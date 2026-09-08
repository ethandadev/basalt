// Feeds a synthetic shell stream through the block model and checks that it
// slices commands correctly and folds their output.
import assert from 'node:assert/strict';
import { BlockModel } from '../src/renderer/blocks.js';

const A = '\x1b]133;A\x07';
const C = '\x1b]133;C\x07';
const D = (code) => `\x1b]133;D;${code}\x07`;
const CWD = (dir) => `\x1b]1337;CurrentDir=${dir}\x07`;

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (error) { console.error(`  FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
}

// --- basic slicing ------------------------------------------------------------

check('splits a stream into prompt/command/output blocks', () => {
  const model = new BlockModel({ maxBlocks: 100 });
  model.ingest(A + CWD('/tmp') + '$ ');
  model.ingest('ls\r\n');
  model.ingest(C);
  model.ingest('a.txt\r\nb.txt\r\n');
  model.ingest(D(0));
  model.ingest(A + '$ ');

  const done = model.blocks.filter((b) => b.state === 'done' && b.output);
  assert.equal(done.length, 1);
  assert.equal(done[0].output, 'a.txt\r\nb.txt\r\n');
  assert.equal(done[0].head, '$ ls\r\n');
  assert.equal(done[0].exitCode, 0);
  assert.equal(done[0].outputLines, 2);
  assert.equal(model.cwd, '/tmp');
});

check('strips the marks from what reaches the terminal', () => {
  const model = new BlockModel({});
  const visible = model.ingest(A + '$ ' + C + 'hi\r\n' + D(0));
  assert.equal(visible, '$ hi\r\n');
  assert.ok(!visible.includes('133'));
});

check('records a non-zero exit status', () => {
  const model = new BlockModel({});
  model.ingest(A + '$ ' + C + 'nope\r\n' + D(127));
  assert.equal(model.current.exitCode, 127);
});

// --- chunk boundaries ---------------------------------------------------------

check('reassembles a mark split across two chunks', () => {
  const model = new BlockModel({});
  const stream = A + '$ ' + C + 'out\r\n' + D(0);
  for (let cut = 1; cut < stream.length; cut++) {
    const split = new BlockModel({});
    const visible = split.ingest(stream.slice(0, cut)) + split.ingest(stream.slice(cut));
    assert.equal(visible, '$ out\r\n', `split at ${cut} produced ${JSON.stringify(visible)}`);
    assert.equal(split.current.exitCode, 0, `split at ${cut} lost the exit status`);
  }
  assert.ok(model);
});

check('passes ordinary escape sequences straight through', () => {
  const model = new BlockModel({});
  const visible = model.ingest('\x1b[31mred\x1b[0m and \x1b]0;a title\x07done');
  assert.equal(visible, '\x1b[31mred\x1b[0m and \x1b]0;a title\x07done');
});

check('holds a trailing bare ESC until the rest arrives', () => {
  const model = new BlockModel({});
  const first = model.ingest('text\x1b');
  const second = model.ingest(']133;A\x07next');
  assert.equal(first, 'text');
  assert.equal(second, 'next');
  assert.equal(model.blocks.length, 2);
});

// --- folding ------------------------------------------------------------------

function longSession(lines) {
  const model = new BlockModel({ maxBlocks: 100, autoTruncate: true, truncateThreshold: 10 });
  model.ingest(A + '$ seq\r\n' + C);
  model.ingest(Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n');
  model.ingest(D(0));
  return model;
}

check('auto-shortens output past the threshold', () => {
  const model = longSession(50);
  assert.equal(model.lastFoldable().fold, 'truncated');
});

check('truncated render keeps the head and tail and elides the middle', () => {
  const model = longSession(50);
  const text = model.render({ headLines: 5, tailLines: 3 }).map((s) => s.text).join('');
  assert.ok(text.includes('line 1'), 'kept the first line');
  assert.ok(text.includes('line 5'), 'kept the last head line');
  assert.ok(!text.includes('line 20'), 'elided the middle');
  assert.ok(text.includes('line 50'), 'kept the last line');
  assert.ok(/42 more lines/.test(text), `summary line count wrong: ${text.match(/\d+ more lines/)}`);
});

check('zsh\'s trailing partial-line marker does not eat a tail line', () => {
  // What zsh actually emits after the last line of output.
  const marker = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m' + ' '.repeat(70) + '\r \r';
  const model = new BlockModel({ autoTruncate: true, truncateThreshold: 10 });
  model.ingest(A + '$ seq 1 60\r\n' + C);
  model.ingest(Array.from({ length: 60 }, (_, i) => `${i + 1}`).join('\r\n') + '\r\n' + marker);
  model.ingest(D(0));

  const segments = model.render({ headLines: 12, tailLines: 6 });
  const tail = segments[segments.length - 1].text;
  const visible = tail.split('\n').filter((line) => /\d/.test(line.replace(/\x1b\[[0-9;]*m/g, '')));
  assert.equal(visible.length, 6, `expected 6 tail lines, got ${visible.length}: ${JSON.stringify(visible)}`);

  const summary = segments.find((s) => s.summary).text;
  assert.ok(/42 more lines/.test(summary), `summary said: ${JSON.stringify(summary)}`);
  assert.ok(tail.includes('55') && tail.includes('60'), 'tail should run 55..60');
  assert.ok(tail.endsWith(marker), 'the marker itself is preserved at the end');
});

check('hidden render replaces the output entirely', () => {
  const model = longSession(50);
  model.setFold(model.lastFoldable().id, 'hidden');
  const text = model.render({}).map((s) => s.text).join('');
  assert.ok(!text.includes('line 1\r\n'), 'output should be gone');
  assert.ok(text.includes('$ seq'), 'the command itself stays');
  assert.ok(/50 lines hidden/.test(text));
});

check('full render reproduces the original stream exactly', () => {
  const model = new BlockModel({ autoTruncate: false });
  const visible = model.ingest(A + '$ ls\r\n' + C + 'a\r\nb\r\n' + D(0) + A + '$ ');
  const rendered = model.render({}).map((s) => s.text).join('');
  assert.equal(rendered, visible);
});

check('a summary segment carries the block id so clicks can find it', () => {
  const model = longSession(50);
  const summaries = model.render({}).filter((s) => s.summary);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].blockId, model.lastFoldable().id);
});

check('cycleFold walks full -> truncated -> hidden -> full', () => {
  const model = new BlockModel({ autoTruncate: false });
  model.ingest(A + '$ x\r\n' + C + 'out\r\n' + D(0));
  const id = model.lastFoldable().id;
  assert.equal(model.byId(id).fold, 'full');
  assert.equal(model.cycleFold(id).fold, 'truncated');
  assert.equal(model.cycleFold(id).fold, 'hidden');
  assert.equal(model.cycleFold(id).fold, 'full');
});

// --- limits -------------------------------------------------------------------

check('drops the oldest blocks past the limit', () => {
  const model = new BlockModel({ maxBlocks: 5 });
  for (let i = 0; i < 20; i++) model.ingest(A + `$ cmd${i}\r\n` + C + 'out\r\n' + D(0));
  assert.ok(model.blocks.length <= 5);
});

check('caps a runaway output instead of growing forever', () => {
  const model = new BlockModel({ maxBytesPerBlock: 4096, autoTruncate: false });
  model.ingest(A + '$ yes\r\n' + C);
  for (let i = 0; i < 50; i++) model.ingest('x'.repeat(1000));
  assert.ok(model.current.output.length <= 4096, `output grew to ${model.current.output.length}`);
  assert.ok(model.current.dropped > 0);
});

// Cutting the middle out must never take a head and a tail that overlap: that
// would duplicate the overlap rather than drop it, and leave the block longer
// than it started.
check('capping an output drops the middle without duplicating it', () => {
  const model = new BlockModel({ maxBytesPerBlock: 4096, autoTruncate: false });
  model.ingest(A + '$ run\r\n' + C);
  // Land just under the cap, then cross it by a little.
  model.ingest('a'.repeat(4000));
  model.ingest('b'.repeat(200));

  const { output, dropped } = model.current;
  assert.equal(output.length, 4096, 'output should be capped at exactly the limit');
  assert.equal(dropped, 104, 'dropped should count the bytes actually discarded');
  assert.equal(output, 'a'.repeat(2048) + 'a'.repeat(1848) + 'b'.repeat(200));
  // Nothing survived twice: the kept head and tail came from disjoint ranges.
  assert.equal(output.split('b').length - 1, 200);
  assert.equal(output.split('a').length - 1, 3896);
});

check('shell command list arrives base64-encoded', () => {
  const model = new BlockModel({});
  let received = null;
  model.onCommands = (list) => { received = list; };
  model.ingest(`\x1b]1337;BasaltCmds=${Buffer.from('ll\ngst\nmyfunc').toString('base64')}\x07`);
  assert.deepEqual(received, ['ll', 'gst', 'myfunc']);
});

console.log(`\n${passed} checks passed`);
