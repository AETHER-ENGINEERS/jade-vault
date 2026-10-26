// The Rust core must give the same answers as the page's JavaScript.
// - Note parsing and search: on the phone they run natively (rust/core vault.rs via libjade). Here the same Rust code
//   runs as a small program on this machine (rust/core/examples/vault_cli.rs) and is compared with the page.
// - Web pages to Markdown (WebAssembly, in the page): checked directly.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { start } = await import('./_harness.mjs');
const { page, ok, done } = await start();
const E = (fn, arg) => page.evaluate(fn, arg);

const NOTES = {
  '/r/Plan.md': '# Plan\nSee [[Project Neon]] and [[ideas/Lamp|the lamp]] #work #Work/deep-\n![[photo.png]] ![[Other.md]]\n[x](notes/a%20b.md) [y](https://e.com/z.md) [bad](c%ZZ.md)\n```\n[[not a link]] #nope\n```\n`#code` $#m$ and $$\n#gone\n$$',
  '/r/Project Neon.md': 'Neon neon NEON aaa aaaa — café #ünïcode #ok_tag (#paren) [[Plan#Goals]] [[ Plan ]]\n'.repeat(3),
  '/r/ideas/Lamp.md': '~~~\nfenced [[x]]\n~~~\nlamp lamp-post lampshade #ideas/light 😀 emoji then lamp\n' + 'filler words here '.repeat(40) + ' lamp at the end',
  '/r/notes/a b.md': 'tabs\tand nbsp em-space words #a-b- [[Missing One]] [[Project Neon]]',
  '/r/empty.md': '',
};
const QUERIES = ['neon', 'lamp', 'aa', 'café', '#ideas', '#ok_tag', 'words here', 'zzz', 'plan', '  '];
const js = await E(({ NOTES, QUERIES }) => {
  for (const [p, t] of Object.entries(NOTES)) vfs.write(p, t, { mkdirs: true });
  VaultParsed.clear(); Vault.dirty = true; Vault.index = null;
  const parsed = {}; for (const p of Object.keys(NOTES)) { const e = noteParse(p); parsed[p] = { wiki: e.wiki, md: e.md, tags: [...e.tags], words: e.words }; }
  const idx = vaultIndex();
  const notes = Object.keys(NOTES).filter(p => idx.notes.includes(p));
  const backlinks = {}; for (const p of notes) { const n = idx.back.get(p)?.size || 0; if (n) backlinks[p] = n; }
  const tags = {}; for (const [t, st] of idx.tags) tags[t] = [...st].filter(p => p.startsWith('/r/'));
  const search = {}; for (const q of QUERIES) search[q] = searchNotes(q, 10).filter(h => h.path.startsWith('/r/'));
  return { parsed, backlinks, tags, search, notes };
}, { NOTES, QUERIES });

let rust = null;
try {
  const out = execFileSync('cargo', ['run', '-q', '--release', '-p', 'jade-core', '--example', 'vault_cli'], { cwd: path.join(ROOT, 'rust'), input: JSON.stringify({ notes: Object.fromEntries(js.notes.map(p => [p, NOTES[p]])), queries: QUERIES, backlinks: js.backlinks, tags: js.tags }), maxBuffer: 1 << 26 });
  rust = JSON.parse(out.toString());
} catch (e) { console.log('NOTE: no Rust toolchain here, the parse/search comparison is skipped (' + e.message.split('\n')[0] + ')'); }
if (rust) {
  for (const p of Object.keys(NOTES)) { const a = JSON.stringify(js.parsed[p]), b = JSON.stringify(rust.parsed[p]); ok(a === b, `parse ${p}: ${b}${a === b ? '' : ' JS ' + a}`); }
  for (const q of QUERIES) { const a = JSON.stringify(js.search[q]), b = JSON.stringify(rust.search[q]); ok(a === b, `search "${q}": ${js.search[q].length} hits${a === b ? '' : ' RUST ' + b + ' JS ' + a}`); }
}

// web pages to Markdown, in WebAssembly in the page
const ready = await E(async () => { await RustCore.init(); return RustCore.ready; });
ok(ready, 'the WebAssembly core loads');
const md = await E(() => JSON.parse(RustCore.w.html_markdown('<html><head><title>T</title></head><body><nav>menu</nav><p>Hi <a href="b">x</a> &amp; <b>more</b></p><script>bad()</script></body></html>', 'https://e.test/a/')));
ok(md.title === 'T' && md.text === 'Hi [x](https://e.test/a/b) & **more**', 'web pages become Markdown: ' + JSON.stringify(md));
await done();
