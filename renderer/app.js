const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const sftp = require('./sftp');

// ── State ──
const tabs = new Map();
let activeTabId = null;
let tabCounter = 0;
let ftpConnectionId = null;
let ftpCurrentPath = '/';
let lastConnectConfig = null;
const nudges = [];
let nudgeCounter = 0;

// ── DOM refs ──
const tabBar = document.getElementById('tab-bar');
const termContainer = document.getElementById('terminal-container');
const ftpPanel = document.getElementById('ftp-panel');
const nudgeModal = document.getElementById('nudge-modal');

// ── Terminal tabs ──

const TERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b70',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

const { READY_MARKER, SHELL_INTEGRATION } = require('./shellint');

// ── Transport: a tab is either a local pty or a native SSH session ──

function tabSend(tab, data) {
  if (tab.kind === 'ssh') {
    if (tab.sshId != null) window.api.sshInput(tab.sshId, data);
  } else if (tab.termId != null) {
    window.api.sendInput(tab.termId, data);
  }
}

function tabResize(tab, cols, rows) {
  if (tab.kind === 'ssh') {
    if (tab.sshId != null) window.api.sshResize(tab.sshId, cols, rows);
  } else if (tab.termId != null) {
    window.api.resizeTerminal(tab.termId, cols, rows);
  }
}

function tabClose(tab) {
  if (tab.kind === 'ssh') {
    if (tab.sshId != null) {
      window.api.sshClose(tab.sshId);
      sftp.remove(tab.sshId);
    }
  } else if (tab.termId != null) {
    window.api.killTerminal(tab.termId);
  }
}

// Swallow the shell-integration bootstrap so the user never sees it.
function tabWrite(tab, data) {
  const sup = tab.suppress;
  if (!sup) return tab.xterm.write(data);

  sup.buffer += data;
  const idx = sup.buffer.indexOf(READY_MARKER);
  if (idx !== -1) {
    const rest = sup.buffer.slice(idx + READY_MARKER.length);
    clearTimeout(sup.timer);
    tab.suppress = null;
    if (rest) tab.xterm.write(rest);
  } else if (sup.buffer.length > 8192) {
    flushSuppressed(tab);
  }
}

function flushSuppressed(tab) {
  const sup = tab.suppress;
  if (!sup) return;
  clearTimeout(sup.timer);
  tab.suppress = null;
  if (sup.buffer) tab.xterm.write(sup.buffer);
}

function findTab(kind, id) {
  for (const [, tab] of tabs) {
    if (kind === 'ssh' ? tab.sshId === id : tab.termId === id) return tab;
  }
  return null;
}

// ── Tab creation ──

async function createTab(opts = {}) {
  if (typeof opts === 'string') opts = { title: opts };
  const isSsh = opts.kind === 'ssh';
  const session = opts.session || null;

  tabCounter++;
  const tabId = tabCounter;
  const label = opts.title
    || (isSsh ? (session.label || `${session.user ? session.user + '@' : ''}${session.host}`) : `Terminal ${tabId}`);

  const xterm = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    scrollback: 10000,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    theme: TERM_THEME,
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());

  const wrapper = document.createElement('div');
  wrapper.className = 'term-wrapper';
  wrapper.dataset.tabId = tabId;
  termContainer.appendChild(wrapper);

  xterm.open(wrapper);
  fitAddon.fit();

  const tab = {
    tabId,
    kind: isSsh ? 'ssh' : 'local',
    xterm,
    fitAddon,
    wrapper,
    tabEl: null,
    label,
    session,
    sshId: null,
    termId: null,
    suppress: null,
  };
  tabs.set(tabId, tab);

  xterm.onData((data) => tabSend(tab, data));

  // The remote shell tells us where it is; keep the file browser in step.
  xterm.parser.registerOscHandler(7, (uri) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri);
    if (m && tab.sshId != null) {
      let dir = m[1];
      try { dir = decodeURIComponent(dir); } catch {}
      sftp.notifyCwd(tab.sshId, dir);
    }
    return true;
  });

  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Ctrl+Shift+C/V are the unambiguous terminal clipboard bindings; plain
    // Ctrl+C still reaches the remote as SIGINT unless there is a selection.
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
      if (xterm.hasSelection()) navigator.clipboard.writeText(xterm.getSelection());
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') {
      navigator.clipboard.readText().then((text) => text && tabSend(tab, text));
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
      navigator.clipboard.readText().then((text) => text && tabSend(tab, text));
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.key === 'c' && xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection());
      return false;
    }
    return true;
  });

  wrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection());
      xterm.clearSelection();
      showToast('Clipboard', 'Copied selection');
    } else {
      navigator.clipboard.readText().then((text) => text && tabSend(tab, text));
    }
  });

  const tabEl = document.createElement('div');
  tabEl.className = `tab ${tab.kind}`;
  tabEl.dataset.tabId = tabId;
  tabEl.innerHTML = `
    <span class="tab-kind">${isSsh ? 'SSH' : '&gt;_'}</span>
    <span class="tab-title">${escapeHtml(label)}</span>
    <span class="tab-close" title="Close tab">&times;</span>
  `;
  tabBar.appendChild(tabEl);
  tab.tabEl = tabEl;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) closeTab(tabId);
    else switchTab(tabId);
  });

  tabEl.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('tab-title')) return;
    const titleEl = e.target;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-rename';
    input.value = titleEl.textContent;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const finish = () => {
      const newTitle = input.value.trim() || label;
      const span = document.createElement('span');
      span.className = 'tab-title';
      span.textContent = newTitle;
      input.replaceWith(span);
      tab.label = newTitle;
      updateNudgeTargets();
      persistState();
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = label; input.blur(); }
    });
  });

  switchTab(tabId);
  updateNudgeTargets();

  if (isSsh) {
    xterm.write(`\x1b[90mConnecting to ${session.user ? session.user + '@' : ''}${session.host}:${session.port || 22}…\x1b[0m\r\n`);
    const res = await window.api.sshConnect({
      ...session,
      cols: xterm.cols,
      rows: xterm.rows,
    });

    if (res.error) {
      xterm.write(`\r\n\x1b[31mConnection failed: ${res.error}\x1b[0m\r\n`);
      tab.failed = true;
      persistState();
      return tabId;
    }

    tab.sshId = res.id;
    tabResize(tab, xterm.cols, xterm.rows);

    if (res.savedPassword && session.quicklinkId) {
      const link = await window.api.getQuicklink(session.quicklinkId);
      if (link) await window.api.saveQuicklink({ ...link, password: res.savedPassword });
    }

    if (session.shellIntegration !== false) {
      tab.suppress = { buffer: '', timer: setTimeout(() => flushSuppressed(tab), 4000) };
      setTimeout(() => tabSend(tab, SHELL_INTEGRATION), 300);
    }

    if (activeTabId === tabId) {
      sftp.show();
      sftp.setActive(tab.sshId, tab.label);
    }
  } else {
    const res = await window.api.createTerminal({ cols: xterm.cols, rows: xterm.rows });
    tab.termId = res.id;
    tabResize(tab, xterm.cols, xterm.rows);
  }

  persistState();
  return tabId;
}

