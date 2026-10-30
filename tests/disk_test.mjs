// The vault on real storage (Android app): every file is a file in a folder, the page keeps only the list.
// A fake folder stands in for the Java side (same contract as DiskHost / Disk.java, which has its own JVM test).
const FAKE = `(() => {
  const K = '__fakedisk';
  const load = () => { try { return JSON.parse(sessionStorage.getItem(K)) || {}; } catch { return {}; } };
  const files = load();            // path -> { d:1 } | { b: base64, m: mtime }
  const tmp = {};                  // path -> base64 pieces while a chunked write is in progress
  const save = () => { try { sessionStorage.setItem(K, JSON.stringify(files)); } catch (e) { console.warn('fake disk full', e.message); } };
  const st = window.__disk = { calls: [], fail: null, files, mtime: 1700000000000, root: '/storage/emulated/0/JadeVault', mode: 'shared' };
  const A = window.NetrunnerAndroid;
  const rec = (n, a) => { st.calls.push(n + ' ' + a.filter(x => typeof x === 'string' && x.length < 80).join(' ')); if (st.fail && st.fail(n, a)) return 'ERR:' + st.failMsg; };
  const ok = (extra = '') => 'ok' + extra;
  const parent = p => p.slice(0, p.lastIndexOf('/')) || '/';
  const mk = p => { for (let q = parent(p); q !== '/'; q = parent(q)) files[q] = files[q] || { d: 1 }; };
  const tick = () => ++st.mtime;
  Object.assign(A, {
    diskInfo() { return JSON.stringify({ root: st.root, mode: st.mode, sharedOk: st.mode === 'shared', free: 5e9, warn: '', sdk: 34 }); },
    diskScan() { return JSON.stringify(Object.keys(files).sort().map(p => [p, files[p].d ? 1 : 0, files[p].d ? 0 : Math.floor(atob(files[p].b).length), files[p].m || 0])); },
    diskGet(p, off, len) { const e = rec('get', [p]); if (e) return e; const f = files[p]; if (!f || f.d) return 'ERR:no such file: ' + p; const s = atob(f.b).slice(off, off + len); return btoa(s); },
    diskPut(p, b64, first, last) { const e = rec('put', [p]); if (e) return e; if (files[p]?.d) return 'ERR:is a directory'; tmp[p] = (first ? '' : tmp[p] || '') + atob(b64); if (!last) return 'ok:0'; mk(p); const m = tick(); files[p] = { b: btoa(tmp[p]), m }; delete tmp[p]; save(); return 'ok:' + m; },
    diskMkdir(p) { const e = rec('mkdir', [p]); if (e) return e; mk(p); files[p] = files[p]?.d ? files[p] : { d: 1 }; save(); return ok(); },
    diskDel(p) { const e = rec('del', [p]); if (e) return e; for (const k of Object.keys(files)) if (k === p || k.startsWith(p + '/')) delete files[k]; save(); return ok(); },
    diskMove(a, b) { const e = rec('mv', [a, b]); if (e) return e; for (const k of Object.keys(files)) if (k === b || k.startsWith(b + '/')) delete files[k]; mk(b); for (const k of Object.keys(files)) if (k === a || k.startsWith(a + '/')) { files[b + k.slice(a.length)] = files[k]; delete files[k]; } save(); return ok(); },
    diskTouch(p, t) { const e = rec('touch', [p]); if (e) return e; if (!files[p]) return 'ERR:no such file'; files[p].m = t; save(); return 'ok:' + t; },
    diskClear() { const e = rec('clear', []); if (e) return e; for (const k of Object.keys(files)) delete files[k]; save(); return ok(); },
    diskUseShared() { return 'need-permission'; },
  });
  if (sessionStorage.getItem('__failput')) { st.failMsg = 'nope'; st.fail = n => n === 'put'; }
  st.put = (p, text) => { mk(p); files[p] = { b: btoa(unescape(encodeURIComponent(text))), m: tick() }; save(); };
  st.del = p => { delete files[p]; save(); };
  st.text = p => files[p] && !files[p].d ? decodeURIComponent(escape(atob(files[p].b))) : null;
  st.bytes = p => files[p] && !files[p].d ? atob(files[p].b).length : null;
  st.has = p => !!files[p];
  st.paths = () => Object.keys(files).sort();
})();`;

