// USB: navigator.usb in the Android app (on top of UsbHost.java, faked here with the same contract), the usb tool,
// and the browser path (real WebUSB needs a person to pick a device: Jade asks with a button).
const FAKE_USB = `(() => {
  const st = window.__usb = { calls: [], perm: false, devices: null, stored: new Uint8Array(0) };
  const dev = (id, vid, pid, name) => ({ id, vendorId: vid, productId: pid, deviceClass: 2, deviceSubclass: 0, deviceProtocol: 0, manufacturerName: 'Arduino (www.arduino.cc)', productName: name, version: '1.10', interfaces: [
    { number: 0, alternate: 0, interfaceClass: 2, interfaceSubclass: 2, interfaceProtocol: 1, name: '', endpoints: [{ number: 2, direction: 'in', type: 'interrupt', packetSize: 8 }] },
    { number: 1, alternate: 0, interfaceClass: 10, interfaceSubclass: 0, interfaceProtocol: 0, name: '', endpoints: [{ number: 4, direction: 'out', type: 'bulk', packetSize: 64 }, { number: 3, direction: 'in', type: 'bulk', packetSize: 64 }] }] });
  st.devices = [dev('/dev/bus/usb/001/002', 0x2341, 0x0043, 'Arduino Uno')];
  const opened = new Set(), claimed = new Set();
  const b64 = u => btoa(String.fromCharCode(...u)); const unb64 = s => Uint8Array.from(atob(s || ''), c => c.charCodeAt(0));
  const answer = (op, a) => {
    const d = st.devices.find(x => x.id === a.device || (x.vendorId.toString(16).padStart(4,'0') + ':' + x.productId.toString(16).padStart(4,'0')) === a.device);
    if (op === 'list') return st.devices.map(x => ({ ...x, permission: st.perm, opened: opened.has(x.id) }));
    if (!d) return { error: 'no USB device ' + a.device + ' (unplugged?)' };
    if (op === 'permission') return { granted: st.grant !== false && (st.perm = true) };
    if (op === 'open') { if (!st.perm) return { error: 'no permission for this device yet: ask for it first' }; opened.add(d.id); return { ok: true }; }
    if (op === 'close') { opened.delete(d.id); claimed.clear(); return { ok: true }; }
    if (!opened.has(d.id)) return { error: 'the device is not open' };
    if (op === 'claim') { claimed.add(a.interface); return { ok: true }; }
    if (op === 'release') { claimed.delete(a.interface); return { ok: true }; }
    if (op === 'select_alt') return { ok: true };
    if (op === 'control') {
      if (a.direction === 'in' && a.requestType === 'standard' && a.request === 6 && a.value === 0x100) { const desc = [18, 1, 0x10, 1, 2, 0, 0, 8, 0x41, 0x23, 0x43, 0, 1, 0, 1, 2, 3, 1]; return { status: 'ok', data: b64(desc.slice(0, a.length)) }; }
      if (a.direction === 'out') return { status: 'ok', bytesWritten: unb64(a.data).length };
      return { status: 'stall', error: 'the control transfer failed or timed out' };
    }
    if (op === 'transfer') {
      if (!claimed.has(1)) return { error: 'no ' + a.direction + ' endpoint ' + a.endpoint + ' on a claimed interface' };
      if (a.direction === 'out' && a.endpoint === 4) { st.stored = unb64(a.data); return { status: 'ok', bytesWritten: st.stored.length }; }
      if (a.direction === 'in' && a.endpoint === 3) { const up = new TextEncoder().encode(new TextDecoder().decode(st.stored).toUpperCase()); return { status: 'ok', data: b64(up.slice(0, a.length)) }; }
      return { error: 'no ' + a.direction + ' endpoint ' + a.endpoint + ' on a claimed interface' };
    }
    return { error: 'unknown usb action ' + op };
  };
  window.NetrunnerAndroid.usb = (id, op, json) => { const a = JSON.parse(json); st.calls.push([op, a]); setTimeout(() => window.__jusb(id, JSON.stringify(answer(op, a))), 5); };
})();`;

const { start } = await import('./_harness.mjs');
const { page, ok, done } = await start({ init: FAKE_USB });
const E = (fn, arg) => page.evaluate(fn, arg);
const T = (args) => E(a => usbTool(a).then(r => r, e => 'ERR ' + e.message), args);

