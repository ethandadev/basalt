// Window-level wiring: tabs, the shell picker, the command list, find, settings,
// and the menu actions the main process forwards here.

import { Session, stripAnsi } from './session.js';
import { buildSettingsUI, setPath } from './settings-ui.js';
import { createFilesPanel } from './files.js';

const $ = (id) => document.getElementById(id);

const state = {
  raw: null,        // settings as stored on disk
  themes: {},
  shells: [],
  info: null,
  sessions: [],
  active: -1,
  byPty: new Map(),
  findTerm: '',
  systemTheme: 'dark',
};

// Which theme is in force: the mode picks between the light and dark choices,
// and 'auto' asks macOS.
function currentThemeId() {
  const appearance = state.raw.appearance;
  const dark = appearance.mode === 'dark' || (appearance.mode === 'auto' && state.systemTheme === 'dark');
  const id = dark ? appearance.darkTheme : appearance.lightTheme;
  return state.themes[id] ? id : (dark ? 'basalt-dark' : 'basalt-light');
}

function currentTheme() {
  return state.themes[currentThemeId()];
}

// What a Session sees: the stored settings plus the read-only extras it needs.
function viewSettings() {
  return {
    ...state.raw,
    theme: currentTheme(),
    themes: state.themes,
    shells: state.shells,
    platform: state.info?.platform || 'darwin',
    settingsFile: state.info?.settingsFile || '',
  };
}

function activeSession() {
  return state.sessions[state.active] || null;
}

// --- tabs --------------------------------------------------------------------

function tabLabel(session) {
  if (session.customName) return session.customName;
  if (session.title) return session.title;
  const folder = session.cwd ? session.cwd.split('/').filter(Boolean).pop() || '/' : '';
  return folder ? `${session.shellBase || 'shell'} — ${folder}` : (session.shellBase || 'shell');
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = '';

  state.sessions.forEach((session, index) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.draggable = true;
    tab.setAttribute('role', 'tab');
    if (index === state.active) tab.classList.add('active');
    if (session.running) tab.classList.add('running');
    if (session.bell) tab.classList.add('bell');
    if (session.exited) tab.classList.add('exited');

    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    tab.appendChild(badge);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tabLabel(session);
    title.title = session.cwd || '';
    tab.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close tab');
    // Rebuilt on every render, so it misses the one-time pass that keeps the
    // rest of the chrome out of the focus order.
    close.tabIndex = -1;
    close.addEventListener('mousedown', (event) => event.preventDefault());
    close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(index); });
    tab.appendChild(close);

    tab.addEventListener('mousedown', (event) => {
      if (event.button === 1) { event.preventDefault(); closeTab(index); return; }
      // Selecting redraws the whole strip, which would destroy the close button
      // between its mousedown and its click — so the click would never land and
      // the tab would never close. Let the button handle itself.
      if (event.target.closest('.tab-close')) return;
      if (event.button === 0) selectTab(index);
    });

    // Double-click the label to rename the tab.
    title.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      title.contentEditable = 'true';
      title.focus();
      document.execCommand('selectAll', false, null);
      const finish = (commit) => {
        title.contentEditable = 'false';
        const text = title.textContent.trim();
        if (commit) session.customName = text || '';
        renderTabs();
      };
      title.addEventListener('blur', () => finish(true), { once: true });
      title.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); title.blur(); }
        if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); finish(false); }
      });
    });

    tab.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', String(index));
      event.dataTransfer.effectAllowed = 'move';
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => renderTabs());
    tab.addEventListener('dragover', (event) => {
      event.preventDefault();
      const rect = tab.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      tab.classList.toggle('drop-after', after);
      tab.classList.toggle('drop-before', !after);
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-after', 'drop-before'));
    tab.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData('text/plain'));
      const rect = tab.getBoundingClientRect();
      let to = index + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
      // A tab can exit on its own between the drag starting and the drop
      // landing, so the index the drag carried may no longer point at anything.
      // Splicing in the undefined that comes back would corrupt the whole strip.
      const moved = state.sessions[from];
      if (!moved || Number.isNaN(from) || from === index) { renderTabs(); return; }
      const wasActive = activeSession();
      state.sessions.splice(from, 1);
      if (from < to) to -= 1;
      to = Math.max(0, Math.min(to, state.sessions.length));
      state.sessions.splice(to, 0, moved);
      state.active = Math.max(0, state.sessions.indexOf(wasActive));
      renderTabs();
    });

    tabs.appendChild(tab);
  });

  const session = activeSession();
  document.title = session ? tabLabel(session) : 'Basalt';
  updateStatus();
  updateShellButton();
  renderBlockList();
}

