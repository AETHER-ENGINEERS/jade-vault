#!/usr/bin/env bash
# Rebuild app/vendor/sqlite3.min.wasm: SQLite 3.53.4 + sqlite-vec 0.1.9 for wasm32-wasip1 (no Emscripten).
#   needs: git, a C compiler for the amalgamation step (cc, make), curl, tar
#   usage: sqlite-wasm/build.sh [workdir]        (default /tmp/jv-sqlite-wasm; downloads ~150 MB once)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
SQLITE_TAG=version-3.53.4; VEC_TAG=v0.1.9; WASI_SDK=27
W="${1:-/tmp/jv-sqlite-wasm}"; mkdir -p "$W"; cd "$W"
[ -d sqlite ]     || GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch "$SQLITE_TAG" https://github.com/sqlite/sqlite sqlite
[ -d sqlite-vec ] || GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch "$VEC_TAG" https://github.com/asg017/sqlite-vec sqlite-vec
SDK="wasi-sdk-$WASI_SDK.0-x86_64-linux"
[ -d "$SDK" ] || { curl -fsSL -o sdk.tgz "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK/$SDK.tar.gz" && tar xzf sdk.tgz; }
# SQLite's single-file source (its own build makes the Tcl interpreter it needs)
[ -f sqlite/sqlite3.c ] || (cd sqlite && ./configure >/dev/null && make sqlite3.c >/dev/null)
mkdir -p build && cd build
cp ../sqlite/sqlite3.c ../sqlite/sqlite3.h ../sqlite/sqlite3ext.h ../sqlite-vec/sqlite-vec.c "$HERE/jvos.c" .
VER=$(cat ../sqlite-vec/VERSION); IFS=. read -r MA MI PA <<< "$VER"
sed -e "s/\${VERSION}/$VER/; s/\${DATE}/$(date +%F)/; s/\${SOURCE}/$VEC_TAG/; s/\${VERSION_MAJOR}/$MA/; s/\${VERSION_MINOR}/$MI/; s/\${VERSION_PATCH}/$PA/" ../sqlite-vec/sqlite-vec.h.tmpl > sqlite-vec.h
SYS="../$SDK/share/wasi-sysroot"; CC="../$SDK/bin/clang --target=wasm32-wasip1 --sysroot=$SYS"; CF="$(cat "$HERE/cflags.txt")"
$CC -Oz $CF -DSQLITE_EXTRA_INIT=jv_extra_init -c sqlite3.c -o sqlite3.o
$CC -Oz $CF -DSQLITE_CORE -DSQLITE_VEC_STATIC -c jvos.c -o jvos.o
$CC -Oz $CF -DSQLITE_CORE -DSQLITE_VEC_STATIC -c sqlite-vec.c -o vec.o
L="$SYS/lib/wasm32-wasip1"; EX=$(tr -s ' \n' '\n\n' < "$HERE/exports.txt" | grep . | sed 's/^/--export=/' | tr '\n' ' ')
"../$SDK/bin/wasm-ld" "$L/crt1-reactor.o" sqlite3.o jvos.o vec.o "$L/libc.a" "$L/libm.a" "../$SDK/lib/clang/20/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a" \
  --no-entry --strip-all --gc-sections $EX -o "$ROOT/app/vendor/sqlite3.min.wasm"
ls -l "$ROOT/app/vendor/sqlite3.min.wasm"
