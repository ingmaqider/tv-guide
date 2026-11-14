import { useEffect, useSyncExternalStore } from 'react';
import { reloadAll, UNPAIRED } from './api.js';

// One WebSocket to /api/events for the page (see server/events.js). The server sends every
// topic on connect and each change after; the latest state per topic is kept here so a
// component that mounts later gets it straight away.

const latest = new Map();
const topicListeners = new Map(); // topic → Set of callbacks
const connectionListeners = new Set();
let socket = null;
let connected = false;
let everConnected = false;
let retryMs = 1000;
let hiddenAt = 0;
// Not paired (any more): stop reconnecting; the pairing screen reloads the page when done.
let unpaired = false;
window.addEventListener(UNPAIRED, () => {
  unpaired = true;
  socket?.close();
});

function setConnected(value) {
  connected = value;
  connectionListeners.forEach((fn) => fn());
}

function deliver(type, data) {
  latest.set(type, data);
  topicListeners.get(type)?.forEach((fn) => fn(data));
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`);
  socket = ws;
  ws.onopen = () => {
    retryMs = 1000;
    setConnected(true);
    // Back after a drop (the phone slept, the network changed): lists may be stale too.
    if (everConnected) reloadAll();
    everConnected = true;
  };
  ws.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    deliver(type, data);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return; // replaced by reconnect()
    // This phone was removed on the desktop (or phone access turned off): PairGate shows
    // pairing, which reloads the page once paired. No point retrying until then.
    if (e.code === 4401) return window.dispatchEvent(new Event(UNPAIRED));
    if (unpaired) return;
    setConnected(false);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}

// A phone that slept may hold a socket that's silently dead; start a fresh one (which
// also brings a full snapshot) when the page is shown again after a while.
function reconnect() {
  if (unpaired) return;
  const old = socket;
  socket = null;
  old?.close();
  connect();
}

let started = false;
function start() {
  if (started) return;
  started = true;
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10000) reconnect();
  });
}

function listen(topic, fn) {
  start();
  if (!topicListeners.has(topic)) topicListeners.set(topic, new Set());
  topicListeners.get(topic).add(fn);
  return () => topicListeners.get(topic).delete(fn);
}

// The latest state of a topic (undefined until the first message).
export function useEvent(topic) {
  return useSyncExternalStore(
    (fn) => listen(topic, fn),
    () => latest.get(topic),
  );
}

// Calls `fn` with the topic's state now (if known) and on every change. `fn` must be stable.
export function useEventEffect(topic, fn) {
  useEffect(() => {
    if (latest.has(topic)) fn(latest.get(topic));
    return listen(topic, fn);
  }, [topic, fn]);
}

// For a response that already carries the new state (Play, Pause): show it now rather than
// on the next message.
export const setLatest = deliver;

export function useConnected() {
  return useSyncExternalStore(
    (fn) => {
      start();
      connectionListeners.add(fn);
      return () => connectionListeners.delete(fn);
    },
    () => connected || !everConnected,
  );
}
