import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { Epg, findCurrent } from './epg.js';
import { Playlist, isExtra } from './playlist.js';
import { LlamaServer, findModel, findServer, splitArgs } from './llama.js';
import { Events } from './events.js';
import { MAX_WISH, readPrompt, recommend } from './recommend.js';
import { Remote } from './remote.js';
import { MAX_VOLUME, Vlc } from './vlc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

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
const LAST_PLAYED_FILE = path.resolve(process.env.LAST_PLAYED_FILE || path.join(root, 'last-played.json'));
// How to reach the VLC window this app opened (port, password, URLs played): see vlc.js.
const VLC_STATE_FILE = path.resolve(process.env.VLC_STATE_FILE || path.join(root, 'vlc.json'));
const PORT = Number(process.env.PORT) || 3001;
// Phone access (see remote.js): a fixed port, so the phone only needs this computer's IP.
const REMOTE_FILE = path.resolve(process.env.REMOTE_FILE || path.join(root, 'remote.json'));
const REMOTE_PORT = Number(process.env.REMOTE_PORT) || 47832;
const REMOTE_HOST = process.env.REMOTE_HOST || '0.0.0.0';
// How often the server asks VLC what it's doing while a UI is open, to push changes.
const PLAYER_POLL_MS = 1500;
// Retries for an unreachable playlist server while a UI is open (see playlist.ensureFresh).
const PLAYLIST_CHECK_MS = 30000;
// Decision model for "Recommend": llama.cpp's llama-server running a decision model (its
// /v1/systemone endpoint). LLM_URL points at one that's already running, possibly on
// another machine on the LAN. Without it, the app starts its own llama-server if it finds
// a model: LLM_MODEL_FILE, or the first .gguf in MODELS_DIR or the llama.cpp folder.
const LLM_URL = process.env.LLM_URL;
// llama.cpp bundled with the app (vendor/llama/<os>/ when running from source).
const LLAMA_DIR = path.resolve(process.env.LLAMA_DIR || path.join(root, 'vendor', 'llama', process.platform === 'win32' ? 'win' : process.platform));
const MODELS_DIR = path.resolve(process.env.MODELS_DIR || path.join(root, 'models'));
const LLM_MODEL_FILE = LLM_URL ? null : findModel(process.env.LLM_MODEL_FILE, [MODELS_DIR, LLAMA_DIR]);
const LLM_MODEL = process.env.LLM_MODEL;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_TIMEOUT_MS = (Number(process.env.LLM_TIMEOUT) || 120) * 1000;
// Which channels Recommend considers; the UI picks one per request.
const RECOMMEND_SCOPES = {
  favorites: 'your favorite channels',
  playable: 'playable channels',
  all: 'any channel',
};
const RECOMMEND_BATCH = Number(process.env.RECOMMEND_BATCH) || 16;
const RECOMMEND_PARALLEL = Number(process.env.LLM_PARALLEL) || 1;
const llama = LLM_MODEL_FILE
  ? new LlamaServer({
      bin: findServer(process.env.LLAMA_SERVER, LLAMA_DIR),
      model: path.resolve(LLM_MODEL_FILE),
      parallel: RECOMMEND_PARALLEL,
      ctx: Number(process.env.LLAMA_CTX) || 40960,
      extraArgs: splitArgs(process.env.LLAMA_ARGS),
    })
  : null;
const RECOMMEND_DESC_CHARS = Number(process.env.RECOMMEND_DESC_CHARS) || 600;
const RECOMMEND_PROMPT_FILE = path.resolve(process.env.RECOMMEND_PROMPT_FILE || path.join(root, 'recommend-prompt.txt'));
const DEFAULT_PROMPT_FILE = path.join(root, 'server', 'recommend-prompt.txt');

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

// The channel Play was last clicked on ({ id, at }), for the prompt's {{last_played}}. What
// VLC is actually playing comes from VLC (GET /api/player).
function readLastPlayed() {
  try {
    const { id, at } = JSON.parse(fs.readFileSync(LAST_PLAYED_FILE, 'utf8'));
    return typeof id === 'string' ? { id, at } : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read last played channel:', err);
    return null;
  }
}

