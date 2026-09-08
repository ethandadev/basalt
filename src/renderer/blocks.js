// Slices the shell's byte stream into command blocks using the OSC 133 marks
// emitted by Basalt's shell integration, and can re-render the whole scrollback
// with any block's output folded.
//
// The terminal has no concept of a foldable region, so folding works by
// replaying: every block keeps the bytes that produced it, and toggling a fold
// resets the screen and writes everything back with the folded parts replaced
// by a one-line summary. That is why `head` (prompt + echoed command) and
// `output` are stored separately.

const DIM = '\x1b[0m\x1b[2m';
const RESET = '\x1b[0m';

// Marks the summary lines so a replay can find them again in the buffer.
export const SUMMARY_GLYPH = '⏵'; // ⏵

let nextBlockId = 1;

// Does this line put anything on screen? zsh ends a command's output with a
// partial-line marker — an inverse "%", a run of spaces and a carriage return —
// which occupies a line in the raw bytes but shows nothing.
function hasVisibleText(line) {
  // Drop the CR that pairs with the newline we split on.
  let text = line.replace(/\r$/, '');
  // A carriage return sends the cursor back to column 0, so only what comes
  // after the last one is still on screen — which is how the marker erases
  // itself with "\r \r".
  const lastReturn = text.lastIndexOf('\r');
  if (lastReturn !== -1) text = text.slice(lastReturn + 1);
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x07\b]/g, '')
    .trim().length > 0;
}

function countLines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

export class BlockModel {
  constructor(options = {}) {
    this.options = options;
    this.blocks = [];
    this.pending = '';       // partial escape sequence held back between chunks
    this.cwd = '';
    this.shellCommands = [];
    this.onCwdChange = () => {};
    this.onCommands = () => {};
    this.onBlockEnd = () => {};
    this.startBlock();
  }

  get current() {
    return this.blocks[this.blocks.length - 1];
  }

  startBlock() {
    const block = {
      id: nextBlockId++,
      head: '',        // prompt plus whatever the shell echoed while typing
      output: '',      // everything the command printed
      command: '',     // the command text, filled in by the session at run time
      exitCode: null,
      cwd: this.cwd,
      startedAt: 0,
      endedAt: 0,
      state: 'prompt', // prompt -> output -> done
      fold: 'full',    // full | truncated | hidden
      outputLines: 0,
      dropped: 0,      // bytes discarded because the output was enormous
    };
    this.blocks.push(block);

    const max = this.options.maxBlocks || 300;
    if (this.blocks.length > max) this.blocks.splice(0, this.blocks.length - max);
    return block;
  }

  append(text) {
    const block = this.current;
    if (block.state === 'output') {
      const limit = this.options.maxBytesPerBlock || 2 * 1024 * 1024;
      block.outputLines += countLines(text);
      block.output += text;
      if (block.output.length > limit) {
        // Keep the beginning and the most recent tail: those are the parts
        // anyone ever reads back. Cut only what is genuinely in the middle —
        // taking a head and a tail that overlap would duplicate the overlap
        // rather than drop it, and leave the block longer than the limit.
        const keepTail = Math.floor(limit / 2);
        const keepHead = limit - keepTail;
        block.dropped += block.output.length - limit;
        block.output = block.output.slice(0, keepHead) + block.output.slice(block.output.length - keepTail);
      }
    } else {
      block.head += text;
    }
  }

  /**
   * Consume a chunk of shell output. Returns the text that should be written to
   * the terminal (the semantic marks are stripped so they can never be echoed
   * back during a replay).
   */
  ingest(chunk) {
    let text = this.pending + chunk;
    this.pending = '';

    // If the chunk ends mid-escape-sequence, hold the tail until more arrives.
    const lastEsc = text.lastIndexOf('\x1b');
    if (lastEsc !== -1) {
      const tail = text.slice(lastEsc);
      // Hold back only a possible OSC prefix: a bare ESC, or ESC ] with no
      // terminator yet. Anything else (a CSI, a complete OSC) can go straight out.
      const maybeOsc = /^\x1b(\]|$)/.test(tail);
      const complete = !maybeOsc || /\x07|\x1b\\/.test(tail) || tail.length > 512;
      if (!complete) {
        this.pending = tail;
        text = text.slice(0, lastEsc);
      }
    }

