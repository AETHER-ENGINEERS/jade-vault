// The phone tool: alarms, ringing, sounds, calls and texts (asked first), permissions, contacts, clipboard, apps…
// against a fake Android shell that records every call it is given.
process.env.JV_ARGS = '--autoplay-policy=no-user-gesture-required';
const { start } = await import('./_harness.mjs');
const { page, ok, write, done } = await start();
const E = (fn, arg) => page.evaluate(fn, arg);
const T = a => E(a2 => phoneTool(a2).then(r => r, e => 'ERR ' + e.message), a);
const J = async a => { const r = await T(a); try { return JSON.parse(r); } catch { return r; } };

await E(() => {
  window.__ph = []; window.__perm = { granted: true, asked: [] }; window.__phoneReply = {};
  const A = window.NetrunnerAndroid;
  A.phone = (op, json) => { window.__ph.push([op, JSON.parse(json)]); const r = window.__phoneReply[op]; return typeof r === 'function' ? r(JSON.parse(json)) : JSON.stringify(r || { ok: true }); };
  A.permStatus = csv => JSON.stringify(Object.fromEntries(csv.split(',').map(p => [p, window.__perm.granted])));
  A.requestPerms = csv => { window.__perm.asked.push(csv); setTimeout(() => window.__jadePerms(Object.fromEntries(csv.split(',').map(p => [p, window.__perm.allow !== false]))), 30); };
  window.__perm.granted = true;
});
const last = () => E(() => window.__ph.at(-1));
// answer the approval card: 'yes' or 'no' as soon as it shows up
const answerCard = which => page.waitForSelector('[role=alertdialog]', { timeout: 5000 }).then(async () => { const text = await E(() => document.querySelector('[role=alertdialog]').innerText); await E(w => document.querySelector('[role=alertdialog] [data-' + w + ']').click(), which); return text; });

ok(await E(() => activeTools().some(t => t.function.name === 'phone') && /phone: alarms/.test(systemPrompt())), 'the phone tool is offered and in the system prompt');
await E(() => { S.sensesOn = false; }); ok(!(await E(() => activeTools().some(t => t.function.name === 'phone'))) && /turned off/.test(await T({ action: 'ring' })), 'senses off hides it and refuses'); await E(() => { S.sensesOn = true; });

// ---- alarms, timers, ring, volume ----
let r = await J({ action: 'alarm_set', hour: 7, minute: 30, label: 'Wake up', days: ['Mon', 'friday'] });
ok(r.ok && (await last())[0] === 'alarm_set' && JSON.stringify((await last())[1].days) === '[2,6]' && (await last())[1].hour === 7, 'alarm_set passes the time and turns day names into Android day numbers');
r = await J({ action: 'timer_set', seconds: 90, label: 'tea' }); ok(r.ok && (await last())[1].seconds === 90, 'timer_set');
await J({ action: 'ring', seconds: 20 }); ok((await last())[0] === 'ring' && (await last())[1].seconds === 20, 'ring'); await J({ action: 'ring_stop' }); ok((await last())[0] === 'ring_stop', 'ring_stop');
await E(() => { __phoneReply.volume = { media: { level: 0.5, index: 7, max: 15 } }; }); r = await J({ action: 'volume', stream: 'media', level: 0.5 }); ok(r.media.max === 15 && (await last())[1].level === 0.5, 'volume');
await E(() => { __phoneReply.alarm_set = a => JSON.stringify({ error: 'hour is 0-23 and minute 0-59' }); }); ok(/ERR hour is 0-23/.test(await T({ action: 'alarm_set', hour: 99 })), 'an error from the phone is reported'); await E(() => { delete __phoneReply.alarm_set; });

// ---- calls and texts: the user is asked first ----
await E(() => { __ph.length = 0; });
let p = T({ action: 'call', number: '+15551234567', name: 'Mum' }); let card = await answerCard('no'); r = await p;
ok(/Jade wants to call/.test(card) && /Mum/.test(card) && /\+15551234567/.test(card), 'a call shows who and what number: ' + card.replace(/\n/g, ' | '));
ok(/The user said no/.test(r) && !(await E(() => __ph.some(x => x[0] === 'call'))), 'saying no means nothing is dialled');
p = T({ action: 'call', number: '+15551234567' }); await answerCard('yes'); r = await p;
ok(!/ERR/.test(r) && (await last())[0] === 'call' && (await last())[1].number === '+15551234567', 'saying yes places the call');
p = T({ action: 'sms_send', to: '555-0100', text: 'Running late, back in 10', name: 'Sam' }); card = await answerCard('yes'); r = await p;
ok(/Running late, back in 10/.test(card) && /Sam/.test(card), 'a text shows the whole message before it goes'); ok((await last())[0] === 'sms_send' && (await last())[1].text === 'Running late, back in 10', 'and then it is sent');
await E(() => { S.askRisky = false; __ph.length = 0; });
r = await T({ action: 'sms_send', to: '555-0100', text: 'no prompt' }); ok(!/ERR/.test(r) && (await last())[0] === 'sms_send' && !(await E(() => !!document.querySelector('[role=alertdialog]'))), 'with asking turned off the text just goes');
await E(() => { S.askRisky = true; });