const { start } = await import('./_harness.mjs');
const { page, ok, write, read, sh, done } = await start({ init: FAKE });
const E = (fn, arg) => page.evaluate(fn, arg);
const settle = () => E(async () => { await new Promise(r => setTimeout(r, 400)); vfs.flush(true); });
const reload = async () => { await settle(); await page.reload(); await page.waitForFunction(() => typeof flowRun === 'function' && typeof userShell !== 'undefined' && S.model && typeof Sched !== 'undefined', null, { timeout: 90000 }); await page.waitForTimeout(1000); };

// ---- boot: the page uses the folder ----
ok(await E(() => vfs.diskOn === true && vfs.info?.root === '/storage/emulated/0/JadeVault'), 'the page found the folder and uses it');
await settle();
ok(await E(() => __disk.paths().length > 3 && __disk.has('/Welcome.md')), 'the starter notes were written into the folder as real files');
ok(await E(async () => (await idb.get('vfs')) === undefined), 'the browser database no longer holds the vault');

// ---- ordinary files ----
await write('/notes/日本 café.md', '# Héllo\nline two');
await settle();
ok(await E(() => __disk.text('/notes/日本 café.md') === '# Héllo\nline two'), 'a note is stored as a real file (unicode name and text intact)');
ok(await E(() => { const n = vfs.nodes.get('/notes/日本 café.md'); __disk.calls.length = 0; const s = vfs.stat('/notes/日本 café.md'); return s.size === 17 && __disk.calls.length === 0; }), 'size and mtime come from the list, not from reading the file');
ok(await E(() => { vfs.nodes.get('/notes/日本 café.md')._d = null; __disk.calls.length = 0; const t = vfs.read('/notes/日本 café.md'); const again = vfs.read('/notes/日本 café.md'); return t === '# Héllo\nline two' && __disk.calls.filter(c => c.startsWith('get')).length === 1; }), 'contents are read from the folder on demand, once, then cached');

// ---- big file: chunked both ways, never held by the list ----
const bigOk = await E(async () => {
  const n = 7 * 1048576 + 123; const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + (i >> 8)) & 255;
  __disk.calls.length = 0; vfs.write('/media/big.bin', u, { mkdirs: true }); vfs.flush(true);
  const puts = __disk.calls.filter(c => c.startsWith('put /media/big.bin')).length;
  const sz = __disk.bytes('/media/big.bin');
  vfs.nodes.get('/media/big.bin')._d = null; LRU.drop(vfs.nodes.get('/media/big.bin'));
  const back = vfs.readBytes('/media/big.bin'); let same = back.length === n; for (let i = 0; same && i < n; i += 997) if (back[i] !== u[i]) same = false;
  return { puts, sz: sz === n, same, n };
});
ok(bigOk.puts === 3 && bigOk.sz, `a 7 MB file is written in ${bigOk.puts} chunks and lands whole`);
ok(bigOk.same, 'and reads back byte for byte');
ok(await E(() => { LRU.max = 4 * 1048576; vfs.read('/notes/日本 café.md'); vfs.readBytes('/media/big.bin'); vfs.readBytes('/media/big.bin'); const held = [...vfs.nodes.values()].filter(n => n._d).length; LRU.max = 48 * 1048576; return LRU.bytes <= 8 * 1048576 + 16 || held < 40; }), 'the cache drops big files instead of keeping everything in memory');

await E(() => vfs.rm('/media', true)); await settle();   // (the fake folder lives in sessionStorage, which cannot hold 7 MB)

