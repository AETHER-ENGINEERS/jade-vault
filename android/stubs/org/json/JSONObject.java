package org.json;
public class JSONObject {
  public JSONObject() { throw new RuntimeException(); }
  public JSONObject(String s) throws JSONException { throw new RuntimeException(); }
  public String optString(String k, String d) { throw new RuntimeException(); }
  public int optInt(String k, int d) { throw new RuntimeException(); }
  public double optDouble(String k, double d) { throw new RuntimeException(); }
  public boolean optBoolean(String k, boolean d) { throw new RuntimeException(); }
  public boolean has(String k) { throw new RuntimeException(); }
  public JSONArray optJSONArray(String k) { throw new RuntimeException(); }
  public String optString(String k) { throw new RuntimeException(); }
  public int optInt(String k) { throw new RuntimeException(); }
  public boolean optBoolean(String k) { throw new RuntimeException(); }
  public int getInt(String k) throws JSONException { throw new RuntimeException(); }
  public JSONObject put(String k, Object v) throws JSONException { throw new RuntimeException(); }
  public JSONObject put(String k, int v) throws JSONException { throw new RuntimeException(); }
  public JSONObject put(String k, long v) throws JSONException { throw new RuntimeException(); }
  public JSONObject put(String k, boolean v) throws JSONException { throw new RuntimeException(); }
  public JSONObject put(String k, double v) throws JSONException { throw new RuntimeException(); }
}
