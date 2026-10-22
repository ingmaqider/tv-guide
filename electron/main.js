import { app, BrowserWindow, dialog, nativeTheme, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A fixed port keeps the page's origin, and with it the saved theme, the same between runs.
// If it's taken, the server falls back to any free port.
const PREFERRED_PORT = 47831;

let win = null;
let server = null;
let quitting = false;

// Settings (EPG_URL, PLAYLIST_URL) are read from .env in the data folder, so private links
// are never built into the package. Running from source, the project's .env is used if
// the data folder has none.
function envFile(data) {
  const own = path.join(data, '.env');
  const project = path.join(root, '.env');
  return !app.isPackaged && !fs.existsSync(own) && fs.existsSync(project) ? project : own;
}

// Runs server/index.js in a separate Node process so parsing the EPG never stalls the window.
// Data lives in ~/.config/TV Guide/; the server downloads the EPG there on first run.
function startServer() {
  const data = app.getPath('userData');
  return new Promise((resolve, reject) => {
    server = utilityProcess.fork(path.join(root, 'server', 'index.js'), [], {
      serviceName: 'TV Guide server',
      stdio: 'inherit',
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(PREFERRED_PORT),
        PORT_FALLBACK: '1',
        EPG_FILE: path.join(data, 'epg.xml'),
        FAVORITES_FILE: path.join(data, 'favorites.json'),
        PLAYLIST_FILE: path.join(data, 'playlist.json'),
        ENV_FILE: envFile(data),
        DIST_DIR: path.join(root, 'dist'),
      },
    });
    server.on('message', (msg) => {
      if (msg?.type === 'listening') resolve(msg.port);
    });
    server.on('exit', (code) => {
      reject(new Error(`The server stopped (exit code ${code}).`));
      if (!quitting) {
        dialog.showErrorBox('TV Guide', `The TV Guide server stopped unexpectedly (exit code ${code}).`);
        app.quit();
      }
    });
  });
}

function createWindow(port) {
  const origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1000,
    height: 850,
    minWidth: 360,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111317' : '#f5f6f8',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());

  // The window only ever shows the app itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });

  // Alt+Left / Alt+Right for back and forward, like in a browser.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.alt) return;
    const nav = win.webContents.navigationHistory;
    if (input.key === 'ArrowLeft' && nav.canGoBack()) nav.goBack();
    else if (input.key === 'ArrowRight' && nav.canGoForward()) nav.goForward();
    else return;
    event.preventDefault();
  });

  // Mouse back/forward buttons (Windows reports them as app commands).
  win.on('app-command', (event, command) => {
    const nav = win.webContents.navigationHistory;
    if (command === 'browser-backward' && nav.canGoBack()) nav.goBack();
    else if (command === 'browser-forward' && nav.canGoForward()) nav.goForward();
  });

  win.on('closed', () => {
    win = null;
  });
  win.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    try {
      createWindow(await startServer());
    } catch (err) {
      if (!quitting) {
        dialog.showErrorBox('TV Guide', `Could not start: ${err.message}`);
        app.quit();
      }
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
}
