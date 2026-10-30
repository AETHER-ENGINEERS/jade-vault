import app.netrunner.jade.SshClient;
import app.netrunner.jade.SshKeys;
import app.netrunner.jade.SshHost;
import app.netrunner.jade.MiniJson;

import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

/**
 * Tests the SSH client against a REAL server (Dropbear, built from source). Usage:
 *   SshTest host port keysDir authorizedKeysFile [rekeyPort]
 * keysDir holds hk_<type> host keys' fingerprints (hk_<type>.fp) and user keys uk_<type>.pem with uk_<type>.pub (the
 * public key line the key generator printed), so the key parser is checked against what the real tool wrote.
 */
public class SshTest {
    static int pass, fail;
    static void ok(boolean c, String m) { if (c) pass++; else fail++; System.out.println((c ? "PASS " : "FAIL ") + m); }
    static String s(byte[] b) { return new String(b, java.nio.charset.Charset.forName("UTF-8")); }

    static SshClient connect(String host, int port, String[] fpOut) throws Exception {
        SshClient c = new SshClient(host, port);
        c.connect(8000, new SshClient.HostKeyCheck() { public boolean accept(String type, String fp) { if (fpOut != null) { fpOut[0] = type; fpOut[1] = fp; } return true; } });
        return c;
    }

    static String run(SshClient c, String cmd) throws Exception {
        SshClient.Channel ch = c.exec(cmd); ByteArrayOutputStream o = new ByteArrayOutputStream();
        long end = System.currentTimeMillis() + 20000;
        while (!ch.isEof() && System.currentTimeMillis() < end) { o.write(ch.read(300)); }
        o.write(ch.read(100)); return s(o.toByteArray());
    }