async function newTab({ shell, cwd } = {}) {
  const settings = viewSettings();
  let startDir = cwd;
  if (!startDir) {
    if (settings.shell.startingDirectory === 'inherit') startDir = activeSession()?.cwd || '';
    else if (settings.shell.startingDirectory === 'custom') startDir = settings.shell.customDirectory || '';
  }

  const session = new Session({
    container: $('stack'),
    settings,
    shell: shell || settings.shell.defaultShell || '',
    cwd: startDir,
    onTitle: () => renderTabs(),
    onState: () => { renderTabs(); },
    onBell: (bellSession) => handleBell(bellSession),
  });

  state.sessions.push(session);
  state.active = state.sessions.length - 1;
  applyVisibility();

  try {
    const info = await session.start();
    state.byPty.set(info.id, session);
  } catch (error) {
    session.term.write(`\r\n\x1b[31mCould not start ${shell || 'the shell'}: ${error.message}\x1b[0m\r\n`);
  }

  renderTabs();
  return session;
}

function applyVisibility() {
  state.sessions.forEach((session, index) => session.setVisible(index === state.active));
}

function selectTab(index) {
  if (index < 0 || index >= state.sessions.length) return;
  state.active = index;
  const session = state.sessions[index];
  session.bell = false;
  applyVisibility();
  renderTabs();
}

async function closeTab(index) {
  const session = state.sessions[index];
  if (!session) return;

  if (session.ptyId && state.raw.behavior.confirmCloseRunning) {
    const status = await window.basalt.pty.status(session.ptyId);
    if (status.running) {
      const ok = await window.basalt.dialog.confirm({
        title: 'Close this tab?',
        message: `“${status.process}” is still running.`,
        detail: 'Closing the tab will stop it.',
        confirmLabel: 'Close Tab',
      });
      if (!ok) return;
    }
  }

  // The confirmation above is modal but not instantaneous: a shell can exit, or
  // the tabs can be dragged into a new order, while it sits open. Find where
  // this session actually is now rather than trusting the index we came in with,
  // or we would close whichever tab has since taken its place.
  const at = state.sessions.indexOf(session);
  if (at === -1) return;

  if (session.ptyId) state.byPty.delete(session.ptyId);
  session.dispose();
  state.sessions.splice(at, 1);

  if (!state.sessions.length) { window.close(); return; }
  state.active = Math.min(state.active > at ? state.active - 1 : state.active, state.sessions.length - 1);
  applyVisibility();
  renderTabs();
}

function handleBell(session) {
  const mode = state.raw.behavior.bell;
  if (mode === 'none') return;
  if (mode === 'visual') {
    session.bell = true;
    renderTabs();
    return;
  }
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.13);
    setTimeout(() => context.close(), 400);
  } catch (_) { /* audio unavailable */ }
}

// --- status bar and shell picker ---------------------------------------------

function shortPath(path) {
  const home = state.info?.home || '';
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length);
  return path;
}

function updateStatus() {
  const session = activeSession();
  $('status-cwd').textContent = session?.cwd ? shortPath(session.cwd) : '';
  $('status-shell').textContent = session ? (session.shellBase || '') : '';

  let hint = '';
  if (session && !session.integrated && state.raw?.blocks.enabled) {
    hint = 'folding needs zsh or bash';
  } else if (session) {
    const count = session.model.foldable().length;
    const folded = session.model.foldable().filter((b) => b.fold !== 'full').length;
    if (count) hint = folded ? `${folded} of ${count} outputs folded` : `${count} command${count === 1 ? '' : 's'}`;
  }
  $('status-hint').textContent = hint;
}

function updateShellButton() {
  const session = activeSession();
  $('shell-label').textContent = session?.shellBase || 'shell';
  $('shell-dot').className = 'shell-dot' + (session?.integrated ? '' : ' plain');
}

