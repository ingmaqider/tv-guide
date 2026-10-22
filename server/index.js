import express from 'express';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { Epg, findCurrent } from './epg.js';
import { Playlist } from './playlist.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Settings come from the environment, filled in from a .env file (see .env.example):
// ENV_FILE if set (the desktop app points it at its data folder), otherwise ./.env.
// Variables already set in the environment take precedence over the file.
const ENV_FILE = path.resolve(process.env.ENV_FILE || path.join(root, '.env'));
try {
  process.loadEnvFile(ENV_FILE);
} catch (err) {
  if (err.code === 'ENOENT') console.log(`No settings file at ${ENV_FILE}`);
  else console.error(`Failed to read ${ENV_FILE}:`, err.message);
}

const EPG_FILE = path.resolve(process.env.EPG_FILE || path.join(root, 'epg.xml'));
// The URLs are private (the playlist link carries an access token), so they have no defaults.
const EPG_URL = process.env.EPG_URL;
const PLAYLIST_URL = process.env.PLAYLIST_URL;
const VLC = process.env.VLC || findVlc();
const HOST = process.env.HOST || '127.0.0.1';
const FAVORITES_FILE = path.resolve(process.env.FAVORITES_FILE || path.join(root, 'favorites.json'));
// Last downloaded playlist, used when the playlist server can't be reached.
const PLAYLIST_FILE = path.resolve(process.env.PLAYLIST_FILE || path.join(root, 'playlist.json'));
const PORT = Number(process.env.PORT) || 3001;

// Favorites are a JSON array of channel ids in favorites.json; they don't depend on the EPG being loaded.
function readFavorites() {
  try {
    const ids = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read favorites:', err);
    return [];
  }
}

function writeFavorites(ids) {
  const tmp = `${FAVORITES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ids, null, 2));
  fs.renameSync(tmp, FAVORITES_FILE);
}

let favorites = readFavorites();

let epg = null;
let loadError = null;
// Bumped whenever a new EPG is swapped in, so clients know to refetch.
let version = 0;

const seconds = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Loads in stages: channel list, then favorites' schedules (so the Favorites tab is ready
// quickly), then everything else. With `publishEarly` each stage is served as soon as it's
// ready (startup); otherwise the current data keeps being served until the new one is complete.
async function load(file, { publishEarly }) {
  const t0 = Date.now();
  console.log(`Loading ${file}…`);
  const data = await Epg.open(file);
  if (publishEarly) {
    epg = data;
    loadError = null;
  }
  console.log(`Loaded ${data.channels.length} channels in ${seconds(t0)}`);
  await data.parseProgrammes(new Set(favorites));
  console.log(`Loaded ${favorites.length} favorite channels' programmes in ${seconds(t0)}`);
  await data.parseProgrammes();
  const count = [...data.programmes.values()].reduce((n, l) => n + l.length, 0);
  console.log(`Loaded all ${count} programmes in ${seconds(t0)}`);
  epg = data;
  loadError = null;
  version++;
}

const playlist = new Playlist(PLAYLIST_URL, PLAYLIST_FILE);
if (PLAYLIST_URL) playlist.refresh().catch((err) => console.error(err.message));
else console.log(`PLAYLIST_URL is not set in ${ENV_FILE}; Play buttons are disabled`);

const initialLoad = load(EPG_FILE, { publishEarly: true }).catch((err) => {
  loadError = err;
  if (err.code === 'ENOENT') console.log(`No EPG at ${EPG_FILE} yet; downloading it`);
  else console.error('Failed to load EPG:', err);
});

// No EPG yet (e.g. first run of the desktop app): download it.
initialLoad.then(() => {
  if (loadError?.code === 'ENOENT') runUpdate();
});

// "Update EPG": download the gzipped XMLTV, decompress it while downloading into a temp
// file, parse it, and only then swap it in and replace epg.xml. On failure the current file
// and data are left untouched.
let update = { state: 'idle', received: 0, total: null, error: null };
const updating = () => update.state === 'downloading' || update.state === 'processing';