    let out = '';
    const pattern = /\x1b\](133|1337);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let index = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const before = text.slice(index, match.index);
      if (before) { this.append(before); out += before; }
      index = pattern.lastIndex;
      this.handleMark(match[1], match[2]);
    }

    const rest = text.slice(index);
    if (rest) { this.append(rest); out += rest; }
    return out;
  }

  handleMark(kind, body) {
    if (kind === '1337') {
      const eq = body.indexOf('=');
      const key = eq === -1 ? body : body.slice(0, eq);
      const value = eq === -1 ? '' : body.slice(eq + 1);
      if (key === 'CurrentDir') {
        this.cwd = value;
        if (this.current) this.current.cwd = value;
        this.onCwdChange(value);
      } else if (key === 'BasaltCmds') {
        try {
          this.shellCommands = atob(value).split('\n').map((s) => s.trim()).filter(Boolean);
          this.onCommands(this.shellCommands);
        } catch (_) { /* malformed payload; not worth surfacing */ }
      }
      return;
    }

    const [code, arg] = body.split(';');
    if (code === 'A') {
      // A new prompt. Close the previous block unless it is still the empty
      // one we opened at startup.
      const block = this.current;
      if (block && (block.head || block.output)) {
        if (block.state !== 'done') block.state = 'done';
        this.startBlock();
      }
      this.current.cwd = this.cwd;
    } else if (code === 'C') {
      const block = this.current;
      block.state = 'output';
      block.startedAt = Date.now();
    } else if (code === 'D') {
      const block = this.current;
      block.state = 'done';
      block.endedAt = Date.now();
      block.exitCode = arg === undefined || arg === '' ? null : Number(arg);
      this.applyAutoFold(block);
      this.onBlockEnd(block);
    }
  }

  applyAutoFold(block) {
    const { autoTruncate, truncateThreshold } = this.options;
    if (!autoTruncate) return;
    if (block.outputLines > (truncateThreshold || 40)) block.fold = 'truncated';
  }

  byId(id) {
    return this.blocks.find((b) => b.id === id) || null;
  }

  // Blocks that actually have foldable output, newest last.
  foldable() {
    return this.blocks.filter((b) => b.state === 'done' && b.outputLines > 0);
  }

  lastFoldable() {
    const list = this.foldable();
    return list.length ? list[list.length - 1] : null;
  }

  setFold(id, fold) {
    const block = this.byId(id);
    if (block) block.fold = fold;
    return block;
  }

  cycleFold(id) {
    const block = this.byId(id);
    if (!block) return null;
    block.fold = block.fold === 'full' ? 'truncated' : block.fold === 'truncated' ? 'hidden' : 'full';
    return block;
  }

  setFoldAll(fold) {
    for (const block of this.foldable()) block.fold = fold;
  }

  summaryFor(block, hiddenLines, mode) {
    const label = mode === 'hidden'
      ? `${hiddenLines} line${hiddenLines === 1 ? '' : 's'} hidden`
      : `${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}`;
    const status = block.exitCode && this.options.showExitStatus !== false ? `  exit ${block.exitCode}` : '';
    return `${DIM}  ${SUMMARY_GLYPH} ${label} — click to show${status}${RESET}\r\n`;
  }

  /**
   * The full scrollback, block by block, honouring each block's fold state.
   * Returns segments so the caller can write them one at a time and learn which
   * terminal row each summary line landed on.
   */
  render(options = {}) {
    const headLines = options.headLines ?? 12;
    const tailLines = options.tailLines ?? 6;
    const budget = options.maxBytes ?? 4 * 1024 * 1024;

    // Trim from the top if the scrollback is too big to replay quickly.
    let start = 0;
    let total = 0;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      total += block.head.length + (block.fold === 'full' ? block.output.length : 400);
      if (total > budget) { start = i + 1; break; }
    }

    const segments = [];
    if (start > 0) {
      segments.push({ text: `${DIM}  ${start} earlier command${start === 1 ? '' : 's'} not shown${RESET}\r\n`, blockId: null });
    }

    for (let i = start; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.head) segments.push({ text: block.head, blockId: null });
      if (!block.output) continue;

      if (block.fold === 'full' || block.outputLines === 0) {
        segments.push({ text: block.output, blockId: null });
        continue;
      }

      if (block.fold === 'hidden') {
        segments.push({ text: this.summaryFor(block, block.outputLines, 'hidden'), blockId: block.id, summary: true });
        continue;
      }

      // Truncated: keep the head and tail, elide the middle. The last split
      // element is normally invisible — the empty string after a trailing
      // newline, or the shell's partial-line marker — so set it aside rather
      // than letting it eat one of the tail's slots, and put it back at the end.
      const lines = block.output.split('\n');
      const trailer = hasVisibleText(lines[lines.length - 1]) ? null : lines.pop();

      if (lines.length <= headLines + tailLines + 1) {
        segments.push({ text: block.output, blockId: null });
        continue;
      }

      const head = lines.slice(0, headLines).join('\n');
      const tail = lines.slice(lines.length - tailLines).join('\n');
      const hidden = lines.length - headLines - tailLines;
      segments.push({ text: head + '\n', blockId: null });
      segments.push({ text: this.summaryFor(block, hidden, 'truncated'), blockId: block.id, summary: true });
      segments.push({ text: RESET + tail + (trailer === null ? '' : '\n' + trailer), blockId: null });
    }

    return segments;
  }
}
