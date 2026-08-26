const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Terminal
  createTerminal: (opts) => ipcRenderer.invoke('term:create', opts),
  sendInput: (id, data) => ipcRenderer.send('term:input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  killTerminal: (id) => ipcRenderer.send('term:kill', id),
  onTermData: (callback) => ipcRenderer.on('term:data', (e, id, data) => callback(id, data)),
  onTermExit: (callback) => ipcRenderer.on('term:exit', (e, id, code) => callback(id, code)),

  // Native SSH
  sshConnect: (cfg) => ipcRenderer.invoke('ssh:connect', cfg),
  sshInput: (id, data) => ipcRenderer.send('ssh:input', id, data),
  sshResize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  sshClose: (id) => ipcRenderer.send('ssh:close', id),
  onSshData: (cb) => ipcRenderer.on('ssh:data', (e, id, data) => cb(id, data)),
  onSshExit: (cb) => ipcRenderer.on('ssh:exit', (e, id, code) => cb(id, code)),
  onSshStatus: (cb) => ipcRenderer.on('ssh:status', (e, id, msg) => cb(id, msg)),
  onSshPrompt: (cb) => ipcRenderer.on('ssh:prompt', (e, id, payload) => cb(id, payload)),
  sshPromptReply: (id, answers) => ipcRenderer.send('ssh:prompt-reply', id, answers),
  sshFindKeys: () => ipcRenderer.invoke('ssh:findKeys'),
  sshDefaultUser: () => ipcRenderer.invoke('ssh:defaultUser'),

  // SFTP (rides the live SSH session)
  sftpList: (id, path) => ipcRenderer.invoke('sftp:list', id, path),
  sftpRealpath: (id, path) => ipcRenderer.invoke('sftp:realpath', id, path),
  sftpStat: (id, path) => ipcRenderer.invoke('sftp:stat', id, path),
  sftpDownload: (id, remote, local) => ipcRenderer.invoke('sftp:download', id, remote, local),
  sftpUpload: (id, local, remote) => ipcRenderer.invoke('sftp:upload', id, local, remote),
  sftpMkdir: (id, path) => ipcRenderer.invoke('sftp:mkdir', id, path),
  sftpRename: (id, from, to) => ipcRenderer.invoke('sftp:rename', id, from, to),
  sftpChmod: (id, path, mode) => ipcRenderer.invoke('sftp:chmod', id, path, mode),
  sftpDelete: (id, path, isDir) => ipcRenderer.invoke('sftp:delete', id, path, isDir),
  onSftpProgress: (cb) => ipcRenderer.on('sftp:progress', (e, id, p) => cb(id, p)),

  // FTP
  ftpConnect: (config) => ipcRenderer.invoke('ftp:connect', config),
  ftpList: (id, path) => ipcRenderer.invoke('ftp:list', id, path),
  ftpDownload: (id, remote, local) => ipcRenderer.invoke('ftp:download', id, remote, local),
  ftpUpload: (id, local, remote) => ipcRenderer.invoke('ftp:upload', id, local, remote),
  ftpMkdir: (id, path) => ipcRenderer.invoke('ftp:mkdir', id, path),
  ftpDelete: (id, path, isDir) => ipcRenderer.invoke('ftp:delete', id, path, isDir),
  ftpPwd: (id) => ipcRenderer.invoke('ftp:pwd', id),
  ftpDisconnect: (id) => ipcRenderer.invoke('ftp:disconnect', id),

  // Dialogs
  saveFileDialog: (name) => ipcRenderer.invoke('dialog:saveFile', name),
  openFileDialog: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  openKeyDialog: () => ipcRenderer.invoke('dialog:openKey'),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  // Electron 32+ removed File.path; this is the supported replacement.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // Saved hosts
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  getHost: (key) => ipcRenderer.invoke('hosts:get', key),
  saveHost: (data) => ipcRenderer.invoke('hosts:save', data),
  deleteHost: (key) => ipcRenderer.invoke('hosts:delete', key),

  // Quicklinks
  listQuicklinks: () => ipcRenderer.invoke('quicklinks:list'),
  getQuicklink: (id) => ipcRenderer.invoke('quicklinks:get', id),
  saveQuicklink: (data) => ipcRenderer.invoke('quicklinks:save', data),
  deleteQuicklink: (id) => ipcRenderer.invoke('quicklinks:delete', id),

  // App state persistence
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),

  // Keep-alive
  keepAliveGet: () => ipcRenderer.invoke('keepalive:get'),
  keepAliveSet: (patch) => ipcRenderer.invoke('keepalive:set', patch),

  // Remote update
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateSourceGet: () => ipcRenderer.invoke('update:source:get'),
  updateSourceSet: (patch) => ipcRenderer.invoke('update:source:set', patch),
  updateSourceBrowse: () => ipcRenderer.invoke('update:source:browse'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (e, state) => cb(state)),
});
