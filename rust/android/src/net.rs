//! HTTP for the phone, in Rust (tokio + hyper + rustls). The page's fetch() for other sites goes through here on
//! Android: requests run on a small pool of native threads, many at once, with no CORS rules (so a model server or
//! web page does not have to allow the app), HTTP/2 where the server offers it, gzip, kept-alive connections, and
//! TLS checked against the Mozilla root store.
//!
//! The WebView talks to it by polling: start() returns an id at once, poll(id) hands over what has arrived since
//! the last poll (the status and headers first, then the body in pieces), abort(id) stops it.

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::runtime::Runtime;

const MAX_BUFFERED: usize = 96 * 1024 * 1024;
const UA: &str = "Mozilla/5.0 (Linux; Android) JadeVault/2.19";

pub fn rt() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 4);
        tokio::runtime::Builder::new_multi_thread().worker_threads(n).thread_name("jade-net").enable_all().build().expect("tokio runtime")
    })
}

#[derive(Default)]
struct Slot {
    head: Option<Value>,
    head_sent: bool,
    data: Vec<u8>,
    done: bool,
    error: Option<String>,
    task: Option<tokio::task::AbortHandle>,
}

type Slots = Mutex<HashMap<u64, Arc<Mutex<Slot>>>>;

fn slots() -> &'static Slots {
    static S: OnceLock<Slots> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    /// From the page: {method, url, headers: [[k, v]...], body?: base64}.
    pub fn from_json(v: &Value) -> Result<Req, String> {
        let url = v.get("url").and_then(Value::as_str).ok_or("no url")?.to_string();
        let method = v.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
        let headers = v.get("headers").and_then(Value::as_array).into_iter().flatten().filter_map(|h| Some((h.get(0)?.as_str()?.to_string(), h.get(1)?.as_str()?.to_string()))).collect();
        let body = match v.get("body").and_then(Value::as_str) {
            Some(b) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("bad body: {e}"))?,
            None => Vec::new(),
        };
        Ok(Req { method, url, headers, body })
    }
}

/// Start a request; returns its id at once.
pub fn start(req: Req) -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let slot = Arc::new(Mutex::new(Slot::default()));
    slots().lock().unwrap().insert(id, slot.clone());
    let s2 = slot.clone();
    let h = rt().spawn(async move {
        let r = run(req, &s2).await;
        let mut s = s2.lock().unwrap();
        if let Err(e) = r {
            s.error = Some(e);
        }
        s.done = true;
        drop(s);
        crate::wake();
    });
    slot.lock().unwrap().task = Some(h.abort_handle());
    id
}

/// What arrived since the last poll: {head?: {status, url, redirected, headers}, data?: base64, done, error?}.
pub fn poll(id: u64) -> Value {
    let Some(slot) = slots().lock().unwrap().get(&id).cloned() else { return json!({"done": true, "error": "no such request"}) };
    let mut s = slot.lock().unwrap();
    let mut out = serde_json::Map::new();
    if let Some(h) = s.head.as_ref().filter(|_| !s.head_sent) {
        out.insert("head".into(), h.clone());
    }
    if s.head.is_some() {
        s.head_sent = true;
    }
    if !s.data.is_empty() && s.head_sent {
        let d = std::mem::take(&mut s.data);
        out.insert("data".into(), Value::String(base64::engine::general_purpose::STANDARD.encode(d)));
    }
    let finished = s.done && s.data.is_empty() && (s.head_sent || s.error.is_some());
    out.insert("done".into(), Value::Bool(finished));
    if finished {
        if let Some(e) = &s.error {
            out.insert("error".into(), Value::String(e.clone()));
        }
        drop(s);
        slots().lock().unwrap().remove(&id);
    }
    Value::Object(out)
}

pub fn abort(id: u64) {
    if let Some(slot) = slots().lock().unwrap().remove(&id) {
        if let Some(t) = slot.lock().unwrap().task.take() {
            t.abort();
        }
    }
}

// ------------------------------------------------------------------ connections
enum Sender {
    H1(hyper::client::conn::http1::SendRequest<Full<Bytes>>),
    H2(hyper::client::conn::http2::SendRequest<Full<Bytes>>),
}

