// Jade's senses: sensors, battery, Wi-Fi, location, camera, microphone, look (vault images), LiteRT.js,
// hands-free voice, and the vision / speech-to-text side models — against a fake Android shell and a fake Ollama.
import path from 'node:path';
import fs from 'node:fs';
process.env.JV_ARGS = '--allow-file-access-from-files --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required';
const { start } = await import('./_harness.mjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { page, ctx, ok, write, model, done } = await start();
await ctx.grantPermissions(['camera', 'microphone', 'geolocation']); await ctx.setGeolocation({ latitude: 40.7128, longitude: -74.006, accuracy: 12 });
const E = (fn, arg) => page.evaluate(fn, arg);
const T = (name, args) => E(([n, a]) => worldTool(n, a).then(r => r, e => 'ERR ' + e.message), [name, args]);
const J = async (name, args) => { const r = await T(name, args); try { return JSON.parse(r); } catch { return r; } };

// ---- a fake Android shell with sensors, battery, Wi-Fi and a speech recognizer ----
await E((assets) => {
  window.__JADE_ASSETS = assets; window.__sensor = { on: {}, n: 0 }; window.__torch = []; window.__vib = []; window.__stt = [];
  const sensors = [{ key: 'accelerometer', name: 'Acc', vendor: 'X', range: 39, resolution: 0.01, minDelayUs: 5000, type: 1 }, { key: 'magnetic_field', name: 'Mag', vendor: 'X', range: 4912, resolution: 0.1, minDelayUs: 10000, type: 2 }, { key: 'step_counter', name: 'Steps', vendor: 'X', range: 1e6, resolution: 1, minDelayUs: 0, type: 19 }];
  Object.assign(window.NetrunnerAndroid, {
    permStatus: csv => JSON.stringify(Object.fromEntries(csv.split(',').map(p => [p, true]))), requestPerms() {},
    sensorList: () => JSON.stringify(sensors), sensorStart(k) { window.__sensor.on[k] = true; return '{"ok":true}'; }, sensorStop(k) { delete window.__sensor.on[k]; return '{"ok":true}'; },
    sensorRead(k) { const n = ++window.__sensor.n; return JSON.stringify({ t: Date.now(), accuracy: 3, values: k === 'magnetic_field' ? [20 + n % 3, -5, 40] : [0.1 * n, 9.8, 0] }); },
    battery: () => '{"percent":77,"status":"charging","power":"usb","temperatureC":29.5,"millivolts":4100}', wifi: () => '{"enabled":true,"connected":true,"ssid":"Home","bssid":"aa:bb","rssi":-58,"linkMbps":433,"frequencyMHz":5180}',
    torch(on) { window.__torch.push(on); return window.__torchFail ? '{"error":"flashlight: busy"}' : JSON.stringify({ ok: true, on }); }, vibrate(csv) { window.__vib.push(csv); return csv === '' ? '{"ok":true,"stopped":true}' : JSON.stringify({ ok: true, ms: csv.split(',').reduce((x, y) => x + +y, 0) }); },
    sttAvailable: () => true, sttStart(lang, partial, offline) { window.__stt.push({ lang, partial, offline }); }, sttStop() {},
  });
}, 'file://' + path.join(ROOT, 'android/proj/assets') + '/');
await E(() => { S.sensesOn = true; });

// ---- tools are offered ----
ok(await E(() => ['senses', 'look', 'litert'].every(n => activeTools().some(t => t.function.name === n))), 'senses, look and litert are in Jade\'s tool list');
ok(await E(() => /senses:.*look:.*litert:/s.test(systemPrompt())), 'the system prompt mentions the new tools');
await E(() => { S.sensesOn = false; });
ok(await E(() => !activeTools().some(t => t.function.name === 'senses') && activeTools().some(t => t.function.name === 'look')), 'turning senses off hides the senses tool');
ok(/turned off/.test(await T('senses', { action: 'battery' })), '…and refuses to read them');
await E(() => { S.sensesOn = true; });

// ---- sensors, battery, wifi, device, location ----
const list = await J('senses', { action: 'list' });
ok(list.android.length === 3 && list.android[1].key === 'magnetic_field' && list.other.includes('camera_snap'), 'list shows every Android sensor');
const mag = await J('senses', { action: 'read', sensor: 'magnetic_field', seconds: 0.6, hz: 20 });
ok(mag.samples >= 6 && mag.axes.length === 3 && mag.axes[2].mean === 40 && mag.axes[0].min >= 20, `EMF (magnetic field) is sampled with stats: ${JSON.stringify(mag.axes?.[0])}`);
ok(await E(() => Object.keys(window.__sensor.on).length === 0), 'the sensor is switched off again after reading');
const raw = await J('senses', { action: 'read', sensor: 'accelerometer', seconds: 0.3, raw: true }); ok(raw.values?.length > 0, 'raw samples on request');
ok(/no sensor called "nope"/.test(await T('senses', { action: 'read', sensor: 'nope' })), 'an unknown sensor says what exists');
const bat = await J('senses', { action: 'battery' }); ok(bat.percent === 77 && bat.power === 'usb', 'battery');
const wf = await J('senses', { action: 'wifi' }); ok(wf.rssi === -58 && wf.signalQuality === 'good' && wf.linkMbps === 433, 'Wi-Fi signal strength and quality');
const dev = await J('senses', { action: 'device' }); ok(dev.screen.width > 0 && dev.timezone && dev.android === true, 'device facts');
// ---- flashlight and vibration ----
let tr = await J('senses', { action: 'torch' }); ok(tr.ok && tr.on === true && (await E(() => __torch.at(-1))) === true, 'the flashlight turns on');
tr = await J('senses', { action: 'torch', on: false }); ok(tr.ok && tr.on === false && (await E(() => __torch.at(-1))) === false, '…and off');
tr = await J('senses', { action: 'torch', seconds: 1 }); ok(tr.offAfterSeconds === 1 && (await E(() => __torch.at(-1))) === true, 'torch with seconds says when it will switch itself off');
await page.waitForTimeout(1300); ok(await E(() => __torch.at(-1)) === false, '…and does');
await E(() => { __torch.length = 0; });
tr = await J('senses', { action: 'torch', blink: 3, ms: 80 }); ok(tr.blinked === 3 && (await E(() => __torch.join())) === 'true,false,true,false,true,false', 'blink flashes it three times and leaves it off');
await E(() => { __torchFail = true; }); ok(/busy/.test(await T('senses', { action: 'torch' })), 'a torch error is reported to Jade'); await E(() => { __torchFail = false; });
let vb = await J('senses', { action: 'vibrate' }); ok(vb.ok && vb.ms === 400 && (await E(() => __vib.at(-1))) === '400', 'vibrate buzzes 400 ms by default');
vb = await J('senses', { action: 'vibrate', pattern: [100, 50, 100, 50, 300] }); ok(vb.ms === 600 && (await E(() => __vib.at(-1))) === '100,50,100,50,300', 'vibrate takes an on/off pattern');
ok(/limited to 30 seconds/.test(await T('senses', { action: 'vibrate', pattern: [20000, 100, 20000] })), 'vibration is capped at 30 seconds');
vb = await J('senses', { action: 'vibrate', stop: true }); ok(vb.stopped && (await E(() => __vib.at(-1))) === '', 'vibrate can be cancelled');
ok(await E(() => /torch.*vibrate/s.test(WORLD_TOOL_DEFS[0].description) && WORLD_TOOL_DEFS[0].parameters.properties.action.enum.includes('torch') && /flashlight/.test(systemPrompt())), 'the tool description and system prompt mention them');
const loc = await J('senses', { action: 'location' }); ok(Math.abs(loc.latitude - 40.7128) < 1e-4 && loc.accuracyM === 12, 'location (GPS)');

// ---- camera and microphone (fake devices) ----
const snap = await J('senses', { action: 'camera_snap' });
ok(snap.saved?.startsWith('/attachments/camera/photo-') && snap.shown && snap.width > 0, `camera_snap saves a photo: ${snap.saved}`);
ok(await E(p => vfs.isFile(p) && vfs.nodes.get(p).data.length > 1000, snap.saved), '…it is a real JPEG in the vault');
ok(await E(() => window.__viewQ.length === 1), '…and it is queued to be shown to the model');
const fv = await E(() => worldFlushViews());
ok(fv && fv.role === 'user' && fv.images.length === 1 && fv.images[0].length > 1000 && /camera/.test(fv.content) && fv._look, 'the queue becomes one user message with the image');
ok(await E(() => worldFlushViews() === null), '…and the queue is empty afterwards');
const watch = await J('senses', { action: 'camera_watch', seconds: 2, every: 1, frames: 3, look: false });
ok(watch.frames?.length === 3 && !watch.shown && await E(() => window.__viewQ.length === 0), 'camera_watch takes frames over time (not shown when look:false)');
const lvl = await J('senses', { action: 'mic_level', seconds: 1 }); ok(typeof lvl.averageDbFS === 'number' && lvl.loudness, `mic level: ${JSON.stringify(lvl)}`);
const rec = await J('senses', { action: 'mic_record', seconds: 1 }); ok(rec.saved?.startsWith('/attachments/audio/') && rec.sizeKB > 0, 'mic_record saves audio');
const clip = await J('senses', { action: 'camera_clip', seconds: 1 }); ok(clip.saved?.startsWith('/attachments/camera/clip-') && clip.sizeKB > 0, 'camera_clip saves a video');

// ---- look: vault images, folders and videos ----
await E(async () => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d'); g.fillStyle = '#e33'; g.fillRect(0, 0, 600, 400); g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText('JADE', 200, 220);
  const b = await new Promise(r => c.toBlob(r, 'image/png')); vfs.write('/pics/red.png', new Uint8Array(await b.arrayBuffer()), { mkdirs: true });
  vfs.write('/pics/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0a0"/></svg>', { mkdirs: true }); });
