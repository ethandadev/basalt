'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell: electronShell, clipboard, dialog, Menu, nativeTheme } = require('electron');

const { Settings, THEMES, resolveTheme } = require('./settings');
const shells = require('./shells');
const history = require('./history');
const completions = require('./completions');
const { PtyManager } = require('./pty');
const menu = require('./menu');
const ssh = require('./ssh');

const IS_MAC = process.platform === 'darwin';

// macOS takes the icon from the bundle's Info.plist, but every other platform
// wants it handed to each window. Missing is not fatal — the window just gets
// the default — so this stays optional.
const WINDOW_ICON = (() => {
  if (IS_MAC) return null;
  const dir = path.join(__dirname, '..', '..', 'build');
  // Windows wants the multi-resolution .ico so the taskbar and title bar can
  // each pick the size they need; elsewhere a PNG is what gets used.
  const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png'];
  for (const name of names) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
})();

const settings = new Settings();
const ptys = new PtyManager();
const windows = new Set();

// A PTY belongs to the window that asked for it, so its output goes to exactly
// one renderer and everything it owns dies with it.
const ptyOwner = new Map();

app.setName('Basalt');

function createWindow() {
  const { appearance, window: windowPrefs } = settings.all();
  const theme = resolveTheme(appearance, nativeTheme.shouldUseDarkColors);
  // Vibrancy is a macOS effect; elsewhere only plain opacity is available, and
  // even that needs a running compositor.
  const vibrancy = IS_MAC && appearance.vibrancy;
  const translucent = appearance.opacity < 1 || vibrancy;

  const win = new BrowserWindow({
    width: windowPrefs.width,
    height: windowPrefs.height,
    minWidth: 420,
    minHeight: 260,
    title: 'Basalt',
    // macOS hides its title bar and Basalt draws the tab strip in the space the
    // traffic lights leave. Other platforms keep their own window frame and the
    // tab strip simply sits below it.
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 13, y: 15 } }
      : WINDOW_ICON ? { icon: WINDOW_ICON } : {}),
    backgroundColor: translucent ? '#00000000' : theme.background,
    transparent: translucent,
    vibrancy: vibrancy ? 'under-window' : undefined,
    visualEffectState: 'active',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      enableBlinkFeatures: 'FontAccess',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // Listing installed fonts is the one permission this app asks for, and it
  // only ever comes from our own page.
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'local-fonts');
  });
  win.webContents.session.setPermissionCheckHandler((contents, permission) => permission === 'local-fonts');

  // The renderer only ever loads local files. Nothing should be opening a new
  // window — least of all a URL that arrived as terminal output.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('close', () => {
    if (settings.all().window.rememberSize && !win.isFullScreen()) {
      const [width, height] = win.getSize();
      settings.patch({ window: { width, height } });
    }
  });

  win.on('closed', () => {
    windows.delete(win);
    for (const [id, owner] of ptyOwner) {
      if (owner === win.id) { ptys.kill(id); ptyOwner.delete(id); }
    }
  });

  windows.add(win);
  return win;
}

function windowFor(ptyId) {
  const id = ptyOwner.get(ptyId);
  return [...windows].find((win) => win.id === id) || null;
}

ptys.onData = (id, buffer) => {
  const win = windowFor(id);
  if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data: buffer });
};

ptys.onExit = (id, exitCode, signal) => {
  const win = windowFor(id);
  ptyOwner.delete(id);
  if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode, signal });
};

function rebuildMenu() {
  menu.build({
    shells: shells.list(settings.all().shell.extraShells),
    onNewWindow: () => createWindow(),
    onOpenSettingsFile: () => electronShell.openPath(settings.file),
    onOpenIntegrationDir: () => electronShell.openPath(shells.integrationRoot()),
  });
}

// --- IPC ---------------------------------------------------------------------

ipcMain.handle('pty:create', (event, options = {}) => {
  const info = ptys.create(options);
  // The window can go away between asking for a PTY and getting one. Without an
  // owner nothing would ever route its output or clean it up, so end it here
  // rather than leaking a live shell process.
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) { ptys.kill(info.id); throw new Error('window closed'); }
  ptyOwner.set(info.id, owner.id);
  return info;
});

ipcMain.on('pty:write', (event, { id, data }) => ptys.write(id, data));
ipcMain.on('pty:resize', (event, { id, cols, rows }) => ptys.resize(id, cols, rows));
ipcMain.on('pty:kill', (event, { id }) => { ptys.kill(id); ptyOwner.delete(id); });
ipcMain.on('pty:cwd', (event, { id, cwd }) => ptys.setCwd(id, cwd));

ipcMain.handle('pty:status', (event, { id }) => ({
  running: ptys.hasRunningProcess(id),
  process: ptys.foregroundProcess(id),
}));

ipcMain.handle('shells:list', () => shells.list(settings.all().shell.extraShells));

ipcMain.handle('complete', async (event, query) => {
  try { return await completions.complete(query); } catch (err) {
    console.error('[basalt] completion failed:', err.message);
    return { token: '', tokenStart: 0, candidates: [], commonPrefix: '' };
  }
});

ipcMain.handle('suggest', async (event, query) => {
  try { return await completions.suggest(query); } catch (_) { return ''; }
});

ipcMain.handle('history:load', (event, { shellBase }) => history.load(shellBase));

