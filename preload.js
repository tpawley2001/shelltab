const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Terminal
  createTerminal: (opts) => ipcRenderer.invoke('term:create', opts),
  sendInput: (id, data) => ipcRenderer.send('term:input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  killTerminal: (id) => ipcRenderer.send('term:kill', id),
  onTermData: (callback) => ipcRenderer.on('term:data', (e, id, data) => callback(id, data)),
  onTermExit: (callback) => ipcRenderer.on('term:exit', (e, id, code) => callback(id, code)),

  // FTP
  ftpConnect: (config) => ipcRenderer.invoke('ftp:connect', config),
  ftpList: (id, path) => ipcRenderer.invoke('ftp:list', id, path),
  ftpDownload: (id, remote, local) => ipcRenderer.invoke('ftp:download', id, remote, local),
  ftpUpload: (id, local, remote) => ipcRenderer.invoke('ftp:upload', id, local, remote),
  ftpMkdir: (id, path) => ipcRenderer.invoke('ftp:mkdir', id, path),
  ftpDelete: (id, path) => ipcRenderer.invoke('ftp:delete', id, path),
  ftpPwd: (id) => ipcRenderer.invoke('ftp:pwd', id),
  ftpDisconnect: (id) => ipcRenderer.invoke('ftp:disconnect', id),

  // Dialogs
  saveFileDialog: (name) => ipcRenderer.invoke('dialog:saveFile', name),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // Saved hosts
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  getHost: (key) => ipcRenderer.invoke('hosts:get', key),
  saveHost: (data) => ipcRenderer.invoke('hosts:save', data),
  deleteHost: (key) => ipcRenderer.invoke('hosts:delete', key),
});