let lk = await J('look', { path: '/pics/red.png' }); ok(lk.shown === 1 && lk.items[0].size === '600x400', 'look opens a vault image');
let fl = await E(() => worldFlushViews()); ok(fl?.images.length === 1 && /red\.png/.test(fl.display), 'the image reaches the next message');
lk = await J('look', { path: 'red.png' }); ok(lk.shown === 1, 'a bare file name is found anywhere in the vault'); await E(() => worldFlushViews());
lk = await J('look', { paths: ['/pics/logo.svg', '/pics/red.png'] }); ok(lk.shown === 2, 'several images (SVG too) in one call'); await E(() => worldFlushViews());
lk = await J('look', { path: '/pics' }); ok(lk.shown === 0 && lk.items[0].images.length === 2, 'a folder lists its images without showing them');
ok(/not in the vault/.test((await J('look', { path: '/nope.png' })).errors?.[0] || ''), 'a missing file is reported');
lk = await J('look', { path: clip.saved }); ok(lk.shown === 3 && lk.items[0].framesAtS.length === 3, `look samples frames of a video: ${JSON.stringify(lk.items?.[0] || lk)}`); await E(() => worldFlushViews());

// ---- the agent loop: a look call puts the picture in front of the model ----
await write('/Look/cat.png', 'x'); await E(async () => { vfs.write('/Look/cat.png', vfs.nodes.get('/pics/red.png').data, { mkdirs: true }); });
let turn = 0; model.chatReply = (msgs) => { turn++; if (turn === 1) return { content: '', tool_calls: [{ function: { name: 'look', arguments: { path: '/Look/cat.png' } } }] }; return { content: 'I see a red square.' }; };
await E(() => { newSession(); }); await E(() => send('what is in my cat picture?')); await page.waitForFunction(() => !running, null, { timeout: 30000 });
const second = model.chats.at(-1); const lastUser = [...second].reverse().find(m => m.role === 'user');
ok(model.chats.length >= 2 && lastUser?.images?.length === 1 && /Images you asked to see/.test(lastUser.content), 'after the look tool the model\'s next request carries the image');
ok(await E(() => cur.messages.some(m => m._look && m.images?.length === 1) && cur.messages.filter(m => m.role === 'tool').length === 1), 'tool results stay contiguous; the image comes as its own message after them');

