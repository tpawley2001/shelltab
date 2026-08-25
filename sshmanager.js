// ── Native SSH + SFTP backend ──
// Replaces the old "type `ssh` into a local shell and scrape the password" approach.
const { ipcMain, dialog, app } = require('electron');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const keepAlive = require('./keepalive');

const sessions = new Map(); // id -> { client, stream, sftp, cfg, closed }
let nextSessionId = 1;

// ── Anti-idle ──
// SSH keepalives are protocol-level; a bastion or firewall that only counts
// *channel* traffic will still time the session out. This drips a NUL into the
// shell itself, which no shell echoes or acts on.

function stopAntiIdle(session) {
  if (session.antiIdleTimer) {
    clearInterval(session.antiIdleTimer);
    session.antiIdleTimer = null;
  }
}

function startAntiIdle(session) {
  stopAntiIdle(session);
  const ms = keepAlive.antiIdleMs();
  if (!ms) return;
  session.antiIdleTimer = setInterval(() => {
    if (session.closed || !session.stream) return stopAntiIdle(session);
    try { session.stream.write(keepAlive.ANTI_IDLE_BYTE); } catch {}
  }, ms);
}

// A settings change retargets live sessions without a reconnect. The SSH
// keepalive interval is fixed at connect time, so that half only takes effect
// on the next session.
keepAlive.subscribe(() => {
  for (const [, s] of sessions) {
    if (!s.closed && s.stream) startAntiIdle(s);
    else stopAntiIdle(s);
  }
});

// ── Renderer prompts (passwords, passphrases, keyboard-interactive / 2FA) ──

const pendingPrompts = new Map();
let nextPromptId = 1;

function askRenderer(win, payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = nextPromptId++;
    pendingPrompts.set(id, resolve);
    win.webContents.send('ssh:prompt', id, payload);
  });
}

// ── Host key verification (known_hosts equivalent) ──

function knownHostsFile() {
  return path.join(app.getPath('userData'), 'known-hosts.json');
}

function loadKnownHosts() {
  try {
    return JSON.parse(fs.readFileSync(knownHostsFile(), 'utf-8'));
  } catch { return {}; }
}

function saveKnownHosts(map) {
  try {
    fs.writeFileSync(knownHostsFile(), JSON.stringify(map, null, 2));
  } catch {}
}

function fingerprint(keyBuffer) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
}

async function verifyHostKey(win, host, port, keyBuffer) {
  const id = `${host}:${port}`;
  const fp = fingerprint(keyBuffer);
  const known = loadKnownHosts();

  if (known[id] === fp) return true;

  const changed = !!known[id];
  const result = await dialog.showMessageBox(win, {
    type: changed ? 'warning' : 'question',
    title: changed ? 'HOST KEY CHANGED' : 'Unknown host key',
    message: changed
      ? `WARNING: the host key for ${id} has CHANGED.`
      : `The authenticity of host ${id} can't be established.`,
    detail: changed
      ? `Stored:  ${known[id]}\nOffered: ${fp}\n\nThis may mean someone is intercepting the connection, or the server was rebuilt. Only continue if you expected this.`
      : `Fingerprint: ${fp}\n\nAccept this key to continue connecting.`,
    buttons: ['Cancel', 'Accept once', changed ? 'Accept & replace stored key' : 'Accept & save'],
    defaultId: changed ? 0 : 2,
    cancelId: 0,
    noLink: true,
  });

  if (result.response === 0) return false;
  if (result.response === 2) {
    known[id] = fp;
    saveKnownHosts(known);
  }
  return true;
}

// ── Connect ──

function readPrivateKey(cfg) {
  if (cfg.privateKey) return cfg.privateKey;
  if (!cfg.privateKeyPath) return null;
  const p = cfg.privateKeyPath.replace(/^~(?=[/\\]|$)/, os.homedir());
  return fs.readFileSync(p);
}

function defaultAgent() {
  if (process.platform === 'win32') return process.env.SSH_AUTH_SOCK || 'pageant';
  return process.env.SSH_AUTH_SOCK || null;
}

