'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const PRETTY = {
  zsh: 'zsh', bash: 'bash', sh: 'sh', fish: 'fish', ksh: 'ksh',
  tcsh: 'tcsh', csh: 'csh', dash: 'dash', nu: 'nushell', xonsh: 'xonsh',
  pwsh: 'PowerShell', 'pwsh.exe': 'PowerShell',
  'powershell.exe': 'Windows PowerShell', 'cmd.exe': 'Command Prompt',
  'bash.exe': 'Git Bash', 'wsl.exe': 'WSL', 'nu.exe': 'nushell',
};

// Shells Basalt can install its block/prompt marks into. Everything else still
// runs, just without folding and with history-only prediction. cmd.exe is not
// here on purpose: its PROMPT can emit an escape but it has no hook that fires
// when a command starts or finishes, so blocks could never be closed.
const INTEGRATED = new Set(['zsh', 'bash', 'bash.exe', 'pwsh', 'pwsh.exe', 'powershell.exe']);

// Windows has no notion of a login shell, so "the user's shell" is whichever
// PowerShell is installed, falling back to the one that always is.
function windowsDefaultShell() {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    windowsSystem('WindowsPowerShell\\v1.0\\powershell.exe'),
    windowsSystem('cmd.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
  return process.env.ComSpec || 'cmd.exe';
}

function windowsSystem(relative) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', relative);
}

