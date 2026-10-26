# TV Guide

A TV guide for an XMLTV EPG (`epg.xml`) with favorites, search and one-click playback
in VLC. Runs in the browser or as a desktop app (Electron) on Linux and Windows.

- **Favorites / Now / Channels** tabs: what's on now and next, with search by channel
  name or, on Now and Favorites, by the title of what's on now (e.g. a film you know)
- Channel schedule by day, with the current programme highlighted
- ☆ favorites, ▶ play in VLC (for channels in your M3U playlist). The app opens one VLC
  window and reuses it; the header shows what it's playing, with Pause and Stop, and the
  channel is highlighted in the lists. A VLC you opened yourself is left alone.
- **Update EPG** downloads a fresh guide and reloads it without a restart
- Channels that are in your playlist but not in the EPG are listed too, marked **No guide**
  (with an amber badge): you can play and favorite them, but there's no schedule
- **Recommend** asks a local decision model what to watch now, with a prompt you can tune
- Light / dark / auto theme; scroll position kept when going back to a list

## Requirements

- Node.js 22 or newer (developed on 24)
- VLC, for the Play buttons
- Wine, only to build the Windows packages on Linux

## Setup

```bash
npm install
cp .env.example .env    # then put your EPG and playlist links in .env
```

`.env` is git-ignored; the links are private (the playlist link carries an access token).
See `.env.example` for all settings.

If `npm run app` fails with "Electron failed to install correctly", `npm install` skipped
the Electron binary download; run `node node_modules/electron/install.js`.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | API server on :3001 + Vite dev server with hot reload. Open http://localhost:5173 |
| `npm run build` | Build the frontend into `dist/` |
| `npm start` | Serve the API and the built frontend on http://localhost:3001 |
| `npm run app` | Build the frontend and run the desktop app from source |

Browser mode keeps its data in the project folder: `epg.xml` (downloaded on first start
if missing), `favorites.json`, `last-played.json`, `recommend-prompt.txt`, `playlist.json`
(the last downloaded playlist, used when the playlist server is unreachable) and `vlc.json`
(how to reach the VLC window the app opened). The last two contain your stream links, so
they're git-ignored.

## Recommendations (local decision model)

**Recommend** asks a decision model which programme on now to watch, and shows the top
picks with their probabilities. The model runs in llama.cpp's `llama-server`, which
answers typed decisions on `POST /v1/systemone`. The server can run on another machine on
your LAN, so the Windows app can use a GPU on a Linux box.

Each request is one `choice` question. The state describes you, the options are the
programmes (channel name plus title, time and EPG description), and the model gives
every option a probability. More programmes than `RECOMMEND_BATCH` (16 by default, up to
255) are ranked in rounds: the best of each batch go on to the next round.

The app can use a llama-server that's already running (below), or start its own (see
[Running the model inside the app](#running-the-model-inside-the-app)).

On the machine with the GPU, with a llama.cpp that supports H2O Lightning (#30361: nightly
b11840 or later works; the v0.7.0 release is too old) and a decision GGUF, for
example [H2O Lightning 4B](https://huggingface.co/h2oai/h2o-lightning-4b-gguf)
(`h2o-lightning-4b-Q8_0.gguf`; the `stock-` files have no decision metadata):

```bash
./build/bin/llama-server -m ~/models/h2o-lightning-4b-gguf/h2o-lightning-4b-Q8_0.gguf \
  --alias h2o-lightning-4b -c 40960 -np 1 --no-kv-unified --no-mmproj \
  --host 0.0.0.0 --port 9931 --api-key <some-secret>
```

Open that port in the machine's firewall for your LAN only.

In the TV Guide `.env` (on every machine running the app):

```
LLM_URL=http://<gpu-machine-ip>:9931
LLM_API_KEY=<some-secret>
```

The panel's switch picks which channels to consider: **Favorites** (the default, a few
seconds), **Playable** (channels in your playlist) or **All** channels in the EPG. The last
two take many more model calls, so they're slower; the panel shows the time so far, and
**Stop** cancels the run (no further model calls are made).
See `.env.example` for the other settings: batch size and description length.

The prompt is `recommend-prompt.txt` in the data folder (the project folder in browser
mode), created from `server/recommend-prompt.txt` the first time you press Recommend. It
has three sections: `[state]` (you and your tastes), `[instructions]` (the question) and
`[option]` (how each programme is described). It's re-read on every request, and the
panel's **Request** section shows exactly what was sent.

The box in the Recommend panel takes a wish for this time ("something funny", "a film in
English"); press Enter or **Ask**. It fills `{{wish}}` in the prompt. Any placeholder can
also switch text on or off: `{{#wish}}…{{/wish}}` is kept only when there is a wish,
`{{^wish}}…{{/wish}}` only when there isn't. The comments at the top of the file list the
placeholders; an unknown one is reported as an error instead of being sent.

### Running the model inside the app

Without `LLM_URL`, the app starts llama-server itself when it finds a model, and stops it
when the app closes. It listens on 127.0.0.1 only, on a free port, with a random API key.
The model loads at startup; until it's ready the panel says "Loading the model…".

- **Model**: put the `.gguf` in a `models` folder in the data folder (e.g.
  `%APPDATA%\TV Guide\models\` on Windows), or set `LLM_MODEL_FILE`. `stock-` and
  `mmproj` files are skipped.
- **llama-server**: the copy bundled with the app (below), else `LLAMA_SERVER`, else
  `llama-server` on `PATH`. It runs with `-c 40960 -np 1 --no-kv-unified --no-mmproj`; add
  options with `LLAMA_ARGS` (e.g. `-fa on`, `-ngl 99`).

To bundle llama.cpp, put a build in `vendor/llama/win/` (Windows) or `vendor/llama/linux/`
before `npm run dist:win` / `npm run dist`: `llama-server` with all its DLLs or `.so` files,
straight in that folder. It ends up in the package's `resources/llama/`. Use a build with
H2O Lightning support, e.g. llama.cpp's nightly zips (`llama-b11840-bin-win-vulkan-x64.zip` or later): the Vulkan build only needs the GPU driver;
the CUDA build is faster on NVIDIA but also needs the CUDA runtime DLLs (the matching
`cudart-…` zip). Models aren't bundled: at 4.5 GB, H2O Lightning Q8_0 is over the Windows
installer's size limit.

## Building the desktop app

| Command | Output in `release/` |
|---|---|
| `npm run dist` | Linux: `tv-guide-<version>-x86_64.AppImage` and `.rpm` |
| `npm run dist:win` | Windows: installer `tv-guide-setup-<version>.exe`, `tv-guide-portable-<version>.exe` and a `.zip` (needs Wine) |

Install the rpm with `sudo dnf install ./release/tv-guide-<version>-x86_64.rpm`, or run the
AppImage directly. The Windows builds aren't code-signed, so SmartScreen warns on first
launch (**More info → Run anyway**).

Packages don't contain your links. The desktop app reads its settings and keeps its data
in its own folder:

| | Folder |
|---|---|
| Linux | `~/.config/TV Guide/` |
| Windows | `%APPDATA%\TV Guide\` |

Put a `.env` there (same format as `.env.example`). The folder also holds `epg.xml`
(downloaded on first run), `favorites.json`, `last-played.json`, `playlist.json`,
`vlc.json` and `recommend-prompt.txt`.
