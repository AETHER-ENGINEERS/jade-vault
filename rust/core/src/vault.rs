//! The vault's knowledge layer (was vault_core.js): what a note links to, its tags and word count; link resolution
//! (Obsidian style: by path, by file name, by a normalised name); the index (out-links, backlinks, tags, missing
//! links); and ranked search with snippets. Pure functions over text and paths: the Android library feeds it files
//! from the phone's storage on all cores, the browser build feeds it the notes in memory.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("a fixed pattern"))
}

static FENCE: OnceLock<Regex> = OnceLock::new();
static INLINE_CODE: OnceLock<Regex> = OnceLock::new();
static MATH_BLOCK: OnceLock<Regex> = OnceLock::new();
static MATH_INLINE: OnceLock<Regex> = OnceLock::new();
static WIKI: OnceLock<Regex> = OnceLock::new();
static MD_LINK: OnceLock<Regex> = OnceLock::new();
static TAG: OnceLock<Regex> = OnceLock::new();
static EXT2_5: OnceLock<Regex> = OnceLock::new();
static SCHEME: OnceLock<Regex> = OnceLock::new();
static NOTE: OnceLock<Regex> = OnceLock::new();
static SEP: OnceLock<Regex> = OnceLock::new();

pub fn is_note(p: &str) -> bool {
    re(&NOTE, r"(?i)\.(md|markdown)$").is_match(p)
}

/// "Projects/My Note.md" → "My Note"
pub fn note_name(p: &str) -> String {
    let b = base(p);
    re(&NOTE, r"(?i)\.(md|markdown)$").replace(b, "").into_owned()
}

pub fn base(p: &str) -> &str {
    if p == "/" {
        return "/";
    }
    match p.rfind('/') {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

pub fn parent(p: &str) -> &str {
    if p == "/" {
        return "/";
    }
    match p.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &p[..i],
    }
}

/// Like the VFS's norm(): resolve . and .. against cwd; always absolute.
pub fn norm(p: &str, cwd: &str) -> String {
    let p = if p.is_empty() { "." } else { p };
    let p = if p == "~" { "/".to_string() } else if let Some(r) = p.strip_prefix("~/") { format!("/{r}") } else { p.to_string() };
    let full = if p.starts_with('/') { p } else { format!("{cwd}/{p}") };
    let mut out: Vec<&str> = Vec::new();
    for s in full.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            _ => out.push(s),
        }
    }
    format!("/{}", out.join("/"))
}

/// Code and math do not count: links and tags inside them are not links and tags.
pub fn strip_code(md: &str) -> String {
    // the JS used a backreference (```…``` or ~~~…~~~ at line starts); do the two fences separately
    let fence = re(&FENCE, r"(?ms)^```.*?^```|^~~~.*?^~~~");
    let s = fence.replace_all(md, " ");
    let s = re(&INLINE_CODE, r"`[^`\n]*`").replace_all(&s, " ");
    let s = re(&MATH_BLOCK, r"(?s)\$\$.*?\$\$").replace_all(&s, " ");
    let s = re(&MATH_INLINE, r"\$[^\s$][^$\n]*?\$").replace_all(&s, |c: &regex::Captures| {
        // the JS: \$(?!\s)[^$\n]+?\$  (a single non-space char also counts)
        let _ = c;
        " ".to_string()
    });
    s.into_owned()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub wiki: Vec<String>,
    pub md: Vec<String>,
    pub tags: Vec<String>,
    pub words: usize,
}

/// decodeURIComponent: None when an escape is malformed (the caller keeps the raw text, like the app did).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// What one note links to, its tags and its word count (never its text).
pub fn parse_note(text: &str) -> Parsed {
    let body = strip_code(text);
    let mut wiki = Vec::new();
    let mut md = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    let mut seen_tag: HashSet<String> = HashSet::new();
    let w = re(&WIKI, r"\[\[([^\[\]\n|#]+)(#[^\[\]\n|]*)?(?:\|([^\[\]\n]+))?\]\]");
    let ext = re(&EXT2_5, r"\.[A-Za-z0-9_]{2,5}$");
    for c in w.captures_iter(&body) {
        let m0 = c.get(0).unwrap();
        let target = c.get(1).unwrap().as_str();
        let t = target.trim();
        // ![[image.png]] is an embed, not a note link
        if m0.start() > 0 && body.as_bytes()[m0.start() - 1] == b'!' && ext.is_match(t) && !is_note(t) {
            continue;
        }
        wiki.push(target.to_string());
    }
    let mdl = re(&MD_LINK, r"(?i)\]\(([^)\s]+\.(?:md|markdown))(?:#[^)]*)?\)");
    let scheme = re(&SCHEME, r"(?i)^[a-z][a-z0-9+.-]*:");
    for c in mdl.captures_iter(&body) {
        let t = c.get(1).unwrap().as_str();
        if scheme.is_match(t) {
            continue;
        }
        md.push(percent_decode(t).unwrap_or_else(|| t.to_string()));
    }
    let tag = re(&TAG, r"(?:^|[\s(\[,;])#([A-Za-z][A-Za-z0-9_/-]*)");
    for c in tag.captures_iter(&body) {
        let t = c.get(1).unwrap().as_str().trim_end_matches(['/', '-']).to_lowercase();
        if !t.is_empty() && seen_tag.insert(t.clone()) {
            tags.push(t);
        }
    }
    let words = text.split_whitespace().count();
    Parsed { wiki, md, tags, words }
}

