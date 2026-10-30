#!/usr/bin/env bash
# Build the browser's Rust core (WebAssembly) into app/vendor/, where app/build.py embeds it in the page.
# Needs the wasm32 target, wasm-bindgen 0.2.129 and binaryen's wasm-opt (on PATH or in ~/bin).
set -euo pipefail
cd "$(dirname "$0")"
PATH="$HOME/bin:$PATH"
cargo build --release -q -p jade-wasm --target wasm32-unknown-unknown
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
wasm-bindgen --target no-modules --no-typescript --out-dir "$T" target/wasm32-unknown-unknown/release/jade_wasm.wasm
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals "$T/jade_wasm_bg.wasm" -o ../app/vendor/jade_core.wasm
sed 's/^let wasm_bindgen = /const jadeRustGlue = /' "$T/jade_wasm.js" > ../app/vendor/jade_core.js
echo "app/vendor/jade_core.wasm ($(stat -c %s ../app/vendor/jade_core.wasm) bytes) + jade_core.js"
