package android.hardware.usb;
public class UsbInterface {
  public int getId() { throw new RuntimeException(); }
  public int getAlternateSetting() { throw new RuntimeException(); }
  public String getName() { throw new RuntimeException(); }
  public int getInterfaceClass() { throw new RuntimeException(); }
  public int getInterfaceSubclass() { throw new RuntimeException(); }
  public int getInterfaceProtocol() { throw new RuntimeException(); }
  public int getEndpointCount() { throw new RuntimeException(); }
  public UsbEndpoint getEndpoint(int i) { throw new RuntimeException(); }
}
