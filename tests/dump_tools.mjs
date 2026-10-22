// Not a test: writes the tool list the model sees (all optional tools switched on) to apps/jade-docs/data/tools.json,
// which scripts/build-docs-app.py turns into the tool reference pages.  Run:  node tests/run.mjs --dump-tools   or directly:
//   cd tests/.work && JV_WEB=… JV_NM=… NODE_PATH=… OUTF=../../apps/jade-docs/data/tools.json node ../dump_tools.mjs
const { start } = await import('./_harness.mjs');
const fs = await import('node:fs');
const { page, done } = await start({ settings: { curiosityOn: true, abOn: true } });
const tools = await page.evaluate(() => activeTools().map(t => ({ name: t.function.name, description: t.function.description, params: Object.entries((t.function.parameters || {}).properties || {}).map(([k, v]) => ({ name: k, type: v.type || '', description: v.description || '', enum: v.enum || null })), required: (t.function.parameters || {}).required || [] })));
fs.writeFileSync(process.env.OUTF || 'tools.json', JSON.stringify({ count: tools.length, tools }, null, 1)); await done();