// ---- appends in one go write once ----
const app = await E(() => { vfs.write('/log.txt', ''); vfs.flush(true); __disk.calls.length = 0; for (let i = 0; i < 300; i++) vfs.append('/log.txt', 'line ' + i + '\n'); vfs.flush(true); return { puts: __disk.calls.filter(c => c.startsWith('put /log.txt')).length, text: __disk.text('/log.txt') }; });
ok(app.puts === 1 && app.text.split('\n').length === 301, `300 appends in a burst are one write (${app.puts})`);

// ---- folders, move, remove, copy, touch ----
await E(() => { vfs.mkdirp('/proj/src'); vfs.write('/proj/src/a.md', 'A'); vfs.write('/proj/b.md', 'B'); });
await settle();
ok(await E(() => __disk.has('/proj/src') && __disk.text('/proj/src/a.md') === 'A'), 'folders and nested files');
await E(() => vfs.move('/proj', '/project')); await settle();
ok(await E(() => __disk.text('/project/src/a.md') === 'A' && !__disk.has('/proj') && vfs.read('/project/b.md') === 'B' && !vfs.exists('/proj/b.md')), 'moving a folder moves it on disk and in the list');
ok(await E(() => vfs.nodes.get('/project/b.md').p === '/project/b.md'), '…and the moved nodes know their new path');
await E(() => { vfs.copy('/project', '/copy', true); }); await settle();
ok(await E(() => __disk.text('/copy/src/a.md') === 'A'), 'copying a folder');
await E(() => vfs.rm('/copy', true)); await settle();
ok(await E(() => !__disk.has('/copy') && !__disk.has('/copy/src/a.md')), 'removing a folder removes it from disk');
await E(() => vfs.touch('/project/b.md')); await settle();
ok(await E(() => __disk.files['/project/b.md'].m === vfs.nodes.get('/project/b.md').mtime), 'touch sets the file time on disk');
ok(await E(() => { vfs.write('/over.md', 'one'); vfs.move('/over.md', '/project/b.md'); vfs.flush(true); return vfs.read('/project/b.md') === 'one' && __disk.text('/project/b.md') === 'one'; }), 'moving onto a file replaces it');

// ---- the shell works on the real files ----
let r = await sh('echo from-shell > /sh.txt && cat /project/src/a.md && ls /project');
ok(/A/.test(r.out) && /src/.test(r.out), 'shell reads files from the folder: ' + r.out.trim().replace(/\n/g, ' | '));
await settle();
ok(await E(() => __disk.text('/sh.txt') === 'from-shell\n'), 'a file made by a shell command is a real file');
await E(() => { const u = new Uint8Array(17e6); u[5] = 7; vfs.write('/huge.bin', u); vfs.flush(true); });
r = await sh('ls / && rm /sh.txt'); await settle();
ok(await E(() => vfs.exists('/huge.bin') && __disk.bytes('/huge.bin') === 17e6 && !vfs.exists('/sh.txt') && !__disk.has('/sh.txt')), 'a file too big to hand to the shell is left alone by it (not deleted), and rm works');
await E(() => vfs.rm('/huge.bin')); await settle();
// a file the vault lists but storage cannot read (removed behind the app's back, or a case-only rename) must not
// break every command: it is skipped, never deleted by the run, and a rescan drops it once it is really gone
await E(() => { vfs.write('/Jade/Tools/debug_nws.js', 'x', { mkdirs: true }); vfs.write('/Jade/Tools/keep.js', 'k'); vfs.flush(true); const n = vfs.nodes.get('/Jade/Tools/debug_nws.js'); n._d = null; LRU.drop(n); delete __disk.files['/Jade/Tools/debug_nws.js']; vfs._scanned = Date.now(); });
r = await sh('echo hello');
ok(r.out === 'hello\n' && !/no such file/.test(r.out + r.err), 'a vanished file does not break shell commands: ' + JSON.stringify(r.out + r.err));
r = await sh('node -e "console.log(require(\'fs\').readFileSync(\'/Jade/Tools/keep.js\',\'utf8\'))"');
ok(r.out.trim() === 'k', 'nor node: ' + JSON.stringify(r.out + r.err));
await settle();
ok(await E(() => !vfs.exists('/Jade/Tools/debug_nws.js') && vfs.exists('/Jade/Tools/keep.js') && !__disk.calls.some(c => c.startsWith('del /Jade/Tools/keep'))), 'the rescan then drops the missing file and nothing else');
await E(() => { __disk.files['/Jade/Tools/odd.js'] = { b: btoa('o'), m: 1 }; vfs.rescan(true); __disk.fail = (k, a) => k === 'get' && a[0] === '/Jade/Tools/odd.js'; __disk.failMsg = 'Permission denied'; });
r = await sh('echo again');
await E(() => { __disk.fail = null; }); await settle();
ok(r.out === 'again\n' && await E(() => vfs.exists('/Jade/Tools/odd.js') && __disk.has('/Jade/Tools/odd.js')), 'a file that is there but cannot be read right now is kept, not deleted');

