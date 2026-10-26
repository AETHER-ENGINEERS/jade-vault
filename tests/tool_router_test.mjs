// Tool router: the model is sent core tools plus the optional ones that fit the message; the rest are one more_tools call away.
const { start } = await import('./_harness.mjs');
const { page, ok, model, done } = await start({ settings: { curiosityOn: true, abOn: true, askRisky: false } });
const E = (fn, arg) => page.evaluate(fn, arg);
const send = async t => { const n0 = await E(() => cur?.messages.length || 0); await page.fill('#input', t); await page.evaluate(() => document.querySelector('#btnSend').click()); await page.waitForFunction(n0 => !running && cur && cur.messages.length > n0 + 1, n0, { timeout: 60000 }); };
const lastTools = () => (model.tools.at(-1) || []).map(t => t.function.name);
const size = () => JSON.stringify(model.tools.at(-1) || []).length;
model.chatReply = (msgs, u) => ({ content: 'ok: ' + u.slice(0, 30) });

const full = await E(() => activeTools().map(t => t.function.name));
ok(full.includes('phone') && full.includes('ssh') && full.includes('playbook') && full.length > 25, 'activeTools() is still the full set (' + full.length + ' tools)');
const fullChars = await E(() => JSON.stringify(activeTools()).length);

await send('hello there, how are you?');
let t = lastTools(); const base = size();
ok(t.includes('read') && t.includes('write') && t.includes('bash') && t.includes('notes_search') && t.includes('more_tools'), 'core tools and more_tools are sent: ' + t.length + ' tools');
ok(!t.includes('phone') && !t.includes('ssh') && !t.includes('screen') && !t.includes('litert') && !t.includes('sentry'), 'optional tools are held back for a plain message');
ok(base < fullChars * 0.6, `the request carries ${base} characters of tools instead of ${fullChars} (${Math.round(100 - 100 * base / fullChars)}% less)`);
ok(/not loaded[^]*phone[^]*ssh/.test(JSON.stringify(model.tools.at(-1).find(x => x.function.name === 'more_tools'))), 'more_tools names what it can load');

await send('please set an alarm for 7am tomorrow'); t = lastTools();
ok(t.includes('phone') && !t.includes('ssh'), 'an alarm request brings in the phone tool only: ' + t.filter(x => !['read', 'write', 'edit', 'bash', 'tasks', 'web_search', 'web_fetch', 'notes_search', 'note_links', 'open_note', 'memory', 'skill', 'decide'].includes(x)).join(','));
await send('now just chat'); t = lastTools();
ok(t.includes('phone'), 'a tool used or asked for earlier in the chat stays loaded');

await E(() => newSession());
await send('make a playbook that checks my notes every morning'); t = lastTools();
ok(t.includes('playbook'), 'naming the thing loads its tool: ' + t.length);
await E(() => newSession());
await send('connect over ssh to my raspberry pi'); t = lastTools();
ok(t.includes('ssh'), 'words from the tool hints (ssh, raspberry) load it');

// asking for tools explicitly
await E(() => newSession()); await send('hello again');
ok(!lastTools().includes('litert'), 'a fresh chat starts light');
const r = await E(() => moreToolsTool({ names: ['litert', 'nonsense'] }));
ok(/Loaded 1 tool/.test(r) && /litert\(/.test(r), 'more_tools loads by name and shows the parameters: ' + r.slice(0, 120));
const r2 = await E(() => moreToolsTool({ query: 'connect to a remote server over ssh' }));
ok(/ssh\(/.test(r2), 'more_tools loads by description');
await send('carry on'); t = lastTools();
ok(t.includes('litert') && t.includes('ssh'), 'loaded tools are sent from the next request on');
ok(/No tool matches/.test(await E(() => moreToolsTool({ names: ['xyz'] }))), 'an unknown name says what is available');

// a hidden tool the model calls anyway still runs
await E(() => newSession());
model.chatReply = (msgs, u) => msgs.at(-1).role === 'tool' ? { content: 'done: ' + msgs.at(-1).content.slice(0, 40) } : { content: '', tool_calls: [{ function: { name: 'playbook', arguments: { action: 'list' } } }] };
await send('hi');
ok(await E(() => cur.messages.some(m => m.role === 'tool' && m.tool_name === 'playbook' && /No playbooks|:/.test(m.content))), 'a tool that was not sent still runs when the model names it');

// a skill that names a tool brings it along
await E(() => { newSession(); cur.messages.push({ role: 'user', content: 'use my routine' }, { role: 'tool', tool_name: 'skill', content: 'Step 1: call the ssh tool to check the server.' }); });
ok(await E(() => routeTools(activeTools()).some(t => t.function.name === 'ssh')), 'a tool named in a loaded skill is sent');

// the tool list must not change from turn to turn (it is the start of the prompt: a changing list defeats the prompt cache)
await E(() => { newSession(); });
model.chatReply = () => ({ content: 'ok' });
await send('set an alarm for 7am'); const a1 = lastTools();
await send('thanks, what is the capital of France?'); const a2 = lastTools();
await send('and Spain?'); const a3 = lastTools();
ok(a1.includes('phone') && a2.join() === a1.join() && a3.join() === a1.join(), 'tools offered earlier in a chat stay offered, in the same order (' + a1.length + ' / ' + a2.length + ' / ' + a3.length + ')');
await send('ssh into my server'); const a4 = lastTools();
ok(a1.every(n => a4.includes(n)) && a4.includes('ssh') && a4.length > a1.length, 'the set only grows');
// switching it off, and small sets
await E(() => { S.toolRouter = 'off'; });
await send('hello'); ok(lastTools().length === full.length && !lastTools().includes('more_tools'), 'toolRouter off sends everything');
await E(() => { S.toolRouter = 'auto'; });
// the context report matches what is sent
const rep = await E(() => contextReport().rows.map(r => r[1] + ' ' + r[0]).join('\n'));
ok(/Built-in tools \(\d+ sent of \d+\)/.test(rep), 'the /context report says how many tools are sent: ' + (rep.match(/Built-in tools[^\n]*/) || [''])[0]);
await done();
