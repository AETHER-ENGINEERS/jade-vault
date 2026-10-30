// chat_history: raw read (JSON with timestamps, sender, tool calls/results), and hybrid search over the raw chats
const { start } = await import('./_harness.mjs');
const { page, ok, model, done } = await start({ settings: { memoryOn: true, embedOn: true } });
const E = (fn, arg) => page.evaluate(fn, arg);
const T = a => E(x => chatHistoryTool(x).then(r => r, e => 'ERR ' + e.message), a);
const J = async a => { const r = await T(a); const i = r.indexOf('\n{'); try { return JSON.parse(r.slice(i + 1)); } catch { return r; } };

// fake embedding: concepts, so "refund" finds "money back" with no shared word
const C = [['refund', 'money', 'reimburse', 'back', 'return'], ['gpu', 'graphics', 'card', 'vram'], ['recipe', 'dinner', 'cook'], ['weather', 'rain', 'forecast']];
model.embed = t => { const w = t.toLowerCase().replace(/^(search_query|search_document): /, '').split(/[^a-z]+/).filter(Boolean); const v = [0, 0, 0, 0, 0.01]; for (const x of w) { let hit = false; C.forEach((c, i) => { if (c.includes(x)) { v[i]++; hit = true; } }); if (!hit) v[4] += 0.05; } return v; };

const T0 = Date.UTC(2026, 8, 3, 15, 0, 0);
await E(async t0 => {
  const mk = (id, title, updated, msgs) => ({ id, title, updated, messages: msgs, tasks: [], taskSeq: 0 });
  const s1 = mk('s1', 'Graphics card shopping', t0, [
    { role: 'user', content: 'Which graphics card has the most vram for the money?', ts: t0 },
    { role: 'assistant', content: 'Let me check.', ts: t0 + 1000, tool_calls: [{ function: { name: 'web_search', arguments: { query: 'gpu vram price' } } }] },
    { role: 'tool', tool_name: 'web_search', content: 'RTX-9000 has 48GB VRAM, price 1299 USD (order #A-7731)', ts: t0 + 2000 },
    { role: 'assistant', content: 'The RTX-9000 has the most VRAM.', ts: t0 + 3000 }]);
  const s2 = mk('s2', 'Dinner', t0 + 86400000, [
    { role: 'user', content: 'Give me a dinner recipe with lentils', ts: t0 + 86400000 },
    { role: 'assistant', content: 'Lentil soup: simmer lentils with cumin.', ts: t0 + 86401000 }]);
  const s3 = mk('s3', 'Returns', t0 + 2 * 86400000, [
    { role: 'user', content: 'I want my money back for the broken headset', ts: t0 + 2 * 86400000 },
    { role: 'assistant', content: 'Contact the store and ask for a refund of order 5521.', ts: t0 + 2 * 86400000 + 1000 }]);
  for (const s of [s1, s2, s3]) await idb.set('session:' + s.id, s);
  sessions.length = 0; sessions.push({ id: 's3', title: s3.title, updated: s3.updated }, { id: 's2', title: s2.title, updated: s2.updated }, { id: 's1', title: s1.title, updated: s1.updated });
  await idb.set('sessions', sessions);
  Object.assign(cur, { id: 'cur', title: 'Now', messages: [{ role: 'user', content: 'current chat marker ZEBRA', ts: Date.now() }, { role: 'assistant', content: 'noted', ts: Date.now() }], updated: Date.now() });
}, T0);

ok(await E(() => activeTools().some(t => t.function.name === 'chat_history') && /chat_history: raw past chats/.test(systemPrompt())), 'the tool is offered and described');
ok(await E(() => { S.memoryOn = false; const off = !activeTools().some(t => t.function.name === 'chat_history'); S.memoryOn = true; return off; }), 'it goes away with memory switched off');

// ---- list
let l = await J({ action: 'list' });
ok(l.chats.length === 4 && l.chats[0].session === 'cur' && l.chats.find(c => c.session === 's1').messages === 4 && l.current === 'cur', 'list shows every chat incl. the current one, newest first');
l = await J({ action: 'list', since: '2026-09-04' });
ok(l.chats.map(c => c.session).join() === 'cur,s3,s2', 'list can filter by date: ' + l.chats.map(c => c.session));

