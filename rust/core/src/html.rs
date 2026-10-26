//! Web pages to readable Markdown, for web_fetch on the phone (which can fetch pages directly, without a
//! third-party reader). A small forgiving HTML scanner: it keeps the main content (<main> or <article> when the page
//! has one), headings, paragraphs, lists, links, code and tables; it drops scripts, styles, navigation, forms and
//! anything hidden.

/// Title and Markdown text of an HTML page. `base`: the page's URL, for resolving relative links.
pub fn to_markdown(html: &str, base: &str) -> (String, String) {
    let toks = scan(html);
    let title = toks
        .iter()
        .position(|t| matches!(t, Tok::Open(n, _) if n == "title"))
        .map(|i| toks[i + 1..].iter().take_while(|t| !matches!(t, Tok::Close(n) if n == "title")).filter_map(|t| if let Tok::Text(s) = t { Some(s.as_str()) } else { None }).collect::<String>())
        .map(|t| squash(&decode(&t)))
        .unwrap_or_default();
    // prefer the main content when the page marks it
    let range = ["main", "article"].iter().find_map(|tag| {
        let a = toks.iter().position(|t| matches!(t, Tok::Open(n, _) if n == tag))?;
        let mut depth = 0;
        for (i, t) in toks.iter().enumerate().skip(a) {
            match t {
                Tok::Open(n, _) if n == tag => depth += 1,
                Tok::Close(n) if n == tag => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((a, i));
                    }
                }
                _ => {}
            }
        }
        Some((a, toks.len()))
    });
    let (a, b) = range.unwrap_or((0, toks.len()));
    (title, render(&toks[a..b], base))
}

#[derive(Debug)]
enum Tok {
    Open(String, String), // name, raw attributes
    Close(String),
    Text(String),
}

const SKIP: &[&str] = &["script", "style", "noscript", "template", "svg", "head", "nav", "footer", "form", "iframe", "select", "button", "canvas", "dialog"];
const VOID: &[&str] = &["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"];

fn scan(h: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let b = h.as_bytes();
    let mut i = 0;
    let mut text_from = 0;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        if i > text_from {
            out.push(Tok::Text(h[text_from..i].to_string()));
        }
        if h[i..].starts_with("<!--") {
            i = h[i..].find("-->").map(|e| i + e + 3).unwrap_or(b.len());
            text_from = i;
            continue;
        }
        if h[i..].starts_with("<!") || h[i..].starts_with("<?") {
            i = h[i..].find('>').map(|e| i + e + 1).unwrap_or(b.len());
            text_from = i;
            continue;
        }
        let close = b.get(i + 1) == Some(&b'/');
        let ns = i + 1 + close as usize;
        let ne = ns + b[ns..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'-' || **c == b':').count();
        if ne == ns {
            // a lone "<" in text
            i += 1;
            continue;
        }
        let name = h[ns..ne].to_ascii_lowercase();
        // the end of the tag, skipping quoted attribute values
        let mut j = ne;
        let mut q = 0u8;
        while j < b.len() {
            let c = b[j];
            if q != 0 {
                if c == q {
                    q = 0;
                }
            } else if c == b'"' || c == b'\'' {
                q = c;
            } else if c == b'>' {
                break;
            }
            j += 1;
        }
        let attrs = h[ne..j.min(b.len())].to_string();
        i = (j + 1).min(b.len());
        text_from = i;
        if close {
            out.push(Tok::Close(name));
            continue;
        }
        let self_closing = attrs.trim_end().ends_with('/');
        if SKIP.contains(&name.as_str()) && !self_closing {
            // skip to the matching close tag (raw text for script/style)
            let end = format!("</{name}");
            let lower = h[i..].to_ascii_lowercase();
            i = lower.find(&end).map(|e| i + e).unwrap_or(b.len());
            i = h[i..].find('>').map(|e| i + e + 1).unwrap_or(b.len());
            text_from = i;
            if name == "head" {
                // keep the title, which lives in <head>
                if let Some(t) = scan_title(&h[..i]) {
                    out.push(Tok::Open("title".into(), String::new()));
                    out.push(Tok::Text(t));
                    out.push(Tok::Close("title".into()));
                }
            }
            continue;
        }
        if hidden(&attrs) && !VOID.contains(&name.as_str()) && !self_closing {
            let mut depth = 1;
            let mut k = i;
            // skip the hidden element and its children
            while depth > 0 && k < b.len() {
                let Some(n) = h[k..].find('<') else { k = b.len(); break };
                k += n;
                let cl = b.get(k + 1) == Some(&b'/');
                let s2 = k + 1 + cl as usize;
                let e2 = s2 + b[s2..].iter().take_while(|c| c.is_ascii_alphanumeric()).count();
                if h[s2..e2].eq_ignore_ascii_case(&name) {
                    depth += if cl { -1 } else { 1 };
                }
                k = h[k..].find('>').map(|e| k + e + 1).unwrap_or(b.len());
            }
            i = k;
            text_from = i;
            continue;
        }
        out.push(Tok::Open(name, attrs));
    }
    if text_from < b.len() {
        out.push(Tok::Text(h[text_from..].to_string()));
    }
    out
}

