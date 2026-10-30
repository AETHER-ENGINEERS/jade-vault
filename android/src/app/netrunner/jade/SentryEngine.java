package app.netrunner.jade;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * Sentry's rules engine. The engine itself is Rust (libjade, rust/core/src/sentry.rs); this class is the Java face of
 * it, so it is still tested on a plain JVM (android/test/SentryTest) with a fake clock. The host (SentryHost) feeds it sensor readings and events and gets back the triggers that fired.
 *
 * A trigger is  { id, when?, on?, for_s, cooldown_s, max_per_hour, hours, rearm, ... }  (see the page's schema).
 *  - "when" is a state condition: all / any / not over leaves {src, op, value, clear}. A leaf with "clear" is a
 *    hysteresis band: it turns on at "value" but only turns off at "clear", so a reading hovering around the
 *    threshold does not flap.
 *  - a state trigger (no "on") FIRES ON THE EDGE: when its condition has held for "for_s" seconds. It will not
 *    fire again until the condition has cleared (rearm "clear", the default) or the cooldown has passed while
 *    it still holds (rearm "cooldown").
 *  - an event trigger ("on": {event: "notification", ...}) fires when a matching event arrives while "when" holds.
 *  - guards on both: cooldown_s, max_per_hour, and an active-hours window.
 *  - after (re)configuring, a condition that is already true is a baseline, not an edge: restarting the app does
 *    not make every standing condition fire.
 */
public final class SentryEngine {
    static { Native.load(); }
    public interface Clock { long now(); }

    public static final class Fire {
        public final String id, kind;       // kind: "state" or "event"
        public final long at;
        public final Map<String, Object> rule, values, event;
        Fire(String id, String kind, long at, Map<String, Object> rule, Map<String, Object> values, Map<String, Object> event) { this.id = id; this.kind = kind; this.at = at; this.rule = rule; this.values = values; this.event = event; }
    }

    private static native long nNew();
    private static native String nCall(long h, String req);
    private static native void nFree(long h);
    private static native double nMeters(double la1, double lo1, double la2, double lo2);

    private final Clock clock;
    private long h;

    public SentryEngine(Clock clock) { this.clock = clock; this.h = Native.ok ? nNew() : 0; }

    /** Release the native engine. The app keeps one for its whole life, so only tests and reloads need this. */
    public synchronized void close() { if (h != 0) nFree(h); h = 0; }

    /** One call into the engine. Every call carries the time and the local zone offset, so active-hours windows follow the phone's clock. */
    private Object call(String op, Map<String, Object> args) {
        if (h == 0) return fallback(op);
        long now = clock.now();
        Map<String, Object> req = args == null ? new LinkedHashMap<String, Object>() : args;
        req.put("op", op); req.put("now", (double) now); req.put("tz", (double) (TimeZone.getDefault().getOffset(now) / 60000));
        return MiniJson.parse(nCall(h, MiniJson.write(req)));
    }

    /** Without the native library: no rules run, and configure/status say why. */
    private static Object fallback(String op) {
        String why = "Sentry's engine (libjade) did not load: " + Native.error;
        if (op.equals("configure")) { List<Object> l = new ArrayList<Object>(); l.add(why); return l; }
        if (op.equals("next_wake_ms")) return -1.0;
        if (op.equals("value") || op.equals("touch")) return null;
        if (op.equals("status")) { Map<String, Object> m = new LinkedHashMap<String, Object>(); m.put("values", new LinkedHashMap<String, Object>()); m.put("triggers", new ArrayList<Object>()); m.put("error", why); return m; }
        return new ArrayList<Object>();
    }

    private static Map<String, Object> args(Object... kv) { Map<String, Object> m = new LinkedHashMap<String, Object>(); for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]); return m; }

    @SuppressWarnings("unchecked")
    private static List<Fire> fires(Object o) {
        List<Fire> out = new ArrayList<Fire>();
        if (!(o instanceof List)) return out;
        for (Object x : (List<Object>) o) {
            Map<String, Object> f = (Map<String, Object>) x;
            out.add(new Fire((String) f.get("id"), (String) f.get("kind"), ((Double) f.get("at")).longValue(), MiniJson.m(f, "rule"), MiniJson.m(f, "values"), MiniJson.m(f, "event")));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<String> strings(Object o) { List<String> out = new ArrayList<String>(); if (o instanceof List) for (Object x : (List<Object>) o) out.add(String.valueOf(x)); return out; }

    // ---------- configuration ----------
    /** Replace the rules. Triggers whose definition did not change keep their state. Returns problems found (bad rules are skipped). */
    public synchronized List<String> configure(String json) { return strings(call("configure", args("rules", json))); }

    // ---------- input ----------
    public synchronized List<Fire> update(Map<String, Object> readings) { return fires(call("update", args("readings", readings))); }

    public synchronized List<Fire> set(String key, Object value) { Map<String, Object> m = new HashMap<String, Object>(); m.put(key, value); return update(m); }

    public synchronized List<Fire> tick() { return fires(call("tick", null)); }

    /** The user did something (screen on, unlock): resets user.idle_s. */
    public synchronized void touch() { call("touch", null); }

    public synchronized List<Fire> event(String name, Map<String, Object> data) { return fires(call("event", args("name", name, "data", data == null ? new HashMap<String, Object>() : data))); }

    // ---------- scheduling hints and status ----------
    /** Which sources the rules read (so the host only registers the sensors that are needed). */
    public synchronized List<String> sources() { return strings(call("sources", null)); }

    /** Milliseconds until something needs re-evaluating with no new input (a debounce expiring, an idle timer, a cooldown), or -1. */
    public synchronized long nextWakeMs() { return ((Double) call("next_wake_ms", null)).longValue(); }

    public synchronized Object value(String key) { return call("value", args("key", key)); }

    /** JSON: current readings and each trigger's state, for the sentry tool's state/list actions. */
    public synchronized String status() { return MiniJson.write(call("status", null)); }

    /** Distance in metres between two points (haversine). */
    static double meters(double la1, double lo1, double la2, double lo2) { return nMeters(la1, lo1, la2, lo2); }
}