// ---- read: the raw JSON shape
let r = await J({ action: 'read', session: 's1' });
ok(r.total_messages === 4 && r.messages.length === 4, 'read returns the messages');
const [m0, m1, m2] = r.messages;
ok(m0.sender === 'User' && m0.ts === new Date(T0).toISOString() && /vram for the money/.test(m0.text) && m0.i === 0, 'user entry: sender, ISO timestamp, raw text');
ok(m1.sender === 'Jade' && m1.tool_calls[0].name === 'web_search' && m1.tool_calls[0].arguments.query === 'gpu vram price', 'assistant entry carries its tool calls');
ok(m2.sender === 'tool' && m2.tool_name === 'web_search' && /order #A-7731/.test(m2.text), 'tool entry carries the raw result');
ok((await T({ action: 'read', session: 's1' })).startsWith('[Chat history, raw.'), 'output is framed as data');
r = await J({ action: 'read', session: 'graphics card', from: 1, to: 2, role: 'tool' });
ok(r.messages.length === 1 && r.messages[0].i === 2, 'read by title part, a range and a role filter');
r = await J({ action: 'read', session: 's1', tools: false });
ok(r.messages.length === 3 && !r.messages.some(m => m.role === 'tool'), 'tools:false leaves tool results out');
r = await J({ action: 'read', session: 'current' });
ok(/ZEBRA/.test(r.messages[0].text), '"current" reads the live chat, even unsaved');
ok(/^ERR no chat matches/.test(await T({ action: 'read', session: 'nonexistent-xyz' })), 'an unknown chat is an error');
await E(async () => { const s = await idb.get('session:s2'); s.messages[1].content = 'x'.repeat(40000); await idb.set('session:s2', s); });
r = await J({ action: 'read', session: 's2' });
ok(r.messages[1].text.length < 8200, 'one huge message is cut');
await E(async () => { const s = await idb.get('session:s2'); s.messages[1].content = 'Lentil soup: simmer lentils with cumin.'; await idb.set('session:s2', s); });

// ---- search: keywords
let s = await J({ action: 'search', query: 'A-7731' });
ok(s.hits.length && s.hits[0].session === 's1' && /order #A-7731/.test(s.hits[0].text) && s.hits[0].keyword === true, 'search finds an exact detail inside a tool result: ' + JSON.stringify(s.hits[0] && [s.hits[0].session, s.hits[0].index]));
ok(s.hits[0].index === 0 && /read the surrounding messages/.test(s.next), 'a hit says which message to read around');
// ---- search: meaning (no shared word)
s = await J({ action: 'search', query: 'reimburse me' });
ok(s.hits[0] && s.hits[0].session === 's3', 'search finds by meaning: "reimburse" finds the money-back chat: ' + JSON.stringify(s.hits.map(h => h.session)));
ok(model.embedCalls > 0, 'the embedding model was used');
// ---- filters and modes
s = await J({ action: 'search', query: 'refund', since: '2026-09-05' });
ok(s.hits.length && s.hits.every(h => h.session === 's3'), 'date filter');
s = await J({ action: 'search', query: 'lentils', session: 'Dinner' });
ok(s.hits.length && s.hits.every(h => h.session === 's2'), 'session filter');
s = await J({ action: 'search', query: 'ZEBRA' });
ok(s.hits.some(h => h.session === 'cur'), 'the current chat is searchable too');
s = await J({ action: 'search', query: 'lentils', mode: 'keyword' });
ok(s.hits.length && s.hits.every(h => h.keyword), 'keyword-only mode');
ok(/^ERR search needs a query/.test(await T({ action: 'search' })), 'a query is required');
s = await J({ action: 'search', query: 'weather rain forecast' });
ok(Array.isArray(s.hits) && /no match/.test(s.next), 'no match is explained');

// ---- changes and deletion
await E(async () => { const x = await idb.get('session:s2'); x.messages.push({ role: 'user', content: 'also remember pomegranate molasses', ts: Date.now() }); x.updated = Date.now(); await idb.set('session:s2', x); sessions.find(q => q.id === 's2').updated = x.updated; });
s = await J({ action: 'search', query: 'pomegranate' });
ok(s.hits.some(h => h.session === 's2'), 'a chat that grew is re-indexed');
await E(async () => { sessions.splice(sessions.findIndex(q => q.id === 's1'), 1); await idb.set('sessions', sessions); await idb.del('session:s1'); });
s = await J({ action: 'search', query: 'A-7731' });
ok(!s.hits.some(h => h.session === 's1') && /removed from the index/.test(s.note || ''), 'a deleted chat disappears from the index (nothing lingers): ' + (s.note || ''));
// ---- the shared embeddings tool does not surface chats by default
const emb = await E(() => runTool('embeddings', { action: 'search', query: 'pomegranate' }).then(String, e => 'ERR ' + e.message));
ok(!/\[chats/.test(emb), 'the general embeddings search does not mix in raw chats');
ok(/^ERR unknown action/.test(await T({ action: 'zap' })), 'unknown action is an error');
done();
