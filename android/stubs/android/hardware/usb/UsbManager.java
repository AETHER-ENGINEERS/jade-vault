package android.hardware.usb;
public class UsbManager {
  public static final String ACTION_USB_DEVICE_ATTACHED = "android.hardware.usb.action.USB_DEVICE_ATTACHED";
  public static final String ACTION_USB_DEVICE_DETACHED = "android.hardware.usb.action.USB_DEVICE_DETACHED";
  public static final String EXTRA_DEVICE = "device";
  public static final String EXTRA_PERMISSION_GRANTED = "permission";
  public java.util.HashMap<String, UsbDevice> getDeviceList() { throw new RuntimeException(); }
  public boolean hasPermission(UsbDevice d) { throw new RuntimeException(); }
  public void requestPermission(UsbDevice d, android.app.PendingIntent pi) { throw new RuntimeException(); }
  public UsbDeviceConnection openDevice(UsbDevice d) { throw new RuntimeException(); }
}
