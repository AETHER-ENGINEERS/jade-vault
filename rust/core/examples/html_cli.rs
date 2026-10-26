//! Convert an HTML file to Markdown with the web_fetch converter: html_cli FILE [URL]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let html = std::fs::read(&a[1]).unwrap();
    let t0 = std::time::Instant::now();
    let (title, text) = jade_core::html::to_markdown(&String::from_utf8_lossy(&html), a.get(2).map(|s| s.as_str()).unwrap_or("https://example.com/"));
    eprintln!("{} KB → {} KB in {:?}", html.len() / 1024, text.len() / 1024, t0.elapsed());
    println!("# {title}\n\n{text}");
}
