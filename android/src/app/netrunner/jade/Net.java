package app.netrunner.jade;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The page's fetch() on the phone, done in Rust (rust/android/src/net.rs): many requests at once on native threads,
 * no CORS, HTTP/2, gzip. The page starts a request and polls for its head and body; when something arrives, the
 * native side calls {@link #wake()}, which nudges the page to poll at once (so replies keep streaming even while the
 * app is in the background and the page's timers are slowed down).
 */
final class Net {
    /** What a wake does (the activity sets it: run the page's poll on the UI thread). */
    interface Waker { void wake(); }
    static volatile Waker waker;
    private static final AtomicBoolean pending = new AtomicBoolean();
    static final java.util.concurrent.atomic.AtomicInteger wakes = new java.util.concurrent.atomic.AtomicInteger();
    static {
        Native.load();
        if (Native.ok) { try { nInit(); } catch (Throwable ignored) { } }
    }
    private static native void nInit();
    private static native long nStart(String req) throws java.io.IOException;
    private static native String nPoll(long id);
    private static native void nAbort(long id);

    /** {method, url, headers: [[k, v]...], body?: base64} → id, or "ERR:..." */
    static String start(String req) { if (!Native.ok) return "ERR:native: " + Native.error; try { return Long.toString(nStart(req)); } catch (Throwable e) { return "ERR:" + e.getMessage(); } }
    /** {head?, data?: base64, done, error?} */
    static String poll(long id) { try { return nPoll(id); } catch (Throwable e) { return "{\"done\":true,\"error\":" + MiniJson.quote(String.valueOf(e.getMessage())) + "}"; } }
    static void abort(long id) { try { nAbort(id); } catch (Throwable ignored) { } }

    /** Called from native threads: at most one nudge waits at a time. */
    static void wake() {
        wakes.incrementAndGet();
        Waker w = waker;
        if (w != null && pending.compareAndSet(false, true)) w.wake();
    }
    /** The waker calls this when the nudge has been delivered, so the next arrival nudges again. */
    static void woke() { pending.set(false); }
    private Net() {}
}
