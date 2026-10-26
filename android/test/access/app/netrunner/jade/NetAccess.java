package app.netrunner.jade;

/** Test access to the package-private Net class. */
public final class NetAccess {
    public static String start(String r) { return Net.start(r); }
    public static String poll(long id) { return Net.poll(id); }
    public static void abort(long id) { Net.abort(id); }
    public static int wakes() { return Net.wakes.get(); }
}
