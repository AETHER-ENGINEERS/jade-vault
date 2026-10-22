SQLite 3.53.4 + sqlite-vec 0.1.9 for Jade Vault (embedded in index.html as gzip+base64, id="sqlite-wasm")

Built from the official amalgamation (sqlite3.c) and the sqlite-vec amalgamation (sqlite-vec.c) with clang for
wasm32-wasip1 against a wasi-libc sysroot (wasi-sdk 27), no Emscripten. `./build.sh` does all of it:
  clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot> -Oz $(cat cflags.txt) -DSQLITE_EXTRA_INIT=jv_extra_init -c sqlite3.c
  clang … -DSQLITE_CORE -DSQLITE_VEC_STATIC -c jvos.c sqlite-vec.c
  wasm-ld crt1-reactor.o sqlite3.o jvos.o vec.o libc.a libm.a libclang_rt.builtins.a --no-entry --strip-all --gc-sections
          $(sed 's/^/--export=/' exports.txt) -o sqlite3.min.wasm
jvos.c is the tiny OS layer (SQLITE_OS_OTHER): no file I/O at all. Databases live in memory and are
loaded/saved as whole vault files with sqlite3_deserialize / sqlite3_serialize, so .db files are normal
SQLite files you can open anywhere.

sqlite-vec is linked in and registered for every connection (SQLITE_EXTRA_INIT → sqlite3_auto_extension): vec0 virtual
tables (float / int8 / bit vectors, KNN with `embedding MATCH ? AND k = ?`, partition keys), vec_distance_L2 / cosine /
hamming, vec_f32, vec_to_json and the rest, in the sqlite3 shell, Python's sqlite3, node:sqlite and Jade's own vector
memory (app/modules/embed.js). It pulls in a little of wasi-libc's stdio, so besides WASI clock_time_get and random_get the
module imports fd_close, fd_seek, fd_write, fd_prestat_get, fd_prestat_dir_name and proc_exit; sqlite_glue.js stubs them.