function renderShellMenu() {
  const menu = $('shell-menu');
  menu.innerHTML = '';
  const session = activeSession();

  const label = document.createElement('div');
  label.className = 'popover-label';
  label.textContent = 'Switch this tab to';
  menu.appendChild(label);

  for (const entry of state.shells) {
    const row = document.createElement('div');
    row.className = 'shell-row' + (entry.integrated ? '' : ' plain');

    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = session && session.shell === entry.path ? '✓' : '';
    row.appendChild(check);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    row.appendChild(name);

    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = entry.path;
    row.appendChild(path);

    const add = document.createElement('button');
    add.className = 'newtab';
    add.textContent = '+';
    add.title = `New tab with ${entry.name}`;
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      closeShellMenu();
      newTab({ shell: entry.path });
    });
    row.appendChild(add);

    row.addEventListener('click', () => { closeShellMenu(); switchShell(entry.path); });
    menu.appendChild(row);
  }

  const note = document.createElement('div');
  note.className = 'shell-note';
  note.textContent = 'Click a shell to restart this tab with it, or + to open it in a new tab. A dimmed dot means that shell cannot fold output.';
  menu.appendChild(note);
}

function openShellMenu() {
  renderShellMenu();
  $('shell-menu').hidden = false;
  $('shell-button').setAttribute('aria-expanded', 'true');
}

function closeShellMenu() {
  $('shell-menu').hidden = true;
  $('shell-button').setAttribute('aria-expanded', 'false');
}

async function switchShell(shellPath, { force = false } = {}) {
  const session = activeSession();
  if (!session || (!force && session.shell === shellPath)) return;

  if (session.ptyId && state.raw.behavior.confirmCloseRunning) {
    const status = await window.basalt.pty.status(session.ptyId);
    if (status.running) {
      const ok = await window.basalt.dialog.confirm({
        title: 'Switch shell?',
        message: `“${status.process}” is still running in this tab.`,
        detail: 'Switching shells restarts the session and stops it.',
        confirmLabel: 'Switch',
      });
      if (!ok) return;
    }
  }

  // Same hazard as closeTab: the confirmation is modal but time passes, so the
  // tab may have moved or gone entirely by the time we get here.
  const index = state.sessions.indexOf(session);
  if (index === -1) return;

  const cwd = session.cwd;
  const name = session.customName;
  if (session.ptyId) state.byPty.delete(session.ptyId);
  session.dispose();
  state.sessions.splice(index, 1);

  const replacement = new Session({
    container: $('stack'),
    settings: viewSettings(),
    shell: shellPath,
    cwd,
    onTitle: () => renderTabs(),
    onState: () => renderTabs(),
    onBell: (bellSession) => handleBell(bellSession),
  });
  replacement.customName = name;

  state.sessions.splice(index, 0, replacement);
  state.active = index;
  applyVisibility();

  // A shell that will not start must say so in the tab rather than throwing out
  // of here and leaving a blank one behind, which is what newTab already does.
  try {
    const info = await replacement.start();
    state.byPty.set(info.id, replacement);
  } catch (error) {
    replacement.term.write(`\r\n\x1b[31mCould not start ${shellPath}: ${error.message}\x1b[0m\r\n`);
  }
  renderTabs();
}

// --- command list panel -------------------------------------------------------

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function renderBlockList() {
  const panel = $('blocks-panel');
  if (panel.hidden) return;

  const list = $('block-list');
  list.innerHTML = '';
  const session = activeSession();
  const blocks = session ? session.model.foldable().slice().reverse() : [];

  if (!blocks.length) {
    const empty = document.createElement('div');
    empty.className = 'block-empty';
    empty.textContent = session && !session.integrated
      ? 'This shell does not report where commands start and end, so Basalt cannot fold its output. Switch the tab to zsh or bash to use folding.'
      : 'Commands you run will appear here, with a control to fold or expand each one’s output.';
    list.appendChild(empty);
    return;
  }

  for (const block of blocks) {
    const row = document.createElement('div');
    row.className = 'block-row';

    const command = document.createElement('div');
    command.className = 'cmd';
    command.textContent = block.command || '(command)';
    command.title = block.command || '';
    row.appendChild(command);

    const meta = document.createElement('div');
    meta.className = 'meta';

    if (state.raw.blocks.showExitStatus) {
      const status = document.createElement('span');
      status.className = block.exitCode ? 'status-bad' : 'status-ok';
      status.textContent = block.exitCode ? `exit ${block.exitCode}` : 'ok';
      meta.appendChild(status);
    }

    const lines = document.createElement('span');
    lines.textContent = `${block.outputLines} lines`;
    meta.appendChild(lines);

    // An enormous output is kept only in part, so say so rather than letting the
    // copied text look complete.
    if (block.dropped > 0) {
      const dropped = document.createElement('span');
      dropped.textContent = 'truncated';
      dropped.title = `${block.dropped.toLocaleString()} bytes from the middle of this output were discarded to cap memory use`;
      meta.appendChild(dropped);
    }

    const duration = formatDuration(block.endedAt - block.startedAt);
    if (duration && state.raw.blocks.showTiming) {
      const time = document.createElement('span');
      time.textContent = duration;
      meta.appendChild(time);
    }

    const toggle = document.createElement('button');
    toggle.className = 'fold-toggle';
    toggle.textContent = block.fold === 'full' ? 'Fold' : block.fold === 'truncated' ? 'Shortened' : 'Hidden';
    toggle.addEventListener('click', async (event) => {
      event.stopPropagation();
      session.model.cycleFold(block.id);
      await session.replay();
      renderBlockList();
    });
    meta.appendChild(toggle);

    row.appendChild(meta);
    row.addEventListener('click', () => window.basalt.clipboard.write(stripAnsi(block.output)));
    row.title = 'Click to copy this command’s output';
    list.appendChild(row);
  }
}

