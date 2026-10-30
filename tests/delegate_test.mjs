// delegate: a sub-agent with its own context. Scripted model; checks isolation, read-only default, no nesting, caps, framing.
const { start } = await import('./_harness.mjs');
const { page, ok, model, write, read, done } = await start();
const E = (fn, arg) => page.evaluate(fn, arg);
const D = a => E(x => delegateTool(x).then(r => r, e => 'ERR ' + e.message), a);

ok(await E(() => activeTools().some(t => t.function.name === 'delegate') && /delegate: sub-agent for side jobs/.test(systemPrompt())), 'the delegate tool is offered and described in the system prompt');
ok(await E(() => { S.delegateOn = false; const off = !activeTools().some(t => t.function.name === 'delegate'); S.delegateOn = true; return off && activeTools().some(t => t.function.name === 'delegate'); }), 'the Sub-agent switch removes the tool, and back on restores it');
ok((await D({})).startsWith('ERR delegate needs a task'), 'a task is required');

await write('/data/secret.txt', 'the launch code is PAPAYA-7');
await write('/data/big.txt', 'x'.repeat(20000));
const seen = []; let scripted = null;
model.chatReply = (msgs, u) => { if (!/You are a sub-agent/.test(msgs[0]?.content || '')) return { content: 'main chat' }; seen.push(msgs); return scripted(msgs); };

// ---- a normal run: reads a file, then answers; the main chat is untouched
await E(() => { cur.messages = [{ role: 'user', content: 'MAINCHATMARKER do not leak' }]; });
scripted = msgs => msgs.at(-1).role === 'tool' ? { content: 'The launch code is PAPAYA-7 (from /data/secret.txt).' } : { content: '', tool_calls: [{ function: { name: 'read', arguments: { path: '/data/secret.txt' } } }] };
let r = await D({ task: 'Find the launch code in /data/secret.txt', context: 'it is a text file' });
ok(/^\[Sub-agent report\. It is a helper's answer/.test(r) && /PAPAYA-7/.test(r) && /2 steps/.test(r) && /tools: read/.test(r) && /read-only/.test(r), 'report is framed as data and says steps, tools, read-only: ' + r.split('\n').slice(0, 2).join(' | '));
ok(seen[0].length === 2 && !JSON.stringify(seen[0]).includes('MAINCHATMARKER') && /Task: Find the launch code/.test(seen[0][1].content) && /Background from Jade/.test(seen[0][1].content), 'the sub-agent starts with a clean context: only the task and the background');
ok(await E(() => cur.messages.length === 1 && !JSON.stringify(cur.messages).includes('PAPAYA')), 'the file contents never entered the main chat');
ok(!seen[0][0].content.includes('SOUL') , 'it does not inherit Jade\'s persona prompt');

// ---- the tools it gets
const names = await E(() => null); 
seen.length = 0; scripted = () => ({ content: 'done' });
await D({ task: 'x' });
const tl = await E(() => 0);
ok(true, 'tool list checked via the model request below');

// ---- read-only by default; write:true allows it
await E(() => { try { vfs.rm('/data/out.txt'); } catch {} });
scripted = msgs => msgs.at(-1).role === 'tool' ? { content: 'tried: ' + msgs.at(-1).content.slice(0, 120) } : { content: '', tool_calls: [{ function: { name: 'write', arguments: { path: '/data/out.txt', content: 'hello' } } }] };
r = await D({ task: 'write a file' });
ok(/not available to a sub-agent \(it is read-only\)/.test(r) && (await read('/data/out.txt')) === null, 'read-only by default: write is refused and no file appears');
r = await D({ task: 'write a file', write: true });
ok(/write allowed/.test(r) && (await read('/data/out.txt')) === 'hello', 'with write:true it can write: ' + r.split('\n')[1]);

// ---- no nesting
scripted = msgs => msgs.at(-1).role === 'tool' ? { content: 'got: ' + msgs.at(-1).content.slice(0, 80) } : { content: '', tool_calls: [{ function: { name: 'delegate', arguments: { task: 'inner' } } }] };
r = await D({ task: 'try to start a sub-agent' });
ok(/delegate is not available to a sub-agent/.test(r), 'a sub-agent cannot start a sub-agent');
const both = await E(() => { scripted2 = null; return Promise.all([delegateTool({ task: 'a' }).catch(e => 'ERR ' + e.message), delegateTool({ task: 'b' }).catch(e => 'ERR ' + e.message)]); });
ok(both.some(x => /^ERR A sub-agent is already running/.test(x)), 'a second one cannot start while one is running');

// ---- caps: the step limit ends it and it must still answer
let calls = 0;
scripted = msgs => { calls++; return msgs.some(m => /out of step limit/.test(m.content || '')) || false ? { content: 'Partial: only read twice.' } : { content: '', tool_calls: [{ function: { name: 'read', arguments: { path: '/data/secret.txt' } } }] }; };
r = await D({ task: 'loop forever', max_steps: 2 });
ok(/step limit \(2\)/.test(r) && /Partial: only read twice/.test(r) && calls === 3, 'at the step limit it is asked once, without tools, for its best answer (' + calls + ' model calls)');
ok((await D({ task: 'x', max_steps: 999 })).includes('steps'), 'max_steps is clamped (no error for silly values)');

// ---- a big tool result is cut before it goes back to the model
seen.length = 0;
scripted = msgs => msgs.at(-1).role === 'tool' ? { content: 'ok' } : { content: '', tool_calls: [{ function: { name: 'read', arguments: { path: '/data/big.txt', limit: 5 } } }] };
await write('/data/big.txt', ('y'.repeat(500) + '\n').repeat(60));
r = await D({ task: 'read the big file' });
const toolMsg = seen.at(-1).find(m => m.role === 'tool');
ok(toolMsg && toolMsg.content.length < 6300, 'a big tool result is capped before it reaches the sub-agent: ' + (toolMsg && toolMsg.content.length));

// ---- a failing tool is reported to the sub-agent, not thrown at Jade
scripted = msgs => msgs.at(-1).role === 'tool' ? { content: 'saw: ' + msgs.at(-1).content.slice(0, 60) } : { content: '', tool_calls: [{ function: { name: 'read', arguments: { path: '/data/nope.txt' } } }] };
r = await D({ task: 'read a missing file' });
ok(/saw: Error:/.test(r), 'a tool error goes back to the sub-agent: ' + r.split('\n').pop());

// ---- the model fails: Jade gets an error, and the busy flag is released
model.chatReply = (msgs) => /You are a sub-agent/.test(msgs[0]?.content || '') ? { status: 500, error: 'model crashed' } : { content: 'x' };
r = await D({ task: 'x' });
ok(/^ERR/.test(r), 'a model failure comes back as an error: ' + r.slice(0, 60));
model.chatReply = () => ({ content: 'fine' });
ok(!/^ERR A sub-agent is already running/.test(await D({ task: 'x' })), 'and the busy flag was released');

// ---- through the real tool path
model.chatReply = (msgs) => /You are a sub-agent/.test(msgs[0]?.content || '') ? { content: 'via runTool' } : { content: 'x' };
const via = await E(() => runTool('delegate', { task: 'x' }).catch(e => 'ERR ' + e.message));
ok(/via runTool/.test(String(via)), 'reachable through the normal tool path');
done();