let lastPlayed = readLastPlayed();

function setLastPlayed(id) {
  lastPlayed = { id, at: Date.now() };
  try {
    const tmp = `${LAST_PLAYED_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lastPlayed));
    fs.renameSync(tmp, LAST_PLAYED_FILE);
  } catch (err) {
    console.error('Failed to save last played channel:', err);
  }
}

let epg = null;
let loadError = null;
// Bumped whenever a new EPG is swapped in, so clients know to refetch.
let version = 0;

// State pushed to the open UIs (see events.js). The getters only run once a client is
// connected, by which time everything they use below is defined.
const events = new Events({
  player: { get: () => playerStatus() },
  favorites: { get: () => favorites },
  epg: { get: () => epgStatus() },
  playlist: { get: () => playlist.status() },
  recommend: { get: () => rec },
  remote: { get: () => remote.state(), localOnly: true },
});
events.startHeartbeat();

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
  events.publish('epg');
}

const playlist = new Playlist(PLAYLIST_URL, PLAYLIST_FILE);
playlist.onChange = () => events.publish('playlist');
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
  // Download progress for the open UIs, a couple of times a second rather than per chunk.
  events.publish('epg');
  const progress = setInterval(() => events.publish('epg'), 500);
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
  } finally {
    clearInterval(progress);
    events.publish('epg');
  }
}

const app = express();

// Requests through the phone listener (remote.js sets req.viaLan). Pages and the pairing
// calls are open; the rest of the API needs a paired device.
const LAN_OPEN = new Set(['/api/hello', '/api/pair']);
// The phone types an IP address. Any other Host means a DNS name pointed at this machine,
// which is how another website could reach the listener (DNS rebinding).
const IP_HOST = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;

app.use((req, res, next) => {
  if (!req.viaLan) return next();
  if (!IP_HOST.test(req.headers.host || '')) return res.status(403).json({ error: 'Connect using the IP address' });
  req.device = remote.deviceFor(req);
  if (!req.path.startsWith('/api/') || req.device || LAN_OPEN.has(req.path)) return next();
  res.status(401).json({ error: 'This device is not paired with TV Guide', pair: true });
});

// Phone access settings and pairing answers: from the desktop only, never from a phone.
const localOnly = (req, res, next) => (req.viaLan ? res.status(404).json({ error: 'Not found' }) : next());

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

// Identifies the server to the phone app (is this TV Guide, and is this phone paired?).
app.get('/api/hello', (req, res) => {
  res.json({
    app: 'tv-guide',
    version: APP_VERSION,
    remote: !!req.viaLan,
    paired: !req.viaLan || !!req.device,
    device: req.device?.name ?? null,
  });
});

// "Unpair" on the phone: removes this phone on the computer too, as Remove in the desktop's
// Phone panel does. Its open sockets close with 4401, which shows the pairing screen.
app.post('/api/unpair', (req, res) => {
  if (!req.viaLan) return res.status(400).json({ error: 'Only phones are paired' });
  remote.revoke(req.device.id);
  events.disconnect((info) => info.deviceId === req.device.id);
  res.setHeader('Set-Cookie', remote.clearCookie());
  res.json({ paired: false });
});

// A phone asks to be paired and waits until it's allowed or denied on the desktop. With the
// `code` from the QR code shown on the desktop, it's paired straight away.
app.post('/api/pair', express.json({ limit: '1kb' }), async (req, res) => {
  if (!req.viaLan) return res.status(400).json({ error: 'Only phones need pairing' });
  if (req.device) return res.json({ paired: true });
  if (req.body?.code !== undefined) {
    const cookie = remote.pairWithCode(req.body.code, req.body.name, req.socket.remoteAddress?.replace(/^::ffff:/, ''));
    if (!cookie) {
      return res.status(403).json({ error: 'This QR code has expired or was already used. Open Phone in TV Guide on the computer and scan the new code.' });
    }
    res.setHeader('Set-Cookie', cookie);
    return res.json({ paired: true });
  }
  const gaveUp = new AbortController();
  res.on('close', () => gaveUp.abort());
  const cookie = await remote.pair(req.body?.name, req.socket.remoteAddress?.replace(/^::ffff:/, ''), gaveUp.signal);
  if (gaveUp.signal.aborted) return;
  if (!cookie) return res.status(403).json({ error: 'Pairing was declined on the computer, or nobody answered.' });
  res.setHeader('Set-Cookie', cookie);
  res.json({ paired: true });
});

app.get('/api/remote', localOnly, (req, res) => {
  res.json(remote.state());
});

app.put('/api/remote', localOnly, express.json({ limit: '1kb' }), async (req, res) => {
  const on = !!req.body?.enabled;
  await remote.setEnabled(on);
  if (!on) events.disconnect((info) => !info.local);
  res.json(remote.state());
});

app.post('/api/remote/pairings/:id', localOnly, express.json({ limit: '1kb' }), (req, res) => {
  if (!remote.answer(req.params.id, !!req.body?.allow)) {
    return res.status(404).json({ error: 'That phone is no longer waiting' });
  }
  res.json(remote.state());
});

// The QR code: a new one while the Phone panel is open (and after one expires or is used),
// none once it closes.
app.post('/api/remote/code', localOnly, (req, res) => {
  if (!remote.server) return res.status(409).json({ error: 'Phone access is off' });
  remote.newCode();
  res.json(remote.state());
});

app.delete('/api/remote/code', localOnly, (req, res) => {
  remote.clearCode();
  res.json(remote.state());
});

app.delete('/api/remote/devices/:id', localOnly, (req, res) => {
  if (remote.revoke(req.params.id)) events.disconnect((info) => info.deviceId === req.params.id);
  res.json(remote.state());
});

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

// Downloads the playlist now (the phone's "Refresh playlist"); answers with its status.
app.post('/api/playlist/refresh', async (req, res) => {
  if (!PLAYLIST_URL) return res.status(400).json({ error: `PLAYLIST_URL is not set in ${ENV_FILE}` });
  await playlist.refresh().catch(() => {}); // the error is in status()
  res.json(playlist.status());
});

// Which optional features are set up, so the UI can hide the rest. `remote`: the page is
// open on a phone, which gets the volume and playlist controls.
app.get('/api/config', (req, res) => {
  res.json({ recommend: !!(LLM_URL || llama), playlist: playlist.status().configured, remote: !!req.viaLan });
});

app.get('/api/favorites', (req, res) => {
  res.json(favorites);
});

app.put('/api/favorites/:id', (req, res) => {
  if (!favorites.includes(req.params.id)) {
    favorites = [...favorites, req.params.id];
    writeFavorites(favorites);
    events.publish('favorites');
  }
  res.json(favorites);
});

app.delete('/api/favorites/:id', (req, res) => {
  if (favorites.includes(req.params.id)) {
    favorites = favorites.filter((id) => id !== req.params.id);
    writeFavorites(favorites);
    events.publish('favorites');
  }
  res.json(favorites);
});

// Recommend runs as one job on the server, shared by every open UI: started on the phone,
// it shows on the desktop too, either can stop it, and a phone locking its screen (which
// drops its connections) doesn't stop it. Progress and the result arrive as the
// `recommend` event. `id` changes with each run so the UIs can tell a new one.
let rec = { id: 0, status: 'idle' };
let recAbort = null;

function setRec(patch) {
  rec = { ...rec, ...patch };
  events.publish('recommend');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits (stoppable) until the data for `scope` is parsed and the model is up.
async function recommendReady(scope, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (loadError && !updating()) throw new Error(String(loadError.message || loadError));
    const dataReady = epg && (scope === 'favorites' ? favoritesLoaded() : epg.complete);
    const endpoint = llama ? llama.endpoint() : { url: LLM_URL, apiKey: LLM_API_KEY };
    if (dataReady && endpoint) return endpoint;
    const message = dataReady ? 'Loading the model…' : 'Loading the TV guide…';
    if (rec.message !== message) setRec({ message });
    await sleep(1000);
  }
}

// Ranks what's on now with the decision model. `scope` picks the channels: favorites (the
// default, a few model calls), playable (in the playlist) or all in the EPG (many calls).
async function runRecommend(wish, scope, signal) {
  const endpoint = await recommendReady(scope, signal);
  if (scope !== 'favorites') await playlist.ensureFresh();

  const now = Date.now();
  const ids = new Set(favorites);
  const wanted = (channel) =>
    scope === 'all' || (scope === 'favorites' ? ids.has(channel.id) : !!playlist.lookup(channel));
  const candidates = [];
  for (const channel of epg.channels) {
    if (!wanted(channel)) continue;
    const list = epg.programmesOf(channel.id);
    const p = list[findCurrent(list, now)];
    if (p) candidates.push({ channel, programme: { start: p.start, stop: p.stop, title: p.title, ...epg.details(p) } });
  }
  if (!candidates.length) {
    const hint = scope === 'favorites' ? ' Add favorites with ☆ first.' : '';
    throw new Error(`Nothing is on now on ${RECOMMEND_SCOPES[scope]}.${hint}`);
  }

  setRec({ message: null });
  const prompt = readPrompt(RECOMMEND_PROMPT_FILE, DEFAULT_PROMPT_FILE);
  const names = new Map([...epg.channels, ...extras()].map((ch) => [ch.id, ch.name]));
  const result = await recommend({
    ...endpoint,
    model: LLM_MODEL,
    prompt,
    candidates,
    batchSize: RECOMMEND_BATCH,
    parallel: RECOMMEND_PARALLEL,
    descChars: RECOMMEND_DESC_CHARS,
    favorites: favorites.map((id) => names.get(id)).filter(Boolean),
    lastPlayed: lastPlayed && names.get(lastPlayed.id),
    wish,
    timeoutMs: LLM_TIMEOUT_MS,
    signal,
    onProgress: (done, total) => {
      if (done < total) setRec({ message: `Asking the model… ${done} of ${total} calls done` });
    },
  });
  return {
    model: result.model,
    promptFile: RECOMMEND_PROMPT_FILE,
    request: result.request,
    considered: candidates.length,
    eliminated: result.eliminated,
    calls: result.calls,
    ranked: result.ranked.map(({ channel, programme, probability }) => ({
      id: channel.id,
      name: channel.name,
      icon: channel.icon,
      playable: !!playlist.lookup(channel),
      programme: { start: programme.start, stop: programme.stop, title: programme.title },
      probability,
    })),
  };
}

async function startRecommend(wish, scope) {
  const abort = new AbortController();
  recAbort = abort;
  const startedAt = Date.now();
  const seconds = () => Math.round((Date.now() - startedAt) / 1000);
  rec = { id: rec.id + 1, status: 'running', wish, scope, startedAt, message: null, result: null, error: null, seconds: null };
  events.publish('recommend');
  try {
    const result = await runRecommend(wish, scope, abort.signal);
    setRec({ status: 'done', result, message: null, seconds: seconds() });
  } catch (err) {
    if (abort.signal.aborted) {
      console.log('Recommend stopped');
      setRec({ status: 'stopped', message: null, seconds: seconds() });
    } else {
      console.error('Recommend failed:', err.message);
      setRec({ status: 'error', message: null, error: err.message });
    }
  } finally {
    if (recAbort === abort) recAbort = null;
  }
}

// Starts a run; 409 while one is running. POST because each run costs model calls.
app.post('/api/recommend', express.json({ limit: '16kb' }), (req, res) => {
  if (!LLM_URL && !llama) {
    return res.status(400).json({ error: `No model set up. Add LLM_URL or LLM_MODEL_FILE to ${ENV_FILE} and restart.` });
  }
  // What the viewer typed for this request ("something funny"); fills {{wish}}.
  const wish = typeof req.body?.wish === 'string' ? req.body.wish.replace(/\s+/g, ' ').trim() : '';
  if (wish.length > MAX_WISH) return res.status(400).json({ error: `Keep the wish under ${MAX_WISH} characters.` });
  const scope = req.body?.scope ?? 'favorites';
  if (!Object.hasOwn(RECOMMEND_SCOPES, scope)) return res.status(400).json({ error: `Unknown scope "${scope}".` });
  if (rec.status === 'running') return res.status(409).json({ error: 'A recommendation is already running.' });
  startRecommend(wish, scope);
  res.status(202).json(rec);
});

app.get('/api/recommend', (req, res) => {
  res.json(rec);
});

// Stop, from whichever UI.
app.delete('/api/recommend', (req, res) => {
  recAbort?.abort();
  res.json(rec);
});

// 503 tells the client the data it asked for is still being parsed and to retry.
const notReady = (res) => res.status(503).json({ loading: true });

// Playlist channels the EPG doesn't have, as the API shows them (without the stream URL).
const extras = () => playlist.extras(epg.channels).map(({ url, ...ch }) => ({ ...ch, playable: true, noGuide: true }));
// An EPG channel, or a playlist-only one (which carries its `url`: keep it on the server).
const findChannel = (id) =>
  epg.channels.find((c) => c.id === id) || (isExtra(id) ? playlist.extra(epg.channels, id) : null);
const streamOf = async (channel) => (isExtra(channel.id) ? channel.url : playlist.streamFor(channel));
// Favorites' schedules are parsed; playlist-only favorites have none to wait for.
const favoritesLoaded = () => favorites.every((id) => isExtra(id) || epg.isLoaded(id));

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
  res.json([...epg.channels.map((ch) => ({ ...ch, playable: !!playlist.lookup(ch) })), ...extras()]);
});

// ?favorites=1 limits the result to favorite channels, which are available before the rest.
app.get('/api/now', async (req, res) => {
  const onlyFavorites = req.query.favorites !== undefined;
  const ids = onlyFavorites && new Set(favorites);
  if (onlyFavorites ? !favoritesLoaded() : !epg.complete) return notReady(res);
  await playlist.ensureFresh();

  const now = Date.now();
  const strip = (p) => p && { start: p.start, stop: p.stop, title: p.title };
  const channels = ids ? epg.channels.filter((ch) => ids.has(ch.id)) : epg.channels;
  res.json({
    time: now,
    channels: [
      ...channels.map((ch) => {
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
      // Playlist-only channels go last: there's nothing on them to show.
      ...extras()
        .filter((ch) => !ids || ids.has(ch.id))
        .map((ch) => ({ ...ch, current: null, next: null })),
    ],
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
  await playlist.ensureFresh();
  const channel = findChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (isExtra(channel.id)) {
    const { url, ...rest } = channel;
    return res.json({ channel: rest, playable: true, noGuide: true, programmes: [] });
  }
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

const vlc = new Vlc({ bin: VLC, env: vlcEnv(), stateFile: VLC_STATE_FILE });

// What the VLC window this app opened is doing, with the channel and its programme now.
async function playerStatus() {
  const { state, channelId, volume } = await vlc.status();
  const channel = channelId && epg && findChannel(channelId);
  if (!channel) return { state, channel: null, volume };
  const list = !isExtra(channel.id) && epg.isLoaded(channel.id) ? epg.programmesOf(channel.id) : [];
  const p = list[findCurrent(list, Date.now())];
  return {
    state,
    volume,
    channel: { id: channel.id, name: channel.name, icon: channel.icon },
    programme: p ? { start: p.start, stop: p.stop, title: p.title } : null,
  };
}

// The last player state pushed to the UIs: the poll below only publishes changes.
let lastPlayer = '';
async function publishPlayer(status) {
  const s = status || (await playerStatus());
  const json = JSON.stringify(s);
  if (json === lastPlayer) return s;
  lastPlayer = json;
  events.publish('player', s);
  return s;
}

app.get('/api/player', async (req, res) => {
  res.json(await playerStatus());
});

// { value } in percent (0 to MAX_VOLUME). Only the phone shows a volume control.
app.post('/api/player/volume', express.json({ limit: '1kb' }), async (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isFinite(value)) return res.status(400).json({ error: 'value must be a number' });
  if (!(await vlc.setVolume(value))) return res.status(409).json({ error: 'VLC is not open' });
  res.json(await publishPlayer());
});

app.post('/api/player/:command', async (req, res) => {
  if (!['pause', 'stop'].includes(req.params.command)) return res.status(404).json({ error: 'Unknown command' });
  if (!(await vlc.command(req.params.command))) return res.status(409).json({ error: 'VLC is not open' });
  res.json(await publishPlayer());
});

// Opens the channel's stream in VLC on this machine, in the window opened earlier if it's
// still there. The stream URL (which carries the playlist's access token) never leaves
// the server.
app.post('/api/channels/:id/play', async (req, res) => {
  await playlist.ensureFresh();
  const channel = findChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const url = await streamOf(channel);
  if (!url) return res.status(404).json({ error: 'This channel is not in the playlist' });

  try {
    await vlc.play(url, channel.id, channel.name);
  } catch (err) {
    console.error('Failed to start VLC:', err);
    return res.status(500).json({ error: `Could not start VLC (${err.code || err.message})` });
  }
  setLastPlayed(channel.id);
  res.json(await publishPlayer());
});

// Serve the built frontend (npm run build) if present.
const dist = path.resolve(process.env.DIST_DIR || path.join(root, 'dist'));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// WebSocket connections to /api/events, from either listener. Browsers send Origin on
// WebSockets and CORS doesn't apply to them, so a page from another site is turned away
// here. Phones must be paired, like for the rest of the API.
function upgrade(req, socket, head) {
  if (new URL(req.url, 'http://x').pathname !== '/api/events') return rejectUpgrade(socket, 404, 'Not Found');
  const { origin, host } = req.headers;
  if (origin && URL.canParse(origin) && new URL(origin).host !== host) return rejectUpgrade(socket, 403, 'Forbidden');
  if (!req.viaLan) return events.accept(req, socket, head, { local: true, deviceId: null });
  if (!IP_HOST.test(host || '')) return rejectUpgrade(socket, 403, 'Forbidden');
  const device = remote.deviceFor(req);
  if (!device) return rejectUpgrade(socket, 401, 'Unauthorized');
  events.accept(req, socket, head, { local: false, deviceId: device.id });
}

const remote = new Remote({
  file: REMOTE_FILE,
  host: REMOTE_HOST,
  port: REMOTE_PORT,
  handler: app,
  onUpgrade: upgrade,
  onChange: () => events.publish('remote'),
  // The desktop window flashes so a request isn't missed while it's in the background.
  onPairing: ({ name }) => process.parentPort?.postMessage({ type: 'pairing', name }),
});
remote.apply();

// While a UI is open the server watches VLC (and retries an unreachable playlist server)
// and pushes changes, instead of every UI polling.
// `watching` counts watch loops started: a loop whose number is no longer current (the last
// client left, maybe while it was waiting on VLC) stops.
let watchTimer = null;
let watching = 0;
events.onFirstClient = () => {
  const loop = ++watching;
  let lastPlaylistCheck = 0;
  const tick = async () => {
    await publishPlayer().catch((err) => console.error('Failed to get player status:', err.message));
    if (Date.now() - lastPlaylistCheck > PLAYLIST_CHECK_MS) {
      lastPlaylistCheck = Date.now();
      playlist.ensureFresh();
    }
    if (loop === watching) watchTimer = setTimeout(tick, PLAYER_POLL_MS);
  };
  watchTimer = setTimeout(tick, 0);
};
events.onLastClient = () => {
  watching++;
  clearTimeout(watchTimer);
  lastPlayer = '';
};

// Localhost only: the API can launch VLC and download files on this machine. Phones reach
// it through the separate, paired-only listener in remote.js.
// With PORT_FALLBACK (desktop app), a busy port falls back to any free one.
function listen(port) {
  const server = app.listen(port, HOST, () => {
    const actual = server.address().port;
    console.log(`API listening on http://${HOST}:${actual}`);
    // Running as an Electron utility process: tell the main process where to load from.
    process.parentPort?.postMessage({ type: 'listening', port: actual });
  });
  server.on('upgrade', upgrade);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && process.env.PORT_FALLBACK && port !== 0) listen(0);
    else throw err;
  });
}

listen(PORT);

// Loading the model takes a while, so it starts with the app rather than on first use.
llama?.start();

// Don't leave llama-server running (and holding GPU memory) after the app. The desktop app
// asks with a message: on Windows, killing this process wouldn't run any handler.
const shutdown = () => {
  llama?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.parentPort?.on('message', (e) => e.data?.type === 'quit' && shutdown());