async function runUpdate() {
  const tmp = `${EPG_FILE}.tmp`;
  update = { state: 'downloading', received: 0, total: null, error: null };
  try {
    if (!EPG_URL) throw new Error(`EPG_URL is not set. Add it to ${ENV_FILE} and restart.`);
    const res = await fetch(EPG_URL, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    update.total = Number(res.headers.get('content-length')) || null;
    const counter = new Transform({
      transform(chunk, enc, cb) {
        update.received += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, zlib.createGunzip(), fs.createWriteStream(tmp));

    update.state = 'processing';
    await initialLoad; // so the startup load can't overwrite the new data when it finishes
    await load(tmp, { publishEarly: false });
    fs.renameSync(tmp, EPG_FILE);
    // Refresh stream links too, so "Update EPG" brings everything up to date.
    if (PLAYLIST_URL) await playlist.refresh().catch((err) => console.error(err.message));
    update ={ state: 'done', received: update.received, total: update.total, error: null };
    console.log('EPG updated');
  } catch (err) {
    console.error('EPG update failed:', err);
    fs.rmSync(tmp, { force: true });
    update = { ...update, state: 'error', error: err.message || String(err) };
  }
}

const app = express();

// Requests that change something must carry this header. Browsers won't send a custom
// header cross-origin without a CORS preflight (which we never approve), so other websites
// can't make this local server launch VLC or downloads.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-TV-Guide') !== '1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

const epgStatus = () => ({ version, ready: !!epg?.complete, update });

app.get('/api/epg', (req, res) => {
  res.json(epgStatus());
});

app.post('/api/epg/update', (req, res) => {
  const busy = updating();
  if (!busy) runUpdate();
  res.status(busy ? 409 : 202).json(epgStatus());
});

// Lets the UI explain missing Play buttons. Polling it also drives the retries while the
// playlist server is unreachable.
app.get('/api/playlist', (req, res) => {
  playlist.ensureFresh();
  res.json(playlist.status());
});

app.get('/api/favorites', (req, res) => {
  res.json(favorites);
});

app.put('/api/favorites/:id', (req, res) => {
  if (!favorites.includes(req.params.id)) {
    favorites = [...favorites, req.params.id];
    writeFavorites(favorites);
  }
  res.json(favorites);
});

app.delete('/api/favorites/:id', (req, res) => {
  if (favorites.includes(req.params.id)) {
    favorites = favorites.filter((id) => id !== req.params.id);
    writeFavorites(favorites);
  }
  res.json(favorites);
});

// 503 tells the client the data it asked for is still being parsed and to retry.
const notReady = (res) => res.status(503).json({ loading: true });

app.use('/api', (req, res, next) => {
  if (loadError && !updating()) {
    // No EPG at all: if the download attempt failed, its reason is the more useful message.
    const message = update.state === 'error' ? update.error : String(loadError.message || loadError);
    return res.status(500).json({ error: message });
  }
  if (!epg) return notReady(res);
  next();
});

// `playable`: the channel is in the playlist, so the UI can offer a Play button.
app.get('/api/channels', async (req, res) => {
  await playlist.ensureFresh();
  res.json(epg.channels.map((ch) => ({ ...ch, playable: !!playlist.lookup(ch) })));
});

// ?favorites=1 limits the result to favorite channels, which are available before the rest.
app.get('/api/now', async (req, res) => {
  const onlyFavorites = req.query.favorites !== undefined;
  const ids = onlyFavorites && new Set(favorites);
  if (onlyFavorites ? !favorites.every((id) => epg.isLoaded(id)) : !epg.complete) return notReady(res);
  await playlist.ensureFresh();

  const now = Date.now();
  const strip = (p) => p && { start: p.start, stop: p.stop, title: p.title };
  const channels = ids ? epg.channels.filter((ch) => ids.has(ch.id)) : epg.channels;
  res.json({
    time: now,
    channels: channels.map((ch) => {
      const list = epg.programmesOf(ch.id);
      const i = findCurrent(list, now);
      const nextIndex = i >= 0 ? i + 1 : list.findIndex((p) => p.start > now);
      return {
        ...ch,
        playable: !!playlist.lookup(ch),
        current: i >= 0 ? strip(list[i]) : null,
        next: nextIndex >= 0 ? strip(list[nextIndex]) || null : null,
      };
    }),
  });
});

// On Linux vlc is on the PATH. On Windows it usually isn't, so look where the VLC installer
// puts it (the registry records the install dir; fall back to the default folders).
function findVlc() {
  if (process.platform !== 'win32') return 'vlc';
  for (const key of ['HKLM\\SOFTWARE\\VideoLAN\\VLC', 'HKLM\\SOFTWARE\\WOW6432Node\\VideoLAN\\VLC']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'InstallDir'], { encoding: 'utf8', windowsHide: true });
      const dir = /InstallDir\s+REG_\w+\s+(.+)/.exec(out)?.[1]?.trim();
      if (dir && fs.existsSync(path.join(dir, 'vlc.exe'))) return path.join(dir, 'vlc.exe');
    } catch {
      // Key not present; try the next one.
    }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    const exe = base && path.join(base, 'VideoLAN', 'VLC', 'vlc.exe');
    if (exe && fs.existsSync(exe)) return exe;
  }
  return 'vlc.exe';
}

