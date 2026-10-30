import app.netrunner.jade.Disk;
import java.io.File;
import java.nio.file.Files;

/** Plain-JVM test of the on-disk vault layer:  android/test/run.sh */
public class DiskTest {
    static int fails = 0;
    static void ok(boolean c, String m) { if (!c) { fails++; System.out.println("FAIL " + m); } else System.out.println("ok   " + m); }
    static boolean threw(Runnable r) { try { r.run(); return false; } catch (RuntimeException e) { return true; } }
    interface T { void run() throws Exception; }
    static boolean bad(T t) { try { t.run(); return false; } catch (Exception e) { return true; } }

    public static void main(String[] a) throws Exception {
        File tmp = Files.createTempDirectory("jv").toFile();
        Disk d = new Disk(new File(tmp, "JadeVault"));
        ok(d.scan().equals("[]"), "empty vault scans empty");

        d.mkdir("/notes");
        long m = d.put("/notes/a.md", "hello".getBytes("UTF-8"), true, true);
        ok(m > 0, "put returns mtime");
        ok(new String(d.read("/notes/a.md", 0, 100), "UTF-8").equals("hello"), "read back");
        ok(new String(d.read("/notes/a.md", 1, 3), "UTF-8").equals("ell"), "read a range");
        ok(d.read("/notes/a.md", 5, 10).length == 0, "read at EOF is empty");

        // chunked write, only visible after the last chunk
        d.put("/big.bin", new byte[]{1, 2, 3}, true, false);
        ok(!new File(d.root(), "big.bin").exists(), "half-written file is not in place yet");
        ok(d.scan().indexOf("big.bin") < 0, "scan hides temp files...");
        ok(new File(d.root(), "big.bin" + Disk.TMP).exists(), "...and leaves one that is being written");
        d.put("/big.bin", new byte[]{4, 5}, false, true);
        ok(d.read("/big.bin", 0, 10).length == 5, "chunks joined");
        d.put("/stale.md", new byte[]{9}, true, false);    // leaves stale.md.jvtmp
        new File(d.root(), "stale.md.jvtmp").setLastModified(System.currentTimeMillis() - 7200000L);
        d.scan();
        ok(!new File(d.root(), "stale.md.jvtmp").exists(), "...and removes abandoned temp files");

        // overwrite
        d.put("/notes/a.md", "v2".getBytes("UTF-8"), true, true);
        ok(new String(d.read("/notes/a.md", 0, 100), "UTF-8").equals("v2"), "overwrite");

        // unicode + quotes in names survive the JSON
        d.put("/n\"q r.md", "x".getBytes(), true, true);
        ok(d.scan().contains("n\\\"q r.md"), "special names are escaped in the scan");

        // path safety
        ok(bad(() -> d.put("/../evil", new byte[]{1}, true, true)), "rejects ..");
        ok(bad(() -> d.read("/notes/../../x", 0, 1)), "rejects .. in the middle");
        ok(bad(() -> d.read("rel", 0, 1)), "rejects relative paths");
        ok(bad(() -> d.delete("/")), "refuses to delete the root");

        // move / delete
        d.move("/notes", "/archive");
        ok(new File(d.root(), "archive/a.md").isFile() && !new File(d.root(), "notes").exists(), "move a folder");
        d.put("/x.md", "x".getBytes(), true, true);
        d.move("/x.md", "/deep/er/x.md");
        ok(new File(d.root(), "deep/er/x.md").isFile(), "move creates parents");
        d.delete("/archive");
        ok(!new File(d.root(), "archive").exists(), "recursive delete");
        d.delete("/never-existed");

        // touch
        long t = d.touch("/big.bin", 1500000000000L);
        ok(t / 1000 == 1500000000L, "touch sets mtime");

        // symlink loop is not followed
        try {
            Files.createSymbolicLink(new File(d.root(), "loop").toPath(), d.root().toPath());
            String s = d.scan();
            ok(!s.contains("/loop/"), "symlinks are not followed");
        } catch (UnsupportedOperationException e) { ok(true, "symlinks unsupported here"); }

        // merge from an app-private vault into shared storage
        Disk app = new Disk(new File(tmp, "app"));
        app.put("/keep.md", "app".getBytes(), true, true);
        app.put("/notes/z.md", "z".getBytes(), true, true);
        d.put("/keep.md", "shared".getBytes(), true, true);
        int n = d.mergeFrom(app);
        ok(n == 1, "merge copies only what is missing (" + n + ")");
        ok(new String(d.read("/keep.md", 0, 10)).equals("shared"), "merge never overwrites");
        ok(new String(d.read("/notes/z.md", 0, 10)).equals("z"), "merge brings new files");
        ok(app.isEmpty(), "the old vault is emptied after the merge");

        d.clear();
        ok(d.isEmpty(), "clear");
        System.out.println(fails == 0 ? "ALL PASSED" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
