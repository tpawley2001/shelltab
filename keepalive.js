// ── Keep-alive ──
// Two independent halves, because a session dies two different ways:
//   1. The Windows box sleeps or locks the screen out from under it. We hold a
//      powerSaveBlocker, which is the same thing a video player does while it
//      is playing — Windows sees the machine as busy and never idles out.
//   2. The far end drops an idle connection. SSH protocol keepalives cover
//      servers that count any traffic; anti-idle writes a harmless byte into
//      the session itself for servers that only count channel data.
const { app, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  enabled: true,
  keepAwake: true,
  // 'display' keeps the screen on too (video-player behaviour); 'system' lets
  // the monitor sleep but keeps the machine from suspending.
  awakeMode: 'display',
  sshInterval: 20,       // seconds between SSH keepalives; 0 disables
  antiIdle: false,
  antiIdleSeconds: 120,
};

// NUL: every shell ignores it and nothing echoes, so it is safe to inject
// into whatever happens to be running in the session.
const ANTI_IDLE_BYTE = '\u0000';

let settings = { ...DEFAULTS };
let blockerId = null;
let blockerType = null;
const listeners = new Set();

function settingsFile() {
  return path.join(app.getPath('userData'), 'keepalive.json');
}

function load() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
  return settings;
}

function persist() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {}
}

function blockerActive() {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

function syncBlocker() {
  const want = settings.enabled && settings.keepAwake;
  const type = settings.awakeMode === 'system' ? 'prevent-app-suspension' : 'prevent-display-sleep';

  // The blocker type is fixed at start(), so a mode change means restart it.
  if (blockerActive() && (!want || blockerType !== type)) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    blockerType = null;
  }
  if (want && !blockerActive()) {
    blockerId = powerSaveBlocker.start(type);
    blockerType = type;
  }
}

function get() {
  return { ...settings, awake: blockerActive() };
}

function set(patch) {
  settings = { ...settings, ...patch };
  persist();
  syncBlocker();
  for (const fn of listeners) {
    try { fn(settings); } catch {}
  }
  return get();
}

// sshmanager subscribes so live sessions pick up an anti-idle change without
// having to be reconnected.
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Effective SSH keepalive interval in ms, for ssh2's connect options.
function sshKeepaliveMs() {
  if (!settings.enabled) return 0;
  const secs = Number(settings.sshInterval) || 0;
  return secs > 0 ? secs * 1000 : 0;
}

function antiIdleMs() {
  if (!settings.enabled || !settings.antiIdle) return 0;
  const secs = Number(settings.antiIdleSeconds) || 0;
  return secs > 0 ? secs * 1000 : 0;
}

function register() {
  load();
  syncBlocker();

  ipcMain.handle('keepalive:get', () => get());
  ipcMain.handle('keepalive:set', (event, patch) => set(patch || {}));

  app.on('will-quit', () => {
    if (blockerActive()) powerSaveBlocker.stop(blockerId);
    blockerId = null;
    blockerType = null;
  });
}

module.exports = {
  register,
  get,
  set,
  subscribe,
  sshKeepaliveMs,
  antiIdleMs,
  ANTI_IDLE_BYTE,
  DEFAULTS,
};
