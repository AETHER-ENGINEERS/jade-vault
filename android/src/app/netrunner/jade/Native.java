package app.netrunner.jade;

/**
 * Loads libjade (the Rust core). On a phone it comes from the APK; tests on a plain JVM point -Djade.lib at a host
 * build. Never throws: if the library cannot load, {@link #ok} is false and its users fall back (the vault to the
 * browser database, the network to the WebView, Sentry to reporting the problem).
 */
final class Native {
    private static boolean done;
    static boolean ok;
    static String error = "";
    static synchronized void load() {
        if (done) return;
        done = true;
        try {
            String p = System.getProperty("jade.lib");
            if (p != null && p.length() > 0) System.load(p); else System.loadLibrary("jade");
            ok = true;
        } catch (Throwable t) { error = String.valueOf(t); }
    }
    private Native() {}
}