// ---- vision side model: describes pictures for a chat model that cannot see ----
const sideSeen = [];
await page.route('http://vision.test/**', async route => { const req = route.request(); const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }; if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const b = JSON.parse(req.postData() || '{}'); sideSeen.push(b); return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A solid red rectangle with the word JADE in white.' } }] }) }); });
await E(() => { Object.assign(S, { visProv: 'llamacpp', visModel: 'llava:7b', lcppHost: 'http://vision.test' }); });
turn = 99; model.chatReply = (msgs) => ({ content: 'ok' }); const before = model.chats.length;
await E(() => { newSession(); }); await E(async () => { const m = composeUserMessage('what colour is this?', ''); m.images = [btoa('imgbytes')]; cur.messages.push(m); });
await E(() => visionPrepass());
ok(sideSeen.length === 1 && sideSeen[0].model === 'llava:7b' && sideSeen[0].messages[0].content.some(p => p.type === 'image_url') && /what colour is this/.test(sideSeen[0].messages[0].content[0].text), 'the vision model gets the image plus what the user asked');
const api1 = await E(() => buildApiMessages().filter(m => m.role === 'user').pop());
ok(!api1.images && /described by a vision model: A solid red rectangle/.test(api1.content), 'the chat model gets the description instead of the image');
await E(() => visionPrepass()); ok(sideSeen.length === 1, 'each picture is described once (cached in the chat)');
await E(() => { S.visProv = ''; S.visModel = ''; });
ok(await E(() => { const m = buildApiMessages().filter(m => m.role === 'user').pop(); return m.images?.length === 1; }), 'with no vision model picked the chat model sees the picture itself');

// ---- speech to text via a transcription model ----
const tx = []; await page.route('http://stt.test/**', async route => { const req = route.request(); const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }; if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const u = req.url(); tx.push(u); if (u.endsWith('/audio/transcriptions')) return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ text: 'turn on the lights' }) });
  return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' }); });
