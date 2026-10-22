package app.netrunner.jade;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.AlgorithmParameters;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * A small SSH-2 client with no libraries, built on the platform's crypto. It speaks the algorithms OpenSSH and most
 * servers offer by default: key exchange ecdh-sha2-nistp256, host keys ecdsa-sha2-nistp256 and RSA (SHA-2), ciphers
 * aes128-ctr and aes256-ctr, MAC hmac-sha2-256. Login by password, keyboard-interactive or private key. Channels
 * (an interactive shell with a terminal, or a single command) are multiplexed over one connection, with flow control,
 * keepalives, and key re-exchange when the server asks for it. The server's host key is shown to the caller to accept
 * or refuse; nothing is trusted silently.
 */
public final class SshClient implements Closeable {
    public interface HostKeyCheck { boolean accept(String keyType, String fingerprint); }

    public static final class AuthException extends IOException { public AuthException(String m) { super(m); } }

    private static final int MSG_DISCONNECT = 1, MSG_IGNORE = 2, MSG_UNIMPL = 3, MSG_DEBUG = 4, MSG_SERVICE_REQ = 5, MSG_SERVICE_ACC = 6, MSG_EXT_INFO = 7,
        MSG_KEXINIT = 20, MSG_NEWKEYS = 21, MSG_ECDH_INIT = 30, MSG_ECDH_REPLY = 31,
        MSG_AUTH_REQ = 50, MSG_AUTH_FAIL = 51, MSG_AUTH_OK = 52, MSG_AUTH_BANNER = 53, MSG_AUTH_60 = 60, MSG_AUTH_INFO_RESP = 61,
        MSG_GLOBAL = 80, MSG_GLOBAL_OK = 81, MSG_GLOBAL_FAIL = 82,
        MSG_CH_OPEN = 90, MSG_CH_OPEN_OK = 91, MSG_CH_OPEN_FAIL = 92, MSG_CH_WINDOW = 93, MSG_CH_DATA = 94, MSG_CH_EXT = 95, MSG_CH_EOF = 96, MSG_CH_CLOSE = 97, MSG_CH_REQ = 98, MSG_CH_REQ_OK = 99, MSG_CH_REQ_FAIL = 100;

    private static final String CLIENT_VERSION = "SSH-2.0-JadeSSH_1.0";
    private static final int LOCAL_WINDOW = 2 * 1024 * 1024, MAX_PACKET = 32768, BUF_CAP = 4 * 1024 * 1024;

    private final String host; private final int port;
    private Socket sock; private InputStream in; private OutputStream out;
    private String serverVersion;
    private byte[] sessionId;
    private byte[] hostKeyBlob;
    private HostKeyCheck hostKeyCheck;
    private boolean strictKex;

    private Cipher encC, decC; private Mac macOut, macIn; private int macOutLen, macInLen, blockIn = 8, blockOut = 8;
    private long seqOut, seqIn;
    private final Object sendLock = new Object();
    private boolean rekeying; private Thread kexThread;
    private final SecureRandom rnd = new SecureRandom();

    private volatile boolean closed; private volatile String closeReason = "";
    private volatile long lastRx;
    private Thread pump, keepalive;
    private final Map<Integer, Channel> channels = new ConcurrentHashMap<Integer, Channel>();
    private int nextChannel;

    public SshClient(String host, int port) { this.host = host; this.port = port; }

    public boolean isClosed() { return closed; }
    public String closeReason() { return closeReason; }
    public String serverVersion() { return serverVersion; }

    // ------------------------------------------------------------------ connect, key exchange, login
    public void connect(int timeoutMs, HostKeyCheck check) throws IOException {
        this.hostKeyCheck = check;
        sock = new Socket();
        sock.connect(new InetSocketAddress(host, port), timeoutMs);
        sock.setTcpNoDelay(true); sock.setKeepAlive(true); sock.setSoTimeout(timeoutMs);
        in = sock.getInputStream(); out = sock.getOutputStream();
        out.write((CLIENT_VERSION + "\r\n").getBytes("US-ASCII")); out.flush();
        // the server may print lines before its version
        for (int i = 0; i < 50; i++) {
            String line = readLine();
            if (line.startsWith("SSH-")) { serverVersion = line; break; }
        }
        if (serverVersion == null) throw new IOException("that is not an SSH server (no version line)");
        if (!serverVersion.startsWith("SSH-2.0-") && !serverVersion.startsWith("SSH-1.99-")) throw new IOException("the server speaks " + serverVersion + ", not SSH 2");
        kex(null, true);
    }

