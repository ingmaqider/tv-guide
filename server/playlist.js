// M3U playlist of stream URLs, matched to EPG channels.

export function parseM3u(text) {
  const entries = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      pending = { name: line.slice(line.indexOf(',') + 1).trim(), tvgId: /tvg-id="([^"]*)"/.exec(line)?.[1] };
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

/**
 * Fetches the playlist and finds a channel's stream: by tvg-id, then by the channel id in
 * the stream URL, then by name. Refetched when older than an hour.
 */
export class Playlist {
  constructor(url) {
    this.url = url;
    this.byId = new Map();
    this.byName = new Map();
    this.fetchedAt = 0;
    this.attemptedAt = 0;
    this.pending = null;
  }

  refresh() {
    this.pending ??= (async () => {
      this.attemptedAt = Date.now();
      try {
        const res = await fetch(this.url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`Playlist download failed: HTTP ${res.status}`);
        const entries = parseM3u(await res.text());
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
        this.fetchedAt = Date.now();
        console.log(`Loaded playlist: ${entries.length} streams`);
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  // Refreshes a stale playlist (waiting for one already in flight). On failure keeps what
  // was loaded before, and doesn't retry for a minute so requests don't all wait on it.
  async ensureFresh() {
    if (!this.url) return; // not configured: no channel is playable
    if (this.pending) return this.pending.catch(() => {});
    const stale = Date.now() - this.fetchedAt > MAX_AGE_MS;
    if (!stale || Date.now() - this.attemptedAt < RETRY_MS) return;
    await this.refresh().catch((err) => console.error('Playlist unavailable:', err.message));
  }

  // Stream URL for an EPG channel from the loaded playlist, or null.
  lookup(channel) {
    return this.byId.get(channel.id) || this.byName.get(normalize(channel.name)) || null;
  }

  async streamFor(channel) {
    await this.ensureFresh();
    return this.lookup(channel);
  }
}
