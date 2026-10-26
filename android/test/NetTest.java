import app.netrunner.jade.NetAccess;
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.Base64;

/** The page's fetch on the phone (Net → Rust), called the way the WebView bridge calls it. */
public class NetTest {
    static int failed = 0;
    static void ok(boolean c, String m) { System.out.println((c ? "PASS " : "FAIL ") + m); if (!c) failed++; }

    public static void main(String[] a) throws Exception {
        HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        srv.createContext("/", ex -> {
            byte[] in = ex.getRequestBody().readAllBytes();
            String body = ex.getRequestMethod() + " " + new String(in, "UTF-8") + " " + ex.getRequestHeaders().getFirst("X-Test");
            byte[] out = body.getBytes("UTF-8");
            ex.getResponseHeaders().add("X-Back", "yes");
            ex.sendResponseHeaders(207, out.length);
            try (OutputStream o = ex.getResponseBody()) { o.write(out); }
        });
        srv.start();
        int port = srv.getAddress().getPort();
        String b64 = Base64.getEncoder().encodeToString("héllo ✓".getBytes("UTF-8"));
        String id = NetAccess.start("{\"method\":\"POST\",\"url\":\"http://127.0.0.1:" + port + "/x\",\"headers\":[[\"X-Test\",\"abc\"]],\"body\":\"" + b64 + "\"}");
        ok(!id.startsWith("ERR:"), "a request starts: " + id);
        StringBuilder all = new StringBuilder(); String head = null; String err = null;
        for (int i = 0; i < 400; i++) {
            String p = NetAccess.poll(Long.parseLong(id));
            if (p.contains("\"head\"")) head = p;
            int d = p.indexOf("\"data\":\"");
            if (d >= 0) all.append(new String(Base64.getDecoder().decode(p.substring(d + 8, p.indexOf('"', d + 8))), "UTF-8"));
            if (p.contains("\"error\"")) err = p;
            if (p.contains("\"done\":true")) break;
            Thread.sleep(5);
        }
        ok(head != null && head.contains("\"status\":207") && head.toLowerCase().contains("x-back"), "status and headers arrive: " + head);
        ok(all.toString().equals("POST héllo ✓ abc"), "the body goes both ways, every character intact: " + all);
        ok(err == null, "no error");
        ok(NetAccess.wakes() >= 2, "native threads called back into Java to wake the page (" + NetAccess.wakes() + " times)");
        long fid = Long.parseLong(NetAccess.start("{\"url\":\"ftp://x/\"}")); String fp = "";
        for (int i = 0; i < 200 && !fp.contains("\"done\":true"); i++) { fp = NetAccess.poll(fid); Thread.sleep(5); }
        ok(fp.contains("unsupported URL scheme"), "an unsupported URL is reported when polled: " + fp);
        String bad = NetAccess.start("{nope");
        ok(bad.startsWith("ERR:"), "malformed requests are refused: " + bad);
        srv.stop(0);
        System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
        if (failed > 0) System.exit(1);
    }
}
