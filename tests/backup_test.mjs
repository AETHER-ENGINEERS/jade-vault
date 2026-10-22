// Scheduled backup (app side) against a fake server: upload headers, checksum, gzip + encryption round trip,
// secrets left out by default, backoff after a failure, Jade's tool, and the restore pipeline.
const { start } = await import('./_harness.mjs');
const { page, ctx, ok, done, extraRoutes } = await start({ settings: { askRisky: false } });
const E = (fn, arg) => page.evaluate(fn, arg);
const store = new Map(); const seen = []; let failNext = 0;
const fake = async route => {
  if (!route.request().url().startsWith('http://backup.test/')) return false;
  const req = route.request(), u = new URL(req.url()), H = req.headers(), CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'X-Sha256' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  seen.push({ m: req.method(), p: u.pathname, auth: H.authorization, sha: H['x-sha256'] });
  if (H.authorization !== 'Bearer tok123') return route.fulfill({ status: 401, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: 'bad token' }) });
  if (failNext > 0) { failNext--; return route.fulfill({ status: 503, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) }); }
  if (req.method() === 'PUT') { const b = req.postDataBuffer(); const sha = (await import('node:crypto')).createHash('sha256').update(b).digest('hex'); if (sha !== H['x-sha256']) return route.fulfill({ status: 400, headers: CORS, body: '{"error":"checksum"}' }); store.set(decodeURIComponent(u.pathname.split('/').pop()), b); return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ ok: true, sha256: sha }) }); }
  if (req.method() === 'GET' && u.pathname === '/backups') return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ backups: [...store].map(([name, b]) => ({ name, size: b.length, modified: 1790000000 })) }) });
  if (req.method() === 'GET') { const n = decodeURIComponent(u.pathname.split('/').pop()), b = store.get(n); if (!b) return route.fulfill({ status: 404, headers: CORS, body: '{"error":"none"}' }); const sha = (await import('node:crypto')).createHash('sha256').update(b).digest('hex'); return route.fulfill({ headers: { ...CORS, 'X-Sha256': sha }, contentType: 'application/octet-stream', body: b }); }
  return route.fulfill({ status: 404, headers: CORS, body: '{}' });
};
extraRoutes.push(async route => { const r = await fake(route); return r === false ? false : true; });

await E(() => { Object.assign(S, { abOn: true, abUrl: 'http://backup.test/', abToken: 'tok123', abHours: 24, abKind: 'full', abKeys: false, abEncrypt: false, abPass: '', secrets: { MYKEY: 'sekret-value-1' } }); vfs.write('/Notes/hello.md', 'hello backup world', { mkdirs: true }); ls.set('abLast', 0); ls.set('abFails', 0); ls.set('abRetryAt', 0); });

// 1. manual backup: gz, auth header, checksum verified by the server
let r = await E(() => runAutoBackup({ manual: true })); 
ok(r.ok && /^jade-vault-full-.*\.json\.gz$/.test(r.name) && store.size === 1, 'backup now uploads a gzip file: ' + JSON.stringify(r));
ok(seen.some(x => x.m === 'PUT' && x.auth === 'Bearer tok123' && /^[0-9a-f]{64}$/.test(x.sha)), 'PUT carries the bearer token and a sha256');
const name1 = [...store.keys()][0];
let dec = await E(async n => { const b = Uint8Array.from(atob(n), c => c.charCodeAt(0)); const o = await abDecode(b, ''); return JSON.stringify(o); }, Buffer.from(store.get(name1)).toString('base64'));
ok(dec.includes('hello backup world'), 'the file contains the vault');
ok(!dec.includes('sekret-value-1'), 'secrets are left out by default');

