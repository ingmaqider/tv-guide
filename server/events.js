// Pushes state to the open UIs (the desktop window and paired phones) over WebSocket at
// /api/events, so a change made on one shows up on the others without polling.
//
// Each message is { type, data } with the whole current state of that topic: a client that
// connects (or reconnects after the phone slept) gets every topic once, then each change.
// REST stays for loading data and for commands; this only carries state.

import { WebSocketServer } from 'ws';

export class Events {
  // topics: { name: { get: () => data | Promise<data>, localOnly?: boolean } }
  constructor(topics) {
    this.topics = topics;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();
    this.onFirstClient = null;
    this.onLastClient = null;
  }

  // Called from an http server's 'upgrade' once the request has been checked. `info` is
  // { local, deviceId }: phones (not local) never get local-only topics.
  accept(req, socket, head, info) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.info = info;
      ws.alive = true;
      ws.on('pong', () => {
        ws.alive = true;
      });
      ws.on('close', () => {
        this.clients.delete(ws);
        if (!this.clients.size) this.onLastClient?.();
      });
      ws.on('error', () => ws.terminate());
      this.clients.add(ws);
      if (this.clients.size === 1) this.onFirstClient?.();
      this.snapshot(ws);
    });
  }

  async snapshot(ws) {
    for (const [type, topic] of Object.entries(this.topics)) {
      if (topic.localOnly && !ws.info.local) continue;
      try {
        this.send(ws, type, await topic.get());
      } catch (err) {
        console.error(`Failed to send ${type}:`, err.message);
      }
    }
  }

  send(ws, type, data) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
  }

  // Sends the topic's current state (`data`, or from its getter) to everyone allowed to see it.
  async publish(type, data) {
    if (!this.clients.size) return;
    const topic = this.topics[type];
    if (data === undefined) data = await topic.get();
    for (const ws of this.clients) {
      if (!topic.localOnly || ws.info.local) this.send(ws, type, data);
    }
  }

  // A revoked phone, or all phones when phone access is turned off. 4401 tells the page
  // it's no longer paired.
  disconnect(filter) {
    for (const ws of this.clients) if (filter(ws.info)) ws.close(4401, 'Not paired');
  }

  // A phone that went out of range doesn't close its socket; ping finds those.
  startHeartbeat(ms = 30000) {
    setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.alive) ws.terminate();
        else {
          ws.alive = false;
          ws.ping();
        }
      }
    }, ms).unref();
  }
}
