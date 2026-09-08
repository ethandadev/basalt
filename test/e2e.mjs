// End-to-end test. Launches the real app, drives it over the DevTools protocol,
// and checks the four features Basalt exists for: visible prediction, an easy
// shell switch, selection-aware editing, and foldable output.
//
//   node test/e2e.mjs [--keep] [--shot <file.png>]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Derived from the pid rather than fixed, so two runs — or a run started while
// a previous app is still shutting down — never contend for the same port.
const PORT = 9400 + (process.pid % 500);
const keepOpen = process.argv.includes('--keep');
const shotIndex = process.argv.indexOf('--shot');
const shotPath = shotIndex === -1 ? null : process.argv[shotIndex + 1];

let passed = 0;
let failed = 0;

function report(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- CDP plumbing -------------------------------------------------------------

class Client {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const resolver = this.pending.get(message.id);
      if (!resolver) return;
      this.pending.delete(message.id);
      message.error ? resolver.reject(new Error(message.error.message)) : resolver.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
    });
  }

  // Evaluate in the page and return the value, awaiting promises.
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return result.result.value;
  }
}

// Ask the app to quit and wait until it really has. Exiting the moment SIGTERM
// is sent leaves the debugging port bound by the dying process, so a run
// started straight afterwards silently fails to attach to its own instance.
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function findTarget() {
  // 30s: a cold start on a loaded machine can take well over the 15s this
  // used to allow, which showed up as a spurious "never opened a window".
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* not listening yet */ }
    await sleep(250);
  }
  throw new Error('the app never opened a debuggable window');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(new Client(socket)));
    socket.addEventListener('error', reject);
  });
}

// --- typing helpers -----------------------------------------------------------

async function typeText(client, text) {
  for (const char of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    await sleep(12);
  }
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};

async function pressKey(client, name, modifiers = 0) {
  const spec = KEYS[name];
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...spec });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: spec.key, code: spec.code });
  await sleep(40);
}

// Wait until an expression returns something truthy.
async function until(client, expression, timeout = 8000, label = expression) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(`return ${expression};`);
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

const S = 'window.basaltInternals.state';
const SESSION = `${S}.sessions[${S}.active]`;

// --- the test -----------------------------------------------------------------