function switchTab(tabId) {
  if (activeTabId === tabId) return;

  for (const [id, tab] of tabs) {
    tab.wrapper.classList.toggle('active', id === tabId);
    tab.tabEl.classList.toggle('active', id === tabId);
  }

  activeTabId = tabId;
  const tab = tabs.get(tabId);
  if (tab) {
    setTimeout(() => {
      tab.fitAddon.fit();
      tab.xterm.focus();
      tabResize(tab, tab.xterm.cols, tab.xterm.rows);
    }, 10);
    sftp.setActive(tab.kind === 'ssh' ? tab.sshId : null, tab.label);
  }
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  tabClose(tab);
  tab.xterm.dispose();
  tab.wrapper.remove();
  tab.tabEl.remove();
  tabs.delete(tabId);

  // Remove nudges targeting this tab
  for (let i = nudges.length - 1; i >= 0; i--) {
    if (nudges[i].targetTabId === tabId) {
      clearInterval(nudges[i].intervalHandle);
      nudges.splice(i, 1);
    }
  }
  renderNudgeList();
  updateNudgeTargets();
  persistState();

  if (activeTabId === tabId) {
    activeTabId = null;
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    }
  }
}

// ── Data from the backends ──
window.api.onTermData((termId, data) => {
  const tab = findTab('local', termId);
  if (tab) tabWrite(tab, data);
});

window.api.onTermExit((termId) => {
  const tab = findTab('local', termId);
  if (tab) {
    flushSuppressed(tab);
    tab.xterm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
  }
});

window.api.onSshData((sshId, data) => {
  const tab = findTab('ssh', sshId);
  if (tab) tabWrite(tab, data);
});

window.api.onSshExit((sshId) => {
  const tab = findTab('ssh', sshId);
  if (!tab) return;
  flushSuppressed(tab);
  tab.xterm.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
  tab.tabEl?.classList.add('disconnected');
  sftp.remove(sshId);
  tab.sshId = null;
});

window.api.onSshStatus((sshId, msg) => {
  const tab = findTab('ssh', sshId);
  if (tab) tab.xterm.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
});

// ── Resize handling ──
const resizeObserver = new ResizeObserver(() => {
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      tab.fitAddon.fit();
      tabResize(tab, tab.xterm.cols, tab.xterm.rows);
    }
  }
});
resizeObserver.observe(termContainer);

// Sidebars steal width from the terminal; refit after they open or close.
function refitActive() {
  setTimeout(() => {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    tab.fitAddon.fit();
    tabResize(tab, tab.xterm.cols, tab.xterm.rows);
  }, 50);
}

// ── Side panel resizing ──
// Both sidebars steal width from the terminal, so each gets a drag grip and a
// double-click escape hatch. Widths persist with the rest of the app state.

function initPanelResizer(panelId, resizerId, buttonId, defaultWidth) {
  const panel = document.getElementById(panelId);
  const grip = document.getElementById(resizerId);
  const button = document.getElementById(buttonId);
  const MIN = 220;
  // Always leave the terminal something usable, even on a narrow window.
  const maxWidth = () => Math.max(MIN, window.innerWidth - 360);

  let width = defaultWidth;

  function apply(px) {
    width = Math.round(Math.min(Math.max(px, MIN), maxWidth()));
    // #sftp-panel carries a CSS min-width that would otherwise win the clamp.
    panel.style.width = `${width}px`;
    panel.style.minWidth = `${width}px`;
    panel.style.maxWidth = `${width}px`;
    return width;
  }

  // The SFTP panel is opened and closed from inside sftp.js too, so watch the
  // class rather than trying to hook every call site.
  function syncVisibility() {
    const open = !panel.classList.contains('hidden');
    grip.classList.toggle('hidden', !open);
    if (button) button.classList.toggle('toggled', open);
  }
  new MutationObserver(syncVisibility).observe(panel, { attributes: true, attributeFilter: ['class'] });
  syncVisibility();

  let startX = 0;
  let startWidth = 0;

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    // Capture keeps the drag alive over the terminal; harmless if unsupported.
    try { grip.setPointerCapture(e.pointerId); } catch {}
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
  });

  grip.addEventListener('pointermove', (e) => {
    if (!grip.classList.contains('dragging')) return;
    // The terminal refits on its own — a ResizeObserver watches the container.
    apply(startWidth + (e.clientX - startX));
  });

  const endDrag = (e) => {
    if (!grip.classList.contains('dragging')) return;
    grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try { grip.releasePointerCapture(e.pointerId); } catch {}
    persistState();
    refitActive();
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  // Double-click the grip to get the panel out of the way entirely.
  grip.addEventListener('dblclick', () => {
    panel.classList.add('hidden');
    persistState();
    refitActive();
  });

  // A shrinking window can strand a panel wider than the terminal.
  window.addEventListener('resize', () => apply(width));

  return {
    restore: (px) => apply(px || defaultWidth),
    width: () => Math.round(panel.getBoundingClientRect().width) || width,
  };
}

const ftpResizer = initPanelResizer('ftp-panel', 'ftp-resizer', 'btn-ftp', 320);
const sftpResizer = initPanelResizer('sftp-panel', 'sftp-resizer', 'btn-sftp', 380);

// ── FTP Panel ──
document.getElementById('btn-ftp').addEventListener('click', () => {
  ftpPanel.classList.toggle('hidden');
  if (!ftpPanel.classList.contains('hidden')) {
    renderSavedHosts();
    prefillFtpFromSsh();
  }
  persistState();
  refitActive();
});

