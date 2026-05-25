const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');

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

async function createTab(title) {
  tabCounter++;
  const tabId = tabCounter;
  const label = title || `Terminal ${tabId}`;

  const result = await window.api.createTerminal({ cols: 80, rows: 24 });

  const xterm = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    theme: {
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
    },
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

  window.api.resizeTerminal(result.id, xterm.cols, xterm.rows);

  xterm.onData((data) => {
    window.api.sendInput(result.id, data);
  });

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = tabId;
  tabEl.innerHTML = `
    <span class="tab-title">${label}</span>
    <span class="tab-close" title="Close tab">&times;</span>
  `;
  tabBar.appendChild(tabEl);

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tabId);
    } else {
      switchTab(tabId);
    }
  });

  tabEl.addEventListener('dblclick', (e) => {
    if (e.target.classList.contains('tab-title')) {
      const titleEl = e.target;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = titleEl.textContent;
      input.style.cssText = 'background:#1e1e2e;border:1px solid #89b4fa;color:#cdd6f4;font-size:12px;width:80px;padding:1px 4px;border-radius:2px;';
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const newTitle = input.value.trim() || label;
        const span = document.createElement('span');
        span.className = 'tab-title';
        span.textContent = newTitle;
        input.replaceWith(span);
        tabs.get(tabId).label = newTitle;
        updateNudgeTargets();
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = label; input.blur(); }
      });
    }
  });

  tabs.set(tabId, { termId: result.id, xterm, fitAddon, wrapper, tabEl, label });
  switchTab(tabId);
  updateNudgeTargets();
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
      window.api.resizeTerminal(tab.termId, tab.xterm.cols, tab.xterm.rows);
    }, 10);
  }
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  window.api.killTerminal(tab.termId);
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

  if (activeTabId === tabId) {
    activeTabId = null;
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    }
  }
}

// ── Terminal data from backend ──
window.api.onTermData((termId, data) => {
  for (const [, tab] of tabs) {
    if (tab.termId === termId) {
      tab.xterm.write(data);
      break;
    }
  }
  detectSshHost(termId, data);
});

window.api.onTermExit((termId) => {
  for (const [tabId, tab] of tabs) {
    if (tab.termId === termId) {
      tab.xterm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      break;
    }
  }
});

// ── Resize handling ──
const resizeObserver = new ResizeObserver(() => {
  if (activeTabId) {
    const tab = tabs.get(activeTabId);
    if (tab) {
      tab.fitAddon.fit();
      window.api.resizeTerminal(tab.termId, tab.xterm.cols, tab.xterm.rows);
    }
  }
});
resizeObserver.observe(termContainer);

// ── FTP Panel ──
document.getElementById('btn-ftp').addEventListener('click', () => {
  ftpPanel.classList.toggle('hidden');
  if (!ftpPanel.classList.contains('hidden')) {
    renderSavedHosts();
    prefillFtpFromSsh();
  }
  setTimeout(() => {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        tab.fitAddon.fit();
        window.api.resizeTerminal(tab.termId, tab.xterm.cols, tab.xterm.rows);
      }
    }
  }, 50);
});

document.getElementById('ftp-close').addEventListener('click', () => {
  ftpPanel.classList.add('hidden');
  setTimeout(() => {
    if (activeTabId) {
      const tab = tabs.get(activeTabId);
      if (tab) {
        tab.fitAddon.fit();
        window.api.resizeTerminal(tab.termId, tab.xterm.cols, tab.xterm.rows);
      }
    }
  }, 50);
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

// ── SSH Host Detection ──

const sshHostPerTab = new Map();

function detectSshHost(termId, data) {
  const text = typeof data === 'string' ? data : '';
  const sshMatch = text.match(/(\w+)@([\w.\-]+)[:\s]/);
  if (sshMatch) {
    for (const [tabId, tab] of tabs) {
      if (tab.termId === termId) {
        sshHostPerTab.set(tabId, { user: sshMatch[1], host: sshMatch[2] });
        break;
      }
    }
  }
}

function prefillFtpFromSsh() {
  if (ftpConnectionId) return;
  const sshInfo = sshHostPerTab.get(activeTabId);
  if (sshInfo) {
    const hostEl = document.getElementById('ftp-host');
    const userEl = document.getElementById('ftp-user');
    if (!hostEl.value) {
      hostEl.value = sshInfo.host;
      userEl.value = sshInfo.user;
    }
  }
}

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
    if (tab) {
      const payload = nudge.appendNewline ? nudge.text + '\n' : nudge.text;
      window.api.sendInput(tab.termId, payload);
    }
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

// ── Keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    createTab();
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
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

// ── Init ──
createTab('Terminal 1');
renderSavedHosts();
