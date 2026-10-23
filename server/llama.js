// Runs llama.cpp's llama-server as a child process, so "Recommend" works without a model
// server set up elsewhere. Used when LLM_URL isn't set but a model file is found.
//
// The server listens on a free 127.0.0.1 port with a random API key: only this app can use
// it. It's started with the app, and restarted on the next request if it crashes later.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const LOG_LINES = 30;
const READY_TIMEOUT_MS = 10 * 60 * 1000;

// The binary: LLAMA_SERVER, else the bundled copy in `dir`, else llama-server on PATH.
export function findServer(explicit, dir) {
  if (explicit) return explicit;
  const bundled = dir && path.join(dir, EXE);
  return bundled && fs.existsSync(bundled) ? bundled : EXE;
}

// The model: LLM_MODEL_FILE, else the first .gguf found in `dirs` (stock- files have no
// decision metadata, and mmproj- files are vision projectors, so both are skipped).
export function findModel(explicit, dirs) {
  if (explicit) return explicit;
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const name = names.sort().find((n) => n.endsWith('.gguf') && !/^(stock-|mmproj)/.test(n) && !n.includes('-stock-'));
    if (name) return path.join(dir, name);
  }
  return null;
}

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

// "--foo 1 'a b'" → ['--foo', '1', 'a b'], for LLAMA_ARGS.
export function splitArgs(text) {
  return [...(text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

export class LlamaServer {
  constructor({ bin, model, parallel = 1, ctx = 40960, extraArgs = [] }) {
    Object.assign(this, { bin, model, parallel, ctx, extraArgs });
    this.apiKey = crypto.randomBytes(24).toString('hex');
    this.state = 'stopped'; // stopped → starting → ready; failed if it never got ready
    this.error = null;
    this.url = null;
    this.child = null;
    this.log = [];
  }

  start() {
    if (this.state === 'starting' || this.state === 'ready') return;
    this.state = 'starting';
    this.error = null;
    this.run().catch((err) => {
      this.state = 'failed';
      this.error = err.message;
      console.error('llama-server:', err.message);
      this.stop();
    });
  }

  async run() {
    if (!fs.existsSync(this.model)) throw new Error(`Model file not found: ${this.model}`);
    const port = await freePort();
    const args = [
      '-m', this.model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--api-key', this.apiKey,
      // The name answers report, instead of the file's path.
      '--alias', path.basename(this.model, '.gguf'),
      // H2O's recommended settings for decision models: a context per slot, slots not
      // sharing one KV cache, and no vision projector.
      '-c', String(this.ctx * this.parallel),
      '-np', String(this.parallel),
      '--no-kv-unified',
      '--no-mmproj',
      ...this.extraArgs,
    ];
    console.log(`Starting ${this.bin} with ${path.basename(this.model)} on port ${port}`);
    this.log = [];
    // A bundled build loads the libraries next to it: Windows looks for DLLs there anyway;
    // on Linux, a build's RUNPATH may point at the folder it was built in.
    const dir = path.isAbsolute(this.bin) ? path.dirname(this.bin) : null;
    const env = { ...process.env };
    if (dir && process.platform === 'linux') {
      env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: dir ?? undefined, env });
    this.child = child;
    const keep = (chunk) => {
      this.log.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
      this.log.splice(0, Math.max(0, this.log.length - LOG_LINES));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const exited = new Promise((resolve, reject) => {
      child.on('error', (err) =>
        reject(new Error(err.code === 'ENOENT' ? `${this.bin} not found. Set LLAMA_SERVER or bundle llama.cpp.` : err.message)));
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        const why = `llama-server exited (${signal || `code ${code}`})`;
        if (this.state === 'ready') {
          // Crashed after starting fine: the next request starts it again.
          console.error(`${why}. Last output:\n${this.log.slice(-10).join('\n')}`);
          this.state = 'stopped';
          this.error = why;
        }
        reject(new Error(`${why}: ${this.log.slice(-3).join(' ') || 'no output'}`));
      });
    });
    exited.catch(() => {});

    // /health answers 503 while the model loads, 200 once it can take requests.
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const ready = (async () => {
      while (Date.now() < deadline && this.child === child) {
        try {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) return;
        } catch {
          // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (this.child === child) throw new Error(`llama-server didn't get ready in ${READY_TIMEOUT_MS / 60000} minutes`);
    })();
    await Promise.race([ready, exited]);
    this.url = url;
    this.state = 'ready';
    console.log(`llama-server ready at ${url}`);
  }

  // For a request: { url, apiKey } when ready; otherwise starts it if it crashed earlier
  // and returns null (still loading) or throws (couldn't start).
  endpoint() {
    if (this.state === 'ready') return { url: this.url, apiKey: this.apiKey };
    if (this.state === 'failed') throw new Error(`The local model server couldn't start: ${this.error}`);
    this.start();
    return null;
  }

  status() {
    return { state: this.state, error: this.error, model: path.basename(this.model) };
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (this.state !== 'failed') this.state = 'stopped';
    if (child && child.exitCode === null) child.kill();
  }
}