document.getElementById('ftp-close').addEventListener('click', () => {
  ftpPanel.classList.add('hidden');
  persistState();
  refitActive();
});

document.getElementById('ftp-connect-btn').addEventListener('click', async () => {
  const host = document.getElementById('ftp-host').value.trim();
  if (!host) return;

  const config = {
    host,
    port: parseInt(document.getElementById('ftp-port').value) || 21,
    user: document.getElementById('ftp-user').value || 'anonymous',
    password: document.getElementById('ftp-pass').value || '',
    secure: document.getElementById('ftp-secure').checked,
  };

  const statusEl = document.getElementById('ftp-status');
  statusEl.textContent = 'Connecting...';

  const result = await window.api.ftpConnect(config);

  if (result.status === 'connected') {
    ftpConnectionId = result.id;
    lastConnectConfig = config;
    statusEl.textContent = `Connected to ${host}`;
    statusEl.style.color = 'var(--green)';
    document.getElementById('ftp-connect-btn').classList.add('hidden');
    document.getElementById('ftp-disconnect-btn').classList.remove('hidden');
    document.getElementById('ftp-path-bar').classList.remove('hidden');
    document.getElementById('ftp-file-list').classList.remove('hidden');
    document.getElementById('ftp-actions').classList.remove('hidden');
    document.getElementById('ftp-saved-hosts').classList.add('hidden');
    ftpNavigate('/');

    const key = `${config.host}:${config.port}:${config.user}`;
    const existing = await window.api.getHost(key);
    if (!existing && config.password) {
      document.getElementById('ftp-save-prompt').classList.remove('hidden');
    } else {
      document.getElementById('ftp-save-prompt').classList.add('hidden');
    }
  } else {
    statusEl.textContent = `Error: ${result.message}`;
    statusEl.style.color = 'var(--red)';
  }
});

document.getElementById('ftp-save-yes').addEventListener('click', async () => {
  if (lastConnectConfig) {
    await window.api.saveHost(lastConnectConfig);
    showToast('Host Saved', `${lastConnectConfig.host} saved to known hosts`);
    renderSavedHosts();
  }
  document.getElementById('ftp-save-prompt').classList.add('hidden');
});

document.getElementById('ftp-save-no').addEventListener('click', () => {
  document.getElementById('ftp-save-prompt').classList.add('hidden');
});

document.getElementById('ftp-disconnect-btn').addEventListener('click', async () => {
  if (ftpConnectionId) {
    await window.api.ftpDisconnect(ftpConnectionId);
    ftpConnectionId = null;
  }
  lastConnectConfig = null;
  document.getElementById('ftp-status').textContent = 'Disconnected';
  document.getElementById('ftp-status').style.color = 'var(--text-dim)';
  document.getElementById('ftp-connect-btn').classList.remove('hidden');
  document.getElementById('ftp-disconnect-btn').classList.add('hidden');
  document.getElementById('ftp-path-bar').classList.add('hidden');
  document.getElementById('ftp-file-list').classList.add('hidden');
  document.getElementById('ftp-actions').classList.add('hidden');
  document.getElementById('ftp-save-prompt').classList.add('hidden');
  document.getElementById('ftp-saved-hosts').classList.remove('hidden');
  renderSavedHosts();
});

async function ftpNavigate(remotePath) {
  if (!ftpConnectionId) return;
  ftpCurrentPath = remotePath;
  document.getElementById('ftp-cwd').textContent = remotePath;

  const items = await window.api.ftpList(ftpConnectionId, remotePath);
  const listEl = document.getElementById('ftp-file-list');
  listEl.innerHTML = '';

  if (items.error) {
    listEl.innerHTML = `<div style="padding:8px 12px;color:var(--red);font-size:12px">${items.error}</div>`;
    return;
  }

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    const el = document.createElement('div');
    el.className = `ftp-item ${item.type}`;
    const icon = item.type === 'dir' ? '📁' : '📄';
    const size = item.type === 'file' ? formatSize(item.size) : '';
    el.innerHTML = `
      <span class="ftp-icon">${icon}</span>
      <span class="ftp-name">${item.name}</span>
      <span class="ftp-size">${size}</span>
      <button class="ftp-delete" title="Delete">&times;</button>
    `;

    if (item.type === 'dir') {
      el.addEventListener('dblclick', () => {
        const newPath = ftpCurrentPath === '/'
          ? `/${item.name}`
          : `${ftpCurrentPath}/${item.name}`;
        ftpNavigate(newPath);
      });
    } else {
      el.addEventListener('dblclick', async () => {
        const localPath = await window.api.saveFileDialog(item.name);
        if (localPath) {
          const remoteFull = ftpCurrentPath === '/'
            ? `/${item.name}`
            : `${ftpCurrentPath}/${item.name}`;
          const result = await window.api.ftpDownload(ftpConnectionId, remoteFull, localPath);
          if (result.error) {
            showToast('FTP Error', result.error);
          } else {
            showToast('Download Complete', `Saved to ${localPath}`);
          }
        }
      });
    }

    el.querySelector('.ftp-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const remoteFull = ftpCurrentPath === '/'
        ? `/${item.name}`
        : `${ftpCurrentPath}/${item.name}`;
      if (confirm(`Delete ${item.name}?`)) {
        const result = await window.api.ftpDelete(ftpConnectionId, remoteFull);
        if (result.error) {
          showToast('FTP Error', result.error);
        } else {
          ftpNavigate(ftpCurrentPath);
        }
      }
    });

    listEl.appendChild(el);
  }
}

document.getElementById('ftp-up').addEventListener('click', () => {
  if (ftpCurrentPath === '/') return;
  const parts = ftpCurrentPath.split('/').filter(Boolean);
  parts.pop();
  ftpNavigate('/' + parts.join('/'));
});

document.getElementById('ftp-refresh').addEventListener('click', () => {
  ftpNavigate(ftpCurrentPath);
});