// ---- navigator.usb in the app
ok(await E(() => typeof navigator.usb.requestDevice === 'function' && typeof JadeUSBDevice === 'function' && navigator.usb.requestDevice.toString().includes('usbNativeList')), 'the app provides navigator.usb (the WebView has none that works)');
ok(await E(async () => (await navigator.usb.getDevices()).length === 0), 'no device is allowed before the user agrees');
const req = await E(async () => { const d = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x2341 }] }); return { name: d.productName, vid: d.vendorId, ifs: d.configuration.interfaces.length, ep: d.configuration.interfaces[1].alternate.endpoints.map(e => e.endpointNumber + e.direction + e.type).join(','), perm: __usb.calls.some(c => c[0] === 'permission') }; });
ok(req.name === 'Arduino Uno' && req.vid === 0x2341 && req.ifs === 2 && req.ep === '4outbulk,3inbulk' && req.perm, 'requestDevice asks Android for permission and returns a WebUSB device: ' + JSON.stringify(req));
ok(await E(async () => (await navigator.usb.requestDevice({ filters: [{ vendorId: 0x1234 }] }).then(() => 'found', e => e.name))) === 'NotFoundError', 'a filter that matches nothing is NotFoundError, as in WebUSB');
const io = await E(async () => {
  const [d] = await navigator.usb.getDevices(); await d.open(); await d.selectConfiguration(1); await d.claimInterface(1);
  const desc = await d.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x100, index: 0 }, 18);
  const w = await d.transferOut(4, new TextEncoder().encode('hello jade'));
  const r = await d.transferIn(3, 64);
  return { opened: d.opened, claimed: d.configuration.interfaces[1].claimed, descLen: desc.data.byteLength, descType: desc.data.getUint8(1), vid: desc.data.getUint16(8, true), written: w.bytesWritten, read: new TextDecoder().decode(r.data), status: r.status };
});
ok(io.opened && io.claimed && io.descLen === 18 && io.descType === 1 && io.vid === 0x2341, 'open, claim and a control transfer (the device descriptor) work: ' + JSON.stringify(io));
ok(io.written === 10 && io.read === 'HELLO JADE' && io.status === 'ok', 'bulk transfers out and in work');
ok(await E(async () => { const [d] = await navigator.usb.getDevices(); return (await d.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 99, value: 0, index: 0 }, 4)).status; }) === 'stall', 'a refused control transfer reports a stall, not an exception');
ok(await E(async () => { const [d] = await navigator.usb.getDevices(); return d.isochronousTransferIn(1, [8]).then(() => 'ok', e => e.name); }) === 'NotSupportedError', 'isochronous transfers say they are not supported');

// ---- the usb tool
const list = JSON.parse(await T({ action: 'list' }));
ok(list[0].vendorProduct === '2341:0043' && list[0].interfaces[1].endpoints.includes('4 out bulk 64') && list[0].opened === true, 'list shows devices with their interfaces and endpoints');
ok(/opened|closed/.test(await T({ action: 'close' })) && /opened Arduino Uno/.test(await T({ action: 'open', device: '2341:0043' })), 'open and close by vendor:product');
ok(/open the device first|not open/.test(await (async () => { await T({ action: 'close' }); const r = await T({ action: 'transfer_in', endpoint: 3 }); await T({ action: 'open' }); return r; })()), 'transfers need the device open first');
ok(/claimed interface 1/.test(await T({ action: 'claim', interface: 1 })), 'claim an interface');
const out = JSON.parse(await T({ action: 'transfer_out', endpoint: 4, text: 'ping' }));
const inn = JSON.parse(await T({ action: 'transfer_in', endpoint: 3, length: 16, save: '/usb/reply.bin' }));
ok(out.bytesWritten === 4 && inn.text === 'PING' && inn.hex === '50 49 4e 47' && inn.saved === '/usb/reply.bin' && await E(() => vfs.read('/usb/reply.bin') === 'PING'), 'the tool sends text and reads bytes back (hex, text, saved to the vault): ' + JSON.stringify(inn));
const hex = JSON.parse(await T({ action: 'transfer_out', endpoint: 4, data: '68 69 0a' }));
ok(hex.bytesWritten === 3 && JSON.parse(await T({ action: 'transfer_in', endpoint: 3 })).hex === '48 49 0a', 'hex data works both ways');
const ci = JSON.parse(await T({ action: 'control_in', requestType: 'standard', request: 6, value: 256, length: 18 }));
ok(ci.bytes === 18 && ci.hex.startsWith('12 01 10 01'), 'control_in reads a descriptor');
ok(/ERR .*hex/.test(await T({ action: 'transfer_out', endpoint: 4, data: 'zz' })) && /no allowed USB device/.test(await T({ action: 'open', device: 'ffff:0001' })), 'bad data and unknown devices are clear errors');
ok(await E(() => activeTools().some(t => t.function.name === 'usb') && /usb: USB devices plugged/.test(systemPrompt())), 'Jade has the usb tool and knows about it');

// ---- unplugging fires disconnect
const unplug = await E(async () => {
  let got = null; navigator.usb.addEventListener('disconnect', e => { got = e.device; });
  await new Promise(r => setTimeout(r, 2300)); __usb.devices = [];
  for (let i = 0; i < 40 && !got; i++) await new Promise(r => setTimeout(r, 100));
  return got && got._id;
});
ok(unplug === '/dev/bus/usb/001/002', 'unplugging a device fires a disconnect event');
await done();

// ---- a browser: real WebUSB, so Jade asks the person with a button
const b = await start();
const pick = await b.page.evaluate(async () => {
  if (!navigator.usb) return 'no-webusb';
  const fake = { vendorId: 0x2341, productId: 0x8036, productName: 'Leonardo', manufacturerName: 'Arduino', opened: false, configuration: { interfaces: [] } };
  let asked = null; navigator.usb.requestDevice = async (o) => { asked = o; return fake; };
  const p = usbTool({ action: 'request', vendorId: '2341' });
  for (let i = 0; i < 50 && !document.getElementById('usbAllow'); i++) await new Promise(r => setTimeout(r, 50));
  const shown = !!document.getElementById('usbAllow'); document.getElementById('usbAllow')?.click();
  const r = await p; return { shown, filters: asked?.filters, r: r.slice(0, 60) };
});
b.ok(pick === 'no-webusb' || (pick.shown && pick.filters?.[0]?.vendorId === 0x2341 && /allowed: .*2341:8036/.test(pick.r)), 'in a browser the usb tool shows an "Allow a USB device" button and passes the tap to WebUSB: ' + JSON.stringify(pick));
await b.done();
