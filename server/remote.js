// Phone access: a second listener on the LAN (off until turned on in the desktop app),
// serving the same app to paired phones.
//
// The API can launch VLC, download files and run the model, so the LAN listener only
// answers devices that were paired: the phone asks, the desktop shows the request, and
// on Allow the phone gets a random token in an HttpOnly cookie. Only hashes of the tokens
// are saved (remote.json, mode 0600). Traffic is plain HTTP: this is meant for a home LAN.
//
// Or with a QR code: while the desktop's Phone panel is open it shows a one-time code (in
// a link to this listener). A phone presenting it is paired without the Allow step, since
// it could only have read it off the screen. The code is random, works once, expires, and
// is only ever sent to the desktop (state() is a local-only topic).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const COOKIE = 'tvg_device';
// The phone waits this long for someone to answer the request on the desktop.
const PAIR_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PENDING = 5;
const MAX_NAME = 40;
// lastSeen is shown in the device list; saving it on every request would be wasteful.
const SEEN_SAVE_MS = 10 * 60 * 1000;
// A QR code is replaced after this long (the panel asks for a new one).
const CODE_TTL_MS = 5 * 60 * 1000;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

// Home networks use these ranges; VPNs (e.g. Tailscale's 100.64/10) and the rest come after.
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

// IPv4 addresses of this machine on the LAN: what to type on the phone, likeliest first.
function lanAddresses() {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  return [...all.filter(isPrivate), ...all.filter((ip) => !isPrivate(ip))];
}