/// Idle HTTP/1 connections and live HTTP/2 ones, per scheme://host:port.
fn pool() -> &'static Mutex<HashMap<String, Vec<Sender>>> {
    static P: OnceLock<Mutex<HashMap<String, Vec<Sender>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tls() -> Arc<rustls::ClientConfig> {
    static C: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    C.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        #[cfg(test)]
        if let Ok(p) = std::env::var("JADE_TEST_CA") {
            use rustls::pki_types::{pem::PemObject, CertificateDer};
            for c in CertificateDer::pem_file_iter(p).unwrap() {
                roots.add(c.unwrap()).unwrap();
            }
        }
        let mut c = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        c.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        Arc::new(c)
    })
    .clone()
}

struct Target {
    https: bool,
    host: String,
    port: u16,
    path: String,
}

fn target(url: &str) -> Result<Target, String> {
    let (scheme, rest) = url.split_once("://").ok_or_else(|| format!("bad URL: {url}"))?;
    let https = match scheme.to_ascii_lowercase().as_str() {
        "https" => true,
        "http" => false,
        s => return Err(format!("unsupported URL scheme {s}:")),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let auth = &rest[..end];
    let auth = auth.rsplit_once('@').map(|a| a.1).unwrap_or(auth);
    let mut path = rest[end..].split('#').next().unwrap_or("").to_string();
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    let (host, port) = if let Some(h) = auth.strip_prefix('[') {
        let (h, p) = h.split_once(']').ok_or("bad IPv6 address")?;
        (h.to_string(), p.strip_prefix(':').and_then(|p| p.parse().ok()))
    } else {
        match auth.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h.to_string(), p.parse().ok()),
            _ => (auth.to_string(), None),
        }
    };
    if host.is_empty() {
        return Err(format!("bad URL: {url}"));
    }
    Ok(Target { https, port: port.unwrap_or(if https { 443 } else { 80 }), host, path })
}