function toggleBlocksPanel(force) {
  const panel = $('blocks-panel');
  const next = force === undefined ? panel.hidden : force;
  panel.hidden = !next;
  $('blocks-button').classList.toggle('on', next);
  renderBlockList();
  requestAnimationFrame(() => activeSession()?.fit());
}

// --- ssh ----------------------------------------------------------------------

let filesPanel = null;

// Connecting opens a normal tab and runs ssh in it, rather than replacing the
// shell. The local shell is still there when the remote session ends, and the
// command carries the options that let the file panel share the connection.
async function connectTo(target) {
  const clean = (target || '').trim();
  if (!clean) return;

  const command = await window.basalt.ssh.command(clean);
  if (!command) return;

  const session = await newTab();
  session.customName = clean;
  session.pendingCommand = command;
  renderTabs();

  // The panel offers whatever has been connected to, so keep its list current.
  if (filesPanel) await filesPanel.loadHosts();
}

async function renderConnectMenu() {
  const menu = $('connect-menu');
  menu.innerHTML = '';

  const { configured, recent } = await window.basalt.ssh.hosts();

  const label = document.createElement('div');
  label.className = 'popover-label';
  label.textContent = 'Connect over SSH';
  menu.appendChild(label);

  const form = document.createElement('div');
  form.className = 'ssh-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'user@host';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const go = document.createElement('button');
  go.className = 'mini';
  go.textContent = 'Connect';
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    closeConnectMenu();
    connectTo(value);
  };
  go.addEventListener('mousedown', (event) => event.preventDefault());
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
    if (event.key === 'Escape') { event.preventDefault(); closeConnectMenu(); }
  });
  form.appendChild(input);
  form.appendChild(go);
  menu.appendChild(form);

  const section = (title, hosts, { removable = false } = {}) => {
    if (!hosts.length) return;
    const heading = document.createElement('div');
    heading.className = 'popover-label';
    heading.textContent = title;
    menu.appendChild(heading);

    for (const entry of hosts) {
      const name = typeof entry === 'string' ? entry : entry.host;
      const row = document.createElement('div');
      row.className = 'shell-row';

      const check = document.createElement('span');
      check.className = 'check';
      row.appendChild(check);

      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = name;
      row.appendChild(label);

      const detail = document.createElement('span');
      detail.className = 'path';
      detail.textContent = typeof entry === 'string' ? ''
        : [entry.user && `${entry.user}@`, entry.hostname, entry.port && `:${entry.port}`]
          .filter(Boolean).join('');
      row.appendChild(detail);

      if (removable) {
        const forget = document.createElement('button');
        forget.className = 'newtab';
        forget.textContent = '✕';
        forget.title = `Forget ${name}`;
        forget.addEventListener('mousedown', (event) => event.preventDefault());
        forget.addEventListener('click', async (event) => {
          event.stopPropagation();
          await window.basalt.ssh.forget(name);
          renderConnectMenu();
        });
        row.appendChild(forget);
      }

      row.addEventListener('click', () => { closeConnectMenu(); connectTo(name); });
      menu.appendChild(row);
    }
  };

  section('From ~/.ssh/config', configured);
  section('Recent', recent.filter((h) => !configured.some((c) => c.host === h)), { removable: true });

  if (!configured.length && !recent.length) {
    const note = document.createElement('div');
    note.className = 'shell-note';
    note.textContent = 'No hosts in ~/.ssh/config yet. Type a target above to connect to one directly.';
    menu.appendChild(note);
  }

  requestAnimationFrame(() => input.focus());
}

