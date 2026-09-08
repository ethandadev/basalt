// Scratch diagnostic: boots the app, types a few characters, and dumps what the
// session thinks is going on.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'),
  ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', (c) => process.stderr.write(`[app] ${c}`));

let socket, id = 0;
const pending = new Map();

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('no target');
}

function send(method, params = {}) {
  const messageId = ++id;
  socket.send(JSON.stringify({ id: messageId, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(messageId, { resolve, reject });
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
  return result.result.value;
}

const S = 'window.basaltInternals.state';
const SESSION = `${S}.sessions[${S}.active]`;

async function main() {
  const page = await target();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    message.error ? resolver.reject(new Error(message.error.message)) : resolver.resolve(message.result);
  });

  await send('Runtime.enable');
  await sleep(3500);

  console.log('booted:', await evaluate('return Boolean(window.basaltInternals);'));
  console.log('state:', JSON.stringify(await evaluate(`
    const s = ${SESSION};
    return { shell: s.shellBase, integrated: s.integrated, inputStart: s.inputStart, cwd: s.cwd,
             blocks: s.model.blocks.length, activeEl: document.activeElement?.className };
  `), null, 2));

  await evaluate(`${SESSION}.focus(); ${SESSION}.history = ['echo hello-from-basalt']; return true;`);
  await sleep(200);
  console.log('focused element:', await evaluate('return document.activeElement?.className || document.activeElement?.tagName;'));

  // Method A: keyDown with text
  for (const char of 'echo hel') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, unmodifiedText: char });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    await sleep(20);
  }
  await sleep(600);
  console.log('after method A:', JSON.stringify(await evaluate(`
    const s = ${SESSION};
    return { readInput: s.readInput(), full: s.readFullInput(), suggestion: s.suggestion,
             inputStart: s.inputStart, cursor: { x: s.term.buffer.active.cursorX, y: s.term.buffer.active.cursorY } };
  `)));

  // Method B: char events
  await evaluate(`${SESSION}.write('\\u0015'); return true;`);
  await sleep(300);
  for (const char of 'echo hel') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char });
    await send('Input.dispatchKeyEvent', { type: 'char', text: char, key: char, unmodifiedText: char });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    await sleep(20);
  }
  await sleep(600);
  console.log('after method B:', JSON.stringify(await evaluate(`
    const s = ${SESSION};
    return { readInput: s.readInput(), full: s.readFullInput(), suggestion: s.suggestion };
  `)));

  // Method C: straight to the pty, which is what a keystroke ends up doing
  await evaluate(`${SESSION}.write('\\u0015'); return true;`);
  await sleep(300);
  await evaluate(`${SESSION}.write('echo hel'); return true;`);
  await sleep(700);
  console.log('after method C:', JSON.stringify(await evaluate(`
    const s = ${SESSION};
    return { readInput: s.readInput(), full: s.readFullInput(), suggestion: s.suggestion,
             ghost: document.querySelector('.ghost')?.textContent, ghostVisible: document.querySelector('.ghost')?.classList.contains('visible') };
  `)));

  child.kill('SIGTERM');
  process.exit(0);
}

main().catch((error) => { console.error(error); child.kill('SIGTERM'); process.exit(1); });
