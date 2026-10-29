// TensorFlow.js on WebGPU (Chromium's software WebGPU here; Android's WebView in compatibility mode on phones), and
// the adapter fallback that makes phones work: a plain requestAdapter() that comes back empty is retried in
// compatibility mode, and an adapter that can do full WebGPU is asked for it.
process.env.JV_ARGS = [process.env.JV_ARGS, '--enable-unsafe-webgpu'].filter(Boolean).join(' ');
const { start } = await import('./_harness.mjs');
const { page, ok, sh, done } = await start();
const E = (fn, arg) => page.evaluate(fn, arg);

let r = await sh(`node -e "await tf.ready(); const m = tf.matMul(tf.tensor2d([[1, 2], [3, 4]]), tf.tensor2d([[5], [6]])); console.log(tf.getBackend(), JSON.stringify(await m.array()))"`, 90000);
ok(r.code === 0 && r.out.trim() === 'webgpu [[17],[39]]', 'scripts get TensorFlow.js on WebGPU and it computes: ' + JSON.stringify(r.out.trim() || r.err));

const shim = await E(async () => {
  const calls = []; const dev = [];
  const adapter = { features: new Set(['core-features-and-limits', 'timestamp-query']), requestDevice: async (d) => { dev.push(d); return {}; } };
  const g = { requestAdapter: async (o) => { calls.push(o || null); return o && o.featureLevel === 'compatibility' ? adapter : null; } };
  jvGpuShim(g); jvGpuShim(g);   // twice: wraps once
  const a = await g.requestAdapter(); await a.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const none = await g.requestAdapter({ featureLevel: 'core' });
  return { calls, dev, got: a === adapter, none };
});
ok(shim.got && shim.calls.length === 3 && shim.calls[0] === null && shim.calls[1].featureLevel === 'compatibility', 'an empty plain request is retried in compatibility mode: ' + JSON.stringify(shim.calls));
ok(JSON.stringify(shim.dev[0].requiredFeatures.sort()) === JSON.stringify(['core-features-and-limits', 'timestamp-query']), 'a compatibility adapter that can do full WebGPU is asked for it');
ok(shim.none === null && shim.calls[2].featureLevel === 'core', 'an explicit feature level is left alone');

await E(() => { S.tfBackend = 'webgl'; });
r = await sh(`node -e "await tf.ready(); console.log(tf.getBackend())"`, 90000);
ok(r.code === 0 && ['webgl', 'cpu'].includes(r.out.trim()), 'a script can be kept off WebGPU (S.tfBackend = webgl): ' + r.out.trim());
await E(() => { S.tfBackend = 'auto'; });
await done();
