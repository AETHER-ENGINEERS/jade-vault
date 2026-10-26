//! For the page tests (tests/rust_core_test.mjs): runs the Rust vault code on notes given as JSON on stdin, so the
//! test can check it gives the same answers as the page's JavaScript.
//! In: {notes: {path: text}, queries: [..], backlinks: {path: n}, tags: {tag: [paths]}}.
//! Out: {parsed: {path: {wiki, md, tags, words}}, search: {query: [hits]}}.

use jade_core::vault;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let req: Value = serde_json::from_str(&s).unwrap();
    let notes: Vec<(String, String)> = req["notes"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect();
    let mut parsed = Map::new();
    for (p, t) in &notes {
        let x = vault::parse_note(t);
        parsed.insert(p.clone(), json!({"wiki": x.wiki, "md": x.md, "tags": x.tags, "words": x.words}));
    }
    let back: HashMap<String, usize> = req["backlinks"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(0) as usize)).collect()).unwrap_or_default();
    let tags: HashMap<String, Vec<String>> = serde_json::from_value(req["tags"].clone()).unwrap_or_default();
    let mut search = Map::new();
    for q in req["queries"].as_array().unwrap() {
        let q = q.as_str().unwrap();
        let (tag_q, _) = vault::query_parts(q);
        let hit: Option<HashSet<String>> = tag_q.map(|t| tags.iter().filter(|(k, _)| **k == t || k.starts_with(&format!("{t}/"))).flat_map(|(_, v)| v.iter().cloned()).collect());
        let hits = vault::search(q, notes.iter().map(|(p, t)| (p.as_str(), t.as_str())), &back, hit.as_ref(), 10);
        search.insert(q.to_string(), serde_json::to_value(hits).unwrap());
    }
    println!("{}", json!({"parsed": parsed, "search": search}));
}
