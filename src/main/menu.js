'use strict';

const { Menu } = require('electron');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Every menu item does the same thing: name an action and let the focused
// window's renderer decide what it means for the active tab.
function send(action, payload) {
  return (menuItem, browserWindow) => {
    if (browserWindow) browserWindow.webContents.send('menu:action', { action, payload });
  };
}

// macOS gives an application ⌘ to itself — the shell only ever sees ⌃, so the
// two never collide. On Linux the shell owns Ctrl outright: Ctrl+C has to reach
// the foreground process as an interrupt, not copy a selection. So the window's
// own shortcuts live on Ctrl+Shift and Ctrl+Alt there, which is what every
// Linux terminal does.
const KEYS = IS_MAC ? {
  settings: 'Cmd+,', quit: undefined,
  newTab: 'Cmd+T', newWindow: 'Cmd+N', chooseShell: 'Cmd+Shift+S', restart: 'Cmd+R',
  duplicate: 'Cmd+Shift+D', closeTab: 'Cmd+W',
  undo: 'Cmd+Z', copy: 'Cmd+C', paste: 'Cmd+V', pasteEscaped: 'Cmd+Shift+V',
  selectAll: 'Cmd+A', selectInput: 'Cmd+Shift+A', deleteSelection: 'Cmd+Backspace',
  find: 'Cmd+F', findNext: 'Cmd+G', findPrev: 'Cmd+Shift+G',
  foldOne: 'Cmd+Shift+E', cycleFold: 'Cmd+E', foldAll: 'Cmd+Alt+E', expandAll: 'Cmd+Alt+Shift+E',
  blocks: 'Cmd+Shift+O', connect: 'Cmd+Shift+K', files: 'Cmd+Shift+B',
  bigger: 'Cmd+Plus', smaller: 'Cmd+-', actualSize: 'Cmd+0',
  clear: 'Cmd+K', devTools: 'Cmd+Alt+I', help: 'Cmd+/',
  nextTab: 'Ctrl+Tab', prevTab: 'Ctrl+Shift+Tab',
  tab: (i) => `Cmd+${i}`, shellTab: (i) => `Cmd+Ctrl+${i}`,
} : {
  settings: 'Ctrl+,', quit: 'Ctrl+Shift+Q',
  newTab: 'Ctrl+Shift+T', newWindow: 'Ctrl+Shift+N', chooseShell: 'Ctrl+Alt+S', restart: 'Ctrl+Shift+R',
  duplicate: 'Ctrl+Alt+D', closeTab: 'Ctrl+Shift+W',
  undo: 'Ctrl+Shift+Z', copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', pasteEscaped: 'Ctrl+Alt+V',
  selectAll: 'Ctrl+Shift+A', selectInput: 'Ctrl+Alt+A', deleteSelection: 'Ctrl+Shift+Backspace',
  find: 'Ctrl+Shift+F', findNext: 'Ctrl+Shift+G', findPrev: 'Ctrl+Alt+G',
  foldOne: 'Ctrl+Alt+E', cycleFold: 'Ctrl+Shift+E', foldAll: 'Ctrl+Alt+Shift+E', expandAll: 'Ctrl+Alt+Shift+U',
  blocks: 'Ctrl+Shift+O', connect: 'Ctrl+Alt+K', files: 'Ctrl+Shift+B',
  bigger: 'Ctrl+Plus', smaller: 'Ctrl+-', actualSize: 'Ctrl+0',
  clear: 'Ctrl+Shift+K', devTools: 'Ctrl+Shift+I', help: 'F1',
  nextTab: 'Ctrl+PageDown', prevTab: 'Ctrl+PageUp',
  tab: (i) => `Alt+${i}`, shellTab: (i) => `Ctrl+Alt+${i}`,
};

