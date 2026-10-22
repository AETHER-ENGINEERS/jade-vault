package app.netrunner.jade;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Jade's SSH sessions. The page calls run(op, json) on a worker thread and gets JSON back. A session is a live
 * connection with an interactive shell on a terminal: she opens it, types into it, reads what comes back, and closes
 * it, and several can be open at once. Output has the terminal's control codes stripped so it reads as plain text.
 * Credentials arrive with "open" and are held only in the connection; they are never returned.
 */
public final class SshHost {
    private static final int MAX_SESSIONS = 8;

    private static final class Sess {
        String id, label, host, user; SshClient c; SshClient.Channel ch; long opened = System.currentTimeMillis(); final Cleaner cleaner = new Cleaner();
    }

    private final Map<String, Sess> sessions = new ConcurrentHashMap<String, Sess>();
    private int counter;

    public String run(String op, String json) {
        try {
            Map<String, Object> a = MiniJson.obj(json == null || json.length() == 0 ? "{}" : json);
            if (op.equals("open")) return open(a);
            if (op.equals("list")) return list();
            if (op.equals("close_all")) { closeAll(); return "{\"ok\":true}"; }
            Sess s = need(a);
            if (op.equals("send")) return send(s, a);
            if (op.equals("read")) return collect(s, MiniJson.num(a, "wait_ms", 600), MiniJson.num(a, "quiet_ms", 350), MiniJson.str(a, "until"), (int) MiniJson.num(a, "max_chars", 12000), null);
            if (op.equals("exec")) return exec(s, a);
            if (op.equals("resize")) { s.ch.resize((int) MiniJson.num(a, "cols", 120), (int) MiniJson.num(a, "rows", 40)); return "{\"ok\":true}"; }
            if (op.equals("put")) return put(s, a);
            if (op.equals("get")) return get(s, a);
            if (op.equals("close")) { close(s); return "{\"ok\":true,\"closed\":" + MiniJson.quote(s.id) + "}"; }
            return err("unknown ssh action " + op);
        } catch (Throwable e) { return err(String.valueOf(e.getMessage() == null ? e : e.getMessage())); }
    }

    public void closeAll() { for (Sess s : new ArrayList<Sess>(sessions.values())) close(s); }

    private static String err(String m) { Map<String, Object> r = new LinkedHashMap<String, Object>(); r.put("error", m); return MiniJson.write(r); }

    private Sess need(Map<String, Object> a) {
        String id = MiniJson.str(a, "session");
        Sess s = id == null ? null : sessions.get(id);
        if (s == null) throw new IllegalArgumentException(id == null ? "which session? (use the id that open returned; list shows them)" : "no session " + id + " (it may have been closed; list shows what is open)");
        return s;
    }

