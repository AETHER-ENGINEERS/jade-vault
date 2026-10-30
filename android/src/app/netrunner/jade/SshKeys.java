package app.netrunner.jade;

import java.io.IOException;
import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.AlgorithmParameters;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.RSAPrivateCrtKeySpec;

/**
 * The user's own private key, for logging in with a key instead of a password. Reads OpenSSH keys (ed25519, RSA,
 * ECDSA), PEM RSA and EC keys, and PKCS#8 RSA keys, when they are not passphrase-protected. Signing is done with the
 * platform's crypto, except Ed25519, which is implemented here so it works on every Android version.
 */
public final class SshKeys {
    private SshKeys() { }

    public static final class Key {
        public final String type;          // ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256…
        public final byte[] publicBlob;
        private final PrivateKey priv;     // RSA / EC
        private final byte[] seed;         // Ed25519
        private final String curve;        // EC: nistp256 | nistp384 | nistp521

        Key(String type, byte[] blob, PrivateKey priv, byte[] seed, String curve) { this.type = type; this.publicBlob = blob; this.priv = priv; this.seed = seed; this.curve = curve; }

        /** Signature algorithm names to offer, best first. */
        public String[] signAlgos() { return type.equals("ssh-rsa") ? new String[] { "rsa-sha2-256", "rsa-sha2-512", "ssh-rsa" } : new String[] { type }; }

        /** The signature as the SSH wire form wants it: for RSA and Ed25519 the raw bytes, for ECDSA string-wrapped r and s. */
        public byte[] sign(String algo, byte[] data) throws GeneralSecurityException {
            if (type.equals("ssh-ed25519")) return Ed25519.sign(seed, data);
            if (type.equals("ssh-rsa")) {
                Signature s = Signature.getInstance(algo.equals("rsa-sha2-512") ? "SHA512withRSA" : algo.equals("rsa-sha2-256") ? "SHA256withRSA" : "SHA1withRSA");
                s.initSign(priv); s.update(data); return s.sign();
            }
            Signature s = Signature.getInstance(curve.equals("nistp256") ? "SHA256withECDSA" : curve.equals("nistp384") ? "SHA384withECDSA" : "SHA512withECDSA");
            s.initSign(priv); s.update(data);
            try { return derToRs(s.sign()); } catch (IOException e) { throw new GeneralSecurityException(e); }
        }
    }

    /** Parse a private key file. Throws an IOException whose message says what to do when the key cannot be used. */
    public static Key parse(byte[] file) throws IOException {
        String s = new String(file, SshWire.UTF8);
        try {
            if (s.contains("BEGIN OPENSSH PRIVATE KEY")) return openssh(b64(body(s, "OPENSSH PRIVATE KEY")));
            if (s.contains("ENCRYPTED")) throw new IOException("this key is protected by a passphrase, which is not supported. Remove it first (ssh-keygen -p -f yourkey, leave the new passphrase empty) or use a password");
            if (s.contains("BEGIN RSA PRIVATE KEY")) return pkcs1(b64(body(s, "RSA PRIVATE KEY")));
            if (s.contains("BEGIN EC PRIVATE KEY")) return sec1(b64(body(s, "EC PRIVATE KEY")));
            if (s.contains("BEGIN PRIVATE KEY")) return pkcs8(b64(body(s, "PRIVATE KEY")));
        } catch (IOException e) { throw e; } catch (Exception e) { throw new IOException("could not read the private key: " + e.getMessage()); }
        throw new IOException("that does not look like a private key (expected a file starting with -----BEGIN … PRIVATE KEY-----)");
    }

    private static String body(String s, String label) throws IOException {
        int a = s.indexOf("-----BEGIN " + label + "-----"), b = s.indexOf("-----END " + label + "-----");
        if (a < 0 || b < 0) throw new IOException("the key file is incomplete");
        return s.substring(a + ("-----BEGIN " + label + "-----").length(), b);
    }