await E(() => { Object.assign(S, { sttProv: 'openai', sttModel: 'whisper-1', oaiHost: 'http://stt.test/v1', oaiKey: 'k', voiceLang: 'en-US' }); });
const wav = await E(() => Array.from(wavFromFloat(Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 5) * 0.3), 16000).slice(0, 12)).join(','));
ok(wav.startsWith('82,73,70,70'), 'WAV encoder writes a RIFF header');
ok(await E(() => transcribeWav(wavFromFloat(new Float32Array(1600), 16000))) === 'turn on the lights' && tx[0] === 'http://stt.test/v1/audio/transcriptions', 'transcription goes to /audio/transcriptions on the chosen provider');
const sr = await E(() => resampleTo(Float32Array.from({ length: 48000 }, (_, i) => i), 48000, 16000).length); ok(sr === 16000, 'resampling 48 kHz to 16 kHz');
// fall back to an audio-capable chat model
await page.unroute('http://stt.test/**'); const chats = [];
await page.route('http://stt.test/**', async route => { const req = route.request(); const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }; if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (req.url().endsWith('/audio/transcriptions')) return route.fulfill({ status: 404, headers: CORS, body: '{}' });
  chats.push(JSON.parse(req.postData())); return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: ' open the door ' } }] }) }); });
ok(await E(() => transcribeWav(wavFromFloat(new Float32Array(1600), 16000))) === 'open the door' && chats[0].messages[0].content[1].type === 'input_audio', 'if there is no /audio/transcriptions it asks an audio-capable chat model');