async function openConnectMenu() {
  await renderConnectMenu();
  $('connect-menu').hidden = false;
  $('connect-button').setAttribute('aria-expanded', 'true');
}

function closeConnectMenu() {
  $('connect-menu').hidden = true;
  $('connect-button').setAttribute('aria-expanded', 'false');
  activeSession()?.focus();
}

async function toggleFilesPanel(force) {
  const panel = $('files-panel');
  const next = force === undefined ? panel.hidden : force;
  panel.hidden = !next;
  $('files-button').classList.toggle('on', next);
  requestAnimationFrame(() => activeSession()?.fit());
  if (!next || !filesPanel) return;
  // Hosts can be added by connecting in a tab, so the list is re-read on every
  // opening rather than only once at startup.
  await filesPanel.loadHosts();
  filesPanel.render();
}

// --- find bar -----------------------------------------------------------------

function openFind() {
  $('findbar').hidden = false;
  const input = $('find-input');
  input.value = state.findTerm;
  input.focus();
  input.select();
}

function closeFind() {
  $('findbar').hidden = true;
  activeSession()?.focus();
}

function runFind(back = false) {
  const session = activeSession();
  if (!session || !state.findTerm) return;
  session.find(state.findTerm, { back });
}

// --- settings -----------------------------------------------------------------

let settingsUI = null;
let savePending = null;

function applySettingsToUI() {
  const settings = viewSettings();
  const theme = settings.theme;

  const root = document.documentElement;
  root.classList.toggle('light', theme.ui === 'light');
  root.style.setProperty('--bg', theme.background);
  root.style.setProperty('--fg', theme.foreground);
  root.style.setProperty('--accent', theme.brightBlue || theme.blue);
  root.style.setProperty('--danger', theme.red);
  root.style.setProperty('--muted', theme.brightBlack);
  root.style.setProperty('--opacity', String(settings.appearance.opacity));
  root.style.setProperty('--pad', `${settings.appearance.padding}px`);
  root.style.setProperty('--mono', settings.appearance.fontFamily);

  document.body.classList.toggle('no-scrollbar', !settings.appearance.scrollbar);
  document.body.classList.toggle('translucent', settings.appearance.opacity < 1 || settings.appearance.vibrancy);
  updateAppearanceButton();

  window.basalt.window.appearance({
    opacity: settings.appearance.opacity,
    vibrancy: settings.appearance.vibrancy,
    background: theme.background,
  });

  for (const session of state.sessions) session.applySettings(settings);
}

const MODE_ICON = { auto: '◐', light: '☀', dark: '☾' };
const MODE_ORDER = ['auto', 'light', 'dark'];

function updateAppearanceButton() {
  const button = $('appearance-button');
  if (!button) return;
  const mode = state.raw.appearance.mode;
  button.textContent = MODE_ICON[mode] || MODE_ICON.auto;
  button.title = `Appearance: ${mode}${mode === 'auto' ? ` (now ${state.systemTheme})` : ''} — click to change`;
}

function cycleAppearance() {
  const next = MODE_ORDER[(MODE_ORDER.indexOf(state.raw.appearance.mode) + 1) % MODE_ORDER.length];
  changeSetting('appearance.mode', next);
}

function changeSetting(path, value, { silent = false } = {}) {
  setPath(state.raw, path, value);
  applySettingsToUI();
  if (!silent) settingsUI?.render();

  // Range sliders fire continuously; write to disk once they settle.
  clearTimeout(savePending);
  savePending = setTimeout(() => { window.basalt.settings.patch(state.raw); }, 220);
}

function openSettings() {
  $('overlay').hidden = false;
  $('settings-sheet').hidden = false;
  settingsUI.render();
}

function closeSheets() {
  $('overlay').hidden = true;
  $('settings-sheet').hidden = true;
  $('help-sheet').hidden = true;
  activeSession()?.focus();
}

// --- help ---------------------------------------------------------------------

