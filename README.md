# ShellTab

A cross-platform tabbed terminal emulator with built-in FTP client and timed nudge system. Built with Electron, xterm.js, and node-pty.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

### Tabbed Terminal
- Full PTY-backed terminal sessions with xterm.js rendering
- Catppuccin Mocha color theme
- Create, close, rename, and cycle through tabs
- Keyboard shortcuts: `Ctrl+T` (new tab), `Ctrl+W` (close tab), `Ctrl+Tab` / `Ctrl+Shift+Tab` (cycle tabs)
- Double-click a tab title to rename it
- Uses your default shell (bash/zsh on Linux, PowerShell/cmd on Windows)

### Built-in FTP Client
- Side panel FTP client with connect/browse/upload/download/delete
- FTPS (TLS) support
- Directory navigation with breadcrumb path bar
- Create remote directories
- File size display with human-readable formatting

### Saved Hosts
- After a successful FTP connection, ShellTab prompts to save the connection
- Passwords are encrypted at rest using the OS keychain (Electron `safeStorage` API)
- One-click reconnect from the saved hosts list
- Delete saved hosts when no longer needed

### SSH Host Detection
- When you SSH into a server from a terminal tab, ShellTab detects the hostname
- Opening the FTP panel auto-fills the host and username from the active SSH session
- Streamlines the workflow of SSHing in and then FTPing to the same server

### Timed Nudges
- Configure periodic actions on a per-tab or global (active tab) basis
- Two nudge types:
  - **Terminal input**: Sends text directly to the PTY (e.g., keep-alive commands, periodic `ls`, health checks)
  - **Overlay notification**: Displays a toast notification over the terminal without affecting the shell
- Configurable interval (in seconds)
- Pause, resume, and remove individual nudges

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
  preload.js           Context bridge (IPC between main and renderer)
  renderer/
    index.html         UI layout
    app.js             Renderer logic (tabs, FTP UI, nudges, SSH detection)
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
- **[basic-ftp](https://github.com/patrickjuchli/basic-ftp)** - FTP/FTPS client
- **[esbuild](https://esbuild.github.io/)** - Fast JS bundler for the renderer
- **[electron-builder](https://www.electron.build/)** - Packaging and distribution

### Security
- Renderer runs with `contextIsolation: true` and `nodeIntegration: false`
- All main-process communication goes through a preload script using `contextBridge`
- FTP passwords are encrypted via `safeStorage` (OS keychain / DPAPI on Windows / libsecret on Linux)
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

## License

MIT