// ---- permissions ----
await E(() => { __perm.granted = false; __perm.asked.length = 0; __ph.length = 0; });
r = await T({ action: 'sms_read', unread: true, limit: 5 });
ok((await E(() => __perm.asked))[0] === 'android.permission.READ_SMS' && (await last())[0] === 'sms_read', 'a missing Android permission is asked for, then the call goes through');
await E(() => { __perm.allow = false; __ph.length = 0; }); r = await T({ action: 'contacts', query: 'sam' });
ok(/permission was not given: READ_CONTACTS/.test(r) && !(await E(() => __ph.length)), 'if it is refused she is told and nothing runs');
await E(() => { __perm.allow = true; __perm.granted = true; });
await E(() => { __phoneReply.sms_read = [{ from: '+15550001', text: 'hi', date: 1, read: false }]; }); r = await J({ action: 'sms_read', from: '5550001', contains: 'hi' }); ok(r[0].text === 'hi' && (await last())[1].from === '5550001', 'sms_read returns the texts');
await E(() => { __phoneReply.contacts = [{ name: 'Sam', number: '555-0100' }]; }); r = await J({ action: 'contacts', query: 'sam' }); ok(r[0].name === 'Sam', 'contacts');
r = await J({ action: 'answer' }); ok((await last())[0] === 'answer', 'answer'); await J({ action: 'hangup' }); ok((await last())[0] === 'hangup', 'hangup'); await J({ action: 'speaker', on: true }); ok((await last())[1].on === true, 'speaker');
await J({ action: 'call_state' }); ok((await last())[0] === 'call_state', 'call_state'); await J({ action: 'call_log', limit: 3 }); ok((await last())[1].limit === 3, 'call_log');
await J({ action: 'radio' }); ok((await last())[0] === 'radio', 'radio'); await J({ action: 'bluetooth' }); ok((await last())[0] === 'bluetooth', 'bluetooth');
await J({ action: 'clipboard_set', text: 'copied' }); ok((await last())[1].text === 'copied', 'clipboard_set'); await J({ action: 'open_url', url: 'geo:0,0?q=coffee' }); ok((await last())[1].url.startsWith('geo:'), 'open_url');
await J({ action: 'apps', query: 'maps' }); await J({ action: 'app_launch', package: 'com.example' }); ok((await last())[0] === 'app_launch', 'apps and app_launch'); await J({ action: 'brightness', level: 0.3 }); await J({ action: 'keep_awake', on: true }); ok((await last())[0] === 'keep_awake', 'brightness and keep_awake');

// ---- sounds, made in the page ----
r = await J({ action: 'tone', hz: 440, ms: 200, wait: true }); ok(r.ok && r.ms === 200, 'a tone plays and waits for its end');
r = await J({ action: 'tone', pattern: [{ hz: 880, ms: 100 }, { hz: 0, ms: 50 }, { hz: 660, ms: 100 }], wave: 'square' }); ok(r.notes === 3 && r.ms === 250, 'a pattern of tones with a rest');
ok(/limited to 60 seconds/.test(await T({ action: 'tone', pattern: [{ hz: 440, ms: 5000 }].concat(Array(13).fill({ hz: 440, ms: 5000 })) })), 'tones are capped at a minute');
await J({ action: 'sound_stop' });
// a tiny WAV in the vault
await E(() => { const n = 8000 * 0.3, u = new Uint8Array(44 + n * 2), dv = new DataView(u.buffer); const w = (o, s) => [...s].forEach((c, i) => u[o + i] = c.charCodeAt(0)); w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true); for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true); vfs.write('/sounds/ding.wav', u, { mkdirs: true }); });
r = await J({ action: 'sound_play', path: '/sounds/ding.wav', volume: 0.2, wait: true }); ok(r.ok && r.finished === true, 'a vault audio file plays through to the end');
r = await J({ action: 'sound_play', path: '/sounds/ding.wav', loop: true }); ok(r.playing && (await E(() => PH.audio.size)) === 1, 'a looping sound keeps playing');
r = await J({ action: 'sound_stop' }); ok(r.stopped >= 1 && (await E(() => PH.audio.size)) === 0, 'sound_stop stops it');
ok(/not in the vault/.test(await T({ action: 'sound_play', path: '/nope.mp3' })), 'a missing file says so'); ok(/http or https/.test(await T({ action: 'sound_play', url: 'ftp://x/y.mp3' })), 'only http(s) streams');

