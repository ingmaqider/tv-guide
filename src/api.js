import { useEffect, useState, useSyncExternalStore } from 'react';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// For requests that change something; the server rejects them without this header
// (see server/index.js), which keeps other websites from driving the local server.
export const send = (url, method) => fetch(url, { method, headers: { 'X-TV-Guide': '1' } });

// Fetches JSON, retrying while the server is still parsing the EPG (HTTP 503).
export async function fetchJson(url, signal) {
  for (;;) {
    const res = await fetch(url, { signal });
    if (res.status === 503) {
      await sleep(1000);
      continue;
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
    return body;
  }
}

// Last response per URL. Returning to a page renders the cached data immediately (then
// refreshes it), which lets the scroll position be restored on a fully rendered list.
const cache = new Map();

const fromCache = (url) =>
  cache.has(url)
    ? { url, data: cache.get(url), error: null, loading: false }
    : { url, data: null, error: null, loading: true };

// Bumping the generation (after an EPG update) makes every mounted useApi refetch,
// while keeping its current data on screen until the new response arrives.
let generation = 0;
const listeners = new Set();
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function reloadAll() {
  cache.clear();
  generation++;
  listeners.forEach((fn) => fn());
}

// { data, error, loading } for a URL; refetches every `refreshMs` if given.
export function useApi(url, refreshMs) {
  const [state, setState] = useState(() => fromCache(url));
  const gen = useSyncExternalStore(subscribe, () => generation);

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const load = () => {
      fetchJson(url, controller.signal)
        .then((data) => {
          cache.set(url, data);
          setState({ url, data, error: null, loading: false });
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            setState({ url, data: cache.get(url) ?? null, error, loading: false });
          }
        })
        .finally(() => {
          if (refreshMs && !controller.signal.aborted) timer = setTimeout(load, refreshMs);
        });
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, refreshMs, gen]);

  // On a URL change, serve the new URL's cached state until its fetch completes.
  return state.url === url ? state : fromCache(url);
}

// Current time, updated every `intervalMs`.
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export const formatTime = (ms) => timeFmt.format(ms);
export const formatDay = (ms) => dayFmt.format(ms);
export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export const progress = (p, now) =>
  Math.min(100, Math.max(0, ((now - p.start) / (p.stop - p.start)) * 100));
