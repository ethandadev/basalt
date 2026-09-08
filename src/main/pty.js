'use strict';

const os = require('os');
const path = require('path');
const pty = require('node-pty');
const shells = require('./shells');

let nextId = 1;

// Environment variables Basalt must not inherit into the shell: they belong to
// the Electron process, not to a terminal session.
const STRIP = [
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'NODE_ENV',
  'GDK_PIXBUF_MODULE_FILE', 'ORIGINAL_XDG_CURRENT_DESKTOP',
];

function baseEnv() {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Basalt';
  env.TERM_PROGRAM_VERSION = require('../../package.json').version;
  env.LANG = env.LANG || 'en_US.UTF-8';
  return env;
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.onData = () => {};
    this.onExit = () => {};
  }

  create({ shell, cwd, cols = 80, rows = 24, login = true, args = [] } = {}) {
    const shellPath = shell || shells.loginShell();
    const plan = shells.launchPlan(shellPath, { login, extraArgs: args });

    let startDir = cwd || os.homedir();
    try { if (!path.isAbsolute(startDir)) startDir = os.homedir(); } catch (_) { startDir = os.homedir(); }

    const proc = pty.spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd: startDir,
      env: { ...baseEnv(), ...plan.env },
      encoding: null, // deliver raw bytes; the renderer decodes UTF-8 itself
    });

    const id = nextId++;
    const session = {
      id,
      proc,
      shell: shellPath,
      shellBase: path.basename(shellPath),
      integrated: plan.integrated,
      cwd: startDir,
      exited: false,
    };
    this.sessions.set(id, session);

    proc.onData((data) => {
      // node-pty hands us a Buffer when encoding is null; ship it as-is so
      // multi-byte characters split across reads still reassemble correctly.
      this.onData(id, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    });

    proc.onExit(({ exitCode, signal }) => {
      session.exited = true;
      this.sessions.delete(id);
      this.onExit(id, exitCode, signal);
    });

    return {
      id,
      shell: shellPath,
      shellBase: session.shellBase,
      integrated: plan.integrated,
      cwd: startDir,
      pid: proc.pid,
    };
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (session && !session.exited) session.proc.write(data);
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    try { session.proc.resize(Math.max(2, cols), Math.max(1, rows)); } catch (_) { /* raced with exit */ }
  }

  setCwd(id, cwd) {
    const session = this.sessions.get(id);
    if (session) session.cwd = cwd;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  // Is anything running other than the shell itself? Used to warn before
  // closing a tab that is in the middle of something.
  hasRunningProcess(id) {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    try {
      const name = session.proc.process;
      return Boolean(name) && name !== session.shellBase && name !== session.shell;
    } catch (_) {
      return false;
    }
  }

  foregroundProcess(id) {
    const session = this.sessions.get(id);
    if (!session || session.exited) return '';
    try { return session.proc.process || ''; } catch (_) { return ''; }
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.exited = true;
    this.sessions.delete(id);
    try { session.proc.kill(); } catch (_) { /* already gone */ }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager };
