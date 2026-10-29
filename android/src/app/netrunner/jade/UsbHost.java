package app.netrunner.jade;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * USB devices on the phone's USB port (USB host / OTG), for the page's navigator.usb (Android's WebView has no
 * WebUSB) and Jade's usb tool. Devices are named by their path ("/dev/bus/usb/001/002"). Android asks the user once
 * per device ("permission"); after that the page can open it, claim interfaces and run control, bulk and interrupt
 * transfers. Every call returns JSON: the result, or {"error": "..."}; blocking calls run off the UI thread
 * (MainActivity.usbAsync).
 */
final class UsbHost {
    private static final String ACTION = ".USB_PERMISSION";
    private final MainActivity a;
    // transfers run on their own threads (several at once), so the bookkeeping is concurrent
    private final Map<String, UsbDeviceConnection> open = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, Map<Integer, UsbInterface>> claimed = new java.util.concurrent.ConcurrentHashMap<>();

    UsbHost(MainActivity a) { this.a = a; }

    private UsbManager mgr() { return (UsbManager) a.getSystemService(Context.USB_SERVICE); }
    private static String err(String m) { return "{\"error\":" + World.json(m) + "}"; }

    String run(String op, String json) {
        try {
            JSONObject o = new JSONObject(json == null || json.length() == 0 ? "{}" : json);
            UsbManager m = mgr();
            if (m == null) return err("this phone has no USB host support");
            if (op.equals("list")) return list(m);
            UsbDevice d = find(m, o.optString("device", ""));
            if (d == null) return err("no USB device " + o.optString("device", "") + " (unplugged?)");
            String id = d.getDeviceName();
            if (op.equals("permission")) return permission(m, d, o.optInt("timeout", 60));
            if (op.equals("open")) {
                if (open.containsKey(id)) return "{\"ok\":true}";
                if (!m.hasPermission(d)) return err("no permission for this device yet: ask for it first");
                UsbDeviceConnection c = m.openDevice(d);
                if (c == null) return err("Android could not open the device");
                open.put(id, c); claimed.put(id, new java.util.concurrent.ConcurrentHashMap<Integer, UsbInterface>());
                return "{\"ok\":true}";
            }
            if (op.equals("close")) { close(id); return "{\"ok\":true}"; }
            UsbDeviceConnection c = open.get(id);
            if (c == null) return err("the device is not open");
            if (op.equals("claim") || op.equals("select_alt")) {
                UsbInterface itf = iface(d, o.getInt("interface"), o.optInt("alternate", 0));
                if (itf == null) return err("no interface " + o.getInt("interface") + (o.has("alternate") ? " alternate " + o.getInt("alternate") : ""));
                if (op.equals("claim")) { if (!c.claimInterface(itf, o.optBoolean("force", true))) return err("could not claim interface " + itf.getId() + " (another driver has it?)"); }
                else if (!c.setInterface(itf)) return err("could not select alternate " + itf.getAlternateSetting());
                claimed.get(id).put(itf.getId(), itf);
                return "{\"ok\":true}";
            }
            if (op.equals("release")) {
                UsbInterface itf = claimed.get(id).remove(o.getInt("interface"));
                if (itf != null) c.releaseInterface(itf);
                return "{\"ok\":true}";
            }
            int timeout = o.optInt("timeout", 5000);
            if (op.equals("control")) {
                boolean in = "in".equals(o.optString("direction", "in"));
                int type = ("class".equals(o.optString("requestType")) ? 1 : "vendor".equals(o.optString("requestType")) ? 2 : 0) << 5;
                String r = o.optString("recipient", "device");
                int rec = r.equals("interface") ? 1 : r.equals("endpoint") ? 2 : r.equals("other") ? 3 : 0;
                int bm = (in ? UsbConstants.USB_DIR_IN : UsbConstants.USB_DIR_OUT) | type | rec;
                byte[] buf = in ? new byte[Math.max(0, o.optInt("length", 0))] : b64(o.optString("data", ""));
                int n = c.controlTransfer(bm, o.optInt("request"), o.optInt("value"), o.optInt("index"), buf, buf.length, timeout);
                if (n < 0) return "{\"status\":\"stall\",\"error\":\"the control transfer failed or timed out\"}";
                return in ? "{\"status\":\"ok\",\"data\":" + World.json(enc(buf, n)) + "}" : "{\"status\":\"ok\",\"bytesWritten\":" + n + "}";
            }
            if (op.equals("transfer")) {
                boolean in = "in".equals(o.optString("direction", "in"));
                UsbEndpoint ep = endpoint(id, d, o.getInt("endpoint"), in);
                if (ep == null) return err("no " + (in ? "in" : "out") + " endpoint " + o.getInt("endpoint") + " on a claimed interface");
                if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_ISOC) return err("isochronous transfers are not supported");
                byte[] buf = in ? new byte[Math.max(1, o.optInt("length", ep.getMaxPacketSize()))] : b64(o.optString("data", ""));
                int n = c.bulkTransfer(ep, buf, buf.length, timeout);
                if (n < 0) return "{\"status\":\"stall\",\"error\":\"the transfer failed or timed out\"}";
                return in ? "{\"status\":\"ok\",\"data\":" + World.json(enc(buf, n)) + "}" : "{\"status\":\"ok\",\"bytesWritten\":" + n + "}";
            }
            return err("unknown usb action " + op);
        } catch (Throwable e) { return err(op + ": " + e.getMessage()); }
    }

    private static byte[] b64(String s) { return s.length() == 0 ? new byte[0] : Base64.decode(s, Base64.NO_WRAP); }
    private static String enc(byte[] b, int n) { byte[] c = new byte[n]; System.arraycopy(b, 0, c, 0, n); return Base64.encodeToString(c, Base64.NO_WRAP); }

    private UsbDevice find(UsbManager m, String id) {
        HashMap<String, UsbDevice> all = m.getDeviceList();
        if (all == null) return null;
        UsbDevice d = all.get(id);
        if (d != null) return d;
        for (UsbDevice x : all.values()) {   // "vendor:product" in hex also names a device
            String vp = String.format("%04x:%04x", x.getVendorId(), x.getProductId());
            if (vp.equalsIgnoreCase(id)) return x;
        }
        return null;
    }

    private static UsbInterface iface(UsbDevice d, int number, int alt) {
        for (int i = 0; i < d.getInterfaceCount(); i++) { UsbInterface f = d.getInterface(i); if (f.getId() == number && f.getAlternateSetting() == alt) return f; }
        return null;
    }

    private UsbEndpoint endpoint(String id, UsbDevice d, int number, boolean in) {
        Map<Integer, UsbInterface> cl = claimed.get(id);
        for (UsbInterface f : cl.values())
            for (int e = 0; e < f.getEndpointCount(); e++) {
                UsbEndpoint ep = f.getEndpoint(e);
                if (ep.getEndpointNumber() == number && (ep.getDirection() == UsbConstants.USB_DIR_IN) == in) return ep;
            }
        return null;
    }

    private void close(String id) {
        UsbDeviceConnection c = open.remove(id);
        Map<Integer, UsbInterface> cl = claimed.remove(id);
        if (c != null) {
            if (cl != null) for (UsbInterface f : cl.values()) { try { c.releaseInterface(f); } catch (Throwable ignored) {} }
            try { c.close(); } catch (Throwable ignored) {}
        }
    }

    void destroy() { for (String id : new java.util.ArrayList<>(open.keySet())) close(id); }

    private String list(UsbManager m) throws Exception {
        JSONArray out = new JSONArray();
        HashMap<String, UsbDevice> all = m.getDeviceList();
        if (all != null) for (UsbDevice d : all.values()) {
            JSONObject o = new JSONObject();
            boolean perm = m.hasPermission(d);
            o.put("id", d.getDeviceName()).put("vendorId", d.getVendorId()).put("productId", d.getProductId())
                .put("deviceClass", d.getDeviceClass()).put("deviceSubclass", d.getDeviceSubclass()).put("deviceProtocol", d.getDeviceProtocol())
                .put("permission", perm).put("opened", open.containsKey(d.getDeviceName()));
            if (Build.VERSION.SDK_INT >= 21) { o.put("manufacturerName", s(d.getManufacturerName())).put("productName", s(d.getProductName())); }
            if (Build.VERSION.SDK_INT >= 23) o.put("version", s(d.getVersion()));
            if (perm && Build.VERSION.SDK_INT >= 21) { try { o.put("serialNumber", s(d.getSerialNumber())); } catch (Throwable ignored) {} }
            JSONArray its = new JSONArray();
            for (int i = 0; i < d.getInterfaceCount(); i++) {
                UsbInterface f = d.getInterface(i);
                JSONObject fi = new JSONObject().put("number", f.getId()).put("alternate", f.getAlternateSetting())
                    .put("interfaceClass", f.getInterfaceClass()).put("interfaceSubclass", f.getInterfaceSubclass()).put("interfaceProtocol", f.getInterfaceProtocol())
                    .put("name", Build.VERSION.SDK_INT >= 21 ? s(f.getName()) : "");
                Map<Integer, UsbInterface> cl = claimed.get(d.getDeviceName());
                fi.put("claimed", cl != null && cl.containsKey(f.getId()));
                JSONArray eps = new JSONArray();
                for (int e = 0; e < f.getEndpointCount(); e++) {
                    UsbEndpoint ep = f.getEndpoint(e);
                    int t = ep.getType();
                    eps.put(new JSONObject().put("number", ep.getEndpointNumber()).put("direction", ep.getDirection() == UsbConstants.USB_DIR_IN ? "in" : "out")
                        .put("type", t == UsbConstants.USB_ENDPOINT_XFER_BULK ? "bulk" : t == UsbConstants.USB_ENDPOINT_XFER_INT ? "interrupt" : t == UsbConstants.USB_ENDPOINT_XFER_ISOC ? "isochronous" : "control")
                        .put("packetSize", ep.getMaxPacketSize()));
                }
                its.put(fi.put("endpoints", eps));
            }
            out.put(o.put("interfaces", its));
        }
        return out.toString();
    }

    private static String s(String x) { return x == null ? "" : x; }

    /** Ask Android for permission to use the device (a system dialog) and wait for the answer. */
    private String permission(UsbManager m, UsbDevice d, int seconds) throws Exception {
        if (m.hasPermission(d)) return "{\"granted\":true}";
        final String action = a.getPackageName() + ACTION;
        final boolean[] granted = { false };
        final CountDownLatch done = new CountDownLatch(1);
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { granted[0] = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false); done.countDown(); }
        };
        if (Build.VERSION.SDK_INT >= 33) a.registerReceiver(r, new IntentFilter(action), Context.RECEIVER_NOT_EXPORTED);
        else a.registerReceiver(r, new IntentFilter(action));
        try {
            Intent i = new Intent(action).setPackage(a.getPackageName());
            // the system fills in the device and the answer, so the intent must be mutable (and explicit, for Android 14)
            PendingIntent pi = PendingIntent.getBroadcast(a, 0, i, Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            m.requestPermission(d, pi);
            if (!done.await(Math.max(5, seconds), TimeUnit.SECONDS)) return "{\"granted\":false,\"error\":\"no answer from the permission dialog\"}";
            return "{\"granted\":" + granted[0] + "}";
        } finally { try { a.unregisterReceiver(r); } catch (Throwable ignored) {} }
    }
}
