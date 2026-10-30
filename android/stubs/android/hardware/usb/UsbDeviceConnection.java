package android.hardware.usb;
public class UsbDeviceConnection {
  public boolean claimInterface(UsbInterface i, boolean force) { throw new RuntimeException(); }
  public boolean releaseInterface(UsbInterface i) { throw new RuntimeException(); }
  public boolean setInterface(UsbInterface i) { throw new RuntimeException(); }
  public boolean setConfiguration(UsbConfiguration c) { throw new RuntimeException(); }
  public int controlTransfer(int requestType, int request, int value, int index, byte[] buffer, int length, int timeout) { throw new RuntimeException(); }
  public int bulkTransfer(UsbEndpoint ep, byte[] buffer, int length, int timeout) { throw new RuntimeException(); }
  public byte[] getRawDescriptors() { throw new RuntimeException(); }
  public String getSerial() { throw new RuntimeException(); }
  public void close() { throw new RuntimeException(); }
}