// macOS keeps the login shell in Directory Services rather than /etc/passwd, so
// the two platforms have to ask different questions. $SHELL is the last resort
// on both: it reflects the shell that launched us, which is usually but not
// always the one the account is configured with.
function loginShell() {
  if (IS_WIN) return windowsDefaultShell();

  if (IS_MAC) {
    try {
      const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${os.userInfo().username}`, 'UserShell'], {
        encoding: 'utf8', timeout: 2000,
      });
      const match = out.match(/UserShell:\s*(\S+)/);
      if (match) return match[1];
    } catch (_) { /* fall through to the environment */ }
    return process.env.SHELL || '/bin/zsh';
  }

  // Linux: getpwuid, which Node exposes directly and which reads NSS — so this
  // works for LDAP and SSSD accounts that are not in /etc/passwd at all.
  try {
    const { shell } = os.userInfo();
    if (shell) return shell;
  } catch (_) { /* fall through */ }
  return process.env.SHELL || '/bin/bash';
}

function readEtcShells() {
  try {
    return fs.readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (_) {
    return [];
  }
}

function isExecutable(file) {
  try {
    // Windows has no execute bit — whether a file can be run is decided by its
    // extension, and every candidate here already carries one.
    if (!IS_WIN) fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

// A shell path on Windows is separated by backslashes whichever machine is
// reading it, so it needs the win32 rules rather than the host's. On Windows
// `path` already is `path.win32`; naming it explicitly is what lets this be
// tested from anywhere.
function shellBaseName(shellPath) {
  return IS_WIN ? path.win32.basename(shellPath) : path.basename(shellPath);
}

function describe(shellPath) {
  const base = shellBaseName(shellPath);
  return {
    path: shellPath,
    name: PRETTY[base] || base,
    base,
    integrated: INTEGRATED.has(base),
  };
}

// PowerShell is cross-platform, so a POSIX install counts as an integrated
// shell too and belongs in the pickers alongside the native ones.
const POSIX_POWERSHELL = ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh'];

// Where each platform actually keeps its shells. macOS ships them in /bin and
// gets the rest from Homebrew; Linux distributions split between /bin and
// /usr/bin (often symlinked together) and add Homebrew, Snap and Nix.
function windowsCandidates() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
    localAppData && path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    windowsSystem('WindowsPowerShell\\v1.0\\powershell.exe'),
    windowsSystem('cmd.exe'),
    windowsSystem('wsl.exe'),
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFiles86, 'Git', 'bin', 'bash.exe'),
    path.join(programFiles, 'nu', 'bin', 'nu.exe'),
  ].filter(Boolean);
}

const WELL_KNOWN = IS_WIN ? windowsCandidates() : IS_MAC
  ? [
    '/bin/zsh', '/bin/bash', '/bin/sh', '/bin/dash', '/bin/ksh', '/bin/tcsh', '/bin/csh',
    '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
    '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
    '/opt/homebrew/bin/nu', '/usr/local/bin/nu',
    ...POSIX_POWERSHELL,
  ]
  : [
    '/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash', '/bin/fish', '/bin/ksh', '/bin/tcsh', '/bin/csh',
    '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/sh', '/usr/bin/dash', '/usr/bin/fish',
    '/usr/bin/ksh', '/usr/bin/tcsh', '/usr/bin/csh', '/usr/bin/nu', '/usr/bin/xonsh',
    '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish', '/usr/local/bin/nu',
    '/home/linuxbrew/.linuxbrew/bin/bash', '/home/linuxbrew/.linuxbrew/bin/zsh',
    '/home/linuxbrew/.linuxbrew/bin/fish',
    '/snap/bin/fish', '/run/current-system/sw/bin/bash', '/run/current-system/sw/bin/zsh',
    ...POSIX_POWERSHELL,
  ];

// Everything the shell picker should offer: the user's login shell, /etc/shells,
// the well-known locations for this platform, and anything they added by hand.
function list(extraShells = []) {
  const candidates = [
    loginShell(),
    ...readEtcShells(),
    ...WELL_KNOWN,
    ...extraShells,
  ];

  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || !isExecutable(candidate)) continue;
    seen.add(candidate);

    // On Linux /bin is usually a symlink to /usr/bin, so the same shell would
    // otherwise be listed twice under two names. Resolve before deciding it is
    // something new, but keep showing the path the user would recognise.
    let real = candidate;
    try { real = fs.realpathSync(candidate); } catch (_) { /* keep the literal path */ }
    if (real !== candidate) {
      if (seen.has(real)) continue;
      seen.add(real);
    }

    out.push(describe(candidate));
  }
  return out;
}

// --- Shell integration -------------------------------------------------------
// The integration scripts ship inside the app bundle, where the shell cannot
// read them (an asar archive is not a real directory). Copy them out to a stable
// location on disk on every launch, so an app update refreshes them too.

let integrationDir = null;

// `baseDir` exists so the integration can be generated into a scratch directory
// by tests; in the app it always lands in userData.
function integrationRoot(baseDir) {
  if (integrationDir && !baseDir) return integrationDir;

  const dir = path.join(baseDir || app.getPath('userData'), 'shell-integration');
  fs.mkdirSync(dir, { recursive: true });

  const source = path.join(__dirname, '..', 'shell-integration');
  for (const file of ['basalt.zsh', 'basalt.bash', 'basalt.ps1']) {
    fs.writeFileSync(path.join(dir, file), fs.readFileSync(path.join(source, file), 'utf8'), 'utf8');
  }

  // zsh only accepts integration by way of ZDOTDIR, which redirects every one
  // of its startup files. Forward the ones we are not using ourselves so a
  // user's .zshenv / .zprofile / .zlogin still run.
  const forward = (name) => `# Generated by Basalt. Forwards to your real startup file.
BASALT_ORIG_ZDOTDIR="\${BASALT_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$BASALT_ORIG_ZDOTDIR/${name}" ]] && ZDOTDIR="$BASALT_ORIG_ZDOTDIR" source "$BASALT_ORIG_ZDOTDIR/${name}"
`;
  fs.writeFileSync(path.join(dir, '.zshenv'), forward('.zshenv'), 'utf8');
  fs.writeFileSync(path.join(dir, '.zprofile'), forward('.zprofile'), 'utf8');
  fs.writeFileSync(path.join(dir, '.zlogin'), forward('.zlogin'), 'utf8');
  fs.writeFileSync(path.join(dir, '.zshrc'), `# Generated by Basalt.
source "${path.join(dir, 'basalt.zsh')}"
`, 'utf8');

  // bash takes --rcfile directly, but that *replaces* the normal startup file,
  // so this wrapper has to load the user's own first.
  fs.writeFileSync(path.join(dir, 'basalt-bashrc'), `# Generated by Basalt.
if [ -f "$HOME/.bash_profile" ]; then
  . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then
  . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then
  . "$HOME/.profile"
fi
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
source "${path.join(dir, 'basalt.bash')}"
`, 'utf8');

  integrationDir = dir;
  return dir;
}

// A PowerShell single-quoted string takes everything literally; the only escape
// it needs is a doubled quote.
function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Turn a chosen shell into the exact argv/env a PTY should be spawned with.
function launchPlan(shellPath, { login = true, extraArgs = [] } = {}) {
  const base = shellBaseName(shellPath);
  const dir = integrationRoot();
  const env = {};
  let args = [];

  // PowerShell runs on all three platforms, so this is decided by which shell
  // it is rather than by which platform we are on.
  const lower = base.toLowerCase();
  if (lower === 'pwsh' || lower === 'pwsh.exe' || lower === 'powershell.exe') {
    // PowerShell loads $PROFILE on its own, so -Command runs after the user's
    // own configuration rather than instead of it. -NoExit keeps the session
    // interactive once the integration has been dot-sourced.
    args.push('-NoLogo', '-NoExit', '-Command', `. ${powershellQuote(path.join(dir, 'basalt.ps1'))}`);
    args = args.concat(extraArgs);
    return { file: shellPath, args, env, integrated: true };
  }

  if (IS_WIN) {
    if (lower === 'bash.exe') {
      // Git Bash, which is a real bash and takes the same wrapper as elsewhere.
      args.push('--rcfile', path.join(dir, 'basalt-bashrc'), '-i');
    }
    // cmd.exe and wsl.exe get no arguments: neither has a hook Basalt can use.
    args = args.concat(extraArgs);
    return { file: shellPath, args, env, integrated: INTEGRATED.has(lower) };
  }

  if (base === 'zsh') {
    env.BASALT_ORIG_ZDOTDIR = process.env.ZDOTDIR || os.homedir();
    env.BASALT_SAVED_ZDOTDIR = process.env.ZDOTDIR || '';
    env.ZDOTDIR = dir;
    if (login) args.push('-l');
    args.push('-i');
  } else if (base === 'bash') {
    args.push('--rcfile', path.join(dir, 'basalt-bashrc'));
    // --rcfile is ignored for a login shell, so run interactive-only and let the
    // wrapper source the profile files itself.
    args.push('-i');
  } else if (login) {
    args.push('-l');
  }

  args = args.concat(extraArgs);
  return { file: shellPath, args, env, integrated: INTEGRATED.has(base) };
}

module.exports = { list, loginShell, launchPlan, integrationRoot, describe, powershellQuote };
