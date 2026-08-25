// Shell integration: teach the remote shell to announce its working directory
// via OSC 7 after every prompt, so the SFTP browser can follow the terminal.
//
// The bootstrap line is echoed by the remote shell, so it ends by printing a
// sentinel; the renderer hides everything up to and including that sentinel.

const READY_MARKER = '\x1b]1337;ST_READY\x07';

// Emits OSC 7: ESC ] 7 ; file://<host><cwd> BEL
const OSC7 = `printf "\\033]7;file://%s%s\\007" "$(hostname 2>/dev/null)" "$PWD"`;

// bash uses PROMPT_COMMAND, zsh uses precmd; defining both is harmless in either.
// Leading space keeps it out of history when HISTCONTROL=ignorespace.
const SHELL_INTEGRATION =
  ` PROMPT_COMMAND='${OSC7}'"\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; ` +
  `precmd() { ${OSC7}; }; ` +
  `printf '\\033]1337;ST_READY\\007'\r`;

module.exports = { READY_MARKER, OSC7, SHELL_INTEGRATION };
