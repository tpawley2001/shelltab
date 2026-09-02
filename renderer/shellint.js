// Shell integration: teach the remote shell to announce its working directory
// via OSC 7 after every prompt, so the SFTP browser can follow the terminal.
//
// The bootstrap line is echoed by the remote shell. We hide just that echo --
// not everything up to the sentinel -- because the login banner (motd, disk
// usage, pending updates) lands in the same window and belongs on screen.
// `:` is a no-op builtin, so the leading token is inert; the renderer looks for
// it in the echo to know where the part it must hide begins.

const READY_MARKER = '\x1b]1337;ST_READY\x07';

// Emits OSC 7: ESC ] 7 ; file://<host><cwd> BEL
const OSC7 = `printf "\\033]7;file://%s%s\\007" "$(hostname 2>/dev/null)" "$PWD"`;

// bash uses PROMPT_COMMAND, zsh uses precmd; defining both is harmless in either.
// Leading space keeps it out of history when HISTCONTROL=ignorespace.
function buildBootstrap() {
  const beginToken = `ST_BOOT_${Math.random().toString(36).slice(2, 10)}`;
  const text =
    ` : ${beginToken}; PROMPT_COMMAND='${OSC7}'"\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; ` +
    `precmd() { ${OSC7}; }; ` +
    `printf '\\033]1337;ST_READY\\007'\r`;
  return { text, beginToken };
}

module.exports = { READY_MARKER, OSC7, buildBootstrap };
