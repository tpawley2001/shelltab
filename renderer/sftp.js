// ── SFTP browser ──
// One panel, one state bucket per live SSH session. Mirrors MobaXterm's
// behaviour: the browser follows whatever directory the terminal is sitting in.

const panel = () => document.getElementById('sftp-panel');
const listEl = () => document.getElementById('sftp-list');
const cwdEl = () => document.getElementById('sftp-cwd');
const menuEl = () => document.getElementById('sftp-menu');

const sessions = new Map(); // sshId -> { cwd, home, label, entries, selection }
let activeId = null;
let showToast = () => {};
let onLayoutChange = () => {};

function posixJoin(base, name) {
  if (name.startsWith('/')) return name;
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function posixParent(p) {
  if (p === '/' || !p) return '/';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} K`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} M`;
  return `${(bytes / 1073741824).toFixed(1)} G`;
}

function formatMode(mode) {
  if (!mode) return '';
  const rwx = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  return rwx[(mode >> 6) & 7] + rwx[(mode >> 3) & 7] + rwx[mode & 7];
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  const opts = Math.abs(now - ms) > 15778800000
    ? { year: 'numeric', month: 'short', day: '2-digit' }
    : { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString(undefined, opts);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function state(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { cwd: '.', home: null, label: '', entries: [], selection: new Set() });
  }
  return sessions.get(id);
}

// ── Panel visibility ──

function isOpen() {
  return !panel().classList.contains('hidden');
}

function show() {
  panel().classList.remove('hidden');
  onLayoutChange();
}

function hide() {
  panel().classList.add('hidden');
  hideMenu();
  onLayoutChange();
}

function toggle() {
  isOpen() ? hide() : show();
}

// ── Session lifecycle ──

async function setActive(sshId, label) {
  activeId = sshId;
  const empty = document.getElementById('sftp-empty');
  const hasSession = sshId != null;

  document.getElementById('sftp-path-bar').classList.toggle('hidden', !hasSession);
  document.getElementById('sftp-actions').classList.toggle('hidden', !hasSession);
  listEl().classList.toggle('hidden', !hasSession);
  empty.classList.toggle('hidden', hasSession);

  if (!hasSession) {
    document.getElementById('sftp-title').textContent = 'SFTP';
    return;
  }

  const st = state(sshId);
  if (label) st.label = label;
  document.getElementById('sftp-title').textContent = st.label || 'SFTP';

  if (st.home === null) {
    const res = await window.api.sftpRealpath(sshId, '.');
    if (res?.error) {
      listEl().innerHTML = `<div class="sftp-msg error">${escapeHtml(res.error)}</div>`;
      return;
    }
    st.home = res.path;
    st.cwd = res.path;
  }
  await navigate(sshId, st.cwd, true);
}

function remove(sshId) {
  sessions.delete(sshId);
  if (activeId === sshId) setActive(null);
}

// Called when the shell reports a new working directory (OSC 7).
function notifyCwd(sshId, cwd) {
  const st = state(sshId);
  if (st.home === null) st.home = cwd;
  if (!document.getElementById('sftp-follow').checked) return;
  if (activeId !== sshId || !isOpen()) {
    st.cwd = cwd;
    return;
  }
  if (st.cwd === cwd) return;
  navigate(sshId, cwd);
}

// ── Listing ──

async function navigate(sshId, remotePath, force) {
  const st = state(sshId);
  if (!force && st.cwd === remotePath && st.entries.length) return;

  const items = await window.api.sftpList(sshId, remotePath);
  if (items?.error) {
    showToast('SFTP', items.error);
    if (activeId === sshId) {
      listEl().innerHTML = `<div class="sftp-msg error">${escapeHtml(items.error)}</div>`;
    }
    return;
  }

  st.cwd = remotePath;
  st.entries = items;
  st.selection = new Set();
  if (activeId === sshId) render(sshId);
}

