package app.netrunner.jade;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.view.Window;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.OutputStream;
import java.util.Locale;

/**
 * Pi Netrunner (Jade Cat edition) — a thin native shell around the single-page app in assets/index.html.
 * The page is loaded from file:// with universal file access, so it can call Ollama / Ollaya on the LAN
 * without CORS setup. Native extras exposed to JS as window.NetrunnerAndroid:
 *   speak(uid, text, pitch, rate) / stop()  -> Android TextToSpeech, events back via window.__jadeTTS(ev, uid)
 *   notify(title, body) / requestNotifications()
 */
public class MainActivity extends Activity implements ApiServer.Host {
    static final int REQ_FILE = 7, REQ_NOTIFY = 9, REQ_SAVE = 11, REQ_MEDIA = 13, REQ_GEO = 15, REQ_PERMS = 17;
    static final String CHANNEL = "netrunner";
    static final int SCREEN_NOTIFY = 90210;
    static final int BG = 0xff040807;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    TextToSpeech tts;
    boolean ttsReady;
    int notifyId = 100;
    String pendingSaveText, pendingSaveName;
    ApiServer api;
    World world;
    PermissionRequest pendingMedia;
    Net.Waker netWaker;
    String[] pendingMediaPerms;
    GeolocationPermissions.Callback pendingGeo;
    String pendingGeoOrigin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Net.waker = netWaker = new Net.Waker() {
            @Override public void wake() { runOnUiThread(new Runnable() { @Override public void run() { Net.woke(); js("window.__netWake&&window.__netWake()"); } }); }
        };
        try { SentryCore.init(getApplicationContext()); SentryCore.sink = this; SentryCore.pageReady = false; SentryCore.resume(this); } catch (Throwable ignored) { }
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);

        web = new WebView(this);
        web.setBackgroundColor(BG);
        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        browser = new BrowserHost(this, root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(0); // MIXED_CONTENT_ALWAYS_ALLOW
        s.setGeolocationEnabled(true);
        s.setTextZoom(100);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        // keep the page's JS at full priority when the app is not visible, so the agent loop keeps going
        if (Build.VERSION.SDK_INT >= 26) { try { web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false); } catch (Exception ignored) { } }
        api = new ApiServer(this);
        world = new World(this);
        diskHost = new DiskHost(this);
        phone = new PhoneHost(this);
        cast = new CastHost(this);
        ssh = new SshHost();
        web.addJavascriptInterface(new Bridge(this), "NetrunnerAndroid");

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                if (status != TextToSpeech.SUCCESS) { ttsReady = false; return; }
                int r = tts.setLanguage(Locale.UK);
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(Locale.getDefault());
                tts.setOnUtteranceProgressListener(new Progress());
                ttsReady = true;
            }
        });

        if (kioskOn()) setImmersive(true);
        if (state != null) web.restoreState(state);
        if (state == null || web.getUrl() == null) web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        try { stopService(new Intent(this, KeepAliveService.class)); } catch (Exception ignored) { }
        if (api != null) api.stop();
        if (world != null) world.destroy();
        if (phone != null) phone.destroy();
        if (cast != null) cast.destroy();
        if (ssh != null) ssh.closeAll();
        if (Net.waker == netWaker) Net.waker = null;
        if (SentryCore.sink == this) { SentryCore.sink = null; SentryCore.pageReady = false; }
        if (tts != null) { tts.stop(); tts.shutdown(); }
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (browser != null && browser.hideIfShown()) return;
        web.evaluateJavascript("(function(){try{return window.__androidBack?window.__androidBack():false}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) finish();
                    }
                });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SAVE) {
            String name = pendingSaveName, text = pendingSaveText;
            pendingSaveName = null; pendingSaveText = null;
            if (resultCode != -1 /* RESULT_OK */ || data == null || data.getData() == null || text == null) { js("window.__jadeSaved&&window.__jadeSaved(false,'cancelled')"); return; }
            try {
                OutputStream out = getContentResolver().openOutputStream(data.getData());
                out.write(text.getBytes("UTF-8"));
                out.close();
                js("window.__jadeSaved&&window.__jadeSaved(true," + quote(name == null ? "file" : name) + ")");
            } catch (Exception e) {
                js("window.__jadeSaved&&window.__jadeSaved(false," + quote(String.valueOf(e.getMessage())) + ")");
            }
            return;
        }
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean all = results != null && results.length > 0;
        if (results != null) for (int r : results) if (r != 0) all = false;
        if (code == REQ_MEDIA) {
            PermissionRequest r = pendingMedia; pendingMedia = null;
            if (r != null) { if (all) r.grant(r.getResources()); else r.deny(); }
        } else if (code == REQ_GEO) {
            GeolocationPermissions.Callback cb = pendingGeo; pendingGeo = null;
            if (cb != null) cb.invoke(pendingGeoOrigin, all, false);
        } else if (code == REQ_PERMS) {
            js("window.__jadePerms&&window.__jadePerms(" + permStatus(perms) + ")");
        }
    }

    String permStatus(String[] perms) {
        StringBuilder b = new StringBuilder("{");
        for (int i = 0; i < perms.length; i++) {
            if (i > 0) b.append(',');
            b.append(World.json(perms[i])).append(':').append(checkSelfPermission(perms[i]) == 0);
        }
        return b.append('}').toString();
    }

    @Override
    public void js(final String code) {
        web.post(new Runnable() {
            @Override
            public void run() { web.evaluateJavascript(code, null); }
        });
    }

    static String quote(String s) {
        StringBuilder b = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'' || c == '\\') b.append('\\').append(c);
            else if (c < 32) b.append(' ');
            else b.append(c);
        }
        return b.append('\'').toString();
    }

    class Progress extends UtteranceProgressListener {
        @Override public void onStart(String id) { js("window.__jadeTTS&&window.__jadeTTS('start'," + quote(id) + ")"); }
        @Override public void onDone(String id) { js("window.__jadeTTS&&window.__jadeTTS('done'," + quote(id) + ")"); }
        @Override public void onError(String id) { js("window.__jadeTTS&&window.__jadeTTS('error'," + quote(id) + ")"); }
    }

    class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String scheme = u == null ? null : u.getScheme();
            if (!req.isForMainFrame() || scheme == null || "file".equals(scheme) || "about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)) return false;
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, u);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception ignored) { }
            return true;
        }
    }

    class Chrome extends WebChromeClient {
        /** getUserMedia: camera and microphone. The Android permission is asked first, then the page's request is granted. */
        @Override
        public void onPermissionRequest(final PermissionRequest req) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    java.util.ArrayList<String> need = new java.util.ArrayList<String>();
                    for (String r : req.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission("android.permission.CAMERA") != 0) need.add("android.permission.CAMERA");
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && checkSelfPermission("android.permission.RECORD_AUDIO") != 0) need.add("android.permission.RECORD_AUDIO");
                    }
                    if (need.isEmpty()) { req.grant(req.getResources()); return; }
                    if (pendingMedia != null) pendingMedia.deny();
                    pendingMedia = req; pendingMediaPerms = need.toArray(new String[0]);
                    requestPermissions(pendingMediaPerms, REQ_MEDIA);
                }
            });
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(final String origin, final GeolocationPermissions.Callback cb) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == 0) { cb.invoke(origin, true, false); return; }
                    if (pendingGeo != null) pendingGeo.invoke(pendingGeoOrigin, false, false);
                    pendingGeo = cb; pendingGeoOrigin = origin;
                    requestPermissions(new String[]{"android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"}, REQ_GEO);
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                Intent i = params.createIntent();
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(i, REQ_FILE);
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    /** Exposed to JS as window.NetrunnerAndroid. Public + static so WebView's reflection can always call it. */
    public static class Bridge {
        private final MainActivity a;
        public Bridge(MainActivity a) { this.a = a; }

        @JavascriptInterface
        public boolean speak(String uid, String text, double pitch, double rate) { return a.nativeSpeak(uid, text, pitch, rate); }

        @JavascriptInterface
        public void stop() { if (a.tts != null) a.tts.stop(); }

        @JavascriptInterface
        public boolean ttsAvailable() { return a.ttsReady; }

        @JavascriptInterface
        public void openTtsSettings() { a.openTtsSettings(); }

        @JavascriptInterface
        public void requestNotifications() { a.requestNotifications(); }

        @JavascriptInterface
        public void notify(String title, String body) { a.showNotification(title, body); }

        /** Ask the user where to save a file (system "Save as" dialog), then write text to it. Result via window.__jadeSaved(ok, msg). */
        @JavascriptInterface
        public void saveFile(String name, String mime, String text) { a.saveFile(name, mime, text); }

        /** Start/update (on=true) or stop the foreground service that keeps Jade running in the background. */
        @JavascriptInterface
        public boolean keepAlive(boolean on, String text) { return a.keepAlive(on, text); }

        @JavascriptInterface
        public boolean batteryOptimized() { return a.batteryOptimized(); }

        @JavascriptInterface
        public void openBatterySettings() { a.openBatterySettings(); }

        /** Start/restart/stop Jade's HTTP API to match the settings. Returns its status as JSON text. */
        @JavascriptInterface
        public String apiConfigure(boolean enabled, int port, boolean lan, String token) { return a.api.configure(enabled, port, lan, token); }

        @JavascriptInterface
        public String apiStatus() { return a.api.status(); }

        /** JS hands back the finished answer for an API request (id from window.__jadeApi). */
        @JavascriptInterface
        public void apiResult(String id, int status, String body) { a.api.deliver(id, status, body); }

        // ---------- Jade's senses ----------
        /** Which of these Android permissions are granted, e.g. "android.permission.CAMERA,android.permission.RECORD_AUDIO" -> {"android.permission.CAMERA":true,...} */
        @JavascriptInterface
        public String permStatus(String csv) { return a.permStatus(csv.split(",")); }

        /** Ask for permissions; the answer comes back as window.__jadePerms({perm:bool}). */
        @JavascriptInterface
        public void requestPerms(final String csv) {
            a.runOnUiThread(new Runnable() { @Override public void run() { a.requestPermissions(csv.split(","), REQ_PERMS); } });
        }

        // ----- the vault on real storage (see DiskHost) -----
        @JavascriptInterface public String diskInfo() { return a.diskHost.info(); }
        @JavascriptInterface public String diskScan() { return a.diskHost.scan(); }
        @JavascriptInterface public String vaultParse(String req) { return a.diskHost.parse(req); }
        @JavascriptInterface public String vaultSearch(String req) { return a.diskHost.search(req); }
        @JavascriptInterface public String netStart(String req) { return Net.start(req); }
        @JavascriptInterface public String netPoll(double id) { return Net.poll((long) id); }
        @JavascriptInterface public void netAbort(double id) { Net.abort((long) id); }
        @JavascriptInterface public String diskGet(String path, double off, int len) { return a.diskHost.get(path, off, len); }
        @JavascriptInterface public String diskPut(String path, String b64, boolean first, boolean last) { return a.diskHost.put(path, b64, first, last); }
        @JavascriptInterface public String diskMkdir(String path) { return a.diskHost.mkdir(path); }
        @JavascriptInterface public String diskDel(String path) { return a.diskHost.del(path); }
        @JavascriptInterface public String diskMove(String from, String to) { return a.diskHost.move(from, to); }
        @JavascriptInterface public String diskTouch(String path, double mtime) { return a.diskHost.touch(path, mtime); }
        @JavascriptInterface public String diskClear() { return a.diskHost.clear(); }
        @JavascriptInterface public String diskUseShared() { return a.diskHost.useShared(); }

        @JavascriptInterface public String sensorList() { return a.world.sensorList(); }
        @JavascriptInterface public String sensorStart(String key, int periodMs) { return a.world.sensorStart(key, periodMs); }
        @JavascriptInterface public String sensorRead(String key) { return a.world.sensorRead(key); }
        @JavascriptInterface public String sensorStop(String key) { return a.world.sensorStop(key); }
        @JavascriptInterface public String battery() { return a.world.battery(); }
        /** Jade's browser (see BrowserHost). The answer arrives as window.__jbr(id, result). */
        @JavascriptInterface public void browser(int id, String op, String arg) { a.browser.cmd(id, op, arg); }
        /** Alarms, ringing, volume, calls, texts, contacts, clipboard, apps, radio… (see PhoneHost). */
        @JavascriptInterface public String phone(String op, String json) { return a.phone.run(op, json); }
        /** Slow phone work (casting to a TV, scanning Bluetooth): runs off the page's thread and answers via window.__jcast(id, result). */
        @JavascriptInterface public void cast(final int id, final String op, final String json) {
            new Thread(new Runnable() { public void run() { String r; try { r = op.startsWith("cast_") ? a.cast.run(op, json) : a.phone.run(op, json); } catch (Throwable e) { r = "{\"error\":" + World.json(String.valueOf(e.getMessage())) + "}"; } a.js("window.__jcast&&window.__jcast(" + id + "," + quote(r) + ")"); } }, "jade-cast").start();
        }
        /** Driving other apps through the accessibility service (see JadeAccess). Runs off the page thread; answers via window.__jscreen(id, result). */
        @JavascriptInterface public void screen(final int id, final String op, final String json) {
            new Thread(new Runnable() { public void run() { String r; try { r = a.screenRun(op, json); } catch (Throwable e) { r = "{\"error\":" + World.json(String.valueOf(e.getMessage())) + "}"; } a.js("window.__jscreen&&window.__jscreen(" + id + "," + quote(r) + ")"); } }, "jade-screen").start();
        }
        // ---- Sentry: the event rules engine (see SentryCore). The page owns the rules; the phone runs the watchers. ----
        @JavascriptInterface public String sentryConfigure(String json) { return SentryCore.configure(a, json); }
        @JavascriptInterface public String sentryStatus() { return SentryCore.status(a); }
        @JavascriptInterface public String sentrySystems() { return SentrySystems.catalogue(); }
        /** Events the phone queued while the page was away: {"items":[…],"expired":[…]}. Calling this also marks the page as ready for live delivery. */
        @JavascriptInterface public String sentryPending() { return SentryCore.pending(); }
        @JavascriptInterface public void sentryAck(String qid) { SentryCore.ack(qid); }
        @JavascriptInterface public void sentryEmit(String name, String json) { try { SentryCore.emit(name, MiniJson.obj(json == null || json.length() == 0 ? "{}" : json)); } catch (Throwable ignored) { } }
        @JavascriptInterface public void sentrySet(String json) { try { SentryCore.set(MiniJson.obj(json)); } catch (Throwable ignored) { } }
        @JavascriptInterface public void sentryTouch() { SentryCore.touch(); }
        /**
         * SSH sessions. Runs off the page thread (the handshake and reads block); answers via window.__jssh(id, result).
         * The page passes the host's credentials straight through from settings: the model asks for a host by name
         * and never receives the password or key back in a tool result.
         */
        @JavascriptInterface public void ssh(final int id, final String op, final String json) {
            new Thread(new Runnable() { public void run() {
                String r;
                try { r = a.ssh.run(op, json); } catch (Throwable e) { r = "{\"error\":" + World.json(String.valueOf(e.getMessage())) + "}"; }
                a.js("window.__jssh&&window.__jssh(" + id + "," + quote(r) + ")");
            } }, "jade-ssh").start();
        }

        /** Open Android's notification-access screen (only the user can grant it). */
        @JavascriptInterface public void sentryNotifAccess() { a.runOnUiThread(new Runnable() { public void run() { try { Intent i = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); a.startActivity(i); } catch (Exception ignored) { } } }); }
        /** Is Jade allowed to drive the screen? {"enabled":bool,"running":bool} */
        @JavascriptInterface public String screenStatus() { return a.screenStatus(); }
        /** Open Android's Accessibility settings so the user can switch Jade on (she cannot turn it on herself). */
        @JavascriptInterface public void screenEnable() { a.screenEnable(); }
        @JavascriptInterface public String torch(boolean on) { return a.world.torch(on); }
        @JavascriptInterface public String vibrate(String csv) { return a.world.vibrate(csv); }
        @JavascriptInterface public String wifi() { return a.world.wifi(); }

        /** On-device speech recognition. Events: window.__jadeSTT(ready|begin|end|partial|final|error, text). */
        @JavascriptInterface public boolean sttAvailable() { return a.world.sttAvailable(); }
        @JavascriptInterface public void sttStart(String lang, boolean partial, boolean offline) { a.world.sttStart(lang, partial, offline); }
        @JavascriptInterface public void sttStop(boolean cancel) { a.world.sttStop(cancel); }

        /** Kiosk mode: {"on","home","locked","pinned","owner"} */
        @JavascriptInterface
        public String kioskStatus() { return a.kioskStatus(); }

        @JavascriptInterface
        public void setKiosk(final boolean on) {
            a.runOnUiThread(new Runnable() { @Override public void run() { a.setKiosk(on); } });
        }
    }

    // ---------- kiosk mode: Jade as the home screen, full screen, locked in front ----------
    static final String HOME_ALIAS = "app.netrunner.jade.Home";

    DiskHost diskHost;
    BrowserHost browser;
    PhoneHost phone;
    CastHost cast;
    SshHost ssh;

    SharedPreferences prefs() { return getSharedPreferences("jade", 0); }

    boolean kioskOn() { try { return prefs().getBoolean("kiosk", false); } catch (Exception e) { return false; } }

    DevicePolicyManager dpm() { try { return (DevicePolicyManager) getSystemService("device_policy"); } catch (Exception e) { return null; } }

    boolean isOwner() { DevicePolicyManager d = dpm(); try { return d != null && d.isDeviceOwnerApp(getPackageName()); } catch (Exception e) { return false; } }

    int lockState() {
        try { return ((ActivityManager) getSystemService("activity")).getLockTaskModeState(); } catch (Exception e) { return 0; }
    }

    void setKiosk(boolean on) {
        prefs().edit().putBoolean("kiosk", on).apply();
        try {
            getPackageManager().setComponentEnabledSetting(new ComponentName(getPackageName(), HOME_ALIAS),
                    on ? 1 : 2, 1); // ENABLED / DISABLED, DONT_KILL_APP
        } catch (Exception ignored) { }
        if (on) { applyKiosk(); return; }
        if (isOwner()) {
            try { dpm().clearPackagePersistentPreferredActivities(new ComponentName(this, AdminReceiver.class), getPackageName()); } catch (Exception ignored) { }
        }
        try { if (lockState() != 0) stopLockTask(); } catch (Exception ignored) { }
        setImmersive(false);
    }

    /** Enter the kiosk: whitelist + permanent home as device owner, then lock task (screen pinning without it). */
    void applyKiosk() {
        if (!kioskOn()) return;
        if (isOwner()) {
            ComponentName admin = new ComponentName(this, AdminReceiver.class);
            try { dpm().setLockTaskPackages(admin, new String[]{getPackageName()}); } catch (Exception ignored) { }
            try {
                IntentFilter f = new IntentFilter("android.intent.action.MAIN");
                f.addCategory("android.intent.category.HOME");
                f.addCategory("android.intent.category.DEFAULT");
                dpm().addPersistentPreferredActivity(admin, f, new ComponentName(getPackageName(), HOME_ALIAS));
            } catch (Exception ignored) { }
            try { dpm().setKeyguardDisabled(admin, true); } catch (Exception ignored) { }
        }
        try { if (lockState() == 0) startLockTask(); } catch (Exception ignored) { }
        setImmersive(true);
    }

    void setImmersive(boolean on) {
        try {
            Window w = getWindow();
            if (on) {
                w.addFlags(0x80); // FLAG_KEEP_SCREEN_ON
                // IMMERSIVE_STICKY | FULLSCREEN | HIDE_NAVIGATION | LAYOUT_STABLE | LAYOUT_HIDE_NAVIGATION | LAYOUT_FULLSCREEN
                w.getDecorView().setSystemUiVisibility(0x1000 | 0x4 | 0x2 | 0x100 | 0x200 | 0x400);
            } else {
                w.clearFlags(0x80);
                w.getDecorView().setSystemUiVisibility(0);
            }
        } catch (Exception ignored) { }
    }

    String kioskStatus() {
        boolean home = false;
        try { home = getPackageManager().getComponentEnabledSetting(new ComponentName(getPackageName(), HOME_ALIAS)) == 1; } catch (Exception ignored) { }
        int st = lockState();
        return "{\"on\":" + kioskOn() + ",\"home\":" + home + ",\"locked\":" + (st == 1) + ",\"pinned\":" + (st == 2)
                + ",\"owner\":" + isOwner() + "}";
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (kioskOn()) applyKiosk();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && kioskOn()) setImmersive(true);
    }

    void saveFile(final String name, final String mime, final String text) {
        pendingSaveName = name; pendingSaveText = text;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mime == null || mime.length() == 0 ? "application/json" : mime);
                    i.putExtra(Intent.EXTRA_TITLE, name == null ? "jade-vault.json" : name);
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSaveText = null;
                    js("window.__jadeSaved&&window.__jadeSaved(false," + quote(String.valueOf(e.getMessage())) + ")");
                }
            }
        });
    }

    boolean keepAlive(boolean on, String text) {
        try {
            Intent i = new Intent(this, KeepAliveService.class);
            if (!on) { stopService(i); return true; }
            i.putExtra("text", text == null ? "" : text);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            return true;
        } catch (Exception e) {
            return false;   // e.g. Android 12+ refuses to start it while the app is already in the background
        }
    }

    boolean batteryOptimized() {
        try {
            if (Build.VERSION.SDK_INT < 23) return false;
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            return pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName());
        } catch (Exception e) { return false; }
    }

    void openBatterySettings() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", Uri.parse("package:" + getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    try { Intent i = new Intent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); } catch (Exception ignored) { }
                }
            }
        });
    }

    boolean nativeSpeak(String uid, String text, double pitch, double rate) {
        if (!ttsReady || tts == null) { js("window.__jadeTTS&&window.__jadeTTS('error'," + quote(uid) + ")"); return false; }
        float p = (float) Math.max(0.5, Math.min(2.0, pitch > 0 ? pitch : 1.0));
        float r = (float) Math.max(0.5, Math.min(2.0, rate > 0 ? rate : 1.0));
        tts.setPitch(p);
        tts.setSpeechRate(r);
        int res = tts.speak(text, TextToSpeech.QUEUE_ADD, null, uid);
        if (res != TextToSpeech.SUCCESS) { js("window.__jadeTTS&&window.__jadeTTS('error'," + quote(uid) + ")"); return false; }
        return true;
    }

    void openTtsSettings() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent("com.android.settings.TTS_SETTINGS");
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    try { Intent i = new Intent("android.settings.SETTINGS"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); } catch (Exception ignored) { }
                }
            }
        });
    }

    void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY); }
            });
        }
    }

    // ---------- driving other apps (JadeAccess accessibility service) ----------
    String screenRun(String op, String json) {
        app.netrunner.jade.JadeAccess svc = app.netrunner.jade.JadeAccess.get();
        if (svc == null) return "{\"error\":\"screen control is off: turn Jade on in Android's Accessibility settings first (phone action screen_enable opens them)\"}";
        try {
            org.json.JSONObject o = new org.json.JSONObject(json == null || json.length() == 0 ? "{}" : json);
            screenIndicator(true);
            return svc.run(op, o);
        } catch (Throwable e) { return "{\"error\":" + World.json(String.valueOf(e.getMessage())) + "}"; }
    }

    String screenStatus() {
        boolean running = app.netrunner.jade.JadeAccess.isRunning();
        return "{\"enabled\":" + running + ",\"running\":" + running + ",\"sdk\":" + Build.VERSION.SDK_INT + "}";
    }

    void screenEnable() {
        runOnUiThread(new Runnable() { public void run() {
            try { Intent i = new Intent("android.settings.ACCESSIBILITY_SETTINGS"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); } catch (Exception ignored) { }
        } });
    }

    /** A persistent, ongoing notification shown while Jade is driving the screen, auto-cleared when she stops. */
    private long lastScreenAct;
    void screenIndicator(final boolean on) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (!on) { nm.cancel(SCREEN_NOTIFY); return; }
            lastScreenAct = System.currentTimeMillis();
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) { nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Scheduled prompts", NotificationManager.IMPORTANCE_DEFAULT)); b = new Notification.Builder(this, CHANNEL); } else { b = new Notification.Builder(this); }
            b.setSmallIcon(getApplicationInfo().icon).setContentTitle("Jade is controlling your screen").setContentText("Tap to come back to Jade").setColor(0xff1fe5a5).setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            nm.notify(SCREEN_NOTIFY, b.build());
            // clear it a few seconds after the last action
            web.postDelayed(new Runnable() { public void run() { if (System.currentTimeMillis() - lastScreenAct >= 4000) screenIndicator(false); } }, 5000);
        } catch (Exception ignored) { }
    }

    void showNotification(String title, String body) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Scheduled prompts", NotificationManager.IMPORTANCE_DEFAULT));
                b = new Notification.Builder(this, CHANNEL);
            } else {
                b = new Notification.Builder(this);
            }
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.setSmallIcon(getApplicationInfo().icon)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setColor(0xff1fe5a5)
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            nm.notify(notifyId++, b.build());
        } catch (Exception ignored) { }
    }
}
