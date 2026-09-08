'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs with node integration off. Everything it can reach lives
// here, and nothing here takes a channel name from the page.
function on(channel, handler) {
  const wrapped = (event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('basalt', {
  pty: {
    create: (options) => ipcRenderer.invoke('pty:create', options),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    setCwd: (id, cwd) => ipcRenderer.send('pty:cwd', { id, cwd }),
    status: (id) => ipcRenderer.invoke('pty:status', { id }),
    onData: (handler) => on('pty:data', handler),
    onExit: (handler) => on('pty:exit', handler),
  },

  shells: {
    list: () => ipcRenderer.invoke('shells:list'),
  },

  complete: (query) => ipcRenderer.invoke('complete', query),
  suggest: (query) => ipcRenderer.invoke('suggest', query),
  history: (shellBase) => ipcRenderer.invoke('history:load', { shellBase }),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (partial) => ipcRenderer.invoke('settings:patch', partial),
    reset: () => ipcRenderer.invoke('settings:reset'),
    onChange: (handler) => on('settings:changed', handler),
  },

  window: {
    appearance: (options) => ipcRenderer.send('window:appearance', options),
  },

  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.send('clipboard:write', text),
  },

  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  ssh: {
    hosts: () => ipcRenderer.invoke('ssh:hosts'),
    command: (target) => ipcRenderer.invoke('ssh:command', { target }),
    forget: (target) => ipcRenderer.invoke('ssh:forget', { target }),
  },

  sftp: {
    status: (target) => ipcRenderer.invoke('sftp:status', { target }),
    list: (target, dir) => ipcRenderer.invoke('sftp:list', { target, dir }),
    mkdir: (target, path) => ipcRenderer.invoke('sftp:mkdir', { target, path }),
    remove: (target, path, directory) => ipcRenderer.invoke('sftp:remove', { target, path, directory }),
    download: (target, path, name) => ipcRenderer.invoke('sftp:download', { target, path, name }),
    upload: (target, dir) => ipcRenderer.invoke('sftp:upload', { target, dir }),
    disconnect: (target) => ipcRenderer.invoke('sftp:disconnect', { target }),
  },

  dialog: {
    confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
    pickShell: () => ipcRenderer.invoke('dialog:pickShell'),
    context: (options) => ipcRenderer.invoke('menu:context', options),
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    onMenu: (handler) => on('menu:action', handler),
    onSystemTheme: (handler) => on('system:theme', handler),
  },
});