// ---- Bluetooth, media keys and casting to a TV ----
await E(() => {
  const A = window.NetrunnerAndroid; window.__ca = [];
  A.diskInfo = () => JSON.stringify({ sdk: window.__sdk || 33 });
  A.cast = (id, op, json) => { window.__ca.push([op, JSON.parse(json)]); const r = window.__castReply?.[op]; setTimeout(() => window.__jcast(id, typeof r === 'function' ? r(JSON.parse(json)) : JSON.stringify(r || { ok: true })), 20); };
  window.__castReply = {}; window.__perm.asked.length = 0; window.__perm.granted = false; window.__perm.allow = true; window.__ph.length = 0;
});
await E(() => { PH_SDK = 0; });
await E(() => { __castReply.bt_scan = { found: [{ name: 'Sony WH-1000XM5', address: 'AA:BB:CC:DD:EE:FF', bond: 'not paired', kind: 'audio/video' }] }; });
r = await J({ action: 'bt_scan', seconds: 8 });
ok(r.found[0].name === 'Sony WH-1000XM5' && (await E(() => __ca.at(-1)))[0] === 'bt_scan' && (await E(() => __ca.at(-1)))[1].seconds === 8, 'bt_scan runs through the async bridge and returns what it found');
ok((await E(() => __perm.asked))[0] === 'android.permission.BLUETOOTH_SCAN,android.permission.BLUETOOTH_CONNECT', 'on Android 12+ a scan asks for the nearby-devices permissions: ' + (await E(() => __perm.asked)).join(' | '));
await E(() => { __perm.asked.length = 0; __perm.granted = false; PH_SDK = 0; window.__sdk = 29; }); await J({ action: 'bt_scan' });
ok((await E(() => __perm.asked))[0] === 'android.permission.ACCESS_FINE_LOCATION', 'on older Android it asks for location instead');
await E(() => { window.__sdk = 33; PH_SDK = 0; __perm.granted = true; });
for (const [act, extra] of [['bt_pair', { address: 'AA:BB:CC:DD:EE:FF' }], ['bt_unpair', { name: 'Sony' }], ['bt_connect', { name: 'Sony' }], ['bt_disconnect', { name: 'Sony' }], ['bt_power', { on: false }], ['bt_settings', {}]]) {
  await J({ action: act, ...extra }); const l = await last(); ok(l[0] === act && Object.entries(extra).every(([k, v]) => l[1][k] === v), act + ' reaches the phone with its arguments');
}
await J({ action: 'media', command: 'next' }); ok((await last())[0] === 'media' && (await last())[1].command === 'next', 'media key'); await J({ action: 'now_playing' }); ok((await last())[0] === 'now_playing', 'now_playing');
await E(() => { __castReply.cast_devices = { devices: [{ name: 'Living Room TV', model: 'Chromecast', host: '192.168.1.20' }] }; });
r = await J({ action: 'cast_devices' }); ok(r.devices[0].name === 'Living Room TV', 'cast_devices lists the TVs');
await E(() => { __castReply.cast_play = { host: '192.168.1.20', player: 'PLAYING', title: 'Movie' }; });
r = await J({ action: 'cast_play', url: 'https://example.com/m.mp4', title: 'Movie', device: 'living' });
ok(r.player === 'PLAYING' && (await E(() => __ca.at(-1)))[1].url === 'https://example.com/m.mp4' && (await E(() => __ca.at(-1)))[1].device === 'living', 'cast_play sends the link, title and device');
await J({ action: 'cast_play', path: '/media/clip.mp4' }); ok((await E(() => __ca.at(-1)))[1].path === '/media/clip.mp4', 'cast_play can send a vault file');
ok(/needs url/.test(await T({ action: 'cast_play' })), 'cast_play with nothing to play is refused');
for (const [act, extra] of [['cast_pause', {}], ['cast_resume', {}], ['cast_stop', {}], ['cast_seek', { seconds: 90 }], ['cast_volume', { level: 0.4 }], ['cast_mute', { on: true }], ['cast_status', {}], ['cast_close', {}], ['cast_mirror', {}]]) {
  await J({ action: act, ...extra }); const l = await E(() => __ca.at(-1)); ok(l[0] === act && Object.entries(extra).every(([k, v]) => l[1][k] === v), act);
}
await E(() => { __castReply.cast_pause = () => JSON.stringify({ error: 'nothing is playing on the TV' }); }); ok(/ERR nothing is playing/.test(await T({ action: 'cast_pause' })), 'a TV error is reported to her');
await E(() => { __castReply.cast_devices = () => new Promise(() => {}); });
ok(await E(() => { const d = JSON.stringify(WORLD_TOOL_DEFS.find(t => t.name === 'phone')); return /cast_play/.test(d) && /bt_scan/.test(d) && /cast_mirror/.test(d); }), 'the phone tool description mentions casting and bluetooth');
await E(() => { delete NetrunnerAndroid.cast; }); ok(/newest Android app/.test(await T({ action: 'cast_devices' })), 'an older app without casting says so');

// ---- outside the app ----
await E(() => { delete NetrunnerAndroid.phone; }); ok(/needs the Android app/.test(await T({ action: 'call', number: '5550100' })), 'calls need the app');

await done();
