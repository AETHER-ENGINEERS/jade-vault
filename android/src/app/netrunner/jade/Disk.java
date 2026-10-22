package app.netrunner.jade;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The vault on real storage. Vault paths ("/notes/a.md") map straight onto files under one root folder,
 * so the vault is an ordinary directory tree that other apps (a file manager, Pydroid) can open and edit.
 * Pure java.io on purpose: it is unit-tested on a plain JVM (android/test/DiskTest.java).
 */
public final class Disk {
    public static final String TMP = ".jvtmp";
    private final File root;
    private final String rootCanon;

    public Disk(File root) throws IOException {
        this.root = root;
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) throw new IOException("cannot create " + root);
        this.rootCanon = root.getCanonicalPath();
    }

    public File root() { return root; }

    /** Vault path to a File inside the root. Rejects anything that could escape it. */
    File file(String vp) throws IOException {
        if (vp == null || vp.length() == 0 || vp.charAt(0) != '/') throw new IOException("bad path: " + vp);
        File f = root;
        if (!vp.equals("/")) {
            String[] parts = vp.substring(1).split("/", -1);
            for (String s : parts) {
                if (s.length() == 0 || s.equals(".") || s.equals("..") || s.indexOf('\0') >= 0) throw new IOException("bad path: " + vp);
                f = new File(f, s);
            }
        }
        String c = f.getCanonicalPath();
        if (!c.equals(rootCanon) && !c.startsWith(rootCanon + File.separator)) throw new IOException("outside the vault: " + vp);
        return f;
    }

    /** [[path,isDir,size,mtime],...] for everything under the root (not the root itself). Stale temp files are removed. */
    public String scan() throws IOException {
        StringBuilder b = new StringBuilder("[");
        boolean[] first = { true };
        walk(root, "", b, first);
        return b.append(']').toString();
    }

    private void walk(File dir, String vp, StringBuilder b, boolean[] first) throws IOException {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        Arrays.sort(kids);
        for (File k : kids) {
            String name = k.getName();
            if (name.endsWith(TMP)) { if (System.currentTimeMillis() - k.lastModified() > 3600000L) k.delete(); continue; }   // only abandoned ones; a write may be in flight
            String p = vp + "/" + name;
            if (k.isDirectory()) {
                if (!k.getCanonicalPath().equals(new File(dir.getCanonicalFile(), name).getPath())) continue;   // a symlink: do not follow
                add(b, first, p, true, 0, k.lastModified());
                walk(k, p, b, first);
            } else if (k.isFile()) {
                add(b, first, p, false, k.length(), k.lastModified());
            }
        }
    }

    private static void add(StringBuilder b, boolean[] first, String p, boolean dir, long size, long mtime) {
        if (!first[0]) b.append(',');
        first[0] = false;
        b.append('[').append(json(p)).append(',').append(dir ? 1 : 0).append(',').append(size).append(',').append(mtime).append(']');
    }

    static String json(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    /** Up to len bytes starting at off (empty at end of file). */
    public byte[] read(String vp, long off, int len) throws IOException {
        File f = file(vp);
        if (!f.isFile()) throw new IOException("no such file: " + vp);
        RandomAccessFile r = new RandomAccessFile(f, "r");
        try {
            long n = Math.max(0, Math.min((long) len, r.length() - off));
            byte[] out = new byte[(int) n];
            r.seek(off);
            r.readFully(out);
            return out;
        } finally { r.close(); }
    }

    /**
     * Write a file in chunks. The first chunk starts a temp file next to the target, the last one renames it into
     * place, so a crash never leaves a half-written note. Returns the final mtime on the last chunk, else 0.
     */
    public long put(String vp, byte[] bytes, boolean first, boolean last) throws IOException {
        File f = file(vp);
        File tmp = new File(f.getPath() + TMP);
        if (first) {
            File par = f.getParentFile();
            if (!par.isDirectory() && !par.mkdirs() && !par.isDirectory()) throw new IOException("cannot create " + par);
            if (f.isDirectory()) throw new IOException("is a directory: " + vp);
        }
        FileOutputStream o = new FileOutputStream(tmp, !first);
        try { o.write(bytes); o.flush(); try { o.getFD().sync(); } catch (IOException ignore) {} } finally { o.close(); }
        if (!last) return 0;
        if (f.exists() && !f.delete()) throw new IOException("cannot replace " + vp);
        if (!tmp.renameTo(f)) throw new IOException("cannot finish " + vp);
        return f.lastModified();
    }

    public void mkdir(String vp) throws IOException {
        File f = file(vp);
        if (f.isDirectory()) return;
        if (!f.mkdirs() && !f.isDirectory()) throw new IOException("cannot create " + vp);
    }

    public void delete(String vp) throws IOException {
        if (vp.equals("/")) throw new IOException("refusing to delete the vault root");
        File f = file(vp);
        if (f.exists()) deleteTree(f);
    }

    private static void deleteTree(File f) throws IOException {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        if (!f.delete() && f.exists()) throw new IOException("cannot delete " + f);
    }

    public void move(String a, String b) throws IOException {
        File fa = file(a), fb = file(b);
        if (!fa.exists()) throw new IOException("no such file: " + a);
        File par = fb.getParentFile();
        if (!par.isDirectory() && !par.mkdirs() && !par.isDirectory()) throw new IOException("cannot create " + par);
        if (fb.exists()) deleteTree(fb);
        if (!fa.renameTo(fb)) {
            copyTree(fa, fb);
            deleteTree(fa);
        }
    }

    public long touch(String vp, long mtime) throws IOException {
        File f = file(vp);
        if (!f.exists()) throw new IOException("no such file: " + vp);
        f.setLastModified(mtime);
        return f.lastModified();
    }

    /** Bytes free on the volume holding the vault. */
    public long free() { return root.getUsableSpace(); }

    /** Empty everything under the root (full-backup restore). */
    public void clear() throws IOException {
        File[] kids = root.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
    }

    public boolean isEmpty() {
        String[] k = root.list();
        return k == null || k.length == 0;
    }

    /** Copy everything from another vault folder that is not already here, then remove the other one. */
    public int mergeFrom(Disk other) throws IOException {
        int n = copyMissing(other.root, root);
        other.clear();
        return n;
    }

    private static int copyMissing(File from, File to) throws IOException {
        int n = 0;
        File[] kids = from.listFiles();
        if (kids == null) return 0;
        for (File k : kids) {
            if (k.getName().endsWith(TMP)) continue;
            File t = new File(to, k.getName());
            if (k.isDirectory()) { if (!t.isDirectory() && !t.mkdirs()) throw new IOException("cannot create " + t); n += copyMissing(k, t); }
            else if (!t.exists()) { copyFile(k, t); n++; }
        }
        return n;
    }

    private static void copyTree(File a, File b) throws IOException {
        if (a.isDirectory()) {
            if (!b.isDirectory() && !b.mkdirs()) throw new IOException("cannot create " + b);
            File[] kids = a.listFiles();
            if (kids != null) for (File k : kids) copyTree(k, new File(b, k.getName()));
        } else copyFile(a, b);
    }

    private static void copyFile(File a, File b) throws IOException {
        FileInputStream i = new FileInputStream(a);
        try {
            FileOutputStream o = new FileOutputStream(b);
            try {
                byte[] buf = new byte[1 << 16];
                int r;
                while ((r = i.read(buf)) > 0) o.write(buf, 0, r);
            } finally { o.close(); }
        } finally { i.close(); }
        b.setLastModified(a.lastModified());
    }

    public List<String> names() {
        List<String> out = new ArrayList<String>();
        String[] k = root.list();
        if (k != null) out.addAll(Arrays.asList(k));
        return out;
    }
}
