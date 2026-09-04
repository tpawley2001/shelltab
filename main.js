const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const pty = require('node-pty');
const ftp = require('basic-ftp');
const fs = require('fs');
const os = require('os');
const sshManager = require('./sshmanager');
const keepAlive = require('./keepalive');
const updater = require('./updater');

let mainWindow;
const terminals = new Map();
let nextTermId = 1;

function createWindow() {
  const saved = (() => {
    try {
      const sf = path.join(app.getPath('userData'), 'app-state.json');
      if (fs.existsSync(sf)) return JSON.parse(fs.readFileSync(sf, 'utf-8'));
    } catch {}
    return null;
  })();
  const bounds = saved?.windowBounds || { width: 1200, height: 800 };
  const maximized = !!saved?.windowMaximized;

  mainWindow = new BrowserWindow({
    ...bounds,
    title: 'ShellTab',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (maximized) mainWindow.maximize();
  // In selftest mode the page loads with ?selftest=1 so renderer modules can
  // expose test hooks before any probe runs (see dialogs.js).
  const loadOpts = process.env.SHELLTAB_SELFTEST ? { query: { selftest: '1' } } : undefined;
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), loadOpts);
  mainWindow.setMenuBarVisibility(false);

  // Links clicked in a terminal open in the user's browser, not in here.
  // xterm's web-links addon and its OSC-8 hyperlink support both go through
  // window.open, which Electron denies by default — so without this a link
  // in terminal output (a CI URL, or the Kickbacks status-line ad) looked
  // clickable and did nothing at all. 'deny' still stands: the URL is handed
  // to the desktop, never opened as a window inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // A drag-and-drop or a stray link must not navigate the shell UI away.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // SHELLTAB_DEBUG=1 surfaces renderer console output in the terminal.
  if (process.env.SHELLTAB_DEBUG) {
    mainWindow.webContents.on('console-message', (e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('render-process-gone', (e, details) => {
      console.log('[renderer gone]', JSON.stringify(details));
    });
  }

  if (process.env.SHELLTAB_SELFTEST) require('./smoketest').run(mainWindow, app);

  // Persist geometry continuously (debounced), not just on close: a crash,
  // kill or power loss would otherwise restore the last *clean* exit's size.
  let saveBoundsTimer = null;
  const saveBounds = () => {
    if (saveBoundsTimer) return;
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null;
      try {
        const sf = path.join(app.getPath('userData'), 'app-state.json');
        const current = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf-8')) : {};
        current.windowBounds = mainWindow.getNormalBounds(); // size ignoring maximize
        current.windowMaximized = mainWindow.isMaximized();
        fs.writeFileSync(sf, JSON.stringify(current, null, 2));
      } catch {}
    }, 800);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', saveBounds);
  mainWindow.on('unmaximize', saveBounds);

  mainWindow.on('close', () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    try {
      const sf = path.join(app.getPath('userData'), 'app-state.json');
      const current = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf-8')) : {};
      current.windowBounds = mainWindow.getNormalBounds();
      current.windowMaximized = mainWindow.isMaximized();
      fs.writeFileSync(sf, JSON.stringify(current, null, 2));
    } catch {}
  });
}

const ssh = sshManager.register(() => mainWindow);