    // ---------------------------------------------------------------- open
    @SuppressWarnings("unchecked")
    private String open(Map<String, Object> a) throws Exception {
        if (sessions.size() >= MAX_SESSIONS) {
            for (Sess s : new ArrayList<Sess>(sessions.values())) if (s.c.isClosed() || s.ch.isClosed()) close(s);
            if (sessions.size() >= MAX_SESSIONS) return err("too many open sessions (" + MAX_SESSIONS + "); close one first");
        }
        final String host = MiniJson.str(a, "host"), user = MiniJson.str(a, "user"), pinned = MiniJson.str(a, "fingerprint");
        if (host == null || host.length() == 0 || user == null || user.length() == 0) return err("open needs a host and a user");
        int port = (int) MiniJson.num(a, "port", 22);
        final boolean trust = MiniJson.bool(a, "trust", false);
        final String[] seen = new String[2]; final boolean[] flags = new boolean[2];   // 0 = needs trust, 1 = key changed
        SshClient c = new SshClient(host, port);
        try {
            c.connect(15000, new SshClient.HostKeyCheck() { public boolean accept(String type, String fp) {
                seen[0] = type; seen[1] = fp;
                if (pinned != null && pinned.length() > 0) { if (pinned.equals(fp)) return true; flags[1] = true; return false; }
                if (trust) return true;
                flags[0] = true; return false;
            } });
        } catch (IOException e) {
            c.close();
            Map<String, Object> r = new LinkedHashMap<String, Object>();
            if (flags[0]) { r.put("needs_trust", true); r.put("fingerprint", seen[1]); r.put("key_type", seen[0]); return MiniJson.write(r); }
            if (flags[1]) { r.put("error", "the host key is not the one that was approved for " + host + " (expected " + pinned + ", the server presented " + seen[1] + "). That can mean the server was reinstalled, or that someone is intercepting the connection."); r.put("host_key_changed", true); r.put("fingerprint", seen[1]); return MiniJson.write(r); }
            return err("could not connect to " + host + ":" + port + ": " + e.getMessage());
        }
        try {
            String pw = MiniJson.str(a, "password"), key = MiniJson.str(a, "key");
            if (key != null && key.length() > 0) c.authKey(user, SshKeys.parse(key.getBytes("UTF-8")));
            else if (pw != null) c.authPassword(user, pw);
            else { c.close(); return err("no password or private key is set for this host"); }
        } catch (IOException e) { c.close(); return err("login failed: " + e.getMessage()); }
        Sess s = new Sess();
        s.c = c; s.host = host; s.user = user; s.label = MiniJson.str(a, "label") == null ? host : MiniJson.str(a, "label");
        try { s.ch = c.shell((int) MiniJson.num(a, "cols", 120), (int) MiniJson.num(a, "rows", 40)); }
        catch (IOException e) { c.close(); return err("logged in, but the server would not give a shell: " + e.getMessage()); }
        synchronized (this) { s.id = "s" + (++counter); }
        sessions.put(s.id, s);
        String first = collect(s, 2500, 500, null, 6000, null);
        Map<String, Object> r = MiniJson.obj(first); r.put("session", s.id); r.put("host", host); r.put("user", user); r.put("server", c.serverVersion());
        return MiniJson.write(r);
    }

    // ---------------------------------------------------------------- talking to a session
    private static final String[][] KEYS = {
        { "enter", "\r" }, { "return", "\r" }, { "tab", "\t" }, { "esc", "\u001b" }, { "escape", "\u001b" }, { "backspace", "\u007f" }, { "space", " " }, { "delete", "\u001b[3~" },
        { "up", "\u001b[A" }, { "down", "\u001b[B" }, { "right", "\u001b[C" }, { "left", "\u001b[D" }, { "home", "\u001b[H" }, { "end", "\u001b[F" }, { "pageup", "\u001b[5~" }, { "pagedown", "\u001b[6~" },
    };

