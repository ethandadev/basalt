// Checks the platform-dependent wiring for a platform we are not running on.
//
// The Linux build cannot be exercised from macOS, but the parts most likely to
// be wrong are decided at module load from process.platform: the accelerator
// table, the menu template Electron has to accept, the shell search paths and
// the default font. Overriding process.platform before requiring those modules
// gets all of that under test on either host.
//
//   npx electron test/platform.test.cjs
//
// Run by Electron rather than node because building a menu needs the real
// Menu API to validate the accelerators.

const path = require('path');
const { app, Menu } = require('electron');

let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log(`  ok  ${name}`); return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// Load a module as though we were running on `platform`.
function loadAs(platform, relative) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const resolved = require.resolve(relative);
  delete require.cache[resolved];
  try {
    return require(relative);
  } finally {
    Object.defineProperty(process, 'platform', original);
    delete require.cache[resolved];
  }
}

const SHELLS = [
  { path: '/bin/bash', name: 'bash', base: 'bash', integrated: true },
  { path: '/usr/bin/fish', name: 'fish', base: 'fish', integrated: false },
];

function buildMenuAs(platform) {
  // Menu.setApplicationMenu would replace the real one; capture the template by
  // letting build() run and intercepting what it hands to Electron.
  const menu = loadAs(platform, '../src/main/menu');
  const original = Menu.setApplicationMenu;
  let built = null;
  Menu.setApplicationMenu = (value) => { built = value; };
  try {
    menu.build({
      shells: SHELLS,
      onNewWindow: () => {},
      onOpenSettingsFile: () => {},
      onOpenIntegrationDir: () => {},
    });
  } finally {
    Menu.setApplicationMenu = original;
  }
  return { menu, built };
}

function labels(menu) {
  return menu.items.map((item) => item.label);
}

function findItem(menu, label) {
  for (const item of menu.items) {
    if (item.label === label) return item;
    if (item.submenu) {
      const nested = findItem(item.submenu, label);
      if (nested) return nested;
    }
  }
  return null;
}