// An entry beginning with "@" names a binding in the accelerator table the main
// process built the menu from, so the two can never disagree. Everything else
// is a literal, and "{…}" is substituted below.
const SHORTCUTS = [
  ['Prediction', null],
  ['⇥', 'Show the completion menu (or complete straight away when there is one match)'],
  ['↑ ↓', 'Move through the completion menu'],
  ['⏎', 'Accept the highlighted completion'],
  ['{accept}', 'Accept the greyed-out suggestion at the end of the line'],
  ['{alt}→', 'Accept just the next word of the suggestion'],
  ['⎋', 'Dismiss the menu or the suggestion'],

  ['Output folding', null],
  ['@cycleFold', 'Cycle the last output: shortened → hidden → full'],
  ['@foldOne', 'Fold the last output'],
  ['@foldAll', 'Fold every output'],
  ['@expandAll', 'Expand every output'],
  ['Click', 'Click a “… more lines” line to expand that output'],
  ['@blocks', 'Open the command list'],

  ['Selecting and editing', null],
  ['Type over selection', 'Select part of the command line and type to replace it'],
  ['⌫', 'Delete the selected part of the command line'],
  ['{click}-click', 'Move the cursor to where you clicked'],
  ['@selectInput', 'Select the whole command line'],
  ['{alt}← {alt}→', 'Move one word'],
  ['{alt}⌫', 'Delete the previous word'],
  ['Double / triple click', 'Select a word / a whole line'],

  ['Tabs and shells', null],
  ['@newTab', 'New tab'],
  ['@closeTab', 'Close tab'],
  ['{tabs}', 'Go to a tab'],
  ['@nextTab', 'Next tab'],
  ['@chooseShell', 'Switch this tab to another shell'],
  ['@restart', 'Restart this session'],
  ['Double-click a tab', 'Rename it'],

  ['Remote', null],
  ['@connect', 'Connect to a host over SSH'],
  ['@files', 'Browse and transfer files on a connected host'],

  ['Everything else', null],
  ['@find', 'Find'],
  ['@clear', 'Clear the scrollback'],
  ['{textSize}', 'Text size'],
  ['@settings', 'Settings'],
];

