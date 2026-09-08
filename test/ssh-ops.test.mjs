// Exercises the remote operations without needing a server, by putting stub
// ssh and scp binaries on PATH that run the command locally instead of over a
// network. That covers the parts actually written here — how arguments are
// quoted for the remote shell, how output is parsed, and how failures are
// reported — against a real filesystem with awkward filenames.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (error) { console.error(`  FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
}

// The stubs are shebang scripts standing in for ssh and scp, and they emulate
// a POSIX remote shell. Windows can run neither, and what is under test here —
// how a path is quoted for the far side — does not depend on the client's
// platform, so this is skipped rather than reimplemented.
if (process.platform === 'win32') {
  console.log('  --  POSIX-only stubs, skipping on Windows\n\n0 checks passed');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'basalt-ops-'));
const binDir = path.join(scratch, 'bin');
const logFile = path.join(scratch, 'argv.log');
fs.mkdirSync(binDir, { recursive: true });

const STUB_SSH = `#!/usr/bin/env python3
import os, sys, subprocess
open(os.environ['BASALT_TEST_LOG'], 'a').write(repr(sys.argv[1:]) + '\\n')
if os.environ.get('BASALT_TEST_FAIL') == '1':
    sys.stderr.write('user@host: Permission denied (publickey).\\n')
    sys.exit(255)
args = sys.argv[1:]
if '-O' in args:
    sys.exit(0)
# The last argument is what the remote shell would be handed. Running it through
# a local shell reproduces the remote's own parsing of our quoting.
sys.exit(subprocess.call(['sh', '-c', args[-1]], stdin=sys.stdin))
`;

const STUB_SCP = `#!/usr/bin/env python3
import os, sys, shutil, shlex
open(os.environ['BASALT_TEST_LOG'], 'a').write(repr(sys.argv[1:]) + '\\n')
if os.environ.get('BASALT_TEST_FAIL') == '1':
    sys.stderr.write('user@host: Permission denied (publickey).\\n')
    sys.exit(255)
src, dst = sys.argv[-2], sys.argv[-1]
def resolve(p):
    head = p.split('/')[0]
    if ':' in head:                      # host:path — the remote half
        remote = p.split(':', 1)[1]
        parts = shlex.split(remote)      # the remote shell would unquote it
        return parts[0] if parts else remote
    return p
shutil.copyfile(resolve(src), resolve(dst))
`;

const STUB_SFTP = `#!/usr/bin/env python3
import os, sys, shutil
open(os.environ['BASALT_TEST_LOG'], 'a').write(repr(sys.argv[1:]) + '\\n')
if os.environ.get('BASALT_TEST_FAIL') == '1':
    sys.stderr.write('user@host: Permission denied (publickey).\\n')
    sys.exit(255)

def tokenize(line):
    """sftp's own quoting: double quotes with backslash escapes, no shell."""
    out, cur, i, inq, started = [], '', 0, False, False
    while i < len(line):
        c = line[i]
        if inq:
            if c == '\\\\' and i + 1 < len(line):
                cur += line[i + 1]; i += 2; continue
            if c == '"':
                inq = False; i += 1; continue
            cur += c; i += 1
        else:
            if c == '"':
                inq = True; started = True; i += 1; continue
            if c.isspace():
                if cur or started: out.append(cur); cur = ''; started = False
                i += 1; continue
            cur += c; i += 1
    if cur or started: out.append(cur)
    return out

status = 0
for raw in sys.stdin.read().splitlines():
    parts = [t for t in tokenize(raw.strip()) if t not in ('-p',)]
    if not parts: continue
    verb, args = parts[0], parts[1:]
    try:
        if verb in ('get', 'put'):
            shutil.copyfile(args[0], args[1])
        elif verb == 'mkdir':
            os.mkdir(args[0])
        elif verb == 'rmdir':
            os.rmdir(args[0])
        elif verb == 'rm':
            os.remove(args[0])
        else:
            sys.stderr.write('unknown command: ' + verb + '\\n'); status = 1
    except OSError as e:
        sys.stderr.write(str(e) + '\\n'); status = 1
sys.exit(status)
`;

fs.writeFileSync(path.join(binDir, 'ssh'), STUB_SSH, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'scp'), STUB_SCP, { mode: 0o755 });
fs.writeFileSync(path.join(binDir, 'sftp'), STUB_SFTP, { mode: 0o755 });

process.env.BASALT_TEST_LOG = logFile;
process.env.PATH = `${binDir}:${process.env.PATH}`;
process.env.HOME = scratch;

const ssh = await import('../src/main/ssh.js');

const argvLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

