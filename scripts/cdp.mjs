// Drive a running Window Recorder over the Chrome DevTools Protocol: evaluate JS in the renderer and
// take screenshots. Used for UI checks without clicking around by hand (see AGENTS.md → "Testing").
//
//   node scripts/cdp.mjs <port> <steps.json>
//
// steps.json is an array of objects, run in order; each may contain any of:
//   { "eval": "<JS expression>" }  evaluated in the page (awaits promises), result is printed
//   { "wait": <ms> }               sleep
//   { "shot": "<path.png>" }       save a screenshot of the window
//
// Renderer globals (selected, mediaRecorder, lastSaved, showTab(), loadLibrary(), …) are reachable from
// "eval" because renderer.js is a classic script. The window is closed at the end.

import fs from 'node:fs';

const [port, stepsFile] = process.argv.slice(2);
if (!port || !stepsFile) {
  console.error('usage: node scripts/cdp.mjs <port> <steps.json>');
  process.exit(2);
}
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets = [];
for (let i = 0; i < 40 && !targets.some((t) => t.type === 'page'); i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    await sleep(250);
  }
}
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error(`no page on port ${port}; was the app started with --remote-debugging-port=${port}?`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++nextId, resolve);
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });

await sleep(1500); // let the page finish its first window listing
for (const step of steps) {
  if (step.eval) {
    const r = await send('Runtime.evaluate', { expression: step.eval, awaitPromise: true, returnByValue: true });
    const value = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result;
    console.log('eval:', JSON.stringify(value).slice(0, 1000));
  }
  if (step.wait) await sleep(step.wait);
  if (step.shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(step.shot, Buffer.from(r.result.data, 'base64'));
    console.log('shot:', step.shot);
  }
}
await send('Runtime.evaluate', { expression: 'window.close()' });
ws.close();
process.exit(0);