/// "My_Note-2" → "my note 2": the loose name used when nothing else matches.
pub fn name_key(p: &str) -> String {
    let n = note_name(p).to_lowercase();
    re(&SEP, r"[\s_\-]+").replace_all(&n, " ").trim().to_string()
}

/// Fast lookups for link resolution, built once per set of note paths.
pub struct Lookup {
    pub files: HashSet<String>,
    by_base: HashMap<String, Vec<String>>,
    by_key: HashMap<String, Vec<String>>,
}

impl Lookup {
    /// `files`: every file path in the vault (not just notes), for exact path hits; `notes`: the notes.
    pub fn new<'a>(files: impl IntoIterator<Item = &'a str>, notes: &[String]) -> Self {
        let mut by_base: HashMap<String, Vec<String>> = HashMap::new();
        let mut by_key: HashMap<String, Vec<String>> = HashMap::new();
        for p in notes {
            by_base.entry(base(p).to_lowercase()).or_default().push(p.clone());
            let k = name_key(p);
            if !k.is_empty() {
                by_key.entry(k).or_default().push(p.clone());
            }
        }
        Lookup { files: files.into_iter().map(String::from).collect(), by_base, by_key }
    }

    /// Where [[target]] written in fromPath points, or None.
    pub fn resolve(&self, target: &str, from: Option<&str>) -> Option<String> {
        let mut t = target.trim().replace('\\', "/");
        if t.is_empty() {
            return None;
        }
        if !is_note(&t) {
            t.push_str(".md");
        }
        let dir = from.map(parent).unwrap_or("/");
        for cand in [norm(&t, dir), norm(&t, "/")] {
            if self.files.contains(&cand) {
                return Some(cand);
            }
        }
        let lc = t.to_lowercase();
        let b = lc.rsplit('/').next().unwrap_or(&lc).to_string();
        let mut hits: Vec<String> = if lc.contains('/') {
            let tail = format!("/{}", lc.trim_start_matches('/'));
            self.by_base.get(&b).map(|v| v.iter().filter(|p| p.to_lowercase().ends_with(&tail)).cloned().collect()).unwrap_or_default()
        } else {
            vec![]
        };
        if hits.is_empty() {
            hits = self.by_base.get(&b).cloned().unwrap_or_default();
        }
        if hits.is_empty() {
            let k = name_key(&b);
            if !k.is_empty() {
                hits = self.by_key.get(&k).cloned().unwrap_or_default();
            }
        }
        if hits.is_empty() {
            return None;
        }
        hits.sort_by(|a, c| {
            let ad = (parent(a) == dir) as i32;
            let cd = (parent(c) == dir) as i32;
            cd.cmp(&ad).then(a.chars().count().cmp(&c.chars().count())).then_with(|| locale_cmp(a, c))
        });
        hits.into_iter().next()
    }
}

/// Roughly what Intl.Collator / localeCompare do for file names: case-insensitive first, then by case.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let fold = |s: &str| s.chars().flat_map(|c| c.to_lowercase()).filter(|c| c.is_alphanumeric() || !c.is_ascii_punctuation()).collect::<String>();
    fold(a).cmp(&fold(b)).then_with(|| a.to_lowercase().cmp(&b.to_lowercase())).then_with(|| b.cmp(a))
}