document.getElementById('ftp-upload-btn').addEventListener('click', async () => {
  const localPath = await window.api.openFileDialog();
  if (!localPath) return;
  const fileName = localPath.split('/').pop().split('\\').pop();
  const remoteFull = ftpCurrentPath === '/'
    ? `/${fileName}`
    : `${ftpCurrentPath}/${fileName}`;
  const result = await window.api.ftpUpload(ftpConnectionId, localPath, remoteFull);
  if (result.error) {
    showToast('FTP Error', result.error);
  } else {
    showToast('Upload Complete', fileName);
    ftpNavigate(ftpCurrentPath);
  }
});

document.getElementById('ftp-mkdir-btn').addEventListener('click', async () => {
  const name = prompt('Folder name:');
  if (!name) return;
  const remoteFull = ftpCurrentPath === '/'
    ? `/${name}`
    : `${ftpCurrentPath}/${name}`;
  const result = await window.api.ftpMkdir(ftpConnectionId, remoteFull);
  if (result.error) {
    showToast('FTP Error', result.error);
  } else {
    ftpNavigate(ftpCurrentPath);
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

// ── Saved Hosts ──

async function renderSavedHosts() {
  const listEl = document.getElementById('ftp-saved-list');
  const hosts = await window.api.listHosts();
  listEl.innerHTML = '';

  if (hosts.length === 0) {
    listEl.innerHTML = '<div style="padding:4px 12px 8px;color:var(--text-dim);font-size:11px">No saved hosts</div>';
    return;
  }

  for (const host of hosts) {
    const el = document.createElement('div');
    el.className = 'saved-host-item';
    el.innerHTML = `
      <span class="saved-host-icon">&#9679;</span>
      <div class="saved-host-info">
        <div class="saved-host-name">${escapeHtml(host.host)}</div>
        <div class="saved-host-detail">${escapeHtml(host.user || 'anonymous')}:${host.port || 21}${host.secure ? ' (FTPS)' : ''}${host.hasPassword ? ' • password saved' : ''}</div>
      </div>
      <button class="saved-host-delete" title="Remove">&times;</button>
    `;

    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('saved-host-delete')) return;
      const full = await window.api.getHost(host.key);
      if (!full) return;
      document.getElementById('ftp-host').value = full.host;
      document.getElementById('ftp-port').value = full.port || 21;
      document.getElementById('ftp-user').value = full.user || '';
      document.getElementById('ftp-pass').value = full.password || '';
      document.getElementById('ftp-secure').checked = !!full.secure;
      document.getElementById('ftp-connect-btn').click();
    });

    el.querySelector('.saved-host-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.deleteHost(host.key);
      renderSavedHosts();
    });

    listEl.appendChild(el);
  }
}

// ── FTP prefill from the active SSH session ──
// The old build screen-scraped the terminal for `ssh user@host` and then
// recorded the user's keystrokes to steal the password. Native SSH means we
// simply know who we are connected to.

function prefillFtpFromSsh() {
  if (ftpConnectionId) return;
  const tab = tabs.get(activeTabId);
  if (tab?.kind !== 'ssh' || !tab.session) return;
  document.getElementById('ftp-host').value = tab.session.host;
  if (tab.session.user) document.getElementById('ftp-user').value = tab.session.user;
}

// ── Save Connection Dialog ──

const saveConnModal = document.getElementById('save-conn-modal');

function showSaveConnectionDialog(type, host, user, password, command) {
  const typeEl = document.getElementById('save-conn-type');
  typeEl.value = type || 'ssh';
  document.getElementById('save-conn-host').value = host || '';
  document.getElementById('save-conn-port').value = type === 'ftp' ? 21 : 22;
  document.getElementById('save-conn-user').value = user || '';
  document.getElementById('save-conn-pass').value = password || '';
  document.getElementById('save-conn-command').value = command || '';
  document.getElementById('save-conn-label').value = '';
  toggleSaveConnFields(type || 'ssh');
  saveConnModal.classList.remove('hidden');
  document.getElementById('save-conn-label').focus();
}

function toggleSaveConnFields(type) {
  const isCmd = type === 'command';
  document.getElementById('save-conn-row').querySelector('input[type="text"]').classList.toggle('hidden', isCmd);
  document.getElementById('save-conn-port').classList.toggle('hidden', isCmd);
  document.getElementById('save-conn-user').classList.toggle('hidden', isCmd);
  document.getElementById('save-conn-pass').classList.toggle('hidden', isCmd);
  document.getElementById('save-conn-command').classList.toggle('hidden', !isCmd);
  if (!isCmd) {
    document.getElementById('save-conn-port').value = type === 'ftp' ? 21 : 22;
  }
}

document.getElementById('save-conn-type').addEventListener('change', (e) => {
  toggleSaveConnFields(e.target.value);
});

document.getElementById('save-conn-save').addEventListener('click', async () => {
  const type = document.getElementById('save-conn-type').value;
  if (type === 'command') {
    const command = document.getElementById('save-conn-command').value.trim();
    if (!command) return;
    const data = {
      type: 'command',
      label: document.getElementById('save-conn-label').value.trim() || command,
      command,
    };
    await window.api.saveQuicklink(data);
    saveConnModal.classList.add('hidden');
    showToast('Saved', `${data.label} added to Quicklinks`);
    renderQuicklinks();
    return;
  }
  const host = document.getElementById('save-conn-host').value.trim();
  if (!host) return;
  const data = {
    type,
    label: document.getElementById('save-conn-label').value.trim() || host,
    host,
    port: parseInt(document.getElementById('save-conn-port').value) || 22,
    user: document.getElementById('save-conn-user').value.trim(),
    password: document.getElementById('save-conn-pass').value,
  };
  await window.api.saveQuicklink(data);
  saveConnModal.classList.add('hidden');
  showToast('Saved', `${data.label} added to Quicklinks`);
  renderQuicklinks();
});

document.getElementById('save-conn-cancel').addEventListener('click', () => {
  saveConnModal.classList.add('hidden');
});

document.getElementById('save-conn-close').addEventListener('click', () => {
  saveConnModal.classList.add('hidden');
});

saveConnModal.addEventListener('click', (e) => {
  if (e.target === saveConnModal) saveConnModal.classList.add('hidden');
});

// ── Quicklinks Dropdown ──

const qlDropdown = document.getElementById('quicklinks-dropdown');

document.getElementById('btn-quicklinks').addEventListener('click', (e) => {
  e.stopPropagation();
  qlDropdown.classList.toggle('hidden');
  if (!qlDropdown.classList.contains('hidden')) {
    renderQuicklinks();
  }
});

