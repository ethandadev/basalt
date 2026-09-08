'use strict';

// SSH support: reading the user's own ~/.ssh/config so hosts can be offered by
// name, and a small set of remote file operations for the transfer panel.
//
// Nothing here implements the SSH protocol. It drives the ssh and scp binaries
// that are already on the machine, which means the user's keys, agent,
// jump hosts and per-host config all keep working exactly as they do in a
// terminal — and Basalt never handles a credential itself.
//
// Every operation shares one multiplexed connection per host (ControlMaster).
// The terminal's own "Connect" opens that master, so a host that needed a
// password or a hardware key once is then reachable by the file panel without
// asking again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SSH_DIR = path.join(os.homedir(), '.ssh');

// Windows ships OpenSSH, but its port has never implemented connection
// multiplexing: ControlMaster, ControlPath and ControlPersist are all rejected
// there. So on Windows every operation opens its own connection, which means
// the host has to work with a key or an agent rather than by leaning on a
// terminal tab's session.
const MULTIPLEXING = process.platform !== 'win32';

// --- ~/.ssh/config -----------------------------------------------------------

function expandPath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.join(SSH_DIR, value);
}

// Include accepts globs, and a trailing * is by far the common case
// (`Include config.d/*`). Anything fancier is left alone rather than guessed at.
function expandInclude(pattern) {
  const full = expandPath(pattern);
  if (!full.includes('*')) return fs.existsSync(full) ? [full] : [];
  const dir = path.dirname(full);
  const base = path.basename(full);
  if (base.indexOf('*') !== base.length - 1) return [];
  const prefix = base.slice(0, -1);
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && !name.startsWith('.'))
      .map((name) => path.join(dir, name))
      .filter((file) => { try { return fs.statSync(file).isFile(); } catch (_) { return false; } });
  } catch (_) {
    return [];
  }
}

function parseConfig(file, seen, out) {
  if (seen.has(file) || seen.size > 32) return;
  seen.add(file);

  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }

  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Keywords are case-insensitive and may be separated by whitespace or "=".
    const match = line.match(/^(\w+)\s*=?\s*(.*)$/);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();

    if (keyword === 'include') {
      for (const included of expandInclude(value)) parseConfig(included, seen, out);
      continue;
    }

    if (keyword === 'host') {
      current = null;
      for (const name of value.split(/\s+/)) {
        // A pattern is a rule for other hosts, not a host you can connect to.
        if (!name || name.includes('*') || name.includes('?') || name.startsWith('!')) continue;
        const entry = { host: name, hostname: '', user: '', port: '' };
        out.push(entry);
        if (!current) current = [];
        current.push(entry);
      }
      continue;
    }

    if (!current) continue;
    for (const entry of current) {
      if (keyword === 'hostname') entry.hostname = value;
      else if (keyword === 'user') entry.user = value;
      else if (keyword === 'port') entry.port = value;
    }
  }
}

// Hosts the user has already named in their config, in the order they appear.
function configHosts() {
  const out = [];
  parseConfig(path.join(SSH_DIR, 'config'), new Set(), out);

  const seen = new Set();
  return out.filter((entry) => {
    if (seen.has(entry.host)) return false;
    seen.add(entry.host);
    return true;
  });
}

// --- connection multiplexing -------------------------------------------------

// A Unix socket path is limited to about 104 characters, and the userData
// directory alone can eat most of that, so the socket is named by a digest
// rather than by the host.
function controlPath(target) {
  const digest = crypto.createHash('sha256').update(String(target)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `basalt-ssh-${digest}`);
}

function hasMaster(target) {
  try { return fs.statSync(controlPath(target)).isSocket(); } catch (_) { return false; }
}

