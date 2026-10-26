//! libjade.so: the Android app's native core. Java keeps thin classes (Disk, SentryEngine) whose methods call these.
//! Handles are boxed Rust objects passed to Java as a long; the Java object owns its handle for its lifetime.

#![allow(non_snake_case, clippy::missing_safety_doc)]

mod disk;
pub mod net;
mod jni;

use disk::Disk;
use jade_core::sentry;
use jni::{bytes, jbytes, jstr, string, throw_io, Env};
use jni_sys::{jboolean, jbyteArray, jclass, jint, jlong, jstring, JNI_TRUE};
use serde_json::Value;

unsafe fn disk<'a>(h: jlong) -> &'a Disk {
    &*(h as *const Disk)
}

/// Run a Disk operation; an error becomes a Java IOException and `dflt` is returned.
macro_rules! io {
    ($env:expr, $dflt:expr, $body:expr) => {
        match $body {
            Ok(v) => v,
            Err(e) => {
                throw_io($env, &e.to_string());
                $dflt
            }
        }
    };
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nOpen(env: Env, _: jclass, root: jstring) -> jlong {
    io!(env, 0, Disk::open(&string(env, root)).map(|d| Box::into_raw(Box::new(d)) as jlong))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nFile(env: Env, _: jclass, h: jlong, vp: jstring) -> jstring {
    let p = io!(env, String::new(), disk(h).file(&string(env, vp)).map(|f| f.to_string_lossy().into_owned()));
    jstr(env, &p)
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nScan(env: Env, _: jclass, h: jlong) -> jstring {
    let s = io!(env, String::new(), disk(h).scan());
    jstr(env, &s)
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nRead(env: Env, _: jclass, h: jlong, vp: jstring, off: jlong, len: jint) -> jbyteArray {
    let b = io!(env, Vec::new(), disk(h).read(&string(env, vp), off.max(0) as u64, len.max(0) as usize));
    jbytes(env, &b)
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nPut(env: Env, _: jclass, h: jlong, vp: jstring, b: jbyteArray, first: jboolean, last: jboolean) -> jlong {
    io!(env, 0, disk(h).put(&string(env, vp), &bytes(env, b), first == JNI_TRUE, last == JNI_TRUE))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nMkdir(env: Env, _: jclass, h: jlong, vp: jstring) {
    io!(env, (), disk(h).mkdir(&string(env, vp)))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nDelete(env: Env, _: jclass, h: jlong, vp: jstring) {
    io!(env, (), disk(h).delete(&string(env, vp)))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nMove(env: Env, _: jclass, h: jlong, a: jstring, b: jstring) {
    io!(env, (), disk(h).move_(&string(env, a), &string(env, b)))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nTouch(env: Env, _: jclass, h: jlong, vp: jstring, mtime: jlong) -> jlong {
    io!(env, 0, disk(h).touch(&string(env, vp), mtime))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nFree(_: Env, _: jclass, h: jlong) -> jlong {
    disk(h).free()
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nClear(env: Env, _: jclass, h: jlong) {
    io!(env, (), disk(h).clear())
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nIsEmpty(_: Env, _: jclass, h: jlong) -> jboolean {
    disk(h).is_empty() as jboolean
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nMergeFrom(env: Env, _: jclass, h: jlong, other: jlong) -> jint {
    io!(env, 0, disk(h).merge_from(disk(other)))
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nNames(env: Env, _: jclass, h: jlong) -> jstring {
    jstr(env, &Value::from(disk(h).names()).to_string())
}

/// Parse notes from storage on all cores (JSON in, JSON out; see Disk::parse_notes).
#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nParse(env: Env, _: jclass, h: jlong, req: jstring) -> jstring {
    let req: Value = serde_json::from_str(&string(env, req)).unwrap_or(Value::Null);
    jstr(env, &disk(h).parse_notes(&req).to_string())
}

/// Search notes from storage on all cores (see Disk::search).
#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Disk_nSearch(env: Env, _: jclass, h: jlong, req: jstring) -> jstring {
    let req: Value = serde_json::from_str(&string(env, req)).unwrap_or(Value::Null);
    jstr(env, &disk(h).search(&req).to_string())
}

// ------------------------------------------------------------------ Sentry
#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_SentryEngine_nNew(_: Env, _: jclass) -> jlong {
    Box::into_raw(Box::new(sentry::Engine::new())) as jlong
}

/// One engine command: {op, now, tz, ...} → JSON (see jade_core::sentry::command). Java serialises calls.
#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_SentryEngine_nCall(env: Env, _: jclass, h: jlong, req: jstring) -> jstring {
    let e = &mut *(h as *mut sentry::Engine);
    let req: Value = serde_json::from_str(&string(env, req)).unwrap_or(Value::Null);
    jstr(env, &sentry::command(e, &req).to_string())
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_SentryEngine_nFree(_: Env, _: jclass, h: jlong) {
    if h != 0 {
        drop(Box::from_raw(h as *mut sentry::Engine));
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_SentryEngine_nMeters(_: Env, _: jclass, a: f64, b: f64, c: f64, d: f64) -> f64 {
    sentry::meters(a, b, c, d)
}

// ------------------------------------------------------------------ Net (the page's fetch on the phone)
#[no_mangle]
pub unsafe extern "system" fn JNI_OnLoad(vm: *mut jni_sys::JavaVM, _: *mut std::ffi::c_void) -> jint {
    jni::set_vm(vm);
    jni_sys::JNI_VERSION_1_6
}

/// Net's static initialiser: lets native threads call Net.wake() when a response has news for the page.
#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Net_nInit(env: Env, cls: jclass) {
    jni::set_wake(env, cls);
}

pub(crate) fn wake() {
    jni::wake();
}

/// Start a request ({method, url, headers, body?: base64}); returns its id, or throws IOException for a bad one.
#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Net_nStart(env: Env, _: jclass, req: jstring) -> jlong {
    let v: Value = serde_json::from_str(&string(env, req)).unwrap_or(Value::Null);
    match net::Req::from_json(&v) {
        Ok(r) => net::start(r) as jlong,
        Err(e) => {
            throw_io(env, &e);
            0
        }
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Net_nPoll(env: Env, _: jclass, id: jlong) -> jstring {
    jstr(env, &net::poll(id as u64).to_string())
}

#[no_mangle]
pub unsafe extern "system" fn Java_app_netrunner_jade_Net_nAbort(_: Env, _: jclass, id: jlong) {
    net::abort(id as u64)
}
