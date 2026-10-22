// Embeddings + sqlite-vec + hybrid memory search, against a fake Ollama /api/embed:
//  - sqlite-vec is in the embedded SQLite (vec0, vec_distance_*), also from the sqlite3 shell
//  - memory and journal are indexed; search finds a memory by meaning (no shared words) and by keyword
//  - the embeddings tool: add / search / compare / remove / status / index
//  - the prompt's memory lines are ranked hybrid; the index persists across reloads; a model change rebuilds it
//  - Ollama down or no embedding model: keyword-only fallback, no errors
import pw from 'playwright';
import fs from 'node:fs';
const { chromium } = pw;
const URL_ = process.argv[2] || 'file://' + process.env.JV_WEB;
const css = fs.readFileSync('tw.css', 'utf8');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const log = [], fail = []; const ok = (c, m) => (c ? log : fail).push((c ? 'PASS ' : 'FAIL ') + m);

// a fake embedding model: four "concepts" (words of one concept share a direction) plus a little noise from the word itself
const CONCEPTS = [
  ['coffee', 'latte', 'lattes', 'espresso', 'caffeinated', 'caffeine', 'drink', 'milk', 'oat', 'cappuccino'],
  ['lisbon', 'portugal', 'portuguese', 'trip', 'travel', 'europe', 'european', 'atlantic', 'sister', 'maya'],
  ['rust', 'compiler', 'programming', 'code', 'forge', 'software', 'language'],
  ['allergic', 'peanuts', 'allergy', 'nuts', 'food', 'reaction'],
];
function embed(text, model) {
  const words = text.toLowerCase().replace(/^(search_query|search_document): /, '').split(/[^a-z0-9]+/).filter(Boolean);
  const v = new Array(8).fill(0);
  for (const w of words) { CONCEPTS.forEach((c, i) => { if (c.includes(w)) v[i] += 1; }); let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[4 + (h % 4)] += 0.05; }
  return model === 'tiny-embed' ? v.slice(0, 3) : v;
}
const mock = { calls: [], down: false, missing: false };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(() => { if (!localStorage.getItem('jvault:settings')) localStorage.setItem('jvault:settings', JSON.stringify({ model: 'qwen3:8b', journalOn: false, numCtx: 16384, memoryRag: true, memoryRagK: 1 })); });
const page = await ctx.newPage();
page.on('pageerror', e => fail.push('[pageerror] ' + e.message));
page.on('console', m => { if (/hybrid memory search failed|vector sync failed/.test(m.text())) fail.push('[console] ' + m.text()); });
await page.route('**/*', async route => {
  const req = route.request(); const url = req.url();
  if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (url.startsWith('https://cdn.tailwindcss.com/')) return route.fulfill({ contentType: 'text/javascript', body: `window.tailwind={};(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.prepend(s);})();` });
  if (url.includes('marked.min.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.JV_NM + 'marked/lib/marked.umd.js', 'utf8') });
  if (url.includes('purify.min.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.JV_NM + 'dompurify/dist/purify.min.js', 'utf8') });
  if (url === 'http://localhost:11434/api/tags') return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ models: [{ name: 'qwen3:8b' }] }) });
  if (url === 'http://localhost:11434/api/embed') {
    const b = JSON.parse(req.postData()); mock.calls.push(b);
    if (mock.down) return route.abort();
    if (mock.missing) return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: `model "${b.model}" not found, try pulling it first` }) });
    return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ model: b.model, embeddings: b.input.map(t => embed(t, b.model)) }) });
  }
  return route.abort();
});
await page.goto(URL_);
await page.waitForFunction(() => window.__vmem && typeof runTool === 'function', null, { timeout: 90000 });
await page.waitForTimeout(1500);

// 1. sqlite-vec is part of the embedded SQLite, also in the shell
const sh = async (cmd) => page.evaluate(async (cmd) => { const s = new (Object.getPrototypeOf(userShell).constructor)({}); s.timeoutMs = 8000; const r = await s.run(cmd); return { out: r.chunks.filter(c => c.t !== 'err').map(c => c.s ?? c.text ?? '').join(''), code: r.code }; }, cmd);
let r = await sh(`sqlite3 :memory: "select vec_version(), vec_distance_cosine('[1,0]','[0,1]'), vec_distance_L2('[1,2]','[1,2]')"`);
ok(/v0\.1\.9\|1\.0\|0\.0/.test(r.out) || /v0\.1\.9/.test(r.out), 'sqlite3 shell: sqlite-vec is built in (' + JSON.stringify(r.out).slice(0, 80) + ')');
r = await sh(`sqlite3 :memory: "create virtual table v using vec0(e float[2]); insert into v(rowid,e) values (1,'[1,0]'),(2,'[0,1]'); select rowid from v where e match '[0.9,0.1]' and k=1"`);
ok(/^1\s*$/m.test(r.out), 'sqlite3 shell: vec0 nearest neighbour works (' + JSON.stringify(r.out).slice(0, 60) + ')');

