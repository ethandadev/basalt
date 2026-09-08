// The settings sheet. Fields are described as data, and every edit applies
// live — there is no Save button.
//
// Only the settings worth reaching for are shown here. Everything else still
// lives in settings.json, which the footer points at.

import { listFonts, toStack, primaryFamily } from './fonts.js';

const SECTIONS = [
  {
    id: 'look',
    label: 'Look',
    fields: [
      { type: 'segment', path: 'appearance.mode', label: 'Appearance',
        options: [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']],
        hint: 'Auto follows the macOS setting and switches as your Mac does.' },
      { type: 'themes', which: 'light', label: 'Light theme' },
      { type: 'themes', which: 'dark', label: 'Dark theme' },
      { type: 'title', label: 'Text' },
      { type: 'font', path: 'appearance.fontFamily', label: 'Font' },
      { type: 'number', path: 'appearance.fontSize', label: 'Size', min: 8, max: 32, step: 1 },
      { type: 'range', path: 'appearance.lineHeight', label: 'Line spacing', min: 1, max: 2, step: 0.05 },
      { type: 'title', label: 'Window' },
      { type: 'select', path: 'appearance.cursorStyle', label: 'Cursor',
        options: [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']] },
      { type: 'check', path: 'appearance.cursorBlink', label: 'Blinking cursor' },
      { type: 'range', path: 'appearance.opacity', label: 'Opacity', min: 0.4, max: 1, step: 0.01 },
      { type: 'check', path: 'appearance.vibrancy', label: 'Blur what is behind the window' },
      { type: 'range', path: 'appearance.padding', label: 'Padding', min: 0, max: 40, step: 1 },
    ],
  },
  {
    id: 'shell',
    label: 'Shell',
    fields: [
      { type: 'shell', path: 'shell.defaultShell', label: 'Default shell',
        hint: 'Used for new tabs. The picker in the toolbar switches any single tab.' },
      { type: 'check', path: 'shell.loginShell', label: 'Run as a login shell',
        hint: 'Loads .zprofile / .bash_profile, the same as the built-in Terminal.' },
      { type: 'select', path: 'shell.startingDirectory', label: 'New tabs start in',
        options: [['home', 'Home folder'], ['inherit', 'Same folder as the current tab'], ['custom', 'A specific folder']] },
      { type: 'directory', path: 'shell.customDirectory', label: 'That folder', dependsOn: ['shell.startingDirectory', 'custom'] },
      { type: 'list', path: 'shell.extraShells', label: 'Extra shells',
        hint: 'Full paths to shells that are not in /etc/shells.' },
    ],
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    fields: [
      { type: 'title', label: 'Prediction' },
      { type: 'check', path: 'prediction.ghostText', label: 'Show the greyed-out suggestion',
        hint: 'Predicts the rest of the line as you type. Press → to accept it.' },
      { type: 'select', path: 'prediction.ghostSource', label: 'Predict from',
        options: [['history', 'History only'], ['history-and-files', 'History and filenames'], ['off', 'Nothing']] },
      { type: 'select', path: 'prediction.acceptKey', label: 'Accept the suggestion with',
        options: [['right', '→'], ['tab', 'Tab']],
        hint: 'End accepts it either way, and ⌥→ takes just the next word.' },
      { type: 'check', path: 'prediction.completionMenu', label: 'Show a menu when Tab is ambiguous',
        hint: 'Turn off to hand Tab straight to the shell instead.' },
      { type: 'title', label: 'Output' },
      { type: 'check', path: 'blocks.autoTruncate', label: 'Shorten long output automatically' },
      { type: 'number', path: 'blocks.truncateThreshold', label: 'Shorten output longer than', min: 5, max: 5000, step: 5,
        hint: 'Lines. Click the summary line to see it all again.' },
      { type: 'check', path: 'blocks.showExitStatus', label: 'Show the exit status on folded output' },
      { type: 'number', path: 'behavior.scrollback', label: 'Scrollback lines', min: 100, max: 200000, step: 100 },
      { type: 'title', label: 'Keyboard and mouse' },
      { type: 'check', path: 'behavior.copyOnSelect', label: 'Copy as soon as text is selected' },
      { type: 'check', path: 'behavior.pasteOnRightClick', label: 'Right-click pastes',
        hint: 'Replaces the right-click menu with an immediate paste.' },
      { type: 'check', path: 'behavior.optionAsMeta', label: 'Option key moves by word',
        hint: 'Turn off to type accented characters with Option.' },
      { type: 'check', path: 'behavior.confirmCloseRunning', label: 'Ask before closing a busy tab' },
      { type: 'select', path: 'behavior.bell', label: 'Bell',
        options: [['none', 'Ignore'], ['visual', 'Flash the tab'], ['sound', 'Play a sound']] },
    ],
  },
];

function get(object, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
}

function set(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((value, key) => (value[key] = value[key] || {}), object);
  target[last] = value;
}

export function buildSettingsUI({ tabsEl, bodyEl, pathEl, getSettings, onChange, onReset }) {
  let active = SECTIONS[0].id;
  let fonts = { monospace: [], all: [], source: 'fallback' };
  let showAllFonts = false;

  listFonts().then((result) => { fonts = result; if (!bodyEl.hidden) render(); });

  function themeGrid(spec, settings) {
    const wrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = spec.label;
    wrap.appendChild(title);

    const path = spec.which === 'light' ? 'appearance.lightTheme' : 'appearance.darkTheme';
    const current = get(settings, path);

    const grid = document.createElement('div');
    grid.className = 'theme-grid';
    for (const [id, theme] of Object.entries(settings.themes)) {
      if (theme.ui !== spec.which) continue;
      const button = document.createElement('button');
      button.className = 'theme-swatch' + (current === id ? ' active' : '');
      button.style.background = theme.background;
      button.style.color = theme.foreground;
      button.textContent = theme.name;
      const dots = document.createElement('div');
      dots.className = 'dots';
      for (const key of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
        const dot = document.createElement('i');
        dot.style.background = theme[key];
        dots.appendChild(dot);
      }
      button.appendChild(dots);
      button.addEventListener('click', () => onChange(path, id));
      grid.appendChild(button);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function fontControl(spec, settings, control) {
    const current = primaryFamily(get(settings, spec.path));
    const list = showAllFonts ? fonts.all : fonts.monospace;

    const select = document.createElement('select');
    select.className = 'font-select';
    const names = list.includes(current) || !current ? list : [current, ...list];
    for (const family of names) {
      const option = document.createElement('option');
      option.value = family;
      option.textContent = family;
      option.style.fontFamily = `"${family}", monospace`;
      option.selected = family === current;
      select.appendChild(option);
    }
    select.addEventListener('change', () => onChange(spec.path, toStack(select.value)));
    control.appendChild(select);

    const toggle = document.createElement('button');
    toggle.className = 'mini';
    toggle.textContent = showAllFonts ? 'Monospaced only' : 'All fonts';
    toggle.title = showAllFonts
      ? 'Show only fonts where every character is the same width'
      : 'Show every font installed on this Mac';
    toggle.addEventListener('click', () => { showAllFonts = !showAllFonts; render(); });
    control.appendChild(toggle);
  }

  function field(spec, settings) {
    if (spec.type === 'title') {
      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = spec.label;
      return title;
    }

    if (spec.type === 'themes') return themeGrid(spec, settings);

    if (spec.dependsOn) {
      const [dependsPath, expected] = spec.dependsOn;
      if (get(settings, dependsPath) !== expected) return null;
    }

    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('label');
    label.textContent = spec.label;
    if (spec.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = spec.hint;
      label.appendChild(hint);
    }
    row.appendChild(label);

    const control = document.createElement('div');
    control.className = 'control';
    const value = get(settings, spec.path);

    switch (spec.type) {
      case 'segment': {
        const group = document.createElement('div');
        group.className = 'segment';
        for (const [optionValue, optionLabel] of spec.options) {
          const button = document.createElement('button');
          button.className = 'segment-option' + (optionValue === value ? ' active' : '');
          button.textContent = optionLabel;
          button.addEventListener('click', () => onChange(spec.path, optionValue));
          group.appendChild(button);
        }
        control.appendChild(group);
        break;
      }
      case 'font':
        fontControl(spec, settings, control);
        break;
      case 'check': {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(value);
        input.addEventListener('change', () => onChange(spec.path, input.checked));
        control.appendChild(input);
        break;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        Object.assign(input, { min: spec.min, max: spec.max, step: spec.step, value });
        input.addEventListener('change', () => {
          const next = Math.min(spec.max, Math.max(spec.min, Number(input.value) || spec.min));
          input.value = next;
          onChange(spec.path, next);
        });
        control.appendChild(input);
        break;
      }
      case 'range': {
        const input = document.createElement('input');
        input.type = 'range';
        Object.assign(input, { min: spec.min, max: spec.max, step: spec.step, value });
        const readout = document.createElement('span');
        readout.className = 'value';
        readout.textContent = Number(value).toFixed(spec.step < 1 ? 2 : 0);
        input.addEventListener('input', () => {
          readout.textContent = Number(input.value).toFixed(spec.step < 1 ? 2 : 0);
          onChange(spec.path, Number(input.value), { silent: true });
        });
        control.appendChild(input);
        control.appendChild(readout);
        break;
      }
      case 'select': {
        const select = document.createElement('select');
        for (const [optionValue, optionLabel] of spec.options) {
          const option = document.createElement('option');
          option.value = optionValue;
          option.textContent = optionLabel;
          option.selected = optionValue === value;
          select.appendChild(option);
        }
        select.addEventListener('change', () => onChange(spec.path, select.value));
        control.appendChild(select);
        break;
      }
      case 'shell': {
        const select = document.createElement('select');
        const system = document.createElement('option');
        system.value = '';
        system.textContent = 'System default';
        system.selected = !value;
        select.appendChild(system);
        for (const entry of settings.shells || []) {
          const option = document.createElement('option');
          option.value = entry.path;
          option.textContent = `${entry.name} — ${entry.path}`;
          option.selected = entry.path === value;
          select.appendChild(option);
        }
        select.addEventListener('change', () => onChange(spec.path, select.value));
        control.appendChild(select);
        break;
      }
      case 'directory': {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
        input.addEventListener('change', () => onChange(spec.path, input.value));
        const browse = document.createElement('button');
        browse.className = 'mini';
        browse.textContent = 'Choose…';
        browse.addEventListener('click', async () => {
          const picked = await window.basalt.dialog.pickDirectory();
          if (picked) { input.value = picked; onChange(spec.path, picked); }
        });
        control.appendChild(input);
        control.appendChild(browse);
        break;
      }
      case 'list': {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = (value || []).join(', ');
        input.placeholder = '/opt/homebrew/bin/fish';
        input.addEventListener('change', () => {
          onChange(spec.path, input.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
        });
        const browse = document.createElement('button');
        browse.className = 'mini';
        browse.textContent = 'Add…';
        browse.addEventListener('click', async () => {
          const picked = await window.basalt.dialog.pickShell();
          if (!picked) return;
          const next = (get(getSettings(), spec.path) || []).concat(picked);
          input.value = next.join(', ');
          onChange(spec.path, next);
        });
        control.appendChild(input);
        control.appendChild(browse);
        break;
      }
      default:
        break;
    }

    row.appendChild(control);
    return row;
  }

  function render() {
    const settings = getSettings();

    tabsEl.innerHTML = '';
    for (const section of SECTIONS) {
      const button = document.createElement('button');
      button.className = 'sheet-tab' + (section.id === active ? ' active' : '');
      button.textContent = section.label;
      button.addEventListener('click', () => { active = section.id; render(); });
      tabsEl.appendChild(button);
    }

    bodyEl.innerHTML = '';
    const section = SECTIONS.find((s) => s.id === active) || SECTIONS[0];
    for (const spec of section.fields) {
      const element = field(spec, settings);
      if (element) bodyEl.appendChild(element);
    }

    if (pathEl && settings.settingsFile) pathEl.textContent = settings.settingsFile;
  }

  return { render, reset: onReset };
}

export { set as setPath };
