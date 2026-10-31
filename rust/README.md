# Jade Vault's Rust core

The parts of the app where Rust is measurably faster, or does something the page could not do on its own, are written
in Rust. The screens, the avatar and the agent's control flow stay in the page (HTML and JavaScript), because every
step of the loop touches page state (the chat, tool cards, the vault in memory) and crossing into Rust for those
steps costs more than it saves.

## What runs in Rust

| Where | What | Why it is faster or better |
| --- | --- | --- |
| Phone (native `libjade.so`) | The network: every `fetch()` the page makes to another site (model providers, web search, web pages, embeddings, and other HTTP calls) | Native threads, many requests at once, HTTP/2, gzip, kept-alive connections, TLS checked against the Mozilla roots. No CORS, so a model server does not need `OLLAMA_ORIGINS` and web pages can be read directly. |
| Phone | Parsing notes for the link/tag index, and note search | On all cores, straight from storage; the JavaScript had to pull each note through the WebView bridge as base64. |
| Phone | The vault folder (scan, read, write, move, merge) | Same behaviour as the Java it replaced; scans sub-folders in parallel. |
| Phone | Sentry's rules engine | Same rules and results as the Java it replaced. |
| Phone and browser (WebAssembly, 88 KB) | Web pages to Markdown for `web_fetch` | The page had no local converter (it asked a remote reader service). On the phone, `web_fetch` now fetches the page itself and converts it here. |
| Agent loop (page) | `web_search` / `web_fetch` calls made in the same round run at the same time | On the phone each one runs on its own native connection. |

## What was tried and left in JavaScript

Measured in the page (Chromium, desktop):

| Work | JavaScript | Rust via WebAssembly |
| --- | --- | --- |
| Index 3,000 notes in the browser | 221 ms | 932 ms |
| Note search (browser, warm) | 19–28 ms | 7–30 ms |
| Trim an 800-message chat to the context window | 10 ms | 24 ms |

Copying notes or chat history into WebAssembly and the results back costs more than the work itself, so in the
browser these stay in JavaScript. On the phone the note index and search are native (no copying through the
WebView), which is where they help.

Also left as they are: the SSH client (its crypto already runs in Android's native BoringSSL), the phone's API and
file servers (already thread pools), embeddings search (sqlite-vec, already C in WebAssembly in a worker), and cron
(local-time and daylight-saving rules the page already gets right).

## Layout

- `core/`: pure logic with no I/O, shared by the phone and the browser: `vault.rs` (note parsing, link resolution,
  index, search), `sentry.rs` (rules engine), `html.rs` (HTML to Markdown).
- `android/`: `libjade.so` for the app: `disk.rs` (vault folder, parallel parse/search), `net.rs` (HTTP client on
  tokio + hyper + rustls), `jni.rs` + `lib.rs` (the JNI functions behind `Disk`, `SentryEngine` and `Net`).
- `wasm/`: the WebAssembly the page embeds (`html_markdown`).

## Build

```sh
rust/build-android.sh   # libjade.so for arm64-v8a, armeabi-v7a, x86_64 → android/proj/lib/<abi>/
rust/build-wasm.sh      # app/vendor/jade_core.wasm + jade_core.js (needs wasm-bindgen 0.2.129 and wasm-opt)
cd rust && cargo test   # Rust tests (the network tests start local HTTP, HTTPS and HTTP/2 servers)
android/test/run.sh     # Java tests against a host build of libjade.so
```

Android linking needs clang with the NDK sysroot. `~/.cargo/config.toml` points each target's linker at a small
wrapper such as:

```sh
#!/bin/sh
exec clang --target=aarch64-linux-android26 --sysroot=$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot -fuse-ld=lld "$@"
```

The libraries are linked against API 26 headers; symbols newer than the app's minimum (API 24), such as
`getrandom`, are weak and looked up at run time, so the app still installs and runs on Android 7.

`scripts/build-web.sh` and `android/build-apk.sh` run these scripts when `cargo` is installed; without Rust they
use the built copies checked in under `app/vendor/` and `android/proj/lib/`.

CI does the same on GitHub's runners: it adds the three Android targets, points each at the runner's NDK clang
for API 26, and rebuilds `libjade.so` on every run, so the APKs always match `rust/` (and says when the committed
copies differ).

## Switching the native network off

On the phone, `localStorage.setItem('jadeNativeNet', 'off')` in the page (for example from a WebView debugging console) sends
requests through the WebView again. If a TLS connection fails natively (for example a server whose certificate
only the phone's own store trusts), that one request is retried through the WebView automatically.