    static String keyBytes(String name) {
        String n = name.toLowerCase().trim();
        for (String[] k : KEYS) if (k[0].equals(n)) return k[1];
        if (n.startsWith("ctrl-") || n.startsWith("ctrl+") || n.startsWith("c-")) {
            String k = n.substring(n.indexOf(n.startsWith("c-") ? '-' : n.charAt(4)) + 1);
            if (k.length() == 1) { char c = k.charAt(0); if (c >= 'a' && c <= 'z') return String.valueOf((char) (c - 'a' + 1)); if (c == '[') return "\u001b"; if (c == '\\') return "\u001c"; if (c == ']') return "\u001d"; if (c == ' ') return "\u0000"; }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private String send(Sess s, Map<String, Object> a) throws Exception {
        if (s.c.isClosed() || s.ch.isClosed()) return collect(s, 0, 0, null, 12000, null);
        StringBuilder b = new StringBuilder();
        String text = MiniJson.str(a, "text"); if (text != null) b.append(text);
        if (MiniJson.bool(a, "enter", false)) b.append('\r');
        List<Object> keys = MiniJson.l(a, "keys");
        if (keys != null) for (Object k : keys) { String kb = keyBytes(String.valueOf(k)); if (kb == null) return err("unknown key \"" + k + "\" (enter, tab, esc, backspace, space, delete, up, down, left, right, home, end, pageup, pagedown, ctrl-a … ctrl-z)"); b.append(kb); }
        if (b.length() == 0) return err("send needs text, keys, or enter");
        s.ch.write(b.toString().getBytes("UTF-8"));
        return collect(s, MiniJson.num(a, "wait_ms", 700), MiniJson.num(a, "quiet_ms", 350), MiniJson.str(a, "until"), (int) MiniJson.num(a, "max_chars", 12000), null);
    }

    /** Gather output: wait for something to arrive and go quiet (or for the until-pattern, or the deadline). */
    private String collect(Sess s, double waitMs, double quietMs, String until, int maxChars, String stopMarker) {
        long wait = (long) Math.max(0, Math.min(120000, waitMs)), quiet = (long) Math.max(50, Math.min(10000, quietMs));
        long end = System.currentTimeMillis() + wait; Pattern p = null;
        if (until != null && until.length() > 0) { try { p = Pattern.compile(until); } catch (Exception e) { return err("the until pattern is not a valid regular expression: " + e.getMessage()); } }
        StringBuilder acc = new StringBuilder(); boolean matched = false;
        while (true) {
            long left = end - System.currentTimeMillis();
            if (left > 0 && !s.ch.isEof()) s.ch.waitActivity(left, quiet);
            acc.append(s.cleaner.feed(s.ch.read(0)));
            acc.append(s.cleaner.take());
            if (p != null) { if (p.matcher(acc).find()) { matched = true; break; } if (System.currentTimeMillis() < end && !s.ch.isEof()) continue; break; }
            break;
        }
        if (s.ch.isEof() && !s.ch.isClosed()) s.ch.awaitClosed(400);
        acc.append(s.cleaner.feed(s.ch.read(0))); acc.append(s.cleaner.take());
        Map<String, Object> r = new LinkedHashMap<String, Object>();
        String out = clip(acc.toString(), Math.max(500, Math.min(100000, maxChars)));
        r.put("output", out);
        if (p != null) r.put("matched", matched);
        long dropped = s.ch.droppedBytes(); if (dropped > 0) r.put("dropped_bytes", (double) dropped);
        if (s.c.isClosed() || s.ch.isClosed()) { r.put("closed", true); if (s.ch.exitStatus() != null) r.put("exit", (double) s.ch.exitStatus()); if (s.c.isClosed() && s.c.closeReason().length() > 0 && !s.c.closeReason().equals("closed")) r.put("reason", s.c.closeReason()); }
        return MiniJson.write(r);
    }

    private static String clip(String t, int max) {
        if (t.length() <= max) return t;
        int head = Math.min(2000, max / 6), tail = max - head;
        return t.substring(0, head) + "\n… [" + (t.length() - max) + " characters omitted] …\n" + t.substring(t.length() - tail);
    }

    /** Run one command in the session's shell and wait until it finishes, reporting its exit code. */
    private String exec(Sess s, Map<String, Object> a) throws Exception {
        String cmd = MiniJson.str(a, "command");
        if (cmd == null || cmd.trim().length() == 0) return err("run needs a command");
        if (s.c.isClosed() || s.ch.isClosed()) return collect(s, 0, 0, null, 12000, null);
        double timeout = Math.max(1, Math.min(1800, MiniJson.num(a, "timeout_s", 60)));
        int max = (int) MiniJson.num(a, "max_chars", 12000);
        String tag; synchronized (this) { tag = "__JD" + (++counter) + "_" + Long.toString(System.nanoTime() % 100000, 36) + "__"; }
        collect(s, 0, 50, null, 100, null);   // drop anything already waiting
        s.ch.write((cmd + " ; printf '\\n" + tag + ":%s:\\n' $?\r").getBytes("UTF-8"));
        Pattern done = Pattern.compile(Pattern.quote(tag) + ":(\\d+):");
        StringBuilder acc = new StringBuilder(); long end = System.currentTimeMillis() + (long) (timeout * 1000); Matcher m = null; boolean ok = false;
        while (System.currentTimeMillis() < end) {
            s.ch.waitActivity(Math.min(1000, end - System.currentTimeMillis()), 300);
            acc.append(s.cleaner.feed(s.ch.read(0))); acc.append(s.cleaner.take());
            m = done.matcher(acc); if (m.find()) { ok = true; break; }
            if (s.ch.isEof()) break;
        }
        Map<String, Object> r = new LinkedHashMap<String, Object>();
        if (ok) {
            String body = acc.substring(0, m.start());
            int nl = body.indexOf('\n'); body = nl >= 0 && body.substring(0, nl).contains("printf") ? body.substring(nl + 1) : body;   // the echo of what was typed
            while (body.endsWith("\n")) body = body.substring(0, body.length() - 1);
            r.put("output", clip(body, Math.max(500, Math.min(100000, max)))); r.put("exit_code", Double.parseDouble(m.group(1)));
        } else {
            r.put("output", clip(acc.toString(), Math.max(500, Math.min(100000, max)))); r.put("timed_out", !s.ch.isEof());
            if (!s.ch.isEof()) r.put("note", "still running (or waiting for input): use read to see more, send to answer it, or send keys [\"ctrl-c\"] to stop it");
            else { r.put("closed", true); }
        }
        return MiniJson.write(r);
    }

    private String list() {
        List<Object> l = new ArrayList<Object>();
        for (Sess s : sessions.values()) {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("session", s.id); m.put("host", s.host); m.put("user", s.user); m.put("label", s.label); m.put("age_s", (double) ((System.currentTimeMillis() - s.opened) / 1000));
            m.put("closed", s.c.isClosed() || s.ch.isClosed()); m.put("unread_bytes", (double) s.ch.available());
            l.add(m);
        }
        Map<String, Object> r = new LinkedHashMap<String, Object>(); r.put("sessions", l); return MiniJson.write(r);
    }

    private void close(Sess s) { sessions.remove(s.id); try { s.ch.closeChannel(); } catch (Throwable ignored) { } try { s.c.close(); } catch (Throwable ignored) { } }

    // ---------------------------------------------------------------- files
    private static String shq(String p) { return "'" + p.replace("'", "'\\''") + "'"; }

    private String put(Sess s, Map<String, Object> a) throws Exception {
        String path = MiniJson.str(a, "remote_path"), b64 = MiniJson.str(a, "data_b64");
        if (path == null || path.length() == 0 || b64 == null) return err("put needs remote_path and the file's data");
        byte[] data = SshKeys.b64(b64);
        SshClient.Channel ch = s.c.exec((MiniJson.bool(a, "append", false) ? "cat >> " : "cat > ") + shq(path));
        ch.write(data); ch.sendEof();
        long end = System.currentTimeMillis() + 120000; while (!ch.isClosed() && System.currentTimeMillis() < end) ch.read(200);
        String e = new String(ch.readErr(), "UTF-8");
        Integer x = ch.exitStatus();
        if (x == null || x != 0) return err("the upload failed" + (e.length() > 0 ? ": " + e.trim() : x == null ? " (no answer)" : " (exit " + x + ")"));
        Map<String, Object> r = new LinkedHashMap<String, Object>(); r.put("ok", true); r.put("bytes", (double) data.length); r.put("remote_path", path); return MiniJson.write(r);
    }

    private String get(Sess s, Map<String, Object> a) throws Exception {
        String path = MiniJson.str(a, "remote_path"); if (path == null || path.length() == 0) return err("get needs remote_path");
        long max = (long) MiniJson.num(a, "max_bytes", 8 * 1024 * 1024);
        SshClient.Channel ch = s.c.exec("cat " + shq(path));
        ByteArrayOutputStream o = new ByteArrayOutputStream(); long end = System.currentTimeMillis() + 120000;
        while (!ch.isEof() && System.currentTimeMillis() < end) { byte[] d = ch.read(300); o.write(d); if (o.size() > max) { ch.closeChannel(); return err("the file is larger than " + max + " bytes"); } }
        o.write(ch.read(100));
        long wait = System.currentTimeMillis() + 3000; while (ch.exitStatus() == null && System.currentTimeMillis() < wait) { try { Thread.sleep(50); } catch (InterruptedException ignored) { } }
        String e = new String(ch.readErr(), "UTF-8"); Integer x = ch.exitStatus();
        if (x != null && x != 0) return err("could not read the file" + (e.length() > 0 ? ": " + e.trim() : " (exit " + x + ")"));
        if (o.size() > max) return err("the file is larger than " + max + " bytes");
        Map<String, Object> r = new LinkedHashMap<String, Object>(); r.put("ok", true); r.put("bytes", (double) o.size()); r.put("data_b64", b64enc(o.toByteArray())); return MiniJson.write(r);
    }

    static String b64enc(byte[] d) {
        String t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; StringBuilder s = new StringBuilder((d.length + 2) / 3 * 4);
        for (int i = 0; i < d.length; i += 3) {
            int v = (d[i] & 0xff) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xff) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xff : 0);
            s.append(t.charAt(v >> 18 & 63)).append(t.charAt(v >> 12 & 63)).append(i + 1 < d.length ? t.charAt(v >> 6 & 63) : '=').append(i + 2 < d.length ? t.charAt(v & 63) : '=');
        }
        return s.toString();
    }