    // ---------------- OpenSSH format ----------------
    private static Key openssh(byte[] d) throws Exception {
        byte[] magic = "openssh-key-v1\0".getBytes("US-ASCII");
        if (d.length < magic.length) throw new IOException("not an OpenSSH key");
        for (int i = 0; i < magic.length; i++) if (d[i] != magic[i]) throw new IOException("not an OpenSSH key");
        SshWire.Rd r = new SshWire.Rd(d, magic.length);
        String cipher = r.strS(); r.strS(); r.str();
        if (r.u32() != 1) throw new IOException("a key file with several keys is not supported");
        r.str();
        byte[] priv = r.str();
        if (!cipher.equals("none")) throw new IOException("this key is protected by a passphrase, which is not supported. Remove it first (ssh-keygen -p -f yourkey, leave the new passphrase empty) or use a password");
        SshWire.Rd p = new SshWire.Rd(priv);
        long c1 = p.u32(), c2 = p.u32(); if (c1 != c2) throw new IOException("the key could not be read (wrong format)");
        String type = p.strS();
        if (type.equals("ssh-ed25519")) {
            byte[] pub = p.str(), sk = p.str();
            if (pub.length != 32 || sk.length != 64) throw new IOException("a malformed ed25519 key");
            byte[] seed = new byte[32]; System.arraycopy(sk, 0, seed, 0, 32);
            return new Key(type, new SshWire.Wr().str(type).str(pub).toBytes(), null, seed, null);
        }
        if (type.equals("ssh-rsa")) {
            BigInteger n = p.mpint(), e = p.mpint(), dd = p.mpint(), iqmp = p.mpint(), pp = p.mpint(), q = p.mpint();
            return rsa(n, e, dd, pp, q, dd.mod(pp.subtract(BigInteger.ONE)), dd.mod(q.subtract(BigInteger.ONE)), iqmp);
        }
        if (type.startsWith("ecdsa-sha2-")) {
            String curve = p.strS(); byte[] q = p.str(); BigInteger dd = p.mpint();
            return ec(type, curve, q, dd);
        }
        throw new IOException("key type " + type + " is not supported (use ed25519, RSA or ECDSA)");
    }

    private static Key rsa(BigInteger n, BigInteger e, BigInteger d, BigInteger p, BigInteger q, BigInteger dp, BigInteger dq, BigInteger qinv) throws Exception {
        PrivateKey k = KeyFactory.getInstance("RSA").generatePrivate(new RSAPrivateCrtKeySpec(n, e, d, p, q, dp, dq, qinv));
        return new Key("ssh-rsa", new SshWire.Wr().str("ssh-rsa").mpint(e).mpint(n).toBytes(), k, null, null);
    }

