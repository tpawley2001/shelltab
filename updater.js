// ── Remote update ──
// electron-updater, pointed at one of three feeds: the GitHub Releases named by
// the publish block in package.json, any directory served over the LAN or
// Tailscale holding latest.yml + the installer, or a plain folder / UNC share
// holding the same two files. The folder case needs no web server: ShellTab
// serves the directory to itself on a loopback port it picks, so nobody has to
// stand one up or remember a port number. The choice persists in
// update-source.json, so a machine with no path to github.com still updates.
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null; // dependency missing — every call below degrades to a message
}

// Matches the build.publish block in package.json — the fallback when no
// local feed is configured.
const GITHUB_FEED = { provider: 'github', owner: 'tpawley2001', repo: 'shelltab' };

// A box that never reaches github.com can still update: point it at a directory
// served over the LAN or Tailscale ('url'), or at a folder, mapped drive or
// \\server\share this machine can already read ('folder').
const SOURCE_DEFAULTS = { mode: 'github', url: '', folder: '' };

let getWindow = () => null;
let source = { ...SOURCE_DEFAULTS };
let state = { status: 'idle', version: app.getVersion() };

// ── Loopback feed for folder mode ──
// electron-updater only speaks HTTP, so a folder feed gets a one-directory
// static server bound to 127.0.0.1 on an ephemeral port.
let folderServer = null; // { server, port, dir }

// electron-builder writes 'ShellTab Setup x.y.z.exe' with spaces while
// latest.yml records the hyphenated name (or the other way round, depending on
// how the folder was filled). Locally we can just try both instead of 404ing.
function resolveAsset(dir, name) {
  const candidates = [name, name.replace(/-/g, ' '), name.replace(/ /g, '-')];
  for (const candidate of candidates) {
    const full = path.join(dir, candidate);
    // path.join collapses '..', so re-check the result really is inside dir.
    if (full !== dir && !full.startsWith(dir + path.sep)) continue;
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) return { full, stat };
    } catch {}
  }
  return null;
}

function serveFolder(dir) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let name;
    try {
      name = path.basename(decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const hit = resolveAsset(dir, name);
    if (!hit) {
      res.writeHead(404).end();
      return;
    }
    const total = hit.stat.size;
    // Range matters: electron-updater asks for the tail of the installer to
    // read its embedded signature block before downloading the whole thing.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = total - 1;
    let status = 200;
    if (range) {
      if (range[1] === '') {
        start = Math.max(0, total - Number(range[2] || 0));
      } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
      if (!(start <= end) || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      status = 206;
    }
    const headers = {
      'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(hit.full, { start, end }).on('error', () => res.destroy()).pipe(res);
  };
}

function stopFolderServer() {
  if (!folderServer) return;
  try {
    folderServer.server.close();
  } catch {}
  folderServer = null;
}

function startFolderServer(dir) {
  if (folderServer && folderServer.dir === dir) return Promise.resolve(folderServer.port);
  stopFolderServer();
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveFolder(dir));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      folderServer = { server, port: server.address().port, dir };
      resolve(folderServer.port);
    });
  });
}

function sourceFile() {
  return path.join(app.getPath('userData'), 'update-source.json');
}

function loadSource() {
  try {
    source = { ...SOURCE_DEFAULTS, ...JSON.parse(fs.readFileSync(sourceFile(), 'utf-8')) };
  } catch {
    source = { ...SOURCE_DEFAULTS };
  }
  return source;
}