// Inside the AppImage, library paths point into the app bundle; VLC must use the system's.
function vlcEnv() {
  const env = { ...process.env };
  if (env.APPIMAGE) {
    for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'GIO_MODULE_DIR', 'GDK_PIXBUF_MODULE_FILE', 'GSETTINGS_SCHEMA_DIR']) {
      delete env[key];
    }
  }
  for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_')) delete env[key];
  return env;
}

app.get('/api/channels/:id', async (req, res) => {
  const channel = epg.channels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!epg.isLoaded(channel.id)) return notReady(res);
  res.json({
    channel,
    playable: !!(await playlist.streamFor(channel)),
    programmes: epg.programmesOf(channel.id).map((p) => ({
      start: p.start,
      stop: p.stop,
      title: p.title,
      ...epg.details(p),
    })),
  });
});

// Opens the channel's stream in VLC on this machine. --one-instance reuses an open VLC
// window instead of starting a new one per click. The stream URL (which carries the
// playlist's access token) never leaves the server.
app.post('/api/channels/:id/play', async (req, res) => {
  const channel = epg.channels.find((c) => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const url = await playlist.streamFor(channel);
  if (!url) return res.status(404).json({ error: 'This channel is not in the playlist' });

  const vlc = spawn(VLC, ['--one-instance', `--meta-title=${channel.name}`, url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: vlcEnv(),
  });
  vlc.once('error', (err) => {
    console.error('Failed to start VLC:', err);
    res.status(500).json({ error: `Could not start VLC (${err.code || err.message})` });
  });
  vlc.once('spawn', () => {
    vlc.unref();
    res.json({ ok: true });
  });
});

// Serve the built frontend (npm run build) if present.
const dist = path.resolve(process.env.DIST_DIR || path.join(root, 'dist'));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Localhost only by default: the API can launch VLC and download files on this machine.
// With PORT_FALLBACK (desktop app), a busy port falls back to any free one.
function listen(port) {
  const server = app.listen(port, HOST, () => {
    const actual = server.address().port;
    console.log(`API listening on http://${HOST}:${actual}`);
    // Running as an Electron utility process: tell the main process where to load from.
    process.parentPort?.postMessage({ type: 'listening', port: actual });
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && process.env.PORT_FALLBACK && port !== 0) listen(0);
    else throw err;
  });
}

listen(PORT);