// 2. memory is indexed and found by meaning
await page.evaluate(() => {
  S.memoryOn = true; S.embedOn = true; S.embedModel = 'nomic-embed-text'; S.embedHost = ''; S.memoryRag = true; S.memoryRagK = 1;
  vfs.write('/Jade/Memory.md', '# Memory\n\n## About you\n- Likes oat milk lattes\n- Sister Maya lives in Lisbon\n\n## Projects & people\n- Works on a Rust compiler project called Forge\n- Allergic to peanuts\n', { mkdirs: true });
});
let st = await page.evaluate(async () => { await __vmem.sync(); return runTool('embeddings', { action: 'status' }); });
ok(/sqlite-vec v0\.1\.9 on SQLite 3\.53/.test(st) && /memory: 4 texts, 4 embedded/.test(st) && /8 numbers/.test(st), 'status: ' + st.replace(/\n/g, ' | '));
ok(mock.calls.some(c => c.input.every(t => t.startsWith('search_document: '))), 'nomic-embed-text gets the search_document: prefix for stored texts');
let hit = await page.evaluate(() => runTool('memory', { action: 'search', text: 'caffeinated drink' }));
ok(/oat milk lattes/.test(hit) && !/\[keyword search only/.test(hit), 'meaning: "caffeinated drink" finds "oat milk lattes" (no shared words)');
ok(/^memory · About you: Likes oat milk lattes/m.test(hit), 'the memory section is shown with the hit: ' + hit.split('\n')[0]);
hit = await page.evaluate(() => runTool('memory', { action: 'search', text: 'Forge' }));
ok(/Rust compiler project called Forge/.test(hit), 'keywords: "Forge" finds its memory');
ok(mock.calls.some(c => c.input.length === 1 && c.input[0] === 'search_query: Forge'), 'queries get the search_query: prefix');
hit = await page.evaluate(() => runTool('memory', { action: 'search', text: 'portuguese trip' }));
ok(/Sister Maya lives in Lisbon/.test(hit.split('\n')[0]), 'meaning: "portuguese trip" ranks the Lisbon memory first');

// 3. save/forget keep the index in step (debounced), journal entries are indexed too
await page.evaluate(() => runTool('memory', { action: 'save', text: 'Drinks cappuccino at breakfast', section: 'preferences' }));
await page.evaluate(() => { vfs.write('/Jade/Journal/Journal 2026-10-01.md', '# Journal 2026-10-01\n\n#journal\n\n## 09:00 · Trip planning\n- Talked about a europe travel plan: flights to Portugal in May.\n', { mkdirs: true }); });
st = await page.evaluate(async () => { await __vmem.sync(); return runTool('embeddings', { action: 'status' }); });
ok(/memory: 5 texts, 5 embedded/.test(st) && /journal: 1 texts, 1 embedded/.test(st), 'a new memory and a journal entry were picked up: ' + st.split('\n').slice(1).join(' | '));
hit = await page.evaluate(() => runTool('memory', { action: 'search', text: 'atlantic flights' }));
ok(/^journal · 2026-10-01 09:00 · Trip planning/m.test(hit), 'the journal is searched by meaning too');
await page.evaluate(() => runTool('memory', { action: 'forget', text: 'cappuccino' }));
st = await page.evaluate(async () => { await __vmem.sync(); return runTool('embeddings', { action: 'status' }); });
ok(/memory: 4 texts, 4 embedded/.test(st), 'a forgotten memory leaves the index');

// 4. the prompt: ranked by keywords + meaning (K = 1), prepared before the turn
let ctxT = await page.evaluate(async () => {
  if (!cur) newSession?.(); cur.messages = [{ role: 'user', content: 'what espresso do I like?' }];
  await __vmem.prefetch(); return memoryContext();
});
ok(/oat milk lattes/.test(ctxT) && !/Maya|peanuts|Forge/.test(ctxT) && /keywords and meaning/.test(ctxT), 'prompt: only the lattes memory, found by meaning ("espresso")');
ctxT = await page.evaluate(async () => { cur.messages = [{ role: 'user', content: 'how is the compiler going?' }]; await __vmem.prefetch(); return memoryContext(); });
ok(/Forge/.test(ctxT) && !/lattes/.test(ctxT), 'prompt: another message, another memory');
ctxT = await page.evaluate(async () => { cur.messages = [{ role: 'user', content: 'zzzz qqqq' }]; await __vmem.prefetch(); return memoryContext(); });
ok(/nothing matched/.test(ctxT), 'prompt: nothing relevant falls back to the newest lines');

// 5. the embeddings tool
const tool = (a) => page.evaluate(a => runTool('embeddings', a), a);
const names = await page.evaluate(() => activeTools().map(t => t.function.name));
ok(names.includes('embeddings'), 'the embeddings tool is offered to Jade');
let t = await tool({ action: 'add', collection: 'research', texts: ['The capital of Portugal is Lisbon, a city on the Atlantic coast.', 'Rust is a programming language with a borrow checker.', 'Peanut allergies can cause a severe reaction.'], source: 'test' });
ok(/Stored 3 texts in "research"/.test(t), t);
t = await tool({ action: 'add', collection: 'research', text: 'Rust is a programming language with a borrow checker.' });
ok(/Stored 0 texts/.test(t), 'the same text is not stored twice');
t = await tool({ action: 'search', query: 'european trip', collection: 'research' });
ok(/^1\. \[research( · test)?\] The capital of Portugal/.test(t), 'search by meaning inside a collection: ' + t.split('\n')[0].slice(0, 90));
ok(/similarity 0\.\d\d/.test(t), 'results show a similarity');
t = await tool({ action: 'search', query: 'borrow checker', mode: 'keyword' });
ok(/Rust is a programming language/.test(t) && !/similarity/.test(t), 'keyword mode');
t = await tool({ action: 'search', query: 'caffeinated drink', mode: 'semantic' });
ok(/oat milk lattes/.test(t.split('\n')[0]), 'semantic mode across every collection finds the memory: ' + t.split('\n')[0].slice(0, 80));
t = await tool({ action: 'compare', a: 'espresso', b: 'latte' });
const same = +/similarity ([\d.-]+)/.exec(t)[1];
t = await tool({ action: 'compare', a: 'espresso', b: 'Rust compiler' });
const other = +/similarity ([\d.-]+)/.exec(t)[1];
ok(same > 0.9 && other < 0.4, `compare: related ${same} vs unrelated ${other}`);
let threw = ''; try { await tool({ action: 'add', collection: 'memory', text: 'x' }); } catch (e) { threw = e.message; }
ok(/filled automatically/.test(threw), 'add refuses the automatic collections');
await page.evaluate(() => { vfs.write('/Projects/Garden.md', '# Garden\n\n## Plan\nPlant tomatoes and basil along the south fence before the first frost.\n', { mkdirs: true }); });
t = await tool({ action: 'index' });
ok(/Indexed the vault/.test(t) && /"notes" holds [1-9]/.test(t), t);
t = await tool({ action: 'search', query: 'basil', collection: 'notes' });
ok(/\[notes · Garden › Plan\].*tomatoes and basil/s.test(t), 'notes are searchable once indexed: ' + t.split('\n')[0].slice(0, 100));
t = await tool({ action: 'remove', collection: 'research', source: 'test' });
ok(/Removed 0 texts|Removed [1-9]/.test(t), 'remove by source: ' + t);
t = await tool({ action: 'remove', collection: 'research' });
st = await tool({ action: 'status' });
ok(!/research/.test(st), 'remove by collection: ' + st.split('\n').slice(1).join(' | '));
threw = ''; try { await tool({ action: 'nope' }); } catch (e) { threw = e.message; }
ok(/unknown action/.test(threw), 'unknown action is an error');

// 6. the index is a real SQLite file and survives a reload without embedding the notes again
await page.evaluate(() => __vmem.sync());
const f = await page.evaluate(() => { const b = vfs.readBytes('/Jade/.index/vectors.db'); return { n: b.length, head: String.fromCharCode(...b.subarray(0, 15)) }; });
ok(f.head === 'SQLite format 3' && f.n > 8192, 'vectors.db is saved in the vault (' + f.n + ' bytes)');
await page.evaluate(() => (vfs.save ? vfs.save() : null));
await page.waitForTimeout(800);
mock.calls.length = 0;
await page.reload(); await page.waitForFunction(() => window.__vmem, null, { timeout: 90000 }); await page.waitForTimeout(500);
t = await page.evaluate(async () => { const r = await runTool('memory', { action: 'search', text: 'caffeinated drink' }); return r; });
ok(/oat milk lattes/.test(t), 'after a reload the saved index still finds the memory by meaning');
ok(!mock.calls.some(c => c.input.some(x => x.startsWith('search_document: '))), 'nothing was embedded again after the reload (' + mock.calls.length + ' calls, queries only)');

// 7. a different embedding model (another size) rebuilds the vector table
await page.evaluate(() => { S.embedModel = 'tiny-embed'; });
t = await page.evaluate(async () => { const r = await __vmem.rebuild(); return { r, s: await runTool('embeddings', { action: 'status' }) }; });
ok(/tiny-embed \(3 numbers per text\)/.test(t.s) && /memory: 4 texts, 4 embedded/.test(t.s), 'model change: table recreated at 3 numbers: ' + t.s.split('\n')[0].slice(0, 100));
const tiny = mock.calls.filter(c => c.model === 'tiny-embed'); ok(tiny.length > 0 && !tiny.some(c => c.input.some(x => /^search_(document|query): /.test(x))), 'other models get no nomic prefixes (' + tiny.length + ' calls)');
await page.evaluate(() => { S.embedModel = 'nomic-embed-text'; });
await page.evaluate(() => __vmem.rebuild());

// 8. no Ollama / no model: keyword fallback, no breakage
mock.down = true;
hit = await page.evaluate(() => runTool('memory', { action: 'search', text: 'Forge' }));
ok(/Forge/.test(hit) && /\[keyword search only \(could not reach Ollama/.test(hit), 'Ollama down: keyword search with a note: ' + hit.split('\n')[0].slice(0, 120));
const sem = await page.evaluate(async () => { try { await runTool('embeddings', { action: 'search', query: 'espresso', mode: 'semantic' }); return 'no error'; } catch (e) { return e.message; } });
ok(/could not reach Ollama/.test(sem), 'semantic search says why it cannot run: ' + sem.slice(0, 80));
mock.down = false; mock.missing = true;
await page.evaluate(() => { __vmem.reset(); });
await page.evaluate(() => { S.embedModel = 'bge-m3'; });
hit = await page.evaluate(() => runTool('memory', { action: 'search', text: 'Forge' }));
ok(/Forge/.test(hit) && /ollama pull bge-m3/.test(hit), 'missing model: the note says how to install it');
ctxT = await page.evaluate(async () => { cur.messages = [{ role: 'user', content: 'how is the compiler going?' }]; await __vmem.prefetch(); return memoryContext(); });
ok(/Forge/.test(ctxT) && !/keywords and meaning/.test(ctxT), 'embeddings failing: the prompt still ranks (keywords only): ' + ctxT.split('\n')[2].slice(0, 110));
mock.missing = false;
await page.evaluate(() => { S.embedModel = 'nomic-embed-text'; S.embedOn = false; });
const off = await page.evaluate(async () => ({ names: activeTools().map(t => t.function.name), m: await runTool('memory', { action: 'search', text: 'Forge' }) }));
ok(!off.names.includes('embeddings') && /Forge/.test(off.m) && !/keyword search only/.test(off.m), 'embeddings off: no tool, the old word match answers');

// 9. settings
await page.evaluate(() => { S.embedOn = true; openSettings(); });
await page.waitForTimeout(400);
const ui = await page.evaluate(() => { const g = id => document.querySelector(id); return { on: g('#sEmbedOn')?.checked, model: g('#sEmbedModel')?.value, rag: g('#sMemoryRag')?.checked, btn: !!g('#btnEmbedRebuild') }; });
ok(ui.on && ui.model === 'nomic-embed-text' && ui.btn, 'settings show the embeddings section: ' + JSON.stringify(ui));
await page.evaluate(() => { document.querySelector('#sEmbedModel').value = 'nomic-embed-text'; document.querySelector('#btnEmbedRebuild').click(); });
await page.waitForFunction(() => /Works\.|Problem|Failed/.test(document.querySelector('#embedStatus').textContent), null, { timeout: 30000 });
const stTxt = await page.evaluate(() => document.querySelector('#embedStatus').textContent);
ok(/^Works\. sqlite-vec v0\.1\.9 · nomic-embed-text \(8\) · /.test(stTxt), 'test button: ' + stTxt);
await page.evaluate(() => { document.querySelector('#sEmbedModel').value = 'embeddinggemma'; document.querySelector('#sEmbedNotes').checked = true; document.querySelector('#btnSave').click(); });
await page.waitForTimeout(400);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jvault:settings') || '{}'));
ok(saved.embedModel === 'embeddinggemma' && saved.embedNotes === true && saved.embedOn === true, 'settings persist');
console.log(log.join('\n')); console.log('\n' + (fail.length ? fail.join('\n') : 'ALL PASS'));
await browser.close();
process.exit(fail.length ? 1 : 0);