/// Which files are notes the index looks at (not skills, not node_modules/.git/.trash).
pub fn indexable(p: &str) -> bool {
    if !is_note(p) {
        return false;
    }
    let lp = p.to_lowercase();
    if lp.starts_with("/jade/skills/") {
        return false;
    }
    !(p.contains("/node_modules/") || p.contains("/.git/") || p.contains("/.trash/"))
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Index {
    pub notes: Vec<String>,
    /// note → the notes it links to
    pub out: BTreeMap<String, Vec<String>>,
    /// note → the notes that link to it
    pub back: BTreeMap<String, Vec<String>>,
    pub tags: BTreeMap<String, Vec<String>>,
    /// note → link targets that do not exist yet
    pub missing: BTreeMap<String, Vec<String>>,
    pub words: usize,
}

/// The index from every note's parse. `files` is every file path (for exact path resolution).
pub fn build_index<'a>(files: impl IntoIterator<Item = &'a str>, parsed: &HashMap<String, Parsed>) -> Index {
    let mut notes: Vec<String> = parsed.keys().filter(|p| indexable(p)).cloned().collect();
    notes.sort_by(|a, b| locale_cmp(a, b));
    let look = Lookup::new(files, &notes);
    let mut idx = Index { notes: notes.clone(), ..Default::default() };
    let mut back: HashMap<&str, BTreeSet<String>> = notes.iter().map(|p| (p.as_str(), BTreeSet::new())).collect();
    let mut tags: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for p in &notes {
        let e = &parsed[p];
        let mut out: Vec<String> = Vec::new();
        let mut miss: Vec<String> = Vec::new();
        for t in &e.wiki {
            match look.resolve(t, Some(p)) {
                Some(r) => {
                    if &r != p && !out.contains(&r) {
                        out.push(r)
                    }
                }
                None => {
                    let t = t.trim().to_string();
                    if !miss.contains(&t) {
                        miss.push(t)
                    }
                }
            }
        }
        for t in &e.md {
            if let Some(r) = look.resolve(t, Some(p)) {
                if &r != p && !out.contains(&r) {
                    out.push(r);
                }
            }
        }
        for r in &out {
            if let Some(b) = back.get_mut(r.as_str()) {
                b.insert(p.clone());
            }
        }
        for t in &e.tags {
            tags.entry(t.clone()).or_default().insert(p.clone());
        }
        idx.words += e.words;
        idx.out.insert(p.clone(), out);
        idx.missing.insert(p.clone(), miss);
    }
    idx.back = back.into_iter().map(|(k, v)| (k.to_string(), v.into_iter().collect())).collect();
    idx.tags = tags.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect();
    idx
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Hit {
    pub path: String,
    pub score: f64,
    pub snippet: String,
}

/// How one note scores for a query (None: it does not match). `lc` is the note's text, lower-cased.
pub fn score_note(path: &str, lc: &str, terms: &[String], tag_q: Option<&str>, backlinks: usize) -> Option<(f64, i64)> {
    let name = note_name(path).to_lowercase();
    let pl = path.to_lowercase();
    if tag_q.is_none() && !terms.iter().all(|t| lc.contains(t.as_str()) || pl.contains(t.as_str())) {
        return None;
    }
    let mut score = 0.0;
    let mut first_byte: Option<usize> = None;   // turned into a UTF-16 position once, at the end
    for t in terms {
        if name == *t {
            score += 30.0;
        } else if name.contains(t.as_str()) {
            score += 12.0;
        }
        // occurrences may overlap ("aaa" holds "aa" twice), at most 60 counted
        let mut c = 0;
        let mut from = 0;
        while c < 60 {
            let Some(j) = lc[from..].find(t.as_str()) else { break };
            let at = from + j;
            if first_byte.is_none_or(|f| at < f) {
                first_byte = Some(at);
            }
            c += 1;
            from = at + lc[at..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
            if from > lc.len() {
                break;
            }
        }
        score += c as f64;
    }
    let mut first: i64 = first_byte.map(|b| char_index(lc, b) as i64).unwrap_or(-1);
    if let Some(tq) = tag_q {
        first = lc.find(&format!("#{tq}")).map(|i| char_index(lc, i) as i64).unwrap_or(-1);
        score = 1.0;
    }
    score += (backlinks.min(5)) as f64 * 0.5;
    Some((score, first))
}

/// Positions are counted in UTF-16 units, as JavaScript counts them, so snippets match the page's to the character.
fn char_index(s: &str, byte: usize) -> usize {
    s[..byte].encode_utf16().count()
}

/// The ~190 characters around the first hit, on one line.
pub fn snippet(text: &str, first: i64) -> String {
    let u: Vec<u16> = text.encode_utf16().collect();
    let s = ((if first < 0 { 0 } else { first }) - 50).max(0) as usize;
    let s = s.min(u.len());
    let e = (s + 190).min(u.len());
    let mid = String::from_utf16_lossy(&u[s..e]);
    let mid = mid.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{}{}", if s > 0 { "…" } else { "" }, mid, if u.len() > s + 190 { "…" } else { "" })
}

/// The query's parts: either a #tag, or lower-cased words.
pub fn query_parts(q: &str) -> (Option<String>, Vec<String>) {
    let q = q.trim();
    let is_tag = q.len() > 1 && q.starts_with('#') && q[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '/' || c == '-');
    if is_tag {
        (Some(q[1..].to_lowercase()), vec![])
    } else {
        (None, q.to_lowercase().split_whitespace().map(String::from).collect())
    }
}

/// Rank the candidates (path, text) for a query. `tag_hit`: the notes carrying the queried tag, when it is a tag query.
pub fn search<'a>(q: &str, notes: impl IntoIterator<Item = (&'a str, &'a str)>, backlinks: &HashMap<String, usize>, tag_hit: Option<&HashSet<String>>, limit: usize) -> Vec<Hit> {
    let (tag_q, terms) = query_parts(q);
    if tag_q.is_none() && terms.is_empty() {
        return vec![];
    }
    let mut cand: Vec<(f64, &str, &str, i64)> = Vec::new();
    for (p, text) in notes {
        if tag_q.is_some() && !tag_hit.map(|h| h.contains(p)).unwrap_or(false) {
            continue;
        }
        let lc = text.to_lowercase();
        if let Some((score, first)) = score_note(p, &lc, &terms, tag_q.as_deref(), *backlinks.get(p).unwrap_or(&0)) {
            cand.push((score, p, text, first));
        }
    }
    rank(cand, limit)
}

pub fn rank(mut cand: Vec<(f64, &str, &str, i64)>, limit: usize) -> Vec<Hit> {
    cand.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| locale_cmp(a.1, b.1)));
    cand.into_iter().take(limit).map(|(score, p, text, first)| Hit { path: p.to_string(), score, snippet: snippet(text, first) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links_tags_and_words() {
        let t = "# Plan\nSee [[Project Neon]] and [[ideas/Lamp|the lamp]] #work #Work/deep-\n![[photo.png]] ![[Other.md]]\n[x](notes/a%20b.md) [y](https://e.com/z.md)\n```\n[[not a link]] #nope\n```\n`#code` $#m$";
        let p = parse_note(t);
        assert_eq!(p.wiki, vec!["Project Neon", "ideas/Lamp", "Other.md"]);
        assert_eq!(p.md, vec!["notes/a b.md"]);
        assert_eq!(p.tags, vec!["work", "work/deep"]);
        assert_eq!(p.words, t.split_whitespace().count());
    }

    #[test]
    fn resolves_like_obsidian() {
        let notes: Vec<String> = ["/Projects/Project Neon.md", "/ideas/Lamp.md", "/a/Lamp.md", "/Inbox.md", "/x/My_Note-2.md"].iter().map(|s| s.to_string()).collect();
        let l = Lookup::new(notes.iter().map(|s| s.as_str()), &notes);
        assert_eq!(l.resolve("Project Neon", Some("/Inbox.md")).as_deref(), Some("/Projects/Project Neon.md"));
        assert_eq!(l.resolve("ideas/Lamp", Some("/Inbox.md")).as_deref(), Some("/ideas/Lamp.md"));
        assert_eq!(l.resolve("Lamp", Some("/a/Note.md")).as_deref(), Some("/a/Lamp.md"));   // the same folder wins
        assert_eq!(l.resolve("my note 2", None).as_deref(), Some("/x/My_Note-2.md"));
        assert_eq!(l.resolve("Nope", None), None);
        assert_eq!(norm("../b/c.md", "/a/x"), "/a/b/c.md");
    }

    #[test]
    fn index_and_search() {
        let mut parsed = HashMap::new();
        let texts = [("/A.md", "links to [[B]] and [[Gone]] #t"), ("/B.md", "back to [[A]] lamp lamp"), ("/jade/skills/s.md", "[[A]]")];
        for (p, t) in texts {
            parsed.insert(p.to_string(), parse_note(t));
        }
        let idx = build_index(texts.iter().map(|(p, _)| *p), &parsed);
        assert_eq!(idx.notes, vec!["/A.md", "/B.md"]);
        assert_eq!(idx.back["/B.md"], vec!["/A.md"]);
        assert_eq!(idx.missing["/A.md"], vec!["Gone"]);
        assert_eq!(idx.tags["t"], vec!["/A.md"]);
        let bl: HashMap<String, usize> = idx.back.iter().map(|(k, v)| (k.clone(), v.len())).collect();
        let hits = search("lamp", texts[..2].iter().map(|(p, t)| (*p, *t)), &bl, None, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/B.md");
        assert_eq!(hits[0].score, 2.0 + 0.5);
        assert_eq!(hits[0].snippet, "back to [[A]] lamp lamp");
        let (_, terms) = query_parts("aa");
        assert_eq!(score_note("/x.md", "aaa", &terms, None, 0), Some((2.0, 0)));   // overlapping, like indexOf(t, i + 1)
        assert_eq!(parse_note("[x](a%zz.md) [y](b%20c.md)").md, vec!["a%zz.md", "b c.md"]);
        assert_eq!(parse_note("#café #ok_1").tags, vec!["caf", "ok_1"]);   // ASCII \w, as in JavaScript
    }
}