document.addEventListener('click', (e) => {
  if (!qlDropdown.classList.contains('hidden') && !qlDropdown.contains(e.target)) {
    qlDropdown.classList.add('hidden');
  }
});

document.getElementById('quicklinks-add-ssh').addEventListener('click', () => {
  qlDropdown.classList.add('hidden');
  openSshModal();
});

document.getElementById('quicklinks-add-other').addEventListener('click', () => {
  qlDropdown.classList.add('hidden');
  showSaveConnectionDialog('ftp', '', '', '');
});

async function renderQuicklinks() {
  const listEl = document.getElementById('quicklinks-list');
  const links = await window.api.listQuicklinks();
  listEl.innerHTML = '';

  for (const link of links) {
    const el = document.createElement('div');
    el.className = 'ql-item';
    const type = link.type || 'ssh';
    const typeTag = type === 'command' ? '&gt;_' : type.toUpperCase();
    const detail = type === 'command'
      ? escapeHtml(link.command || '')
      : `${escapeHtml(link.user || '')}@${escapeHtml(link.host)}:${link.port || 22}`;
    el.innerHTML = `
      <span class="ql-icon ${type === 'command' ? 'ql-icon-cmd' : ''}">${typeTag}</span>
      <div class="ql-info">
        <div class="ql-label">${escapeHtml(link.label || link.command || link.host)}</div>
        <div class="ql-detail">${detail}</div>
      </div>
      <button class="ql-delete" title="Remove">&times;</button>
    `;

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('ql-delete')) return;
      qlDropdown.classList.add('hidden');
      connectQuicklink(link);
    });

    el.querySelector('.ql-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.deleteQuicklink(link.id);
      renderQuicklinks();
    });

    listEl.appendChild(el);
  }
}

async function connectQuicklink(link) {
  if (link.type === 'ftp') {
    ftpPanel.classList.remove('hidden');
    document.getElementById('ftp-host').value = link.host;
    document.getElementById('ftp-port').value = link.port || 21;
    document.getElementById('ftp-user').value = link.user || '';
    document.getElementById('ftp-pass').value = link.password || '';
    document.getElementById('ftp-secure').checked = !!link.secure;
    persistState();
    refitActive();
    document.getElementById('ftp-connect-btn').click();
    return;
  }

  if (link.type === 'command') {
    const tabId = await createTab({ title: link.label || link.command });
    const tab = tabs.get(tabId);
    if (tab) setTimeout(() => tabSend(tab, link.command + '\n'), 500);
    return;
  }

  // SSH — a real session, not a shell that gets `ssh` typed into it.
  await createTab({
    kind: 'ssh',
    title: link.label || link.host,
    session: {
      host: link.host,
      port: link.port || 22,
      user: link.user,
      password: link.password || null,
      privateKeyPath: link.privateKeyPath || null,
      passphrase: link.passphrase || null,
      useAgent: link.auth === 'agent' || (!link.password && !link.privateKeyPath),
      shellIntegration: link.shellIntegration !== false,
      label: link.label,
      quicklinkId: link.id,
    },
  });
}

// ── New SSH session dialog ──

const sshModal = document.getElementById('ssh-modal');

function syncSshAuthFields() {
  const mode = document.getElementById('ssh-auth').value;
  document.getElementById('ssh-pass').classList.toggle('hidden', mode !== 'password');
  document.getElementById('ssh-key-row').classList.toggle('hidden', mode !== 'key');
  document.getElementById('ssh-passphrase').classList.toggle('hidden', mode !== 'key');
}

async function openSshModal() {
  document.getElementById('ssh-modal-error').textContent = '';
  document.getElementById('ssh-host').value = '';
  document.getElementById('ssh-port').value = 22;
  document.getElementById('ssh-pass').value = '';
  document.getElementById('ssh-passphrase').value = '';
  document.getElementById('ssh-label').value = '';
  document.getElementById('ssh-save').checked = false;
  document.getElementById('ssh-label').classList.add('hidden');
  document.getElementById('ssh-shellint').checked = true;

  const userEl = document.getElementById('ssh-user');
  if (!userEl.value) userEl.value = await window.api.sshDefaultUser();

  const keyEl = document.getElementById('ssh-key');
  const keys = await window.api.sshFindKeys();
  const datalist = document.getElementById('ssh-key-list');
  datalist.innerHTML = '';
  for (const k of keys) {
    const opt = document.createElement('option');
    opt.value = k;
    datalist.appendChild(opt);
  }
  if (!keyEl.value && keys.length) keyEl.value = keys[0];

  syncSshAuthFields();
  sshModal.classList.remove('hidden');
  document.getElementById('ssh-host').focus();
}

document.getElementById('ssh-auth').addEventListener('change', syncSshAuthFields);

document.getElementById('ssh-save').addEventListener('change', (e) => {
  document.getElementById('ssh-label').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('ssh-key-browse').addEventListener('click', async () => {
  const p = await window.api.openKeyDialog();
  if (p) document.getElementById('ssh-key').value = p;
});

function closeSshModal() {
  sshModal.classList.add('hidden');
}

document.getElementById('ssh-modal-close').addEventListener('click', closeSshModal);
document.getElementById('ssh-cancel-btn').addEventListener('click', closeSshModal);
sshModal.addEventListener('click', (e) => { if (e.target === sshModal) closeSshModal(); });

async function submitSshModal() {
  const host = document.getElementById('ssh-host').value.trim();
  if (!host) {
    document.getElementById('ssh-modal-error').textContent = 'A host is required.';
    return;
  }

  const mode = document.getElementById('ssh-auth').value;
  const session = {
    host,
    port: parseInt(document.getElementById('ssh-port').value, 10) || 22,
    user: document.getElementById('ssh-user').value.trim(),
    password: mode === 'password' ? (document.getElementById('ssh-pass').value || null) : null,
    privateKeyPath: mode === 'key' ? (document.getElementById('ssh-key').value.trim() || null) : null,
    passphrase: mode === 'key' ? (document.getElementById('ssh-passphrase').value || null) : null,
    useAgent: mode === 'agent',
    shellIntegration: document.getElementById('ssh-shellint').checked,
  };

  if (document.getElementById('ssh-save').checked) {
    const label = document.getElementById('ssh-label').value.trim()
      || `${session.user ? session.user + '@' : ''}${host}`;
    const saved = await window.api.saveQuicklink({
      type: 'ssh',
      label,
      host: session.host,
      port: session.port,
      user: session.user,
      password: session.password || '',
      privateKeyPath: session.privateKeyPath || '',
      auth: mode,
      shellIntegration: session.shellIntegration,
    });
    session.label = label;
    session.quicklinkId = saved.id;
    renderQuicklinks();
  }

  closeSshModal();
  await createTab({ kind: 'ssh', session });
}

document.getElementById('ssh-connect-btn').addEventListener('click', submitSshModal);
sshModal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitSshModal();
  if (e.key === 'Escape') closeSshModal();
});

