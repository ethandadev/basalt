'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// The faces that are actually present out of the box, per platform. Anything
// missing is skipped by the CSS font stack, so the last entry is what matters.
const DEFAULT_FONT = process.platform === 'darwin'
  ? 'SF Mono, Menlo, Monaco, Courier New, monospace'
  : process.platform === 'win32'
    ? 'Cascadia Mono, Consolas, Lucida Console, Courier New, monospace'
    : 'DejaVu Sans Mono, Liberation Mono, Noto Sans Mono, Ubuntu Mono, monospace';

const DEFAULTS = {
  appearance: {
    // 'auto' follows the macOS appearance and swaps between the two themes
    // below; 'light' and 'dark' pin it.
    mode: 'auto',
    lightTheme: 'basalt-light',
    darkTheme: 'basalt-dark',
    fontFamily: DEFAULT_FONT,
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorStyle: 'block', // block | bar | underline
    cursorBlink: true,
    opacity: 1,
    vibrancy: false,
    padding: 10,
    scrollbar: true,
    minimumContrastRatio: 1,
  },
  shell: {
    // Empty string means "whatever the system says is my login shell".
    defaultShell: '',
    args: [],
    loginShell: true,
    startingDirectory: 'home', // home | inherit | custom
    customDirectory: '',
    extraShells: [],
  },
  behavior: {
    scrollback: 10000,
    copyOnSelect: false,
    pasteOnRightClick: false,
    confirmCloseRunning: true,
    bell: 'none', // none | sound | visual
    scrollSensitivity: 1,
    rightClickMenu: true,
    // Option sends Esc-prefixed sequences, so ⌥← / ⌥→ move by word the way
    // they do in every other terminal. Turn off to type accented characters.
    optionAsMeta: true,
  },
  prediction: {
    ghostText: true,
    ghostSource: 'history-and-files', // history | history-and-files | off
    completionMenu: true,
    completionMaxItems: 12,
    completionMinChars: 0,
    acceptKey: 'right', // right | tab (End always accepts too)
  },
  blocks: {
    enabled: true,
    autoTruncate: true,
    truncateThreshold: 40,
    headLines: 12,
    tailLines: 6,
    showExitStatus: true,
    showTiming: true,
    maxBlocks: 300,
    maxBytesPerBlock: 2 * 1024 * 1024,
  },
  ssh: {
    // Targets the user has connected to, newest first, offered alongside the
    // hosts named in ~/.ssh/config.
    recent: [],
  },
  window: {
    width: 1000,
    height: 680,
    rememberSize: true,
  },
};

