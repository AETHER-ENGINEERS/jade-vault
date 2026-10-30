package app.netrunner.jade;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Base64;

import java.io.File;

/**
 * Android side of the on-disk vault: picks where the vault folder lives and answers the page's
 * disk* calls. Preferred home is /storage/emulated/0/JadeVault (needs "all files access");
 * until that is granted the vault lives in the app's own folder on shared storage.
 * Every call returns a string: a value, or "ERR:message".
 */
final class DiskHost {
    private final MainActivity a;
    private Disk disk;
    private String mode = "app", warn = "";

    DiskHost(MainActivity a) { this.a = a; }

    boolean sharedOk() {
        try {
            if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
            return a.checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE") == 0;
        } catch (Exception e) { return false; }
    }

    File sharedRoot() { return new File(Environment.getExternalStorageDirectory(), "JadeVault"); }

    File appRoot() {
        File x = null;
        try { x = a.getExternalFilesDir(null); } catch (Exception ignored) { }
        if (x == null) x = a.getFilesDir();
        return new File(x, "vault");
    }

    private synchronized Disk disk() throws Exception {
        if (disk != null) return disk;
        String want = a.prefs().getString("vault_root", null);
        if (want == null) { want = sharedOk() ? "shared" : "app"; a.prefs().edit().putString("vault_root", want).apply(); }
        warn = "";
        if (want.equals("shared")) {
            if (sharedOk()) {
                try { disk = new Disk(sharedRoot()); mode = "shared"; return disk; } catch (Exception e) { warn = "Could not open " + sharedRoot() + ": " + e.getMessage(); }
            } else warn = "Storage permission was turned off, so JadeVault is out of reach. Using the app folder until it is allowed again.";
        }
        mode = "app";
        try { disk = new Disk(appRoot()); } catch (Exception e) { disk = new Disk(new File(a.getFilesDir(), "vault")); }
        return disk;
    }

    /** The real file behind a vault path (for sharing it with a TV). */
    File fileOf(String vp) throws Exception { return disk().file(vp); }

    String info() {
        try {
            Disk d = disk();
            return "{\"root\":" + MiniJson.quote(d.root().getPath()) + ",\"mode\":\"" + mode + "\",\"sharedOk\":" + sharedOk()
                + ",\"free\":" + d.free() + ",\"warn\":" + MiniJson.quote(warn) + ",\"sdk\":" + Build.VERSION.SDK_INT + "}";
        } catch (Exception e) { return err(e); }
    }

    String scan() { try { return disk().scan(); } catch (Exception e) { return err(e); } }
    /** Parse notes on all cores, straight from storage (Rust). */
    String parse(String req) { try { return disk().parse(req); } catch (Exception e) { return err(e); } }
    /** Search notes on all cores, straight from storage (Rust). */
    String search(String req) { try { return disk().search(req); } catch (Exception e) { return err(e); } }

    String get(String p, double off, int len) {
        try { return Base64.encodeToString(disk().read(p, (long) off, len), Base64.NO_WRAP); } catch (Exception e) { return err(e); }
    }

    String put(String p, String b64, boolean first, boolean last) {
        try { return "ok:" + disk().put(p, Base64.decode(b64, Base64.DEFAULT), first, last); } catch (Exception e) { return err(e); }
    }

    String mkdir(String p) { try { disk().mkdir(p); return "ok"; } catch (Exception e) { return err(e); } }
    String del(String p) { try { disk().delete(p); return "ok"; } catch (Exception e) { return err(e); } }
    String move(String x, String y) { try { disk().move(x, y); return "ok"; } catch (Exception e) { return err(e); } }
    String touch(String p, double mtime) { try { return "ok:" + disk().touch(p, (long) mtime); } catch (Exception e) { return err(e); } }
    String clear() { try { disk().clear(); return "ok"; } catch (Exception e) { return err(e); } }

    /** Move the vault into /storage/emulated/0/JadeVault. Asks for the permission first if it is missing. */
    synchronized String useShared() {
        try {
            if (!sharedOk()) { askPermission(); return "need-permission"; }
            Disk s = new Disk(sharedRoot());
            if (!appRoot().equals(s.root())) { Disk ap = new Disk(appRoot()); s.mergeFrom(ap); }
            a.prefs().edit().putString("vault_root", "shared").apply();
            disk = null;
            return "ok";
        } catch (Exception e) { return err(e); }
    }

    private void askPermission() {
        a.runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 30) {
                        Intent i;
                        try { i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + a.getPackageName())); a.startActivity(i); }
                        catch (Exception e) { a.startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)); }
                    } else a.requestPermissions(new String[] { "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.READ_EXTERNAL_STORAGE" }, MainActivity.REQ_PERMS);
                } catch (Exception ignored) { }
            }
        });
    }

    private static String err(Exception e) { return "ERR:" + (e.getMessage() == null ? e.toString() : e.getMessage()); }
}