// ── Interactive auth prompts (password, key passphrase, 2FA) ──

const sshPromptModal = document.getElementById('ssh-prompt-modal');
let activePromptId = null;

function closeSshPrompt(answers) {
  if (activePromptId == null) return;
  window.api.sshPromptReply(activePromptId, answers);
  activePromptId = null;
  sshPromptModal.classList.add('hidden');
  document.getElementById('ssh-prompt-fields').innerHTML = '';
}

window.api.onSshPrompt((id, payload) => {
  activePromptId = id;
  document.getElementById('ssh-prompt-title').textContent = payload.title || 'Authentication';
  document.getElementById('ssh-prompt-host').textContent = payload.host || '';
  const instr = document.getElementById('ssh-prompt-instructions');
  instr.textContent = payload.instructions || '';
  instr.classList.toggle('hidden', !payload.instructions);

  const fieldsEl = document.getElementById('ssh-prompt-fields');
  fieldsEl.innerHTML = '';
  (payload.fields || []).forEach((f, i) => {
    const wrap = document.createElement('label');
    wrap.className = 'prompt-field';
    const span = document.createElement('span');
    span.textContent = (f.label || '').replace(/:\s*$/, '');
    const input = document.createElement('input');
    input.type = f.secret ? 'password' : 'text';
    input.dataset.index = i;
    wrap.appendChild(span);
    wrap.appendChild(input);
    fieldsEl.appendChild(wrap);
  });

  document.getElementById('ssh-prompt-save-wrap').classList.toggle('hidden', !payload.offerSave);
  document.getElementById('ssh-prompt-save').checked = false;

  sshPromptModal.classList.remove('hidden');
  fieldsEl.querySelector('input')?.focus();
});

function submitSshPrompt() {
  const inputs = [...document.getElementById('ssh-prompt-fields').querySelectorAll('input')];
  closeSshPrompt({
    answers: inputs.map((i) => i.value),
    save: document.getElementById('ssh-prompt-save').checked,
  });
}

document.getElementById('ssh-prompt-ok').addEventListener('click', submitSshPrompt);
document.getElementById('ssh-prompt-cancel').addEventListener('click', () => closeSshPrompt(null));
sshPromptModal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitSshPrompt();
  if (e.key === 'Escape') closeSshPrompt(null);
});

// ── Nudge Manager ──
document.getElementById('btn-nudges').addEventListener('click', () => {
  nudgeModal.classList.remove('hidden');
  updateNudgeTargets();
  renderNudgeList();
});

document.getElementById('nudge-close').addEventListener('click', () => {
  nudgeModal.classList.add('hidden');
});

nudgeModal.addEventListener('click', (e) => {
  if (e.target === nudgeModal) nudgeModal.classList.add('hidden');
});

function updateNudgeTargets() {
  const select = document.getElementById('nudge-target');
  const currentVal = select.value;
  select.innerHTML = '<option value="active">Active tab</option>';
  for (const [id, tab] of tabs) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = tab.label;
    select.appendChild(opt);
  }
  if ([...select.options].some(o => o.value === currentVal)) {
    select.value = currentVal;
  }
}

document.getElementById('nudge-add-btn').addEventListener('click', () => {
  const text = document.getElementById('nudge-text').value.trim();
  if (!text) return;

  const interval = parseInt(document.getElementById('nudge-interval').value) || 60;
  const type = document.getElementById('nudge-type').value;
  const targetVal = document.getElementById('nudge-target').value;
  const appendNewline = document.getElementById('nudge-newline').checked;

  nudgeCounter++;
  const nudge = {
    id: nudgeCounter,
    text,
    interval,
    type,
    targetTabId: targetVal === 'active' ? null : parseInt(targetVal),
    appendNewline,
    active: true,
    intervalHandle: null,
  };

  nudge.intervalHandle = setInterval(() => {
    if (!nudge.active) return;
    executeNudge(nudge);
  }, interval * 1000);

  nudges.push(nudge);
  document.getElementById('nudge-text').value = '';
  renderNudgeList();
});

function executeNudge(nudge) {
  const targetId = nudge.targetTabId || activeTabId;
  if (!targetId) return;

  if (nudge.type === 'terminal') {
    const tab = tabs.get(targetId);
    if (tab) tabSend(tab, nudge.appendNewline ? nudge.text + '\n' : nudge.text);
  } else {
    const tabLabel = nudge.targetTabId
      ? (tabs.get(nudge.targetTabId)?.label || 'Unknown')
      : 'Active tab';
    showToast(`Nudge [${tabLabel}]`, nudge.text);
  }
}

function renderNudgeList() {
  const container = document.getElementById('nudge-items');
  container.innerHTML = '';

  if (nudges.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:4px 0">No nudges configured</div>';
    return;
  }

  for (const nudge of nudges) {
    const el = document.createElement('div');
    el.className = 'nudge-item';
    const targetLabel = nudge.targetTabId
      ? (tabs.get(nudge.targetTabId)?.label || `Tab ${nudge.targetTabId}`)
      : 'Active tab';
    const typeLabel = nudge.type === 'terminal' ? 'Terminal input' : 'Notification';

    el.innerHTML = `
      <div class="nudge-info">
        <div class="nudge-label">${escapeHtml(nudge.text)}</div>
        <div class="nudge-meta">${typeLabel} | Every ${nudge.interval}s | ${targetLabel}</div>
      </div>
      <button class="nudge-toggle ${nudge.active ? '' : 'paused'}">${nudge.active ? 'Pause' : 'Resume'}</button>
      <button class="nudge-remove" title="Remove">&times;</button>
    `;

    el.querySelector('.nudge-toggle').addEventListener('click', () => {
      nudge.active = !nudge.active;
      renderNudgeList();
    });

    el.querySelector('.nudge-remove').addEventListener('click', () => {
      clearInterval(nudge.intervalHandle);
      const idx = nudges.indexOf(nudge);
      if (idx !== -1) nudges.splice(idx, 1);
      renderNudgeList();
    });

    container.appendChild(el);
  }
}

