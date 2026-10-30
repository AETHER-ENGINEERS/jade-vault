package android.hardware.camera2;
public class CameraCharacteristics {
  public static final int LENS_FACING_BACK = 1;
  public static final class Key<T> { }
  public static final Key<Boolean> FLASH_INFO_AVAILABLE = null;
  public static final Key<Integer> LENS_FACING = null;
  public <T> T get(Key<T> key) { throw new RuntimeException(); }
}
