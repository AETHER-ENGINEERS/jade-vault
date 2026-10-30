//! The little of JNI this library needs, over jni-sys: Java strings in and out (as UTF-16, so every character
//! survives), byte arrays, and throwing IOException.

use jni_sys::{jbyteArray, jsize, jstring, JNIEnv};
use std::ptr;

pub type Env = *mut JNIEnv;

#[inline]
unsafe fn f(env: Env) -> &'static jni_sys::JNINativeInterface_ {
    &**env
}

/// A Java String as a Rust String (empty for null).
pub unsafe fn string(env: Env, s: jstring) -> String {
    if s.is_null() {
        return String::new();
    }
    let len = (f(env).v1_1.GetStringLength)(env, s) as usize;
    let chars = (f(env).v1_1.GetStringChars)(env, s, ptr::null_mut());
    if chars.is_null() {
        return String::new();
    }
    let out = String::from_utf16_lossy(std::slice::from_raw_parts(chars, len));
    (f(env).v1_1.ReleaseStringChars)(env, s, chars);
    out
}

/// A Rust str as a new Java String.
pub unsafe fn jstr(env: Env, s: &str) -> jstring {
    let u: Vec<u16> = s.encode_utf16().collect();
    (f(env).v1_1.NewString)(env, u.as_ptr(), u.len() as jsize)
}

pub unsafe fn bytes(env: Env, a: jbyteArray) -> Vec<u8> {
    if a.is_null() {
        return Vec::new();
    }
    let n = (f(env).v1_1.GetArrayLength)(env, a) as usize;
    let mut v = vec![0u8; n];
    if n > 0 {
        (f(env).v1_1.GetByteArrayRegion)(env, a, 0, n as jsize, v.as_mut_ptr() as *mut i8);
    }
    v
}

pub unsafe fn jbytes(env: Env, b: &[u8]) -> jbyteArray {
    let a = (f(env).v1_1.NewByteArray)(env, b.len() as jsize);
    if !a.is_null() && !b.is_empty() {
        (f(env).v1_1.SetByteArrayRegion)(env, a, 0, b.len() as jsize, b.as_ptr() as *const i8);
    }
    a
}

/// Throw java.io.IOException(msg); the native method's return value is then ignored by Java.
pub unsafe fn throw_io(env: Env, msg: &str) {
    let cls = (f(env).v1_1.FindClass)(env, c"java/io/IOException".as_ptr());
    if cls.is_null() {
        return;
    }
    let m = std::ffi::CString::new(msg.replace('\0', " ")).unwrap_or_default();
    (f(env).v1_1.ThrowNew)(env, cls, m.as_ptr());
}

// ------------------------------------------------------------------ calling back into Java (from native threads)
use jni_sys::{jclass, jmethodID, JavaVM};
use std::sync::atomic::{AtomicPtr, Ordering};

static VM: AtomicPtr<JavaVM> = AtomicPtr::new(ptr::null_mut());
static WAKE_CLS: AtomicPtr<jni_sys::_jobject> = AtomicPtr::new(ptr::null_mut());
static WAKE_MID: AtomicPtr<jni_sys::_jmethodID> = AtomicPtr::new(ptr::null_mut());

pub fn set_vm(vm: *mut JavaVM) {
    VM.store(vm, Ordering::Release);
}

/// Remember `cls.wake()` (a static void method) so native threads can call it.
pub unsafe fn set_wake(env: Env, cls: jclass) {
    let mid: jmethodID = (f(env).v1_1.GetStaticMethodID)(env, cls, c"wake".as_ptr(), c"()V".as_ptr());
    if mid.is_null() {
        (f(env).v1_1.ExceptionClear)(env);
        return;
    }
    let g = (f(env).v1_1.NewGlobalRef)(env, cls);
    WAKE_MID.store(mid, Ordering::Release);
    WAKE_CLS.store(g, Ordering::Release);
}

/// Tell the Java side that something arrived (it wakes the page). A no-op outside a JVM (cargo test).
pub fn wake() {
    let (vm, cls, mid) = (VM.load(Ordering::Acquire), WAKE_CLS.load(Ordering::Acquire), WAKE_MID.load(Ordering::Acquire));
    if vm.is_null() || cls.is_null() || mid.is_null() {
        return;
    }
    unsafe {
        let mut env: *mut std::ffi::c_void = ptr::null_mut();
        // daemon threads: the runtime's threads never have to be detached
        if ((**vm).v1_4.AttachCurrentThreadAsDaemon)(vm, &mut env, ptr::null_mut()) != 0 || env.is_null() {
            return;
        }
        let env = env as Env;
        (f(env).v1_1.CallStaticVoidMethodA)(env, cls, mid, ptr::null());
        if (f(env).v1_2.ExceptionCheck)(env) {
            (f(env).v1_1.ExceptionClear)(env);
        }
    }
}