function render(sshId) {
  const st = state(sshId);
  cwdEl().value = st.cwd;

  const items = [...st.entries].sort((a, b) => {
    const ad = a.type === 'dir', bd = b.type === 'dir';
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  const el = listEl();
  el.innerHTML = '';

  if (!items.length) {
    el.innerHTML = '<div class="sftp-msg">Empty directory</div>';
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `sftp-item ${item.type}`;
    row.dataset.name = item.name;
    const icon = item.type === 'dir' ? '📁' : item.type === 'link' ? '🔗' : '📄';
    row.innerHTML = `
      <span class="sftp-ic">${icon}</span>
      <span class="sftp-nm">${escapeHtml(item.name)}</span>
      <span class="sftp-sz">${item.type === 'dir' ? '' : formatSize(item.size)}</span>
      <span class="sftp-dt">${formatDate(item.mtime)}</span>
      <span class="sftp-md">${formatMode(item.mode)}</span>
    `;
    if (st.selection.has(item.name)) row.classList.add('selected');

    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        st.selection.has(item.name) ? st.selection.delete(item.name) : st.selection.add(item.name);
      } else {
        st.selection = new Set([item.name]);
      }
      render(sshId);
    });

    row.addEventListener('dblclick', () => {
      if (item.type === 'dir' || item.type === 'link') {
        navigate(sshId, posixJoin(st.cwd, item.name), true);
      } else {
        downloadOne(sshId, item);
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!st.selection.has(item.name)) st.selection = new Set([item.name]);
      render(sshId);
      showMenu(e.clientX, e.clientY, sshId, item);
    });

    el.appendChild(row);
  }
}

function refresh() {
  if (activeId != null) navigate(activeId, state(activeId).cwd, true);
}

// ── Transfers ──

async function downloadOne(sshId, item) {
  const localPath = await window.api.saveFileDialog(item.name);
  if (!localPath) return;
  const st = state(sshId);
  const res = await window.api.sftpDownload(sshId, posixJoin(st.cwd, item.name), localPath);
  if (res?.error) showToast('SFTP download failed', res.error);
  else showToast('Downloaded', `${item.name} → ${localPath}`);
}

async function downloadSelected(sshId) {
  const st = state(sshId);
  const names = [...st.selection];
  const files = st.entries.filter((e) => names.includes(e.name) && e.type !== 'dir');

  if (!files.length) {
    showToast('SFTP', 'Select one or more files to download (directories are not recursed).');
    return;
  }
  if (files.length === 1) return downloadOne(sshId, files[0]);

  const dir = await window.api.openDirectoryDialog();
  if (!dir) return;
  const sep = dir.includes('\\') ? '\\' : '/';
  let ok = 0;
  for (const f of files) {
    const res = await window.api.sftpDownload(sshId, posixJoin(st.cwd, f.name), `${dir}${sep}${f.name}`);
    if (res?.error) showToast('SFTP download failed', `${f.name}: ${res.error}`);
    else ok++;
  }
  showToast('Downloaded', `${ok} of ${files.length} file(s) → ${dir}`);
}

async function uploadPaths(sshId, localPaths) {
  if (!localPaths?.length) return;
  const st = state(sshId);
  let ok = 0;
  for (const local of localPaths) {
    const name = local.split(/[/\\]/).pop();
    const res = await window.api.sftpUpload(sshId, local, posixJoin(st.cwd, name));
    if (res?.error) showToast('SFTP upload failed', `${name}: ${res.error}`);
    else ok++;
  }
  if (ok) showToast('Uploaded', `${ok} file(s) → ${st.cwd}`);
  refresh();
}

function onProgress(sshId, p) {
  if (sshId !== activeId) return;
  const wrap = document.getElementById('sftp-transfer');
  if (p.done) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const pct = p.total ? Math.round((p.transferred / p.total) * 100) : 0;
  document.getElementById('sftp-transfer-label').textContent =
    `${p.direction === 'up' ? '↑' : '↓'} ${p.name} — ${formatSize(p.transferred)} / ${formatSize(p.total)} (${pct}%)`;
  document.getElementById('sftp-bar-fill').style.width = `${pct}%`;
}

// ── Context menu ──

function hideMenu() {
  menuEl().classList.add('hidden');
}