// Constant-time comparison for the QR code.
function sameCode(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class Remote {
  // handler: the Express app; onUpgrade(req, socket, head) for WebSockets; onChange() after
  // anything in state() changes; onPairing(request) when a phone asks to pair.
  constructor({ file, host, port, handler, onUpgrade, onChange, onPairing }) {
    Object.assign(this, { file, host, port, handler, onUpgrade, onChange, onPairing });
    this.settings = { enabled: false, devices: [] };
    this.server = null;
    this.error = null;
    this.pending = new Map(); // id → { id, name, ip, at, finish }
    this.code = null; // { value, expiresAt, timer }: the QR code shown on the desktop
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.settings = { enabled: !!saved.enabled, devices: Array.isArray(saved.devices) ? saved.devices : [] };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Failed to read phone access settings:', err.message);
    }
  }

  save() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Failed to save phone access settings:', err.message);
    }
  }

  // Starts or stops the listener to match the setting.
  apply() {
    if (this.settings.enabled && !this.server) return this.start();
    if (!this.settings.enabled && this.server) this.stop();
    return Promise.resolve();
  }

  start() {
    const server = http.createServer((req, res) => {
      req.viaLan = true;
      this.handler(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      req.viaLan = true;
      this.onUpgrade(req, socket, head);
    });
    this.server = server;
    return new Promise((resolve) => {
      server.once('error', (err) => {
        this.server = null;
        this.error =
          err.code === 'EADDRINUSE'
            ? `Port ${this.port} is in use by another program, so phones can't connect.`
            : `Can't accept phone connections: ${err.message}`;
        console.error(this.error);
        this.onChange();
        resolve();
      });
      server.listen(this.port, this.host, () => {
        this.error = null;
        console.log(`Phone access on http://${this.host}:${this.port}`);
        this.onChange();
        resolve();
      });
    });
  }

  stop() {
    const server = this.server;
    this.server = null;
    server.close();
    server.closeAllConnections();
    for (const request of this.pending.values()) request.finish(null);
    this.clearCode();
    console.log('Phone access off');
  }

  async setEnabled(on) {
    this.settings.enabled = !!on;
    this.save();
    if (!on) this.error = null;
    await this.apply();
    this.onChange();
  }

  // The paired device a request comes from, or null.
  deviceFor(req) {
    const token = cookie(req, COOKIE);
    if (!token) return null;
    const tokenHash = hash(token);
    const device = this.settings.devices.find((d) => d.tokenHash === tokenHash);
    if (!device) return null;
    const now = Date.now();
    if (now - (device.lastSeen || 0) > SEEN_SAVE_MS) {
      device.lastSeen = now;
      this.save();
    }
    return device;
  }

  // Resolves with a Set-Cookie value once the desktop allows it, or null if it's denied,
  // times out, the phone gives up (signal) or phone access is turned off.
  pair(name, ip, signal) {
    // One request per phone address; the newest replaces an older one still waiting.
    for (const request of this.pending.values()) if (request.ip === ip) request.finish(null);
    if (this.pending.size >= MAX_PENDING) return Promise.resolve(null);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => request.finish(null), PAIR_TIMEOUT_MS);
      const request = {
        id,
        name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Phone',
        ip,
        at: Date.now(),
        finish: (result) => {
          if (!this.pending.has(id)) return;
          clearTimeout(timer);
          this.pending.delete(id);
          this.onChange();
          resolve(result);
        },
      };
      signal.addEventListener('abort', () => request.finish(null));
      this.pending.set(id, request);
      this.onChange();
      this.onPairing(request);
    });
  }

  // Answers a pairing request from the desktop. Returns false if it's no longer waiting.
  answer(id, allow) {
    const request = this.pending.get(id);
    if (!request) return false;
    if (!allow) {
      console.log(`Phone pairing denied: ${request.name} (${request.ip})`);
      request.finish(null);
      return true;
    }
    request.finish(this.addDevice(request.name, request.ip));
    return true;
  }

  // Saves a new paired device; returns the Set-Cookie value with its token.
  addDevice(name, ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.settings.devices.push({ id: crypto.randomUUID(), name, tokenHash: hash(token), pairedAt: now, lastSeen: now });
    this.save();
    console.log(`Phone paired: ${name} (${ip})`);
    this.onChange();
    // Ten years: the phone stays paired until the device is removed on the desktop.
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`;
  }

  // A new QR code, replacing the one shown before (the desktop's Phone panel asks for one
  // when it opens, and again when the code expires or has been used).
  newCode() {
    this.clearCode();
    const timer = setTimeout(() => this.clearCode(), CODE_TTL_MS);
    timer.unref();
    this.code = { value: crypto.randomBytes(16).toString('base64url'), expiresAt: Date.now() + CODE_TTL_MS, timer };
    this.onChange();
  }

  // The panel closed (or the code expired / was used): no code is valid any more.
  clearCode() {
    if (!this.code) return;
    clearTimeout(this.code.timer);
    this.code = null;
    this.onChange();
  }

  // Pairs at once if `code` is the QR code being shown; it can't be used again. Returns the
  // Set-Cookie value, or null.
  pairWithCode(code, name, ip) {
    if (!this.code || !sameCode(code, this.code.value)) return null;
    this.clearCode();
    return this.addDevice(String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Phone', ip);
  }

  // Set-Cookie value that removes the token from the phone (after it unpairs itself).
  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  revoke(id) {
    const before = this.settings.devices.length;
    this.settings.devices = this.settings.devices.filter((d) => d.id !== id);
    if (this.settings.devices.length === before) return false;
    this.save();
    this.onChange();
    return true;
  }

  // For the desktop's Phone panel. Never includes token hashes.
  state() {
    return {
      enabled: this.settings.enabled,
      listening: !!this.server,
      port: this.port,
      platform: process.platform, // for the firewall hint
      error: this.error,
      // Listening on one address (REMOTE_HOST) rather than all: that's the one to use.
      addresses: ['0.0.0.0', '::'].includes(this.host) ? lanAddresses() : [this.host],
      code: this.code && { value: this.code.value, expiresAt: this.code.expiresAt },
      devices: this.settings.devices.map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen })),
      pending: [...this.pending.values()].map(({ id, name, ip, at }) => ({ id, name, ip, at })),
    };
  }
}
