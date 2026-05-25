const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const pty = require('node-pty');
const ftp = require('basic-ftp');
const fs = require('fs');
const os = require('os');

let mainWindow;
const terminals = new Map();
let nextTermId = 1;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'ShellTab',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const [, term] of terminals) term.kill();
  app.quit();
});

const defaultShell = process.platform === 'win32'
  ? (process.env.COMSPEC || 'powershell.exe')
  : (process.env.SHELL || '/bin/bash');

ipcMain.handle('term:create', (event, opts = {}) => {
  const id = nextTermId++;
  const shell = opts.shell || defaultShell;
  const cwd = opts.cwd || os.homedir();
  const ptyOpts = {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  };
  if (process.platform === 'win32') {
    ptyOpts.useConpty = true;
  }
  const term = pty.spawn(shell, [], ptyOpts);

  terminals.set(id, term);

  term.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('term:data', id, data);
    }
  });

  term.onExit(({ exitCode }) => {
    terminals.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('term:exit', id, exitCode);
    }
  });

  return { id, shell, cwd };
});

ipcMain.on('term:input', (event, id, data) => {
  const term = terminals.get(id);
  if (term) term.write(data);
});

ipcMain.on('term:resize', (event, id, cols, rows) => {
  const term = terminals.get(id);
  if (term) {
    try { term.resize(cols, rows); } catch {}
  }
});

ipcMain.on('term:kill', (event, id) => {
  const term = terminals.get(id);
  if (term) {
    term.kill();
    terminals.delete(id);
  }
});

// FTP
const ftpClients = new Map();
let nextFtpId = 1;

ipcMain.handle('ftp:connect', async (event, config) => {
  const id = nextFtpId++;
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: config.host,
      port: config.port || 21,
      user: config.user || 'anonymous',
      password: config.password || '',
      secure: config.secure || false,
    });
    ftpClients.set(id, client);
    return { id, status: 'connected' };
  } catch (err) {
    return { id: null, status: 'error', message: err.message };
  }
});

ipcMain.handle('ftp:list', async (event, id, remotePath) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    const list = await client.list(remotePath || '/');
    return list.map((f) => ({
      name: f.name,
      size: f.size,
      type: f.isDirectory ? 'dir' : 'file',
      date: f.rawModifiedAt || f.modifiedAt?.toISOString() || '',
    }));
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ftp:download', async (event, id, remotePath, localPath) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    await client.downloadTo(localPath, remotePath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ftp:upload', async (event, id, localPath, remotePath) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    await client.uploadFrom(localPath, remotePath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ftp:mkdir', async (event, id, remotePath) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    await client.ensureDir(remotePath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ftp:delete', async (event, id, remotePath) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    await client.remove(remotePath);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ftp:pwd', async (event, id) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    return { path: await client.pwd() };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ftp:disconnect', async (event, id) => {
  const client = ftpClients.get(id);
  if (client) {
    client.close();
    ftpClients.delete(id);
  }
  return { success: true };
});

// File dialog helpers
const { dialog } = require('electron');

ipcMain.handle('dialog:saveFile', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(os.homedir(), defaultName || 'download'),
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Saved hosts (passwords encrypted via OS keychain) ──

const hostsFile = path.join(app.getPath('userData'), 'saved-hosts.json');

function loadHosts() {
  try {
    if (!fs.existsSync(hostsFile)) return [];
    const raw = JSON.parse(fs.readFileSync(hostsFile, 'utf-8'));
    return raw.map((h) => {
      if (h.encryptedPassword && safeStorage.isEncryptionAvailable()) {
        try {
          h.password = safeStorage.decryptString(Buffer.from(h.encryptedPassword, 'base64'));
        } catch { h.password = ''; }
      }
      delete h.encryptedPassword;
      return h;
    });
  } catch { return []; }
}

function saveHosts(hosts) {
  const toStore = hosts.map((h) => {
    const entry = { ...h };
    if (entry.password && safeStorage.isEncryptionAvailable()) {
      entry.encryptedPassword = safeStorage.encryptString(entry.password).toString('base64');
    } else if (entry.password) {
      entry.encryptedPassword = Buffer.from(entry.password).toString('base64');
    }
    delete entry.password;
    return entry;
  });
  fs.writeFileSync(hostsFile, JSON.stringify(toStore, null, 2));
}

ipcMain.handle('hosts:list', () => {
  const hosts = loadHosts();
  return hosts.map((h) => ({
    ...h,
    password: h.password ? '••••••••' : '',
    hasPassword: !!h.password,
  }));
});

ipcMain.handle('hosts:get', (event, hostKey) => {
  const hosts = loadHosts();
  return hosts.find((h) => h.key === hostKey) || null;
});

ipcMain.handle('hosts:save', (event, hostData) => {
  const hosts = loadHosts();
  const key = `${hostData.host}:${hostData.port || 21}:${hostData.user || 'anonymous'}`;
  const existing = hosts.findIndex((h) => h.key === key);
  const entry = { key, ...hostData };
  if (existing >= 0) {
    hosts[existing] = entry;
  } else {
    hosts.push(entry);
  }
  saveHosts(hosts);
  return { success: true, key };
});

ipcMain.handle('hosts:delete', (event, hostKey) => {
  const hosts = loadHosts().filter((h) => h.key !== hostKey);
  saveHosts(hosts);
  return { success: true };
});
