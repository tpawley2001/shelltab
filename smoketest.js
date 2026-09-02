// ── Smoke test ──
// Drives the real UI in a headless window and asserts the SSH + SFTP path
// works end to end. Requires an sshd on 127.0.0.1 that accepts one of the
// keys in ~/.ssh.
//
// Nothing about the machine it runs on is hard-coded here: the key is the
// first one found in ~/.ssh (or $SHELLTAB_TEST_KEY), and the probes that need
// a password log in as $SHELLTAB_TEST_USER / $SHELLTAB_TEST_PASS -- a throwaway
// local account you set up yourself. Leave those unset and those probes report
// SKIP rather than FAIL. Never point them at an account you care about; the
// password is passed to a local sshd in the clear.
//
//   sudo useradd -m -s /bin/bash sttest
//   echo "sttest:$PASS" | sudo chpasswd
//   sudo install -D -m 600 -o sttest ~/.ssh/<key>.pub ~sttest/.ssh/authorized_keys
//
// Run with:
//
//   npm run smoketest
//   SHELLTAB_TEST_USER=sttest SHELLTAB_TEST_PASS=… npm run smoketest
//
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_USER = process.env.SHELLTAB_TEST_USER || '';
const TEST_PASS = process.env.SHELLTAB_TEST_PASS || '';

// The key to authenticate with: named explicitly, or whichever private key in
// ~/.ssh has a .pub sibling -- the same discovery the app itself does, so the
// test never has to know what this machine calls its keys.
function testKey() {
  if (process.env.SHELLTAB_TEST_KEY) return process.env.SHELLTAB_TEST_KEY;
  const dir = path.join(os.homedir(), '.ssh');
  const names = fs.readdirSync(dir).filter((f) => fs.existsSync(path.join(dir, `${f}.pub`)));
  if (!names.length) throw new Error('no usable key in ~/.ssh');
  // Whichever of them the local sshd actually accepts. Trying is cheaper than
  // guessing, and it keeps this machine's key names out of the source.
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      require('child_process').execSync(
        `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i '${p}' ${os.userInfo().username}@127.0.0.1 true`,
        { timeout: 10000, stdio: 'ignore' }
      );
      return p;
    } catch {}
  }
  return path.join(dir, names[0]);
}

const TEST_KEY = testKey();

function hasTestUser() {
  if (!TEST_USER || !TEST_PASS) return false;
  try {
    require('child_process').execSync(
      `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i '${TEST_KEY}' ${TEST_USER}@127.0.0.1 true`,
      { timeout: 10000, stdio: 'ignore' }
    );
    return true;
  } catch { return false; }
}

