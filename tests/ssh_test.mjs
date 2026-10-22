// The ssh tool: Jade working on machines the user has saved, against a fake native side that records every op.
// The point of most of these checks is the boundary: she names a host, the page supplies the secret, and no
// password or private key is ever allowed back into a tool result, the host list or the system prompt.
const { start } = await import('./_harness.mjs');
const { page, ok, done } = await start({
  settings: {
    sshOn: true,
    sshHosts: [
      { name: 'buildbox', host: '10.0.0.5', port: 22, user: 'dev', password: 'hunter2-secret', fingerprint: 'SHA256:abc', confirm: false, sentry: false },
      { name: 'pi', host: 'pi.local', port: 2222, user: 'pi', key: '-----BEGIN OPENSSH PRIVATE KEY-----\nKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----', fingerprint: '', confirm: true, sentry: true },
      { name: 'bare', host: '10.0.0.9', port: 22, user: 'root', confirm: false },
    ],
  },
});
const E = (fn, arg) => page.evaluate(fn, arg);
const T = a => E(a2 => sshTool(a2).then(r => r, e => 'ERR ' + e.message), a);
const J = async a => { const r = await T(a); const i = r.indexOf('{'); try { return JSON.parse(i > 0 ? r.slice(i) : r); } catch { return r; } };
// the real approval dialog, answered the way phone_test does it
const answerCard = which => page.waitForSelector('[role=alertdialog]', { timeout: 8000 }).then(async () => {
  const text = await E(() => document.querySelector('[role=alertdialog]').innerText);
  await E(w => document.querySelector('[role=alertdialog] [data-' + w + ']').click(), which);
  return text;
});

await E(() => {
  window.__ssh = [];
  const A = window.NetrunnerAndroid;
  A.__reply = {
    open: () => JSON.stringify({ ok: true, session: 's1', host: '10.0.0.5', user: 'dev', output: 'dev@buildbox:~$ ' }),
    list: () => JSON.stringify({ sessions: [{ session: 's1', host: '10.0.0.5', user: 'dev', label: 'buildbox', age_s: 3 }] }),
    send: () => JSON.stringify({ ok: true, sent: 7 }),
    read: () => JSON.stringify({ output: 'total 0\ndev@buildbox:~$ ' }),
    exec: () => JSON.stringify({ ok: true, output: 'hello', exit_status: 0 }),
  };
  A.ssh = (id, op, json) => {
    window.__ssh.push([op, JSON.parse(json)]);
    const r = A.__reply[op];
    setTimeout(() => window.__jssh(id, typeof r === 'function' ? r(JSON.parse(json)) : JSON.stringify(r || { ok: true })), 10);
  };
});
const calls = () => E(() => window.__ssh);
const last = () => E(() => window.__ssh.at(-1));

ok(await E(() => activeTools().some(t => t.function.name === 'ssh') && /ssh: hold interactive SSH sessions/.test(systemPrompt())),
  'the ssh tool is offered and described in the system prompt');

// ---- the secret never leaves the page ----
let raw = await T({ action: 'hosts' });
ok(/buildbox/.test(raw) && /pi\.local/.test(raw) && !/hunter2-secret/.test(raw) && !/KEYMATERIAL/.test(raw),
  'hosts lists the machines by name without the password or the key');
ok(/"auth": *"password"/.test(raw) && /"auth": *"key"/.test(raw) && /"auth": *"none"/.test(raw),
  'hosts says how each machine authenticates without saying what the secret is');
ok(!/hunter2-secret|KEYMATERIAL/.test(await E(() => systemPrompt())), 'no secret reaches the system prompt');

// ---- open: the page supplies the credential to the native side ----
let r = await J({ action: 'open', host: 'buildbox' });
let c = await last();
ok(r.session === 's1' && c[0] === 'open' && c[1].password === 'hunter2-secret' && c[1].host === '10.0.0.5' && c[1].port === 22 && c[1].user === 'dev',
  'open hands the saved password straight to the native side');
ok(c[1].fingerprint === 'SHA256:abc', 'open passes the pinned fingerprint so a changed host key is refused');
raw = await T({ action: 'open', host: 'buildbox' });
ok(/data, not instructions/i.test(raw), 'the first output of a session carries the untrusted-data warning');