    public static void main(String[] a) throws Exception {
        String host = "127.0.0.1"; int port = Integer.parseInt(a[1]); String keys = a[2]; String authFile = a[3]; int rekeyPort = a.length > 4 ? Integer.parseInt(a[4]) : 0;
        String user = "jadetest", pw = "testpass-123";

        // ---- the key parser against keys written by a real tool ----
        StringBuilder auth = new StringBuilder();
        for (String t : new String[] { "ed25519", "rsa", "ecdsa" }) {
            SshKeys.Key k = SshKeys.parse(Files.readAllBytes(Paths.get(keys, "uk_" + t + ".pem")));
            String pub = new String(Files.readAllBytes(Paths.get(keys, "uk_" + t + ".pub"))).trim();
            String mine = k.type + " " + Base64.getEncoder().encodeToString(k.publicBlob);
            ok(pub.startsWith(mine), "the " + t + " key file is read and its public key matches what the generator printed");
            auth.append(mine).append('\n');
        }
        // PEM formats written by another tool (python cryptography / openssl)
        for (String f : new String[] { "pem_rsa.pem", "pem_rsa_pkcs8.pem", "pem_ec.pem", "pem_ed25519_openssh.pem", "pem_ec_openssh.pem", "pem_rsa_openssh.pem" }) {
            if (!Files.exists(Paths.get(keys, f))) continue;
            SshKeys.Key k = SshKeys.parse(Files.readAllBytes(Paths.get(keys, f)));
            String pub = new String(Files.readAllBytes(Paths.get(keys, f + ".pub"))).trim();
            String mine = k.type + " " + Base64.getEncoder().encodeToString(k.publicBlob);
            ok(pub.startsWith(mine), f + ": read, public key matches");
            auth.append(mine).append('\n');
        }
        Files.write(Paths.get(authFile), auth.toString().getBytes("UTF-8"));
        String enc = Files.exists(Paths.get(keys, "uk_enc.pem")) ? "yes" : "no";
        if (enc.equals("yes")) { try { SshKeys.parse(Files.readAllBytes(Paths.get(keys, "uk_enc.pem"))); ok(false, "a passphrase-protected key is refused"); } catch (java.io.IOException e) { ok(e.getMessage().contains("passphrase"), "a passphrase-protected key is refused with a clear reason: " + e.getMessage().substring(0, 40)); } }
        try { SshKeys.parse("hello".getBytes()); ok(false, "junk is not a key"); } catch (java.io.IOException e) { ok(true, "a file that is not a key is refused"); }

        // ---- Ed25519 against the JDK's own implementation (RFC 8032 test vector 1) ----
        byte[] seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        SshKeys.Key ek = SshKeys.ed25519(seed);
        ok(java.util.Arrays.equals(java.util.Arrays.copyOfRange(ek.publicBlob, ek.publicBlob.length - 32, ek.publicBlob.length), hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")), "Ed25519 public key matches RFC 8032 test 1");
        ok(java.util.Arrays.equals(ek.sign("ssh-ed25519", new byte[0]), hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")), "Ed25519 signature matches RFC 8032 test 1");
        java.security.KeyPairGenerator g = java.security.KeyPairGenerator.getInstance("Ed25519");
        for (int i = 0; i < 3; i++) {   // random keys and messages, verified by the JDK
            byte[] sd = new byte[32]; new java.security.SecureRandom().nextBytes(sd); byte[] msg = new byte[40 + i * 100]; new java.security.SecureRandom().nextBytes(msg);
            SshKeys.Key k2 = SshKeys.ed25519(sd); byte[] sig = k2.sign("ssh-ed25519", msg);
            byte[] pubRaw = java.util.Arrays.copyOfRange(k2.publicBlob, k2.publicBlob.length - 32, k2.publicBlob.length);
            // build an X.509 Ed25519 public key for the JDK
            byte[] spki = concat(hex("302a300506032b6570032100"), pubRaw);
            java.security.Signature v = java.security.Signature.getInstance("Ed25519"); v.initVerify(java.security.KeyFactory.getInstance("Ed25519").generatePublic(new java.security.spec.X509EncodedKeySpec(spki))); v.update(msg);
            ok(v.verify(sig), "a random Ed25519 signature verifies under the JDK (" + i + ")");
        }

        // ---- password login, host key, exec, stderr, exit status ----
        String[] fp = new String[2];
        SshClient c = connect(host, port, fp);
        String wantFp = new String(Files.readAllBytes(Paths.get(keys, "hk.fps"))).trim();
        ok(wantFp.contains(fp[1]), "the host key fingerprint matches the server's (" + fp[0] + " " + fp[1] + ")");
        ok(c.serverVersion().startsWith("SSH-2.0-dropbear"), "the server identifies itself: " + c.serverVersion());
        try { c.authPassword(user, "wrong"); ok(false, "a wrong password is refused"); } catch (SshClient.AuthException e) { ok(true, "a wrong password is refused: " + e.getMessage()); }
        c.authPassword(user, pw);
        ok(run(c, "id -un").trim().equals("jadetest"), "password login works and a command runs");
        SshClient.Channel ch = c.exec("echo out; echo err 1>&2; exit 3");
        ByteArrayOutputStream o = new ByteArrayOutputStream(); long end = System.currentTimeMillis() + 10000;
        while (!ch.isClosed() && System.currentTimeMillis() < end) o.write(ch.read(200));
        o.write(ch.read(50));
        ok(s(o.toByteArray()).equals("out\n") && s(ch.readErr()).equals("err\n") && ch.exitStatus() != null && ch.exitStatus() == 3, "stdout and stderr are separate and the exit status is 3");

        // ---- an interactive shell with a terminal ----
        SshClient.Channel sh = c.shell(80, 24);
        sh.write("echo $((6*7))\n".getBytes());
        String got = ""; end = System.currentTimeMillis() + 8000;
        while (!got.contains("\n42") && System.currentTimeMillis() < end) got += s(sh.read(300));
        ok(got.contains("42"), "an interactive shell answers a command");
        sh.resize(100, 40); sh.write("stty size\n".getBytes());
        got = ""; end = System.currentTimeMillis() + 8000;
        while (!got.contains("40 100") && System.currentTimeMillis() < end) got += s(sh.read(300));
        ok(got.contains("40 100"), "the terminal can be resized (stty size says 40 100)");
        sh.write(new byte[] { 3 });   // ctrl-c is a normal byte on a terminal
        Thread.sleep(400);   // (typing straight after ^C makes bash drop the first letter: that is the terminal, not the client)
        sh.write("sleep 30\n".getBytes()); Thread.sleep(900); sh.write(new byte[] { 3 }); Thread.sleep(400); sh.write("echo back-$((1+1))\n".getBytes());
        got = ""; end = System.currentTimeMillis() + 8000;
        while (!got.contains("back-2") && System.currentTimeMillis() < end) got += s(sh.read(300));
        ok(got.contains("back-2"), "ctrl-c interrupts a running command");
        sh.write("exit\n".getBytes()); end = System.currentTimeMillis() + 8000; while (!sh.isClosed() && System.currentTimeMillis() < end) sh.read(200);
        ok(sh.isClosed(), "leaving the shell closes its channel");

        // ---- flow control: several MB each way ----
        SshClient.Channel big = c.exec("head -c 6000000 /dev/zero | tr '\\0' 'x'");
        long total = 0; end = System.currentTimeMillis() + 30000; while (!big.isEof() && System.currentTimeMillis() < end) total += big.read(300).length; total += big.read(100).length;
        ok(total == 6000000, "6,000,000 bytes arrive intact through flow control: " + total);
        byte[] up = new byte[3000000]; new java.util.Random(7).nextBytes(up);
        SshClient.Channel cat = c.exec("cat > /tmp/jadetest-up.bin; echo done");
        cat.write(up); cat.sendEof(); end = System.currentTimeMillis() + 20000; while (!cat.isClosed() && System.currentTimeMillis() < end) cat.read(200);
        ok(Files.size(Paths.get("/tmp/jadetest-up.bin")) == 3000000 && java.util.Arrays.equals(Files.readAllBytes(Paths.get("/tmp/jadetest-up.bin")), up), "3 MB uploaded byte-for-byte");
        ok(run(c, "echo still-alive").trim().equals("still-alive"), "the connection is still usable afterwards");
        c.close(); ok(c.isClosed(), "close() ends the connection");

        // ---- every kind of key ----
        for (String t : new String[] { "ed25519", "rsa", "ecdsa" }) {
            SshClient k = connect(host, port, null);
            k.authKey(user, SshKeys.parse(Files.readAllBytes(Paths.get(keys, "uk_" + t + ".pem"))));
            ok(run(k, "echo key-ok").trim().equals("key-ok"), "login with a " + t + " key");
            k.close();
        }
        for (String f : new String[] { "pem_rsa.pem", "pem_rsa_pkcs8.pem", "pem_ec.pem", "pem_ed25519_openssh.pem", "pem_ec_openssh.pem", "pem_rsa_openssh.pem" }) {
            if (!Files.exists(Paths.get(keys, f))) continue;
            SshClient k = connect(host, port, null);
            k.authKey(user, SshKeys.parse(Files.readAllBytes(Paths.get(keys, f))));
            ok(run(k, "echo key-ok").trim().equals("key-ok"), "login with " + f);
            k.close();
        }
        SshClient bad = connect(host, port, null);
        try { bad.authKey(user, SshKeys.ed25519(new byte[32])); ok(false, "an unknown key is refused"); } catch (SshClient.AuthException e) { ok(true, "a key the server does not know is refused"); }
        bad.close();


        // ---- the session layer Jade uses (SshHost): open, type, read, run, files, close ----
        SshHost h = new SshHost();
        String base = "\"host\":\"127.0.0.1\",\"port\":" + port + ",\"user\":\"jadetest\",\"password\":\"" + pw + "\"";
        java.util.Map<String, Object> o1 = MiniJson.obj(h.run("open", "{" + base + "}"));
        ok(Boolean.TRUE.equals(o1.get("needs_trust")) && String.valueOf(o1.get("fingerprint")).startsWith("SHA256:"), "an unknown host is not connected to until its key is approved: " + o1.get("fingerprint"));
        String pinFp = String.valueOf(o1.get("fingerprint"));
        java.util.Map<String, Object> bad1 = MiniJson.obj(h.run("open", "{" + base + ",\"fingerprint\":\"SHA256:nope\"}"));
        ok(Boolean.TRUE.equals(bad1.get("host_key_changed")) && String.valueOf(bad1.get("error")).contains("not the one that was approved"), "a changed host key is refused with an explanation");
        ok(String.valueOf(MiniJson.obj(h.run("open", "{" + base.replace(pw, "wrong") + ",\"fingerprint\":\"" + pinFp + "\"}")).get("error")).contains("login failed"), "a wrong password reports a failed login");
        java.util.Map<String, Object> o2 = MiniJson.obj(h.run("open", "{" + base + ",\"fingerprint\":\"" + pinFp + "\",\"label\":\"test box\"}"));
        String sid = String.valueOf(o2.get("session"));
        ok(sid.startsWith("s") && String.valueOf(o2.get("output")).contains("$") , "open with the approved key gives a session and the first prompt: " + String.valueOf(o2.get("output")).trim());
        java.util.Map<String, Object> r1 = MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"echo hi; echo there\"}"));
        ok(String.valueOf(r1.get("output")).equals("hi\nthere") && ((Number) r1.get("exit_code")).intValue() == 0, "run returns just the output and the exit code: [" + r1.get("output") + "]");
        java.util.Map<String, Object> r2 = MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"ls /nonexistent-dir\"}"));
        ok(((Number) r2.get("exit_code")).intValue() != 0 && String.valueOf(r2.get("output")).contains("No such file"), "a failing command reports its exit code and message");
        h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"cd /tmp && export JADE_X=42\"}");
        ok(String.valueOf(MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"echo $JADE_X; pwd\"}")).get("output")).equals("42\n/tmp"), "the session keeps its state between commands (cd, exports)");
        java.util.Map<String, Object> r3 = MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"sleep 30\",\"timeout_s\":1}"));
        ok(Boolean.TRUE.equals(r3.get("timed_out")), "a slow command times out without hanging the session");
        h.run("send", "{\"session\":\"" + sid + "\",\"keys\":[\"ctrl-c\"]}");
        ok(String.valueOf(MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"echo free\"}")).get("output")).equals("free"), "ctrl-c frees the session again");
        // typing into a program that asks a question, with colours and prompts around it
        h.run("send", "{\"session\":\"" + sid + "\",\"text\":\"read -p 'name? ' n; printf '\\\\033[31mhello %s\\\\033[0m\\\\n' $n\",\"enter\":true,\"until\":\"name\\\\?\"}");
        java.util.Map<String, Object> r4 = MiniJson.obj(h.run("send", "{\"session\":\"" + sid + "\",\"text\":\"Jade\",\"enter\":true,\"until\":\"hello Jade\"}"));
        ok(Boolean.TRUE.equals(r4.get("matched")) && String.valueOf(r4.get("output")).contains("hello Jade") && !String.valueOf(r4.get("output")).contains("\u001b") && !String.valueOf(r4.get("output")).contains("[31m"), "interactive input works and colour codes are stripped: [" + String.valueOf(r4.get("output")).trim().replace("\n", "|") + "]");
        java.util.Map<String, Object> r5 = MiniJson.obj(h.run("send", "{\"session\":\"" + sid + "\",\"keys\":[\"bogus-key\"]}"));
        ok(String.valueOf(r5.get("error")).contains("unknown key"), "an unknown key name is refused with the list of valid ones");
        // files
        byte[] blob = new byte[200000]; new java.util.Random(3).nextBytes(blob);
        String b64 = Base64.getEncoder().encodeToString(blob);
        java.util.Map<String, Object> pu = MiniJson.obj(h.run("put", "{\"session\":\"" + sid + "\",\"remote_path\":\"/tmp/it's a file.bin\",\"data_b64\":\"" + b64 + "\"}"));
        ok(Boolean.TRUE.equals(pu.get("ok")) && java.util.Arrays.equals(Files.readAllBytes(Paths.get("/tmp/it's a file.bin")), blob), "put uploads a file whose name has quotes and spaces");
        java.util.Map<String, Object> ge = MiniJson.obj(h.run("get", "{\"session\":\"" + sid + "\",\"remote_path\":\"/tmp/it's a file.bin\"}"));
        ok(Boolean.TRUE.equals(ge.get("ok")) && java.util.Arrays.equals(Base64.getDecoder().decode(String.valueOf(ge.get("data_b64"))), blob), "get downloads it byte-for-byte");
        ok(String.valueOf(MiniJson.obj(h.run("get", "{\"session\":\"" + sid + "\",\"remote_path\":\"/tmp/nope-missing\"}")).get("error")).contains("No such file"), "get of a missing file says so");
        ok(String.valueOf(MiniJson.obj(h.run("get", "{\"session\":\"" + sid + "\",\"remote_path\":\"/tmp/it's a file.bin\",\"max_bytes\":1000}")).get("error")).contains("larger than"), "get refuses a file over the size limit");
        // a second session at the same time, and listing
        String sid2 = String.valueOf(MiniJson.obj(h.run("open", "{" + base + ",\"fingerprint\":\"" + pinFp + "\"}")).get("session"));
        h.run("exec", "{\"session\":\"" + sid2 + "\",\"command\":\"export WHO=second\"}");
        ok(String.valueOf(MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"echo [$WHO]\"}")).get("output")).equals("[]"), "two sessions are independent");
        ok(String.valueOf(h.run("list", "{}")).contains(sid2) && String.valueOf(h.run("list", "{}")).contains("test box"), "list shows the open sessions");
        // many lines of output are trimmed to a readable size, keeping the end
        java.util.Map<String, Object> r6 = MiniJson.obj(h.run("exec", "{\"session\":\"" + sid + "\",\"command\":\"seq 1 20000\",\"max_chars\":3000}"));
        ok(String.valueOf(r6.get("output")).length() < 3300 && String.valueOf(r6.get("output")).contains("characters omitted") && String.valueOf(r6.get("output")).trim().endsWith("20000"), "long output is cut in the middle and the end is kept");
        // the remote side ends the session
        java.util.Map<String, Object> r7 = MiniJson.obj(h.run("send", "{\"session\":\"" + sid2 + "\",\"text\":\"exit\",\"enter\":true,\"wait_ms\":3000}"));
        for (int i = 0; i < 4 && !Boolean.TRUE.equals(r7.get("closed")); i++) r7 = MiniJson.obj(h.run("read", "{\"session\":\"" + sid2 + "\",\"wait_ms\":1000}"));
        ok(Boolean.TRUE.equals(r7.get("closed")), "when the remote shell exits the session reports closed (on this or the next read): " + MiniJson.write(r7));
        ok(String.valueOf(MiniJson.obj(h.run("send", "{\"session\":\"nope\",\"text\":\"x\"}")).get("error")).contains("no session"), "an unknown session id is reported");
        h.run("close", "{\"session\":\"" + sid + "\"}"); ok(!String.valueOf(h.run("list", "{}")).contains("\"" + sid + "\""), "close removes the session");
        h.closeAll();

        // ---- a refused host key stops the connection ----
        try { new SshClient(host, port).connect(5000, new SshClient.HostKeyCheck() { public boolean accept(String t, String f) { return false; } }); ok(false, "a rejected host key aborts"); } catch (java.io.IOException e) { ok(e.getMessage().contains("not accepted"), "a rejected host key aborts the connection"); }
        try { new SshClient(host, 1).connect(2000, null); ok(false, "a closed port fails"); } catch (java.io.IOException e) { ok(true, "a closed port gives an error: " + e.getMessage()); }

        // ---- key re-exchange mid-session (a server that rekeys every 128 KB) ----
        if (rekeyPort > 0) {
            SshClient r = connect(host, rekeyPort, null); r.authPassword(user, pw);
            SshClient.Channel rc = r.exec("head -c 3000000 /dev/zero | tr '\\0' 'y'");
            long n = 0; end = System.currentTimeMillis() + 30000; while (!rc.isEof() && System.currentTimeMillis() < end) n += rc.read(300).length; n += rc.read(100).length;
            ok(n == 3000000 && !r.isClosed() && r.rekeyCount() >= 2, "3 MB survive many server-initiated key re-exchanges: " + n + " bytes, " + r.rekeyCount() + " rekeys" + (r.isClosed() ? " closed: " + r.closeReason() : ""));
            byte[] up2 = new byte[1500000]; new java.util.Random(9).nextBytes(up2);
            SshClient.Channel cat2 = r.exec("cat > /tmp/jadetest-up2.bin");
            cat2.write(up2); cat2.sendEof(); end = System.currentTimeMillis() + 20000; while (!cat2.isClosed() && System.currentTimeMillis() < end) cat2.read(200);
            ok(!r.isClosed() && java.util.Arrays.equals(Files.readAllBytes(Paths.get("/tmp/jadetest-up2.bin")), up2), "uploading while the keys are being exchanged also works");
            r.close();
        }

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }

    static byte[] hex(String h) { byte[] b = new byte[h.length() / 2]; for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16); return b; }
    static byte[] concat(byte[] x, byte[] y) { byte[] r = new byte[x.length + y.length]; System.arraycopy(x, 0, r, 0, x.length); System.arraycopy(y, 0, r, x.length, y.length); return r; }
}
