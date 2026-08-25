// ── Remote update ──
// electron-updater, pointed at one of two feeds: the GitHub Releases named by
// the publish block in package.json, or any directory served over the LAN or
// Tailscale holding latest.yml + the installer. The chosen feed persists in
// update-source.json, so a machine with no path to github.com still updates.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null; // dependency missing — every call below degrades to a message
}

// Matches the build.publish block in package.json — the fallback when no
// local feed is configured.
const GITHUB_FEED = { provider: 'github', owner: 'tpawley2001', repo: 'shelltab' };

// A box that never reaches github.com can still update: point it at any
// directory served over the LAN or Tailscale that holds latest.yml plus the
// installer electron-builder wrote next to it.
const SOURCE_DEFAULTS = { mode: 'github', url: '' };

let getWindow = () => null;
let source = { ...SOURCE_DEFAULTS };
let state = { status: 'idle', version: app.getVersion() };

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

function applyFeed() {
  if (!autoUpdater) return;
  try {
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

function setSource(patch) {
  source = { ...source, ...patch };
  try {
    fs.writeFileSync(sourceFile(), JSON.stringify(source, null, 2));
  } catch {}
  applyFeed();
  send({ status: 'idle', message: '', source: getSource() });
  return getSource();
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
  ipcMain.handle('update:check', (event, opts) => check(opts || {}));
  ipcMain.handle('update:download', () => download());
  ipcMain.handle('update:install', () => install());

  loadSource();
  state = { ...state, source: getSource() };

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

module.exports = { register, check, download, install, getSource, setSource };