    private String readLine() throws IOException {
        StringBuilder b = new StringBuilder();
        while (b.length() < 512) {
            int c = in.read(); if (c < 0) throw new IOException("the server closed the connection");
            if (c == '\n') break; if (c != '\r') b.append((char) c);
        }
        return b.toString();
    }

    private static final String KEX_ALGO = "ecdh-sha2-nistp256", HOSTKEY_ALGOS = "ecdsa-sha2-nistp256,rsa-sha2-256,rsa-sha2-512", CIPHERS = "aes128-ctr,aes256-ctr", MACS = "hmac-sha2-256";

    private byte[] ourKexInit() {
        SshWire.Wr w = new SshWire.Wr(); w.u8(MSG_KEXINIT);
        byte[] cookie = new byte[16]; rnd.nextBytes(cookie); w.raw(cookie);
        w.str(KEX_ALGO + ",kex-strict-c-v00@openssh.com").str(HOSTKEY_ALGOS).str(CIPHERS).str(CIPHERS).str(MACS).str(MACS).str("none").str("none").str("").str("");
        w.bool(false).u32(0);
        return w.toBytes();
    }

    /** One key exchange. For the first one (initial) the host key goes to the caller; a re-exchange must present the same key. */
    private void kex(byte[] serverInit, boolean initial) throws IOException {
        try {
            byte[] ic = ourKexInit(); sendRaw(ic);
            byte[] is = serverInit != null ? serverInit : expect(MSG_KEXINIT, initial);
            SshWire.Rd r = new SshWire.Rd(is); r.u8(); r.raw(16);
            String kexL = r.strS(), hostL = r.strS(), encCS = r.strS(), encSC = r.strS(), macCS = r.strS(), macSC = r.strS(), compCS = r.strS(), compSC = r.strS();
            if (!SshWire.listHas(kexL, KEX_ALGO)) throw new IOException("the server does not offer ecdh-sha2-nistp256 key exchange (it offers: " + kexL + ")");
            String hostAlgo = pick(HOSTKEY_ALGOS, hostL, "host key"); String cipher = pick(CIPHERS, encCS, "cipher"); pick(CIPHERS, encSC, "cipher"); pick(MACS, macCS, "MAC"); pick(MACS, macSC, "MAC");
            if (!SshWire.listHas(compCS, "none") || !SshWire.listHas(compSC, "none")) throw new IOException("the server insists on compression");
            if (initial) strictKex = SshWire.listHas(kexL, "kex-strict-s-v00@openssh.com");
            String cipherIn = pick(CIPHERS, encSC, "cipher");
            if (!cipherIn.equals(cipher)) { /* different ciphers each way is fine */ }

            AlgorithmParameters ap = AlgorithmParameters.getInstance("EC"); ap.init(new ECGenParameterSpec("secp256r1"));
            ECParameterSpec spec = ap.getParameterSpec(ECParameterSpec.class);
            KeyPairGenerator kg = KeyPairGenerator.getInstance("EC"); kg.initialize(new ECGenParameterSpec("secp256r1"), rnd);
            KeyPair kp = kg.generateKeyPair();
            byte[] qc = point(((ECPublicKey) kp.getPublic()).getW());
            sendRaw(new SshWire.Wr().u8(MSG_ECDH_INIT).str(qc).toBytes());
            byte[] reply = expect(MSG_ECDH_REPLY, initial);
            SshWire.Rd rr = new SshWire.Rd(reply); rr.u8();
            byte[] ks = rr.str(), qs = rr.str(), sig = rr.str();
            PublicKey sp = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(unpoint(qs), spec));
            KeyAgreement ka = KeyAgreement.getInstance("ECDH"); ka.init(kp.getPrivate()); ka.doPhase(sp, true);
            BigInteger k = new BigInteger(1, ka.generateSecret());
            byte[] h = MessageDigest.getInstance("SHA-256").digest(new SshWire.Wr().str(CLIENT_VERSION).str(serverVersion).str(ic).str(is).str(ks).str(qc).str(qs).mpint(k).toBytes());
            verifyHostSig(ks, h, sig);
            if (initial) {
                hostKeyBlob = ks;
                String type = new SshWire.Rd(ks).strS();
                if (hostKeyCheck == null || !hostKeyCheck.accept(type, fingerprint(ks))) throw new IOException("the host key was not accepted");
                sessionId = h;
            } else if (!java.util.Arrays.equals(ks, hostKeyBlob)) throw new IOException("the server changed its host key while connected");
            sendRaw(new byte[] { (byte) MSG_NEWKEYS });
            expect(MSG_NEWKEYS, initial);
            install(k, h, cipher, cipherIn);
        } catch (GeneralSecurityException e) { throw new IOException("key exchange failed: " + e.getMessage()); }
    }

    private static String pick(String ours, String theirs, String what) throws IOException {
        for (String a : ours.split(",")) if (SshWire.listHas(theirs, a)) return a;
        throw new IOException("no " + what + " algorithm in common with the server (it offers: " + theirs + ")");
    }

    private static byte[] point(ECPoint w) {
        byte[] o = new byte[65]; o[0] = 4; byte[] x = fixed(w.getAffineX()), y = fixed(w.getAffineY());
        System.arraycopy(x, 0, o, 1, 32); System.arraycopy(y, 0, o, 33, 32); return o;
    }
    private static byte[] fixed(BigInteger v) { byte[] b = v.toByteArray(), o = new byte[32]; int n = Math.min(32, b.length); System.arraycopy(b, b.length - n, o, 32 - n, n); return o; }
    private static ECPoint unpoint(byte[] q) throws IOException {
        if (q.length != 65 || q[0] != 4) throw new IOException("the server sent a bad key-exchange point");
        return new ECPoint(new BigInteger(1, java.util.Arrays.copyOfRange(q, 1, 33)), new BigInteger(1, java.util.Arrays.copyOfRange(q, 33, 65)));
    }

    public static String fingerprint(byte[] blob) throws GeneralSecurityException {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(blob);
        String a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; StringBuilder s = new StringBuilder("SHA256:");
        int acc = 0, bits = 0; for (byte x : d) { acc = (acc << 8) | (x & 0xff); bits += 8; while (bits >= 6) { bits -= 6; s.append(a.charAt((acc >> bits) & 63)); } }
        if (bits > 0) s.append(a.charAt((acc << (6 - bits)) & 63));
        return s.toString();
    }

    private void verifyHostSig(byte[] ks, byte[] h, byte[] sigBlob) throws IOException, GeneralSecurityException {
        SshWire.Rd k = new SshWire.Rd(ks); String type = k.strS();
        SshWire.Rd s = new SshWire.Rd(sigBlob); String algo = s.strS(); byte[] sig = s.str();
        boolean ok;
        if (type.equals("ecdsa-sha2-nistp256") && algo.equals(type)) {
            k.strS(); byte[] q = k.str();
            AlgorithmParameters ap = AlgorithmParameters.getInstance("EC"); ap.init(new ECGenParameterSpec("secp256r1"));
            PublicKey pk = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(unpoint(q), ap.getParameterSpec(ECParameterSpec.class)));
            Signature v = Signature.getInstance("SHA256withECDSA"); v.initVerify(pk); v.update(h); ok = v.verify(SshKeys.rsToDer(sig));
        } else if (type.equals("ssh-rsa") && (algo.equals("rsa-sha2-256") || algo.equals("rsa-sha2-512"))) {
            BigInteger e = k.mpint(), n = k.mpint();
            PublicKey pk = KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(n, e));
            Signature v = Signature.getInstance(algo.equals("rsa-sha2-256") ? "SHA256withRSA" : "SHA512withRSA"); v.initVerify(pk); v.update(h); ok = v.verify(sig);
        } else throw new IOException("the server signed with " + algo + " using a " + type + " key, which is not supported");
        if (!ok) throw new IOException("the server's signature did not verify (possible man-in-the-middle)");
    }

    private byte[] derive(BigInteger k, byte[] h, char c, int len) throws GeneralSecurityException {
        MessageDigest md = MessageDigest.getInstance("SHA-256"); byte[] kb = new SshWire.Wr().mpint(k).toBytes();
        md.update(kb); md.update(h); md.update((byte) c); md.update(sessionId); byte[] out = md.digest();
        while (out.length < len) { md.update(kb); md.update(h); md.update(out); byte[] more = md.digest(); byte[] n = new byte[out.length + more.length]; System.arraycopy(out, 0, n, 0, out.length); System.arraycopy(more, 0, n, out.length, more.length); out = n; }
        return java.util.Arrays.copyOf(out, len);
    }

    private void install(BigInteger k, byte[] h, String cipherOut, String cipherIn) throws GeneralSecurityException {
        int lo = cipherOut.equals("aes256-ctr") ? 32 : 16, li = cipherIn.equals("aes256-ctr") ? 32 : 16;
        Cipher e = Cipher.getInstance("AES/CTR/NoPadding"); e.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(derive(k, h, 'C', lo), "AES"), new IvParameterSpec(derive(k, h, 'A', 16)));
        Cipher d = Cipher.getInstance("AES/CTR/NoPadding"); d.init(Cipher.DECRYPT_MODE, new SecretKeySpec(derive(k, h, 'D', li), "AES"), new IvParameterSpec(derive(k, h, 'B', 16)));
        Mac mo = Mac.getInstance("HmacSHA256"); mo.init(new SecretKeySpec(derive(k, h, 'E', 32), "HmacSHA256"));
        Mac mi = Mac.getInstance("HmacSHA256"); mi.init(new SecretKeySpec(derive(k, h, 'F', 32), "HmacSHA256"));
        synchronized (sendLock) { encC = e; macOut = mo; macOutLen = 32; blockOut = 16; if (strictKex) seqOut = 0; }
        decC = d; macIn = mi; macInLen = 32; blockIn = 16; if (strictKex) seqIn = 0;
    }

    // ------------------------------------------------------------------ packets
    private byte[] readFully(int n) throws IOException {
        byte[] b = new byte[n]; int off = 0;
        while (off < n) { int r = in.read(b, off, n - off); if (r < 0) throw new IOException("the server closed the connection"); off += r; }
        return b;
    }

    /** Read one packet's payload. Only one thread reads at a time (the connecting thread, then the pump). */
    private byte[] readPacket() throws IOException {
        byte[] first = readFully(blockIn);
        if (decC != null) first = decC.update(first);
        long len = ((first[0] & 0xffL) << 24) | ((first[1] & 0xffL) << 16) | ((first[2] & 0xffL) << 8) | (first[3] & 0xffL);
        if (len < 12 || len > 40000) throw new IOException("the server sent a bad packet length (" + len + ")");
        int total = (int) len + 4; if (total % blockIn != 0 && decC != null) throw new IOException("a packet with the wrong padding arrived");
        byte[] pkt = new byte[total]; System.arraycopy(first, 0, pkt, 0, first.length);
        if (total > first.length) { byte[] rest = readFully(total - first.length); if (decC != null) rest = decC.update(rest); System.arraycopy(rest, 0, pkt, first.length, rest.length); }
        if (macIn != null) {
            byte[] mac = readFully(macInLen);
            macIn.update(new byte[] { (byte) (seqIn >>> 24), (byte) (seqIn >>> 16), (byte) (seqIn >>> 8), (byte) seqIn }); macIn.update(pkt);
            if (!MessageDigest.isEqual(mac, macIn.doFinal())) throw new IOException("a packet failed its integrity check; the connection may have been tampered with");
        }
        seqIn++;
        int pad = pkt[4] & 0xff; int plen = total - 5 - pad;
        if (plen < 1) throw new IOException("a packet with no content arrived");
        byte[] payload = new byte[plen]; System.arraycopy(pkt, 5, payload, 0, plen); return payload;
    }

    private void writePacket(byte[] payload) throws IOException {
        int block = encC != null ? Math.max(16, blockOut) : 8;
        int pad = block - ((5 + payload.length) % block); if (pad < 4) pad += block;
        byte[] pkt = new byte[5 + payload.length + pad];
        int len = 1 + payload.length + pad; pkt[0] = (byte) (len >>> 24); pkt[1] = (byte) (len >>> 16); pkt[2] = (byte) (len >>> 8); pkt[3] = (byte) len; pkt[4] = (byte) pad;
        System.arraycopy(payload, 0, pkt, 5, payload.length);
        if (encC != null) { byte[] pd = new byte[pad]; rnd.nextBytes(pd); System.arraycopy(pd, 0, pkt, 5 + payload.length, pad); }
        byte[] mac = null;
        if (macOut != null) { macOut.update(new byte[] { (byte) (seqOut >>> 24), (byte) (seqOut >>> 16), (byte) (seqOut >>> 8), (byte) seqOut }); macOut.update(pkt); mac = macOut.doFinal(); }
        byte[] enc = encC != null ? encC.update(pkt) : pkt;
        out.write(enc); if (mac != null) out.write(mac); out.flush(); seqOut++;
    }

    /** Send a packet, waiting out any key re-exchange in progress (the exchange itself uses sendRaw). */
    private void send(byte[] payload) throws IOException {
        synchronized (sendLock) {
            long end = System.currentTimeMillis() + 30000;
            while (rekeying && Thread.currentThread() != kexThread && !closed) { long w = end - System.currentTimeMillis(); if (w <= 0) throw new IOException("timed out waiting for a key re-exchange"); try { sendLock.wait(w); } catch (InterruptedException e) { throw new IOException("interrupted"); } }
            if (closed) throw new IOException("the connection is closed" + (closeReason.length() > 0 ? ": " + closeReason : ""));
            try { writePacket(payload); } catch (IOException e) { fail(e.getMessage()); throw e; }
        }
    }
    private void sendRaw(byte[] payload) throws IOException { synchronized (sendLock) { writePacket(payload); } }

    /** Read until a packet of this type; housekeeping messages are skipped (but not during the very first exchange, which must be clean). */
    private byte[] expect(int type, boolean strictCheck) throws IOException {
        while (true) {
            byte[] p = readPacket(); int t = p[0] & 0xff;
            if (t == type) return p;
            if (t == MSG_DISCONNECT) throw new IOException("the server disconnected: " + disconnectText(p));
            if (t == MSG_IGNORE || t == MSG_DEBUG || t == MSG_UNIMPL || t == MSG_EXT_INFO) { if (strictKex && strictCheck) throw new IOException("an unexpected message arrived during key exchange (possible attack)"); continue; }
            if (t == MSG_AUTH_BANNER) continue;
            throw new IOException("unexpected message " + t + " from the server while expecting " + type);
        }
    }

    private static String disconnectText(byte[] p) { try { SshWire.Rd r = new SshWire.Rd(p); r.u8(); r.u32(); return r.strS(); } catch (Exception e) { return "(no reason given)"; } }

    // ------------------------------------------------------------------ authentication
    private void serviceRequest() throws IOException {
        sendRaw(new SshWire.Wr().u8(MSG_SERVICE_REQ).str("ssh-userauth").toBytes());
        expect(MSG_SERVICE_ACC, false);
    }

    private boolean authStarted;
    private void startAuth() throws IOException { if (!authStarted) { serviceRequest(); authStarted = true; } }

    /** Reads the answer to an authentication request. Returns true on success; false with the server's allowed methods in lastMethods. */
    private String lastMethods = "";
    private boolean authReply() throws IOException {
        while (true) {
            byte[] p = readPacket(); int t = p[0] & 0xff;
            if (t == MSG_AUTH_OK) return true;
            if (t == MSG_AUTH_FAIL) { SshWire.Rd r = new SshWire.Rd(p); r.u8(); lastMethods = r.strS(); return false; }
            if (t == MSG_AUTH_BANNER || t == MSG_IGNORE || t == MSG_DEBUG) continue;
            if (t == MSG_DISCONNECT) throw new IOException("the server disconnected: " + disconnectText(p));
            if (t == MSG_AUTH_60) { lastInfoRequest = p; return false; }
            throw new IOException("unexpected message " + t + " during login");
        }
    }
    private byte[] lastInfoRequest;

    public void authPassword(String user, String password) throws IOException {
        startAuth(); lastInfoRequest = null;
        sendRaw(new SshWire.Wr().u8(MSG_AUTH_REQ).str(user).str("ssh-connection").str("password").bool(false).str(password).toBytes());
        if (authReply()) { established(); return; }
        // many servers only allow the password through keyboard-interactive
        if (lastInfoRequest != null || SshWire.listHas(lastMethods, "keyboard-interactive")) {
            lastInfoRequest = null;
            sendRaw(new SshWire.Wr().u8(MSG_AUTH_REQ).str(user).str("ssh-connection").str("keyboard-interactive").str("").str("").toBytes());
            for (int round = 0; round < 5; round++) {
                if (authReply()) { established(); return; }
                if (lastInfoRequest == null) break;
                SshWire.Rd r = new SshWire.Rd(lastInfoRequest); r.u8(); r.strS(); r.strS(); r.strS(); long n = r.u32(); lastInfoRequest = null;
                SshWire.Wr w = new SshWire.Wr().u8(MSG_AUTH_INFO_RESP).u32(n); for (long i = 0; i < n; i++) w.str(password);
                sendRaw(w.toBytes());
            }
        }
        throw new AuthException("the server refused the password" + (lastMethods.length() > 0 ? " (it accepts: " + lastMethods + ")" : ""));
    }

    public void authKey(String user, SshKeys.Key key) throws IOException {
        startAuth(); lastInfoRequest = null;
        for (String algo : key.signAlgos()) {
            try {
                byte[] signed = new SshWire.Wr().str(sessionId).u8(MSG_AUTH_REQ).str(user).str("ssh-connection").str("publickey").bool(true).str(algo).str(key.publicBlob).toBytes();
                byte[] sig = key.sign(algo, signed);
                byte[] sigBlob = new SshWire.Wr().str(algo).str(sig).toBytes();
                sendRaw(new SshWire.Wr().u8(MSG_AUTH_REQ).str(user).str("ssh-connection").str("publickey").bool(true).str(algo).str(key.publicBlob).str(sigBlob).toBytes());
                if (authReply()) { established(); return; }
            } catch (GeneralSecurityException e) { throw new IOException("could not sign with the key: " + e.getMessage()); }
        }
        throw new AuthException("the server refused the key" + (lastMethods.length() > 0 ? " (it accepts: " + lastMethods + ")" : "") + ". Is its public key in ~/.ssh/authorized_keys on the server, and is the user name right?");
    }

    private void established() throws IOException {
        lastRx = System.currentTimeMillis();
        try { sock.setSoTimeout(0); } catch (Exception ignored) { }
        pump = new Thread(new Runnable() { public void run() { pumpLoop(); } }, "ssh-pump"); pump.setDaemon(true); pump.start();
        keepalive = new Thread(new Runnable() { public void run() { keepaliveLoop(); } }, "ssh-keepalive"); keepalive.setDaemon(true); keepalive.start();
    }

    // ------------------------------------------------------------------ the reader thread
    private void pumpLoop() {
        try {
            while (!closed) {
                byte[] p = readPacket(); lastRx = System.currentTimeMillis();
                dispatch(p);
            }
        } catch (IOException e) { fail(closed ? closeReason : e.getMessage()); }
        catch (Throwable e) { fail(String.valueOf(e)); }
    }

    private void keepaliveLoop() {
        while (!closed) {
            try { Thread.sleep(30000); } catch (InterruptedException e) { return; }
            if (closed) return;
            if (System.currentTimeMillis() - lastRx > 150000) { fail("the connection timed out (no answer for 2 minutes)"); return; }
            try { send(new SshWire.Wr().u8(MSG_GLOBAL).str("keepalive@openssh.com").bool(true).toBytes()); } catch (IOException e) { return; }
        }
    }

    private void dispatch(byte[] p) throws IOException {
        int t = p[0] & 0xff; SshWire.Rd r = new SshWire.Rd(p); r.u8();
        switch (t) {
            case MSG_IGNORE: case MSG_DEBUG: case MSG_UNIMPL: case MSG_EXT_INFO: case MSG_GLOBAL_OK: case MSG_GLOBAL_FAIL: return;
            case MSG_DISCONNECT: fail("the server disconnected: " + disconnectText(p)); return;
            case MSG_KEXINIT: rekey(p); return;
            case MSG_GLOBAL: { r.strS(); boolean want = r.bool(); if (want) send(new byte[] { (byte) MSG_GLOBAL_FAIL }); return; }
            case MSG_CH_OPEN: { r.strS(); long remote = r.u32(); send(new SshWire.Wr().u8(MSG_CH_OPEN_FAIL).u32(remote).u32(3).str("not supported").str("").toBytes()); return; }
            case MSG_CH_OPEN_OK: { Channel c = channels.get((int) r.u32()); if (c != null) { c.remote = (int) r.u32(); c.remoteWindow = r.u32(); c.remoteMax = (int) Math.min(r.u32(), MAX_PACKET); c.openOk = true; c.opened.countDown(); } return; }
            case MSG_CH_OPEN_FAIL: { Channel c = channels.get((int) r.u32()); if (c != null) { long code = r.u32(); c.openErr = r.strS(); if (c.openErr.length() == 0) c.openErr = "code " + code; c.opened.countDown(); } return; }
            default: break;
        }
        Channel c = channels.get((int) r.u32()); if (c == null) return;
        switch (t) {
            case MSG_CH_WINDOW: { long add = r.u32(); synchronized (c) { c.remoteWindow += add; c.notifyAll(); } return; }
            case MSG_CH_DATA: { byte[] d = r.str(); c.deliver(d, false); adjust(c, d.length); return; }
            case MSG_CH_EXT: { r.u32(); byte[] d = r.str(); c.deliver(d, true); adjust(c, d.length); return; }
            case MSG_CH_EOF: c.markEof(); return;
            case MSG_CH_CLOSE: { c.markClosed(); channels.remove(c.local); if (!c.closeSent) { c.closeSent = true; try { send(new SshWire.Wr().u8(MSG_CH_CLOSE).u32(c.remote).toBytes()); } catch (IOException ignored) { } } return; }
            case MSG_CH_REQ: {
                String type = r.strS(); boolean want = r.bool();
                if (type.equals("exit-status")) { c.exit = (int) r.u32(); }
                else if (type.equals("exit-signal")) { c.exitSignal = r.strS(); }
                if (want) send(new SshWire.Wr().u8(MSG_CH_REQ_FAIL).u32(c.remote).toBytes());
                return;
            }
            case MSG_CH_REQ_OK: c.replies.add(Boolean.TRUE); return;
            case MSG_CH_REQ_FAIL: c.replies.add(Boolean.FALSE); return;
            default: return;
        }
    }

    private void adjust(Channel c, int n) throws IOException { if (n > 0 && !c.closeSent) send(new SshWire.Wr().u8(MSG_CH_WINDOW).u32(c.remote).u32(n).toBytes()); }

    private volatile int rekeys;
    public int rekeyCount() { return rekeys; }
    private void rekey(byte[] serverInit) throws IOException {
        synchronized (sendLock) { rekeying = true; kexThread = Thread.currentThread(); }
        try { kex(serverInit, false); rekeys++; }
        finally { synchronized (sendLock) { rekeying = false; kexThread = null; sendLock.notifyAll(); } }
    }

    private void fail(String why) {
        synchronized (this) { if (closed) return; closed = true; closeReason = why == null ? "" : why; }
        for (Channel c : channels.values()) { c.markClosed(); c.opened.countDown(); }
        try { sock.close(); } catch (Exception ignored) { }
        synchronized (sendLock) { sendLock.notifyAll(); }
    }

    @Override public void close() {
        if (!closed) { try { synchronized (sendLock) { if (encC != null || !closed) writePacket(new SshWire.Wr().u8(MSG_DISCONNECT).u32(11).str("bye").str("").toBytes()); } } catch (Throwable ignored) { } }
        fail("closed");
    }

    // ------------------------------------------------------------------ channels
    public final class Channel {
        final int local; volatile int remote; volatile long remoteWindow; volatile int remoteMax = MAX_PACKET;
        final CountDownLatch opened = new CountDownLatch(1); volatile boolean openOk; volatile String openErr;
        final BlockingQueue<Boolean> replies = new LinkedBlockingQueue<Boolean>();
        private byte[] buf = new byte[8192]; private int start, end; private long dropped;
        private byte[] ebuf = new byte[0];
        volatile boolean eof, closeSent, chClosed; volatile Integer exit; volatile String exitSignal;

        Channel(int local) { this.local = local; }

        synchronized void deliver(byte[] d, boolean err) {
            if (err) { byte[] n = new byte[Math.min(ebuf.length + d.length, BUF_CAP)]; int keep = n.length - Math.min(d.length, n.length); System.arraycopy(ebuf, ebuf.length - keep, n, 0, keep); System.arraycopy(d, Math.max(0, d.length - (n.length - keep)), n, keep, n.length - keep); ebuf = n; notifyAll(); return; }
            int have = end - start;
            if (have + d.length > BUF_CAP) { int drop = have + d.length - BUF_CAP; dropped += drop; if (drop >= have) { start = end = 0; d = java.util.Arrays.copyOfRange(d, Math.min(d.length, drop - have), d.length); } else start += drop; }
            if (end + d.length > buf.length) {
                int n2 = end - start; byte[] nb = new byte[Math.max(buf.length, (n2 + d.length) * 2)]; System.arraycopy(buf, start, nb, 0, n2); buf = nb; start = 0; end = n2;
            }
            System.arraycopy(d, 0, buf, end, d.length); end += d.length; notifyAll();
        }
        synchronized void markEof() { eof = true; notifyAll(); }
        synchronized void markClosed() { eof = true; chClosed = true; notifyAll(); }

        /** After the server has said it is done (EOF), its CLOSE follows within milliseconds: give it a moment so callers see the final state. */
        public synchronized void awaitClosed(long ms) { long until = System.currentTimeMillis() + ms; while (!chClosed && !closed) { long w = until - System.currentTimeMillis(); if (w <= 0) break; try { wait(w); } catch (InterruptedException e) { break; } } }

        public boolean isClosed() { return chClosed; }
        public boolean isEof() { return eof; }
        public Integer exitStatus() { return exit; }
        public String exitSignal() { return exitSignal; }
        public synchronized long droppedBytes() { long d = dropped; dropped = 0; return d; }
        public synchronized int available() { return end - start; }

        /** Everything received so far (waiting up to waitMs for something to arrive if there is nothing yet). */
        public synchronized byte[] read(long waitMs) {
            long until = System.currentTimeMillis() + waitMs;
            while (end == start && !eof) { long w = until - System.currentTimeMillis(); if (w <= 0) break; try { wait(w); } catch (InterruptedException e) { break; } }
            byte[] r = java.util.Arrays.copyOfRange(buf, start, end); start = end = 0; return r;
        }
        public synchronized byte[] readErr() { byte[] r = ebuf; ebuf = new byte[0]; return r; }

        /** Block until data arrives, the channel ends, or the quiet period passes with data in hand. Returns true if the channel is still open. */
        public synchronized void waitActivity(long maxMs, long quietMs) {
            long t0 = System.currentTimeMillis(), until = t0 + maxMs; int seen = end - start; long lastChange = t0;
            while (!eof) {
                long now = System.currentTimeMillis(); if (now >= until) break;
                int have = end - start; if (have != seen) { seen = have; lastChange = now; }
                if (have > 0 && now - lastChange >= quietMs) break;
                try { wait(Math.max(10, Math.min(until - now, quietMs))); } catch (InterruptedException e) { break; }
            }
        }

        public void write(byte[] d) throws IOException { write(d, 0, d.length); }
        public void write(byte[] d, int off, int len) throws IOException {
            while (len > 0) {
                int n;
                synchronized (this) {
                    long until = System.currentTimeMillis() + 30000;
                    while (remoteWindow <= 0 && !chClosed && !closed) { long w = until - System.currentTimeMillis(); if (w <= 0) throw new IOException("the server is not accepting data (its window is full)"); try { wait(w); } catch (InterruptedException e) { throw new IOException("interrupted"); } }
                    if (chClosed || closed) throw new IOException("the channel is closed");
                    n = (int) Math.min(Math.min(len, remoteMax), remoteWindow); remoteWindow -= n;
                }
                send(new SshWire.Wr().u8(MSG_CH_DATA).u32(remote).str(java.util.Arrays.copyOfRange(d, off, off + n)).toBytes());
                off += n; len -= n;
            }
        }

        public void sendEof() throws IOException { send(new SshWire.Wr().u8(MSG_CH_EOF).u32(remote).toBytes()); }

        public void resize(int cols, int rows) throws IOException { request("window-change", false, new SshWire.Wr().u32(cols).u32(rows).u32(0).u32(0).toBytes()); }

        public void closeChannel() { if (!closeSent) { closeSent = true; try { send(new SshWire.Wr().u8(MSG_CH_CLOSE).u32(remote).toBytes()); } catch (IOException ignored) { } } }

        boolean request(String type, boolean reply, byte[] args) throws IOException {
            send(new SshWire.Wr().u8(MSG_CH_REQ).u32(remote).str(type).bool(reply).raw(args).toBytes());
            if (!reply) return true;
            try { Boolean b = replies.poll(15, TimeUnit.SECONDS); if (b == null) throw new IOException("the server did not answer the " + type + " request"); return b; }
            catch (InterruptedException e) { throw new IOException("interrupted"); }
        }
    }

    private Channel open() throws IOException {
        if (closed) throw new IOException("the connection is closed" + (closeReason.length() > 0 ? ": " + closeReason : ""));
        Channel c; synchronized (this) { c = new Channel(nextChannel++); channels.put(c.local, c); }
        send(new SshWire.Wr().u8(MSG_CH_OPEN).str("session").u32(c.local).u32(LOCAL_WINDOW).u32(MAX_PACKET).toBytes());
        try { if (!c.opened.await(20, TimeUnit.SECONDS)) throw new IOException("the server did not open a channel"); } catch (InterruptedException e) { throw new IOException("interrupted"); }
        if (!c.openOk) { channels.remove(c.local); throw new IOException("the server refused to open a channel" + (c.openErr != null ? ": " + c.openErr : closed ? ": " + closeReason : "")); }
        return c;
    }

    /** An interactive shell with a terminal (so full-screen and interactive programs work). */
    public Channel shell(int cols, int rows) throws IOException {
        Channel c = open();
        byte[] modes = new byte[] { 0 };
        if (!c.request("pty-req", true, new SshWire.Wr().str("xterm-256color").u32(cols).u32(rows).u32(0).u32(0).str(modes).toBytes())) { c.closeChannel(); throw new IOException("the server refused a terminal"); }
        if (!c.request("shell", true, new byte[0])) { c.closeChannel(); throw new IOException("the server refused to start a shell"); }
        return c;
    }

    /** One command, no terminal: stdout and stderr stay separate and the exit status is reported. */
    public Channel exec(String command) throws IOException {
        Channel c = open();
        if (!c.request("exec", true, new SshWire.Wr().str(command).toBytes())) { c.closeChannel(); throw new IOException("the server refused to run the command"); }
        return c;
    }
}