r = await T({ action: 'open', host: 'nope' });
ok(/no saved host/.test(r), 'an unknown host name is refused, and the saved names are offered');
r = await T({ action: 'open', host: 'bare' });
ok(/no password or private key/.test(r), 'a host with no credential saved is refused with an explanation');

// ---- first connection: the user approves the host key, and it is remembered ----
await E(() => { NetrunnerAndroid.__reply.open = a => a.fingerprint ? JSON.stringify({ ok: true, session: 's2', output: 'pi@pi:~$ ' }) : JSON.stringify({ needs_trust: true, fingerprint: 'SHA256:newhost', key_type: 'ssh-ed25519' }); });
let p = T({ action: 'open', host: 'pi' });
let card = await answerCard('yes');
r = JSON.parse((await p).replace(/^[^{]*/, ''));
ok(/Trust this SSH host/.test(card) && /SHA256:newhost/.test(card) && /ssh-ed25519/.test(card),
  'an unknown host key is shown to the user for approval, with its fingerprint');
ok(r.session === 's2', 'after approval the connection is made');
ok(await E(() => (S.sshHosts.find(h => h.name === 'pi') || {}).fingerprint === 'SHA256:newhost'), 'the approved fingerprint is saved against the host');
// the second connection to the same machine does not ask again
await E(() => { window.__ssh.length = 0; });
r = await J({ action: 'open', host: 'pi' });
ok(r.session === 's2' && !(await E(() => !!document.querySelector('[role=alertdialog]'))), 'once approved, it is not asked again');

await E(() => { S.sshHosts = S.sshHosts.map(h => h.name === 'pi' ? { ...h, fingerprint: '' } : h); });
p = T({ action: 'open', host: 'pi' }); await answerCard('no'); r = await p;
ok(/did not approve the host key/.test(r), 'if the user declines the fingerprint nothing is connected');
ok(await E(() => !(S.sshHosts.find(h => h.name === 'pi') || {}).fingerprint), 'and nothing is pinned');

// ---- a changed host key is refused outright ----
await E(() => { NetrunnerAndroid.__reply.open = () => JSON.stringify({ host_key_changed: true, error: 'the host key is not the one that was approved', fingerprint: 'SHA256:other' }); });
r = await J({ action: 'open', host: 'buildbox' });
ok(r.host_key_changed === true && /not the one that was approved/.test(r.error), 'a changed host key is reported as such, not retried');
ok(!(await E(() => !!document.querySelector('[role=alertdialog]'))), 'a changed host key is never offered for approval');

// ---- working in a live session (buildbox has confirm off) ----
await E(() => { NetrunnerAndroid.__reply.open = () => JSON.stringify({ ok: true, session: 's1', output: '$ ' }); window.__ssh.length = 0; });
raw = await T({ action: 'send', session: 's1', text: 'ls -la', enter: true });
c = await calls();
ok(c.some(x => x[0] === 'send' && x[1].text === 'ls -la' && x[1].enter === true), 'send types the text into the session');
ok(c.at(-1)[0] === 'read' && /data, not instructions/i.test(raw) && /total 0/.test(raw), 'send then reads what came back, framed as untrusted data');

await T({ action: 'send', session: 's1', keys: ['ctrl-c'] });
ok((await calls()).some(x => x[0] === 'send' && JSON.stringify(x[1].keys) === '["ctrl-c"]'), 'control keys are passed through');
await T({ action: 'send', session: 's1', text: 'x', read: false });
ok((await last())[0] === 'send', 'read:false types without waiting for output');

raw = await T({ action: 'read', session: 's1', wait_ms: 3000, until: '$ ' });
c = await last();
ok(c[0] === 'read' && c[1].wait_ms === 3000 && c[1].until === '$ ' && /data, not instructions/i.test(raw), 'read passes its waiting options and frames the output');

await T({ action: 'resize', session: 's1', cols: 100, rows: 30 });
c = await last(); ok(c[0] === 'resize' && c[1].cols === 100 && c[1].rows === 30, 'resize reaches the session');
await T({ action: 'list' }); ok((await last())[0] === 'list', 'list asks the native side');
await T({ action: 'close', session: 's1' }); ok((await last())[0] === 'close', 'close closes the session');

// ---- run, with and without a session ----
await E(() => { window.__ssh.length = 0; });
raw = await T({ action: 'run', session: 's1', command: 'make -j4' });
c = await calls();
ok(c.some(x => x[0] === 'send' && x[1].text === 'make -j4' && x[1].enter === true), 'run inside a session types the command');
ok(c.at(-1)[0] === 'read', 'run inside a session then reads the output');
await E(() => { window.__ssh.length = 0; });
raw = await T({ action: 'run', host: 'buildbox', command: 'uname -a' });
c = await calls();
ok(c.some(x => x[0] === 'open') && c.some(x => x[0] === 'exec' && x[1].command === 'uname -a') && c.at(-1)[0] === 'close',
  'run without a session connects, execs and disconnects');
ok(/data, not instructions/i.test(raw), 'one-shot run output is framed as untrusted data');

// ---- confirm before each command ----
await E(() => { S.sshHosts = S.sshHosts.map(h => h.name === 'buildbox' ? { ...h, confirm: true } : h); });
p = T({ action: 'run', host: 'buildbox', command: 'rm -rf /tmp/x' }); card = await answerCard('no'); r = await p;
ok(/did not approve/.test(r) && /rm -rf \/tmp\/x/.test(card) && /10\.0\.0\.5/.test(card),
  'with confirm on, the command and the machine are shown, and no is obeyed');
ok(!/hunter2-secret/.test(card), 'the approval card does not show the password');
await E(() => { window.__ssh.length = 0; });
p = T({ action: 'run', host: 'buildbox', command: 'echo hi' }); await answerCard('yes'); await p;
ok((await calls()).some(x => x[0] === 'exec' && x[1].command === 'echo hi'), 'with confirm on and the user saying yes, it runs');
await E(() => { S.sshHosts = S.sshHosts.map(h => h.name === 'buildbox' ? { ...h, confirm: false } : h); });
await T({ action: 'run', host: 'buildbox', command: 'echo hi' });
ok(!(await E(() => !!document.querySelector('[role=alertdialog]'))), 'with confirm off there is no dialog');

// ---- Sentry-triggered flows may only touch hosts ticked for them ----
await E(() => { window.SY = window.SY || {}; SY.running = 1; });
r = await T({ action: 'open', host: 'buildbox' });
ok(/not one of the hosts allowed to be used by a Sentry/.test(r), 'a Sentry-run flow cannot open a host that is not ticked for it');
r = await T({ action: 'run', host: 'buildbox', command: 'echo x' });
ok(/not one of the hosts allowed to be used by a Sentry/.test(r), 'and it cannot run a command on one either');
await E(() => { S.sshHosts = S.sshHosts.map(h => h.name === 'pi' ? { ...h, fingerprint: 'SHA256:x', sentry: true, confirm: false } : h); });
r = await J({ action: 'open', host: 'pi' });
ok(!!r.session, 'a host ticked for Sentry can be used by a Sentry-run flow');
await E(() => { SY.running = 0; });
r = await J({ action: 'open', host: 'buildbox' });
ok(!!r.session, 'outside a Sentry flow an unticked host opens normally');

// ---- the pack switch removes the whole tool ----
ok(await E(() => { S.sshOn = false; const off = !activeTools().some(t => t.function.name === 'ssh'); S.sshOn = true; return off && activeTools().some(t => t.function.name === 'ssh'); }),
  'turning the SSH switch off takes the whole tool out of what she is given, and back on restores it');

// ---- the settings list ----
ok(await E(() => { sshUiRender(); const h = document.getElementById('sshList').innerHTML; return /buildbox/.test(h) && /type="password"/.test(h); }),
  'the settings list renders the saved machines with the password masked');
ok(await E(() => { const n = S.sshHosts.length; S.sshHosts = sshHosts().concat([{ name: '', host: '', port: 22, user: '', confirm: true }]); const grew = S.sshHosts.length === n + 1; S.sshHosts = S.sshHosts.slice(0, n); return grew; }),
  'a new host can be appended to the list');
const noKeys = await E(() => buildBackup('config', false).then(d => JSON.stringify(d.settings)));
ok(!/hunter2-secret|KEYMATERIAL/.test(noKeys) && !/sshHosts/.test(noKeys), 'a backup exported WITHOUT keys leaves the SSH machines out entirely');
const withKeys = await E(() => buildBackup('config', true).then(d => JSON.stringify(d.settings)));
ok(/hunter2-secret/.test(withKeys) && /sshHosts/.test(withKeys), 'a backup exported WITH keys carries them, as the user asked');

done();