// Options for the interactive session that opens the shared connection. This is
// the one place a password or hardware key may be requested, and it happens in a
// real terminal where the user can answer it.
function masterArgs(target) {
  if (!MULTIPLEXING) return [target];
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath(target)}`,
    '-o', 'ControlPersist=300',
    target,
  ];
}

// Options for the file operations. They never prompt: either the shared
// connection from a terminal session is up, or the host works with a key, or
// this fails immediately with a message worth showing.
function quietArgs(target) {
  const base = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (!MULTIPLEXING) return base;
  return [
    '-o', `ControlPath=${controlPath(target)}`,
    // auto, not no: reuse the terminal's connection when there is one, and
    // otherwise open a shared one of our own so the operations that follow are
    // quick. BatchMode keeps that from ever turning into a hidden prompt.
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=300',
    ...base,
  ];
}

// --- running things ----------------------------------------------------------

function run(file, args, { input = '', timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      done = true;
      resolve({ code: -1, stdout, stderr: stderr || `timed out after ${Math.round(timeout / 1000)}s` });
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Wrap a value so the remote shell sees it as one literal argument. Used for
// the commands that genuinely run through a shell on the far side.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// sftp parses its own command lines and never involves a shell, so paths are
// quoted for its tokeniser instead: double quotes, with backslash escapes.
function sftpQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Run a batch of sftp commands over the shared connection.
async function sftpBatch(target, commands, timeout = 10 * 60 * 1000) {
  const result = await run('sftp', [...quietArgs(target), '-q', '-b', '-', target],
    { input: `${commands.join('\n')}\n`, timeout });
  return result;
}

// ssh reports its own failures on stderr; surface the useful line rather than
// the whole banner.
function friendlyError(result) {
  const line = (result.stderr || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^Warning: Permanently added/.test(s))
    .pop();

  if (!line) return `failed with status ${result.code}`;
  if (/permission denied|publickey/i.test(line)) {
    return MULTIPLEXING
      ? 'Permission denied. Open a terminal tab to this host first — the file panel will then share that connection.'
      : 'Permission denied. Windows cannot share a terminal session\'s connection, so this host needs a key or a running ssh-agent.';
  }
  if (/control socket|no such file or directory.*basalt-ssh/i.test(line)) {
    return 'No shared connection. Open a terminal tab to this host first.';
  }
  return line;
}

// --- remote operations -------------------------------------------------------

// Listing by parsing `ls -l` breaks on any unusual filename, so ask the remote
// shell for exactly the fields wanted, tab separated. Everything here is POSIX,
// so it works against BSD and macOS servers as well as Linux.
const LIST_SCRIPT = `
cd -- "$1" 2>/dev/null || { echo "__BASALT_NODIR__"; exit 3; }
pwd
for f in .* *; do
  [ "$f" = "." ] && continue
  [ "$f" = ".." ] && continue
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -d "$f" ]; then
    printf 'd\\t0\\t%s\\n' "$f"
  else
    size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
    [ -n "$size" ] || size=0
    printf 'f\\t%s\\t%s\\n' "$size" "$f"
  fi
done
`;

async function list(target, dir = '') {
  const remote = `sh -s -- ${shellQuote(dir || '.')}`;
  const result = await run('ssh', [...quietArgs(target), target, remote], { input: LIST_SCRIPT });

  if (result.code !== 0 || result.stdout.includes('__BASALT_NODIR__')) {
    if (result.stdout.includes('__BASALT_NODIR__')) {
      return { ok: false, error: `Cannot open ${dir || 'that folder'}` };
    }
    return { ok: false, error: friendlyError(result) };
  }

  const lines = result.stdout.split('\n');
  const cwd = (lines.shift() || '').trim();
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab + 1);
    if (tab === -1 || tab2 === -1) continue;
    const type = line.slice(0, tab);
    const size = Number(line.slice(tab + 1, tab2)) || 0;
    const name = line.slice(tab2 + 1);
    if (!name) continue;
    entries.push({ name, size, directory: type === 'd' });
  }

  entries.sort((a, b) => (Number(b.directory) - Number(a.directory))
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return { ok: true, cwd, entries };
}

// Transfers and file management go through sftp rather than scp. Modern scp
// speaks the SFTP protocol, which means the remote path is NOT handed to a
// shell — quoting it for one turns the quotes into part of the filename — while
// older scp did use a shell and needed exactly that. sftp behaves the same way
// on every version, so there is no guessing.
async function download(target, remotePath, localPath) {
  const result = await sftpBatch(target, [`get -p ${sftpQuote(remotePath)} ${sftpQuote(localPath)}`]);
  return result.code === 0 ? { ok: true } : { ok: false, error: friendlyError(result) };
}

async function upload(target, localPath, remotePath) {
  const result = await sftpBatch(target, [`put -p ${sftpQuote(localPath)} ${sftpQuote(remotePath)}`]);
  return result.code === 0 ? { ok: true } : { ok: false, error: friendlyError(result) };
}

async function mkdir(target, remotePath) {
  const result = await sftpBatch(target, [`mkdir ${sftpQuote(remotePath)}`], 30000);
  return result.code === 0 ? { ok: true } : { ok: false, error: friendlyError(result) };
}

// Deliberately not recursive for a directory: only an empty one goes, so a
// mis-click cannot take a tree with it.
async function remove(target, remotePath, directory) {
  const command = directory ? 'rmdir' : 'rm';
  const result = await sftpBatch(target, [`${command} ${sftpQuote(remotePath)}`], 30000);
  if (result.code === 0) return { ok: true };
  if (directory) return { ok: false, error: 'Could not delete that folder. It may not be empty.' };
  return { ok: false, error: friendlyError(result) };
}

async function status(target) {
  if (!MULTIPLEXING) return { connected: false, multiplexing: false };
  if (!hasMaster(target)) return { connected: false };
  const result = await run('ssh', [...quietArgs(target), '-O', 'check', target], { timeout: 5000 });
  return { connected: result.code === 0 };
}

function disconnect(target) {
  if (!MULTIPLEXING) return Promise.resolve({ ok: true });
  return run('ssh', [...quietArgs(target), '-O', 'exit', target], { timeout: 5000 })
    .then(() => ({ ok: true }));
}

module.exports = {
  configHosts, controlPath, masterArgs, hasMaster, MULTIPLEXING,
  LIST_SCRIPT,   // exported so the listing can be tested without a server
  list, download, upload, mkdir, remove, status, disconnect,
  shellQuote, sftpQuote,
};