// macOS writes modifiers as symbols with nothing between them; everywhere else
// spells them out and joins with "+", the way the menus themselves render.
const MAC_SYMBOLS = {
  Cmd: '⌘', CmdOrCtrl: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
  Plus: '+', Backspace: '⌫', Tab: '⇥', PageUp: '⇞', PageDown: '⇟',
};
const OTHER_NAMES = { Plus: '+', Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn' };

function prettyAccelerator(spec) {
  if (!spec) return '';
  const parts = String(spec).split('+');
  return state.info?.platform === 'darwin'
    ? parts.map((part) => MAC_SYMBOLS[part] || part).join('')
    : parts.map((part) => OTHER_NAMES[part] || part).join('+');
}

function renderHelp() {
  const body = $('help-body');
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'help-grid';

  const mac = state.info?.platform === 'darwin';
  const keys = state.info?.accelerators || {};
  const alt = mac ? '⌥' : 'Alt+';
  const literals = {
    '{accept}': state.raw.prediction.acceptKey === 'tab' ? '⇥' : '→',
    '{alt}': alt,
    '{click}': mac ? '⌘' : 'Ctrl',
    '{tabs}': `${prettyAccelerator(keys.firstTab)}…${prettyAccelerator(keys.lastTab)}`,
    '{textSize}': [keys.bigger, keys.smaller, keys.actualSize].map(prettyAccelerator).join(' / '),
  };

  const resolve = (raw) => {
    if (raw.startsWith('@')) return prettyAccelerator(keys[raw.slice(1)]);
    return raw.replace(/\{\w+\}/g, (token) => literals[token] ?? token);
  };

  for (const [rawKey, description] of SHORTCUTS) {
    const key = resolve(rawKey);
    if (description === null) {
      const heading = document.createElement('div');
      heading.className = 'help-section';
      heading.textContent = key;
      grid.appendChild(heading);
      continue;
    }
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    const text = document.createElement('span');
    text.textContent = description;
    grid.appendChild(kbd);
    grid.appendChild(text);
  }

  body.appendChild(grid);
}

function openHelp() {
  renderHelp();
  $('overlay').hidden = false;
  $('help-sheet').hidden = false;
}

// --- menu actions -------------------------------------------------------------

async function handleMenu({ action, payload }) {
  const session = activeSession();

  switch (action) {
    case 'new-tab': await newTab(); break;
    case 'new-tab-with-shell': await newTab({ shell: payload.shell }); break;
    case 'duplicate-tab': await newTab({ shell: session?.shell, cwd: session?.cwd }); break;
    case 'close-tab': await closeTab(state.active); break;
    case 'select-tab': selectTab(payload.index); break;
    case 'next-tab': selectTab((state.active + 1) % state.sessions.length); break;
    case 'previous-tab': selectTab((state.active - 1 + state.sessions.length) % state.sessions.length); break;

    case 'choose-shell': openShellMenu(); break;
    case 'ssh-connect': openConnectMenu(); break;
    case 'toggle-files-panel': toggleFilesPanel(); break;

    case 'copy': session?.copy(); break;
    case 'paste': await session?.paste(); break;
    case 'paste-escaped': await session?.paste(true); break;
    case 'select-all': session?.term.selectAll(); break;
    case 'select-input': session?.selectInput(); break;
    case 'delete-selection':
      if (session && !session.replaceSelection()) session.write('\x15');
      break;
    case 'send-key': session?.write(payload.data); break;

    case 'find': openFind(); break;
    case 'find-next': runFind(false); break;
    case 'find-previous': runFind(true); break;

    case 'fold-last': await session?.foldLast('hidden'); renderBlockList(); break;
    case 'cycle-fold-last': await session?.cycleFoldLast(); renderBlockList(); break;
    case 'fold-all': await session?.setFoldAll('truncated'); renderBlockList(); break;
    case 'expand-all': await session?.setFoldAll('full'); renderBlockList(); break;
    case 'toggle-blocks-panel': toggleBlocksPanel(); break;

    case 'font-bigger': changeSetting('appearance.fontSize', Math.min(32, state.raw.appearance.fontSize + 1)); break;
    case 'font-smaller': changeSetting('appearance.fontSize', Math.max(8, state.raw.appearance.fontSize - 1)); break;
    case 'font-reset': changeSetting('appearance.fontSize', 13); break;

    case 'clear-scrollback': session?.clearScrollback(); renderBlockList(); break;
    case 'open-settings': openSettings(); break;
    case 'show-help': openHelp(); break;
    default: break;
  }
}

// Restarting is "switch to the shell I already have", which switchShell would
// otherwise skip as a no-op. This used to blank session.shell to defeat that
// check, which left the tab with no shell recorded at all if the user then
// cancelled the confirmation.
async function restartSession() {
  const session = activeSession();
  if (!session) return;
  await switchShell(session.shell, { force: true });
}

// --- boot ---------------------------------------------------------------------

async function boot() {
  const [{ settings, themes }, shellList, info] = await Promise.all([
    window.basalt.settings.get(),
    window.basalt.shells.list(),
    window.basalt.app.info(),
  ]);

  state.raw = settings;
  state.themes = themes;
  state.shells = shellList;
  state.info = info;
  state.systemTheme = info.systemTheme || 'dark';

  // Drives the bits of chrome that only apply where the window has no frame of
  // its own.
  document.body.classList.toggle('mac', info.platform === 'darwin');

  applySettingsToUI();

  settingsUI = buildSettingsUI({
    tabsEl: $('settings-tabs'),
    bodyEl: $('settings-body'),
    pathEl: $('settings-path'),
    getSettings: viewSettings,
    onChange: changeSetting,
    onReset: async () => {
      state.raw = await window.basalt.settings.reset();
      applySettingsToUI();
      settingsUI.render();
    },
  });

  // --- static wiring
  $('new-tab').addEventListener('click', () => newTab());
  $('appearance-button').addEventListener('click', cycleAppearance);
  $('settings-button').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSheets);
  $('settings-reset').addEventListener('click', () => settingsUI.reset());
  $('help-close').addEventListener('click', closeSheets);
  $('overlay').addEventListener('click', closeSheets);

  filesPanel = createFilesPanel({
    els: {
      host: $('files-host'), path: $('files-path'), status: $('files-status'),
      list: $('file-list'), refresh: $('files-refresh'),
      upload: $('files-upload'), mkdir: $('files-mkdir'),
    },
  });
  await filesPanel.loadHosts();
  filesPanel.render();

  $('files-button').addEventListener('click', () => toggleFilesPanel());
  $('files-close').addEventListener('click', () => toggleFilesPanel(false));
  $('connect-button').addEventListener('click', (event) => {
    event.stopPropagation();
    $('connect-menu').hidden ? openConnectMenu() : closeConnectMenu();
  });

  $('blocks-button').addEventListener('click', () => toggleBlocksPanel());
  $('blocks-close').addEventListener('click', () => toggleBlocksPanel(false));
  $('fold-all').addEventListener('click', async () => { await activeSession()?.setFoldAll('truncated'); renderBlockList(); });
  $('expand-all').addEventListener('click', async () => { await activeSession()?.setFoldAll('full'); renderBlockList(); });

  $('shell-button').addEventListener('click', (event) => {
    event.stopPropagation();
    $('shell-menu').hidden ? openShellMenu() : closeShellMenu();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.shell-picker')) closeShellMenu();
    if (!event.target.closest('.ssh-picker')) closeConnectMenu();
  });

  const findInput = $('find-input');
  findInput.addEventListener('input', () => {
    state.findTerm = findInput.value;
    if (state.findTerm) runFind(false);
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runFind(event.shiftKey); }
    if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
  });
  $('find-next').addEventListener('click', () => runFind(false));
  $('find-prev').addEventListener('click', () => runFind(true));
  $('find-close').addEventListener('click', closeFind);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('settings-sheet').hidden) { closeSheets(); return; }
    if (event.key === 'Escape' && !$('help-sheet').hidden) { closeSheets(); return; }
    if (event.key === 'Escape' && !$('findbar').hidden) { closeFind(); }
  });

  // Tab belongs to the shell. The settings sheet and the find bar are ordinary
  // forms and keep it, but everywhere else the browser's focus traversal would
  // walk the toolbar instead of completing a command. Capture it before the
  // default runs; xterm still sees the key, since this does not stop
  // propagation.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    if (document.activeElement?.closest('.sheet, .findbar')) return;
    event.preventDefault();
    // Focus may already have escaped to a button on an earlier click; bring it
    // back so the next keystroke reaches the terminal.
    const session = activeSession();
    if (session && !session.root.contains(document.activeElement)) session.focus();
  }, true);

  // The chrome is reachable by mouse and by the menu bar's shortcuts, so it
  // never needs to be a tab stop — a terminal that tab-cycles its own buttons
  // is a terminal that cannot complete a filename. Swallowing mousedown keeps
  // the focus on the terminal when one is clicked, too, while still firing the
  // click; the sheets are left alone, being ordinary forms.
  for (const button of document.querySelectorAll('.titlebar button, .statusbar button, .panel button')) {
    button.tabIndex = -1;
    button.addEventListener('mousedown', (event) => event.preventDefault());
  }

  window.addEventListener('resize', () => activeSession()?.fit());

  // --- main-process events
  window.basalt.pty.onData(({ id, data }) => {
    const session = state.byPty.get(id);
    if (session) session.receive(data);
  });

  window.basalt.pty.onExit(({ id, exitCode }) => {
    const session = state.byPty.get(id);
    if (!session) return;
    state.byPty.delete(id);
    session.markExited(exitCode);
    // A shell that exited on its own (⌃D, `exit`) should close its tab.
    const index = state.sessions.indexOf(session);
    if (index !== -1) {
      session.dispose();
      state.sessions.splice(index, 1);
      if (!state.sessions.length) { window.close(); return; }
      state.active = Math.min(state.active > index ? state.active - 1 : state.active, state.sessions.length - 1);
      applyVisibility();
      renderTabs();
    }
  });

  window.basalt.app.onMenu((payload) => {
    if (payload.action === 'restart-session') { restartSession(); return; }
    handleMenu(payload);
  });

  window.basalt.app.onSystemTheme((theme) => {
    state.systemTheme = theme;
    if (state.raw.appearance.mode === 'auto') {
      applySettingsToUI();
      if (!$('settings-sheet').hidden) settingsUI.render();
    }
  });

  window.basalt.settings.onChange((next) => {
    state.raw = next;
    applySettingsToUI();
    if (!$('settings-sheet').hidden) settingsUI.render();
  });

  // Keep the "busy" dot on tabs honest.
  setInterval(async () => {
    let changed = false;
    for (const session of state.sessions) {
      if (!session.ptyId) continue;
      const status = await window.basalt.pty.status(session.ptyId);
      if (Boolean(session.running) !== status.running) { session.running = status.running; changed = true; }
    }
    if (changed) renderTabs();
  }, 1500);

  await newTab();
  renderTabs();

  // A handle for automated tests and for poking at a misbehaving window from
  // the developer tools. The renderer only ever loads local files, so there is
  // nothing here that untrusted content could reach.
  window.basaltInternals = { state, newTab, closeTab, selectTab, handleMenu, switchShell,
    viewSettings, changeSetting, connectTo, filesPanel, toggleFilesPanel };
}

boot().catch((error) => {
  document.body.innerHTML = `<pre style="padding:20px;font-family:monospace;color:#e35d6a">Basalt failed to start:\n${error.stack || error.message}</pre>`;
});