fn scan_title(head: &str) -> Option<String> {
    let l = head.to_ascii_lowercase();
    let a = l.find("<title")?;
    let a = a + l[a..].find('>')? + 1;
    let e = a + l[a..].find("</title")?;
    Some(head[a..e].to_string())
}

fn hidden(attrs: &str) -> bool {
    let l = attrs.to_ascii_lowercase();
    l.split_whitespace().any(|w| w == "hidden" || w.starts_with("hidden=") || w == "aria-hidden=\"true\"") || l.replace(' ', "").contains("display:none")
}

fn attr(attrs: &str, key: &str) -> Option<String> {
    let l = attrs.to_ascii_lowercase();
    let mut from = 0;
    while let Some(p) = l[from..].find(key) {
        let at = from + p;
        let before_ok = at == 0 || l.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = l[at + key.len()..].trim_start();
        if before_ok && rest.starts_with('=') {
            let off = attrs.len() - rest.len() + 1;
            let v = attrs[off..].trim_start();
            let (val, _) = match v.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let e = v[1..].find(q).map(|e| e + 1).unwrap_or(v.len());
                    (&v[1..e], 0)
                }
                _ => (v.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or(""), 0),
            };
            return Some(decode(val));
        }
        from = at + key.len();
    }
    None
}

/// Resolve a link against the page URL (enough for absolute, root-relative, protocol-relative and relative).
pub fn resolve(base: &str, href: &str) -> String {
    let href = href.trim();
    if href.contains("://") || href.starts_with("mailto:") || href.starts_with("tel:") {
        return href.to_string();
    }
    let Some((scheme, rest)) = base.split_once("://") else { return href.to_string() };
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..host_end]);
    if let Some(h) = href.strip_prefix("//") {
        return format!("{scheme}://{h}");
    }
    if href.starts_with('/') {
        return origin + href;
    }
    if href.starts_with('#') || href.starts_with('?') {
        let cut = if href.starts_with('#') { base.find('#') } else { base.find(['?', '#']) };
        return base[..cut.unwrap_or(base.len())].to_string() + href;
    }
    let path = &rest[host_end..];
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let dir = &path[..path.rfind('/').map(|i| i + 1).unwrap_or(0)];
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in href.split('/') {
        match seg {
            "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("{origin}/{}", parts.join("/"))
}

fn render(toks: &[Tok], base: &str) -> String {
    let mut out = String::new();
    let mut line = String::new();
    let mut pre = 0usize;
    let mut list: Vec<(bool, usize)> = Vec::new(); // ordered?, counter
    let mut link: Vec<(usize, String)> = Vec::new(); // start in `line`, href
    let mut cell = false;
    let mut in_title = false;
    let flush = |out: &mut String, line: &mut String| {
        let t = line.trim_end().to_string();
        if !t.trim().is_empty() {
            out.push_str(&t);
            out.push('\n');
        }
        line.clear();
    };
    let block = |out: &mut String, line: &mut String| {
        let t = line.trim_end().to_string();
        if !t.trim().is_empty() {
            out.push_str(&t);
            out.push('\n');
        }
        line.clear();
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
    };
    for t in toks {
        match t {
            Tok::Text(_) if in_title => {}
            Tok::Text(s) => {
                let d = decode(s);
                if pre > 0 {
                    // a newline right after <pre> is not content (HTML drops it)
                    let d = if line.ends_with("```\n") { d.strip_prefix("\r\n").or_else(|| d.strip_prefix('\n')).unwrap_or(&d).to_string() } else { d };
                    line.push_str(&d);
                    continue;
                }
                let mut sq = squash_keep_edges(&d);
                if line.is_empty() || line.ends_with(' ') || line.ends_with('\n') {
                    sq = sq.trim_start().to_string();
                }
                line.push_str(&sq);
            }
            Tok::Open(n, a) => match n.as_str() {
                "title" => in_title = true,
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    block(&mut out, &mut line);
                    line.push_str(&"#".repeat(n[1..].parse().unwrap_or(1)));
                    line.push(' ');
                }
                "p" | "div" | "section" | "header" | "aside" | "blockquote" | "figure" | "figcaption" | "dl" | "dt" | "dd" | "table" | "details" | "summary" | "address" => block(&mut out, &mut line),
                "tr" => flush(&mut out, &mut line),
                "td" | "th" => {
                    if cell {
                        line.push_str(" | ");
                    }
                    cell = true;
                }
                "br" => {
                    if pre > 0 {
                        line.push('\n');
                    } else {
                        flush(&mut out, &mut line);
                    }
                }
                "hr" => {
                    block(&mut out, &mut line);
                    out.push_str("---\n\n");
                }
                "pre" => {
                    block(&mut out, &mut line);
                    line.push_str("```\n");
                    pre += 1;
                }
                "code" if pre == 0 => line.push('`'),
                "ul" | "ol" => {
                    flush(&mut out, &mut line);
                    list.push((n == "ol", 0));
                }
                "li" => {
                    flush(&mut out, &mut line);
                    let depth = list.len().saturating_sub(1);
                    line.push_str(&"  ".repeat(depth));
                    if let Some(l) = list.last_mut() {
                        l.1 += 1;
                        if l.0 {
                            line.push_str(&format!("{}. ", l.1));
                        } else {
                            line.push_str("- ");
                        }
                    } else {
                        line.push_str("- ");
                    }
                }
                "a" => {
                    if let Some(h) = attr(a, "href").filter(|h| !h.starts_with("javascript:") && !h.is_empty()) {
                        link.push((line.len(), resolve(base, &h)));
                    } else {
                        link.push((usize::MAX, String::new()));
                    }
                }
                "img" => {
                    if let Some(alt) = attr(a, "alt").filter(|x| !x.trim().is_empty()) {
                        line.push_str(&format!("[image: {}]", squash(&alt)));
                    }
                }
                "strong" | "b" => line.push_str("**"),
                "em" | "i" => line.push('*'),
                _ => {}
            },
            Tok::Close(n) => match n.as_str() {
                "title" => in_title = false,
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "section" | "header" | "aside" | "blockquote" | "figure" | "table" | "details" | "address" | "dl" => block(&mut out, &mut line),
                "tr" => {
                    flush(&mut out, &mut line);
                    cell = false;
                }
                "pre" => {
                    pre = pre.saturating_sub(1);
                    if !line.ends_with('\n') {
                        line.push('\n');
                    }
                    line.push_str("```");
                    block(&mut out, &mut line);
                }
                "code" if pre == 0 => line.push('`'),
                "ul" | "ol" => {
                    list.pop();
                    flush(&mut out, &mut line);
                    if list.is_empty() {
                        block(&mut out, &mut line);
                    }
                }
                "li" | "dt" | "dd" | "figcaption" | "summary" => flush(&mut out, &mut line),
                "a" => {
                    if let Some((start, href)) = link.pop() {
                        if start != usize::MAX && start <= line.len() {
                            let text = line[start..].trim().to_string();
                            if !text.is_empty() && !href.is_empty() {
                                line.truncate(start);
                                line.push_str(&format!("[{text}]({href})"));
                            }
                        }
                    }
                }
                "strong" | "b" => line.push_str("**"),
                "em" | "i" => line.push('*'),
                _ => {}
            },
        }
    }
    flush(&mut out, &mut line);
    // tidy: no runs of blank lines, no empty emphasis
    let mut res = String::new();
    let mut blank = 0;
    for l in out.lines() {
        let l = if l.trim_start().starts_with("```") { l.to_string() } else { l.replace("****", "").replace("``", "") };
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        res.push_str(l.trim_end());
        res.push('\n');
    }
    res.trim().to_string()
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Collapse whitespace but keep one space at either end when there was some (words across tags stay apart).
fn squash_keep_edges(s: &str) -> String {
    if s.trim().is_empty() {
        return if s.is_empty() { String::new() } else { " ".into() };
    }
    let mut r = String::new();
    if s.starts_with(char::is_whitespace) {
        r.push(' ');
    }
    r.push_str(&squash(s));
    if s.ends_with(char::is_whitespace) {
        r.push(' ');
    }
    r
}

/// Decode HTML character references (numeric and the common named ones).
pub fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        rest = &rest[p..];
        let end = rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '#')).map(|e| e + 1).unwrap_or(rest.len());
        let name = &rest[1..end];
        let semi = rest[end..].starts_with(';');
        let ch: Option<String> = if let Some(n) = name.strip_prefix('#') {
            let v = if let Some(h) = n.strip_prefix(['x', 'X']) { u32::from_str_radix(h, 16).ok() } else { n.parse().ok() };
            v.and_then(char::from_u32).map(String::from)
        } else {
            named(name).map(String::from)
        };
        match ch {
            Some(c) if semi || name.starts_with('#') || matches!(name, "amp" | "lt" | "gt" | "quot" | "nbsp") => {
                out.push_str(&c);
                rest = &rest[end + semi as usize..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn named(n: &str) -> Option<&'static str> {
    Some(match n {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "middot" => "·",
        "bull" => "•",
        "times" => "×",
        "divide" => "÷",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "sect" => "§",
        "para" => "¶",
        "plusmn" => "±",
        "frac12" => "½",
        "frac14" => "¼",
        "frac34" => "¾",
        "shy" => "",
        "zwj" => "\u{200d}",
        "zwnj" => "\u{200c}",
        "thinsp" => "\u{2009}",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "eacute" => "é",
        "egrave" => "è",
        "aacute" => "á",
        "agrave" => "à",
        "ouml" => "ö",
        "uuml" => "ü",
        "auml" => "ä",
        "szlig" => "ß",
        "ccedil" => "ç",
        "ntilde" => "ñ",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_to_markdown() {
        let h = r#"<!doctype html><html><head><title>My &amp; Page</title><style>p{color:red}</style><script>var x = "<p>no</p>";</script></head>
<body><nav><a href="/">Home</a></nav><main><h1>Hello <em>world</em></h1>
<p>First para with a <a href="/docs/x?y=1">link</a> and <code>code()</code>.</p>
<div hidden><p>secret</p></div><div style="display: none">gone</div>
<ul><li>one</li><li>two<ol><li>a</li></ol></li></ul>
<pre>let x = 1;
let y = 2;</pre><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<p>caf&eacute; &#233; &#x41; &unknown; 5 &lt; 6</p><img alt="a cat"></main><footer>foot</footer></body></html>"#;
        let (t, md) = to_markdown(h, "https://ex.com/a/b.html");
        assert_eq!(t, "My & Page");
        assert!(md.starts_with("# Hello *world*"), "{md}");
        assert!(md.contains("[link](https://ex.com/docs/x?y=1)"), "{md}");
        assert!(md.contains("`code()`"));
        assert!(!md.contains("secret") && !md.contains("gone") && !md.contains("Home") && !md.contains("foot") && !md.contains("no</p>"));
        assert!(md.contains("- one\n- two\n  1. a"), "{md}");
        assert!(md.contains("```\nlet x = 1;\nlet y = 2;\n```"), "{md}");
        assert!(md.contains("A | B\n1 | 2"), "{md}");
        assert!(md.contains("café é A &unknown; 5 < 6"), "{md}");
        assert!(md.contains("[image: a cat]"));
        let (t, md) = to_markdown("<html><head><title>T</title></head><body><p>Hi</p></body></html>", "https://e.test/");
        assert_eq!((t.as_str(), md.as_str()), ("T", "Hi"));
        assert_eq!(resolve("https://ex.com/a/b.html", "../c/d"), "https://ex.com/c/d");
        assert_eq!(resolve("https://ex.com/a/b.html?q#h", "#top"), "https://ex.com/a/b.html?q#top");
    }
}