async function applyFeed() {
  if (!autoUpdater) return;
  try {
    if (source.mode === 'folder' && source.folder) {
      const dir = path.resolve(source.folder);
      if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
      const port = await startFolderServer(dir);
      // The loopback server does not do the multi-range requests a differential
      // download needs, and a local copy is cheap to fetch whole anyway.
      autoUpdater.disableDifferentialDownload = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${port}/` });
      if (!resolveAsset(dir, 'latest.yml')) {
        send({ status: 'error', message: `No latest.yml in ${dir}.` });
      }
      return;
    }
    stopFolderServer();
    autoUpdater.disableDifferentialDownload = false;
    if (source.mode === 'url' && source.url) {
      // Trailing slash matters: electron-builder resolves latest.yml against it.
      const url = source.url.endsWith('/') ? source.url : `${source.url}/`;
      autoUpdater.setFeedURL({ provider: 'generic', url });
    } else {
      autoUpdater.setFeedURL(GITHUB_FEED);
    }
  } catch (err) {
    send({ status: 'error', message: `Bad update source: ${err.message}` });
  }
}

function getSource() {
  return { ...source };
}

async function setSource(patch) {
  source = { ...source, ...patch };
  try {
    fs.writeFileSync(sourceFile(), JSON.stringify(source, null, 2));
  } catch {}
  send({ status: 'idle', message: '', source: getSource() });
  await applyFeed();
  return getSource();
}

// Folder mode is only usable if picking a folder is easy, so the dialog lives
// here rather than making the user type a UNC path by hand.
async function browseFolder() {
  const win = getWindow();
  const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: 'Folder holding latest.yml and the installer',
    properties: ['openDirectory'],
    defaultPath: source.folder || undefined,
  });
  if (result.canceled || !result.filePaths.length) return getSource();
  return setSource({ mode: 'folder', folder: result.filePaths[0] });
}

function send(patch) {
  state = { ...state, ...patch, version: app.getVersion(), source: getSource() };
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
}

// In a dev checkout there is no app-update.yml, so a check throws rather than
// reporting "up to date". Say so instead of surfacing a confusing error.
function unavailable() {
  if (!autoUpdater) return 'Updater not installed in this build.';
  if (!app.isPackaged) return 'Updates only work in an installed build, not a dev run.';
  return null;
}

async function check({ silent = false } = {}) {
  const why = unavailable();
  if (why) {
    if (!silent) send({ status: 'unavailable', message: why });
    return state;
  }
  try {
    send({ status: 'checking', message: '' });
    const result = await autoUpdater.checkForUpdates();
    // 'update-available' / 'update-not-available' fire from the listeners below;
    // this only has to catch the throw.
    if (!result) send({ status: 'idle' });
  } catch (err) {
    send({ status: 'error', message: err.message });
  }
  return state;
}

async function download() {
  if (unavailable()) return state;
  try {
    send({ status: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    send({ status: 'error', message: err.message });
  }
  return state;
}

function install() {
  if (state.status !== 'downloaded') return state;
  // isSilent=false so the NSIS installer shows progress; isForceRunAfter=true
  // brings ShellTab back up once it finishes.
  autoUpdater.quitAndInstall(false, true);
  return state;
}

function register(windowGetter) {
  getWindow = windowGetter;

  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:source:get', () => getSource());
  ipcMain.handle('update:source:set', (event, patch) => setSource(patch || {}));
  ipcMain.handle('update:source:browse', () => browseFolder());
  ipcMain.handle('update:check', (event, opts) => check(opts || {}));
  ipcMain.handle('update:download', () => download());
  ipcMain.handle('update:install', () => install());

  loadSource();
  state = { ...state, source: getSource() };
  app.on('will-quit', stopFolderServer);

  if (!autoUpdater) return;

  // Downloading is a deliberate click, and installing is a deliberate restart.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    send({ status: 'available', latest: info.version, notes: info.releaseNotes || '' });
  });
  autoUpdater.on('update-not-available', () => send({ status: 'current', message: '' }));
  autoUpdater.on('download-progress', (p) => {
    send({ status: 'downloading', percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond });
  });
  autoUpdater.on('update-downloaded', (info) => {
    send({ status: 'downloaded', latest: info.version });
  });
  autoUpdater.on('error', (err) => send({ status: 'error', message: err?.message || String(err) }));

  applyFeed();

  // One quiet check a few seconds after launch, then every 6 hours, so a
  // long-lived window still notices a release.
  if (!unavailable()) {
    setTimeout(() => check({ silent: true }), 8000);
    setInterval(() => check({ silent: true }), 6 * 60 * 60 * 1000);
  }
}

module.exports = { register, check, download, install, getSource, setSource, browseFolder };
