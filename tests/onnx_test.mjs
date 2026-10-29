// ONNX Runtime Web (the onnx tool) on WebGPU and on the CPU, with the app's own copy of the runtime (assets/ort/,
// as on the phone), and LiteRT choosing WebGPU by itself when the device has it. Chromium's software WebGPU here.
import path from 'node:path';
import fs from 'node:fs';
process.env.JV_ARGS = '--allow-file-access-from-files --enable-unsafe-webgpu';
const { start } = await import('./_harness.mjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { page, ok, done } = await start();
const E = (fn, arg) => page.evaluate(fn, arg);
const T = (name, args) => E(([n, a]) => worldTool(n, a).then(r => r, e => 'ERR ' + e.message), [name, args]);
const J = async (name, args) => { const r = await T(name, args); try { return JSON.parse(r); } catch { return r; } };
await E((assets) => { window.__JADE_ASSETS = assets; S.sensesOn = true; }, 'file://' + path.join(ROOT, 'android/proj/assets') + '/');

ok(await E(() => activeTools().some(t => t.function.name === 'onnx')), 'onnx is in Jade\'s tool list');
ok(await E(() => /onnx: run \.onnx models/.test(systemPrompt())), 'Jade\'s instructions mention it');
const st = await J('onnx', { action: 'status' });
ok(st.runtime === 'onnxruntime-web 1.31.1' && st.webgpu === true && st.threads === 1, 'ONNX Runtime 1.31.1 loads from the app\'s own files and sees WebGPU: ' + JSON.stringify(st));

// Y = X·W + B with W = [[1,0,0],[0,1,0],[0,0,1],[1,1,1]], B = [0.5,-1,10]; X has a flexible batch size N
const model = Array.from(fs.readFileSync(path.join(ROOT, 'tests/fixtures/tiny_matmul.onnx')));
await E(b => { vfs.write('/models/tiny.onnx', new Uint8Array(b), { mkdirs: true }); }, model);
const ld = await J('onnx', { action: 'load', model: '/models/tiny.onnx', id: 'tiny' });
ok(ld.id === 'tiny' && ld.accelerator === 'webgpu' && ld.inputs?.[0]?.name === 'X' && JSON.stringify(ld.inputs[0].shape) === '[-1,4]' && ld.outputs?.[0]?.name === 'Y', 'a .onnx model loads on WebGPU by default, with its inputs and outputs: ' + JSON.stringify(ld).slice(0, 240));
const r1 = await J('onnx', { action: 'run', id: 'tiny', inputs: [{ data: [[1, 2, 3, 4], [0, 0, 0, 1]] }] });
ok(r1.outputs?.[0]?.first?.join() === '5.5,5,17,1.5,0,11' && JSON.stringify(r1.outputs[0].shape) === '[2,3]' && r1.accelerator === 'webgpu', 'it computes on WebGPU, the batch size taken from the data: ' + JSON.stringify(r1.outputs?.[0]?.first || r1));
const r2 = await J('onnx', { action: 'run', id: 'tiny', inputs: { X: { data: [1, 2, 3, 4] } } });
ok(r2.outputs?.[0]?.first?.join() === '5.5,5,17', 'inputs can be given by name: ' + JSON.stringify(r2.outputs?.[0]?.first || r2));
await E(() => vfs.write('/in/x.json', JSON.stringify([[2, 0, 0, 0]]), { mkdirs: true }));
const r3 = await J('onnx', { action: 'run', id: 'tiny', inputs: [{ data: '/in/x.json' }] });
ok(r3.outputs?.[0]?.first?.join() === '2.5,-1,10', 'or from a vault .json file');
const cpu = await J('onnx', { action: 'load', model: '/models/tiny.onnx', id: 'cpu', accelerator: 'wasm' });
const r4 = await J('onnx', { action: 'run', id: 'cpu', inputs: [{ data: [[1, 2, 3, 4]] }] });
ok(cpu.accelerator === 'wasm' && r4.outputs?.[0]?.first?.join() === '5.5,5,17', 'the CPU (WebAssembly) gives the same answer');
ok((await J('onnx', { action: 'status' })).models.length === 2, 'status lists the loaded models');
ok(/unloaded cpu/.test(await T('onnx', { action: 'unload', id: 'cpu' })) && /no loaded model/.test(await T('onnx', { action: 'run', id: 'cpu', inputs: [{ data: [1] }] })), 'unload, and an unknown id explains what is loaded');
ok(/flexible shape|give shape/.test(await T('onnx', { action: 'run', id: 'tiny', inputs: [{ data: [1, 2, 3] }] })) || /Error|ERR/.test(await T('onnx', { action: 'run', id: 'tiny', inputs: [{ data: [1, 2, 3] }] })), 'wrong-sized data is an error, not a crash');
// a script can use it through jade.tool
const viaTool = await E(async () => JSON.parse(await runTool('onnx', { action: 'run', id: 'tiny', inputs: [{ data: [0, 1, 0, 0] }] })).outputs[0].first.join());
ok(viaTool === '0.5,0,10', 'runTool reaches it (so jade.tool from scripts does too)');

// LiteRT picks WebGPU itself when the device has it
const tflite = Array.from(fs.readFileSync(path.join(ROOT, 'tests/fixtures/add.tflite')));
await E(b => { vfs.write('/models/add.tflite', new Uint8Array(b), { mkdirs: true }); }, tflite);
const lt = await J('litert', { action: 'load', model: '/models/add.tflite', id: 'adder' });
const lr = await J('litert', { action: 'run', id: 'adder', inputs: [{ data: [1, 2, 3, 4] }, { data: [10, 20, 30, 40] }] });
ok((lt.accelerator === 'webgpu' || /webgpu failed/.test(lt.note || '')) && lr.outputs?.[0]?.first?.join() === '11,22,33,44', `LiteRT tries WebGPU by default (${lt.accelerator}${lt.note ? ", " + lt.note.slice(0, 80) : ""}) and computes: ` + JSON.stringify(lr).slice(0, 400));
await done();
