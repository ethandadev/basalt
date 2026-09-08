// The two parts of SSH support that can be checked without a server: reading
// ~/.ssh/config, and the shell snippet that lists a remote directory. The
// snippet is the fragile half — it has to survive filenames that ordinary
// `ls` parsing mangles — so it is run here against a real directory locally.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (error) { console.error(`  FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-ssh-test-'));
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, so both have to
// point at the scratch directory for the config parsing to be tested there.
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
const ssh = (await import('../src/main/ssh.js')).default
  || (await import('../src/main/ssh.js'));

// --- ~/.ssh/config ------------------------------------------------------------

fs.mkdirSync(path.join(scratch, '.ssh', 'config.d'), { recursive: true });
fs.writeFileSync(path.join(scratch, '.ssh', 'config'), `
# a comment
Host web1 web1.short
  HostName 10.0.0.5
  User deploy
  Port 2222

Host *.internal
  User someone

Host *
  ServerAliveInterval 30

Include config.d/*
`, 'utf8');
fs.writeFileSync(path.join(scratch, '.ssh', 'config.d', 'extra'), `
Host db
  HostName db.example.com
  User postgres
`, 'utf8');

const hosts = ssh.configHosts();

check('reads hosts out of ~/.ssh/config', () => {
  assert.ok(hosts.some((h) => h.host === 'web1'), `got ${hosts.map((h) => h.host).join(', ')}`);
});

check('keeps every alias on one Host line', () => {
  assert.ok(hosts.some((h) => h.host === 'web1.short'));
});

check('carries HostName, User and Port across', () => {
  const web = hosts.find((h) => h.host === 'web1');
  assert.equal(web.hostname, '10.0.0.5');
  assert.equal(web.user, 'deploy');
  assert.equal(web.port, '2222');
});

check('skips patterns, which are rules rather than hosts', () => {
  assert.ok(!hosts.some((h) => h.host.includes('*')), `got ${hosts.map((h) => h.host).join(', ')}`);
});

check('follows Include', () => {
  const db = hosts.find((h) => h.host === 'db');
  assert.ok(db, `got ${hosts.map((h) => h.host).join(', ')}`);
  assert.equal(db.user, 'postgres');
});

// --- the control socket -------------------------------------------------------

check('control socket path stays inside the Unix socket length limit', () => {
  const long = ssh.controlPath('a-very-long-hostname.example.internal.some.company.net');
  assert.ok(long.length < 100, `${long.length} chars: ${long}`);
});

check('each host gets its own socket', () => {
  assert.notEqual(ssh.controlPath('a'), ssh.controlPath('b'));
  assert.equal(ssh.controlPath('a'), ssh.controlPath('a'));
});

// --- the remote listing snippet -----------------------------------------------

const remote = path.join(scratch, 'remote');
fs.mkdirSync(path.join(remote, 'a directory'), { recursive: true });
fs.mkdirSync(path.join(remote, '.hidden-dir'), { recursive: true });
fs.writeFileSync(path.join(remote, 'plain.txt'), 'hello');
fs.writeFileSync(path.join(remote, 'name with spaces.log'), '1234567890');
fs.writeFileSync(path.join(remote, "quote'name"), 'x');
fs.writeFileSync(path.join(remote, '-leading-dash'), 'xy');
fs.writeFileSync(path.join(remote, '.dotfile'), 'z');

// The listing snippet runs on the *remote* host, which is POSIX whatever the
// client is. Without a local POSIX shell there is nothing here to run it
// against, so those checks are skipped rather than faked.
const HAS_POSIX_SH = (() => {
  try { execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
})();

function runListing(dir) {
  const out = execFileSync('sh', ['-s', '--', dir], { input: ssh.LIST_SCRIPT, encoding: 'utf8' });
  const lines = out.split('\n');
  const cwd = lines.shift().trim();
  const entries = lines.filter(Boolean).map((line) => {
    const t = line.indexOf('\t');
    const t2 = line.indexOf('\t', t + 1);
    return { type: line.slice(0, t), size: Number(line.slice(t + 1, t2)), name: line.slice(t2 + 1) };
  });
  return { cwd, entries };
}

const listed = HAS_POSIX_SH ? runListing(remote) : { cwd: '', entries: [] };
const byName = Object.fromEntries(listed.entries.map((e) => [e.name, e]));
if (!HAS_POSIX_SH) {
  console.log('  --  no POSIX shell here, skipping the remote-listing checks');
}

if (HAS_POSIX_SH) check('reports the directory it actually landed in', () => {
  assert.equal(fs.realpathSync(listed.cwd), fs.realpathSync(remote));
});

if (HAS_POSIX_SH) check('lists a filename containing spaces as one entry', () => {
  assert.ok(byName['name with spaces.log'], `got: ${Object.keys(byName).join(' | ')}`);
  assert.equal(byName['name with spaces.log'].size, 10);
});

if (HAS_POSIX_SH) check('survives a filename containing a quote', () => {
  assert.ok(byName["quote'name"], `got: ${Object.keys(byName).join(' | ')}`);
});

if (HAS_POSIX_SH) check('does not treat a leading dash as an option', () => {
  assert.ok(byName['-leading-dash'], `got: ${Object.keys(byName).join(' | ')}`);
  assert.equal(byName['-leading-dash'].size, 2);
});

if (HAS_POSIX_SH) check('marks directories apart from files', () => {
  assert.equal(byName['a directory'].type, 'd');
  assert.equal(byName['plain.txt'].type, 'f');
});

if (HAS_POSIX_SH) check('includes dotfiles', () => {
  assert.ok(byName['.dotfile'] && byName['.hidden-dir']);
});

if (HAS_POSIX_SH) check('never emits . or ..', () => {
  assert.ok(!byName['.'] && !byName['..'], `got: ${Object.keys(byName).join(' | ')}`);
});

if (HAS_POSIX_SH) check('reports real sizes', () => {
  assert.equal(byName['plain.txt'].size, 5);
});

const emptyDir = path.join(scratch, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });
if (HAS_POSIX_SH) check('an empty directory lists as empty rather than inventing entries', () => {
  const result = runListing(emptyDir);
  assert.equal(result.entries.length, 0, `got: ${JSON.stringify(result.entries)}`);
});

if (HAS_POSIX_SH) check('a missing directory is reported, not silently empty', () => {
  let out = '';
  try {
    out = execFileSync('sh', ['-s', '--', path.join(scratch, 'nope')],
      { input: ssh.LIST_SCRIPT, encoding: 'utf8' });
  } catch (error) {
    out = error.stdout || '';
  }
  assert.ok(out.includes('__BASALT_NODIR__'), `got ${JSON.stringify(out)}`);
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