app.whenReady().then(() => {
  keepAlive.register();
  createWindow();
  updater.register(() => mainWindow);
});
app.on('window-all-closed', () => {
  for (const [, term] of terminals) term.kill();
  ssh.killAll();
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
  const port = config.port || 21;

  if (port === 22) {
    return { id: null, status: 'error', message: 'Port 22 is SSH/SFTP — this client supports FTP only. Use port 21 for FTP or enable FTPS.' };
  }

  const client = new ftp.Client();
  client.ftp.verbose = true;
  try {
    await client.access({
      host: config.host,
      port,
      user: config.user || 'anonymous',
      password: config.password || '',
      secure: config.secure || false,
    });
    ftpClients.set(id, client);
    return { id, status: 'connected' };
  } catch (err) {
    client.close();
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

ipcMain.handle('ftp:delete', async (event, id, remotePath, isDir) => {
  const client = ftpClients.get(id);
  if (!client) return { error: 'Not connected' };
  try {
    // DELE only deletes files; an empty directory needs RMD.
    if (isDir) await client.removeEmptyDir(remotePath);
    else await client.remove(remotePath);
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

ipcMain.handle('dialog:openFile', async (event, opts = {}) => {
  const properties = ['openFile'];
  if (opts.multi) properties.push('multiSelections');
  const result = await dialog.showOpenDialog(mainWindow, { properties });
  if (result.canceled) return null;
  return opts.multi ? result.filePaths : result.filePaths[0];
});

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose download folder',
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openKey', async () => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select private key',
    defaultPath: fs.existsSync(sshDir) ? sshDir : os.homedir(),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Offer the private keys in ~/.ssh. A private key is any file with a matching
// .pub sibling, which catches non-standard names (solar_key, work_ed25519, …)
// that a fixed id_rsa/id_ed25519 list would miss. Standard names sort first.
ipcMain.handle('ssh:findKeys', () => {
  const sshDir = path.join(os.homedir(), '.ssh');
  const preferred = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];
  try {
    const entries = fs.readdirSync(sshDir);
    const pubs = new Set(entries.filter((f) => f.endsWith('.pub')).map((f) => f.slice(0, -4)));
    const keys = entries.filter((f) => {
      if (f.endsWith('.pub') || !pubs.has(f)) return false;
      try { return fs.statSync(path.join(sshDir, f)).isFile(); } catch { return false; }
    });
    keys.sort((a, b) => {
      const ai = preferred.indexOf(a), bi = preferred.indexOf(b);
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return a.localeCompare(b);
    });
    return keys.map((f) => path.join(sshDir, f));
  } catch {
    return [];
  }
});

ipcMain.handle('ssh:defaultUser', () => {
  try { return os.userInfo().username; } catch { return ''; }
});

// ── Clipboard image paste ──
// A screenshot or copied image lives on the OS clipboard as a bitmap, not a
// file, so a paste has to materialize one before it can be typed into the
// terminal or handed to SFTP.
const { clipboard } = require('electron');

ipcMain.handle('clipboard:readImage', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  const dir = path.join(os.tmpdir(), 'shelltab-paste');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paste-${Date.now()}.png`);
  fs.writeFileSync(file, img.toPNG());
  return { path: file };
});

// ── Saved hosts (passwords encrypted via OS keychain) ──

const hostsFile = path.join(app.getPath('userData'), 'saved-hosts.json');

function loadHosts() {
  try {
    if (!fs.existsSync(hostsFile)) return [];
    const raw = JSON.parse(fs.readFileSync(hostsFile, 'utf-8'));
    return raw.map((h) => {
      if (h.encryptedPassword) {
        if (h.safeStorageEncrypted && safeStorage.isEncryptionAvailable()) {
          try {
            h.password = safeStorage.decryptString(Buffer.from(h.encryptedPassword, 'base64'));
          } catch { h.password = ''; }
        } else if (!h.safeStorageEncrypted) {
          try {
            h.password = Buffer.from(h.encryptedPassword, 'base64').toString('utf-8');
          } catch { h.password = ''; }
        } else {
          h.password = '';
        }
      }
      delete h.encryptedPassword;
      delete h.safeStorageEncrypted;
      return h;
    });
  } catch { return []; }
}

function saveHosts(hosts) {
  const toStore = hosts.map((h) => {
    const entry = { ...h };
    if (entry.password && safeStorage.isEncryptionAvailable()) {
      try {
        entry.encryptedPassword = safeStorage.encryptString(entry.password).toString('base64');
        entry.safeStorageEncrypted = true;
      } catch {
        entry.encryptedPassword = Buffer.from(entry.password).toString('base64');
        entry.safeStorageEncrypted = false;
      }
    } else if (entry.password) {
      entry.encryptedPassword = Buffer.from(entry.password).toString('base64');
      entry.safeStorageEncrypted = false;
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
  try {
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
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('hosts:delete', (event, hostKey) => {
  const hosts = loadHosts().filter((h) => h.key !== hostKey);
  saveHosts(hosts);
  return { success: true };
});

// ── Quicklinks ──

const quicklinksFile = path.join(app.getPath('userData'), 'quicklinks.json');

function loadQuicklinks() {
  try {
    if (!fs.existsSync(quicklinksFile)) return [];
    const raw = JSON.parse(fs.readFileSync(quicklinksFile, 'utf-8'));
    return raw.map((q) => {
      if (q.encryptedPassword) {
        if (q.safeStorageEncrypted && safeStorage.isEncryptionAvailable()) {
          try {
            q.password = safeStorage.decryptString(Buffer.from(q.encryptedPassword, 'base64'));
          } catch { q.password = ''; }
        } else if (!q.safeStorageEncrypted) {
          try {
            q.password = Buffer.from(q.encryptedPassword, 'base64').toString('utf-8');
          } catch { q.password = ''; }
        } else {
          q.password = '';
        }
      }
      delete q.encryptedPassword;
      delete q.safeStorageEncrypted;
      return q;
    });
  } catch { return []; }
}

function saveQuicklinks(links) {
  const toStore = links.map((q) => {
    const entry = { ...q };
    if (entry.password && safeStorage.isEncryptionAvailable()) {
      try {
        entry.encryptedPassword = safeStorage.encryptString(entry.password).toString('base64');
        entry.safeStorageEncrypted = true;
      } catch {
        entry.encryptedPassword = Buffer.from(entry.password).toString('base64');
        entry.safeStorageEncrypted = false;
      }
    } else if (entry.password) {
      entry.encryptedPassword = Buffer.from(entry.password).toString('base64');
      entry.safeStorageEncrypted = false;
    }
    delete entry.password;
    return entry;
  });
  fs.writeFileSync(quicklinksFile, JSON.stringify(toStore, null, 2));
}

ipcMain.handle('quicklinks:list', () => loadQuicklinks());

ipcMain.handle('quicklinks:get', (event, id) => {
  return loadQuicklinks().find((q) => q.id === id) || null;
});

ipcMain.handle('quicklinks:save', (event, data) => {
  try {
    const links = loadQuicklinks();
    const id = data.id || `${data.type || 'ssh'}:${data.host}:${data.user || ''}:${Date.now()}`;
    const existing = links.findIndex((q) => q.id === id);
    const entry = { ...data, id };
    if (existing >= 0) {
      links[existing] = entry;
    } else {
      links.push(entry);
    }
    saveQuicklinks(links);
    return { success: true, id };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('quicklinks:delete', (event, id) => {
  const links = loadQuicklinks().filter((q) => q.id !== id);
  saveQuicklinks(links);
  return { success: true };
});

// ── App state persistence (memory) ──

const stateFile = path.join(app.getPath('userData'), 'app-state.json');

function loadAppState() {
  try {
    if (!fs.existsSync(stateFile)) return null;
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch { return null; }
}

function saveAppState(state) {
  try {
    const current = loadAppState() || {};
    const merged = { ...current, ...state };
    fs.writeFileSync(stateFile, JSON.stringify(merged, null, 2));
  } catch {}
}

ipcMain.handle('state:load', () => loadAppState());
ipcMain.handle('state:save', (event, state) => {
  saveAppState(state);
  return { success: true };
});
