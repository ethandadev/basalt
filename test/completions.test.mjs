// Exercises the completion/prediction engine against a real temporary tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const completions = require('../src/main/completions.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-test-'));
fs.mkdirSync(path.join(root, 'reports'));
fs.mkdirSync(path.join(root, 'receipts'));
fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
fs.writeFileSync(path.join(root, 'notes-old.txt'), 'x');
fs.writeFileSync(path.join(root, '.hidden'), 'x');
fs.writeFileSync(path.join(root, 'my file.txt'), 'x');

let passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (error) { console.error(`  FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
}

const at = (line, extra = {}) => completions.complete({ line, cursor: line.length, cwd: root, history: [], ...extra });

await check('completes a filename prefix', async () => {
  const result = await at('cat not');
  const names = result.candidates.map((c) => c.display);
  assert.ok(names.includes('notes.txt'));
  assert.ok(names.includes('notes-old.txt'));
  assert.equal(result.token, 'not');
});

await check('offers the shared prefix of the matches', async () => {
  const result = await at('cat re');
  assert.equal(result.commonPrefix, 're');
  const result2 = await at('cat rep');
  assert.equal(result2.commonPrefix, 'reports/');
});

await check('marks directories with a trailing slash', async () => {
  const result = await at('cat rep');
  assert.equal(result.candidates[0].type, 'directory');
  assert.equal(result.candidates[0].display, 'reports/');
});

await check('cd only offers directories', async () => {
  const result = await at('cd ');
  const types = new Set(result.candidates.map((c) => c.type));
  assert.deepEqual([...types], ['directory']);
});

await check('hides dotfiles until a dot is typed', async () => {
  const plain = await at('cat ');
  assert.ok(!plain.candidates.some((c) => c.display === '.hidden'));
  const dotted = await at('cat .');
  assert.ok(dotted.candidates.some((c) => c.display === '.hidden'));
});

await check('escapes a space in a filename', async () => {
  const result = await at('cat my');
  const match = result.candidates.find((c) => c.display === 'my file.txt');
  assert.ok(match, 'found the file');
  assert.equal(match.value, 'my\\ file.txt');
});

await check('completes commands in command position', async () => {
  const result = await at('ech');
  assert.ok(result.isCommandPosition);
  assert.ok(result.candidates.some((c) => c.display === 'echo' && c.type === 'command'));
});

await check('treats the word after a pipe as a command', async () => {
  const result = await at('cat notes.txt | gre');
  assert.ok(result.isCommandPosition);
  assert.ok(result.candidates.some((c) => c.display === 'grep'));
});

await check('offers aliases the live shell reported', async () => {
  const result = await at('gs', { shellCommands: ['gst', 'gs', 'gsync'] });
  const names = result.candidates.map((c) => c.display);
  assert.ok(names.includes('gst') && names.includes('gsync'));
});

await check('offers git subcommands', async () => {
  const result = await at('git sta');
  const names = result.candidates.map((c) => c.display);
  assert.ok(names.includes('status') && names.includes('stash'));
});

await check('completes through a directory prefix', async () => {
  fs.writeFileSync(path.join(root, 'reports', 'q1.pdf'), 'x');
  const result = await at('open reports/q');
  assert.equal(result.candidates[0].display, 'q1.pdf');
  assert.equal(result.candidates[0].value, 'reports/q1.pdf');
});

await check('matches history entries for the whole line', async () => {
  const result = await at('cat no', { history: ['cat notes.txt | wc -l'] });
  const historic = result.candidates.filter((c) => c.type === 'history');
  assert.equal(historic.length, 1);
  assert.equal(historic[0].display, 'cat notes.txt | wc -l');
});

// --- inline suggestion --------------------------------------------------------

const suggest = (line, extra = {}) => completions.suggest({ line, cwd: root, history: [], ...extra });

await check('suggests the rest of a remembered command', async () => {
  const rest = await suggest('git com', { history: ['git commit -m "wip"'] });
  assert.equal(rest, 'mit -m "wip"');
});

await check('prefers the most recent match', async () => {
  const rest = await suggest('cd ', { history: ['cd /old', 'cd /new'] });
  assert.equal(rest, '/new');
});

await check('suggests a filename only when it is unambiguous', async () => {
  assert.equal(await suggest('cat notes-'), 'old.txt');
  assert.equal(await suggest('cat notes'), '', 'two files match, so no guess');
});

await check('suggests nothing on an empty line', async () => {
  assert.equal(await suggest(''), '');
});

await check('honours the "history only" setting', async () => {
  const rest = await suggest('cat notes-', { source: 'history' });
  assert.equal(rest, '');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