ipcMain.handle('settings:get', () => ({ settings: settings.all(), themes: THEMES }));
ipcMain.handle('settings:patch', (event, partial) => {
  const saved = settings.patch(partial);
  for (const win of windows) {
    if (!win.isDestroyed() && win.webContents !== event.sender) win.webContents.send('settings:changed', saved);
  }
  return saved;
});
ipcMain.handle('settings:reset', () => {
  const saved = settings.reset();
  rebuildMenu();
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', saved);
  }
  return saved;
});

// Appearance changes that only the native window can apply.
ipcMain.on('window:appearance', (event, { opacity, vibrancy, background }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  try {
    win.setVibrancy(vibrancy ? 'under-window' : null);
    if (!vibrancy && opacity >= 1 && background) win.setBackgroundColor(background);
  } catch (_) { /* unsupported combination; the CSS layer still applies */ }
});

// Opening a link the terminal printed. Only ever hand the system browser a web
// URL: the link detector matches other schemes too, and following those would
// let anything that reaches the screen launch a registered handler.
ipcMain.on('shell:openExternal', (event, url) => {
  try {
    const { protocol } = new URL(String(url));
    if (protocol === 'http:' || protocol === 'https:') electronShell.openExternal(String(url));
  } catch (_) { /* not a URL worth opening */ }
});

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (event, text) => clipboard.writeText(text));

ipcMain.handle('dialog:confirm', async (event, { title, message, detail, confirmLabel = 'OK' }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [confirmLabel, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title, message, detail,
  });
  return response === 0;
});

ipcMain.handle('dialog:pickDirectory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return canceled ? '' : filePaths[0];
});

ipcMain.handle('dialog:pickShell', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'showHiddenFiles'],
    defaultPath: '/bin',
    title: 'Choose a shell executable',
  });
  return canceled ? '' : filePaths[0];
});

// The terminal owns the context menu, but the menu itself has to be native.
ipcMain.handle('menu:context', async (event, { hasSelection, blockId }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return new Promise((resolve) => {
    let picked = '';
    const items = [
      { label: 'Copy', enabled: hasSelection, click: () => { picked = 'copy'; } },
      { label: 'Paste', click: () => { picked = 'paste'; } },
      { type: 'separator' },
      { label: 'Select All', click: () => { picked = 'select-all'; } },
    ];
    if (blockId) {
      items.push(
        { type: 'separator' },
        { label: 'Fold This Output', click: () => { picked = 'fold-block'; } },
        { label: 'Expand This Output', click: () => { picked = 'expand-block'; } },
        { label: 'Copy Command', click: () => { picked = 'copy-command'; } },
        { label: 'Copy Output', click: () => { picked = 'copy-output'; } },
        { label: 'Rerun Command', click: () => { picked = 'rerun'; } },
      );
    }
    Menu.buildFromTemplate(items).popup({ window: win, callback: () => resolve(picked) });
  });
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  accelerators: menu.accelerators(),
  home: os.homedir(),
  settingsFile: settings.file,
  integrationDir: shells.integrationRoot(),
  defaultShell: shells.loginShell(),
  systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
}));

// --- SSH and remote files ----------------------------------------------------

// Remember a target the user actually connected to, newest first.
function rememberHost(target) {
  const recent = settings.all().ssh.recent.filter((entry) => entry !== target);
  recent.unshift(target);
  settings.patch({ ssh: { recent: recent.slice(0, 12) } });
}

ipcMain.handle('ssh:hosts', () => ({
  configured: ssh.configHosts(),
  recent: settings.all().ssh.recent,
}));

// The command the terminal should run. Built here so the file panel and the
// shell agree on which socket the connection is multiplexed over.
ipcMain.handle('ssh:command', (event, { target }) => {
  const clean = String(target || '').trim();
  if (!clean) return '';
  rememberHost(clean);
  const args = ssh.masterArgs(clean).map(ssh.shellQuote).join(' ');
  return `ssh ${args}`;
});

ipcMain.handle('ssh:forget', (event, { target }) => {
  const recent = settings.all().ssh.recent.filter((entry) => entry !== target);
  return settings.patch({ ssh: { recent } }).ssh.recent;
});

ipcMain.handle('sftp:status', (event, { target }) => ssh.status(target));
ipcMain.handle('sftp:list', (event, { target, dir }) => ssh.list(target, dir));
ipcMain.handle('sftp:mkdir', (event, { target, path: remote }) => ssh.mkdir(target, remote));
ipcMain.handle('sftp:remove', (event, { target, path: remote, directory }) =>
  ssh.remove(target, remote, directory));
ipcMain.handle('sftp:disconnect', (event, { target }) => ssh.disconnect(target));

ipcMain.handle('sftp:download', async (event, { target, path: remote, name }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: `Download ${name}`,
    defaultPath: path.join(app.getPath('downloads'), name),
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  const result = await ssh.download(target, remote, filePath);
  return result.ok ? { ok: true, localPath: filePath } : result;
});

ipcMain.handle('sftp:upload', async (event, { target, dir }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Upload to this folder',
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return { ok: false, cancelled: true };

  const failures = [];
  for (const file of filePaths) {
    const remote = `${dir.replace(/\/$/, '')}/${path.basename(file)}`;
    const result = await ssh.upload(target, file, remote);
    if (!result.ok) failures.push(`${path.basename(file)}: ${result.error}`);
  }
  return failures.length
    ? { ok: false, error: failures.join('; ') }
    : { ok: true, count: filePaths.length };
});

// --- Lifecycle ---------------------------------------------------------------

app.whenReady().then(() => {
  shells.integrationRoot();
  rebuildMenu();
  createWindow();
});

nativeTheme.on('updated', () => {
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('system:theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => ptys.killAll());
