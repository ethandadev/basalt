'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_ENTRIES = 5000;

// zsh's EXTENDED_HISTORY format is `: <started>:<elapsed>;<command>`, and a
// command that contained newlines is stored with the newlines escaped by a
// trailing backslash. Plain bash history is one command per line.
function parseZsh(text) {
  const out = [];
  const lines = text.split('\n');
  let pending = null;

  for (const raw of lines) {
    let line = raw;
    if (pending !== null) {
      pending += '\n' + line.replace(/\\$/, '');
      if (!/\\$/.test(line)) { out.push(pending); pending = null; }
      continue;
    }
    const extended = line.match(/^:\s*\d+:\d+;(.*)$/);
    if (extended) line = extended[1];
    if (/\\$/.test(line)) pending = line.replace(/\\$/, '');
    else if (line.trim()) out.push(line);
  }
  if (pending !== null) out.push(pending);
  return out;
}

function readFileTail(file, maxBytes = 2 * 1024 * 1024) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    // A partial first line is possible when we seek into the middle of the file.
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function historyFileFor(shellBase) {
  const home = os.homedir();
  const base = String(shellBase || '').toLowerCase();

  // PowerShell keeps its history through PSReadLine, one command per line.
  if (base === 'pwsh' || base === 'pwsh.exe' || base === 'powershell.exe') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine',
      'ConsoleHost_history.txt');
  }
  // cmd.exe keeps no history of its own between sessions.
  if (base === 'cmd.exe') return '';

  if (base === 'bash' || base === 'bash.exe') {
    return process.env.HISTFILE || path.join(home, '.bash_history');
  }
  if (base === 'fish') return path.join(home, '.local/share/fish/fish_history');
  return process.env.HISTFILE || path.join(home, '.zsh_history');
}

const cache = new Map(); // file -> { mtimeMs, entries }

// Newest-last list of commands from the shell's own history file.
function load(shellBase = 'zsh') {
  const file = historyFileFor(shellBase);
  if (!file) return [];
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.entries;

    const text = readFileTail(file);
    const base = String(shellBase || '').toLowerCase();
    const plainLines = base === 'pwsh' || base === 'pwsh.exe' || base === 'powershell.exe';
    let entries = base === 'fish'
      ? text.split('\n').filter((l) => l.startsWith('- cmd: ')).map((l) => l.slice(7))
      : plainLines
        ? text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim())
        : parseZsh(text);

    // De-duplicate keeping the most recent occurrence of each command.
    const seen = new Set();
    const deduped = [];
    for (let i = entries.length - 1; i >= 0 && deduped.length < MAX_ENTRIES; i--) {
      const cmd = entries[i];
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      deduped.push(cmd);
    }
    entries = deduped.reverse();

    cache.set(file, { mtimeMs: stat.mtimeMs, entries });
    return entries;
  } catch (_) {
    return [];
  }
}

module.exports = { load, historyFileFor };
