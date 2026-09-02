# ShellTab

A cross-platform tabbed terminal with **native SSH**, an **SFTP file browser that follows your shell**, an FTP client, and a timed nudge system. Built with Electron, xterm.js, node-pty and ssh2.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

### Tabbed Terminal
- Full PTY-backed terminal sessions with xterm.js rendering
- Catppuccin Mocha color theme
- Create, close, rename, and cycle through tabs
- Keyboard shortcuts below
- Double-click a tab title to rename it
- Uses your default shell (bash/zsh on Linux, PowerShell/cmd on Windows)
- URLs in terminal output are clickable and open in your desktop browser, never inside the app

### Command Suggestions
As you type, the rest of a command you have run before appears in grey after the
cursor — **Tab** or **Right arrow** takes it, anything else ignores it.

- The guess is drawn into your terminal only; nothing reaches the shell until
  you accept it, so a wrong guess costs no keystrokes
- Ranked most-recent-first out of your own history; a short list of common
  commands fills in until you have one
- History persists across tabs, sessions and restarts, in `app-state.json`
  under the app's user-data directory
- **Suggest** in the toolbar turns it off; the button is lit while it is on
- With nothing suggested, `Tab` is the shell's own completion and `Right` just
  moves the cursor, both untouched
- A prompt that does not echo — `sudo`, `ssh`, anything reading a password — is
  detected and neither suggested against nor recorded

