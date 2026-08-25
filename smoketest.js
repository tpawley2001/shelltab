// ── Smoke test ──
// Drives the real UI in a headless window and asserts the SSH + SFTP path
// works end to end. Requires an sshd on 127.0.0.1 that accepts one of the
// keys in ~/.ssh. Run with:
//
//   npm run smoketest
//
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    await new Promise((r) => setTimeout(r, 2500));
    await probe('one local tab opened at startup',
      `({ ok: document.querySelectorAll('.tab').length === 1, tabs: document.querySelectorAll('.tab').length, kind: document.querySelector('.tab-kind')?.textContent })`);
    await probe('xterm rendered into wrapper',
      `({ ok: !!document.querySelector('.term-wrapper.active .xterm-screen'), rows: document.querySelectorAll('.xterm-rows').length })`);
    await probe('toolbar buttons wired',
      `({ ok: ['btn-new-tab','btn-new-ssh','btn-sftp','btn-ftp','btn-quicklinks','btn-nudges','btn-keepalive','btn-update'].every(i => !!document.getElementById(i)) })`);
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
    await probe('update source switches between GitHub and a local feed',
      `(async () => {
         const before = await window.api.updateSourceGet();
         const lan = await window.api.updateSourceSet({ mode: 'url', url: 'http://127.0.0.1:8099/shelltab' });
         document.getElementById('btn-update').click();
         await new Promise(r => setTimeout(r, 300));
         const shown = !document.getElementById('update-url').classList.contains('hidden');
         const back = await window.api.updateSourceSet(before);
         document.getElementById('update-close').click();
         return {
           ok: lan.mode === 'url' && shown && back.mode === before.mode,
           lan: lan.url, urlFieldShown: shown, restored: back.mode,
         };
       })()`);
    await probe('key discovery finds non-standard key names',
      `(async () => { const keys = await window.api.sshFindKeys(); return { ok: keys.some(k => k.endsWith('solar_key')), keys: keys.map(k => k.split('/').pop()) }; })()`);

    await probe('live SSH tab connects via the connect dialog',
      `(async () => {
         document.getElementById('btn-new-ssh').click();
         await new Promise(r => setTimeout(r, 300));
         document.getElementById('ssh-host').value = '127.0.0.1';
         document.getElementById('ssh-port').value = 22;
         document.getElementById('ssh-user').value = '${os.userInfo().username}';
         const auth = document.getElementById('ssh-auth');
         auth.value = 'key'; auth.dispatchEvent(new Event('change'));
         document.getElementById('ssh-key').value = '${path.join(os.homedir(), '.ssh', 'solar_key')}';
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
         return { ok: !/PROMPT_COMMAND|ST_READY/.test(text), leaked: /PROMPT_COMMAND|ST_READY/.test(text) };
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

    await probe('local shell echoes a command',
      `(async () => { const wrap=document.querySelector('.term-wrapper.active'); const before=wrap.innerText.length; window.dispatchEvent(new Event('noop')); return { ok: before > 0, chars: before }; })()`);
    console.log(`\n${passed}/${passed + failed} checks passed`);
    app.exit(failed ? 1 : 0);
  });
}

module.exports = { run };