// ── Toasts ──
function showToast(title, message) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${escapeHtml(message)}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── State persistence ──

function persistState() {
  const tabState = [];
  for (const [, tab] of tabs) {
    if (tab.restoreSession) {
      tabState.push({ kind: 'ssh', label: tab.label, session: tab.restoreSession });
    } else if (tab.kind === 'ssh') {
      tabState.push({
        kind: 'ssh',
        label: tab.label,
        session: {
          host: tab.session.host,
          port: tab.session.port,
          user: tab.session.user,
          privateKeyPath: tab.session.privateKeyPath || null,
          useAgent: !!tab.session.useAgent,
          shellIntegration: tab.session.shellIntegration !== false,
          quicklinkId: tab.session.quicklinkId || null,
          label: tab.session.label || null,
        },
      });
    } else {
      tabState.push({ kind: 'local', label: tab.label });
    }
  }
  window.api.saveState({
    tabs: tabState,
    ftpPanelOpen: !ftpPanel.classList.contains('hidden'),
    sftpPanelOpen: sftp.isOpen(),
    ftpPanelWidth: ftpResizer.width(),
    sftpPanelWidth: sftpResizer.width(),
  });
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift so plain Ctrl+T / Ctrl+W still reach the remote shell.
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    createTab();
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    openSshModal();
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    sftp.toggle();
    refitActive();
  }
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const ids = [...tabs.keys()];
    const target = ids[parseInt(e.key, 10) - 1];
    if (target != null) {
      e.preventDefault();
      switchTab(target);
    }
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = [...tabs.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeTabId);
    const next = e.shiftKey
      ? ids[(idx - 1 + ids.length) % ids.length]
      : ids[(idx + 1) % ids.length];
    switchTab(next);
  }
});

// ── Toolbar ──
document.getElementById('btn-new-tab').addEventListener('click', () => createTab());
document.getElementById('btn-new-ssh').addEventListener('click', openSshModal);
document.getElementById('btn-sftp').addEventListener('click', () => {
  sftp.toggle();
  refitActive();
  persistState();
});

// ── Keep-alive ──
// The toolbar button doubles as the indicator: lit means something is being
// held open (the PC awake, or an anti-idle drip on live sessions).

const keepAliveModal = document.getElementById('keepalive-modal');
const kaBtn = document.getElementById('btn-keepalive');
const kaEls = {
  enabled: document.getElementById('ka-enabled'),
  awake: document.getElementById('ka-awake'),
  mode: document.getElementById('ka-mode'),
  awakeState: document.getElementById('ka-awake-state'),
  sshInterval: document.getElementById('ka-ssh-interval'),
  antiIdle: document.getElementById('ka-antiidle'),
  antiIdleSecs: document.getElementById('ka-antiidle-secs'),
};

function renderKeepAlive(s) {
  if (!s) return;
  kaEls.enabled.checked = !!s.enabled;
  kaEls.awake.checked = !!s.keepAwake;
  kaEls.mode.value = s.awakeMode || 'display';
  kaEls.sshInterval.value = s.sshInterval ?? 20;
  kaEls.antiIdle.checked = !!s.antiIdle;
  kaEls.antiIdleSecs.value = s.antiIdleSeconds ?? 120;

  for (const group of keepAliveModal.querySelectorAll('.ka-group')) {
    group.classList.toggle('disabled', !s.enabled);
  }
  kaEls.awakeState.textContent = s.awake
    ? 'Holding — this PC will not sleep or lock on idle.'
    : 'Not holding — Windows idle timers apply as normal.';
  kaEls.awakeState.classList.toggle('holding', !!s.awake);

  kaBtn.classList.toggle('toggled', !!s.enabled && (!!s.awake || !!s.antiIdle));
  kaBtn.title = s.enabled
    ? `Keep-alive on${s.awake ? ' — PC held awake' : ''}${s.antiIdle ? ` — anti-idle every ${s.antiIdleSeconds}s` : ''}`
    : 'Keep-alive off';
}

async function patchKeepAlive(patch) {
  renderKeepAlive(await window.api.keepAliveSet(patch));
}

kaBtn.addEventListener('click', async () => {
  renderKeepAlive(await window.api.keepAliveGet());
  keepAliveModal.classList.remove('hidden');
});

const closeKeepAlive = () => keepAliveModal.classList.add('hidden');
document.getElementById('keepalive-close').addEventListener('click', closeKeepAlive);
document.getElementById('keepalive-done').addEventListener('click', closeKeepAlive);
keepAliveModal.addEventListener('click', (e) => {
  if (e.target === keepAliveModal) closeKeepAlive();
});

kaEls.enabled.addEventListener('change', () => patchKeepAlive({ enabled: kaEls.enabled.checked }));
kaEls.awake.addEventListener('change', () => patchKeepAlive({ keepAwake: kaEls.awake.checked }));
kaEls.mode.addEventListener('change', () => patchKeepAlive({ awakeMode: kaEls.mode.value }));
kaEls.antiIdle.addEventListener('change', () => patchKeepAlive({ antiIdle: kaEls.antiIdle.checked }));
kaEls.sshInterval.addEventListener('change', () => {
  patchKeepAlive({ sshInterval: Math.max(0, parseInt(kaEls.sshInterval.value, 10) || 0) });
});
kaEls.antiIdleSecs.addEventListener('change', () => {
  patchKeepAlive({ antiIdleSeconds: Math.max(10, parseInt(kaEls.antiIdleSecs.value, 10) || 120) });
});

// ── Remote update ──

