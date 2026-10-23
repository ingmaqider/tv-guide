# AGENTS.md

Notes for coding agents working on this repo. User-facing docs are in README.md.

## Architecture

- `server/` — Express API (plain Node ESM, no build step). Serves `dist/` too.
  - `epg.js` — XMLTV parser. Reads the whole file into a Buffer and scans tags by byte
    offset (no XML library: sax took 13 s, this takes ~1.5 s for the 225 MB file).
    Programmes keep only start/stop/title + offsets; `details()` decodes desc/icon on demand.
    Parsing runs in passes (`parseProgrammes(ids)`) and yields to the event loop.
  - `index.js` — settings, staged loading (channels → favorites' programmes → the rest),
    EPG update (download → gunzip to `epg.xml.tmp` → parse → swap → rename), favorites,
    the player routes, the last-played channel (`last-played.json`, set on Play; used by
    the prompt's `{{last_played}}`),
    static files.
  - `playlist.js` — M3U parsing and channel matching: tvg-id, then the channel id in the
    stream URL (`/<id>/index.m3u8`, this provider's format), then normalized name.
    Each download is saved to `playlist.json` (PLAYLIST_FILE) and loaded at startup, so an
    unreachable playlist server keeps the last list. Refreshes run in the background once
    something is loaded; `GET /api/playlist` reports the last error, which `PlaylistNotice`
    shows (it also calls `reloadAll()` when the list changes so Play buttons appear).
  - `vlc.js` — the VLC window the app opens, through VLC's HTTP interface (started with
    `--extraintf=http`, a free 127.0.0.1 port, a random password, `--no-one-instance`).
    Play reuses the window (`in_play`), else starts a new one. `GET /api/player` maps the
    current item's URL back to a channel; `POST /api/player/pause|stop`. VLC applies
    switches and stops after a second or two, so `status()` reports the expected state
    until it does. Port, password and played URLs are saved in `vlc.json` (0600: URLs carry
    the token) so a restarted app reconnects to a VLC that's still open.
  - `recommend.js` — "Recommend": fills the prompt template (`readPrompt`, re-read per
    request; sections `[state]`, `[instructions]`, `[option]`; `{{name}}` plus
    `{{#name}}…{{/name}}` / `{{^name}}…{{/name}}` blocks, unknown names throw; `{{wish}}`
    is the text typed in the panel, POSTed as `{ wish, scope }`; scope is favorites
    (default), playable or all, chosen in the panel) into one `choice` question
    for llama-server's `/v1/systemone` (decision models such as H2O Lightning; not chat
    completions). Option keys are channel names; strings are NFC-normalized. More
    candidates than `RECOMMEND_BATCH` run as knockout rounds.
  - `llama.js` — runs llama-server as a child process when `LLM_URL` isn't set and a model
    is found (`LLM_MODEL_FILE`, `MODELS_DIR`): free 127.0.0.1 port, random API key, waits on
    `/health`, restarts after a crash on the next request. Stopped on SIGTERM/SIGINT or a
    `{type:'quit'}` message from Electron (needed on Windows, where kill runs no handlers).
    The binary comes from `LLAMA_DIR` (`vendor/llama/<os>/`, packaged as `resources/llama`
    via `extraResources`), `LLAMA_SERVER` or PATH.
- `src/` — React 18 + react-router 6 (data router), built by Vite. No state library.
  - `api.js` — `useApi` (per-URL cache, polling, `reloadAll()`), `send()` for mutations.
  - `favorites.jsx`, `player.jsx` (polls `/api/player`; `NowPlaying` bar), `recommend.jsx` — app-wide state as small context
    providers (above the router, so it survives navigation).
- `electron/main.js` — runs `server/index.js` in a `utilityProcess` and loads the UI from
  it over http://127.0.0.1. Settings and data live in `app.getPath('userData')`.

## Conventions and invariants

- **No private links in code.** EPG_URL and PLAYLIST_URL come only from the environment /
  `.env` (`process.loadEnvFile`). Never add defaults, and never commit `.env`. Packages must
  not contain them (check `release/*/resources/app.asar` with grep after building).
- **Mutating requests need `X-TV-Guide: 1`** (use `send()` in `src/api.js`). The server
  rejects others with 403; this blocks other websites from driving the local API (it can
  launch VLC). Keep the server bound to 127.0.0.1 by default.
- **503 means "not loaded yet, retry".** `fetchJson` retries on 503. Endpoints return 503
  until the data they need is parsed (`epg.isLoaded(id)` / `epg.complete`).
- **Stream URLs never reach the browser.** The API exposes only `playable: boolean`.
  `playlist.json` holds them with the token: written with mode 0600 and git-ignored.
- **Scroll restoration depends on the `useApi` cache**: a list must render synchronously
  from cache when navigating back. Don't add loading states that blank cached data.
- Search state lives in the URL (`?q=`), set with `replace` + `preventScrollReset`.
- Match the existing style: small components, short comments explaining *why*, CSS
  variables in `src/styles.css` (light default, dark via media query and `data-theme`).

## Commands

See README.md. `npm run dev` for development, `npm run app` for the desktop app,
`npm run dist` / `npm run dist:win` for packages (Windows needs Wine).

## Testing

There is no test suite. Verify changes by running the app:

- Server: `PORT=3099 EPG_FILE=... FAVORITES_FILE=... node server/index.js`, then curl the
  API. Use copies of `epg.xml` / `favorites.json` so real data isn't modified.
- UI: drive the built app (`npm run build` + `npm start`) with Playwright.
- VLC: set `VLC=/path/to/script` to a wrapper that records its arguments and runs
  `vlc -I dummy --vout dummy --aout dummy "$@"`, so no window opens but the HTTP interface
  works. Use a fake playlist pointing at local HLS (ffmpeg `-f hls`) instead of real
  streams. Find test VLCs by their `--http-port` (not `pkill -f`, which can hit the user's
  VLC or your own shell).
- Recommend: needs a llama-server with a decision GGUF; the user runs H2O Lightning
  (`~/models/h2o-lightning-4b-gguf/h2o-lightning-4b-Q8_0.gguf`, usually on
  127.0.0.1:9931). Set `LLM_URL`, and `RECOMMEND_PROMPT_FILE` to a temp copy so the
  user's prompt isn't modified. Don't use the `stock-` GGUFs: they have no decision
  metadata (llama-server answers 501). For the in-app server, leave `LLM_URL` unset and
  set `LLAMA_SERVER=~/fun/opensrc/llama.cpp/build/bin/llama-server` plus `MODELS_DIR`
  (or `LLM_MODEL_FILE`); it starts its own copy on a free port, so the user's server on
  9931 is unaffected. That build's RUNPATH is absolute, so a copy finds its libraries
  through the `LD_LIBRARY_PATH` llama.js sets.
- Desktop app: Playwright's `_electron.launch` with `--ozone-platform=headless` and
  `XDG_CONFIG_HOME` pointing at a temp dir (isolates userData; put a `.env` in
  `<dir>/TV Guide/`). Note CDP-injected keys skip `before-input-event`; use
  `webContents.sendInputEvent` to test keyboard shortcuts handled in the main process.

## Gotchas

- `epg.xml` is ~225 MB; don't read it whole into a string or into chat context.
- The server falls back to a random port if 47831 is taken (`PORT_FALLBACK`), e.g. when
  the user's own copy of the app is running.
- `npm install` sometimes skips Electron's binary download: `node node_modules/electron/install.js`.
- On Windows, VLC is found via the registry / Program Files (`findVlc` in `server/index.js`).
  Inside the AppImage, `vlcEnv()` strips the bundle's library paths before launching VLC.
