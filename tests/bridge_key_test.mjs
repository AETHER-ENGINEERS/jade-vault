// Bridge key: the Android bridge exists in every frame, so every call must carry the key the main page claimed at load.
// The fake below behaves like MainActivity.Bridge: claim() hands the key out once, other methods refuse a wrong or missing key.
const { start } = await import('./_harness.mjs');
const init = `(() => {
  const base = window.NetrunnerAndroid; const KEY = 'k'.repeat(32); let claimed = false; window.__denied = []; window.__raw = {};
  const raw = { claim() { if (claimed) return ''; claimed = true; return KEY; } };
  for (const [name, fn] of Object.entries(base)) raw[name] = function (t, ...a) { if (t !== KEY) { window.__denied.push(name); return typeof fn() === 'boolean' ? false : '{"error":"denied"}'; } return fn.apply(base, a); };
  window.__raw = raw; window.NetrunnerAndroid = raw;
})();`;
const { page, ctx, ok, done } = await start({ init, settings: { askRisky: false } });
const E = (fn, arg) => page.evaluate(fn, arg);
await page.waitForFunction(() => typeof activeTools === 'function', null, { timeout: 60000 });
ok(await E(() => window.NetrunnerAndroid !== window.__raw && typeof NetrunnerAndroid.notify === 'function'), 'the page replaced the raw bridge with its keyed wrapper');
ok(await E(() => { NetrunnerAndroid.notify('Hello', 'from the page'); return window.__notes.some(n => n[0] === 'Hello' && n[1] === 'from the page'); }), 'calls from the page carry the key, with their arguments intact');
ok(await E(() => NetrunnerAndroid.batteryOptimized() === false && typeof NetrunnerAndroid.keepAlive(true, 'x') === 'boolean'), 'return values come back through the wrapper');
ok(await E(() => typeof NetrunnerAndroid.noSuchMethod === 'undefined' && 'notify' in NetrunnerAndroid && !('noSuchMethod' in NetrunnerAndroid)), 'feature checks still work (missing methods stay missing)');
ok(await E(() => !!window.NetrunnerAndroid), 'detecting the Android app still works');
ok((await E(() => window.__denied)).length === 0, 'nothing from the page itself was refused');
// a frame of another origin gets the raw bridge (Android injects it into every frame) but cannot call it: simulate by calling the raw object directly
const evil = await E(() => { const raw = window.__raw; const out = {}; out.sms = raw.notify('x', 'y'); out.claim = raw.claim(); out.nokey = raw.batteryOptimized(); out.wrong = raw.batteryOptimized('nope'); return { claim: out.claim, nokey: out.nokey, wrong: out.wrong, denied: window.__denied.slice() }; });
ok(evil.claim === '' && evil.nokey === false && evil.denied.includes('notify') && evil.denied.includes('batteryOptimized'), 'an app frame calling the raw bridge: claim gives nothing, calls without the key are refused: ' + JSON.stringify(evil));
ok(await E(() => { NetrunnerAndroid.notify('After', 'attack'); return window.__notes.some(n => n[0] === 'After'); }), 'the page keeps working afterwards');
await done();