const updateModal = document.getElementById('update-modal');
const updBtn = document.getElementById('btn-update');
const updEls = {
  version: document.getElementById('update-version'),
  status: document.getElementById('update-status'),
  progress: document.getElementById('update-progress'),
  fill: document.getElementById('update-bar-fill'),
  source: document.getElementById('update-source'),
  url: document.getElementById('update-url'),
  urlHint: document.getElementById('update-url-hint'),
  check: document.getElementById('update-check-btn'),
  download: document.getElementById('update-download-btn'),
  install: document.getElementById('update-install-btn'),
};
let lastUpdateStatus = null;

function renderUpdateSource(src) {
  if (!src) return;
  updEls.source.value = src.mode || 'github';
  updEls.url.value = src.url || '';
  const custom = updEls.source.value === 'url';
  updEls.url.classList.toggle('hidden', !custom);
  updEls.urlHint.classList.toggle('hidden', !custom);
}

function renderUpdate(state) {
  if (!state) return;
  renderUpdateSource(state.source);
  updEls.version.textContent = `Installed version ${state.version}`;
  updEls.progress.classList.add('hidden');
  updEls.download.classList.add('hidden');
  updEls.install.classList.add('hidden');
  updEls.check.disabled = state.status === 'checking' || state.status === 'downloading';
  updEls.status.className = '';

  switch (state.status) {
    case 'checking':
      updEls.status.textContent = 'Checking for updates…';
      break;
    case 'current':
      updEls.status.textContent = 'ShellTab is up to date.';
      updEls.status.className = 'ok';
      break;
    case 'available':
      updEls.status.textContent = `Version ${state.latest} is available.`;
      updEls.download.classList.remove('hidden');
      break;
    case 'downloading':
      updEls.status.textContent = `Downloading ${state.latest || ''}… ${state.percent || 0}%`;
      updEls.progress.classList.remove('hidden');
      updEls.fill.style.width = `${state.percent || 0}%`;
      break;
    case 'downloaded':
      updEls.status.textContent = `Version ${state.latest} is ready. ShellTab will restart to finish.`;
      updEls.status.className = 'ok';
      updEls.install.classList.remove('hidden');
      break;
    case 'error':
      updEls.status.textContent = state.message || 'Update check failed.';
      updEls.status.className = 'err';
      break;
    case 'unavailable':
      updEls.status.textContent = state.message || 'Updates unavailable in this build.';
      break;
    default:
      updEls.status.textContent = '';
  }

  const pending = state.status === 'available' || state.status === 'downloaded';
  updBtn.classList.toggle('attention', pending);
  updBtn.textContent = pending ? 'Update ●' : 'Update';

  // Announce a new release once, so a background check is not silent.
  if (state.status !== lastUpdateStatus) {
    if (state.status === 'available') showToast('Update Available', `ShellTab ${state.latest} — open Update to install`);
    if (state.status === 'downloaded') showToast('Update Ready', `Restart to finish installing ${state.latest}`);
  }
  lastUpdateStatus = state.status;
}

updBtn.addEventListener('click', async () => {
  updateModal.classList.remove('hidden');
  const state = await window.api.updateState();
  renderUpdate(state);
  // A modal opened on a cold "idle" state should just go and look.
  if (!state || state.status === 'idle') window.api.updateCheck();
});

const closeUpdate = () => updateModal.classList.add('hidden');
document.getElementById('update-close').addEventListener('click', closeUpdate);
updateModal.addEventListener('click', (e) => {
  if (e.target === updateModal) closeUpdate();
});

updEls.source.addEventListener('change', async () => {
  const mode = updEls.source.value;
  renderUpdateSource({ mode, url: updEls.url.value });
  // Switching back to GitHub takes effect at once; a custom feed waits for a
  // URL so an empty box does not silently disable updates.
  if (mode === 'github' || updEls.url.value.trim()) {
    renderUpdateSource(await window.api.updateSourceSet({ mode, url: updEls.url.value.trim() }));
  }
});

updEls.url.addEventListener('change', async () => {
  renderUpdateSource(await window.api.updateSourceSet({
    mode: updEls.source.value,
    url: updEls.url.value.trim(),
  }));
});

updEls.check.addEventListener('click', () => window.api.updateCheck());
updEls.download.addEventListener('click', () => window.api.updateDownload());
updEls.install.addEventListener('click', () => window.api.updateInstall());

window.api.onUpdateState((state) => renderUpdate(state));

// ── Init ──

sftp.init({ showToast, onLayoutChange: refitActive });

(async () => {
  const state = await window.api.loadState();
  const saved = state?.tabs?.length ? state.tabs : null;

  if (saved) {
    for (const t of saved) {
      if (t.kind === 'ssh' && t.session?.host) {
        // Reconnecting silently would re-prompt for credentials on startup;
        // open the tab and let the user hit Enter when they want it.
        await createLocalPlaceholderForSsh(t);
      } else {
        await createTab({ title: t.label });
      }
    }
  } else {
    await createTab({ title: 'Terminal 1' });
  }

  // Restore widths before the panels are shown, so nothing snaps into place.
  ftpResizer.restore(state?.ftpPanelWidth);
  sftpResizer.restore(state?.sftpPanelWidth);

  renderKeepAlive(await window.api.keepAliveGet());
  renderUpdate(await window.api.updateState());

  if (state?.ftpPanelOpen) ftpPanel.classList.remove('hidden');
  if (state?.sftpPanelOpen) sftp.show();
  refitActive();
  renderSavedHosts();
})();

// A restored SSH tab is offered, not forced — reconnect on demand.
async function createLocalPlaceholderForSsh(t) {
  const tabId = await createTab({ title: t.label });
  const tab = tabs.get(tabId);
  if (!tab) return;
  const target = `${t.session.user ? t.session.user + '@' : ''}${t.session.host}:${t.session.port || 22}`;
  tab.xterm.write(`\r\n\x1b[90mPrevious session: \x1b[36m${target}\x1b[90m\r\n`);
  tab.xterm.write(`Press \x1b[1mCtrl+Shift+R\x1b[0m\x1b[90m in this tab to reconnect.\x1b[0m\r\n`);
  tab.restoreSession = t.session;
}

document.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r')) return;
  const tab = tabs.get(activeTabId);
  if (!tab?.restoreSession) return;
  e.preventDefault();
  const session = tab.restoreSession;
  closeTab(activeTabId);
  await createTab({ kind: 'ssh', title: session.label || session.host, session });
});