const THEMES = {
  'basalt-dark': {
    name: 'Basalt Dark',
    background: '#12141a', foreground: '#dfe3ec', cursor: '#dfe3ec', cursorAccent: '#12141a',
    selectionBackground: '#2f5d8a', selectionForeground: '#ffffff',
    black: '#20232b', red: '#e35d6a', green: '#5dc98a', yellow: '#e0b957',
    blue: '#5aa5f0', magenta: '#c98ae0', cyan: '#4fc4c4', white: '#c7ccd8',
    brightBlack: '#4a505f', brightRed: '#ff7a86', brightGreen: '#79e5a5', brightYellow: '#ffd473',
    brightBlue: '#7dbcff', brightMagenta: '#dfa6f5', brightCyan: '#6fdede', brightWhite: '#ffffff',
    ui: 'dark',
  },
  'basalt-light': {
    name: 'Basalt Light',
    background: '#fbfbfd', foreground: '#20242e', cursor: '#20242e', cursorAccent: '#fbfbfd',
    selectionBackground: '#c3ddf7', selectionForeground: '#101318',
    black: '#2b303b', red: '#c03440', green: '#2f8f57', yellow: '#966a00',
    blue: '#1f6fc4', magenta: '#9245b0', cyan: '#0f7f88', white: '#d8dce4',
    brightBlack: '#7a8394', brightRed: '#d94f5c', brightGreen: '#3aa869', brightYellow: '#b07f10',
    brightBlue: '#3b8ae0', brightMagenta: '#a95cc4', brightCyan: '#1a99a3', brightWhite: '#ffffff',
    ui: 'light',
  },
  'macos-basic': {
    name: 'macOS Basic',
    background: '#ffffff', foreground: '#000000', cursor: '#000000', cursorAccent: '#ffffff',
    selectionBackground: '#b4d5fe', selectionForeground: '#000000',
    black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900',
    blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
    brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900', brightYellow: '#e5e500',
    brightBlue: '#0000ff', brightMagenta: '#e500e5', brightCyan: '#00e5e5', brightWhite: '#e5e5e5',
    ui: 'light',
  },
  'macos-pro': {
    name: 'macOS Pro',
    background: '#000000', foreground: '#f2f2f2', cursor: '#4d4d4d', cursorAccent: '#000000',
    selectionBackground: '#414141', selectionForeground: '#f2f2f2',
    black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900',
    blue: '#2009db', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
    brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900', brightYellow: '#e5e500',
    brightBlue: '#0000ff', brightMagenta: '#e500e5', brightCyan: '#00e5e5', brightWhite: '#e5e5e5',
    ui: 'dark',
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36',
    selectionBackground: '#274642', selectionForeground: '#93a1a1',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
    brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    ui: 'dark',
  },
  'solarized-light': {
    name: 'Solarized Light',
    background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5', selectionForeground: '#586e75',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
    brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    ui: 'light',
  },
  nord: {
    name: 'Nord',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
    selectionBackground: '#434c5e', selectionForeground: '#eceff4',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    ui: 'dark',
  },
  novel: {
    name: 'Novel',
    background: '#dfdbc3', foreground: '#3b2322', cursor: '#3b2322', cursorAccent: '#dfdbc3',
    selectionBackground: '#a4a390', selectionForeground: '#3b2322',
    black: '#000000', red: '#cc0000', green: '#009600', yellow: '#d06b00',
    blue: '#0000cc', magenta: '#cc00cc', cyan: '#0087cc', white: '#cccccc',
    brightBlack: '#808080', brightRed: '#cc0000', brightGreen: '#009600', brightYellow: '#d06b00',
    brightBlue: '#0000cc', brightMagenta: '#cc00cc', brightCyan: '#0087cc', brightWhite: '#ffffff',
    ui: 'light',
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26',
    selectionBackground: '#33467c', selectionForeground: '#c0caf5',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
    brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    ui: 'dark',
  },
};

// Which theme is actually in force, given the mode and what macOS is doing.
function resolveTheme(appearance, systemIsDark) {
  const dark = appearance.mode === 'dark' || (appearance.mode === 'auto' && systemIsDark);
  const id = dark ? appearance.darkTheme : appearance.lightTheme;
  return THEMES[id] || THEMES[dark ? 'basalt-dark' : 'basalt-light'];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Merge stored settings over the defaults one level at a time, so a settings
// file written by an older version never loses keys added since.
function merge(defaults, stored) {
  const out = Array.isArray(defaults) ? defaults.slice() : { ...defaults };
  if (!isPlainObject(stored)) return out;
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in out)) continue;
    if (isPlainObject(out[key]) && isPlainObject(value)) out[key] = merge(out[key], value);
    else if (Array.isArray(out[key]) && Array.isArray(value)) out[key] = value.slice();
    else if (typeof out[key] === typeof value) out[key] = value;
  }
  return out;
}

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return merge(DEFAULTS, JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[basalt] settings unreadable, using defaults:', err.message);
      return merge(DEFAULTS, {});
    }
  }

  all() {
    return this.data;
  }

  patch(partial) {
    this.data = merge(this.data, partial);
    this.save();
    return this.data;
  }

  reset() {
    this.data = merge(DEFAULTS, {});
    this.save();
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[basalt] could not save settings:', err.message);
    }
  }
}

module.exports = { Settings, DEFAULTS, THEMES, resolveTheme };
