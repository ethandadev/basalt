// One terminal tab: an xterm instance, its PTY, its block model, and all the
// editing affordances layered on top (inline prediction, the completion menu,
// selection-aware editing, output folding).

import { BlockModel } from './blocks.js';

const { Terminal } = window;
const { FitAddon } = window.FitAddon;
const { SearchAddon } = window.SearchAddon;
const { WebglAddon } = window.WebglAddon;
const { WebLinksAddon } = window.WebLinksAddon;
const { Unicode11Addon } = window.Unicode11Addon;

// A key that produces a character, as opposed to a named key like "ArrowLeft".
function isPrintableKey(event) {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey;
}

// How long the shell must stay quiet after drawing a prompt before we take the
// cursor position to be the start of the input line.
const IDLE_MS = 14;

let nextSessionId = 1;

export class Session {
  constructor({ container, settings, shell, cwd, onTitle, onState, onBell }) {
    this.key = nextSessionId++;
    this.settings = settings;
    this.onTitle = onTitle || (() => {});
    this.onState = onState || (() => {});
    this.onBell = onBell || (() => {});

    this.ptyId = null;
    this.shell = shell || '';
    this.shellBase = '';
    this.integrated = false;
    this.cwd = cwd || '';
    this.title = '';
    this.exited = false;

    this.inputStart = null;       // buffer position where the typed line begins
    this.awaitingPrompt = true;
    this.idleTimer = null;
    this.decoder = new TextDecoder('utf-8', { fatal: false });

    this.history = [];
    this.shellCommands = [];
    this.suggestion = '';
    this.suggestToken = 0;
    this.completion = null;       // active completion menu state
    this.summaryRows = new Map(); // terminal row -> block id, rebuilt on replay
    this.replaying = false;
    this.queued = [];             // shell output held back during a redraw
    this.disposed = false;        // set once the terminal is gone, so the async
                                  // work still in flight knows to stand down
    this.pendingCommand = '';     // run as soon as there is a prompt to run it at

    this.buildDom(container);
    this.buildTerminal();
    this.buildModel();
  }

  // --- setup -----------------------------------------------------------------

  buildDom(container) {
    this.root = document.createElement('div');
    this.root.className = 'session';

    this.termHost = document.createElement('div');
    this.termHost.className = 'session-term';
    this.root.appendChild(this.termHost);

    this.ghost = document.createElement('div');
    this.ghost.className = 'ghost';
    this.ghost.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.ghost);

    this.menu = document.createElement('div');
    this.menu.className = 'completion';
    this.menu.hidden = true;
    this.root.appendChild(this.menu);

