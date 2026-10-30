//! The page's Rust core in the browser (WebAssembly). Only what is faster or new in Rust lives here: turning web
//! pages into Markdown for web_fetch (the page had no local converter; it used a remote reader service). Note
//! parsing and search measured faster in the page's own JavaScript than across the WebAssembly boundary, so they
//! stay there in the browser; on the phone they run natively (rust/android).

use serde_json::json;
use wasm_bindgen::prelude::*;

/// A web page as Markdown: {title, text}.
#[wasm_bindgen]
pub fn html_markdown(html: &str, url: &str) -> String {
    let (title, text) = jade_core::html::to_markdown(html, url);
    json!({"title": title, "text": text}).to_string()
}