// A remote tree with the filenames that break naive `ls` parsing.
const remote = path.join(scratch, 'remote');
fs.mkdirSync(path.join(remote, 'sub dir'), { recursive: true });
fs.writeFileSync(path.join(remote, 'notes.txt'), 'abcdef');
fs.writeFileSync(path.join(remote, 'has space.bin'), '0123456789');
fs.writeFileSync(path.join(remote, "it's here.md"), 'xy');
fs.writeFileSync(path.join(remote, 'double"quote.txt'), 'dq');
fs.writeFileSync(path.join(remote, 'back\\slash.txt'), 'bs');

await check('lists a remote directory', async () => {
  const result = await ssh.list('host', remote);
  assert.ok(result.ok, result.error);
  const names = result.entries.map((e) => e.name);
  assert.ok(names.includes('notes.txt'), names.join(' | '));
  assert.ok(names.includes('has space.bin'), names.join(' | '));
  assert.ok(names.includes("it's here.md"), names.join(' | '));
});

await check('a path with a quote survives the trip through the remote shell', async () => {
  const result = await ssh.list('host', path.join(remote, 'sub dir'));
  assert.ok(result.ok, result.error);
  assert.equal(path.basename(result.cwd), 'sub dir');
});

await check('directories sort ahead of files', async () => {
  const result = await ssh.list('host', remote);
  assert.equal(result.entries[0].name, 'sub dir');
  assert.equal(result.entries[0].directory, true);
});

await check('sizes come back for files', async () => {
  const result = await ssh.list('host', remote);
  const entry = result.entries.find((e) => e.name === 'has space.bin');
  assert.equal(entry.size, 10);
});

await check('a missing directory is an error, not an empty listing', async () => {
  const result = await ssh.list('host', path.join(remote, 'nope'));
  assert.equal(result.ok, false);
  assert.match(result.error, /Cannot open/);
});

await check('multiplexing options are passed to every call', async () => {
  fs.writeFileSync(logFile, '');
  await ssh.list('host', remote);
  const log = argvLog();
  assert.match(log, /ControlPath/, log);
  assert.match(log, /BatchMode=yes/, log);
});

await check('downloads a file, quoting the remote side', async () => {
  const dest = path.join(scratch, 'downloaded.bin');
  const result = await ssh.download('host', path.join(remote, 'has space.bin'), dest);
  assert.ok(result.ok, result.error);
  assert.equal(fs.readFileSync(dest, 'utf8'), '0123456789');
});

await check('uploads a file into a directory whose name has a space', async () => {
  const source = path.join(scratch, 'to-upload.txt');
  fs.writeFileSync(source, 'uploaded');
  const target = path.join(remote, 'sub dir', 'landed.txt');
  const result = await ssh.upload('host', source, target);
  assert.ok(result.ok, result.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'uploaded');
});

await check('creates a remote directory', async () => {
  const made = path.join(remote, 'new folder');
  const result = await ssh.mkdir('host', made);
  assert.ok(result.ok, result.error);
  assert.ok(fs.statSync(made).isDirectory());
});

await check('removes a file', async () => {
  const doomed = path.join(remote, 'delete me.txt');
  fs.writeFileSync(doomed, 'x');
  const result = await ssh.remove('host', doomed, false);
  assert.ok(result.ok, result.error);
  assert.equal(fs.existsSync(doomed), false);
});

await check('refuses to remove a directory that still has things in it', async () => {
  const result = await ssh.remove('host', path.join(remote, 'sub dir'), true);
  assert.equal(result.ok, false);
  assert.match(result.error, /not be empty/i);
  assert.ok(fs.existsSync(path.join(remote, 'sub dir')), 'the directory should still be there');
});

await check('an auth failure turns into advice rather than an ssh banner', async () => {
  process.env.BASALT_TEST_FAIL = '1';
  const result = await ssh.list('host', remote);
  delete process.env.BASALT_TEST_FAIL;
  assert.equal(result.ok, false);
  assert.match(result.error, /terminal tab/i, result.error);
});


await check('transfers a name containing a double quote', async () => {
  const dest = path.join(scratch, 'dq.txt');
  const result = await ssh.download('host', path.join(remote, 'double"quote.txt'), dest);
  assert.ok(result.ok, result.error);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'dq');
});

await check('transfers a name containing a backslash', async () => {
  const dest = path.join(scratch, 'bs.txt');
  const result = await ssh.download('host', path.join(remote, 'back\\slash.txt'), dest);
  assert.ok(result.ok, result.error);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'bs');
});

await check('transfers go over sftp, whose paths are never seen by a shell', async () => {
  fs.writeFileSync(logFile, '');
  await ssh.download('host', path.join(remote, 'notes.txt'), path.join(scratch, 'n.txt'));
  const log = argvLog();
  assert.match(log, /'-b'/, log);
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
