// Jade Docs: the app's own UI (stubbed webxdc), then the real thing in the host: install, ask → Jade wakes → docs_tool.js → answer.
import pw from 'playwright';
import fs from 'node:fs';
const { chromium } = pw;
const R = process.env.JV_WEB.replace(/\/dist\/jade-vault\.html$/, '');
const APPDIR = R + '/dist/jade-docs', XDC = R + '/dist/jade-docs.xdc', TOOL = R + '/apps/jade-docs/vault/docs_tool.js';
const URL_ = 'file://' + process.env.JV_WEB, css = fs.readFileSync('tw.css', 'utf8');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const log = [], fail = []; const ok = (c, m) => (c ? log : fail).push((c ? 'PASS ' : 'FAIL ') + m);
const browser = await chromium.launch();

/* ================= A. the app on its own ================= */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    const ups = [], ls = []; let n = 0;
    window.__sent = [];
    window.webxdc = { selfAddr: 'you@jade.vault', selfName: 'You', joinRealtimeChannel: () => ({ setListener: f => { window.__rt = f; }, send() {}, leave() {} }),
      sendUpdate: (u, d) => { window.__sent.push(u); window.__push(Object.assign({ sender: u.payload.author || 'you@jade.vault' }, u)); },
      setUpdateListener: (f, s) => { window.__lf = f; return Promise.resolve(); } };
    window.__push = u => { u.serial = ++n; u.timestamp = Math.floor(Date.now() / 1000); window.__lf && window.__lf(u); };
  });
  const page = await ctx.newPage(); page.on('pageerror', e => fail.push('[pageerror A] ' + e.message));
  await page.goto('file://' + APPDIR + '/index.html'); await page.waitForSelector('#page h1');
  const info = await page.evaluate(() => ({ n: window.DOCS.pages.length, ver: window.DOCS.version, title: document.querySelector('#page h1').textContent, tree: document.querySelectorAll('#tree .n').length }));
  ok(info.n > 100 && /^\d+\.\d+\.\d+$/.test(info.ver) && /overview/i.test(info.title) && info.tree > 5, 'the app loads the overview and a page tree: ' + JSON.stringify(info));
  // BM25: ranked results land on the right page
  const rank = async q => page.evaluate(q => window.__docs.search(q, 0, 5).map(r => r.d.page + '#' + r.d.anchor), q);
  const cases = [['skill router fifteen skills', 'skills'], ['schmidhuber learning progress noisy tv', 'curiosity'], ['PBKDF2 AES-GCM backup passphrase', 'backup-system'], ['accessibility service tap swipe screen reader', 'tool-screen'], ['exact-match replacements build.py MISSING', 'architecture'], ['hysteresis cooldown geofences', 'changelog-2-16-0'], ['reciprocal rank fusion', 'memory-and-search']];
  for (const [q, want] of cases) { const r = await rank(q); ok(r.slice(0, 3).some(x => x.startsWith(want)), `BM25 "${q}" finds ${want} in the top 3: ${r.slice(0, 3).join(', ')}`); }
  ok((await rank('zzzqqq xxyyzz')).length === 0, 'a nonsense query returns nothing');
  const lvl = await page.evaluate(() => window.__docs.search('backup', 4, 20).every(r => r.d.level === 4));
  ok(lvl, 'the level filter limits results');
  await page.fill('#q', 'backup encryption passphrase'); await page.waitForSelector('#results .hit');
  const hit = await page.evaluate(() => ({ n: document.querySelectorAll('#results .hit').length, mark: !!document.querySelector('#results mark'), score: !!document.querySelector('#results .sc') }));
  ok(hit.n > 2 && hit.mark && hit.score, 'the Search tab shows ranked hits with highlights and scores: ' + JSON.stringify(hit));
  await page.click('#results .hit'); await page.waitForSelector('#browse:not([hidden]) #page h1');
  ok(await page.evaluate(() => !document.querySelector('#browse').hidden && /./.test(document.querySelector('#page h1').textContent)), 'clicking a hit opens the page');
  await page.fill('#q', ''); await page.click('#clearq').catch(() => {});
  // levels
  await page.click('[data-lv="4"]'); const l4 = await page.evaluate(() => [...document.querySelectorAll('#tree .n')].length);
  await page.click('[data-lv="0"]'); const l0 = await page.evaluate(() => [...document.querySelectorAll('#tree .n')].length);
  ok(l4 > 0 && l4 !== l0, 'the level buttons filter the tree: ' + l4 + ' vs ' + l0);
  // rendering is safe
  const safe = await page.evaluate(() => { const h = window.__docs.md('# T\n\n<script>alert(1)</script> **b** [x](javascript:alert(1)) `<img src=x onerror=1>`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - two\n\n```js\n<b>raw</b>\n```'); return { script: /<script/.test(h), js: /javascript:/.test(h) && /href/.test(h.match(/<a[^>]*javascript[^>]*>/)?.[0] || ''), table: /<table>/.test(h), nested: (h.match(/<ul>/g) || []).length === 2 }; });
  ok(!safe.script && !safe.js && safe.table && safe.nested, 'markdown rendering escapes HTML, rejects javascript: links, and does tables and nested lists: ' + JSON.stringify(safe));
  // ask Jade: payload and notify
  await page.click('#tabs [data-view=ask]'); await page.fill('#asktext', 'What does the skill router do?'); await page.click('#asksend');
  await page.waitForSelector('.msg.me');
  const sent = await page.evaluate(() => window.__sent.at(-1));
  ok(sent.payload.type === 'ask' && sent.payload.text === 'What does the skill router do?' && sent.payload.page && Array.isArray(sent.payload.top) && sent.payload.top.length > 0 && sent.notify['jade@jade.vault'].startsWith('What does'), 'asking sends {ask, text, page, top hits} with notify for Jade: ' + JSON.stringify(sent).slice(0, 220));
  ok(/thinking/i.test(await page.textContent('#statusText')), 'status shows that Jade is thinking');
  const askId = sent.payload.id;
  await page.evaluate(id => window.__push({ sender: 'jade@jade.vault', payload: { type: 'answer', to: id, text: 'It lists only the **best 6** skills. See [skills](#doc:skills#the-router-217).', refs: ['skills', 'tool-nope'], goto: 'skills', why: 'details' } }), askId);
  await page.waitForSelector('.msg.jade');
  const ans = await page.evaluate(() => ({ html: document.querySelector('.msg.jade').innerHTML, refs: [...document.querySelectorAll('.msg.jade .refs a')].map(a => a.textContent), goto: !!document.querySelector('#goto'), status: document.querySelector('#statusText').textContent }));
  ok(/<strong>best 6<\/strong>/.test(ans.html) && ans.refs.length === 1 && ans.goto && ans.status === 'ready', 'her answer renders, unknown refs are dropped, the suggestion banner shows, status clears: ' + JSON.stringify(ans).slice(0, 200));
  // a plain "msg" (Jade's fallback) is attached to the open question
  await page.fill('#asktext', 'second question'); await page.click('#asksend'); await page.waitForTimeout(100);
  await page.evaluate(() => window.__push({ sender: 'jade@jade.vault', payload: { type: 'msg', text: 'plain reply' } })); await page.waitForTimeout(250);
  const pair = await page.evaluate(() => [...document.querySelectorAll('#thread .msg')].map(m => m.className.replace('msg ', '') + ':' + m.textContent.replace(/\s+/g, ' ').slice(0, 25)));
  ok(pair.length === 4 && pair[3].startsWith('jade:'), 'a plain msg from Jade lands under the question it answers: ' + pair.join(' | '));
  // notes, bookmarks, page edits
  await page.click('#tabs [data-view=browse]'); await page.fill('.noteform input', 'remember to read this'); await page.click('.noteform .btn');
  await page.waitForSelector('#page .note', { timeout: 4000 }).catch(async () => { console.log('DBG', JSON.stringify(await page.evaluate(() => ({ hidden: document.querySelector('#browse').hidden, view: window.__docs.S.view, page: window.__docs.S.page, notes: window.__docs.S.notes, sent: window.__sent.length, form: !!document.querySelector('.noteform'), html: document.querySelector('#page').innerHTML.slice(-300) })))); });
  await page.evaluate(() => window.__push({ sender: 'jade@jade.vault', payload: { type: 'note', page: window.__docs.S.page, text: 'Jade says hi' } })); await page.waitForTimeout(250);
  ok(await page.evaluate(() => document.querySelectorAll('#page .note').length === 2 && document.querySelector('#noteCount').textContent === '(2)'), 'notes from both sides show on the page and are counted');
  await page.click('[data-act=mark]'); await page.waitForFunction(() => /Bookmarked/.test(document.querySelector('[data-act=mark]').textContent));
  await page.evaluate(() => window.__push({ sender: 'jade@jade.vault', payload: { type: 'page', op: 'set', id: 'zebra-page', title: 'Zebra facts', parent: 'overview', level: 2, md: '# Zebra facts\n\nThe quagga hibiscus is documented here.' } })); await page.waitForTimeout(250);
  await page.fill('#q', 'quagga hibiscus'); await page.waitForSelector('#results .hit');
  ok(await page.evaluate(() => /Zebra facts/.test(document.querySelector('#results .hit').textContent)), 'a page Jade adds is searchable at once');
  await page.evaluate(() => window.__push({ sender: 'jade@jade.vault', payload: { type: 'page', op: 'set', id: 'skills', title: 'Skills (edited)', md: '# Skills (edited)\n\nNew text.' } })); await page.waitForTimeout(250);
  await page.fill('#q', ''); await page.click('#tabs [data-view=browse]'); await page.evaluate(() => window.__docs.openDoc('skills'));
  ok(await page.evaluate(() => /edited/.test(document.querySelector('#page .badge.ed')?.textContent || '') && /New text/.test(document.querySelector('#page').textContent)), 'an edited page shows the edited badge and the new text');
  await page.screenshot({ path: 'docs_app.png' });
  await ctx.close();
}