// ---- changes made by other apps ----
await E(() => { __disk.put('/from-pydroid.py', 'print(1)'); __disk.put('/project/b.md', 'edited outside'); __disk.del('/project/src/a.md'); });
const sc = await E(() => ({ changes: vfs.rescan(true), a: vfs.exists('/from-pydroid.py') && vfs.read('/from-pydroid.py'), b: vfs.read('/project/b.md'), gone: !vfs.exists('/project/src/a.md') }));
ok(sc.changes >= 3 && sc.a === 'print(1)' && sc.b === 'edited outside' && sc.gone, 'a rescan picks up files added, changed and removed by other apps');
ok(await E(() => vfs.rescan(true) === 0), 'and a second rescan finds nothing new');
ok(await E(() => { vfs.write('/pending.md', 'x'); const c = vfs.rescan(true); vfs.flush(true); return c === 0 || vfs.exists('/pending.md'); }), 'a rescan never loses a write that has not reached the folder yet');

// ---- write failure: the note is kept in memory, reported, and retried ----
await E(() => { __disk.failMsg = 'disk is full'; __disk.fail = (n, a) => n === 'put' && /fail\.md/.test(a[0]); vfs.write('/fail.md', 'precious'); });
await page.waitForTimeout(500);
ok(await E(() => vfs.read('/fail.md') === 'precious' && !__disk.has('/fail.md') && vfs.ops.length > 0), 'if the folder rejects a write, the text stays in memory and is queued');
ok(await E(() => /disk is full/.test(document.body.innerText)), 'and the failure is shown');
await E(() => { __disk.fail = null; vfs.flush(); });
ok(await E(() => __disk.text('/fail.md') === 'precious' && vfs.ops.length === 0), 'once the folder works again it is written');

// ---- it survives a reload ----
await write('/keep.md', 'still here');
await reload();
ok(await E(() => vfs.diskOn && vfs.read('/keep.md') === 'still here' && vfs.read('/notes/日本 café.md').startsWith('# Héllo') && vfs.nodes.get('/keep.md') instanceof DNode), 'after a reload the vault comes back from the folder');
ok(await E(async () => (await idb.get('vfs')) === undefined), '…without anything in the browser database');