app.whenReady().then(() => {
  console.log('\nLinux');

  // Electron validates accelerators as it builds, so this failing at all means
  // one of the Linux bindings is not a thing Electron accepts.
  let linux;
  try {
    linux = buildMenuAs('linux');
    check('the Linux menu builds', Boolean(linux.built));
  } catch (error) {
    check('the Linux menu builds', false, error.message);
    app.exit(1);
    return;
  }

  const top = labels(linux.built);
  check('has no macOS application menu', top[0] === 'Shell', `top level: ${top.join(', ')}`);
  check('ends with Help', top[top.length - 1] === 'Help', `top level: ${top.join(', ')}`);
  check('offers Quit, which the app menu would otherwise own',
    Boolean(findItem(linux.built, 'Quit')));
  check('offers Settings outside the app menu',
    Boolean(findItem(linux.built, 'Settings…')));

  // The whole point of the Linux binding scheme: Ctrl alone belongs to the
  // shell, so nothing in the menu may claim a bare Ctrl+letter.
  const accelerators = [];
  (function walk(menu) {
    for (const item of menu.items) {
      if (item.accelerator) accelerators.push({ label: item.label, key: item.accelerator });
      if (item.submenu) walk(item.submenu);
    }
  })(linux.built);

  const bareCtrl = accelerators.filter(({ key }) => /^Ctrl\+[A-Za-z]$/.test(key));
  check('never binds a bare Ctrl+letter, which the shell needs',
    bareCtrl.length === 0,
    bareCtrl.map((a) => `${a.label}=${a.key}`).join(', '));

  const keys = loadAs('linux', '../src/main/menu').accelerators();
  check('copy is Ctrl+Shift+C, not Ctrl+C', keys.copy === 'Ctrl+Shift+C', `copy=${keys.copy}`);
  check('paste is Ctrl+Shift+V', keys.paste === 'Ctrl+Shift+V', `paste=${keys.paste}`);
  check('tabs are on Alt+number', keys.firstTab === 'Alt+1', `firstTab=${keys.firstTab}`);

  // Every accelerator must be distinct, or the later one silently never fires.
  const seen = new Map();
  const clashes = [];
  for (const { label, key } of accelerators) {
    if (seen.has(key)) clashes.push(`${key}: ${seen.get(key)} vs ${label}`);
    else seen.set(key, label);
  }
  check('no two Linux shortcuts collide', clashes.length === 0, clashes.join('; '));

  const linuxSettings = loadAs('linux', '../src/main/settings');
  check('defaults to a font Linux actually ships',
    linuxSettings.DEFAULTS.appearance.fontFamily.startsWith('DejaVu Sans Mono'),
    linuxSettings.DEFAULTS.appearance.fontFamily);

  const linuxShells = loadAs('linux', '../src/main/shells');
  check('login shell lookup avoids macOS Directory Services',
    typeof linuxShells.loginShell() === 'string' && linuxShells.loginShell().length > 0);
  check('shell discovery runs without throwing', Array.isArray(linuxShells.list()));

  console.log('\nWindows');

  let win;
  try {
    win = buildMenuAs('win32');
    check('the Windows menu builds', Boolean(win.built));
  } catch (error) {
    check('the Windows menu builds', false, error.message);
    app.exit(1);
    return;
  }

  const winTop = labels(win.built);
  check('has no macOS application menu on Windows', winTop[0] === 'Shell', winTop.join(', '));
  check('offers Quit outside an application menu', Boolean(findItem(win.built, 'Quit')));

  // The About role exists on macOS and Linux only; asking for it on Windows
  // would put a dead entry in the Help menu.
  const winHelp = win.built.items.find((item) => item.role === 'help')
    || win.built.items[win.built.items.length - 1];
  check('does not offer an About role Windows has no panel for',
    !winHelp.submenu.items.some((item) => item.role === 'about'),
    winHelp.submenu.items.map((i) => i.label || i.role).join(', '));

  const winAccelerators = [];
  (function walk(menu) {
    for (const item of menu.items) {
      if (item.accelerator) winAccelerators.push({ label: item.label, key: item.accelerator });
      if (item.submenu) walk(item.submenu);
    }
  })(win.built);

  // Same rule as Linux: Ctrl+C has to reach the shell as an interrupt.
  const winBareCtrl = winAccelerators.filter(({ key }) => /^Ctrl\+[A-Za-z]$/.test(key));
  check('never binds a bare Ctrl+letter on Windows', winBareCtrl.length === 0,
    winBareCtrl.map((a) => `${a.label}=${a.key}`).join(', '));

  const winSeen = new Map();
  const winClashes = [];
  for (const { label, key } of winAccelerators) {
    if (winSeen.has(key)) winClashes.push(`${key}: ${winSeen.get(key)} vs ${label}`);
    else winSeen.set(key, label);
  }
  check('no two Windows shortcuts collide', winClashes.length === 0, winClashes.join('; '));

  const winSettings = loadAs('win32', '../src/main/settings');
  check('defaults to a font Windows actually ships',
    winSettings.DEFAULTS.appearance.fontFamily.startsWith('Cascadia Mono'),
    winSettings.DEFAULTS.appearance.fontFamily);

  const winShells = loadAs('win32', '../src/main/shells');
  check('shell discovery runs on Windows without throwing', Array.isArray(winShells.list()));
  check('falls back to a shell that always exists',
    typeof winShells.loginShell() === 'string' && /cmd\.exe|powershell\.exe|pwsh\.exe/i.test(winShells.loginShell()),
    winShells.loginShell());

  // PowerShell integration is dot-sourced after the user's profile, not instead
  // of it, and -NoExit is what keeps the session interactive afterwards.
  const psPlan = winShells.launchPlan('C:\\Program Files\\PowerShell\\7\\pwsh.exe', {});
  check('PowerShell is started with the integration dot-sourced',
    psPlan.args.includes('-NoExit') && psPlan.args.some((a) => /^\. '.*basalt\.ps1'$/.test(a)),
    psPlan.args.join(' '));
  check('PowerShell counts as an integrated shell', psPlan.integrated === true);

  const cmdPlan = winShells.launchPlan('C:\\Windows\\System32\\cmd.exe', {});
  check('cmd.exe is launched plainly and marked unintegrated',
    cmdPlan.args.length === 0 && cmdPlan.integrated === false,
    JSON.stringify(cmdPlan));

  check('a path with a quote is escaped the way PowerShell expects',
    winShells.powershellQuote("C:\\it's here\\basalt.ps1") === "'C:\\it''s here\\basalt.ps1'",
    winShells.powershellQuote("C:\\it's here\\basalt.ps1"));

  const winHistory = loadAs('win32', '../src/main/history');
  check('PowerShell history comes from PSReadLine',
    /PSReadLine[\\/]ConsoleHost_history\.txt$/.test(winHistory.historyFileFor('pwsh.exe')),
    winHistory.historyFileFor('pwsh.exe'));
  check('cmd.exe is known to keep no history', winHistory.historyFileFor('cmd.exe') === '');

  const winSsh = loadAs('win32', '../src/main/ssh');
  check('knows Windows OpenSSH cannot multiplex a connection',
    winSsh.MULTIPLEXING === false);
  check('so it asks ssh for no ControlMaster options there',
    !winSsh.masterArgs('host').join(' ').includes('ControlMaster'),
    winSsh.masterArgs('host').join(' '));

  const posixSsh = loadAs('linux', '../src/main/ssh');
  check('but still shares the connection where that works',
    posixSsh.MULTIPLEXING === true
      && posixSsh.masterArgs('host').join(' ').includes('ControlMaster=auto'));

  console.log('\nmacOS');
  const mac = buildMenuAs('darwin');
  const macTop = labels(mac.built);
  check('keeps the application menu first', macTop[0] === 'Basalt', `top level: ${macTop.join(', ')}`);
  const macKeys = loadAs('darwin', '../src/main/menu').accelerators();
  check('copy stays on Cmd+C', macKeys.copy === 'Cmd+C', `copy=${macKeys.copy}`);
  check('tabs stay on Cmd+number', macKeys.firstTab === 'Cmd+1', `firstTab=${macKeys.firstTab}`);

  const macSettings = loadAs('darwin', '../src/main/settings');
  check('defaults to SF Mono on macOS',
    macSettings.DEFAULTS.appearance.fontFamily.startsWith('SF Mono'),
    macSettings.DEFAULTS.appearance.fontFamily);

  console.log(failed ? `\n${failed} checks failed` : '\nall platform checks passed');
  app.exit(failed ? 1 : 0);
});
