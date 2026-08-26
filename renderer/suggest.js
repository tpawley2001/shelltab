// ── Inline command suggestions ──
// MobaXterm offered the rest of a command while you typed it; this is that,
// drawn as dim ghost text after the cursor and taken with Tab (or Right arrow).
//
// Nothing is guessed at the shell's expense: the ghost is written only into the
// local xterm, never sent, so a wrong guess costs no keystrokes and the remote
// never sees it. What the user has typed is tracked from their own keystrokes
// rather than scraped off the screen — every keystroke passes through onInput()
// on the way to the transport. The model is dropped the moment something
// arrives we cannot account for (an escape sequence, a control character, a Tab
// handed to the shell's own completion) and comes back at the next prompt, so a
// stale guess is never shown.
//
// Every paint first checks the typed line really is on screen. That one test is
// what keeps a password prompt — which echoes nothing — from being suggested
// against or written to the history file.

const MAX_HISTORY = 500;
const MIN_RECORD = 3; // one- and two-letter commands are faster to retype than to read

const DIM = '\x1b[90m'; // brightBlack in the terminal theme
const RESET = '\x1b[0m';
const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const ERASE_EOL = '\x1b[0K';

// The echo has to land before the cursor can tell us where the ghost goes, so a
// paint waits for this much quiet on the wire.
const SETTLE_MS = 45;

// Worth offering before the history has anything to say. Ranked below history,
// so a command the user has actually run always wins.
const COMMON = [
  'cd ..', 'ls -la', 'df -h', 'du -sh *', 'free -h', 'uptime', 'htop',
  'git status', 'git pull', 'git push', 'git diff', 'git log --oneline -10',
  'docker ps', 'docker compose up -d', 'docker compose logs -f',
  'systemctl status ', 'systemctl restart ', 'journalctl -u ', 'journalctl -f',
  'tail -f /var/log/syslog', 'ps aux | grep ', 'grep -rn ', 'nvidia-smi',
  'sudo apt update && sudo apt upgrade',
];

const history = []; // oldest first — the tail is the best guess
const controllers = new Set();
let enabled = true;

// ── History ──

function record(cmd) {
  const line = (cmd || '').trim();
  if (line.length < MIN_RECORD) return false;
  const at = history.indexOf(line);
  if (at !== -1) history.splice(at, 1);
  history.push(line);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return true;
}

function load(list) {
  history.length = 0;
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) history.push(item);
  }
}

function all() {
  return history.slice();
}

function match(prefix) {
  if (!prefix) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].length > prefix.length && history[i].startsWith(prefix)) return history[i];
  }
  for (const cmd of COMMON) {
    if (cmd.length > prefix.length && cmd.startsWith(prefix)) return cmd;
  }
  return null;
}

// ── Per-tab controller ──

function attach(tab, { send, isActive = () => true, onRecord = () => {} } = {}) {
  let line = ''; // null once the model is stale
  let ghost = ''; // what is painted on screen right now
  let full = ''; // the whole suggestion the ghost is a (possibly clipped) tail of
  let timer = null;

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // The ghost starts at the cursor, so erasing to end of line takes it away
  // without moving anything the shell cares about.
  function erase() {
    if (!ghost) return;
    ghost = '';
    full = '';
    tab.xterm.write(ERASE_EOL);
  }

  function onScreen(text) {
    const buf = tab.xterm.buffer.active;
    const row = buf.getLine(buf.baseY + buf.cursorY);
    if (!row) return false;
    return row.translateToString(false, 0, buf.cursorX).endsWith(text);
  }

  function paint() {
    timer = null;
    if (!enabled || !line || !isActive()) return;
    const buf = tab.xterm.buffer.active;
    if (buf.type !== 'normal') return; // vim, less: not a prompt
    // Not echoed — a password prompt, or a line that wrapped past where we can
    // account for it. Either way, stop guessing until the next prompt.
    if (!onScreen(line)) {
      line = null;
      return;
    }
    const hit = match(line);
    if (!hit) return erase();
    // Clip to the room left on the row: erase-to-end-of-line only clears one
    // row, so a ghost that wrapped could not be taken back cleanly.
    const room = tab.xterm.cols - buf.cursorX - 1;
    const text = hit.slice(line.length, line.length + Math.max(0, room));
    if (!text) return erase();
    if (text === ghost && hit === full) return;
    ghost = text;
    full = hit;
    // Erase, draw, and put the cursor back: the shell's own idea of where it
    // is stays exactly as it was.
    tab.xterm.write(`${SAVE}${ERASE_EOL}${DIM}${text}${RESET}${RESTORE}`);
  }

  function schedule() {
    stop();
    if (!enabled || !line) return;
    timer = setTimeout(paint, SETTLE_MS);
  }

  // Recording only what the screen shows keeps unechoed input — a sudo or SSH
  // password prompt — out of the history.
  function submit() {
    if (line && onScreen(line) && record(line)) onRecord();
    line = '';
  }

  function onInput(data) {
    stop();
    erase();
    if (typeof data !== 'string' || !data) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        submit();
        continue;
      }
      if (line === null) continue;
      if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
      else if (ch === '\x15') line = ''; // Ctrl+U
      else if (ch === '\x17') line = line.replace(/\s*\S*$/, ''); // Ctrl+W
      else if (ch === '\x03' || ch === '\x04') line = ''; // Ctrl+C / Ctrl+D: the shell starts over
      else if (ch < ' ') line = null; // arrows, Tab-completion, anything we cannot model
      else line += ch;
    }
    schedule();
  }

  // Called before the incoming data is written, so the cursor is still where
  // the ghost was drawn and erasing takes back exactly the ghost. Taking it
  // back matters: output that scrolls the prompt away would otherwise leave
  // grey text nobody typed sitting in the scrollback.
  function onOutput() {
    erase();
    schedule();
  }

  function accept() {
    if (!ghost || line === null) return false;
    const rest = full.slice(line.length);
    erase();
    if (!rest) return false;
    line += rest;
    send(rest);
    schedule();
    return true;
  }

  // A fresh prompt: whatever was typed is gone, and so is any ghost on it.
  function reset() {
    stop();
    ghost = '';
    full = '';
    line = '';
  }

  function refresh() {
    if (enabled) schedule();
    else {
      stop();
      erase();
    }
  }

  function dispose() {
    stop();
    controllers.delete(controller);
  }

  const controller = {
    onInput,
    onOutput,
    accept,
    reset,
    refresh,
    dispose,
    // Smoketest window: what the controller currently believes.
    state: () => ({ line, ghost, full }),
  };
  controllers.add(controller);
  return controller;
}

function setEnabled(on) {
  enabled = !!on;
  for (const c of controllers) c.refresh();
}

function isEnabled() {
  return enabled;
}

module.exports = { attach, record, load, all, match, setEnabled, isEnabled };