function run(mainWindow, app) {
  try {
    const crypto = require('crypto');
    const { execSync } = require('child_process');
    const scan = execSync('ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null').toString().trim().split(/\s+/);
    const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(scan[2], 'base64')).digest('base64').replace(/=+$/, '');
    fs.writeFileSync(path.join(app.getPath('userData'), 'known-hosts.json'), JSON.stringify({ '127.0.0.1:22': fp }, null, 2));
    console.log('seeded known-hosts with', fp);
  } catch (e) { console.log('known-hosts seed failed:', e.message); }

  mainWindow.webContents.once('did-finish-load', async () => {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const probe = async (name, expr) => {
      try {
        const r = await mainWindow.webContents.executeJavaScript(expr);
        const good = r === true || (r && r.ok);
        good ? passed++ : failed++;
        console.log(`${good ? 'PASS' : 'FAIL'}  ${name}  ${r === true ? '' : JSON.stringify(r)}`);
      } catch (err) {
        failed++;
        console.log(`FAIL  ${name}  threw: ${err.message}`);
      }
    };
    const skip = (name, why) => {
      skipped++;
      console.log(`SKIP  ${name}  ${why}`);
    };
    await new Promise((r) => setTimeout(r, 2500));
    await probe('one local tab opened at startup',
      `({ ok: document.querySelectorAll('.tab').length === 1, tabs: document.querySelectorAll('.tab').length, kind: document.querySelector('.tab-kind')?.textContent })`);
    await probe('xterm rendered into wrapper',
      `({ ok: !!document.querySelector('.term-wrapper.active .xterm-screen'), rows: document.querySelectorAll('.xterm-rows').length })`);
    await probe('toolbar buttons wired',
      `({ ok: ['btn-new-tab','btn-new-ssh','btn-sftp','btn-ftp','btn-quicklinks','btn-nudges','btn-keepalive','btn-suggest','btn-update'].every(i => !!document.getElementById(i)) })`);
    // ── Inline command suggestions ──

    await probe('history outranks the built-in commands',
      `(() => {
         window.__testSuggest.record('git status --short');
         const hit = window.__testSuggest.match('git st');
         return { ok: hit === 'git status --short', hit };
       })()`);

    await probe('ghost text offers the rest of a command and Tab takes it',
      `(async () => {
         const tab = window.__testActiveTab();
         if (!tab || tab.kind !== 'local') return { ok: false, reason: 'no local tab active' };
         window.__testSuggest.record('echo shelltab-suggest-probe');
         for (const ch of 'echo shelltab-s') tab.xterm.input(ch);
         await new Promise(r => setTimeout(r, 400));
         const ghost = tab.suggest.state().ghost;
         const took = tab.suggest.accept();
         await new Promise(r => setTimeout(r, 300));
         const line = tab.suggest.state().line;
         tab.xterm.input('\u0003');
         await new Promise(r => setTimeout(r, 200));
         return {
           ok: ghost === 'uggest-probe' && took && line === 'echo shelltab-suggest-probe',
           ghost, took, line,
         };
       })()`);

    await probe('nothing is suggested or recorded at a prompt that does not echo',
      `(async () => {
         const tab = window.__testActiveTab();
         if (!tab || tab.kind !== 'local') return { ok: false, reason: 'no local tab active' };
         tab.xterm.input('read -s stprobe\\r');
         await new Promise(r => setTimeout(r, 600));
         for (const ch of 'hunter2-secret') tab.xterm.input(ch);
         await new Promise(r => setTimeout(r, 300));
         const ghost = tab.suggest.state().ghost;
         tab.xterm.input('\\r');
         await new Promise(r => setTimeout(r, 400));
         const leaked = window.__testSuggest.all().some((c) => c.includes('hunter2'));
         return { ok: !ghost && !leaked, ghost, leaked };
       })()`);

    await probe('the toolbar toggle silences suggestions',
      `(async () => {
         const tab = window.__testActiveTab();
         const btn = document.getElementById('btn-suggest');
         const litWhenOn = btn.classList.contains('toggled');
         btn.click();
         for (const ch of 'echo shelltab-s') tab.xterm.input(ch);
         await new Promise(r => setTimeout(r, 400));
         const ghost = tab.suggest.state().ghost;
         tab.xterm.input('\u0003');
         const litWhenOff = btn.classList.contains('toggled');
         btn.click();
         await new Promise(r => setTimeout(r, 200));
         return { ok: litWhenOn && !ghost && !litWhenOff && btn.classList.contains('toggled'), litWhenOn, ghost, litWhenOff };
       })()`);

    await probe('SSH modal opens',
      `(async () => { document.getElementById('btn-new-ssh').click(); await new Promise(r=>setTimeout(r,400)); const m=document.getElementById('ssh-modal'); return { ok: !m.classList.contains('hidden'), user: document.getElementById('ssh-user').value, key: document.getElementById('ssh-key').value }; })()`);
    await probe('SSH auth mode toggles fields',
      `(async () => { const a=document.getElementById('ssh-auth'); a.value='key'; a.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,100)); const keyShown=!document.getElementById('ssh-key-row').classList.contains('hidden'); const passHidden=document.getElementById('ssh-pass').classList.contains('hidden'); return { ok: keyShown && passHidden, keyShown, passHidden }; })()`);
    await probe('SFTP panel toggles',
      `(async () => { document.getElementById('ssh-cancel-btn').click(); document.getElementById('btn-sftp').click(); await new Promise(r=>setTimeout(r,200)); const open=!document.getElementById('sftp-panel').classList.contains('hidden'); const empty=!document.getElementById('sftp-empty').classList.contains('hidden'); document.getElementById('btn-sftp').click(); return { ok: open && empty, open, emptyStateShown: empty }; })()`);
    await probe('FTP sidebar drags to a new width and persists it',
      `(async () => {
         const panel = document.getElementById('ftp-panel');
         const grip = document.getElementById('ftp-resizer');
         if (panel.classList.contains('hidden')) document.getElementById('btn-ftp').click();
         await new Promise(r => setTimeout(r, 200));
         const gripShown = !grip.classList.contains('hidden');
         const before = panel.getBoundingClientRect().width;
         const x = grip.getBoundingClientRect().left;
         const ev = (t, cx) => new PointerEvent(t, { clientX: cx, bubbles: true, pointerId: 1 });
         grip.dispatchEvent(ev('pointerdown', x));
         grip.dispatchEvent(ev('pointermove', x + 120));
         grip.dispatchEvent(ev('pointerup', x + 120));
         await new Promise(r => setTimeout(r, 200));
         const after = panel.getBoundingClientRect().width;
         const saved = (await window.api.loadState())?.ftpPanelWidth;
         return { ok: gripShown && after > before + 100 && saved === Math.round(after), before, after, saved };
       })()`);
    await probe('grip clamps to a minimum instead of collapsing the panel',
      `(async () => {
         const panel = document.getElementById('ftp-panel');
         const grip = document.getElementById('ftp-resizer');
         const x = grip.getBoundingClientRect().left;
         const ev = (t, cx) => new PointerEvent(t, { clientX: cx, bubbles: true, pointerId: 1 });
         grip.dispatchEvent(ev('pointerdown', x));
         grip.dispatchEvent(ev('pointermove', x - 5000));
         grip.dispatchEvent(ev('pointerup', x - 5000));
         await new Promise(r => setTimeout(r, 150));
         const w = panel.getBoundingClientRect().width;
         return { ok: w >= 220 && w <= 221, width: w };
       })()`);
    await probe('double-clicking the grip hides the panel for good',
      `(async () => {
         const panel = document.getElementById('ftp-panel');
         const grip = document.getElementById('ftp-resizer');
         grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
         await new Promise(r => setTimeout(r, 200));
         const hidden = panel.classList.contains('hidden');
         const gripGone = grip.classList.contains('hidden');
         const persisted = (await window.api.loadState())?.ftpPanelOpen;
         const lit = document.getElementById('btn-ftp').classList.contains('toggled');
         return { ok: hidden && gripGone && persisted === false && !lit, hidden, gripGone, persisted, toolbarLit: lit };
       })()`);
    await probe('keep-alive settings round-trip through the main process',
      `(async () => {
         const before = await window.api.keepAliveGet();
         const off = await window.api.keepAliveSet({ enabled: false });
         const on = await window.api.keepAliveSet({ enabled: true, keepAwake: true, awakeMode: 'display' });
         await window.api.keepAliveSet(before);
         return { ok: off.awake === false && on.enabled === true, stoppedBlocker: off.awake === false, restarted: on.enabled };
       })()`);
    await probe('keep-alive modal reflects state and lights the toolbar',
      `(async () => {
         await window.api.keepAliveSet({ enabled: true, keepAwake: true, antiIdle: true, antiIdleSeconds: 90 });
         document.getElementById('btn-keepalive').click();
         // The handler awaits an IPC round-trip, and powerSaveBlocker can be
         // slow to answer over DBus — poll rather than guess a sleep.
         const modal = document.getElementById('keepalive-modal');
         for (let i = 0; i < 40 && modal.classList.contains('hidden'); i++) {
           await new Promise(r => setTimeout(r, 50));
         }
         const open = !modal.classList.contains('hidden');
         const lit = document.getElementById('btn-keepalive').classList.contains('toggled');
         const secs = document.getElementById('ka-antiidle-secs').value;
         document.getElementById('keepalive-done').click();
         await window.api.keepAliveSet({ antiIdle: false, antiIdleSeconds: 120 });
         return { ok: open && lit && secs === '90', open, lit, secs };
       })()`);
    await probe('update modal reports the running version',
      `(async () => {
         document.getElementById('btn-update').click();
         await new Promise(r => setTimeout(r, 400));
         const open = !document.getElementById('update-modal').classList.contains('hidden');
         const txt = document.getElementById('update-version').textContent;
         const status = document.getElementById('update-status').textContent;
         document.getElementById('update-close').click();
         return { ok: open && /Installed version \\d+\\.\\d+\\.\\d+/.test(txt), open, txt, status };
       })()`);
    await probe('update source defaults to the LAN feed and takes another server',
      `(async () => {
         const before = await window.api.updateSourceGet();
         const lan = await window.api.updateSourceSet({ mode: 'url', url: 'http://127.0.0.1:8099/shelltab' });
         document.getElementById('btn-update').click();
         await new Promise(r => setTimeout(r, 300));
         const shown = !document.getElementById('update-url').classList.contains('hidden');
         const back = await window.api.updateSourceSet(before);
         document.getElementById('update-close').click();
         return {
           ok: before.mode === 'url' && before.url.startsWith('http://')
               && before.url.endsWith('/shelltab/')
               && lan.mode === 'url' && shown && back.url === before.url,
           deflt: before.url, lan: lan.url, urlFieldShown: shown, restored: back.url,
         };
       })()`);
    // A stored 'github' source is what every pre-1.7 install carries; it has to
    // land back on the LAN feed rather than leaving the box with no route.
    await probe('a saved GitHub source migrates to the LAN feed',
      `(async () => {
         const before = await window.api.updateSourceGet();
         const migrated = await window.api.updateSourceSet({ mode: 'github', url: '' });
         const back = await window.api.updateSourceSet(before);
         return {
           ok: migrated.mode === 'url' && migrated.url === before.url,
           mode: migrated.mode, url: migrated.url,
         };
       })()`);
    // Folder mode has to work with no web server in sight, so the probe points
    // at a throwaway directory holding a latest.yml the app never has to fetch.
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelltab-feed-'));
    fs.writeFileSync(path.join(feedDir, 'latest.yml'), 'version: 9.9.9\n');
    await probe('update source accepts a plain folder, no port asked for',
      `(async () => {
         const before = await window.api.updateSourceGet();
         const set = await window.api.updateSourceSet({ mode: 'folder', folder: ${JSON.stringify(feedDir)} });
         document.getElementById('btn-update').click();
         await new Promise(r => setTimeout(r, 300));
         const rowShown = !document.getElementById('update-folder-row').classList.contains('hidden');
         const urlHidden = document.getElementById('update-url').classList.contains('hidden');
         const shownPath = document.getElementById('update-folder').value;
         const back = await window.api.updateSourceSet(before);
         document.getElementById('update-close').click();
         return {
           ok: set.mode === 'folder' && rowShown && urlHidden && shownPath === ${JSON.stringify(feedDir)}
               && back.mode === before.mode,
           rowShown, urlHidden, shownPath, restored: back.mode,
         };
       })()`);
    try { fs.rmSync(feedDir, { recursive: true, force: true }); } catch {}

    await probe('key discovery finds non-standard key names',
      `(async () => { const keys = await window.api.sshFindKeys(); return { ok: keys.includes('${TEST_KEY}'), keys: keys.map(k => k.split('/').pop()) }; })()`);

    await probe('live SSH tab connects via the connect dialog',
      `(async () => {
         document.getElementById('btn-new-ssh').click();
         await new Promise(r => setTimeout(r, 300));
         document.getElementById('ssh-host').value = '127.0.0.1';
         document.getElementById('ssh-port').value = 22;
         document.getElementById('ssh-user').value = '${os.userInfo().username}';
         const auth = document.getElementById('ssh-auth');
         auth.value = 'key'; auth.dispatchEvent(new Event('change'));
         document.getElementById('ssh-key').value = '${TEST_KEY}';
         document.getElementById('ssh-connect-btn').click();
         await new Promise(r => setTimeout(r, 5000));
         const tabs = [...document.querySelectorAll('.tab')];
         const active = document.querySelector('.tab.active');
         const screen = document.querySelector('.term-wrapper.active').innerText;
         return {
           ok: tabs.length === 2 && active.classList.contains('ssh') && !/Connection failed/.test(screen),
           tabCount: tabs.length,
           badge: active.querySelector('.tab-kind').textContent,
           failed: /Connection failed/.test(screen),
           screenTail: screen.replace(/\\s+/g, ' ').trim().slice(-90),
         };
       })()`);

    await probe('shell-integration bootstrap is hidden from the user',
      `(async () => {
         const text = document.querySelector('.term-wrapper.active').innerText;
         return { ok: !/PROMPT_COMMAND|ST_READY|ST_BOOT_/.test(text), leaked: /PROMPT_COMMAND|ST_READY|ST_BOOT_/.test(text) };
       })()`);

    // Hiding the bootstrap used to hide the login banner with it.
    await probe('login banner survives the shell-integration bootstrap',
      `(async () => {
         const text = document.querySelector('.term-wrapper.active').innerText;
         const banner = /Welcome to Ubuntu|System information as of|Usage of \\//.test(text);
         return { ok: banner, banner, head: text.replace(/\\s+/g, ' ').trim().slice(0, 90) };
       })()`);

    await probe('SFTP browser auto-opened on the live session',
      `(async () => {
         const open = !document.getElementById('sftp-panel').classList.contains('hidden');
         const rows = document.querySelectorAll('#sftp-list .sftp-item').length;
         return { ok: open && rows > 0, open, rows, cwd: document.getElementById('sftp-cwd').value };
       })()`);

    await probe('SFTP listing decodes dirs, sizes and permissions',
      `(async () => {
         const first = document.querySelector('#sftp-list .sftp-item');
         const dirs = document.querySelectorAll('#sftp-list .sftp-item.dir').length;
         const perms = [...document.querySelectorAll('#sftp-list .sftp-md')].filter(e => /^[rwx-]{9}$/.test(e.textContent)).length;
         return { ok: dirs > 0 && perms > 0, dirs, permsRendered: perms, sample: first && first.querySelector('.sftp-nm').textContent };
       })()`);

    await probe('SFTP browser follows the terminal into a new directory',
      `(async () => {
         const before = document.getElementById('sftp-cwd').value;
         window.api.sshInput(1, 'cd /etc\\r');
         await new Promise(r => setTimeout(r, 2500));
         const after = document.getElementById('sftp-cwd').value;
         const rows = document.querySelectorAll('#sftp-list .sftp-item').length;
         return { ok: after === '/etc' && after !== before, before, after, rows };
       })()`);

    await probe('password auth raises the interactive prompt and cancels cleanly',
      `(async () => {
         document.getElementById('btn-new-ssh').click();
         await new Promise(r => setTimeout(r, 300));
         document.getElementById('ssh-host').value = '127.0.0.1';
         document.getElementById('ssh-user').value = '${os.userInfo().username}';
         const auth = document.getElementById('ssh-auth');
         auth.value = 'password'; auth.dispatchEvent(new Event('change'));
         document.getElementById('ssh-pass').value = '';
         document.getElementById('ssh-connect-btn').click();
         await new Promise(r => setTimeout(r, 2500));
         const modal = document.getElementById('ssh-prompt-modal');
         const shown = !modal.classList.contains('hidden');
         const fields = modal.querySelectorAll('.prompt-field input').length;
         const secret = modal.querySelector('.prompt-field input')?.type === 'password';
         const host = document.getElementById('ssh-prompt-host').textContent;
         document.getElementById('ssh-prompt-cancel').click();
         await new Promise(r => setTimeout(r, 2000));
         const screen = document.querySelector('.term-wrapper.active').innerText;
         const failedCleanly = /Connection failed/.test(screen);
         return { ok: shown && fields === 1 && secret && failedCleanly, shown, fields, secret, host, failedCleanly };
       })()`);

    if (hasTestUser()) {
      await probe('wrong password re-prompts instead of killing the connection',
        `(async () => {
           document.getElementById('btn-new-ssh').click();
           await new Promise(r => setTimeout(r, 300));
           document.getElementById('ssh-host').value = '127.0.0.1';
           document.getElementById('ssh-user').value = '${TEST_USER}';
           const auth = document.getElementById('ssh-auth');
           auth.value = 'password'; auth.dispatchEvent(new Event('change'));
           document.getElementById('ssh-pass').value = '';
           document.getElementById('ssh-connect-btn').click();
           await new Promise(r => setTimeout(r, 2500));
           const modal = document.getElementById('ssh-prompt-modal');
           const first = modal.querySelector('.prompt-field input');
           first.value = 'definitely-wrong';
           document.getElementById('ssh-prompt-ok').click();
           // Wrong password: the server rejects it and auth should come around
           // again for a second ask, not fail the whole connection.
           for (let i = 0; i < 40 && !(!modal.classList.contains('hidden') && modal.querySelector('.prompt-field input')); i++) {
             await new Promise(r => setTimeout(r, 100));
           }
           const reprompted = !modal.classList.contains('hidden') && !!modal.querySelector('.prompt-field input');
           if (!reprompted) {
             document.getElementById('ssh-prompt-cancel')?.click();
             return { ok: false, reprompted };
           }
           modal.querySelector('.prompt-field input').value = '${TEST_PASS}';
           document.getElementById('ssh-prompt-ok').click();
           await new Promise(r => setTimeout(r, 5000));
           const active = document.querySelector('.tab.active');
           const screen = document.querySelector('.term-wrapper.active').innerText;
           const connected = active.classList.contains('ssh')
             && !active.classList.contains('disconnected')
             && !/Connection failed/.test(screen);
           return { ok: reprompted && connected, reprompted, connected };
         })()`);
    } else {
      skip('wrong password re-prompts instead of killing the connection', 'SHELLTAB_TEST_USER/PASS not set (see header)');
    }

    await probe('local shell echoes a command',
      `(async () => { const wrap=document.querySelector('.term-wrapper.active'); const before=wrap.innerText.length; window.dispatchEvent(new Event('noop')); return { ok: before > 0, chars: before }; })()`);

    // ── In-app dialogs (Electron's renderer has no window.prompt) ──

    await probe('in-app prompt resolves with the entered value',
      `(async () => {
         const p = window.__testPrompt('New directory name:', { title: 'SFTP — New Folder' });
         await new Promise(r => setTimeout(r, 200));
         const modal = document.getElementById('prompt-modal');
         const shown = !modal.classList.contains('hidden');
         const input = document.getElementById('prompt-input');
         input.value = 'test-folder';
         document.getElementById('prompt-ok').click();
         const value = await p;
         return { ok: shown && value === 'test-folder', shown, value };
       })()`);

    await probe('in-app prompt cancel resolves null and closes',
      `(async () => {
         const p = window.__testPrompt('Folder name:');
         await new Promise(r => setTimeout(r, 150));
         document.getElementById('prompt-cancel').click();
         const value = await p;
         const hidden = document.getElementById('prompt-modal').classList.contains('hidden');
         return { ok: value === null && hidden, value, hidden };
       })()`);

    await probe('in-app prompt validates before accepting',
      `(async () => {
         const p = window.__testPrompt('Octal permissions:', { validate: (v) => /^[0-7]{3,4}$/.test(v.trim()), error: 'Enter an octal mode like 644.' });
         await new Promise(r => setTimeout(r, 150));
         const input = document.getElementById('prompt-input');
         input.value = 'abc';
         document.getElementById('prompt-ok').click();
         await new Promise(r => setTimeout(r, 100));
         const stillOpen = !document.getElementById('prompt-modal').classList.contains('hidden');
         const errShown = document.getElementById('prompt-error').textContent.length > 0;
         input.value = '644';
         document.getElementById('prompt-ok').click();
         const value = await p;
         return { ok: stillOpen && errShown && value === '644', stillOpen, errShown, value };
       })()`);

    await probe('in-app confirm resolves true on OK and styles the button',
      `(async () => {
         const p = window.__testConfirm('Delete this?', { okLabel: 'Delete' });
         await new Promise(r => setTimeout(r, 150));
         const modal = document.getElementById('prompt-modal');
         const confirmStyled = modal.classList.contains('confirm');
         const label = document.getElementById('prompt-ok').textContent;
         document.getElementById('prompt-ok').click();
         const value = await p;
         return { ok: confirmStyled && label === 'Delete' && value === true, confirmStyled, label, value };
       })()`);

    await probe('SFTP new-folder dialog opens and mkdir succeeds',
      `(async () => {
         // Re-bind the panel to the live SSH tab (the password-fail probe left
         // a dead tab active), and go somewhere writable.
         const sshTab = [...document.querySelectorAll('.tab')].find(t => t.classList.contains('ssh') && !t.classList.contains('disconnected'));
         if (!sshTab) return { ok: false, reason: 'no live ssh tab' };
         sshTab.click();
         await new Promise(r => setTimeout(r, 600));
         document.getElementById('sftp-home').click();
         await new Promise(r => setTimeout(r, 800));
         const before = document.querySelectorAll('#sftp-list .sftp-item').length;
         document.getElementById('sftp-mkdir').click();
         await new Promise(r => setTimeout(r, 250));
         const modal = document.getElementById('prompt-modal');
         const opened = !modal.classList.contains('hidden');
         const input = document.getElementById('prompt-input');
         input.value = 'st_smoketest_dir';
         document.getElementById('prompt-ok').click();
         await new Promise(r => setTimeout(r, 1500));
         const appears = [...document.querySelectorAll('#sftp-list .sftp-nm')].some(e => e.textContent === 'st_smoketest_dir');
         return { ok: opened && appears, opened, before, appears };
       })()`);

    await probe('SFTP rename through the in-app dialog',
      `(async () => {
         const row = [...document.querySelectorAll('#sftp-list .sftp-item')].find(e => e.dataset.name === 'st_smoketest_dir');
         if (!row) return { ok: false, reason: 'smoketest dir missing' };
         row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
         await new Promise(r => setTimeout(r, 150));
         const renameItem = [...document.querySelectorAll('#sftp-menu .ctx-item')].find(e => e.textContent === 'Rename…');
         if (!renameItem) return { ok: false, reason: 'rename menu item missing' };
         renameItem.click();
         await new Promise(r => setTimeout(r, 250));
         const input = document.getElementById('prompt-input');
         const prefilled = input.value === 'st_smoketest_dir';
         input.value = 'st_smoketest_dir2';
         document.getElementById('prompt-ok').click();
         await new Promise(r => setTimeout(r, 1500));
         const renamed = [...document.querySelectorAll('#sftp-list .sftp-nm')].some(e => e.textContent === 'st_smoketest_dir2');
         return { ok: prefilled && renamed, prefilled, renamed };
       })()`);

    await probe('SFTP delete confirms in-app and removes the entry',
      `(async () => {
         const row = [...document.querySelectorAll('#sftp-list .sftp-item')].find(e => e.dataset.name === 'st_smoketest_dir2');
         if (!row) return { ok: false, reason: 'renamed dir missing' };
         row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
         await new Promise(r => setTimeout(r, 150));
         const deleteItem = [...document.querySelectorAll('#sftp-menu .ctx-item')].find(e => e.textContent === 'Delete');
         deleteItem.click();
         await new Promise(r => setTimeout(r, 250));
         const confirmOpen = !document.getElementById('prompt-modal').classList.contains('hidden');
         const danger = document.getElementById('prompt-modal').classList.contains('confirm');
         document.getElementById('prompt-ok').click();
         await new Promise(r => setTimeout(r, 1500));
         const gone = ![...document.querySelectorAll('#sftp-list .sftp-nm')].some(e => e.textContent === 'st_smoketest_dir2');
         return { ok: confirmOpen && danger && gone, confirmOpen, danger, gone };
       })()`);

    await probe('SFTP permissions dialog rejects a non-octal value',
      `(async () => {
         const row = document.querySelector('#sftp-list .sftp-item');
         if (!row) return { ok: false };
         row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
         await new Promise(r => setTimeout(r, 150));
         const permItem = [...document.querySelectorAll('#sftp-menu .ctx-item')].find(e => e.textContent === 'Permissions…');
         permItem.click();
         await new Promise(r => setTimeout(r, 250));
         const input = document.getElementById('prompt-input');
         const prefilled = /^[0-7]{3,4}$/.test(input.value);
         input.value = '999';
         document.getElementById('prompt-ok').click();
         await new Promise(r => setTimeout(r, 150));
         const rejected = !document.getElementById('prompt-modal').classList.contains('hidden');
         document.getElementById('prompt-cancel').click();
         return { ok: prefilled && rejected, prefilled, rejected };
       })()`);

    // ── Reconnect after the server goes away ──

    await probe('a dropped SSH session offers Reconnect in the same tab',
      `(async () => {
         const sshTab = [...document.querySelectorAll('.tab')].find(t => t.classList.contains('ssh') && !t.classList.contains('disconnected'));
         if (!sshTab) return { ok: false, reason: 'no live ssh tab' };
         sshTab.click();
         await new Promise(r => setTimeout(r, 400));
         const tabsBefore = document.querySelectorAll('.tab').length;
         const tab = window.__testActiveTab();
         const oldSshId = tab.sshId;
         // Standing in for the server going away: end the remote shell.
         window.api.sshInput(tab.sshId, 'exit\\r');
         for (let i = 0; i < 60 && tab.sshId !== null; i++) await new Promise(r => setTimeout(r, 100));
         const bar = document.querySelector('.term-wrapper.active .reconnect-bar');
         const shown = !!bar && !bar.classList.contains('hidden');
         const btn = !!bar?.querySelector('.reconnect-btn');
         return {
           ok: shown && btn && tab.sshId === null && sshTab.classList.contains('disconnected')
             && document.querySelectorAll('.tab').length === tabsBefore,
           shown, btn, dropped: tab.sshId === null, oldSshId,
           tabsBefore, tabsAfter: document.querySelectorAll('.tab').length,
           msg: bar?.querySelector('.reconnect-msg')?.textContent,
         };
       })()`);

    await probe('Reconnect dials the same host back into the same tab',
      `(async () => {
         const tab = window.__testActiveTab();
         const tabId = tab.tabId;
         const scrollbackBefore = document.querySelector('.term-wrapper.active').innerText.length;
         const tabsBefore = document.querySelectorAll('.tab').length;
         document.querySelector('.term-wrapper.active .reconnect-bar .reconnect-btn').click();
         for (let i = 0; i < 80 && tab.sshId === null; i++) await new Promise(r => setTimeout(r, 100));
         await new Promise(r => setTimeout(r, 1500));
         const bar = document.querySelector('.term-wrapper.active .reconnect-bar');
         const active = document.querySelector('.tab.active');
         const screen = document.querySelector('.term-wrapper.active').innerText;
         return {
           ok: tab.sshId !== null && window.__testActiveTab().tabId === tabId
             && bar.classList.contains('hidden')
             && !active.classList.contains('disconnected')
             && document.querySelectorAll('.tab').length === tabsBefore
             && scrollbackBefore > 0
             && !/Connection failed/.test(screen),
           sshId: tab.sshId, sameTab: window.__testActiveTab().tabId === tabId,
           barHidden: bar.classList.contains('hidden'),
           tabsAfter: document.querySelectorAll('.tab').length,
           screenTail: screen.replace(/\\s+/g, ' ').trim().slice(-90),
         };
       })()`);

    await probe('a restored session tab reconnects in place, local pty and all',
      `(async () => {
         const tabsBefore = document.querySelectorAll('.tab').length;
         await window.__testRestorePlaceholder({
           label: 'restored-probe',
           session: { host: '127.0.0.1', port: 22, user: '${os.userInfo().username}', privateKeyPath: '${TEST_KEY}' },
         });
         await new Promise(r => setTimeout(r, 600));
         const tab = window.__testActiveTab();
         const startedLocal = tab.kind === 'local';
         const bar = document.querySelector('.term-wrapper.active .reconnect-bar');
         const offered = !!bar && !bar.classList.contains('hidden');
         const tabId = tab.tabId;
         bar.querySelector('.reconnect-btn').click();
         for (let i = 0; i < 80 && tab.sshId === null; i++) await new Promise(r => setTimeout(r, 100));
         await new Promise(r => setTimeout(r, 1200));
         const active = document.querySelector('.tab.active');
         return {
           ok: startedLocal && offered && tab.kind === 'ssh' && tab.sshId != null
             && tab.termId === null && window.__testActiveTab().tabId === tabId
             && active.classList.contains('ssh') && !active.classList.contains('local')
             && active.querySelector('.tab-kind').textContent === 'SSH'
             && document.querySelectorAll('.tab').length === tabsBefore + 1,
           startedLocal, offered, kind: tab.kind, sshId: tab.sshId, termId: tab.termId,
           badge: active.querySelector('.tab-kind').textContent,
           tabsBefore, tabsAfter: document.querySelectorAll('.tab').length,
         };
       })()`);

    // ── Reconnect borrows credentials back from the Quicklink ──
    // The saved app state deliberately never holds a password, so a restored
    // tab only knows its quicklinkId. Reconnect must go and fetch the rest.

    await probe('a credential-less session refills from its Quicklink',
      `(async () => {
         const saved = await window.api.saveQuicklink({
           type: 'ssh', label: 'st-hydrate-probe', host: '10.99.99.99', port: 2222,
           user: 'stuser', password: 'st-secret', auth: 'password', shellIntegration: true,
         });
         const byId = await window.__testHydrateQuicklink({ host: '10.99.99.99', port: 2222, user: 'stuser', quicklinkId: saved.id });
         // No id at all: the host it dials still finds the Quicklink.
         const byHost = await window.__testHydrateQuicklink({ host: '10.99.99.99', port: 2222, user: 'stuser' });
         // A password already in hand is never second-guessed.
         const typed = await window.__testHydrateQuicklink({ host: '10.99.99.99', port: 2222, user: 'stuser', password: 'typed-in' });
         // A different host must not borrow this one's password.
         const other = await window.__testHydrateQuicklink({ host: '10.99.99.98', port: 2222, user: 'stuser' });
         await window.api.deleteQuicklink(saved.id);
         return {
           ok: byId.password === 'st-secret' && byHost.password === 'st-secret'
             && byHost.quicklinkId === saved.id && typed.password === 'typed-in'
             && !other.password,
           byId: byId.password, byHost: byHost.password, typed: typed.password, other: other.password || null,
         };
       })()`);

    if (hasTestUser()) {
      await probe('Reconnect uses the Quicklink password instead of prompting',
        `(async () => {
           const saved = await window.api.saveQuicklink({
             type: 'ssh', label: 'st-reconnect-probe', host: '127.0.0.1', port: 22,
             user: '${TEST_USER}', password: '${TEST_PASS}', auth: 'password', shellIntegration: true,
           });
           // Exactly what persistState() writes for a Quicklink tab: no password.
           await window.__testRestorePlaceholder({
             label: 'st-reconnect-probe',
             session: { host: '127.0.0.1', port: 22, user: '${TEST_USER}', useAgent: false, quicklinkId: saved.id },
           });
           await new Promise(r => setTimeout(r, 600));
           const tab = window.__testActiveTab();
           document.querySelector('.term-wrapper.active .reconnect-bar .reconnect-btn').click();
           for (let i = 0; i < 80 && tab.sshId === null; i++) await new Promise(r => setTimeout(r, 100));
           await new Promise(r => setTimeout(r, 1200));
           const modal = document.getElementById('ssh-prompt-modal');
           const prompted = !modal.classList.contains('hidden');
           if (prompted) document.getElementById('ssh-prompt-cancel').click();
           const screen = document.querySelector('.term-wrapper.active').innerText;
           await window.api.deleteQuicklink(saved.id);
           return {
             ok: !prompted && tab.sshId != null && !/Connection failed/.test(screen),
             prompted, sshId: tab.sshId,
             screenTail: screen.replace(/\\s+/g, ' ').trim().slice(-90),
           };
         })()`);
    } else {
      skip('Reconnect uses the Quicklink password instead of prompting', 'SHELLTAB_TEST_USER/PASS not set (see header)');
    }

    console.log(`\n${passed}/${passed + failed} checks passed${skipped ? ` (${skipped} skipped)` : ''}`);
    app.exit(failed ? 1 : 0);
  });
}

module.exports = { run };