    container.appendChild(this.root);
  }

  buildTerminal() {
    const { appearance, behavior, theme } = this.settings;

    this.term = new Terminal({
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      letterSpacing: appearance.letterSpacing,
      cursorStyle: appearance.cursorStyle,
      cursorBlink: appearance.cursorBlink,
      scrollback: behavior.scrollback,
      scrollSensitivity: behavior.scrollSensitivity,
      minimumContrastRatio: appearance.minimumContrastRatio,
      macOptionIsMeta: behavior.optionAsMeta !== false,
      rightClickSelectsWord: false,
      allowProposedApi: true,
      allowTransparency: appearance.opacity < 1 || appearance.vibrancy,
      theme: this.xtermTheme(theme, appearance),
      windowsMode: false,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    // The addon's own handler calls window.open, which in Electron would open
    // the URL in an app window rather than the browser. Hand it to the system
    // instead, and stand aside when the click was meant to move the cursor.
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event[this.cursorClickModifier]) return;
      window.basalt.openExternal(uri);
    }));

    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';

    this.term.open(this.termHost);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch (_) {
      // No GPU context available; xterm falls back to its DOM renderer.
    }

    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.term.onData((data) => this.onTerminalInput(data));
    this.term.onBinary((data) => this.write(data));
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId) window.basalt.pty.resize(this.ptyId, cols, rows);
    });
    this.term.onTitleChange((title) => { this.title = title; this.onTitle(this); });
    this.term.onBell(() => this.onBell(this));
    this.term.onCursorMove(() => this.refreshPrediction());
    this.term.onSelectionChange(() => this.handleSelectionChange());

    this.termHost.addEventListener('contextmenu', (event) => this.showContextMenu(event));
    this.termHost.addEventListener('click', (event) => this.handleClick(event));
    this.termHost.addEventListener('mousedown', (event) => this.handleMouseDown(event), true);
    this.termHost.addEventListener('scroll', () => this.hidePrediction(), true);
    this.term.element.addEventListener('wheel', () => this.closeCompletion(), { passive: true });
  }

  buildModel() {
    const { blocks } = this.settings;
    this.model = new BlockModel({ ...blocks });
    this.model.onCwdChange = (cwd) => {
      this.cwd = cwd;
      if (this.ptyId) window.basalt.pty.setCwd(this.ptyId, cwd);
      this.onTitle(this);
    };
    this.model.onCommands = (list) => { this.shellCommands = list; };
    this.model.onBlockEnd = () => {
      this.onState(this);
      // A block that auto-folded needs the screen rewritten to show the fold.
      if (this.settings.blocks.enabled && this.settings.blocks.autoTruncate) {
        const last = this.model.lastFoldable();
        if (last && last.fold !== 'full') this.replay();
      }
    };
  }

  xtermTheme(theme, appearance) {
    const out = { ...theme };
    delete out.name; delete out.ui;
    if (appearance.opacity < 1 || appearance.vibrancy) out.background = 'rgba(0,0,0,0)';
    return out;
  }

  async start() {
    const info = await window.basalt.pty.create({
      shell: this.shell,
      cwd: this.cwd,
      cols: this.term.cols,
      rows: this.term.rows,
      login: this.settings.shell.loginShell,
      args: this.settings.shell.args,
    });

    this.ptyId = info.id;
    this.shell = info.shell;
    this.shellBase = info.shellBase;
    this.integrated = info.integrated;
    this.cwd = info.cwd;
    this.onTitle(this);
    this.onState(this);

    // Merge rather than replace: commands run before the file finished loading
    // must not be lost.
    window.basalt.history(this.shellBase).then((entries) => {
      if (this.disposed) return;
      const already = new Set(this.history);
      this.history = (entries || []).filter((entry) => !already.has(entry)).concat(this.history);
    });
    this.fit();
    return info;
  }

  // --- data flow -------------------------------------------------------------

  receive(bytes) {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!text) return;

    // A fold redraws the whole screen over several async writes. Anything the
    // shell says meanwhile has to wait, or it lands in the middle of the redraw.
    if (this.replaying) { this.queued.push(text); return; }
    this.consume(text);
  }

  consume(text) {
    const visible = this.settings.blocks.enabled ? this.model.ingest(text) : text;
    if (visible) this.term.write(visible);
    this.scheduleIdleCheck();
  }

  write(data) {
    if (this.ptyId && !this.exited) window.basalt.pty.write(this.ptyId, data);
  }

  onTerminalInput(data) {
    // Anything xterm decided to send: keystrokes, pastes, mouse reports.
    this.write(data);
    if (data.includes('\r')) {
      this.commitInput();
    }
  }

  commitInput() {
    const line = this.readInput();
    if (line && line.trim()) {
      const block = this.model.current;
      if (block) block.command = line.trim();
      // Keep in-session commands in the prediction pool immediately.
      const trimmed = line.trim();
      const at = this.history.indexOf(trimmed);
      if (at !== -1) this.history.splice(at, 1);
      this.history.push(trimmed);
    }
    this.inputStart = null;
    this.awaitingPrompt = true;
    this.hidePrediction();
    this.closeCompletion();
  }

  scheduleIdleCheck() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle(), IDLE_MS);
  }

  onIdle() {
    if (this.replaying) return;
    const alternate = this.term.buffer.active.type === 'alternate';
    if (alternate) { this.inputStart = null; this.hidePrediction(); return; }

    // The prompt has finished drawing: wherever the cursor is now is where the
    // user's typing will begin. Shells without Basalt's integration get the
    // same treatment whenever we have no anchor at all.
    if (this.awaitingPrompt || (!this.integrated && !this.inputStart)) {
      const buffer = this.term.buffer.active;
      this.inputStart = { y: buffer.baseY + buffer.cursorY, x: buffer.cursorX };
      this.awaitingPrompt = false;
    }

    // A command queued before the shell was ready — an ssh connection, say —
    // waits for a prompt rather than being typed into a shell that is still
    // starting up and would drop it.
    if (this.pendingCommand && this.inputStart && !this.disposed) {
      const command = this.pendingCommand;
      this.pendingCommand = '';
      this.write(`${command}\r`);
      return;
    }

    this.refreshPrediction();
  }

  // --- reading the input line ------------------------------------------------

  readInput(toEnd = false) {
    if (!this.inputStart) return '';
    const buffer = this.term.buffer.active;
    if (buffer.type === 'alternate') return '';

    const endY = toEnd ? buffer.baseY + buffer.length - 1 : buffer.baseY + buffer.cursorY;
    const endX = toEnd ? -1 : buffer.cursorX;
    if (endY < this.inputStart.y) return '';

    let text = '';
    for (let y = this.inputStart.y; y <= endY; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      const from = y === this.inputStart.y ? this.inputStart.x : 0;
      const nextWrapped = y < endY && buffer.getLine(y + 1)?.isWrapped;
      const to = (y === endY && endX >= 0) ? endX : line.length;
      if (to <= from && !nextWrapped) { if (y !== endY) text += '\n'; continue; }
      text += line.translateToString(!nextWrapped, from, to);
      if (y !== endY && !nextWrapped) text += '\n';
    }
    return text;
  }

  // The whole line, including anything to the right of the cursor.
  readFullInput() {
    if (!this.inputStart) return '';
    const buffer = this.term.buffer.active;
    const cursorY = buffer.baseY + buffer.cursorY;
    let lastY = cursorY;
    while (buffer.getLine(lastY + 1)?.isWrapped) lastY++;

    let text = '';
    for (let y = this.inputStart.y; y <= lastY; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      const from = y === this.inputStart.y ? this.inputStart.x : 0;
      const nextWrapped = y < lastY && buffer.getLine(y + 1)?.isWrapped;
      text += line.translateToString(!nextWrapped, from, line.length);
    }
    return text;
  }

  cursorOffset() {
    return this.readInput().length;
  }

  /**
   * Is the cursor effectively at the end of the line? A shell that has just
   * shortened the line leaves real space characters in the cells beyond it, so
   * "only blanks after the cursor" is the honest test rather than an exact
   * length match.
   */
  isAtEndOfInput() {
    const before = this.readInput();
    const full = this.readFullInput();
    return full.slice(before.length).trim() === '';
  }

  // Walk `count` cells backwards through the buffer, following wrapped rows.
  positionBack(from, count) {
    const buffer = this.term.buffer.active;
    let { x, y } = from;
    while (count > 0) {
      if (x >= count) { x -= count; count = 0; break; }
      count -= x;
      y -= 1;
      if (y < 0) return null;
      const line = buffer.getLine(y);
      x = line ? line.length : this.term.cols;
    }
    return { x, y };
  }

  // --- inline prediction -----------------------------------------------------

  async refreshPrediction() {
    if (this.disposed) return;
    if (!this.settings.prediction.ghostText || this.replaying) { this.hideGhost(); return; }
    if (!this.inputStart || this.term.buffer.active.type === 'alternate') { this.hideGhost(); return; }

    const before = this.readInput();

    // Only predict at the end of the line — a suggestion in the middle of what
    // you are editing is noise.
    if (!before || !this.isAtEndOfInput()) { this.hideGhost(); return; }
    if (before.length < (this.settings.prediction.completionMinChars || 0)) { this.hideGhost(); return; }

    const token = ++this.suggestToken;
    let suggestion = '';
    try {
      suggestion = await window.basalt.suggest({
        line: before,
        cwd: this.cwd,
        history: this.history,
        shellCommands: this.shellCommands,
        source: this.settings.prediction.ghostSource,
      });
    } catch (_) { suggestion = ''; }

    if (this.disposed) return;                         // the tab closed meanwhile
    if (token !== this.suggestToken) return;          // a newer keystroke won
    if (this.readInput() !== before) return;           // the line moved on
    this.suggestion = suggestion || '';
    this.suggestion ? this.drawGhost() : this.hideGhost();
  }

  cellSize() {
    try {
      const dimensions = this.term._core._renderService.dimensions.css.cell;
      if (dimensions.width > 0) return dimensions;
    } catch (_) { /* fall through to a measurement */ }
    const rows = this.termHost.querySelector('.xterm-rows');
    const height = rows ? rows.firstElementChild?.getBoundingClientRect().height : 0;
    return { width: this.term.element.clientWidth / this.term.cols, height: height || 17 };
  }

  drawGhost() {
    const buffer = this.term.buffer.active;
    const cell = this.cellSize();
    const screen = this.termHost.querySelector('.xterm-screen');
    if (!screen || !cell.width) { this.hideGhost(); return; }

    const rect = screen.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    const left = rect.left - host.left + buffer.cursorX * cell.width;
    const top = rect.top - host.top + buffer.cursorY * cell.height;

    // Clip to what fits on the rest of the row.
    const room = Math.max(0, this.term.cols - buffer.cursorX);
    this.ghost.textContent = this.suggestion.slice(0, room);
    this.ghost.style.left = `${left}px`;
    this.ghost.style.top = `${top}px`;
    this.ghost.style.height = `${cell.height}px`;
    this.ghost.style.lineHeight = `${cell.height}px`;
    this.ghost.style.fontSize = `${this.settings.appearance.fontSize}px`;
    this.ghost.style.fontFamily = this.settings.appearance.fontFamily;
    this.ghost.style.letterSpacing = `${this.settings.appearance.letterSpacing}px`;
    this.ghost.classList.add('visible');
  }

  hideGhost() {
    this.suggestion = '';
    this.ghost.classList.remove('visible');
    this.ghost.textContent = '';
  }

  hidePrediction() {
    this.hideGhost();
    this.closeCompletion();
  }

  acceptSuggestion(wordOnly = false) {
    if (!this.suggestion) return false;
    let text = this.suggestion;
    if (wordOnly) {
      const match = text.match(/^\s*[^\s/]*\/?/);
      text = match ? match[0] : text;
    }
    this.write(text);
    this.hideGhost();
    return true;
  }

  // --- completion menu -------------------------------------------------------

  async openCompletion() {
    if (this.disposed) return false;
    const before = this.readInput();
    const result = await window.basalt.complete({
      line: before,
      cursor: before.length,
      cwd: this.cwd,
      shellCommands: this.shellCommands,
      history: this.history,
    });

    if (this.disposed) return false;
    if (!result.candidates.length) return false;

    // First insert whatever every candidate agrees on, exactly like a shell.
    const shared = result.commonPrefix;
    if (shared && shared.length > result.token.length && shared.startsWith(result.token)) {
      this.write(shared.slice(result.token.length));
      result.token = shared;
    }

    if (result.candidates.length === 1) {
      const only = result.candidates[0];
      const remaining = only.value.slice(result.token.length);
      if (remaining) this.write(remaining);
      if (only.type !== 'directory' && !only.value.endsWith('/')) this.write(' ');
      return true;
    }

    this.completion = {
      items: result.candidates.slice(0, Math.max(3, this.settings.prediction.completionMaxItems * 4)),
      index: 0,
      token: result.token,
    };
    this.renderCompletion();
    return true;
  }

  renderCompletion() {
    if (!this.completion) { this.menu.hidden = true; return; }
    const { items, index } = this.completion;
    const max = this.settings.prediction.completionMaxItems || 12;

    // Keep the highlighted row inside the visible window.
    const start = Math.max(0, Math.min(index - Math.floor(max / 2), items.length - max));
    const visible = items.slice(Math.max(0, start), Math.max(0, start) + max);

    this.menu.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'completion-list';

    visible.forEach((item, offset) => {
      const realIndex = Math.max(0, start) + offset;
      const row = document.createElement('div');
      row.className = 'completion-item' + (realIndex === index ? ' selected' : '');
      row.innerHTML = `<span class="ci-icon ci-${item.type}"></span>`;
      const label = document.createElement('span');
      label.className = 'ci-label';
      label.textContent = item.display;
      row.appendChild(label);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'ci-detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      const kind = document.createElement('span');
      kind.className = 'ci-kind';
      kind.textContent = item.type;
      row.appendChild(kind);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.completion.index = realIndex;
        this.acceptCompletion();
      });
      list.appendChild(row);
    });

    this.menu.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'completion-footer';
    footer.textContent = `${items.length} match${items.length === 1 ? '' : 'es'}  ·  ↑↓ move  ·  ⇥ next  ·  ⏎ choose  ·  esc dismiss`;
    this.menu.appendChild(footer);

    this.menu.hidden = false;
    this.positionCompletion();
  }

  positionCompletion() {
    const buffer = this.term.buffer.active;
    const cell = this.cellSize();
    const screen = this.termHost.querySelector('.xterm-screen');
    if (!screen) return;

    const rect = screen.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    const cursorLeft = rect.left - host.left + buffer.cursorX * cell.width;
    const cursorTop = rect.top - host.top + buffer.cursorY * cell.height;

    this.menu.style.visibility = 'hidden';
    this.menu.style.left = '0px';
    this.menu.style.top = '0px';
    const size = this.menu.getBoundingClientRect();

    // Prefer below the cursor, flip above when there is no room.
    let top = cursorTop + cell.height + 2;
    if (top + size.height > host.height - 4) top = Math.max(4, cursorTop - size.height - 2);
    const left = Math.max(4, Math.min(cursorLeft, host.width - size.width - 8));

    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
    this.menu.style.visibility = 'visible';
  }

  moveCompletion(delta) {
    if (!this.completion) return;
    const count = this.completion.items.length;
    if (!count) return;   // modulo zero would make the index NaN
    this.completion.index = (this.completion.index + delta + count) % count;
    this.renderCompletion();
  }

  acceptCompletion() {
    if (!this.completion) return;
    const { items, index, token } = this.completion;
    const item = items[index];
    this.closeCompletion();

    // Replace the token by rubbing it out and typing the replacement, which
    // works in every line editor without needing to know its key bindings.
    if (token.length) this.write('\x7f'.repeat(token.length));
    this.write(item.value);
    if (item.type !== 'directory' && item.type !== 'history' && !item.value.endsWith('/')) this.write(' ');
  }

  closeCompletion() {
    this.completion = null;
    this.menu.hidden = true;
  }

  // --- selection-aware editing ----------------------------------------------

  handleSelectionChange() {
    if (this.settings.behavior.copyOnSelect) {
      const text = this.term.getSelection();
      if (text) window.basalt.clipboard.write(text);
    }
    this.onState(this);
  }

  // Where the current selection sits inside the typed line, if it is inside it.
  selectionRange() {
    if (!this.inputStart || !this.term.hasSelection()) return null;
    const position = this.term.getSelectionPosition();
    if (!position) return null;

    const toOffset = (point) => {
      if (point.y < this.inputStart.y) return null;
      const buffer = this.term.buffer.active;
      let offset = 0;
      for (let y = this.inputStart.y; y <= point.y; y++) {
        const line = buffer.getLine(y);
        if (!line) return null;
        const from = y === this.inputStart.y ? this.inputStart.x : 0;
        const to = y === point.y ? point.x : line.length;
        offset += Math.max(0, to - from);
      }
      return offset;
    };

    const start = toOffset(position.start);
    const end = toOffset(position.end);
    if (start === null || end === null || end <= start) return null;

    const length = this.readFullInput().length;
    if (end > length) return null;
    return { start, end };
  }

  moveCursorTo(offset) {
    const current = this.cursorOffset();
    const delta = offset - current;
    if (delta === 0) return;
    this.write((delta > 0 ? '\x1b[C' : '\x1b[D').repeat(Math.abs(delta)));
  }

  // Delete whatever is selected on the input line, then optionally type over it.
  replaceSelection(text = '') {
    const range = this.selectionRange();
    if (!range) return false;
    this.moveCursorTo(range.end);
    this.write('\x7f'.repeat(range.end - range.start));
    if (text) this.write(text);
    this.term.clearSelection();
    return true;
  }

  // Which buffer row is under the pointer, in absolute (scrollback) coordinates.
  rowAt(clientY) {
    const cell = this.cellSize();
    const screen = this.termHost.querySelector('.xterm-screen');
    if (!screen || !cell.height) return null;
    const rect = screen.getBoundingClientRect();
    return Math.floor((clientY - rect.top) / cell.height) + this.term.buffer.active.baseY;
  }

  // Clicking a fold summary opens the output back up.
  handleClick(event) {
    // A modifier-click is positioning the cursor, not toggling a fold.
    if (event.button !== 0 || event[this.cursorClickModifier] || this.term.hasSelection()) return;
    const row = this.rowAt(event.clientY);
    if (row === null || !this.blockAtRow(row)) return;
    event.preventDefault();
    this.toggleBlockAt(row);
  }

  // macOS reserves ⌘ for applications, so ⌘-click is free for the terminal.
  // On Linux the window manager usually claims Super, and Alt-drag moves
  // windows, which leaves Ctrl as the modifier a click reliably arrives with.
  get cursorClickModifier() {
    return this.settings.platform === 'darwin' ? 'metaKey' : 'ctrlKey';
  }

  handleMouseDown(event) {
    // Modifier-click puts the shell's cursor where you clicked.
    if (!event[this.cursorClickModifier] || event.button !== 0 || !this.inputStart) return;
    const cell = this.cellSize();
    const screen = this.termHost.querySelector('.xterm-screen');
    if (!screen || !cell.width) return;

    const rect = screen.getBoundingClientRect();
    const column = Math.round((event.clientX - rect.left) / cell.width);
    const row = Math.floor((event.clientY - rect.top) / cell.height) + this.term.buffer.active.baseY;

    const buffer = this.term.buffer.active;
    let offset = 0;
    for (let y = this.inputStart.y; y <= row; y++) {
      const line = buffer.getLine(y);
      if (!line) return;
      const from = y === this.inputStart.y ? this.inputStart.x : 0;
      const to = y === row ? Math.max(from, column) : line.length;
      offset += Math.max(0, to - from);
    }

    const max = this.readFullInput().length;
    event.preventDefault();
    event.stopPropagation();
    this.moveCursorTo(Math.min(offset, max));
  }

  // --- folding ---------------------------------------------------------------

  async replay() {
    if (this.disposed || !this.settings.blocks.enabled || this.replaying) return;
    this.hidePrediction();

    // Move the shell's cursor to the end of the line first, so its idea of where
    // the cursor is matches the line we are about to redraw. This happens before
    // the redraw starts so the echo is captured normally.
    const pending = this.readInput() ? this.readFullInput().trimEnd() : '';
    if (pending && !this.isAtEndOfInput()) {
      this.write('\x05');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    this.replaying = true;
    if (this.disposed) { this.replaying = false; return; }

    // receive() holds back anything that arrives from here on, but output handed
    // to xterm before this point may still be sitting in its own write queue.
    // Resetting now would be undone when that queue drains on top of the fresh
    // render, leaving a copy of the unfolded output above it. Writing nothing
    // and waiting for the callback lets the queue settle first.
    await new Promise((resolve) => this.term.write('', resolve));

    const segments = this.model.render({
      headLines: this.settings.blocks.headLines,
      tailLines: this.settings.blocks.tailLines,
    });

    this.summaryRows.clear();
    this.term.reset();
    // reset() restores the modes and clears the screen but leaves the scrollback
    // alone, which would strand an unfolded copy of the output above the redraw.
    // ED 3 discards it, so what we write next is the whole buffer.
    await new Promise((resolve) => this.term.write('\x1b[3J', resolve));

    for (const segment of segments) {
      if (this.disposed) { this.replaying = false; return; }
      await new Promise((resolve) => this.term.write(segment.text, resolve));
      if (segment.summary) {
        const buffer = this.term.buffer.active;
        // The summary ends in a newline, so it occupies the row above the cursor.
        this.summaryRows.set(buffer.baseY + buffer.cursorY - 1, segment.blockId);
      }
    }

    // Re-anchor the input line: the cursor now sits at the end of the replayed
    // prompt plus whatever had been typed.
    const buffer = this.term.buffer.active;
    const cursor = { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY };
    this.inputStart = pending ? (this.positionBack(cursor, pending.length) || cursor) : cursor;
    this.awaitingPrompt = false;

    this.term.scrollToBottom();
    this.replaying = false;

    // Anything the shell said during the redraw goes in now, in order.
    const held = this.queued;
    this.queued = [];
    for (const text of held) this.consume(text);

    this.onState(this);
    this.refreshPrediction();
  }

  blockAtRow(row) {
    return this.summaryRows.get(row) || null;
  }

  async toggleBlockAt(row) {
    const id = this.blockAtRow(row);
    if (!id) return false;
    const block = this.model.byId(id);
    if (!block) return false;
    block.fold = block.fold === 'full' ? 'truncated' : 'full';
    await this.replay();
    return true;
  }

  async foldLast(mode) {
    const block = this.model.lastFoldable();
    if (!block) return false;
    block.fold = mode;
    await this.replay();
    return true;
  }

  async cycleFoldLast() {
    const block = this.model.lastFoldable();
    if (!block) return false;
    this.model.cycleFold(block.id);
    await this.replay();
    return true;
  }

  async setFoldAll(mode) {
    this.model.setFoldAll(mode);
    await this.replay();
  }

  async setFold(id, mode) {
    this.model.setFold(id, mode);
    await this.replay();
  }

  // --- keyboard --------------------------------------------------------------

  /**
   * Runs before xterm turns a key into bytes. Returning false stops xterm from
   * handling it, which is how the completion menu and prediction take over keys
   * the shell would otherwise see.
   */
  handleKey(event) {
    if (event.type !== 'keydown') return true;

    const meta = event.metaKey;
    const alt = event.altKey;
    const ctrl = event.ctrlKey;

    if (this.completion) {
      // Telling xterm to ignore a key is not the same as telling the browser to.
      // Without preventDefault the menu cycles while DOM focus jumps to the next
      // control in the toolbar, which is the last thing a terminal should do.
      const consume = (fn) => { event.preventDefault(); fn(); return false; };
      switch (event.key) {
        case 'ArrowDown': return consume(() => this.moveCompletion(1));
        case 'ArrowUp': return consume(() => this.moveCompletion(-1));
        case 'Tab': return consume(() => this.moveCompletion(event.shiftKey ? -1 : 1));
        case 'Enter': case 'ArrowRight': return consume(() => this.acceptCompletion());
        case 'Escape': return consume(() => this.closeCompletion());
        case 'ArrowLeft': this.closeCompletion(); return true;
        default:
          if (!meta && !ctrl) this.closeCompletion();
          return true;
      }
    }

    // ⌘ shortcuts belong to the application menu, not the shell.
    if (meta) return true;

    // When Tab is the chosen accept key, a pending suggestion claims it before
    // the completion menu does.
    if (event.key === 'Tab' && !ctrl && !alt && !event.shiftKey
        && this.suggestion && this.settings.prediction.acceptKey === 'tab') {
      event.preventDefault();
      this.acceptSuggestion();
      return false;
    }

    if (event.key === 'Tab' && !ctrl && !alt && this.canPredict()) {
      if (this.settings.prediction.completionMenu) {
        event.preventDefault();
        // If nothing matched, let the shell have its own go at completing.
        this.openCompletion().then((handled) => { if (!handled) this.write('\t'); });
        return false;
      }
    }

    if (this.suggestion) {
      const acceptKey = this.settings.prediction.acceptKey;
      const atEnd = this.isAtEndOfInput();
      if (event.key === 'ArrowRight' && atEnd && acceptKey === 'right' && !alt && !ctrl) {
        event.preventDefault(); this.acceptSuggestion(); return false;
      }
      // End always accepts, whichever key was chosen as the primary one.
      if (event.key === 'End') { event.preventDefault(); this.acceptSuggestion(); return false; }
      if (event.key === 'ArrowRight' && alt && atEnd) { event.preventDefault(); this.acceptSuggestion(true); return false; }
      if (event.key === 'Escape') { this.hideGhost(); return true; }
    }

    // Typing or deleting with a selection on the input line replaces it.
    if (!ctrl && !meta && this.term.hasSelection()) {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (this.replaceSelection()) { event.preventDefault(); return false; }
      } else if (isPrintableKey(event) && !alt) {
        if (this.replaceSelection(event.key)) { event.preventDefault(); return false; }
      }
    }

    // macOS word/line editing, mapped to the readline bindings every shell has.
    if (alt && !ctrl && !meta) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); this.write('\x1bb'); return false; }
      if (event.key === 'ArrowRight') { event.preventDefault(); this.write('\x1bf'); return false; }
      if (event.key === 'Backspace') { event.preventDefault(); this.write('\x1b\x7f'); return false; }
    }

    return true;
  }

  canPredict() {
    return Boolean(this.inputStart)
      && this.term.buffer.active.type !== 'alternate'
      && !this.replaying;
  }

  // --- assorted --------------------------------------------------------------

  async showContextMenu(event) {
    // Right-click-pastes is the older terminal habit, and it replaces the menu
    // rather than sitting alongside it.
    if (this.settings.behavior.pasteOnRightClick) {
      event.preventDefault();
      await this.paste();
      return;
    }
    if (!this.settings.behavior.rightClickMenu) return;
    event.preventDefault();

    const row = this.rowAt(event.clientY);
    const blockId = (row === null ? null : this.blockAtRow(row)) ?? (this.model.lastFoldable()?.id ?? null);

    const action = await window.basalt.dialog.context({ hasSelection: this.term.hasSelection(), blockId });
    if (this.disposed) return;
    const block = blockId ? this.model.byId(blockId) : null;

    switch (action) {
      case 'copy': this.copy(); break;
      case 'paste': this.paste(); break;
      case 'select-all': this.term.selectAll(); break;
      case 'fold-block': if (block) await this.setFold(block.id, 'hidden'); break;
      case 'expand-block': if (block) await this.setFold(block.id, 'full'); break;
      case 'copy-command': if (block) window.basalt.clipboard.write(block.command || ''); break;
      case 'copy-output': if (block) window.basalt.clipboard.write(stripAnsi(block.output)); break;
      case 'rerun': if (block?.command) this.write(block.command + '\r'); break;
      default: break;
    }
  }

  copy() {
    const text = this.term.getSelection();
    if (text) window.basalt.clipboard.write(text);
    else this.write('\x03'); // nothing selected: ⌘C behaves like an interrupt
  }

  async paste(escape = false) {
    let text = await window.basalt.clipboard.read();
    if (!text) return;
    if (escape) text = text.replace(/([ \t"'`$&|;<>()*?![\]\\])/g, '\\$1');
    this.term.paste(text);
  }

  selectInput() {
    if (!this.inputStart) return;
    const full = this.readFullInput();
    if (!full) return;
    this.term.select(this.inputStart.x, this.inputStart.y, full.length);
  }

  clearLine() {
    this.write('\x15');
  }

  clearScrollback() {
    if (this.settings.blocks.enabled) {
      this.model.blocks = [];
      this.model.startBlock();
      this.summaryRows.clear();
    }
    this.term.clear();
  }

  find(term, options = {}) {
    if (!term) { this.searchAddon.clearDecorations?.(); return false; }
    const decorations = {
      matchBackground: '#7a5c00', matchOverviewRuler: '#e0b957',
      activeMatchBackground: '#e0b957', activeMatchColorOverviewRuler: '#e0b957',
    };
    return options.back
      ? this.searchAddon.findPrevious(term, { decorations, regex: false, caseSensitive: false })
      : this.searchAddon.findNext(term, { decorations, regex: false, caseSensitive: false });
  }

  applySettings(settings) {
    this.settings = settings;
    const { appearance, behavior, theme } = settings;

    this.term.options.fontFamily = appearance.fontFamily;
    this.term.options.fontSize = appearance.fontSize;
    this.term.options.lineHeight = appearance.lineHeight;
    this.term.options.letterSpacing = appearance.letterSpacing;
    this.term.options.cursorStyle = appearance.cursorStyle;
    this.term.options.cursorBlink = appearance.cursorBlink;
    this.term.options.scrollback = behavior.scrollback;
    this.term.options.scrollSensitivity = behavior.scrollSensitivity;
    this.term.options.minimumContrastRatio = appearance.minimumContrastRatio;
    this.term.options.macOptionIsMeta = behavior.optionAsMeta !== false;
    this.term.options.allowTransparency = appearance.opacity < 1 || appearance.vibrancy;
    this.term.options.theme = this.xtermTheme(theme, appearance);

    Object.assign(this.model.options, settings.blocks);
    this.fit();
  }

  fit() {
    try { this.fitAddon.fit(); } catch (_) { /* the tab is hidden right now */ }
    if (this.completion) this.positionCompletion();
    if (this.suggestion) this.drawGhost();
  }

  focus() {
    this.term.focus();
  }

  setVisible(visible) {
    this.root.classList.toggle('active', visible);
    if (visible) {
      requestAnimationFrame(() => { this.fit(); this.focus(); });
    } else {
      this.hidePrediction();
    }
  }

  markExited(code) {
    this.exited = true;
    this.ptyId = null;
    this.hidePrediction();
    this.term.write(`\r\n\x1b[2m[session ended${code ? ` with status ${code}` : ''}]\x1b[0m\r\n`);
    this.onState(this);
  }

  dispose() {
    // Set before tearing anything down: a suggestion or completion request may
    // already be in flight, and its continuation must not touch a disposed
    // terminal when it lands.
    this.disposed = true;
    clearTimeout(this.idleTimer);
    if (this.ptyId) window.basalt.pty.kill(this.ptyId);
    this.term.dispose();
    this.root.remove();
  }
}

export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n');
}
