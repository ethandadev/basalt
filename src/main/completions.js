'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// On Windows what makes a file runnable is its extension being in PATHEXT,
// rather than an execute bit. The names offered drop that extension, because
// that is what people type.
const PATHEXT = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1')
  .split(';').map((ext) => ext.trim().toLowerCase()).filter(Boolean);

const EXEC_CACHE_TTL = 15000;
let execCache = { at: 0, names: [] };

// Sub-commands worth offering for tools people use constantly. Not exhaustive
// on purpose: this is a hint layer, and pressing Tab with no match still falls
// through to the shell's own completion.
const SUBCOMMANDS = {
  git: ['add', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit', 'diff', 'fetch', 'init',
    'log', 'merge', 'mv', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'rm',
    'show', 'stash', 'status', 'switch', 'tag'],
  npm: ['install', 'run', 'start', 'test', 'init', 'publish', 'uninstall', 'update', 'audit', 'ci', 'link', 'ls'],
  brew: ['install', 'uninstall', 'update', 'upgrade', 'search', 'info', 'list', 'doctor', 'cleanup', 'services'],
  docker: ['build', 'run', 'ps', 'images', 'exec', 'logs', 'pull', 'push', 'stop', 'rm', 'rmi', 'compose'],
  python3: [], pip3: ['install', 'uninstall', 'list', 'freeze', 'show'],
};

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

// A path typed at a shell prompt may be quoted or backslash-escaped; strip that
// to get the real name, and re-apply escaping when handing a value back.
function unescapeToken(token) {
  if (token.length >= 1 && (token[0] === '"' || token[0] === "'")) {
    const quote = token[0];
    let body = token.slice(1);
    if (body.endsWith(quote)) body = body.slice(0, -1);
    return { value: quote === "'" ? body : body.replace(/\\(.)/g, '$1'), quote };
  }
  return { value: token.replace(/\\(.)/g, '$1'), quote: '' };
}

