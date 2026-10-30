package app.netrunner.jade;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;

/**
 * Jade's own browser: a second WebView that sits under the app's page. Showing it brings it to the front, hiding it
 * puts the app's page back on top. It keeps running either way, with its own cookies, so after you sign in once she
 * can use the site. She drives it with window.NetrunnerAndroid.browser(id, op, arg); each answer comes back as
 * window.__jbr(id, result). It cannot open file:, intent: or app links, and it asks for no camera, microphone or location.
 */
final class BrowserHost {
    private static final String DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private final MainActivity a;
    private final FrameLayout root;
    private LinearLayout panel;
    private TextView bar;
    private WebView bw;
    private boolean shown;
    private int openId = -1;
    private String lastDialog = "";
    private String defaultUa;

    BrowserHost(MainActivity a, FrameLayout root) { this.a = a; this.root = root; }

    boolean isShown() { return shown; }

    /** Used by the back button: close the browser if it is in front. */
    boolean hideIfShown() {
        if (!shown) return false;
        setShown(false);
        return true;
    }

    private void setShown(boolean on) {
        if (bw == null) return;
        shown = on;
        if (on) panel.bringToFront(); else a.web.bringToFront();
        if (on) bar.setText("◆ Jade's browser · tap here to go back to Jade");
    }

    private void ensure() {
        if (bw != null) return;
        bw = new WebView(a);
        WebSettings s = bw.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(2);   // MIXED_CONTENT_COMPATIBILITY_MODE
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        defaultUa = s.getUserAgentString();
        try { CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(bw, true); } catch (Throwable ignored) { }
        bw.setBackgroundColor(0xFFFFFFFF);
        bw.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String sc = r.getUrl() == null ? null : r.getUrl().getScheme();
                return sc == null || !(sc.equals("http") || sc.equals("https"));   // never leave for another app or read a local file
            }
            @Override public void onPageFinished(WebView v, String url) {
                if (openId >= 0) { int id = openId; openId = -1; reply(id, "{\"ok\":true,\"url\":" + World.json(String.valueOf(url)) + ",\"title\":" + World.json(String.valueOf(v.getTitle())) + "}"); }
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame() && openId >= 0) { int id = openId; openId = -1; reply(id, "{\"error\":" + World.json("could not load the page: " + e.getDescription()) + "}"); }
            }
        });
        bw.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView v, String url, String m, JsResult r) { lastDialog = "alert: " + m; r.confirm(); return true; }
            @Override public boolean onJsConfirm(WebView v, String url, String m, JsResult r) { lastDialog = "confirm: " + m + " (accepted)"; r.confirm(); return true; }
            @Override public boolean onJsPrompt(WebView v, String url, String m, String def, JsPromptResult r) { lastDialog = "prompt: " + m; r.confirm(def == null ? "" : def); return true; }
        });
        bar = new TextView(a);
        bar.setTextColor(0xFFE8FFF4);
        bar.setBackgroundColor(0xFF0B1F18);
        bar.setTextSize(14);
        bar.setSingleLine(true);
        bar.setPadding(24, 22, 24, 22);
        bar.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { setShown(false); } });
        panel = new LinearLayout(a);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        panel.addView(bw, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(panel, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));   // under the app's page
    }

    void reply(int id, String jsLiteral) { a.js("window.__jbr&&window.__jbr(" + id + "," + jsLiteral + ")"); }

    /** Run one command on the UI thread. Always answers, with {"error":...} if it fails. */
    void cmd(final int id, final String op, final String arg) {
        a.runOnUiThread(new Runnable() {
            @Override public void run() {
                try { run1(id, op, arg); } catch (Throwable e) { reply(id, "{\"error\":" + World.json(String.valueOf(e.getMessage())) + "}"); }
            }
        });
    }

    private void run1(final int id, String op, String arg) throws Exception {
        ensure();
        if (op.equals("open")) {
            if (arg == null || !(arg.startsWith("http://") || arg.startsWith("https://"))) { reply(id, "{\"error\":\"only http and https addresses can be opened\"}"); return; }
            if (openId >= 0) reply(openId, "{\"error\":\"replaced by a newer page\"}");
            openId = id; lastDialog = "";
            bw.loadUrl(arg);
        } else if (op.equals("eval")) {
            bw.evaluateJavascript(arg, new ValueCallback<String>() {
                @Override public void onReceiveValue(String v) { reply(id, v == null ? "null" : v); }
            });
        } else if (op.equals("shot")) {
            int w = bw.getWidth(), h = bw.getHeight();
            if (w < 2 || h < 2) { reply(id, "{\"error\":\"the browser has no size yet; try again in a moment\"}"); return; }
            Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(b);
            c.drawColor(0xFFFFFFFF);
            bw.draw(c);
            int max = 1024;
            try { max = Math.max(200, Math.min(2000, Integer.parseInt(arg))); } catch (Exception ignored) { }
            Bitmap out = b;
            if (w > max) out = Bitmap.createScaledBitmap(b, max, Math.max(1, Math.round(h * (max / (float) w))), true);
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            out.compress(Bitmap.CompressFormat.JPEG, 72, o);
            String b64 = Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP);
            int ow = out.getWidth(), oh = out.getHeight();
            if (out != b) out.recycle();
            b.recycle();
            reply(id, "{\"b64\":\"" + b64 + "\",\"w\":" + ow + ",\"h\":" + oh + "}");
        } else if (op.equals("show")) { setShown(true); reply(id, "{\"ok\":true,\"shown\":true}");
        } else if (op.equals("hide")) { setShown(false); reply(id, "{\"ok\":true,\"shown\":false}");
        } else if (op.equals("back")) { boolean ok = bw.canGoBack(); if (ok) bw.goBack(); reply(id, "{\"ok\":" + ok + "}");
        } else if (op.equals("forward")) { boolean ok = bw.canGoForward(); if (ok) bw.goForward(); reply(id, "{\"ok\":" + ok + "}");
        } else if (op.equals("reload")) { bw.reload(); reply(id, "{\"ok\":true}");
        } else if (op.equals("stop")) { bw.stopLoading(); if (openId >= 0) { int o = openId; openId = -1; reply(o, "{\"ok\":true,\"stopped\":true,\"url\":" + World.json(String.valueOf(bw.getUrl())) + ",\"title\":" + World.json(String.valueOf(bw.getTitle())) + "}"); } reply(id, "{\"ok\":true}");
        } else if (op.equals("ua")) { bw.getSettings().setUserAgentString("desktop".equals(arg) ? DESKTOP_UA : defaultUa); reply(id, "{\"ok\":true,\"ua\":" + World.json("desktop".equals(arg) ? "desktop" : "mobile") + "}");
        } else if (op.equals("clear")) {
            bw.stopLoading(); bw.clearHistory(); bw.clearCache(true); bw.clearFormData();
            try { CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush(); WebStorage.getInstance().deleteAllData(); } catch (Throwable ignored) { }
            bw.loadUrl("about:blank");
            reply(id, "{\"ok\":true}");
        } else if (op.equals("state")) {
            reply(id, "{\"url\":" + World.json(String.valueOf(bw.getUrl())) + ",\"title\":" + World.json(String.valueOf(bw.getTitle())) + ",\"progress\":" + bw.getProgress()
                + ",\"canGoBack\":" + bw.canGoBack() + ",\"shown\":" + shown + ",\"lastDialog\":" + World.json(lastDialog) + "}");
        } else reply(id, "{\"error\":\"unknown browser command " + op.replace("\"", "") + "\"}");
    }

    void destroy() { try { if (bw != null) bw.destroy(); } catch (Throwable ignored) { } }
}