function showMenu(x, y, sshId, item) {
  const st = state(sshId);
  const menu = menuEl();
  const actions = [
    item.type === 'dir'
      ? { label: 'Open', fn: () => navigate(sshId, posixJoin(st.cwd, item.name), true) }
      : { label: 'Download…', fn: () => downloadSelected(sshId) },
    { label: 'Rename…', fn: async () => {
      const next = prompt(`Rename "${item.name}" to:`, item.name);
      if (!next || next === item.name) return;
      const res = await window.api.sftpRename(sshId, posixJoin(st.cwd, item.name), posixJoin(st.cwd, next));
      if (res?.error) showToast('SFTP', res.error); else refresh();
    } },
    { label: 'Permissions…', fn: async () => {
      const current = (item.mode || 0).toString(8).padStart(4, '0');
      const next = prompt(`Octal permissions for "${item.name}":`, current);
      if (!next) return;
      const mode = parseInt(next, 8);
      if (Number.isNaN(mode)) return showToast('SFTP', 'Not a valid octal mode.');
      const res = await window.api.sftpChmod(sshId, posixJoin(st.cwd, item.name), mode);
      if (res?.error) showToast('SFTP', res.error); else refresh();
    } },
    { label: 'Copy path', fn: () => {
      navigator.clipboard.writeText(posixJoin(st.cwd, item.name));
      showToast('Clipboard', 'Remote path copied');
    } },
    { label: 'Delete', danger: true, fn: async () => {
      const names = [...st.selection];
      if (!confirm(`Delete ${names.length > 1 ? `${names.length} items` : `"${item.name}"`}?`)) return;
      for (const name of names) {
        const entry = st.entries.find((e) => e.name === name);
        const res = await window.api.sftpDelete(sshId, posixJoin(st.cwd, name), entry?.type === 'dir');
        if (res?.error) showToast('SFTP', `${name}: ${res.error}`);
      }
      refresh();
    } },
  ];

  menu.innerHTML = '';
  for (const a of actions) {
    const el = document.createElement('div');
    el.className = `ctx-item${a.danger ? ' danger' : ''}`;
    el.textContent = a.label;
    el.addEventListener('click', () => { hideMenu(); a.fn(); });
    menu.appendChild(el);
  }

  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

// ── Wiring ──

function init(opts = {}) {
  showToast = opts.showToast || showToast;
  onLayoutChange = opts.onLayoutChange || onLayoutChange;

  document.getElementById('sftp-close').addEventListener('click', hide);
  document.getElementById('sftp-refresh').addEventListener('click', refresh);

  document.getElementById('sftp-up').addEventListener('click', () => {
    if (activeId == null) return;
    navigate(activeId, posixParent(state(activeId).cwd), true);
  });

  document.getElementById('sftp-home').addEventListener('click', () => {
    if (activeId == null) return;
    const st = state(activeId);
    navigate(activeId, st.home || '.', true);
  });

  cwdEl().addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || activeId == null) return;
    navigate(activeId, cwdEl().value.trim() || '/', true);
  });

  document.getElementById('sftp-upload').addEventListener('click', async () => {
    if (activeId == null) return;
    const paths = await window.api.openFileDialog({ multi: true });
    uploadPaths(activeId, Array.isArray(paths) ? paths : paths ? [paths] : []);
  });

  document.getElementById('sftp-download').addEventListener('click', () => {
    if (activeId != null) downloadSelected(activeId);
  });

  document.getElementById('sftp-mkdir').addEventListener('click', async () => {
    if (activeId == null) return;
    const name = prompt('New directory name:');
    if (!name) return;
    const st = state(activeId);
    const res = await window.api.sftpMkdir(activeId, posixJoin(st.cwd, name));
    if (res?.error) showToast('SFTP', res.error); else refresh();
  });

  // Drag files from the OS straight into the remote directory.
  const drop = listEl();
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (activeId != null) drop.classList.add('drag-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (activeId == null) return;
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return showToast('SFTP', 'Could not resolve dropped file paths — use the Upload button.');
    uploadPaths(activeId, paths);
  });

  document.addEventListener('click', hideMenu);
  window.addEventListener('blur', hideMenu);

  window.api.onSftpProgress(onProgress);
}

module.exports = { init, setActive, remove, notifyCwd, show, hide, toggle, isOpen, refresh };