### Native SSH Sessions
- Real SSH connections via [ssh2](https://github.com/mscdex/ssh2) — no OpenSSH client, PuTTY or WSL required
- Authentication by **password**, **private key** (with passphrase), or **SSH agent / Pageant**
- Interactive prompts for passwords, key passphrases and multi-factor challenges
- A wrong password re-prompts (up to three tries, like ssh) instead of killing the connection
- Private keys in `~/.ssh` are discovered automatically, including non-standard names
- Host keys are verified against a stored `known-hosts.json`; you are warned loudly if one changes
- Keepalives hold long-lived sessions open; tabs are badged `SSH` and dim when disconnected
- A session that drops — server reboot, dead link — puts a **Reconnect** button on the tab and dials the same host back into that same tab, keeping its scrollback and name
- Sessions are remembered across restarts and reconnect on demand from the same button (or `Ctrl+Shift+R`)
- **Reconnect never re-asks for a password you already saved.** The saved session state deliberately holds no
  credentials, so a reconnecting tab refills the password, key and passphrase from its Quicklink — matched by id,
  or by host, port and user when the Quicklink was saved later. A password typed for this session still wins
- The login banner (motd, disk usage, pending updates) stays on screen; only the shell-integration bootstrap's own
  echo is hidden

### SFTP Browser
- A graphical file browser riding the **same** SSH connection — no second login
- **Follows the terminal**: `cd` somewhere in the shell and the browser goes with you
- Upload, download, rename, delete, `mkdir`, and `chmod` from a right-click menu
- Multi-select, drag-and-drop upload from the desktop, and live transfer progress
- Sizes, timestamps and `rwxr-xr-x` permissions for every entry
- Renames, permission changes and folder creation use an in-app dialog with validation (Electron has no `window.prompt`)

### Resizable Sidebars
Both the SFTP browser and the FTP panel have a drag grip on their inner edge.
- Drag to resize; the terminal refits live as you go
- **Double-click the grip** to hide that panel outright
- Width clamps to 220px minimum and always leaves the terminal 360px
- Widths and open/closed state persist across restarts
- The **Files** and **FTP** toolbar buttons light up while their panel is open

### Built-in FTP Client
Retained for plain FTP/FTPS servers; see the FTP panel. For anything on port 22, use SSH/SFTP.
Files delete via `DELE`; empty folders via `RMD` (previously folder deletion always failed).

### Quicklinks
The **Quicklinks** toolbar button holds your saved connections — SSH sessions, FTP sites, and plain
commands to run in a fresh tab.
- Tick *Save as Quicklink* in the connect dialog, or add one straight from the dropdown
- Passwords are encrypted at rest with the OS keychain (Electron `safeStorage`), in `quicklinks.json`
  under the app's user-data directory
- A password you type at an interactive prompt can be saved back to the Quicklink from that prompt
- One click connects; the credentials are also what a **Reconnect** falls back on

### Saved Hosts
- After a successful FTP connection, ShellTab prompts to save the connection
- Passwords are encrypted at rest using the OS keychain (Electron `safeStorage` API)
- One-click reconnect from the saved hosts list
- Delete saved hosts when no longer needed

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+T` | New local terminal tab |
| `Ctrl+Shift+S` | New SSH session |
| `Ctrl+Shift+W` | Close the current tab |
| `Ctrl+Shift+B` | Toggle the SFTP browser |
| `Ctrl+Shift+R` | Reconnect a dropped or restored SSH tab (Enter does it too in a dropped tab) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Alt+1`…`Alt+9` | Jump to a tab |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Tab` / `Right` | Accept the inline command suggestion (when one is showing) |

Terminal shortcuts use `Ctrl+Shift` so that plain `Ctrl+C`, `Ctrl+T` and `Ctrl+W`
still reach the remote shell. Right-click copies a selection, or pastes when
there is none.

### Timed Nudges
- Configure periodic actions on a per-tab or global (active tab) basis
- Two nudge types:
  - **Terminal input**: Sends text directly to the PTY (e.g., keep-alive commands, periodic `ls`, health checks)
  - **Overlay notification**: Displays a toast notification over the terminal without affecting the shell
- Configurable interval (in seconds)
- Pause, resume, and remove individual nudges

### Keep-Alive
Sessions die two different ways, so the **Keep-Alive** toolbar button covers both.
The button lights up whenever something is being held open.
- **Keep this PC awake** — holds a `powerSaveBlocker`, the same hold a video
  player takes while playing, so Windows never sleeps, locks, or blanks on idle.
  Choose *screen and system* (video-player behaviour) or *system only*, which
  lets the monitor sleep but keeps the machine from suspending.
- **SSH keepalive** — protocol-level keepalives on the interval you set
  (default 20s, `0` disables). Fixed at connect time, so it applies to sessions
  opened after the change.
- **Anti-idle** — writes a NUL byte into the session itself on an interval, for
  bastions and firewalls that only count *channel* traffic and ignore protocol
  keepalives. No shell echoes or acts on it. Applies to live sessions
  immediately.

Settings persist in `keepalive.json` under the app's user-data directory.

### Remote Update
The **Update** button checks the build server for a newer ShellTab. The feed is
the web server the other self-updating apps here already use — `build.publish`
in `package.json` names it, and the installed build inherits it — so an update
never depends on reaching github.com or on a GitHub Release existing.
- One quiet check ~8s after launch, then every 6 hours; a find raises a toast
  and marks the toolbar button
- Downloads are never automatic — you click **Download**, then
  **Restart & Install**
- Only works in an installed build; a dev run says so rather than erroring

**Update source** is selectable in the same dialog:
- **Local server / Tailscale** (default) — a directory served over HTTP holding
  `latest.yml` and the installer. Empty means the built-in feed from
  `build.publish`. A LAN IP or a Tailscale name both work; `:port` is only
  needed when the server is not on 80.
- **Local folder or share** — the same two files in a folder, mapped drive or
  `\\server\share` this machine can already read. No web server and no port:
  ShellTab serves the directory to itself on a loopback port it picks.
  **Browse…** opens a folder picker.

The choice persists in `update-source.json` under the app's user-data directory.
A source saved by a pre-1.7.0 build (`github`) migrates to the default feed on
first launch.

Publishing is a copy of `latest.yml` plus the installer into the served
directory — `npm run publish:lan` builds and does exactly that:

```bash
install -m 644 -D dist/latest.yml dist/ShellTab-Setup-1.8.1.exe \
  dist/ShellTab-Setup-1.8.1.exe.blockmap -t /var/www/html/shelltab/
```

The NSIS artifact is named with hyphens (`ShellTab-Setup-1.8.1.exe`) to match
the URL `latest.yml` records; electron-builder's default spelling uses spaces
and made every HTTP check 404.

The rename matters for an HTTP feed: electron-builder writes the exe with
spaces but records the hyphenated name in `latest.yml`, so a plain web server
404s on it. Folder mode tries both spellings, so a directory copied straight
out of `dist/` works untouched.

## Installation

### From Source

```bash
git clone https://github.com/yourusername/shelltab.git
cd shelltab
npm install
npx electron-rebuild
npm start
```

### Build Installers

**Windows (NSIS installer):**
```bash
npm run dist:win
# Output: dist/ShellTab Setup x.x.x.exe
```

**Linux (AppImage + .deb):**
```bash
npm run dist:linux
# Output: dist/ShellTab-x.x.x.AppImage, dist/shelltab_x.x.x_amd64.deb
```

**Cross-compile Windows from Linux** (requires `wine`):
```bash
sudo apt install wine
npm run dist:win
```

## Architecture

```
shelltab/
  main.js              Electron main process (PTY management, FTP, saved hosts)
  sshmanager.js        Native SSH + SFTP backend (ssh2), host-key verification
  keepalive.js         Power-save blocker, SSH keepalive and anti-idle settings
  updater.js           electron-updater wiring against the LAN/folder feed
  smoketest.js         Headless UI test harness (not shipped)
  preload.js           Context bridge (IPC between main and renderer)
  renderer/
    index.html         UI layout
    app.js             Renderer logic (tabs, transports, dialogs, nudges)
    sftp.js            SFTP browser panel
    dialogs.js         In-app prompt/confirm (Electron has no window.prompt)
    suggest.js         Inline command suggestions (ghost text + history)
    shellint.js        Shell-integration bootstrap (OSC 7 cwd reporting)
    styles.css         Catppuccin Mocha theme
    bundle.js          esbuild output (generated)
    xterm.css          xterm styles (copied from node_modules)
  icon.png             App icon
  package.json         Config, scripts, and electron-builder settings
```

### Key Technologies
- **[Electron](https://www.electronjs.org/)** - Cross-platform desktop app shell
- **[xterm.js](https://xtermjs.org/)** - Terminal emulator component
- **[node-pty](https://github.com/nicknisi/node-pty)** - Native PTY bindings
- **[ssh2](https://github.com/mscdex/ssh2)** - Pure-JS SSH2 client and SFTP
- **[basic-ftp](https://github.com/patrickjuchli/basic-ftp)** - FTP/FTPS client
- **[esbuild](https://esbuild.github.io/)** - Fast JS bundler for the renderer
- **[electron-builder](https://www.electron.build/)** - Packaging and distribution
- **[electron-updater](https://www.electron.build/auto-update)** - In-app updates from a LAN, Tailscale or folder feed

### Security
- Renderer runs with `contextIsolation: true` and `nodeIntegration: false`
- A Content-Security-Policy is set in `index.html`: local assets only, no remote origins
- All main-process communication goes through a preload script using `contextBridge`
- Saved passwords are encrypted via `safeStorage` (DPAPI on Windows, libsecret on Linux)
- SSH host keys are pinned in `known-hosts.json`; a changed key raises a blocking warning
- Credentials never touch the terminal stream — they go straight to the SSH transport
- No remote content is loaded; all assets are local

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Build renderer and launch the app |
| `npm run build:renderer` | Bundle renderer JS with esbuild |
| `npm run rebuild` | Rebuild native modules for Electron |
| `npm run dist` | Build installer for current platform |
| `npm run dist:win` | Build Windows NSIS installer |
| `npm run dist:linux` | Build Linux AppImage + .deb |
| `npm run dist:all` | Build for all platforms |
| `npm run publish:lan` | Build the Windows installer and install `latest.yml` + the `.exe` into the served update directory |
| `npm run smoketest` | Headless end-to-end test of the SSH/SFTP UI (needs `xvfb` and an sshd on 127.0.0.1; the password-retry probe wants the `sttest` user described in `smoketest.js`) |

## Notes

`ssh2` pulls in the optional native module `cpu-features`, used only as an AES-NI
hint. ShellTab excludes it from packaged builds so Windows installs never need a
C++ toolchain — if `npm install` complains about it, the failure is safe to ignore.

Shell integration works by setting `PROMPT_COMMAND` / `precmd` on the remote host
so the shell reports its working directory via OSC 7. It targets bash and zsh; on
other shells the SFTP browser simply stops following and you navigate it by hand.
Turn it off per session in the connect dialog.

## License

MIT