async function main() {
  const electron = path.join(ROOT, 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BASALT_E2E: '1' },
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', () => {});

  const shutdown = () => { if (!keepOpen) child.kill('SIGTERM'); };
  process.on('exit', shutdown);

  try {
    const target = await findTarget();
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    // --- startup
    await until(client, 'Boolean(window.basaltInternals)', 15000, 'the app to finish booting');
    report('window opens and boots', true);

    // Panels are hidden with the `hidden` attribute, which their own
    // `display: flex` will happily override if the CSS lets it.
    const chrome = await client.evaluate(`
      const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
      return { settings: shown('settings-sheet'), help: shown('help-sheet'),
               find: shown('findbar'), blocks: shown('blocks-panel'), overlay: shown('overlay') };
    `);
    report('no panels or sheets are showing at startup',
      Object.values(chrome).every((visible) => visible === false), JSON.stringify(chrome));

    const shellBase = await until(client, `${SESSION}.shellBase`, 8000, 'a shell to start');
    report('starts a shell', Boolean(shellBase), `shellBase=${shellBase}`);

    const integrated = await until(client, `${SESSION}.integrated`, 3000, 'shell integration');
    report('shell integration is active', integrated === true);

    // The prompt has to land before anything else makes sense.
    await until(client, `${SESSION}.inputStart !== null`, 10000, 'the first prompt');
    report('finds where the input line starts', true);

    await client.evaluate(`${SESSION}.focus(); return true;`);

    // --- 1. prediction: the greyed-out suggestion
    await client.evaluate(`${SESSION}.history = ['echo hello-from-basalt', 'git status']; return true;`);
    await typeText(client, 'echo hel');
    // Each character echoes back separately and each echo triggers a fresh
    // prediction, so the first suggestion to appear may be the one for a
    // half-typed line. Wait for the line itself to settle before reading it.
    await until(client, `${SESSION}.readInput() === 'echo hel'`, 5000, 'the typed line to echo back');
    const ghost = await until(client, `${SESSION}.suggestion`, 5000, 'an inline suggestion');
    report('shows an inline suggestion from history', ghost === 'lo-from-basalt', `got ${JSON.stringify(ghost)}`);

    const ghostVisible = await client.evaluate(
      `return document.querySelector('.ghost.visible')?.textContent || '';`);
    report('draws the suggestion on screen', ghostVisible === 'lo-from-basalt', `drawn: ${JSON.stringify(ghostVisible)}`);

    await pressKey(client, 'ArrowRight');
    await sleep(250);
    const acceptedLine = await client.evaluate(`return ${SESSION}.readInput();`);
    report('→ accepts the suggestion', acceptedLine === 'echo hello-from-basalt', `line is ${JSON.stringify(acceptedLine)}`);

    await pressKey(client, 'Enter');
    await until(client, `${SESSION}.model.blocks.some(b => b.output.includes('hello-from-basalt'))`, 6000, 'the command to run');
    report('runs the command and captures its output', true);

    // --- 2. the Tab completion menu
    await until(client, `${SESSION}.inputStart !== null`, 6000, 'the next prompt');
    await typeText(client, 'cd /usr/lo');
    await pressKey(client, 'Tab');
    await sleep(700);
    const afterTab = await client.evaluate(`return ${SESSION}.readInput();`);
    report('Tab completes an unambiguous path', afterTab === 'cd /usr/local/', `line is ${JSON.stringify(afterTab)}`);

    await typeText(client, ' ');
    await client.evaluate(`${SESSION}.write('\\u0015'); return true;`); // clear the line
    await sleep(250);

    await typeText(client, 'ec');
    await pressKey(client, 'Tab');
    const menuOpen = await until(client, `Boolean(${SESSION}.completion)`, 5000, 'the completion menu');
    report('Tab opens a menu when the choice is ambiguous', Boolean(menuOpen));

    const menuInfo = await client.evaluate(`
      const menu = document.querySelector('.completion');
      return {
        visible: menu && !menu.hidden,
        rows: menu ? menu.querySelectorAll('.completion-item').length : 0,
        selected: menu?.querySelector('.completion-item.selected')?.textContent || '',
        items: ${SESSION}.completion.items.slice(0, 8).map(i => i.display),
      };
    `);
    report('the menu is on screen with rows', menuInfo.visible && menuInfo.rows > 1,
      `visible=${menuInfo.visible} rows=${menuInfo.rows}`);
    report('the menu offers matching commands', menuInfo.items.some((i) => i.startsWith('ec')),
      `items: ${menuInfo.items.join(', ')}`);
    report('one row is highlighted', menuInfo.selected.length > 0);

    await pressKey(client, 'ArrowDown');
    const movedIndex = await client.evaluate(`return ${SESSION}.completion.index;`);
    report('↓ moves the highlight', movedIndex === 1, `index=${movedIndex}`);

    // Consuming a key in the menu has to take it from the browser as well as
    // from xterm. Tab that only does the former cycles the menu while DOM focus
    // walks off into the toolbar.
    const focusBefore = await client.evaluate(`
      return document.activeElement ? document.activeElement.className : '(none)';
    `);
    await pressKey(client, 'Tab');
    const afterTabFocus = await client.evaluate(`
      const el = document.activeElement;
      const completion = ${SESSION}.completion;
      return {
        index: completion ? completion.index : -1,
        count: completion ? completion.items.length : 0,
        inTerminal: Boolean(el && el.closest('.session')),
        tag: el ? el.tagName : '(none)',
        cls: el ? el.className : '(none)',
      };
    `);
    // The highlight was on row 1; Tab advances it, wrapping on a short list.
    report('⇥ moves the highlight in the menu',
      afterTabFocus.index === (1 + 1) % afterTabFocus.count,
      `index=${afterTabFocus.index} of ${afterTabFocus.count}`);
    report('⇥ does not walk DOM focus into the toolbar', afterTabFocus.inTerminal === true,
      `focus was on <${afterTabFocus.tag} class="${afterTabFocus.cls}"> (before: ${focusBefore})`);

    await pressKey(client, 'Escape');
    const closed = await client.evaluate(`return ${SESSION}.completion === null && document.querySelector('.completion').hidden;`);
    report('esc dismisses the menu', closed === true);

    await client.evaluate(`${SESSION}.write('\\u0015'); return true;`);
    await sleep(200);

    // --- 3. selection-aware editing
    await typeText(client, 'echo ONE TWO');
    await sleep(300);
    const beforeEdit = await client.evaluate(`return ${SESSION}.readInput();`);
    report('typed a line to edit', beforeEdit === 'echo ONE TWO', `line is ${JSON.stringify(beforeEdit)}`);

    // Select "ONE" (offsets 5..8 of the input line) and type over it.
    const selected = await client.evaluate(`
      const s = ${SESSION};
      s.term.select(s.inputStart.x + 5, s.inputStart.y, 3);
      return s.term.getSelection();
    `);
    report('can select part of the command line', selected === 'ONE', `selected ${JSON.stringify(selected)}`);

    const range = await client.evaluate(`return ${SESSION}.selectionRange();`);
    report('maps the selection onto the input line', range && range.start === 5 && range.end === 8,
      `range=${JSON.stringify(range)}`);

    await client.evaluate(`return ${SESSION}.replaceSelection('SIX');`);
    await sleep(400);
    // The shell leaves blank cells past the end of a line it has shortened, so
    // compare against the trimmed line.
    const replaced = await client.evaluate(`return ${SESSION}.readFullInput().trimEnd();`);
    report('typing over a selection replaces it', replaced === 'echo SIX TWO', `line is ${JSON.stringify(replaced)}`);

    // Ctrl-U kills the line, but the shell has to echo the result back before
    // the next command is typed — otherwise it lands on the tail of the old one
    // and runs something else entirely, which on a slow machine is exactly what
    // happens.
    // Kill the line, then submit it: if the kill did not fully land, Enter runs
    // whatever is left over harmlessly and either way the next command starts
    // from a fresh prompt. Waiting on the kill alone is a race a slow machine
    // loses, and the next command then runs concatenated onto this one.
    await client.evaluate(`${SESSION}.write('\\u0015'); return true;`);
    await pressKey(client, 'Enter');
    await until(client, `${SESSION}.inputStart !== null && ${SESSION}.readFullInput().trim() === ''`,
      15000, 'a clean prompt before the next command');

    // --- 4. folding long output
    await client.evaluate(`${S}.raw.blocks.truncateThreshold = 10; ${SESSION}.settings.blocks.truncateThreshold = 10; ${SESSION}.model.options.truncateThreshold = 10; return true;`);
    await typeText(client, 'seq 1 60');
    await pressKey(client, 'Enter');

    // Generous rather than tight: on a loaded CI runner the shell can take
    // several seconds to echo, run and report a command that is instant here.
    await until(client, `${SESSION}.model.foldable().some(b => b.outputLines >= 60)`, 30000, 'the long output');
    report('captures a long output as one block', true);

    const folded = await until(client, `${SESSION}.model.lastFoldable().fold !== 'full'`, 15000, 'the auto-fold');
    report('long output folds itself automatically', Boolean(folded));

    // The fold flag flips before the redraw finishes. Wait until this specific
    // block's summary has actually been drawn, not just any summary.
    await until(client,
      `(() => { const s = ${SESSION}; return s.replaying === false && [...s.summaryRows.values()].includes(s.model.lastFoldable().id); })()`,
      8000, 'this block\'s redraw to finish');
    await sleep(150);

    const readScreen = `(() => {
      const s = ${SESSION};
      const buf = s.term.buffer.active;
      let text = '';
      for (let y = 0; y < buf.length; y++) text += (buf.getLine(y)?.translateToString(true) || '') + '\\n';
      return text;
    })()`;

    // A later block ending re-folds and replays, so the redraw waited for above
    // can be followed by another one and a single sample can catch the screen
    // mid-rewrite. Wait for it to settle before snapshotting; if it never does,
    // fall through and let the assertions report what is actually there.
    try {
      await until(client,
        `(() => { const t = ${readScreen}; return ${SESSION}.replaying === false`
        + ` && /more lines — click to show/.test(t) && !t.includes('\\n30\\n'); })()`,
        8000, 'the folded screen to settle');
    } catch (_) { /* reported by the assertions below */ }

    const screenAfterFold = await client.evaluate(`return ${readScreen};`);
    report('the fold summary is on screen', /more lines — click to show/.test(screenAfterFold),
      `screen tail: ${JSON.stringify(screenAfterFold.trim().split('\n').slice(-6))}`);
    if (screenAfterFold.includes('\n30\n')) {
      const diagnostic = await client.evaluate(`
        const s = ${SESSION};
        const b = s.model.lastFoldable();
        return { fold: b.fold, outputLines: b.outputLines, replaying: s.replaying,
                 summaryRows: [...s.summaryRows.entries()], blockId: b.id,
                 bufferLength: s.term.buffer.active.length, baseY: s.term.buffer.active.baseY,
                 rows: s.term.rows, foldable: s.model.foldable().map(x => [x.id, x.fold, x.outputLines]) };
      `);
      console.error(`        diagnostic: ${JSON.stringify(diagnostic)}`);
      console.error(`        screen: ${JSON.stringify(screenAfterFold.split('\n').slice(0, 40))}`);
    }
    report('the middle of the output is hidden', !screenAfterFold.includes('\n30\n'),
      'line 30 should not be visible while folded');
    report('the start of the output is still visible', screenAfterFold.includes('\n1\n'));
    report('the end of the output is still visible', screenAfterFold.includes('\n60\n'));

    const summaryRows = await client.evaluate(`return [...${SESSION}.summaryRows.entries()];`);
    report('remembers which row the summary sits on', summaryRows.length === 1,
      `rows: ${JSON.stringify(summaryRows)}`);

    // Expand it again.
    await client.evaluate(`await ${SESSION}.setFold(${SESSION}.model.lastFoldable().id, 'full'); return true;`);
    await sleep(500);
    const screenAfterExpand = await client.evaluate(`
      const s = ${SESSION};
      const buf = s.term.buffer.active;
      let text = '';
      for (let y = 0; y < buf.length; y++) text += (buf.getLine(y)?.translateToString(true) || '') + '\\n';
      return text;
    `);
    report('expanding brings the whole output back', screenAfterExpand.includes('\n30\n'));
    report('the summary line is gone once expanded', !/more lines — click/.test(screenAfterExpand));

    // Hide it entirely.
    await client.evaluate(`await ${SESSION}.setFold(${SESSION}.model.lastFoldable().id, 'hidden'); return true;`);
    await sleep(500);
    const screenHidden = await client.evaluate(`
      const s = ${SESSION};
      const buf = s.term.buffer.active;
      let text = '';
      for (let y = 0; y < buf.length; y++) text += (buf.getLine(y)?.translateToString(true) || '') + '\\n';
      return text;
    `);
    report('hiding removes the output but keeps the command', /lines hidden/.test(screenHidden) && screenHidden.includes('seq 1 60'));

    // The prompt must still work after all that redrawing.
    await client.evaluate(`await ${SESSION}.setFold(${SESSION}.model.lastFoldable().id, 'truncated'); return true;`);
    await sleep(400);
    await client.evaluate(`${SESSION}.focus(); return true;`);
    await typeText(client, 'echo still-alive');
    await pressKey(client, 'Enter');
    await until(client, `${SESSION}.model.blocks.some(b => b.output.includes('still-alive'))`, 8000, 'the shell after folding');
    report('the shell still works after folding and redrawing', true);

    // --- 5. tabs and shell switching
    await client.evaluate(`await window.basaltInternals.newTab({}); return true;`);
    await until(client, `${S}.sessions.length === 2`, 6000, 'a second tab');
    report('opens a second tab', true);

    const bashPath = await client.evaluate(`return (${S}.shells.find(s => s.base === 'bash') || {}).path || '';`);
    report('finds bash in the shell list', Boolean(bashPath), `bash: ${bashPath}`);

    await client.evaluate(`${S}.raw.behavior.confirmCloseRunning = false; return true;`);
    await client.evaluate(`await window.basaltInternals.switchShell(${JSON.stringify(bashPath)}); return true;`);
    await until(client, `${SESSION}.shellBase === 'bash'`, 10000, 'the tab to switch to bash');
    report('switches the tab to bash from the picker', true);

    await until(client, `${SESSION}.integrated === true`, 4000, 'bash integration');
    await until(client, `${SESSION}.inputStart !== null`, 8000, 'the bash prompt');
    await client.evaluate(`${SESSION}.focus(); return true;`);
    await typeText(client, 'echo from-bash');
    await pressKey(client, 'Enter');
    await until(client, `${SESSION}.model.blocks.some(b => b.output.includes('from-bash'))`, 8000, 'bash to run a command');
    report('the switched-to bash shell runs commands and reports blocks', true);

    const shellMenuRows = await client.evaluate(`
      document.getElementById('shell-button').click();
      await new Promise(r => setTimeout(r, 120));
      const rows = [...document.querySelectorAll('#shell-menu .shell-row')].map(r => r.querySelector('.name').textContent);
      document.body.click();
      return rows;
    `);
    report('the shell picker lists the shells to choose from', shellMenuRows.length >= 2,
      `listed: ${shellMenuRows.join(', ')}`);

    // Closing from the × with a real mouse click. The tab strip is rebuilt on
    // every render, so this exercises ordering that calling closeTab() directly
    // never touches.
    const closeBox = await client.evaluate(`
      const tabs = document.querySelectorAll('.tab');
      const button = tabs[tabs.length - 1].querySelector('.tab-close');
      const r = button.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               before: ${S}.sessions.length };
    `);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', {
        type, x: closeBox.x, y: closeBox.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(500);
    const afterX = await client.evaluate(`return ${S}.sessions.length;`);
    report('the × on a tab closes it', afterX === closeBox.before - 1,
      `${closeBox.before} tabs before the click, ${afterX} after`);

    // Middle-click anywhere on a tab, including over the ×, also closes it.
    await client.evaluate(`await window.basaltInternals.newTab({}); return true;`);
    await until(client, `${S}.sessions.length === 2`, 5000, 'a tab to middle-click');
    const midBox = await client.evaluate(`
      const tabs = document.querySelectorAll('.tab');
      const r = tabs[tabs.length - 1].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', {
        type, x: midBox.x, y: midBox.y, button: 'middle', clickCount: 1,
      });
    }
    await sleep(500);
    const afterMiddle = await client.evaluate(`return ${S}.sessions.length;`);
    report('middle-click closes a tab', afterMiddle === 1, `${afterMiddle} tabs left`);

    if (afterMiddle > 1) await client.evaluate(`await window.basaltInternals.closeTab(1); return true;`);
    await until(client, `${S}.sessions.length === 1`, 5000, 'the tab to close');
    report('closes a tab', true);

    // --- 6. settings apply live
    await client.evaluate(`window.basaltInternals.changeSetting('appearance.darkTheme', 'nord'); window.basaltInternals.changeSetting('appearance.mode', 'dark'); return true;`);
    await sleep(300);
    const themed = await client.evaluate(`
      return {
        css: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        term: ${SESSION}.term.options.theme.background,
        lightClass: document.documentElement.classList.contains('light'),
      };
    `);
    report('changing the theme repaints the window and the terminal',
      themed.css === '#2e3440' && themed.term === '#2e3440', JSON.stringify(themed));
    report('a dark theme does not put the chrome in light mode', themed.lightClass === false);

    // --- light mode
    await client.evaluate(`window.basaltInternals.changeSetting('appearance.mode', 'light'); return true;`);
    await sleep(300);
    const light = await client.evaluate(`
      return {
        css: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        term: ${SESSION}.term.options.theme.background,
        fg: ${SESSION}.term.options.theme.foreground,
        lightClass: document.documentElement.classList.contains('light'),
        button: document.getElementById('appearance-button').textContent,
      };
    `);
    report('switching to light mode repaints the terminal', light.term === '#fbfbfd', JSON.stringify(light));
    report('light mode switches the window chrome too', light.lightClass === true && light.css === '#fbfbfd');
    report('light mode uses dark text', light.fg === '#20242e', `fg=${light.fg}`);
    report('the toolbar button shows the current mode', light.button === '☀', `button=${light.button}`);

    // Auto mode should follow whatever macOS reports.
    await client.evaluate(`window.basaltInternals.changeSetting('appearance.mode', 'auto'); return true;`);
    await sleep(250);
    const auto = await client.evaluate(`
      const s = window.basaltInternals.state;
      return {
        system: s.systemTheme,
        term: s.sessions[s.active].term.options.theme.background,
        light: document.documentElement.classList.contains('light'),
      };
    `);
    report('auto mode follows the macOS appearance',
      (auto.system === 'dark') === !auto.light, JSON.stringify(auto));

    await client.evaluate(`window.basaltInternals.changeSetting('appearance.darkTheme', 'basalt-dark'); return true;`);

    // --- fonts
    const fontInfo = await client.evaluate(`
      const mod = await import('./fonts.js');
      const list = await mod.listFonts();
      return { source: list.source, mono: list.monospace.length, all: list.all.length, sample: list.monospace.slice(0, 6) };
    `);
    report('finds fonts installed on this Mac', fontInfo.mono > 0 && fontInfo.all >= fontInfo.mono,
      JSON.stringify(fontInfo));
    report('picks out the monospaced ones', fontInfo.mono < fontInfo.all || fontInfo.source === 'fallback',
      `${fontInfo.mono} monospaced of ${fontInfo.all} (${fontInfo.source})`);
    report('offers Menlo, which every Mac has', fontInfo.source === 'fallback' ||
      (await client.evaluate(`const m = await import('./fonts.js'); return (await m.listFonts()).monospace.includes('Menlo');`)) === true);

    const applied = await client.evaluate(`
      const mod = await import('./fonts.js');
      window.basaltInternals.changeSetting('appearance.fontFamily', mod.toStack('Courier New'));
      await new Promise(r => setTimeout(r, 200));
      const s = window.basaltInternals.state;
      return s.sessions[s.active].term.options.fontFamily;
    `);
    report('choosing a font applies it to the terminal', applied.startsWith('Courier New'), `applied: ${applied}`);

    await client.evaluate(`window.basaltInternals.changeSetting('appearance.fontSize', 16); return true;`);
    await sleep(300);
    const fontSize = await client.evaluate(`return ${SESSION}.term.options.fontSize;`);
    report('changing the font size applies immediately', fontSize === 16, `size=${fontSize}`);

    // --- the settings sheet renders
    const sheet = await client.evaluate(`
      window.basaltInternals.state.raw.appearance.mode = 'dark';
      document.getElementById('settings-button').click();
      await new Promise(r => setTimeout(r, 250));
      const tabs = [...document.querySelectorAll('.sheet-tab')].map(t => t.textContent);
      const fields = document.querySelectorAll('#settings-body .field').length;
      const fontOptions = document.querySelectorAll('#settings-body .font-select option').length;
      const segments = [...document.querySelectorAll('#settings-body .segment-option')].map(s => s.textContent);
      document.getElementById('settings-close').click();
      return { tabs, fields, fontOptions, segments };
    `);
    report('the settings sheet opens with three sections', sheet.tabs.length === 3,
      `tabs: ${sheet.tabs.join(', ')}`);
    report('the appearance control offers auto / light / dark',
      sheet.segments.join(',') === 'Auto,Light,Dark', `segments: ${sheet.segments.join(',')}`);
    report('the font picker is populated', sheet.fontOptions > 3, `${sheet.fontOptions} options`);

    await client.evaluate(`window.basaltInternals.changeSetting('appearance.fontSize', 13); window.basaltInternals.changeSetting('appearance.fontFamily', 'SF Mono, Menlo, Monaco, Courier New, monospace'); window.basaltInternals.changeSetting('appearance.mode', 'auto'); return true;`);

    // --- the help sheet labels itself from the live accelerator table
    const help = await client.evaluate(`
      window.basaltInternals.handleMenu({ action: 'show-help' });
      await new Promise(r => setTimeout(r, 250));
      const keys = [...document.querySelectorAll('#help-body kbd')].map(k => k.textContent);
      document.getElementById('help-close').click();
      return { keys, platform: window.basaltInternals.state.info.platform };
    `);
    const unresolved = help.keys.filter((k) => k.includes('{') || k.startsWith('@') || !k.trim());
    report('the help sheet resolves every shortcut label', unresolved.length === 0,
      `unresolved: ${unresolved.join(' | ')}`);
    // The bindings come from the main process, so this also proves the two
    // halves agree about what the shortcuts are.
    const expectFold = help.platform === 'darwin' ? '⌘E' : 'Ctrl+Shift+E';
    report('shortcut labels match the platform\'s bindings', help.keys.includes(expectFold),
      `expected ${expectFold} among: ${help.keys.slice(0, 14).join(', ')}`);

    // --- 8. ssh and the remote file panel
    // A throwaway target so this never touches a host the user actually uses;
    // it is forgotten again at the end.
    const TEST_HOST = 'basalt-e2e.invalid';

    const sshCommand = await client.evaluate(`
      return await window.basalt.ssh.command(${JSON.stringify(TEST_HOST)});
    `);
    report('builds an ssh command for a target', sshCommand.includes(TEST_HOST), sshCommand);
    // The file panel can only share the terminal's connection if the terminal
    // opens it as a master in the first place.
    report('the ssh command opens a shared connection',
      sshCommand.includes('ControlMaster=auto') && sshCommand.includes('ControlPath=')
        && sshCommand.includes('ControlPersist'), sshCommand);

    const remembered = await client.evaluate(`
      const hosts = await window.basalt.ssh.hosts();
      return hosts.recent;
    `);
    report('remembers a target that was connected to', remembered.includes(TEST_HOST),
      `recent: ${remembered.join(', ')}`);

    const connectMenu = await client.evaluate(`
      document.getElementById('connect-button').click();
      await new Promise(r => setTimeout(r, 300));
      const menu = document.getElementById('connect-menu');
      const shown = !menu.hidden;
      const rows = [...menu.querySelectorAll('.shell-row .name')].map(n => n.textContent);
      const hasInput = Boolean(menu.querySelector('.ssh-form input'));
      document.getElementById('connect-button').click();
      return { shown, rows, hasInput };
    `);
    report('the connect popover opens', connectMenu.shown === true);
    report('the connect popover takes a typed target', connectMenu.hasInput === true);
    report('the connect popover lists a remembered host', connectMenu.rows.includes(TEST_HOST),
      `rows: ${connectMenu.rows.join(', ')}`);

    const panel = await client.evaluate(`
      await window.basaltInternals.toggleFilesPanel(true);
      await new Promise(r => setTimeout(r, 300));
      const el = document.getElementById('files-panel');
      // Read everything while the panel is still open — closing it first would
      // make "is it showing" trivially false.
      const shown = !el.hidden;
      const options = [...document.querySelectorAll('#files-host option')].map(o => o.value);
      const empty = document.getElementById('file-list').textContent;
      await window.basaltInternals.toggleFilesPanel(false);
      return { shown, options, empty };
    `);
    report('the remote files panel opens', panel.shown === true);
    report('the file panel offers the known hosts', panel.options.includes(TEST_HOST),
      `options: ${panel.options.join(', ')}`);
    report('the file panel explains itself before a host is chosen',
      /Choose a host/i.test(panel.empty), panel.empty.slice(0, 120));

    // A target that cannot resolve should come back as a message, not a hang.
    const failure = await client.evaluate(`
      const result = await window.basalt.sftp.list(${JSON.stringify(TEST_HOST)}, '/tmp');
      return result;
    `);
    report('an unreachable host reports an error instead of hanging',
      failure.ok === false && Boolean(failure.error), JSON.stringify(failure).slice(0, 160));

    await client.evaluate(`return await window.basalt.ssh.forget(${JSON.stringify(TEST_HOST)});`);
    const forgotten = await client.evaluate(`
      const hosts = await window.basalt.ssh.hosts();
      return hosts.recent;
    `);
    report('a remembered host can be forgotten again', !forgotten.includes(TEST_HOST),
      `recent: ${forgotten.join(', ')}`);

    // --- no errors along the way
    const consoleErrors = await client.evaluate(`return (window.__errors || []).length;`);
    report('no uncaught errors in the renderer', !consoleErrors, `${consoleErrors} errors`);
    report('no errors on stderr', !/Error|error:/i.test(stderr.replace(/.*sandbox.*\n?/gi, '')),
      stderr.slice(0, 400));

    // --- a picture for the record
    if (shotPath) {
      await client.evaluate(`
        const s = ${SESSION};
        s.focus();
        return true;
      `);
      await sleep(400);
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log(`\n  screenshot written to ${shotPath}`);
    }
  } catch (error) {
    failed++;
    console.error(`\n  FAIL  ${error.message}`);
    if (stderr) console.error(`  stderr:\n${stderr.slice(0, 2000)}`);
  } finally {
    if (!keepOpen) await stop(child);
  }

  console.log(`\n${passed} checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
