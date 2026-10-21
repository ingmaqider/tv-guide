# TV Guide

A TV guide for an XMLTV EPG (`epg.xml`) with favorites, search and one-click playback
in VLC. Runs in the browser or as a desktop app (Electron) on Linux and Windows.

- **Favorites / Now / Channels** tabs: what's on now and next, with search by channel name
- Channel schedule by day, with the current programme highlighted
- ☆ favorites, ▶ play in VLC (for channels in your M3U playlist)
- **Update EPG** downloads a fresh guide and reloads it without a restart
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
if missing) and `favorites.json`.

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
(downloaded on first run) and `favorites.json`.