async fn connect(t: &Target) -> Result<Sender, String> {
    let tcp = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect((t.host.as_str(), t.port)))
        .await
        .map_err(|_| format!("{} did not answer (timed out connecting)", t.host))?
        .map_err(|e| format!("Failed to fetch: cannot reach {}:{} ({e})", t.host, t.port))?;
    let _ = tcp.set_nodelay(true);
    if !t.https {
        let (s, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        return Ok(Sender::H1(s));
    }
    let name = rustls::pki_types::ServerName::try_from(t.host.clone()).map_err(|e| format!("bad host name {}: {e}", t.host))?;
    let tls = tokio_rustls::TlsConnector::from(tls()).connect(name, tcp).await.map_err(|e| format!("TLS with {} failed: {e}", t.host))?;
    let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
    if h2 {
        let (s, conn) = hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(Sender::H2(s))
    } else {
        let (s, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(Sender::H1(s))
    }
}

/// A connection for this origin: a pooled one that is still usable, else a new one.
async fn sender(key: &str, t: &Target) -> Result<Sender, String> {
    loop {
        let got = {
            let mut p = pool().lock().unwrap();
            let v = p.entry(key.to_string()).or_default();
            // HTTP/2 connections are shared (cloned), HTTP/1 ones are taken
            if let Some(i) = v.iter().position(|s| matches!(s, Sender::H2(h) if !h.is_closed())) {
                if let Sender::H2(h) = &v[i] {
                    Some(Sender::H2(h.clone()))
                } else {
                    None
                }
            } else {
                v.retain(|s| match s {
                    Sender::H1(h) => !h.is_closed(),
                    Sender::H2(h) => !h.is_closed(),
                });
                v.iter().position(|s| matches!(s, Sender::H1(_))).map(|i| v.remove(i))
            }
        };
        match got {
            Some(Sender::H1(mut h)) => {
                if h.ready().await.is_ok() {
                    return Ok(Sender::H1(h));
                }
            }
            Some(s) => return Ok(s),
            None => {
                let s = connect(t).await?;
                if let Sender::H2(h) = &s {
                    pool().lock().unwrap().entry(key.to_string()).or_default().push(Sender::H2(h.clone()));
                }
                return Ok(s);
            }
        }
    }
}

fn give_back(key: &str, s: Sender) {
    if let Sender::H1(h) = s {
        if !h.is_closed() {
            let mut p = pool().lock().unwrap();
            let v = p.entry(key.to_string()).or_default();
            if v.len() < 6 {
                v.push(Sender::H1(h));
            }
        }
    }
}

const SKIP_HEADERS: &[&str] = &["host", "content-length", "connection", "accept-encoding", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-connection"];

async fn send(method: &str, url: &str, headers: &[(String, String)], body: &[u8]) -> Result<(hyper::Response<Incoming>, Option<Sender>, String), String> {
    let t = target(url)?;
    let key = format!("{}://{}:{}", if t.https { "https" } else { "http" }, t.host, t.port);
    let mut s = sender(&key, &t).await?;
    let host_hdr = if (t.https && t.port == 443) || (!t.https && t.port == 80) { t.host.clone() } else { format!("{}:{}", t.host, t.port) };
    let host_hdr = if t.host.contains(':') { format!("[{}]", host_hdr) } else { host_hdr };
    let uri = match s {
        Sender::H1(_) => t.path.clone(),
        Sender::H2(_) => format!("https://{host_hdr}{}", t.path),
    };
    let mut b = hyper::Request::builder().method(method).uri(uri);
    if matches!(s, Sender::H1(_)) {
        b = b.header("host", &host_hdr);
    }
    let mut ua = false;
    for (k, v) in headers {
        let kl = k.to_ascii_lowercase();
        if SKIP_HEADERS.contains(&kl.as_str()) {
            continue;
        }
        ua |= kl == "user-agent";
        b = b.header(k.as_str(), v.as_str());
    }
    if !ua {
        b = b.header("user-agent", UA);
    }
    b = b.header("accept-encoding", "gzip, deflate");
    let req = b.body(Full::new(Bytes::copy_from_slice(body))).map_err(|e| format!("bad request: {e}"))?;
    let res = match &mut s {
        Sender::H1(h) => h.send_request(req).await,
        Sender::H2(h) => h.send_request(req).await,
    }
    .map_err(|e| format!("Failed to fetch: {e}"))?;
    Ok((res, Some(s), key))
}

enum Decoder {
    Plain,
    Gzip(flate2::write::GzDecoder<Vec<u8>>),
    Deflate(flate2::write::ZlibDecoder<Vec<u8>>),
}

impl Decoder {
    fn put(&mut self, d: &[u8]) -> Result<Vec<u8>, String> {
        match self {
            Decoder::Plain => Ok(d.to_vec()),
            Decoder::Gzip(g) => {
                g.write_all(d).map_err(|e| format!("bad gzip from the server: {e}"))?;
                Ok(std::mem::take(g.get_mut()))
            }
            Decoder::Deflate(g) => {
                g.write_all(d).map_err(|e| format!("bad deflate data from the server: {e}"))?;
                Ok(std::mem::take(g.get_mut()))
            }
        }
    }
    fn end(self) -> Result<Vec<u8>, String> {
        match self {
            Decoder::Plain => Ok(vec![]),
            Decoder::Gzip(g) => g.finish().map_err(|e| e.to_string()),
            Decoder::Deflate(g) => g.finish().map_err(|e| e.to_string()),
        }
    }
}

async fn run(req: Req, slot: &Arc<Mutex<Slot>>) -> Result<(), String> {
    let (mut method, mut url, mut body) = (req.method.clone(), req.url.clone(), req.body.clone());
    let mut headers = req.headers.clone();
    let mut redirected = false;
    for hop in 0..=10 {
        let (res, s, key) = send(&method, &url, &headers, &body).await?;
        let status = res.status().as_u16();
        let loc = res.headers().get("location").and_then(|l| l.to_str().ok()).map(String::from);
        if (300..400).contains(&status) && status != 304 && loc.is_some() && hop < 10 {
            // drain the redirect body so the connection can be reused
            let mut b = res.into_body();
            while let Some(f) = b.frame().await {
                if f.is_err() {
                    break;
                }
            }
            if let Some(s) = s {
                give_back(&key, s);
            }
            url = jade_core::html::resolve(&url, &loc.unwrap());
            redirected = true;
            if status == 303 || ((status == 301 || status == 302) && method == "POST") {
                if method != "HEAD" {
                    method = "GET".into();
                }
                body.clear();
                headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
            }
            continue;
        }
        let enc = res.headers().get("content-encoding").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        let mut dec = match enc.as_str() {
            "gzip" | "x-gzip" => Decoder::Gzip(flate2::write::GzDecoder::new(Vec::new())),
            "deflate" => Decoder::Deflate(flate2::write::ZlibDecoder::new(Vec::new())),
            _ => Decoder::Plain,
        };
        let decoded = !matches!(dec, Decoder::Plain);
        let hdrs: Vec<Value> = res
            .headers()
            .iter()
            .filter(|(k, _)| !(decoded && (k.as_str() == "content-encoding" || k.as_str() == "content-length")))
            .map(|(k, v)| json!([k.as_str(), String::from_utf8_lossy(v.as_bytes())]))
            .collect();
        let reason = res.status().canonical_reason().unwrap_or("");
        slot.lock().unwrap().head = Some(json!({"status": status, "statusText": reason, "url": url, "redirected": redirected, "headers": hdrs}));
        crate::wake();
        let mut b = res.into_body();
        while let Some(f) = b.frame().await {
            let f = f.map_err(|e| format!("the connection broke: {e}"))?;
            if let Ok(d) = f.into_data() {
                let d = dec.put(&d)?;
                let mut s = slot.lock().unwrap();
                if s.data.len() + d.len() > MAX_BUFFERED {
                    return Err("the response is too big to hold (over 96 MB waiting)".into());
                }
                s.data.extend_from_slice(&d);
                drop(s);
                crate::wake();
            }
        }
        let tail = dec.end()?;
        slot.lock().unwrap().data.extend_from_slice(&tail);
        if let Some(s) = s {
            give_back(&key, s);
        }
        return Ok(());
    }
    Err("too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::server::conn::http1 as server;
    use hyper::service::service_fn;

    async fn serve() -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (c, _) = l.accept().await.unwrap();
                tokio::spawn(async move {
                    let svc = service_fn(|r: hyper::Request<Incoming>| async move {
                        let path = r.uri().path().to_string();
                        let method = r.method().to_string();
                        let body = r.into_body().collect().await.unwrap().to_bytes();
                        let resp = match path.as_str() {
                            "/redir" => hyper::Response::builder().status(302).header("location", "/echo").body(Full::new(Bytes::new())),
                            "/gz" => {
                                let mut g = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                                g.write_all(b"hello gzip").unwrap();
                                hyper::Response::builder().header("content-encoding", "gzip").body(Full::new(Bytes::from(g.finish().unwrap())))
                            }
                            "/stream" => hyper::Response::builder().body(Full::new(Bytes::from("{\"a\":1}\n{\"b\":2}\n"))),
                            _ => hyper::Response::builder().status(201).body(Full::new(Bytes::from(format!("{method} {}", String::from_utf8_lossy(&body))))),
                        };
                        Ok::<_, std::convert::Infallible>(resp.unwrap())
                    });
                    let _ = server::Builder::new().serve_connection(TokioIo::new(c), svc).await;
                });
            }
        });
        port
    }

    /// A TLS server for "localhost" with a throwaway CA (made with openssl), speaking HTTP/2 or HTTP/1.1 by ALPN.
    async fn serve_tls(alpn: Vec<Vec<u8>>) -> Option<u16> {
        use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
        let d = std::env::temp_dir().join(format!("jade-tls-{}", std::process::id()));
        std::fs::create_dir_all(&d).ok()?;
        let sh = format!(
            "cd {} && [ -f ca.pem ] || (openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj /CN=JadeTestCA && \
             openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj /CN=localhost && \
             printf 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > ext && \
             openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out srv.pem -days 2 -extfile ext) >/dev/null 2>&1",
            d.display()
        );
        if !std::process::Command::new("sh").arg("-c").arg(&sh).status().ok()?.success() {
            return None;
        }
        std::env::set_var("JADE_TEST_CA", d.join("ca.pem"));
        let certs: Vec<CertificateDer> = CertificateDer::pem_file_iter(d.join("srv.pem")).ok()?.map(|c| c.unwrap()).collect();
        let key = PrivateKeyDer::from_pem_file(d.join("srv.key")).ok()?;
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(certs, key).ok()?;
        cfg.alpn_protocols = alpn;
        let acc = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
        let port = l.local_addr().ok()?.port();
        tokio::spawn(async move {
            loop {
                let (c, _) = l.accept().await.unwrap();
                let acc = acc.clone();
                tokio::spawn(async move {
                    let Ok(t) = acc.accept(c).await else { return };
                    let h2 = t.get_ref().1.alpn_protocol() == Some(b"h2");
                    let svc = service_fn(move |r: hyper::Request<Incoming>| async move {
                        let v = format!("{:?} {}", r.version(), r.uri().path());
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from(v))))
                    });
                    if h2 {
                        let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(t), svc).await;
                    } else {
                        let _ = server::Builder::new().serve_connection(TokioIo::new(t), svc).await;
                    }
                });
            }
        });
        Some(port)
    }

    #[test]
    fn tls_with_http2_and_http1() {
        let Some(p2) = rt().block_on(serve_tls(vec![b"h2".to_vec(), b"http/1.1".to_vec()])) else { eprintln!("no openssl: TLS test skipped"); return };
        let p1 = rt().block_on(serve_tls(vec![b"http/1.1".to_vec()])).unwrap();
        let get = |u: String| wait(start(Req { method: "GET".into(), url: u, headers: vec![], body: vec![] }));
        let (h, d, e) = get(format!("https://localhost:{p2}/two"));
        assert_eq!((h["status"].as_u64(), String::from_utf8_lossy(&d).to_string(), e), (Some(200), "HTTP/2.0 /two".to_string(), None));
        // the HTTP/2 connection is shared by later requests
        let ids: Vec<u64> = (0..10).map(|i| start(Req { method: "GET".into(), url: format!("https://localhost:{p2}/n{i}"), headers: vec![], body: vec![] })).collect();
        for (i, id) in ids.into_iter().enumerate() {
            assert_eq!(wait(id).1, format!("HTTP/2.0 /n{i}").into_bytes());
        }
        let (_, d, _) = get(format!("https://localhost:{p1}/one"));
        assert_eq!(d, b"HTTP/1.1 /one");
        // a name the certificate does not cover is refused
        let (_, _, e) = get(format!("https://127.0.0.1:{p1}/"));
        assert!(e.unwrap().contains("TLS"));
    }

    fn wait(id: u64) -> (Value, Vec<u8>, Option<String>) {
        let mut head = Value::Null;
        let mut data = Vec::new();
        for _ in 0..500 {
            let p = poll(id);
            if let Some(h) = p.get("head") {
                head = h.clone();
            }
            if let Some(d) = p.get("data").and_then(Value::as_str) {
                data.extend(base64::engine::general_purpose::STANDARD.decode(d).unwrap());
            }
            if p["done"] == true {
                return (head, data, p.get("error").and_then(Value::as_str).map(String::from));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out");
    }

    #[test]
    fn requests_redirects_gzip_and_errors() {
        let port = rt().block_on(async { serve().await });
        let base = format!("http://127.0.0.1:{port}");
        let (h, d, e) = wait(start(Req { method: "POST".into(), url: base.clone() + "/echo", headers: vec![("Content-Type".into(), "text/plain".into())], body: b"hi".to_vec() }));
        assert_eq!((h["status"].as_u64(), d.as_slice(), e), (Some(201), b"POST hi".as_slice(), None));
        // POST + 302 becomes GET, like a browser
        let (h, d, _) = wait(start(Req { method: "POST".into(), url: base.clone() + "/redir", headers: vec![], body: b"x".to_vec() }));
        assert_eq!(h["redirected"], true);
        assert_eq!(h["url"], base.clone() + "/echo");
        assert_eq!(d, b"GET ");
        let (_, d, _) = wait(start(Req { method: "GET".into(), url: base.clone() + "/gz", headers: vec![], body: vec![] }));
        assert_eq!(d, b"hello gzip");
        // many at once
        let ids: Vec<u64> = (0..20).map(|i| start(Req { method: "PUT".into(), url: base.clone() + "/echo", headers: vec![], body: format!("{i}").into_bytes() })).collect();
        for (i, id) in ids.into_iter().enumerate() {
            assert_eq!(wait(id).1, format!("PUT {i}").into_bytes());
        }
        let (_, _, e) = wait(start(Req { method: "GET".into(), url: "http://127.0.0.1:1/".into(), headers: vec![], body: vec![] }));
        assert!(e.unwrap().contains("Failed to fetch"));
        let (_, _, e) = wait(start(Req { method: "GET".into(), url: "ftp://x/".into(), headers: vec![], body: vec![] }));
        assert!(e.unwrap().contains("unsupported"));
        assert_eq!(target("https://[::1]:8443/a?b#c").map(|t| (t.host, t.port, t.path)).ok(), Some(("::1".into(), 8443, "/a?b".into())));
    }
}
