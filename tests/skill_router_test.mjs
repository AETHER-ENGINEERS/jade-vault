// Skill router: few skills are listed in full as before; many skills -> only the best matches go in the prompt, found by
// keywords + meaning (vector index, collection "skills"); find_skill searches the rest; usage counters are kept.
const { start } = await import('./_harness.mjs');
const { page, ok, model, write, done } = await start({ settings: { memoryOn: true, embedOn: true } });
const E = (fn, arg) => page.evaluate(fn, arg);

// fake embedding model: concepts share a direction (so "tax filing" finds "invoice" skills with no shared words)
const CONCEPTS = [['invoice', 'billing', 'tax', 'taxes', 'filing', 'accounting'], ['recipe', 'cook', 'dinner', 'kitchen', 'meal'], ['workout', 'gym', 'exercise', 'fitness', 'run'], ['travel', 'flight', 'hotel', 'trip', 'itinerary']];
await page.exposeFunction('__noop', () => {});
model.embed = t => { const w = t.toLowerCase().replace(/^(search_query|search_document): /, '').split(/[^a-z]+/).filter(Boolean); const v = [0, 0, 0, 0, 0.01]; for (const x of w) CONCEPTS.forEach((c, i) => { if (c.includes(x)) v[i] += 1; }); return v; };

const mk = (n, d) => write(`/Jade/skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: ${d}\n---\n1. do ${n}\n`);
await E(() => { for (const k of [...vfs.nodes.keys()]) if (/^\/jade\/skills\//i.test(k) && vfs.isFile(k)) vfs.rm(k); });
const base = await E(() => listSkills().length);
ok(base <= 15, 'starting point: few skills (' + base + ')');

// ---- few skills: unchanged behaviour
await mk('invoice-helper', 'Prepare an invoice for a client. Use when billing.');
let r = await E(async () => { await skillPrefetch(); return { routed: skillRouted(), sp: systemPrompt(), tools: activeTools().map(t => t.function.name) }; });
ok(!r.routed && /- invoice-helper: Prepare an invoice/.test(r.sp) && !r.tools.includes('find_skill') && !/find_skill/.test(r.sp), 'few skills: all listed, no find_skill tool, no router note');

// ---- many skills
const topics = [['recipe-planner', 'Plan a dinner recipe and shopping list. Use when cooking a meal.'], ['gym-log', 'Log a workout at the gym. Use for exercise tracking.'], ['trip-planner', 'Build a travel itinerary with flights and hotel. Use for a trip.']];
for (const [n, d] of topics) await mk(n, d);
for (let i = 0; i < 20; i++) await mk('filler-' + i, `Generic helper number ${i} for something unrelated and bland.`);
await E(() => { ls.set('skillStats', {}); });
r = await E(async () => ({ n: listSkills().length, routed: skillRouted(), tools: activeTools().map(t => t.function.name) }));
ok(r.n > 15 && r.routed && r.tools.includes('find_skill'), 'many skills: routed, and find_skill is offered (' + r.n + ' skills)');

// a chat message about taxes: the invoice skill is found by meaning although it shares no word with "taxes filing"
await E(() => { cur.messages = [{ role: 'user', content: 'my taxes and filing' }]; });
r = await E(async () => { await skillPrefetch(); const sp = systemPrompt(); const m = /Skills \(instruction packs[\s\S]*?(?=\nTo create a skill)/.exec(sp); return { block: m ? m[0] : '', names: skillCtxGet().names }; });
ok(r.names.length <= 6 && r.names.includes('invoice-helper'), 'the best matches are chosen by meaning: ' + JSON.stringify(r.names));
ok(/invoice-helper/.test(r.block) && !/filler-1[0-9]/.test(r.block) && /You have \d+ skills/.test(r.block) && /find_skill/.test(r.block), 'only matches are in the prompt, with a note about the rest');
ok((r.block.match(/^- /gm) || []).length <= 7, 'the prompt stays small: ' + (r.block.match(/^- /gm) || []).length + ' lines');
ok(r.names.length === 0 || model.embedCalls > 0, 'the fake embedding model was really used (' + model.embedCalls + ' calls)');

// next message, different topic: the list follows the message
await E(() => { cur.messages.push({ role: 'user', content: 'plan dinner, I want a recipe' }); });
r = await E(async () => { await skillPrefetch(); return skillCtxGet().names; });
ok(r[0] === 'recipe-planner', 'a new message changes the list: ' + JSON.stringify(r));

// find_skill
let f = await E(() => findSkillTool({ query: 'book a flight and a hotel for a trip' }).catch(e => 'ERR ' + e.message));
ok(/trip-planner/.test(f) && f.split('\n')[1].startsWith('- trip-planner'), 'find_skill returns the matching skill first: ' + f.split('\n')[1]);
f = await E(() => findSkillTool({ query: '' }).catch(e => 'ERR ' + e.message));
ok(/ERR find_skill needs a query/.test(f), 'find_skill needs a query');
const viaRun = await E(() => runTool('find_skill', { query: 'workout at the gym' }).catch(e => 'ERR ' + e.message));
ok(/gym-log/.test(String(viaRun && (viaRun.content || viaRun))), 'find_skill is reachable through the normal tool path');

// usage counters
await E(() => runTool('skill', { name: 'trip-planner' }));
const st = await E(() => ls.get('skillStats', {})); 
ok(st['trip-planner'].used === 1 && st['trip-planner'].found >= 1 && (st['invoice-helper'] || {}).offered >= 1, 'offered / found / used are counted: ' + JSON.stringify(st['trip-planner']));

// switched-off skills are not routed to; editing a description re-indexes
await E(() => { ls.set('skillsOff', ['trip-planner']); });
f = await E(() => findSkillTool({ query: 'travel trip flight' }));
ok(!/trip-planner/.test(f), 'a switched-off skill is not suggested');
await E(() => { ls.set('skillsOff', []); });
await mk('trip-planner', 'Work out the cooking recipe for a dinner party.');
f = await E(() => findSkillTool({ query: 'cook dinner recipe' }));
ok(/trip-planner/.test(f), 'after editing a description the index follows (the skill now matches cooking)');

// no embedding model at all: keyword search still works
model.embed = null;
await mk('zebra-counter', 'Count zebras at the savannah crossing.');
f = await E(() => findSkillTool({ query: 'zebras crossing' }));
ok(/zebra-counter/.test(f), 'without an embedding model, keyword / word-overlap search still finds it: ' + f.split('\n')[1]);

// context report accounts the routed list, and /skills still lists everything
const c = await E(() => ({ rep: typeof contextReport === 'function' ? contextReport() : '', all: listSkills().length }));
ok(c.all > 20, 'the skills themselves are all still there (' + c.all + ')');
done();
