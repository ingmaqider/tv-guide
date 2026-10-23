// Controls the VLC window this app opens, through VLC's HTTP interface: what's playing,
// pause and stop, and switching channels in the same window.
//
// VLC is started with --extraintf http on a free 127.0.0.1 port with a random password,
// and --no-one-instance so a VLC the user opened themselves is left alone. VLC keeps
// running when the app closes; the port and password are saved (with the stream URLs we
// played, which carry the playlist token, hence mode 0600) so the next run can reconnect.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

// After a command, VLC takes a moment to apply it (longer to start, a second or two to
// switch or stop an HLS stream). Until it does, or this runs out, status() reports the
// expected state instead of the old one.
const STARTING_MS = 15000;
const SWITCHING_MS = 5000;
// VLC's HTTP interface is quick when it's up; a slow answer means it's gone or stuck.
const REQUEST_TIMEOUT_MS = 1500;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// VLC decodes %XX in query values but not "+", so URLSearchParams' encoding won't do.
const query = (params) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

export class Vlc {
  constructor({ bin, env, stateFile }) {
    Object.assign(this, { bin, env, stateFile });
    this.conn = null; // { port, password }
    this.channels = {}; // stream URL → channel id, for the URLs we asked VLC to play
    this.expected = null; // { state, channelId, until }
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (saved.port && saved.password) this.conn = { port: saved.port, password: saved.password };
      this.channels = saved.channels || {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Failed to read VLC state:', err.message);
    }
  }

  save() {
    try {
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.conn, channels: this.channels }), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      console.error('Failed to save VLC state:', err.message);
    }
  }

  // GET /requests/status.json, optionally with a command. Null if VLC isn't reachable
  // (closed, or another program on the saved port).
  async request(file, params = {}) {
    if (!this.conn) return null;
    const { port, password } = this.conn;
    const qs = query(params);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/requests/${file}${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Basic ${Buffer.from(`:${password}`).toString('base64')}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  // Plays the URL: in the VLC window we opened if it's still there, else in a new one.
  async play(url, channelId, title) {
    // Earlier ones too, since VLC's playlist lets you go back to them. Kept short.
    const { [url]: _, ...rest } = this.channels;
    this.channels = Object.fromEntries([...Object.entries(rest).slice(-49), [url, channelId]]);
    if (await this.request('status.json', { command: 'in_play', input: url, option: `:meta-title=${title}` })) {
      this.expect('opening', channelId, SWITCHING_MS);
      this.save();
      return;
    }
    this.conn = { port: await freePort(), password: crypto.randomBytes(18).toString('hex') };
    this.save();
    await new Promise((resolve, reject) => {
      const vlc = spawn(
        this.bin,
        [
          '--no-one-instance',
          '--extraintf=http',
          '--http-host=127.0.0.1',
          `--http-port=${this.conn.port}`,
          `--http-password=${this.conn.password}`,
          `--meta-title=${title}`,
          url,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true, env: this.env },
      );
      vlc.once('error', reject);
      vlc.once('spawn', () => {
        vlc.unref();
        resolve();
      });
    });
    this.expect('opening', channelId, STARTING_MS);
  }

  expect(state, channelId, ms) {
    this.expected = { state, channelId, until: Date.now() + ms };
  }

  // { state: 'playing' | 'paused' | 'stopped' | 'opening' | 'closed', channelId }.
  // channelId is null when VLC plays something this app didn't start.
  async status() {
    const actual = await this.actualStatus();
    const expected = this.expected;
    if (!expected) return actual;
    const arrived =
      expected.state === 'opening'
        ? actual.channelId === expected.channelId && actual.state !== 'closed'
        : actual.state === expected.state;
    if (arrived || Date.now() > expected.until) {
      this.expected = null;
      return actual;
    }
    return { state: expected.state, channelId: expected.channelId };
  }

  async actualStatus() {
    const status = await this.request('status.json');
    if (!status) return { state: 'closed', channelId: null };
    if (status.state === 'stopped' || status.currentplid < 0) return { state: 'stopped', channelId: null };
    // The current item's URL says which channel it is; the title could be anything.
    const playlist = await this.request('playlist.json');
    const items = playlist?.children?.flatMap((node) => node.children || []) || [];
    const current = items.find((item) => item.current === 'current' || Number(item.id) === status.currentplid);
    return { state: status.state, channelId: (current && this.channels[current.uri]) ?? null };
  }

  // pl_pause toggles between playing and paused.
  async command(name) {
    const commands = { pause: 'pl_pause', stop: 'pl_stop' };
    const before = await this.request('status.json', { command: commands[name] });
    if (!before) return false;
    if (name === 'stop') this.expect('stopped', null, SWITCHING_MS);
    return true;
  }
}