/* ================= B. in the host: install, ask, Jade answers with docs_tool.js ================= */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'America/Detroit' });
  await ctx.addInitScript(() => { try { if (window !== window.top) return; } catch {} if (!localStorage.getItem('jvault:settings')) localStorage.setItem('jvault:settings', JSON.stringify({ model: 'qwen3:8b', journalOn: false, askRisky: false })); });
  const page = await ctx.newPage(); page.on('pageerror', e => fail.push('[pageerror B] ' + e.message));
  const wakes = []; const toolOut = [];
  await ctx.route('**/*', async route => {
    const req = route.request(), url = req.url();
    if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (url.startsWith('https://cdn.tailwindcss.com/')) return route.fulfill({ contentType: 'text/javascript', body: `window.tailwind={};(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.prepend(s)})()` });
    if (url.includes('marked.min.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.JV_NM + 'marked/lib/marked.umd.js', 'utf8') });
    if (url.includes('purify.min.js')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.JV_NM + 'dompurify/dist/purify.min.js', 'utf8') });
    if (url === 'http://localhost:11434/api/tags') return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ models: [{ name: 'qwen3:8b' }] }) });
    if (url === 'http://localhost:11434/api/chat') {
      const b = JSON.parse(req.postData()); if (!b.stream) return route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ message: { role: 'assistant', content: 'SUMMARY:\n- x\nREMEMBER:\n- none' }, done: true }) });
      const li = b.messages.findLastIndex(m => m.role === 'user'), u = b.messages[li].content, tools = b.messages.slice(li).filter(m => m.role === 'tool'), k = tools.length;
      let step; const bash = command => ({ tool_calls: [{ function: { name: 'bash', arguments: { command } } }] });
      if (u.includes('[webxdc app "Jade Docs"')) {
        if (k === 0) wakes.push(u);
        const askId = /"id":"(m[\w]+)"/.exec(u)?.[1] || 'x';
        if (k === 0) step = bash('node /Jade/Tools/docs_tool.js sync');
        else if (k === 1) { toolOut.push(tools[0].content); step = bash('node /Jade/Tools/docs_tool.js pending'); }
        else if (k === 2) { toolOut.push(tools[1].content); step = bash(`node /Jade/Tools/docs_tool.js answer ${askId} text="<script>x</script> bad" refs=skills`); }
        else if (k === 3) { toolOut.push(tools[2].content); step = bash(`node /Jade/Tools/docs_tool.js answer ${askId} text="Only the best **6** skills are listed; the rest are found with find_skill." refs=skills,nonexistent-page`); }
        else if (k === 4) { toolOut.push(tools[3].content); step = bash(`node /Jade/Tools/docs_tool.js answer ${askId} text="Only the best **6** skills are listed; the rest are found with find_skill." refs=skills,tool-skill goto=skills`); }
        else { toolOut.push(tools[4].content); step = { content: 'Answered in the app.' }; }
        await new Promise(r => setTimeout(r, 300));
      } else step = { content: 'main chat reply' };
      return route.fulfill({ headers: CORS, contentType: 'application/x-ndjson', body: JSON.stringify({ message: { role: 'assistant', content: step.content || '', ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) }, done: false }) + '\n' + JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n' });
    }
    return route.abort();
  });
  await page.goto(URL_);
  await page.waitForFunction(() => typeof appsTool === 'function' && typeof userShell !== 'undefined' && typeof vfs !== 'undefined', null, { timeout: 90000 });
  await page.evaluate(([x, t]) => { const bin = Uint8Array.from(atob(x), c => c.charCodeAt(0)); vfs.write('/Apps/jade-docs.xdc', bin, { mkdirs: true }); }, [fs.readFileSync(XDC).toString('base64'), '']);
  const inst = await page.evaluate(() => appsTool({ action: 'install', path: '/Apps/jade-docs.xdc' }));
  ok(/Installed Jade Docs/.test(inst), 'the .xdc installs: ' + inst.slice(0, 80));
  // Jade installs the tool and the skill from the app itself
  const boot = await page.evaluate(async () => { const t = await appsTool({ action: 'source', app: 'Jade Docs', file: 'vault/docs_tool.js' }), k = await appsTool({ action: 'source', app: 'Jade Docs', file: 'vault/skills/document/SKILL.md' }); vfs.write('/Jade/Tools/docs_tool.js', t, { mkdirs: true }); vfs.write('/Jade/skills/document/SKILL.md', k, { mkdirs: true }); return { tool: t.length, skill: /^---\nname: document/.test(k), listed: listSkills().some(s => s.name === 'document') }; });
  ok(boot.tool > 8000 && boot.skill && boot.listed, 'the tool and the skill can be installed from the app, and the skill is picked up: ' + JSON.stringify(boot));
  const src = await page.evaluate(() => appsTool({ action: 'source', app: 'Jade Docs', file: 'index.json' }));
  ok(!/truncated/.test(src) && JSON.parse(src).count > 100, 'index.json can be read through the apps tool without truncation');
  const rd = await page.evaluate(() => appsTool({ action: 'source', app: 'Jade Docs', file: 'pages/skills.md' }));
  ok(/Skills and the skill router/.test(rd), 'a page can be read on its own');
  const sh = async c => page.evaluate(async c => { const s = new (Object.getPrototypeOf(userShell).constructor)({}); s.timeoutMs = 60000; const r = await s.run(c); return { out: r.chunks.filter(x => !x.err).map(x => x.s).join(''), err: r.chunks.filter(x => x.err).map(x => x.s).join(''), code: r.code }; }, c);
  // the tool, by itself
  let r = await sh('node /Jade/Tools/docs_tool.js sync'); ok(/Synced \d+ pages/.test(r.out), 'docs_tool sync copies the pages: ' + (r.out + r.err).slice(0, 100));
  r = await sh('node /Jade/Tools/docs_tool.js sync'); ok(/0 fetched/.test(r.out), 'a second sync fetches nothing: ' + r.out.slice(0, 80));
  r = await sh('node /Jade/Tools/docs_tool.js search "reciprocal rank fusion hybrid" k=3'); ok(/memory-and-search/.test(r.out.split('\n').slice(0, 2).join(' ')), 'docs_tool search ranks the right page first: ' + r.out.split('\n')[0]);
  r = await sh('node /Jade/Tools/docs_tool.js page backup-system section="The server"'); ok(/jade-backup-server\.py/.test(r.out) && !/Manual export/.test(r.out), 'docs_tool page --section prints only that section');
  const bad = async (json, re, why) => { const f = '/tmp/p' + Math.random().toString(36).slice(2) + '.json'; await page.evaluate(([f, j]) => vfs.write(f, j, { mkdirs: true }), [f, json]); const x = await sh(`node /Jade/Tools/docs_tool.js validate @${f}`); ok(re.test(x.out + x.err) && !/^valid/m.test(x.out), 'validate rejects ' + why + ': ' + (x.out + x.err).replace(/\n/g, ' | ').slice(0, 120)); };
  await bad('{"type":"answer","text":"hi","to":"nothing"}', /no question with id/, 'an answer to an unknown question');
  await bad('{"type":"answer","to":"x"}', /"text" is required/, 'an answer without text');
  await bad('{"type":"ask","text":"x"}', /sent by the user/, 'a payload only the user sends');
  await bad('{"type":"wibble"}', /unknown type/, 'an unknown type');
  await bad('{"type":"note","page":"no-such-page","text":"x"}', /does not exist/, 'a note on a missing page');
  await bad('{"type":"page","op":"set","id":"Bad Id","title":"t","md":"# t\\n<iframe src=x></iframe>"}', /lowercase|raw HTML/, 'a page with an invalid id / raw HTML');
  await bad('{"type":"page","op":"set","id":"p1","title":"t","md":"# t","parent":"ghost"}', /parent "ghost"/, 'a page with a missing parent');
  // the round trip
  await page.tap('.tab[data-tab="apps"]'); await page.click('.app-tile:has-text("Jade Docs") .app-open');
  const fr = page.frameLocator('#xdcOverlay iframe'); await fr.locator('#page h1').waitFor({ timeout: 10000 });
  await fr.locator('#tabs [data-view=ask]').click(); await fr.locator('#asktext').fill('How many skills does the router list?'); await fr.locator('#asksend').click();
  await fr.locator('.msg.jade').waitFor({ timeout: 40000 });
  await page.waitForFunction(() => !XWAKE.busy, null, { timeout: 30000 });
  const out = await fr.locator('body').evaluate(() => ({ jade: [...document.querySelectorAll('.msg.jade')].map(m => m.innerHTML), refs: [...document.querySelectorAll('.msg.jade .refs a')].map(a => a.textContent), n: document.querySelectorAll('.msg.jade').length, banner: !!document.querySelector('#goto') }));
  ok(wakes.length === 1 && /"type":"ask"/.test(wakes[0]) && /Jade Docs: protocol for Jade/.test(wakes[0]), 'the question wakes Jade with the ask payload and the app README');
  ok(/pending|ask m/.test(toolOut[1] || '') && /How many skills/.test(toolOut[1] || '') && /skills/.test(toolOut[1] || ''), 'docs_tool pending shows the question and the best pages: ' + (toolOut[1] || '').replace(/\n/g, ' | ').slice(0, 160));
  ok(/INVALID/.test(toolOut[2] || '') && /raw HTML/.test(toolOut[2] || ''), 'an answer with raw HTML is refused before it reaches the app');
  ok(/INVALID/.test(toolOut[3] || '') && /nonexistent-page/.test(toolOut[3] || ''), 'an answer pointing at a page that does not exist is refused');
  ok(/Sent update/.test(toolOut[4] || ''), 'the valid answer is sent: ' + (toolOut[4] || '').slice(0, 80));
  ok(out.n === 1 && /<strong>6<\/strong>/.test(out.jade[0]) && out.refs.length === 2 && out.banner, 'only the checked answer reaches the app, with its page links and the suggestion banner: ' + JSON.stringify({ refs: out.refs, n: out.n, banner: out.banner }));
  await page.screenshot({ path: 'docs_host.png' });
  await ctx.close();
}
await browser.close();
for (const l of log) console.log(l); for (const f of fail) console.log(f);
console.log(fail.length ? 'FAILED ' + fail.length : 'ALL PASS');
process.exit(fail.length ? 1 : 0);