function build({ shells, onNewWindow, onOpenSettingsFile, onOpenIntegrationDir }) {
  const shellItems = shells.map((entry, index) => ({
    label: entry.integrated ? entry.name : `${entry.name}  (no block support)`,
    sublabel: IS_MAC ? entry.path : undefined,
    accelerator: index < 9 ? KEYS.shellTab(index + 1) : undefined,
    click: send('new-tab-with-shell', { shell: entry.path }),
  }));

  const settingsItems = [
    { label: 'Settings…', accelerator: KEYS.settings, click: send('open-settings') },
    { label: 'Open settings.json', click: () => onOpenSettingsFile() },
    { label: 'Open Shell Integration Folder', click: () => onOpenIntegrationDir() },
  ];

  const template = [];

  // The application menu is a macOS construct. Elsewhere its contents belong to
  // the first menu and to Help.
  if (IS_MAC) {
    template.push({
      label: 'Basalt',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...settingsItems,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Shell',
    submenu: [
      { label: 'New Tab', accelerator: KEYS.newTab, click: send('new-tab') },
      { label: 'New Window', accelerator: KEYS.newWindow, click: () => onNewWindow() },
      { label: 'New Tab With Shell', submenu: shellItems.length ? shellItems : [{ label: 'No shells found', enabled: false }] },
      { type: 'separator' },
      { label: 'Connect over SSH…', accelerator: KEYS.connect, click: send('ssh-connect') },
      { label: 'Change Shell in This Tab…', accelerator: KEYS.chooseShell, click: send('choose-shell') },
      { label: 'Restart Session', accelerator: KEYS.restart, click: send('restart-session') },
      { type: 'separator' },
      { label: 'Duplicate Tab', accelerator: KEYS.duplicate, click: send('duplicate-tab') },
      { label: 'Close Tab', accelerator: KEYS.closeTab, click: send('close-tab') },
      { type: 'separator' },
      { label: 'Send Interrupt (Ctrl-C)', click: send('send-key', { data: '\x03' }) },
      { label: 'Send End of File (Ctrl-D)', click: send('send-key', { data: '\x04' }) },
      ...(IS_MAC ? [] : [
        { type: 'separator' },
        ...settingsItems,
        { type: 'separator' },
        { label: 'Quit', accelerator: KEYS.quit, role: 'quit' },
      ]),
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { label: 'Undo Typing', accelerator: KEYS.undo, click: send('send-key', { data: '\x1f' }) },
      { type: 'separator' },
      { label: 'Copy', accelerator: KEYS.copy, click: send('copy') },
      { label: 'Paste', accelerator: KEYS.paste, click: send('paste') },
      { label: 'Paste Escaped', accelerator: KEYS.pasteEscaped, click: send('paste-escaped') },
      { label: 'Select All', accelerator: KEYS.selectAll, click: send('select-all') },
      { label: 'Select Current Command', accelerator: KEYS.selectInput, click: send('select-input') },
      { type: 'separator' },
      { label: 'Delete Selection', accelerator: KEYS.deleteSelection, click: send('delete-selection') },
      { type: 'separator' },
      { label: 'Find…', accelerator: KEYS.find, click: send('find') },
      { label: 'Find Next', accelerator: KEYS.findNext, click: send('find-next') },
      { label: 'Find Previous', accelerator: KEYS.findPrev, click: send('find-previous') },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Fold This Command\'s Output', accelerator: KEYS.foldOne, click: send('fold-last') },
      { label: 'Cycle Fold: Truncated / Full / Hidden', accelerator: KEYS.cycleFold, click: send('cycle-fold-last') },
      { label: 'Fold All Outputs', accelerator: KEYS.foldAll, click: send('fold-all') },
      { label: 'Expand All Outputs', accelerator: KEYS.expandAll, click: send('expand-all') },
      { type: 'separator' },
      { label: 'Command List…', accelerator: KEYS.blocks, click: send('toggle-blocks-panel') },
      { label: 'Remote Files…', accelerator: KEYS.files, click: send('toggle-files-panel') },
      { type: 'separator' },
      { label: 'Bigger Text', accelerator: KEYS.bigger, click: send('font-bigger') },
      { label: 'Smaller Text', accelerator: KEYS.smaller, click: send('font-smaller') },
      { label: 'Actual Size', accelerator: KEYS.actualSize, click: send('font-reset') },
      { type: 'separator' },
      { label: 'Clear Scrollback', accelerator: KEYS.clear, click: send('clear-scrollback') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'Toggle Developer Tools', accelerator: KEYS.devTools, role: 'toggleDevTools' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: KEYS.nextTab, click: send('next-tab') },
      { label: 'Previous Tab', accelerator: KEYS.prevTab, click: send('previous-tab') },
      ...Array.from({ length: 9 }, (_, i) => ({
        label: `Tab ${i + 1}`,
        accelerator: KEYS.tab(i + 1),
        click: send('select-tab', { index: i }),
        visible: false,
      })),
      ...(IS_MAC ? [{ type: 'separator' }, { role: 'front' }] : []),
    ],
  });

  template.push({
    role: 'help',
    submenu: [
      { label: 'Keyboard Shortcuts', accelerator: KEYS.help, click: send('show-help') },
      // The About panel is a macOS and Linux role; Windows has no equivalent.
      ...(IS_MAC || IS_WIN ? [] : [{ type: 'separator' }, { role: 'about' }]),
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The same table the menu is built from, flattened for IPC, so the help sheet
// can label itself with the bindings that are actually in force rather than a
// second hand-maintained copy of them.
function accelerators() {
  const { tab, shellTab, ...rest } = KEYS;
  return { ...rest, firstTab: tab(1), lastTab: tab(9) };
}

module.exports = { build, accelerators };