    // ---------------------------------------------------------------- terminal output -> readable text
    /** Strips colour and cursor codes, resolves backspaces and carriage returns, and copes with sequences split across reads. */
    static final class Cleaner {
        private static final int NORMAL = 0, ESC = 1, CSI = 2, OSC = 3, OSC_ESC = 4, CHARSET = 5;
        private int state = NORMAL; private boolean pendingCr;
        private final StringBuilder out = new StringBuilder(); private int lineStart;
        private byte[] carry = new byte[0];

        synchronized String feed(byte[] chunk) {
            if (chunk.length == 0 && carry.length == 0) return "";
            byte[] all = new byte[carry.length + chunk.length]; System.arraycopy(carry, 0, all, 0, carry.length); System.arraycopy(chunk, 0, all, carry.length, chunk.length);
            int keep = incompleteTail(all); carry = new byte[keep]; System.arraycopy(all, all.length - keep, carry, 0, keep);
            String text; try { text = new String(all, 0, all.length - keep, "UTF-8"); } catch (Exception e) { text = ""; }
            for (int i = 0; i < text.length(); i++) step(text.charAt(i));
            return "";
        }

        /** The text so far, and start the next call fresh. */
        synchronized String take() { String s = out.toString(); out.setLength(0); lineStart = 0; return s; }