// 2. encrypted with a passphrase; wrong passphrase refused; right one restores the content
await E(() => { S.abEncrypt = true; S.abPass = 'correct horse'; });
r = await E(() => runAutoBackup({ manual: false })); const nameE = r.name;
ok(r.ok && /\.enc\.json$/.test(nameE) && r.encrypted, 'an encrypted backup uploads: ' + nameE);
const bE = Buffer.from(store.get(nameE));
ok(!bE.toString('latin1').includes('hello backup world'), 'the encrypted file has no readable content');
const bad = await E(async n => { try { await abDecode(Uint8Array.from(atob(n), c => c.charCodeAt(0)), 'nope'); return 'accepted'; } catch (e) { return e.message; } }, bE.toString('base64'));
ok(bad !== 'accepted', 'a wrong passphrase is refused: ' + bad);
dec = await E(async n => JSON.stringify(await abDecode(Uint8Array.from(atob(n), c => c.charCodeAt(0)), 'correct horse')), bE.toString('base64'));
ok(dec.includes('hello backup world'), 'the right passphrase gives the vault back');
await E(() => { S.abEncrypt = false; });

// 3. with keys on, secrets are included
await E(() => { S.abKeys = true; }); r = await E(() => runAutoBackup({})); if (!r.ok) console.log('KEYS RUN', JSON.stringify(r)); 
dec = await E(async n => JSON.stringify(await abDecode(Uint8Array.from(atob(n), c => c.charCodeAt(0)), 'correct horse')), Buffer.from(store.get(r.name)).toString('base64'));
ok(dec.includes('sekret-value-1') && /\.enc\.json$/.test(r.name), 'with "include keys" on, the backup is forced to be encrypted and carries the secrets'); await E(() => { S.abKeys = false; });

// 4. failure -> status + backoff; schedule respects it; wrong token explained
failNext = 1; r = await E(() => runAutoBackup({}));
let st = await E(() => ({ fails: ls.get('abFails'), retry: ls.get('abRetryAt'), status: ls.get('abStatus') }));
ok(!r.ok && /503/.test(r.msg) && st.fails === 1 && st.retry > Date.now() + 10 * 60e3 && st.status.ok === false, 'a failed upload is recorded with a retry time: ' + r.msg);
const putsBefore = seen.filter(x => x.m === 'PUT').length;
await E(() => { ls.set('abLast', 0); abTick(); }); await page.waitForTimeout(600);
ok(seen.filter(x => x.m === 'PUT').length === putsBefore, 'the schedule waits during back-off');
await E(() => { ls.set('abRetryAt', 0); ls.set('abLast', 0); abTick(); }); await page.waitForTimeout(1500);
ok(seen.filter(x => x.m === 'PUT').length === putsBefore + 1 && (await E(() => ls.get('abFails'))) === 0, 'once the wait is over it runs and the failure count resets');
await E(() => { ls.set('abLast', Date.now()); }); const p2 = seen.length; await E(() => abTick()); await page.waitForTimeout(400);
ok(seen.length === p2, 'it does not run again before the interval is up');
await E(() => { S.abToken = 'wrong'; }); r = await E(() => runAutoBackup({}));
ok(!r.ok && /401.*bad token/.test(r.msg), 'a wrong token is reported plainly: ' + r.msg); await E(() => { S.abToken = 'tok123'; });

// 5. Jade's tool
ok(await E(() => activeTools().some(t => t.function.name === 'backup')), 'the backup tool is offered when backup is on');
const T = a => E(a2 => backupTool(a2).then(x => x, e => 'ERR ' + e.message), a);
ok(/Scheduled backup: on, every 24 h/.test(await T({ action: 'status' })), 'status');
ok(/Backup uploaded: jade-vault-full-/.test(await T({ action: 'now' })), 'now');
ok((await T({ action: 'list' })).includes(name1), 'list');
ok(/ERR .*only the user/.test(await T({ action: 'restore' })), 'she cannot restore');
await E(() => { S.abOn = false; }); ok(!(await E(() => activeTools().some(t => t.function.name === 'backup'))), 'switched off, the tool is hidden'); await E(() => { S.abOn = true; });

// 6. restore pipeline: download, verify, decode, then it asks before replacing anything (we say no)
let asked = ''; page.once('dialog', d => { asked = d.message(); d.dismiss(); });
const before = await E(() => vfs.read('/Notes/hello.md'));
await E(n => abRestore(n), name1);
ok(/Replace EVERYTHING/.test(asked), 'restore downloads, decodes and asks before replacing: ' + asked.slice(0, 60));
ok(await E(() => vfs.read('/Notes/hello.md')) === before, 'declining changes nothing');
await done();
