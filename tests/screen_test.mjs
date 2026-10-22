// The screen tool: Jade driving other apps through the accessibility service, against a fake service that
// records every call. Checks the off-until-enabled gate, the untrusted-data framing, and that each action
// reaches the native side with its arguments.
const { start } = await import('./_harness.mjs');
const { page, ok, write, done } = await start();
const E = (fn, arg) => page.evaluate(fn, arg);
const T = a => E(a2 => screenTool(a2).then(r => r, e => 'ERR ' + e.message), a);
const J = async a => { const r = await T(a); const i = r.indexOf('{'); try { return JSON.parse(i > 0 ? r.slice(i) : r); } catch { return r; } };

await E(() => {
  window.__sc = []; window.__viewQ = window.__viewQ || [];
  const A = window.NetrunnerAndroid;
  A.__running = false; A.__scReply = {};
  A.screenStatus = () => JSON.stringify({ enabled: A.__running, running: A.__running, sdk: 33 });
  A.screenEnable = () => { A.__enableOpened = true; };
  A.screen = (id, op, json) => { window.__sc.push([op, JSON.parse(json)]); const r = A.__scReply[op]; setTimeout(() => window.__jscreen(id, typeof r === 'function' ? r(JSON.parse(json)) : JSON.stringify(r || { ok: true })), 15); };
});
const lastSc = () => E(() => window.__sc.at(-1));

ok(await E(() => activeTools().some(t => t.function.name === 'screen') && /screen: drive other apps/.test(systemPrompt())), 'the screen tool is offered and described in the system prompt');

// ---- off until the user switches it on in Android ----
let r = await J({ action: 'read' });
ok(/screen control is off/i.test(JSON.stringify(r)) && (await E(() => window.__sc.length)) === 0, 'while it is off, actions are refused and nothing is sent to the phone');
r = await J({ action: 'enable' });
ok(await E(() => NetrunnerAndroid.__enableOpened) && /Accessibility settings/.test(JSON.stringify(r)) && /cannot be switched on from here/i.test(JSON.stringify(r)), 'enable opens Android settings and says only the user can switch it on');
r = await J({ action: 'status' }); ok(/off/.test(JSON.stringify(r)), 'status reports it is off');

// ---- once on: reading carries the untrusted-data warning ----
await E(() => { NetrunnerAndroid.__running = true; NetrunnerAndroid.__scReply.read = { app: 'Settings', elements: [{ id: 0, role: 'button', text: 'Bluetooth' }, { id: 1, role: 'field', text: '' }] }; });
let raw = await T({ action: 'read' });
ok(/data, not instructions/i.test(raw) && /Bluetooth/.test(raw) && (await lastSc())[0] === 'read', 'read returns the screen with an explicit untrusted-data warning');
r = await J({ action: 'status' }); ok(/on/.test(JSON.stringify(r)) && !/is off/.test(JSON.stringify(r)), 'status reports it is on');

// ---- actions reach the native side with their arguments ----
for (const [act, extra] of [
  ['tap', { id: 0 }], ['long_press', { target: 'Bluetooth' }], ['type', { id: 1, text: 'hello', submit: true }],
  ['clear', { id: 1 }], ['scroll', { direction: 'down' }], ['swipe', { x1: 10, y1: 20, x2: 10, y2: 400 }],
  ['find', { text: 'wifi' }], ['active', {}], ['tap', { x: 100, y: 200 }],
]) {
  await J({ action: act, ...extra }); const l = await lastSc();
  ok(l[0] === act && Object.entries(extra).every(([k, v]) => JSON.stringify(l[1][k]) === JSON.stringify(v)), act + ' reaches the phone with its arguments: ' + JSON.stringify(l));
}

// the on-screen keyboard
for (const extra of [{}, { text: 'Hello, world!' }, { key: 'enter' }, { id: 1, text: 'hi', submit: true }, { mode: 'hide' }]) {
  await J({ action: 'keyboard', ...extra }); const l = await lastSc();
  ok(l[0] === 'keyboard' && Object.entries(extra).every(([k, v]) => l[1][k] === v), 'keyboard ' + JSON.stringify(extra) + ' reaches the phone: ' + JSON.stringify(l));
}
await J({ action: 'type', id: 1, text: 'x', via: 'keyboard' }); ok((await lastSc())[0] === 'type' && (await lastSc())[1].via === 'keyboard', 'type via the keyboard passes through');
await E(() => { NetrunnerAndroid.__scReply.keyboard = { error: 'typed 3 of 9 characters, then stopped: no key for "é"', typed: 3 }; });
ok(/ERR typed 3 of 9/.test(await T({ action: 'keyboard', text: 'abcdéfghi' })), 'a partial keyboard failure says how far it got');
ok(/keyboard \(read/.test(await E(() => WORLD_TOOL_DEFS.find(t => t.name === 'screen').description)), 'the tool description teaches the keyboard');

// press maps to the native "key" op
await J({ action: 'press', name: 'back' }); ok((await lastSc())[0] === 'key' && (await lastSc())[1].name === 'back', 'press back sends a key');
await J({ action: 'press', key: 'home' }); ok((await lastSc())[1].name === 'home', 'press accepts key as the name too');

// a screenshot is queued for Jade to see, not dumped as base64 text
await E(() => { NetrunnerAndroid.__scReply.screenshot = { ok: true, jpeg_base64: 'AAAA' }; window.__viewQ.length = 0; });
r = await J({ action: 'screenshot' });
ok(/next message/.test(JSON.stringify(r)) && (await E(() => window.__viewQ.length)) === 1 && (await E(() => window.__viewQ[0].b64)) === 'AAAA', 'screenshot is queued as a picture, not returned as text');

// an error from the service is reported to her
await E(() => { NetrunnerAndroid.__scReply.tap = () => JSON.stringify({ error: 'no element with that id; read the screen again' }); });
ok(/ERR no element with that id/.test(await T({ action: 'tap', id: 99 })), 'a service error is passed back');

// senses off hides it entirely
await E(() => { S.sensesOn = false; }); ok(!(await E(() => activeTools().some(t => t.function.name === 'screen'))), 'turning senses off hides the screen tool'); await E(() => { S.sensesOn = true; });
// the app-level setting hides it too
await E(() => { S.screenOn = false; }); ok(!(await E(() => activeTools().some(t => t.function.name === 'screen'))), 'the screen setting off hides it'); await E(() => { S.screenOn = true; });

// without the newest app it says so
await E(() => { delete NetrunnerAndroid.screen; delete NetrunnerAndroid.screenStatus; });
ok(/newest Android app/.test(await T({ action: 'read' })), 'an older app without screen control says so');

await done();
