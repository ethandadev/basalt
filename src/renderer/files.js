// The remote file panel: browse a host over SSH, and move files either way.
//
// Every operation goes through the main process, which drives the system's own
// ssh and scp. Transfers share the connection a terminal tab opened, so a host
// that asked for a password or a hardware key once is not asked again here.

const NAME_MAX = 1024;

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Join a directory and a name without letting "" or "/" produce "//".
export function joinRemote(dir, name) {
  if (!dir || dir === '.') return name;
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

export function parentOf(dir) {
  if (!dir || dir === '/' || !dir.includes('/')) return dir === '/' ? '/' : '';
  const trimmed = dir.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '/';
  return trimmed.slice(0, cut);
}

// The clickable segments of a path, each with the directory it leads to.
export function breadcrumbs(dir) {
  if (!dir) return [];
  const parts = dir.split('/').filter(Boolean);
  const out = dir.startsWith('/') ? [{ label: '/', dir: '/' }] : [];
  let running = dir.startsWith('/') ? '' : '.';
  for (const part of parts) {
    running = running === '.' ? part : `${running}/${part}`;
    out.push({ label: part, dir: running });
  }
  return out;
}

export function createFilesPanel({ els, onBusy }) {
  const state = {
    target: '',
    cwd: '',
    entries: [],
    error: '',
    busy: false,
    hosts: { configured: [], recent: [] },
  };

  const setBusy = (busy, note = '') => {
    state.busy = busy;
    state.error = busy ? note : state.error;
    if (onBusy) onBusy(busy);
    renderStatus();
  };

  function renderStatus() {
    const el = els.status;
    el.textContent = state.busy
      ? (state.error || 'Working…')
      : state.error;
    el.classList.toggle('bad', Boolean(state.error) && !state.busy);
    el.hidden = !el.textContent;
  }

  async function loadHosts() {
    state.hosts = await window.basalt.ssh.hosts();
    const select = els.host;
    const previous = state.target;
    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a host…';
    select.appendChild(placeholder);

    const add = (label, values) => {
      const listed = values.filter(Boolean);
      if (!listed.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const value of listed) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        group.appendChild(option);
      }
      select.appendChild(group);
    };

    const configured = state.hosts.configured.map((h) => h.host);
    add('From ~/.ssh/config', configured);
    add('Recent', state.hosts.recent.filter((h) => !configured.includes(h)));

    if (previous && ![...select.options].some((o) => o.value === previous)) {
      const option = document.createElement('option');
      option.value = previous;
      option.textContent = previous;
      select.appendChild(option);
    }
    select.value = previous || '';
  }

  async function navigate(dir) {
    if (!state.target) return;
    setBusy(true, `Listing ${dir || 'home'}…`);
    const result = await window.basalt.sftp.list(state.target, dir);
    state.busy = false;
    if (onBusy) onBusy(false);

    if (!result.ok) {
      state.error = result.error;
      state.entries = [];
      render();
      return;
    }
    state.error = '';
    state.cwd = result.cwd;
    state.entries = result.entries;
    render();
  }

  async function setTarget(target) {
    state.target = target || '';
    state.entries = [];
    state.cwd = '';
    state.error = '';
    if (els.host.value !== state.target) els.host.value = state.target;
    if (!state.target) { render(); return; }
    await navigate('');
  }

  function renderPath() {
    const el = els.path;
    el.innerHTML = '';
    if (!state.target) { el.hidden = true; return; }
    el.hidden = false;

    const up = document.createElement('button');
    up.className = 'mini';
    up.textContent = '↑';
    up.title = 'Parent folder';
    up.tabIndex = -1;
    up.disabled = !state.cwd || state.cwd === '/';
    up.addEventListener('mousedown', (event) => event.preventDefault());
    up.addEventListener('click', () => navigate(parentOf(state.cwd)));
    el.appendChild(up);

    for (const crumb of breadcrumbs(state.cwd)) {
      const button = document.createElement('button');
      button.className = 'crumb';
      button.textContent = crumb.label;
      button.title = crumb.dir;
      button.tabIndex = -1;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => navigate(crumb.dir));
      el.appendChild(button);
    }
  }

  function renderList() {
    const list = els.list;
    list.innerHTML = '';

    if (!state.target) {
      const empty = document.createElement('div');
      empty.className = 'block-empty';
      empty.textContent = 'Choose a host to browse its files. Open a terminal tab to that host first '
        + 'and this panel will share the connection, so it never asks for a password of its own.';
      list.appendChild(empty);
      return;
    }

    if (!state.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'block-empty';
      empty.textContent = state.error ? '' : 'This folder is empty.';
      list.appendChild(empty);
      return;
    }

    for (const entry of state.entries) {
      const row = document.createElement('div');
      row.className = 'file-row' + (entry.directory ? ' dir' : '');

      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = entry.directory ? '▸' : '·';
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = entry.name.slice(0, NAME_MAX);
      name.title = entry.name;
      row.appendChild(name);

      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = entry.directory ? '' : formatSize(entry.size);
      row.appendChild(size);

      const actions = document.createElement('span');
      actions.className = 'file-actions';

      if (!entry.directory) {
        const get = document.createElement('button');
        get.className = 'mini';
        get.textContent = '↓';
        get.title = `Download ${entry.name}`;
        get.tabIndex = -1;
        get.addEventListener('mousedown', (event) => event.preventDefault());
        get.addEventListener('click', async (event) => {
          event.stopPropagation();
          setBusy(true, `Downloading ${entry.name}…`);
          const result = await window.basalt.sftp.download(
            state.target, joinRemote(state.cwd, entry.name), entry.name);
          setBusy(false);
          state.error = result.ok || result.cancelled ? '' : result.error;
          renderStatus();
        });
        actions.appendChild(get);
      }

      const remove = document.createElement('button');
      remove.className = 'mini danger';
      remove.textContent = '✕';
      remove.title = `Delete ${entry.name}`;
      remove.tabIndex = -1;
      remove.addEventListener('mousedown', (event) => event.preventDefault());
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        const ok = await window.basalt.dialog.confirm({
          title: entry.directory ? 'Delete this folder?' : 'Delete this file?',
          message: entry.name,
          detail: `On ${state.target}, in ${state.cwd}. This cannot be undone.`,
          confirmLabel: 'Delete',
        });
        if (!ok) return;
        setBusy(true, `Deleting ${entry.name}…`);
        const result = await window.basalt.sftp.remove(
          state.target, joinRemote(state.cwd, entry.name), entry.directory);
        setBusy(false);
        state.error = result.ok ? '' : result.error;
        if (result.ok) await navigate(state.cwd);
        else renderStatus();
      });
      actions.appendChild(remove);
      row.appendChild(actions);

      if (entry.directory) {
        row.addEventListener('click', () => navigate(joinRemote(state.cwd, entry.name)));
      }
      list.appendChild(row);
    }
  }

  function render() {
    renderPath();
    renderList();
    renderStatus();
  }

  els.host.addEventListener('change', () => setTarget(els.host.value));
  els.refresh.addEventListener('click', () => { if (state.target) navigate(state.cwd); });

  els.upload.addEventListener('click', async () => {
    if (!state.target || !state.cwd) return;
    setBusy(true, 'Uploading…');
    const result = await window.basalt.sftp.upload(state.target, state.cwd);
    setBusy(false);
    state.error = result.ok || result.cancelled ? '' : result.error;
    if (result.ok) await navigate(state.cwd);
    else renderStatus();
  });

  els.mkdir.addEventListener('click', async () => {
    if (!state.target || !state.cwd) return;
    const name = await promptForName(els);
    if (!name) return;
    setBusy(true, `Creating ${name}…`);
    const result = await window.basalt.sftp.mkdir(state.target, joinRemote(state.cwd, name));
    setBusy(false);
    state.error = result.ok ? '' : result.error;
    if (result.ok) await navigate(state.cwd);
    else renderStatus();
  });

  return {
    render,
    loadHosts,
    setTarget,
    refresh: () => (state.target ? navigate(state.cwd) : Promise.resolve()),
    get target() { return state.target; },
  };
}

// A tiny inline prompt rather than a native dialog: the panel is already a
// form-like surface, and a modal for one short name is heavy.
function promptForName(els) {
  return new Promise((resolve) => {
    const row = document.createElement('div');
    row.className = 'file-newdir';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'New folder name';
    input.spellcheck = false;
    row.appendChild(input);

    const finish = (value) => {
      row.remove();
      resolve(value ? value.trim() : '');
    };

    const ok = document.createElement('button');
    ok.className = 'mini';
    ok.textContent = 'Create';
    ok.addEventListener('mousedown', (event) => event.preventDefault());
    ok.addEventListener('click', () => finish(input.value));
    row.appendChild(ok);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(input.value); }
      if (event.key === 'Escape') { event.preventDefault(); finish(''); }
    });

    els.list.prepend(row);
    input.focus();
  });
}