function register(getWindow) {
  ipcMain.on('ssh:prompt-reply', (event, id, answers) => {
    const resolve = pendingPrompts.get(id);
    if (resolve) {
      pendingPrompts.delete(id);
      resolve(answers);
    }
  });

  ipcMain.handle('ssh:connect', async (event, cfg = {}) => {
    const win = getWindow();
    const id = nextSessionId++;
    const host = cfg.host;
    const port = cfg.port || 22;
    const username = cfg.user || os.userInfo().username;

    if (!host) return { error: 'No host specified' };

    let privateKey = null;
    if (cfg.privateKeyPath || cfg.privateKey) {
      try {
        privateKey = readPrivateKey(cfg);
      } catch (err) {
        return { error: `Could not read key file: ${err.message}` };
      }
    }

    const agent = cfg.useAgent === false ? null : (cfg.agent || defaultAgent());
    let password = cfg.password || null;
    let passphrase = cfg.passphrase || null;

    const client = new Client();
    const session = { client, stream: null, sftp: null, cfg: { ...cfg, host, port, user: username }, closed: false };

    const send = (channel, ...args) => {
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(channel, id, ...args);
    };

    // Auth method order: agent → publickey → password → keyboard-interactive.
    const methods = ['none'];
    if (agent) methods.push('agent');
    if (privateKey) methods.push('publickey');
    methods.push('password', 'keyboard-interactive');
    let methodIndex = 0;

    // ssh2 calls this as (methodsLeft, partialSuccess, callback); both of the
    // first two are null on the first attempt.
    const authHandler = (methodsLeft, partialSuccess, callback) => {
      const next = async () => {
        while (methodIndex < methods.length) {
          const method = methods[methodIndex++];
          if (methodsLeft && methodsLeft.length && method !== 'none' && !methodsLeft.includes(method)) continue;

          if (method === 'none') return callback({ type: 'none', username });
          if (method === 'agent') return callback({ type: 'agent', username, agent });

          if (method === 'publickey') {
            if (!privateKey) continue;
            // Encrypted key with no passphrase yet → ask.
            if (!passphrase && /ENCRYPTED|bcrypt/i.test(privateKey.toString('utf-8').slice(0, 400))) {
              const answers = await askRenderer(win, {
                title: `Passphrase for ${cfg.privateKeyPath || 'private key'}`,
                host: `${username}@${host}`,
                fields: [{ label: 'Key passphrase', secret: true }],
              });
              if (!answers) continue;
              passphrase = answers.answers[0];
            }
            return callback({ type: 'publickey', username, key: privateKey, passphrase: passphrase || undefined });
          }

          if (method === 'password') {
            if (!password) {
              const answers = await askRenderer(win, {
                title: `Password for ${username}@${host}`,
                host: `${username}@${host}:${port}`,
                fields: [{ label: 'Password', secret: true }],
                offerSave: true,
              });
              if (!answers) continue;
              password = answers.answers[0];
              if (answers.save) session.offerSavePassword = password;
            }
            return callback({ type: 'password', username, password });
          }

          if (method === 'keyboard-interactive') {
            return callback({
              type: 'keyboard-interactive',
              username,
              prompt: async (name, instructions, lang, prompts, finish) => {
                // A single non-echo prompt is almost always just the password.
                if (password && prompts.length === 1 && !prompts[0].echo) return finish([password]);
                const answers = await askRenderer(win, {
                  title: name || `${username}@${host}`,
                  host: `${username}@${host}:${port}`,
                  instructions,
                  fields: prompts.map((p) => ({ label: p.prompt, secret: !p.echo })),
                });
                finish(answers ? answers.answers : prompts.map(() => ''));
              },
            });
          }
        }
        return callback(false);
      };
      next();
    };

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      client.on('ready', () => {
        sessions.set(id, session);
        client.shell(
          {
            term: 'xterm-256color',
            cols: cfg.cols || 80,
            rows: cfg.rows || 24,
          },
          (err, stream) => {
            if (err) {
              client.end();
              return settle({ error: `Could not open shell: ${err.message}` });
            }
            session.stream = stream;
            startAntiIdle(session);
            stream.on('data', (d) => send('ssh:data', d.toString('utf-8')));
            stream.stderr.on('data', (d) => send('ssh:data', d.toString('utf-8')));
            stream.on('close', () => {
              session.closed = true;
              stopAntiIdle(session);
              send('ssh:exit', 0);
              client.end();
            });
            settle({
              id,
              host,
              port,
              user: username,
              savedPassword: session.offerSavePassword || null,
            });
          }
        );
      });

      client.on('error', (err) => {
        send('ssh:status', err.message);
        settle({ error: err.message });
      });

      client.on('close', () => {
        if (!session.closed) {
          session.closed = true;
          send('ssh:exit', 0);
        }
        stopAntiIdle(session);
        sessions.delete(id);
      });

      client.on('banner', (msg) => send('ssh:data', msg.replace(/\n/g, '\r\n')));

      client.connect({
        host,
        port,
        username,
        agent: agent || undefined,
        agentForward: !!cfg.agentForward,
        tryKeyboard: true,
        readyTimeout: cfg.readyTimeout || 30000,
        keepaliveInterval: keepAlive.sshKeepaliveMs(),
        keepaliveCountMax: 5,
        authHandler,
        hostVerifier: (key, cb) => {
          verifyHostKey(getWindow(), host, port, Buffer.isBuffer(key) ? key : Buffer.from(key))
            .then(cb)
            .catch(() => cb(false));
        },
      });
    });
  });

  ipcMain.on('ssh:input', (event, id, data) => {
    const s = sessions.get(id);
    if (s?.stream) s.stream.write(data);
  });

  ipcMain.on('ssh:resize', (event, id, cols, rows) => {
    const s = sessions.get(id);
    if (s?.stream) {
      try { s.stream.setWindow(rows, cols, 0, 0); } catch {}
    }
  });

  ipcMain.on('ssh:close', (event, id) => {
    const s = sessions.get(id);
    if (s) {
      s.closed = true;
      stopAntiIdle(s);
      try { s.stream?.end(); } catch {}
      try { s.client.end(); } catch {}
      sessions.delete(id);
    }
  });

  // ── SFTP over the live session ──

  function getSftp(id) {
    const s = sessions.get(id);
    if (!s) return Promise.reject(new Error('Session not connected'));
    if (s.sftp) return Promise.resolve(s.sftp);
    return new Promise((resolve, reject) => {
      s.client.sftp((err, sftp) => {
        if (err) return reject(err);
        s.sftp = sftp;
        sftp.on('close', () => { s.sftp = null; });
        resolve(sftp);
      });
    });
  }

  const wrap = (fn) => async (event, id, ...args) => {
    try {
      const sftp = await getSftp(id);
      return await fn(sftp, ...args);
    } catch (err) {
      return { error: err.message };
    }
  };

  ipcMain.handle('sftp:list', wrap((sftp, remotePath) => new Promise((resolve, reject) => {
    sftp.readdir(remotePath || '.', (err, list) => {
      if (err) return reject(err);
      resolve(list.map((e) => {
        const mode = e.attrs.mode || 0;
        const isDir = (mode & 0o170000) === 0o040000;
        const isLink = (mode & 0o170000) === 0o120000;
        return {
          name: e.filename,
          size: e.attrs.size,
          mtime: e.attrs.mtime ? e.attrs.mtime * 1000 : 0,
          mode: mode & 0o7777,
          type: isDir ? 'dir' : isLink ? 'link' : 'file',
          longname: e.longname,
        };
      }));
    });
  })));

  ipcMain.handle('sftp:realpath', wrap((sftp, remotePath) => new Promise((resolve, reject) => {
    sftp.realpath(remotePath || '.', (err, p) => (err ? reject(err) : resolve({ path: p })));
  })));

  ipcMain.handle('sftp:stat', wrap((sftp, remotePath) => new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, attrs) => {
      if (err) return reject(err);
      const mode = attrs.mode || 0;
      resolve({
        size: attrs.size,
        mode: mode & 0o7777,
        type: (mode & 0o170000) === 0o040000 ? 'dir' : 'file',
        mtime: attrs.mtime ? attrs.mtime * 1000 : 0,
      });
    });
  })));

  ipcMain.handle('sftp:download', async (event, id, remotePath, localPath) => {
    try {
      const sftp = await getSftp(id);
      const send = (payload) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('sftp:progress', id, payload);
      };
      const name = remotePath.split('/').pop();
      return await new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, {
          concurrency: 8,
          chunkSize: 32768,
          step: (transferred, chunk, total) => send({ name, direction: 'down', transferred, total }),
        }, (err) => {
          send({ name, direction: 'down', done: true });
          err ? reject(err) : resolve({ success: true });
        });
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('sftp:upload', async (event, id, localPath, remotePath) => {
    try {
      const sftp = await getSftp(id);
      const send = (payload) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('sftp:progress', id, payload);
      };
      const name = localPath.split(/[/\\]/).pop();
      return await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, {
          concurrency: 8,
          chunkSize: 32768,
          step: (transferred, chunk, total) => send({ name, direction: 'up', transferred, total }),
        }, (err) => {
          send({ name, direction: 'up', done: true });
          err ? reject(err) : resolve({ success: true });
        });
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('sftp:mkdir', wrap((sftp, remotePath) => new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve({ success: true })));
  })));

  ipcMain.handle('sftp:rename', wrap((sftp, from, to) => new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve({ success: true })));
  })));

  ipcMain.handle('sftp:chmod', wrap((sftp, remotePath, mode) => new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (err) => (err ? reject(err) : resolve({ success: true })));
  })));

  ipcMain.handle('sftp:delete', wrap((sftp, remotePath, isDir) => new Promise((resolve, reject) => {
    const fn = isDir ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
    fn(remotePath, (err) => (err ? reject(err) : resolve({ success: true })));
  })));

  return {
    killAll() {
      for (const [, s] of sessions) {
        stopAntiIdle(s);
        try { s.client.end(); } catch {}
      }
      sessions.clear();
    },
  };
}

module.exports = { register };