// ---- upgrade: the old one-record vault is copied across, checked, then removed ----
await E(async () => {
  __disk.paths().forEach(p => __disk.del(p));
  const enc_ = s => new TextEncoder().encode(s);
  await idb.set('vfs', [['/', { dir: true, mtime: 1 }], ['/old', { dir: true, mtime: 1 }], ['/old/a.md', { data: enc_('legacy A'), mtime: 5 }], ['/old/blob.bin', { data: new Uint8Array([0, 1, 2, 255]), mtime: 6 }], ['/Welcome.md', { data: enc_('legacy welcome'), mtime: 7 }]]);
  __disk.put('/Welcome.md', 'already in the folder');
  await idb.del('vfs-migrated');
});
await page.reload(); await page.waitForFunction(() => typeof flowRun === 'function' && typeof userShell !== 'undefined' && S.model, null, { timeout: 90000 }); await page.waitForTimeout(1500);
const mig = await E(async () => ({ a: __disk.text('/old/a.md'), blob: __disk.bytes('/old/blob.bin'), w: __disk.text('/Welcome.md'), gone: (await idb.get('vfs')) === undefined, flag: !!(await idb.get('vfs-migrated')), inList: vfs.isFile('/old/a.md') }));
ok(mig.a === 'legacy A' && mig.blob === 4 && mig.inList, 'the old vault was copied into the folder');
ok(mig.w === 'already in the folder', 'a file already in the folder is never overwritten by the old copy');
ok(mig.gone && mig.flag, 'the old record was deleted only after the copy checked out');
// a failed copy keeps the old record
await E(async () => { __disk.paths().forEach(p => __disk.del(p)); await idb.set('vfs', [['/', { dir: true, mtime: 1 }], ['/x.md', { data: new TextEncoder().encode('keep me'), mtime: 5 }]]); await idb.del('vfs-migrated'); sessionStorage.setItem('__failput', '1'); });
await page.reload(); await page.waitForFunction(() => typeof flowRun === 'function' && typeof userShell !== 'undefined' && S.model, null, { timeout: 90000 }); await page.waitForTimeout(1500);
ok(await E(async () => !!(await idb.get('vfs')) && !__disk.has('/x.md')), 'if the folder cannot be written, the old copy is kept');
await E(() => { sessionStorage.removeItem('__failput'); });
await page.reload(); await page.waitForFunction(() => typeof flowRun === 'function' && typeof userShell !== 'undefined' && S.model, null, { timeout: 90000 }); await page.waitForTimeout(1500);
ok(await E(async () => __disk.text('/x.md') === 'keep me' && (await idb.get('vfs')) === undefined), '…and is moved on the next start once it works');

// ---- backups ----
await write('/bk/one.md', 'one'); await settle();
const bk = await E(async () => { const b = await buildBackup('full', false); return { files: Object.keys(b.vault.files).length, has: b.vault.files['/bk/one.md'] === 'one' }; });
ok(bk.has && bk.files > 2, 'a full backup reads every file from the folder');
const rs = await E(async () => {
  const entries = [['/', { dir: true, mtime: 1 }], ['/r', { dir: true, mtime: 1 }], ['/r/new.md', { data: new TextEncoder().encode('restored'), mtime: 2 }]];
  vfs.replace(entries, true); const okf = vfs.flush(true);
  return { okf, paths: __disk.paths(), text: __disk.text('/r/new.md') };
});
ok(rs.okf && rs.paths.join() === '/r,/r/new.md' && rs.text === 'restored', 'restoring a full backup replaces what is in the folder');

// ---- settings panel ----
await E(() => openSettings());
await page.waitForTimeout(300);
const panel = await E(() => { diskSync(); const s = $('#diskSection'); return { shown: !s.hidden, text: $('#diskStatus').innerText, btn: !$('#btnDiskShared').hidden }; });
ok(panel.shown && /JadeVault/.test(panel.text) && !panel.btn, 'Settings shows where the vault lives: ' + panel.text.replace(/\n/g, ' · '));
await E(() => { __disk.mode = 'app'; __disk.root = '/storage/emulated/0/Android/data/app.netrunner.vault/files/vault'; vfs.info = null; });
const panel2 = await E(() => { diskSync(); return { text: $('#diskStatus').innerText, btn: !$('#btnDiskShared').hidden }; });
ok(/app/.test(panel2.text) && panel2.btn, 'when the vault is in the app folder it offers to move it to JadeVault');

await done();