        private static int incompleteTail(byte[] b) {
            for (int back = 1; back <= 3 && back <= b.length; back++) {
                int c = b[b.length - back] & 0xff;
                if ((c & 0xc0) == 0x80) continue;                  // a continuation byte: look further back for its lead byte
                int need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
                return need > back ? back : 0;
            }
            return 0;
        }

        private void step(char c) {
            switch (state) {
                case ESC:
                    if (c == '[') state = CSI; else if (c == ']' || c == 'P' || c == 'X' || c == '^' || c == '_') state = OSC;
                    else if (c == '(' || c == ')' || c == '*' || c == '+') state = CHARSET; else state = NORMAL;
                    return;
                case CSI: if (c >= 0x40 && c <= 0x7e) state = NORMAL; return;
                case OSC: if (c == 0x07) state = NORMAL; else if (c == 0x1b) state = OSC_ESC; return;
                case OSC_ESC: state = c == '\\' ? NORMAL : OSC; return;
                case CHARSET: state = NORMAL; return;
                default: break;
            }
            if (pendingCr) {
                pendingCr = false;
                if (c == '\n') { out.append('\n'); lineStart = out.length(); return; }
                if (out.length() > lineStart) out.setLength(lineStart);   // a lone carriage return: the line is being redrawn
            }
            if (c == 0x1b) { state = ESC; return; }
            if (c == '\r') { pendingCr = true; return; }
            if (c == '\n') { out.append('\n'); lineStart = out.length(); return; }
            if (c == '\b') { if (out.length() > lineStart) out.setLength(out.length() - 1); return; }
            if (c == '\t') { out.append('\t'); return; }
            if (c < 0x20 || c == 0x7f) return;
            out.append(c);
        }
    }
}
