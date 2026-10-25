// M3U playlist of stream URLs, matched to EPG channels.

import crypto from 'node:crypto';
import fs from 'node:fs';

// Ids for playlist channels that aren't in the EPG. Made from the name, not the URL: the
// URL carries the token (which must not reach the browser) and changes with it.
export const EXTRA_PREFIX = 'm3u-';
export const isExtra = (id) => id.startsWith(EXTRA_PREFIX);

export function parseM3u(text) {
  const entries = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      pending = {
        name: line.slice(line.indexOf(',') + 1).trim(),
        tvgId: /tvg-id="([^"]*)"/.exec(line)?.[1],
        logo: /tvg-logo="([^"]*)"/.exec(line)?.[1] || null,
      };
    } else if (!line.startsWith('#') && pending) {
      entries.push({ ...pending, url: line });
      pending = null;
    }
  }
  return entries;
}

const normalize = (name) => name.toLocaleLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// The provider's stream URLs look like https://host/<epg channel id>/index.m3u8.
function idFromUrl(url) {
  try {
    const first = new URL(url).pathname.split('/')[1];
    return /^\d+$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

const MAX_AGE_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

// fetch() reports network failures as "fetch failed" with the reason in `cause`.
function describe(err) {
  if (err.name === 'TimeoutError') return "the server didn't respond";
  const code = err.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "the server's address couldn't be found";
  if (code === 'ECONNREFUSED') return 'the server refused the connection';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return "the server didn't respond";
  return err.cause?.message || err.message;
}

/**
 * Fetches the playlist and finds a channel's stream: by tvg-id, then by the channel id in
 * the stream URL, then by name. Refetched when older than an hour. Each download is saved
 * to `cacheFile` and loaded from there at startup, so an unreachable playlist server
 * doesn't take the Play buttons away.
 */
export class Playlist {
  constructor(url, cacheFile) {
    this.url = url;
    this.cacheFile = cacheFile;
    this.byId = new Map();
    this.byName = new Map();
    this.entries = [];
    this.extraCache = null;
    this.streams = 0;
    this.updatedAt = null; // when the loaded list was downloaded
    this.fetchedAt = 0; // last successful download in this run
    this.attemptedAt = 0;
    this.error = null; // reason the last download failed, if it did
    this.version = 0; // bumped when the loaded list changes, so clients refetch
    this.pending = null;
    if (url) this.loadCache();
  }

  // The cache belongs to one link; a different PLAYLIST_URL starts empty.
  loadCache() {
    try {
      const { url, savedAt, text } = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (url !== this.url) return;
      this.use(parseM3u(text), savedAt);
      console.log(`Loaded saved playlist from ${new Date(savedAt).toISOString()}: ${this.streams} streams`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Failed to read saved playlist:', err.message);
    }
  }

  // Written atomically and private to the user: it holds the stream links with their token.
  saveCache(text, savedAt) {
    const tmp = `${this.cacheFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ url: this.url, savedAt, text }), { mode: 0o600 });
      fs.renameSync(tmp, this.cacheFile);
    } catch (err) {
      console.error('Failed to save playlist:', err.message);
    }
  }

  use(entries, updatedAt) {
    const byId = new Map();
    const byName = new Map();
    for (const e of entries) {
      const id = e.tvgId || idFromUrl(e.url);
      if (id && !byId.has(id)) byId.set(id, e.url);
      const name = normalize(e.name);
      if (!byName.has(name)) byName.set(name, e.url);
    }
    this.byId = byId;
    this.byName = byName;
    this.entries = entries;
    this.extraCache = null;
    this.streams = entries.length;
    this.updatedAt = updatedAt;
    this.version++;
  }

  refresh() {
    this.pending ??= (async () => {
      this.attemptedAt = Date.now();
      try {
        let text;
        try {
          const res = await fetch(this.url, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
          text = await res.text();
        } catch (err) {
          throw new Error(`Playlist download failed: ${describe(err)}`);
        }
        const entries = parseM3u(text);
        if (!entries.length) throw new Error('Playlist download failed: the file has no streams');
        const now = Date.now();
        this.use(entries, now);
        this.saveCache(text, now);
        this.fetchedAt = now;
        this.error = null;
        console.log(`Loaded playlist: ${entries.length} streams`);
      } catch (err) {
        this.error = err.message;
        throw err;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  // Refreshes a stale playlist, keeping what was loaded before if that fails. Only waits for
  // the download when there's nothing loaded yet (the first one at startup); otherwise it
  // runs in the background so requests aren't held up by a slow or unreachable server.
  async ensureFresh() {
    if (!this.url) return; // not configured: no channel is playable
    if (this.pending) {
      if (!this.streams) await this.pending.catch(() => {});
      return;
    }
    const stale = Date.now() - this.fetchedAt > MAX_AGE_MS;
    if (!stale || Date.now() - this.attemptedAt < RETRY_MS) return;
    this.refresh().catch((err) => console.error(err.message));
  }

  status() {
    return {
      configured: !!this.url,
      streams: this.streams,
      updatedAt: this.updatedAt,
      error: this.error,
      version: this.version,
    };
  }

  // Stream URL for an EPG channel from the loaded playlist, or null.
  lookup(channel) {
    return this.byId.get(channel.id) || this.byName.get(normalize(channel.name)) || null;
  }

  async streamFor(channel) {
    await this.ensureFresh();
    return this.lookup(channel);
  }

  // Playlist channels none of the EPG `channels` match: [{ id, name, icon, url }], in
  // playlist order. Cached until the playlist or the EPG changes.
  extras(channels) {
    if (this.extraCache?.channels === channels) return this.extraCache.list;
    const matched = new Set(channels.map((ch) => this.lookup(ch)).filter(Boolean));
    const seenUrls = new Set();
    const ids = new Map();
    const list = [];
    for (const e of this.entries || []) {
      if (matched.has(e.url) || seenUrls.has(e.url)) continue;
      seenUrls.add(e.url);
      const base = EXTRA_PREFIX + crypto.createHash('sha1').update(normalize(e.name)).digest('hex').slice(0, 10);
      const n = (ids.get(base) || 0) + 1;
      ids.set(base, n);
      list.push({ id: n === 1 ? base : `${base}-${n}`, name: e.name, icon: e.logo, url: e.url });
    }
    this.extraCache = { channels, list, byId: new Map(list.map((x) => [x.id, x])) };
    return list;
  }

  extra(channels, id) {
    this.extras(channels);
    return this.extraCache.byId.get(id) || null;
  }
}
