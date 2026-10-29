package android.hardware.usb;
public class UsbDevice {
  public String getDeviceName() { throw new RuntimeException(); }
  public int getDeviceId() { throw new RuntimeException(); }
  public int getVendorId() { throw new RuntimeException(); }
  public int getProductId() { throw new RuntimeException(); }
  public int getDeviceClass() { throw new RuntimeException(); }
  public int getDeviceSubclass() { throw new RuntimeException(); }
  public int getDeviceProtocol() { throw new RuntimeException(); }
  public String getManufacturerName() { throw new RuntimeException(); }
  public String getProductName() { throw new RuntimeException(); }
  public String getSerialNumber() { throw new RuntimeException(); }
  public String getVersion() { throw new RuntimeException(); }
  public int getConfigurationCount() { throw new RuntimeException(); }
  public UsbConfiguration getConfiguration(int i) { throw new RuntimeException(); }
  public int getInterfaceCount() { throw new RuntimeException(); }
  public UsbInterface getInterface(int i) { throw new RuntimeException(); }
}