    private static Key ec(String type, String curve, byte[] q, BigInteger d) throws Exception {
        String jc = curve.equals("nistp256") ? "secp256r1" : curve.equals("nistp384") ? "secp384r1" : curve.equals("nistp521") ? "secp521r1" : null;
        if (jc == null) throw new IOException("curve " + curve + " is not supported");
        AlgorithmParameters ap = AlgorithmParameters.getInstance("EC"); ap.init(new ECGenParameterSpec(jc));
        PrivateKey k = KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(d, ap.getParameterSpec(ECParameterSpec.class)));
        return new Key(type, new SshWire.Wr().str(type).str(curve).str(q).toBytes(), k, null, curve);
    }

    // ---------------- PEM: PKCS#1 RSA, SEC1 EC, PKCS#8 RSA ----------------
    private static Key pkcs1(byte[] der) throws Exception {
        Der s = new Der(der).seq(); s.integer();
        BigInteger n = s.integer(), e = s.integer(), d = s.integer(), p = s.integer(), q = s.integer(), dp = s.integer(), dq = s.integer(), qi = s.integer();
        return rsa(n, e, d, p, q, dp, dq, qi);
    }

    private static Key sec1(byte[] der) throws Exception {
        Der s = new Der(der).seq(); s.integer();
        byte[] priv = s.octets(); String curve = null; byte[] pub = null;
        while (s.more()) {
            int tag = s.peek(); Der inner = s.ctx();
            if (tag == 0xa0) { String oid = inner.oid(); curve = oid.equals("1.2.840.10045.3.1.7") ? "nistp256" : oid.equals("1.3.132.0.34") ? "nistp384" : oid.equals("1.3.132.0.35") ? "nistp521" : null; }
            else if (tag == 0xa1) pub = inner.bits();
        }
        if (curve == null || pub == null) throw new IOException("an EC key without a supported curve or public point; use an OpenSSH-format key");
        return ec("ecdsa-sha2-" + curve, curve, pub, new BigInteger(1, priv));
    }

    private static Key pkcs8(byte[] der) throws Exception {
        PrivateKey k;
        try { k = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der)); }
        catch (GeneralSecurityException e) { throw new IOException("this PKCS#8 key is not RSA; convert it with: ssh-keygen -p -m PEM -f yourkey, or use an OpenSSH-format key"); }
        if (!(k instanceof RSAPrivateCrtKey)) throw new IOException("an RSA key without its CRT parameters is not supported");
        RSAPrivateCrtKey c = (RSAPrivateCrtKey) k;
        return new Key("ssh-rsa", new SshWire.Wr().str("ssh-rsa").mpint(c.getPublicExponent()).mpint(c.getModulus()).toBytes(), k, null, null);
    }

    // ---------------- a tiny DER reader ----------------
    private static final class Der {
        final byte[] b; int p, end;
        Der(byte[] b) { this.b = b; this.end = b.length; }
        Der(byte[] b, int p, int end) { this.b = b; this.p = p; this.end = end; }
        boolean more() { return p < end; }
        int peek() { return b[p] & 0xff; }
        private int len() throws IOException {
            int l = b[p++] & 0xff; if (l < 0x80) return l;
            int n = l & 0x7f; if (n < 1 || n > 4) throw new IOException("bad key encoding"); l = 0;
            for (int i = 0; i < n; i++) l = (l << 8) | (b[p++] & 0xff);
            return l;
        }
        private Der take(int tag) throws IOException {
            if (p >= end || (b[p] & 0xff) != tag) throw new IOException("bad key encoding");
            p++; int l = len(); if (l < 0 || p + l > end) throw new IOException("bad key encoding");
            Der d = new Der(b, p, p + l); p += l; return d;
        }
        Der seq() throws IOException { return take(0x30); }
        Der ctx() throws IOException { int t = peek(); return take(t); }
        BigInteger integer() throws IOException { Der d = take(0x02); return new BigInteger(java.util.Arrays.copyOfRange(b, d.p, d.end)); }
        byte[] octets() throws IOException { Der d = take(0x04); return java.util.Arrays.copyOfRange(b, d.p, d.end); }
        byte[] bits() throws IOException { Der d = take(0x03); return java.util.Arrays.copyOfRange(b, d.p + 1, d.end); }
        String oid() throws IOException {
            Der d = take(0x06); StringBuilder s = new StringBuilder(); long v = 0; boolean first = true;
            for (int i = d.p; i < d.end; i++) {
                v = (v << 7) | (b[i] & 0x7f);
                if ((b[i] & 0x80) == 0) { if (first) { s.append(v / 40).append('.').append(v % 40); first = false; } else s.append('.').append(v); v = 0; }
            }
            return s.toString();
        }
    }

    /** DER ECDSA signature -> the SSH form: string(mpint r || mpint s) contents. */
    static byte[] derToRs(byte[] der) throws IOException {
        Der s = new Der(der).seq(); BigInteger r = s.integer(), v = s.integer();
        return new SshWire.Wr().mpint(r).mpint(v).toBytes();
    }

    /** SSH ECDSA signature contents (mpint r, mpint s) -> DER, for verifying. */
    static byte[] rsToDer(byte[] rs) throws IOException {
        SshWire.Rd r = new SshWire.Rd(rs); BigInteger a = r.mpint(), b = r.mpint();
        byte[] x = a.toByteArray(), y = b.toByteArray();
        int body = 2 + x.length + 2 + y.length; if (body > 127) throw new IOException("signature too large");
        byte[] o = new byte[2 + body]; int i = 0;
        o[i++] = 0x30; o[i++] = (byte) body; o[i++] = 0x02; o[i++] = (byte) x.length; System.arraycopy(x, 0, o, i, x.length); i += x.length;
        o[i++] = 0x02; o[i++] = (byte) y.length; System.arraycopy(y, 0, o, i, y.length);
        return o;
    }

    // ---------------- base64 (java.util.Base64 needs Android 8) ----------------
    static byte[] b64(String s) throws IOException {
        int[] t = new int[128]; java.util.Arrays.fill(t, -1);
        String a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (int i = 0; i < 64; i++) t[a.charAt(i)] = i;
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream(); int acc = 0, bits = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i); if (c == '=' ) break; if (c >= 128 || t[c] < 0) { if (Character.isWhitespace(c)) continue; throw new IOException("the key file is not valid base64"); }
            acc = (acc << 6) | t[c]; bits += 6; if (bits >= 8) { bits -= 8; o.write((acc >> bits) & 0xff); }
        }
        return o.toByteArray();
    }

    // ---------------- Ed25519 (RFC 8032), signing only ----------------
    static final class Ed25519 {
        static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
        static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
        static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
        static final BigInteger I = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
        static final BigInteger[] B;
        static {
            BigInteger y = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
            B = new BigInteger[] { recoverX(y, 0), y };
        }
        static BigInteger recoverX(BigInteger y, int sign) {
            BigInteger y2 = y.multiply(y).mod(P);
            BigInteger x2 = y2.subtract(BigInteger.ONE).multiply(D.multiply(y2).add(BigInteger.ONE).modInverse(P)).mod(P);
            BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
            if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(I).mod(P);
            if (x.testBit(0) != (sign == 1)) x = P.subtract(x);
            return x;
        }
        static BigInteger[] add(BigInteger[] a, BigInteger[] b) {
            BigInteger t = D.multiply(a[0]).multiply(b[0]).mod(P).multiply(a[1]).mod(P).multiply(b[1]).mod(P);
            BigInteger x = a[0].multiply(b[1]).add(b[0].multiply(a[1])).mod(P).multiply(BigInteger.ONE.add(t).modInverse(P)).mod(P);
            BigInteger y = a[1].multiply(b[1]).add(a[0].multiply(b[0])).mod(P).multiply(BigInteger.ONE.subtract(t).mod(P).modInverse(P)).mod(P);
            return new BigInteger[] { x, y };
        }
        static BigInteger[] mul(BigInteger k) {
            BigInteger[] r = { BigInteger.ZERO, BigInteger.ONE }, q = B;
            for (int i = 0; i < k.bitLength(); i++) { if (k.testBit(i)) r = add(r, q); q = add(q, q); }
            return r;
        }
        static byte[] enc(BigInteger[] pt) {
            byte[] le = new byte[32]; byte[] be = pt[1].toByteArray();
            for (int i = 0; i < be.length && i < 33; i++) { int idx = be.length - 1 - i; if (i < 32) le[i] = be[idx]; }
            if (pt[0].testBit(0)) le[31] |= (byte) 0x80;
            return le;
        }
        static BigInteger le(byte[] b, int off, int len) { byte[] r = new byte[len + 1]; for (int i = 0; i < len; i++) r[len - i] = b[off + i]; return new BigInteger(r); }
        static byte[] le32(BigInteger v) { byte[] o = new byte[32]; byte[] be = v.toByteArray(); for (int i = 0; i < be.length && i < 32; i++) o[i] = be[be.length - 1 - i]; return o; }
        static MessageDigest sha512() throws GeneralSecurityException { return MessageDigest.getInstance("SHA-512"); }

        static byte[] publicKey(byte[] seed) throws GeneralSecurityException {
            byte[] h = sha512().digest(seed); return enc(mul(clamp(h)));
        }
        static BigInteger clamp(byte[] h) { byte[] a = new byte[32]; System.arraycopy(h, 0, a, 0, 32); a[0] &= (byte) 248; a[31] &= 63; a[31] |= 64; return le(a, 0, 32); }

        static byte[] sign(byte[] seed, byte[] msg) throws GeneralSecurityException {
            byte[] h = sha512().digest(seed); BigInteger a = clamp(h);
            byte[] A = enc(mul(a));
            MessageDigest m = sha512(); m.update(h, 32, 32); m.update(msg); BigInteger r = le(m.digest(), 0, 64).mod(L);
            byte[] R = enc(mul(r));
            m = sha512(); m.update(R); m.update(A); m.update(msg); BigInteger k = le(m.digest(), 0, 64).mod(L);
            BigInteger S = r.add(k.multiply(a)).mod(L);
            byte[] sig = new byte[64]; System.arraycopy(R, 0, sig, 0, 32); System.arraycopy(le32(S), 0, sig, 32, 32);
            return sig;
        }
    }

    /** Public key blob of an Ed25519 seed, for tests and for building a key from a bare seed. */
    public static Key ed25519(byte[] seed) throws GeneralSecurityException {
        return new Key("ssh-ed25519", new SshWire.Wr().str("ssh-ed25519").str(Ed25519.publicKey(seed)).toBytes(), null, seed, null);
    }
}
