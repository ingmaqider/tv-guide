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
    VLC launching, static files.
  - `playlist.js` — M3U parsing and channel matching: tvg-id, then the channel id in the
    stream URL (`/<id>/index.m3u8`, this provider's format), then normalized name.
- `src/` — React 18 + react-router 6 (data router), built by Vite. No state library.
  - `api.js` — `useApi` (per-URL cache, polling, `reloadAll()`), `send()` for mutations.
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
- VLC: set `VLC=/path/to/script` to a stub that records its arguments instead of
  opening a player.
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