// ---- transcribe a vault file (decodes webm/wav in the browser, sends 16 kHz mono) ----
await E(() => { vfs.write('/a/voice.wav', wavFromFloat(Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 7) * 0.4), 16000), { mkdirs: true }); });
const tf = await J('senses', { action: 'transcribe', path: '/a/voice.wav' }); ok(tf.text === 'open the door' && tf.seconds === 0.5, `transcribe a vault audio file: ${JSON.stringify(tf)}`);
await E(() => { Object.assign(S, { sttProv: '', sttModel: '' }); }); ok(/pick a transcription model/.test(await T('senses', { action: 'transcribe', path: '/a/voice.wav' })), 'without a transcription model it says how to set one');

// ---- hands-free voice with the phone's recognizer ----
await E(() => { S.jadeVoice = true; });
turn = 99; model.chatReply = (msgs, userText) => ({ content: 'You said: ' + userText });
await E(() => { newSession(); });
await E(() => hfStart()); ok(await E(() => HF.on), 'hands-free starts');
await page.waitForFunction(() => window.__stt.length >= 1, null, { timeout: 8000 }); ok(true, 'it starts the Android recognizer after the quiet period');
await E(() => window.__jadeSTT('ready', '')); await E(() => window.__jadeSTT('partial', 'what time')); ok(await E(() => document.querySelector('#input').value === 'what time'), 'partial results show as live captions');
await E(() => window.__jadeSTT('final', 'what time is it'));
await page.waitForFunction(() => cur.messages.some(m => m.role === 'assistant' && /You said: what time is it/.test(m.content || '')), null, { timeout: 30000 }); ok(true, 'a final result is sent to Jade and answered');
await page.waitForFunction(() => window.__stt.length >= 2, null, { timeout: 15000 }); ok(true, 'then it listens again');
const n0 = await E(() => window.__stt.length); await E(() => window.__jadeSTT('error', '7')); await page.waitForFunction(n => window.__stt.length > n, n0, { timeout: 8000 }); ok(true, 'a "no match" error just listens again');
await E(() => hfStop()); ok(await E(() => !HF.on && document.querySelector('#btnTalk').textContent === 'Talk'), 'hands-free stops');
await E(() => { window.__jadeSTT = null; });

