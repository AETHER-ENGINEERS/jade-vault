#!/usr/bin/env bash
# Build libjade.so (the Rust core) for the phone ABIs and put it where apktool packages it (android/proj/lib/<abi>/).
set -euo pipefail
cd "$(dirname "$0")"
declare -A ABI=([aarch64-linux-android]=arm64-v8a [armv7-linux-androideabi]=armeabi-v7a [x86_64-linux-android]=x86_64)
for t in "${!ABI[@]}"; do
  cargo build --release -q -p jade-android --target "$t"
  mkdir -p "../android/proj/lib/${ABI[$t]}"
  cp "target/$t/release/libjade.so" "../android/proj/lib/${ABI[$t]}/libjade.so"
done
echo "libjade.so → android/proj/lib/{arm64-v8a,armeabi-v7a,x86_64}"