function escapeForShell(value, quote) {
  // Neither PowerShell nor cmd uses backslash escapes — a backslash is a path
  // separator there — so anything awkward is quoted instead.
  if (IS_WIN) {
    if (quote === "'") return value.replace(/'/g, "''");
    if (quote === '"') return value.replace(/"/g, '`"');
    return /[\s'"`&|<>^]/.test(value) ? `'${value.replace(/'/g, "''")}'` : value;
  }
  if (quote === "'") return value.replace(/'/g, `'\\''`);
  if (quote === '"') return value.replace(/(["$`\\])/g, '\\$1');
  return value.replace(/([ \t"'`$&|;<>()*?![\]#~\\])/g, '\\$1');
}

async function listExecutables() {
  const now = Date.now();
  if (now - execCache.at < EXEC_CACHE_TTL) return execCache.names;

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = new Set();
  await Promise.all(dirs.map(async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (IS_WIN) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!PATHEXT.includes(ext)) continue;
        names.add(entry.name.slice(0, entry.name.length - ext.length));
        continue;
      }
      try {
        fs.accessSync(path.join(dir, entry.name), fs.constants.X_OK);
        names.add(entry.name);
      } catch (_) { /* not executable by us */ }
    }
  }));

  execCache = { at: now, names: [...names] };
  return execCache.names;
}

async function completePath(token, cwd, { directoriesOnly = false } = {}) {
  const { value, quote } = unescapeToken(token);
  const expanded = expandHome(value);

  // Split into "the directory we are listing" and "the prefix being typed".
  // Windows shells accept either separator, so both have to count — and the one
  // the user is already typing is the one to hand back.
  const slash = IS_WIN
    ? Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf('\\'))
    : expanded.lastIndexOf('/');
  const sep = !IS_WIN ? '/'
    : (expanded.lastIndexOf('/') > expanded.lastIndexOf('\\') ? '/' : '\\');
  const dirPart = slash === -1 ? '' : expanded.slice(0, slash + 1);
  const prefix = slash === -1 ? expanded : expanded.slice(slash + 1);
  const searchDir = path.resolve(cwd, dirPart || '.');

  let entries;
  try { entries = await fsp.readdir(searchDir, { withFileTypes: true }); } catch (_) { return []; }

  const wantHidden = prefix.startsWith('.');
  const lowerPrefix = prefix.toLowerCase();
  const out = [];

  for (const entry of entries) {
    if (!wantHidden && entry.name.startsWith('.')) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(lowerPrefix)) continue;

    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDir = (await fsp.stat(path.join(searchDir, entry.name))).isDirectory(); } catch (_) { isDir = false; }
    }
    if (directoriesOnly && !isDir) continue;

    // What the user keeps typing is the raw text; rebuild it with the original
    // ~ and directory prefix intact so accepting never rewrites what they wrote.
    const rawValue = (value.slice(0, value.length - prefix.length)) + entry.name + (isDir ? sep : '');
    out.push({
      value: escapeForShell(rawValue, quote),
      display: entry.name + (isDir ? sep : ''),
      type: isDir ? 'directory' : 'file',
      detail: '',
      exact: prefix && entry.name.startsWith(prefix) ? 1 : 0,
    });
  }

  out.sort((a, b) => (b.exact - a.exact) || a.display.localeCompare(b.display, undefined, { numeric: true }));
  return out;
}

async function completeCommand(token, cwd, shellCommands) {
  const { value, quote } = unescapeToken(token);
  if (value.includes('/') || (IS_WIN && value.includes('\\'))) return completePath(token, cwd);

  const names = new Set([...(shellCommands || []), ...(await listExecutables())]);
  const lower = value.toLowerCase();
  const out = [];
  for (const name of names) {
    if (value && !name.toLowerCase().startsWith(lower)) continue;
    out.push({
      value: escapeForShell(name, quote),
      display: name,
      type: 'command',
      detail: '',
      exact: value && name.startsWith(value) ? 1 : 0,
    });
  }
  out.sort((a, b) => (b.exact - a.exact) || a.display.length - b.display.length || a.display.localeCompare(b.display));
  return out;
}

// Longest string every candidate starts with — what a real shell inserts on the
// first Tab press when the choice is still ambiguous.
function commonPrefix(values) {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * @param {object} query
 * @param {string} query.line       full input line
 * @param {number} query.cursor     cursor offset within the line
 * @param {string} query.cwd        working directory of the shell
 * @param {string[]} query.shellCommands aliases/functions/builtins from the live shell
 * @param {string[]} query.history  recent commands, newest last
 */
async function complete(query) {
  const { line = '', cursor = line.length, cwd = os.homedir(), shellCommands = [], history = [] } = query;

  const before = line.slice(0, cursor);
  // Token boundaries: unescaped whitespace, or a pipe/redirect that starts a
  // fresh command.
  const tokenMatch = before.match(/(?:^|[^\\])((?:[^\s|;&><]|\\.)*)$/);
  const token = tokenMatch ? tokenMatch[1] : '';
  const tokenStart = cursor - token.length;

  const segment = before.slice(0, tokenStart);
  const isCommandPosition = /(^|[|;&]|&&|\|\|)\s*$/.test(segment);

  const words = before.trim().split(/\s+/).filter(Boolean);
  const command = words.length ? words[0] : '';

  let candidates;
  if (isCommandPosition) {
    candidates = await completeCommand(token, cwd, shellCommands);
  } else if (command === 'cd' || command === 'pushd' || command === 'rmdir') {
    candidates = await completePath(token, cwd, { directoriesOnly: true });
  } else {
    candidates = await completePath(token, cwd);
    // Offer sub-commands only for the word right after the command name.
    const subs = SUBCOMMANDS[command];
    if (subs && words.length <= (token ? 2 : 1)) {
      const matching = subs
        .filter((s) => s.startsWith(unescapeToken(token).value))
        .map((s) => ({ value: s, display: s, type: 'subcommand', detail: command, exact: 1 }));
      candidates = matching.concat(candidates);
    }
  }

  // Whole-line history matches, shown after the structural candidates.
  const historyMatches = [];
  if (before.trim()) {
    const seen = new Set();
    for (let i = history.length - 1; i >= 0 && historyMatches.length < 6; i--) {
      const entry = history[i];
      if (!entry.startsWith(before) || entry === before || seen.has(entry)) continue;
      seen.add(entry);
      historyMatches.push({ value: entry.slice(tokenStart), display: entry, type: 'history', detail: '', exact: 0 });
    }
  }

  const limited = candidates.slice(0, 200);
  return {
    token,
    tokenStart,
    candidates: limited.concat(historyMatches),
    commonPrefix: commonPrefix(limited.map((c) => c.value)),
    isCommandPosition,
  };
}

// The fish-style greyed-out suggestion: the single best continuation of what has
// been typed so far. History first (it is almost always what you meant), then an
// unambiguous filename.
async function suggest(query) {
  const { line = '', cwd = os.homedir(), history = [], source = 'history-and-files' } = query;
  if (!line.trim() || source === 'off') return '';

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.length > line.length && entry.startsWith(line)) return entry.slice(line.length);
  }

  if (source !== 'history-and-files') return '';

  // Only suggest a path when exactly one thing can match — a wrong guess that
  // keeps changing as you type is worse than no guess at all.
  const result = await complete({ ...query, cursor: line.length });
  const structural = result.candidates.filter((c) => c.type !== 'history');
  if (structural.length === 1) {
    const only = structural[0].value;
    if (only.length > result.token.length && only.startsWith(result.token)) return only.slice(result.token.length);
  }
  return '';
}

module.exports = { complete, suggest, listExecutables };
