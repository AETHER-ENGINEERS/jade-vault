package app.netrunner.jade;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The vault on real storage. Vault paths ("/notes/a.md") map straight onto files under one root folder,
 * so the vault is an ordinary directory tree that other apps (a file manager, Pydroid) can open and edit.
 * The work is done in Rust (libjade, rust/android/src/disk.rs), which also parses and searches notes on all cores
 * straight from storage. Tested on a plain JVM (android/test/DiskTest.java) against a host build of the library.
 */
public final class Disk {
    static { Native.load(); }
    public static final String TMP = ".jvtmp";
    private final File root;
    private final long h;

    private static native long nOpen(String root) throws IOException;
    private static native String nFile(long h, String vp) throws IOException;
    private static native String nScan(long h) throws IOException;
    private static native byte[] nRead(long h, String vp, long off, int len) throws IOException;
    private static native long nPut(long h, String vp, byte[] b, boolean first, boolean last) throws IOException;
    private static native void nMkdir(long h, String vp) throws IOException;
    private static native void nDelete(long h, String vp) throws IOException;
    private static native void nMove(long h, String a, String b) throws IOException;
    private static native long nTouch(long h, String vp, long mtime) throws IOException;
    private static native long nFree(long h);
    private static native void nClear(long h) throws IOException;
    private static native boolean nIsEmpty(long h);
    private static native int nMergeFrom(long h, long other) throws IOException;
    private static native String nNames(long h);
    private static native String nParse(long h, String req);
    private static native String nSearch(long h, String req);

    public Disk(File root) throws IOException {
        if (!Native.ok) throw new IOException("the vault's native library did not load: " + Native.error);
        this.root = root; this.h = nOpen(root.getPath());
    }

    public File root() { return root; }

    /** Vault path to a File inside the root. Rejects anything that could escape it. */
    File file(String vp) throws IOException { return new File(nFile(h, vp)); }

    /** [[path,isDir,size,mtime],...] for everything under the root (not the root itself). Stale temp files are removed. */
    public String scan() throws IOException { return nScan(h); }

    /** Up to len bytes from offset off (empty at end of file). */
    public byte[] read(String vp, long off, int len) throws IOException { return nRead(h, vp, off, len); }

    /** Chunked atomic write: the first chunk starts a temp file, the last renames it into place. Returns the mtime on the last chunk. */
    public long put(String vp, byte[] bytes, boolean first, boolean last) throws IOException { return nPut(h, vp, bytes, first, last); }

    public void mkdir(String vp) throws IOException { nMkdir(h, vp); }

    public void delete(String vp) throws IOException { nDelete(h, vp); }

    public void move(String a, String b) throws IOException { nMove(h, a, b); }

    public long touch(String vp, long mtime) throws IOException { return nTouch(h, vp, mtime); }

    /** Bytes free on the volume holding the vault. */
    public long free() { return nFree(h); }

    /** Empty everything under the root (full-backup restore). */
    public void clear() throws IOException { nClear(h); }

    public boolean isEmpty() { return nIsEmpty(h); }

    /** Copy everything from another vault folder that is not already here, then empty the other one. */
    public int mergeFrom(Disk other) throws IOException { return nMergeFrom(h, other.h); }

    @SuppressWarnings("unchecked")
    public List<String> names() { List<String> out = new ArrayList<String>(); for (Object o : (List<Object>) MiniJson.parse(nNames(h))) out.add((String) o); return out; }

    /** Parse notes from storage on all cores: {"paths":[[path,sig],...]} → {path:{sig,wiki,md,tags,words}}. */
    public String parse(String req) { return nParse(h, req); }

    /** Search notes from storage on all cores: {q,paths,backlinks,tag_hit,limit} → [{path,score,snippet}]. */
    public String search(String req) { return nSearch(h, req); }
}