// ---- hands-free companion screen: only her avatar on her background ----
await E(() => { window.__hfSoloForce = true; S.hfSolo = true; S.wakeWords = ''; });
await E(() => hfStart());
const solo = await E(() => { const st = document.getElementById('jadeStage'), r = st.getBoundingClientRect(), vis = el => el && getComputedStyle(el).display !== 'none'; return { cls: document.body.classList.contains('hf-solo'), parentBody: st.parentNode === document.body, full: Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight, ctrls: vis(st.querySelector('.jade-ctrls')), label: vis(st.querySelector('.jade-label')), bubble: vis(st.querySelector('.jade-bubble')), exit: vis(document.getElementById('hfExit')), z: +getComputedStyle(st).zIndex }; });
ok(solo.cls && solo.parentBody && solo.full, 'hands-free puts her stage full screen: ' + JSON.stringify(solo));
ok(!solo.ctrls && !solo.label && solo.exit, 'only the avatar, her captions and a small exit button are left on it');
const cap = await E(() => { jadeBubble('Hey choom, the alarm is set for seven.'); const b = document.getElementById('jadeBubble'), r = b.getBoundingClientRect(); return { vis: getComputedStyle(b).display !== 'none' && r.height > 0, low: r.top > innerHeight / 2 && r.bottom <= innerHeight, wide: r.width > innerWidth * 0.8, fs: parseFloat(getComputedStyle(b).fontSize), txt: b.textContent, top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#jadeBubble') !== null }; });
ok(cap.vis && cap.low && cap.wide && cap.fs >= 14 && cap.top && /alarm is set/.test(cap.txt), 'her text is shown over the avatar at the bottom: ' + JSON.stringify(cap));
await page.screenshot({ path: 'hf_solo_caption.png' });
ok(await E(() => { jadeBubble(''); return getComputedStyle(document.getElementById('jadeBubble')).display === 'none'; }), '...and goes away when there is nothing to say');
ok(await E(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('#jadeStage') !== null && document.elementFromPoint(20, 20).closest('#jadeStage') !== null), 'the stage covers the header, chat and composer');
await E(() => document.getElementById('hfExit').click());
ok(await E(() => !HF.on && !document.body.classList.contains('hf-solo') && !HFS.on && document.getElementById('jadeStage').parentNode.closest('[data-panel=chat]') !== null), 'the exit button stops hands-free and puts the stage back in the chat');
await E(() => hfStart()); ok(await E(() => window.__androidBack() === true && !HF.on && !document.body.classList.contains('hf-solo')), 'the Android Back button leaves it');
await E(() => { document.getElementById('app').classList.add('jade-hidden'); }); await E(() => hfStart());
ok(await E(() => { const r = document.getElementById('jadeStage').getBoundingClientRect(); return r.width > 100 && r.height > 100; }), 'it shows even when she was hidden in the chat'); await E(() => hfStop());
ok(await E(() => document.getElementById('app').classList.contains('jade-hidden')), '...and she is hidden again afterwards'); await E(() => { document.getElementById('app').classList.remove('jade-hidden'); });
await E(() => { S.hfSolo = false; }); await E(() => hfStart()); ok(await E(() => !document.body.classList.contains('hf-solo')), 'with the setting off the normal screen stays'); await E(() => hfStop());
await E(() => { S.hfSolo = true; window.__hfSoloForce = false; });

// ---- wake phrase ----
await E(() => { S.wakeWords = 'hey jade, hey choom'; });
const wp = t => E(x => wakeParse(x), t);
let w = await wp('Hey Jade, what time is it?'); ok(w.heard && w.command === 'what time is it?', 'the phrase is found and the rest is the command: ' + JSON.stringify(w));
w = await wp('hay jade turn on the light'); ok(w.heard && w.command === 'turn on the light', '"hay" is accepted for "hey"');
w = await wp('Hey choom flash the light'); ok(w.heard && w.command === 'flash the light', 'a second phrase works');
w = await wp('hey chum are you there'); ok(w.heard && w.command === 'are you there', 'a near miss of a long-enough word is accepted ("chum" for "choom")');
w = await wp('they made a plan'); ok(!w.heard, 'ordinary speech does not wake her');
w = await wp('hey jake what time is it'); ok(!w.heard, 'a short name that is a different word does not wake her (jake is not jade)');
w = await wp('hey jade'); ok(w.heard && w.command === '', 'just the phrase has no command');
await E(() => { S.wakeWords = ''; }); ok((await wp('hey jade')) === null, 'with no phrases set she always listens');
await E(() => { S.wakeWords = 'hey jade, hey choom'; HF.awakeUntil = 0; HF.lastBusy = 0; newSession(); });
await E(() => hfStart());
await page.waitForFunction(() => window.__stt.length >= 1, null, { timeout: 8000 });
const say = async t => { await page.waitForFunction(() => typeof window.__jadeSTT === 'function', null, { timeout: 10000 }); await E(x => window.__jadeSTT('final', x), t); };
const msgs = () => E(() => cur.messages.filter(m => m.role === 'user').map(m => m.content));
await say('what time is it'); await page.waitForTimeout(900);
ok((await msgs()).length === 0, 'without the phrase, speech is ignored');
ok(await E(() => document.querySelector('#input').placeholder.includes('hey jade')), 'the input says which phrase to say');
await say('hey jade'); await page.waitForTimeout(900);
ok((await msgs()).length === 0 && await E(() => HF.awakeUntil > Date.now()), 'just the phrase makes her listen for the next thing you say');
await say('what time is it');
await page.waitForFunction(() => cur.messages.some(m => m.role === 'assistant' && /You said: what time is it/.test(m.content || '')), null, { timeout: 30000 }); ok(true, 'then the next sentence is sent');
await page.waitForFunction(() => window.__stt.length >= 4, null, { timeout: 15000 });
await E(() => { HF.awakeUntil = 0; HF.lastBusy = 0; }); const nB = await E(() => window.__stt.length);
await say('Hey choom, say banana');
await page.waitForFunction(() => cur.messages.some(m => m.role === 'assistant' && /You said: say banana/.test(m.content || '')), null, { timeout: 30000 }); ok(true, 'phrase and command in one sentence: only the command is sent');
await E(() => hfStop()); await E(() => { window.__jadeSTT = null; S.wakeWords = ''; });
// the Talk button sits next to Voice
ok(await E(() => document.querySelector('#btnVoice').nextElementSibling?.id === 'btnTalk'), 'the Talk button is next to Voice');

// ---- settings ----
await E(() => openSettings()); await page.click('#setTabs [data-tab="app"]').catch(() => {});
ok(await E(() => !!document.querySelector('#senseSection') && document.querySelectorAll('#sVisProv option').length >= 5 && document.querySelectorAll('#sSttProv option').length >= 5), 'Config has Voice & senses with provider pickers');
await E(() => { $('#sVisProv').value = 'cloud'; $('#sVisModel').value = 'gemma3:12b'; $('#sSttProv').value = 'groq'; $('#sSttModel').value = 'whisper-large-v3-turbo'; $('#sVadMs').value = '1200'; $('#sSensesOn').checked = false; $('#btnSave').click(); });
await page.waitForTimeout(300);
ok(await E(() => S.visProv === 'cloud' && S.visModel === 'gemma3:12b' && S.sttProv === 'groq' && S.sttModel === 'whisper-large-v3-turbo' && S.vadMs === 1200 && S.sensesOn === false), 'the settings save');
await E(() => { Object.assign(S, { sensesOn: true, visProv: '', visModel: '', sttProv: '', sttModel: '' }); });

// ---- LiteRT.js ----
const tflite = Array.from(fs.readFileSync(path.join(ROOT, 'tests/fixtures/add.tflite')));
await E(b => { vfs.write('/models/add.tflite', new Uint8Array(b), { mkdirs: true }); }, tflite);
const ld = await J('litert', { action: 'load', model: '/models/add.tflite', id: 'adder' });
ok(ld.id === 'adder' && ld.inputs.length === 2 && ld.outputs.length === 1 && ld.accelerator === 'wasm', `LiteRT loads a .tflite from the vault: ${JSON.stringify(ld).slice(0, 220)}`);
const rn = await J('litert', { action: 'run', id: 'adder', inputs: [{ data: [1, 2, 3, 4] }, { data: [10, 20, 30, 40] }] });
ok(rn.outputs?.[0]?.first?.join() === '11,22,33,44' && rn.outputs[0].top5[0].index === 3, `…and runs it (1,2,3,4 + 10,20,30,40): ${JSON.stringify(rn.outputs?.[0]?.first)}`);
await E(() => vfs.write('/in/b.json', JSON.stringify([[0.5, 0.5, 0.5, 0.5]]), { mkdirs: true }));
const rn2 = await J('litert', { action: 'run', id: 'adder', inputs: [{ data: [[1, 1, 1, 1]], shape: [1, 4] }, { data: '/in/b.json' }] }); ok(rn2.outputs?.[0]?.first?.join() === '1.5,1.5,1.5,1.5', 'inputs can be nested arrays or a vault .json file');
ok((await J('litert', { action: 'status' })).models.length === 1, 'status lists loaded models');
ok(/no loaded model/.test(await T('litert', { action: 'run', id: 'zzz', inputs: [{ data: [1] }] })), 'running an unknown model id explains what is loaded');
ok(/unloaded/.test(await T('litert', { action: 'unload', id: 'adder' })), 'unload');

// ---- pictures as model input (quantized uint8 and float models) ----
const it = await E(async () => {
  const u = await wImageTensor({ image: '/pics/red.png' }, { dtype: 'uint8', shape: new Int32Array([1, 8, 8, 3]) });
  const f = await wImageTensor({ image: '/pics/red.png', layout: 'nchw', fit: 'stretch' }, { dtype: 'float32', shape: new Int32Array([1, 3, 4, 6]) });
  const z = await wImageTensor({ image: '/pics/red.png', norm: 'zero_1', size: [2, 2] }, { dtype: 'float32', shape: new Int32Array([1, -1, -1, 3]) });
  return { u: { t: u.arr.constructor.name, shape: u.shape, r: u.arr[0], g: u.arr[1], len: u.arr.length }, f: { t: f.arr.constructor.name, shape: f.shape, r: +f.arr[0].toFixed(2), g: +f.arr[24].toFixed(2), len: f.arr.length }, z: { shape: z.shape, r: +z.arr[0].toFixed(2) } };
});
ok(it.u.t === 'Uint8Array' && it.u.shape.join() === '1,8,8,3' && it.u.r > 200 && it.u.g < 90 && it.u.len === 192, 'a uint8 (quantized) model gets raw 0-255 pixels, resized from the model\'s input shape: ' + JSON.stringify(it.u));
ok(it.f.t === 'Float32Array' && it.f.shape.join() === '1,3,4,6' && it.f.r > 0.5 && it.f.g < -0.4, 'a float model with NCHW layout gets planes scaled to -1..1: ' + JSON.stringify(it.f));
ok(it.z.shape.join() === '1,2,2,3' && it.z.r > 0.8, 'flexible input size comes from size:[h,w]; norm zero_1 scales to 0..1');
ok(/flexible input size/.test(await E(() => wImageTensor({ image: '/pics/red.png' }, { dtype: 'float32', shape: new Int32Array([1, -1, -1, 3]) }).then(() => 'no error', e => e.message))), 'a model with no fixed size asks for size');
ok(await E(async () => { const t = await wTensorData({ data: [1.4, 300, -5] }, { dtype: 'uint8', shape: new Int32Array([3]) }); return t.arr.constructor.name === 'Uint8Array' && t.arr.join() === '1,255,0'; }), 'numbers for a uint8 input are rounded and clamped to 0-255');

// ---- int8 (quantized) models: scale 0.5, zero point -3 on every tensor ----
const t8 = Array.from(fs.readFileSync(path.join(ROOT, 'tests/fixtures/add_int8.tflite')));
await E(b => { vfs.write('/models/add_int8.tflite', new Uint8Array(b), { mkdirs: true }); }, t8);
const q8 = await E(b => tfliteQuant(new Uint8Array(b)), t8); ok(q8.inputs.length === 2 && q8.inputs[0].scale === 0.5 && q8.inputs[0].zeroPoint === -3 && q8.outputs[0].scale === 0.5, 'quantization is read from the .tflite file: ' + JSON.stringify(q8.outputs));
const l8 = await J('litert', { action: 'load', model: '/models/add_int8.tflite', id: 'q8' });
ok(l8.inputs?.[0]?.dtype === 'int8' && l8.inputs[0].quantization.scale === 0.5, `an INT8 model loads (it used to fail with "Element type INT8 is not supported"): ${JSON.stringify(l8.inputs?.[0])}`);
const r8 = await J('litert', { action: 'run', id: 'q8', inputs: [{ data: [1, 2, 3, 4] }, { data: [10, 20, 30, 40] }] });
// raw ints 1+10 = 11 (the model adds in real space: (q-zp)*s sums, requantized with the same params => q_out = qa + qb + zp)
ok(r8.outputs?.[0]?.dequantized?.scale === 0.5 && r8.outputs[0].count === 4 && r8.outputs[0].first.every(Number.isFinite), `an INT8 model runs, output dequantized: ${JSON.stringify(r8.outputs?.[0]?.first)}`);
const raw8 = await J('litert', { action: 'run', id: 'q8', raw_output: true, inputs: [{ data: [1, 2, 3, 4] }, { data: [10, 20, 30, 40] }] });
const real = r8.outputs[0].first, rawv = raw8.outputs[0].first; ok(rawv.every((q, i) => Math.abs((q + 3) * 0.5 - real[i]) < 1e-6), 'real = (quantized - zero point) x scale');
const rr = await J('litert', { action: 'run', id: 'q8', inputs: [{ data: [2, 4, 6, 8], real: true }, { data: [1, 1, 1, 1], real: true }] }); ok(!rr.error && rr.outputs?.[0], 'real:true quantizes real numbers with the input\'s scale and zero point');

await done();
