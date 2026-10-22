package app.netrunner.jade;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.Charset;

/** The SSH wire formats (RFC 4251): reading and writing uint32, strings, mpints and name-lists. */
public final class SshWire {
    private SshWire() { }
    static final Charset UTF8 = Charset.forName("UTF-8");

    public static final class Wr {
        private final ByteArrayOutputStream o = new ByteArrayOutputStream();
        public Wr u8(int v) { o.write(v); return this; }
        public Wr bool(boolean v) { o.write(v ? 1 : 0); return this; }
        public Wr u32(long v) { o.write((int) (v >>> 24)); o.write((int) (v >>> 16)); o.write((int) (v >>> 8)); o.write((int) v); return this; }
        public Wr raw(byte[] b) { o.write(b, 0, b.length); return this; }
        public Wr raw(byte[] b, int off, int len) { o.write(b, off, len); return this; }
        public Wr str(byte[] b) { u32(b.length); return raw(b); }
        public Wr str(String s) { return str(s.getBytes(UTF8)); }
        public Wr mpint(BigInteger v) {
            if (v.signum() == 0) return u32(0);
            return str(v.toByteArray());   // two's complement, minimal, with a leading zero when the top bit is set: exactly the SSH form
        }
        public byte[] toBytes() { return o.toByteArray(); }
    }

    public static final class Rd {
        private final byte[] b; private int p;
        public Rd(byte[] b) { this(b, 0); }
        public Rd(byte[] b, int off) { this.b = b; this.p = off; }
        public int pos() { return p; }
        public int left() { return b.length - p; }
        private void need(int n) throws IOException { if (n < 0 || p + n > b.length) throw new IOException("a message from the server was cut short"); }
        public int u8() throws IOException { need(1); return b[p++] & 0xff; }
        public boolean bool() throws IOException { return u8() != 0; }
        public long u32() throws IOException { need(4); long v = ((b[p] & 0xffL) << 24) | ((b[p + 1] & 0xffL) << 16) | ((b[p + 2] & 0xffL) << 8) | (b[p + 3] & 0xffL); p += 4; return v; }
        public byte[] raw(int n) throws IOException { need(n); byte[] r = new byte[n]; System.arraycopy(b, p, r, 0, n); p += n; return r; }
        public byte[] str() throws IOException { long n = u32(); if (n > 1 << 24) throw new IOException("a string in a server message is too long"); return raw((int) n); }
        public String strS() throws IOException { return new String(str(), UTF8); }
        public BigInteger mpint() throws IOException { byte[] r = str(); return r.length == 0 ? BigInteger.ZERO : new BigInteger(r); }
        public byte[] rest() { byte[] r = new byte[b.length - p]; System.arraycopy(b, p, r, 0, r.length); p = b.length; return r; }
    }

    public static boolean listHas(String list, String name) {
        for (String s : list.split(",")) if (s.equals(name)) return true;
        return false;
    }
}
