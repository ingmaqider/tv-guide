// "What should I watch?": asks a decision model served by llama.cpp's llama-server (its
// TypeSafe-compatible /v1/systemone endpoint, for example H2O Lightning) to pick one of
// the programmes on now.
//
// Each request is one `choice` question: the state describes the viewer, the options are
// the programmes, and the answer gives every option a probability.
// More candidates than fit one question are ranked in batches, knockout style: the best
// of each batch go through to the next round until one final batch is left.

import fs from 'node:fs';

// llama-server's limit for h2o-lightning and most other decision types.
export const MAX_OPTIONS = 255;
const SECTIONS = ['state', 'instructions', 'option'];

// The template is read on every request so edits apply immediately. The first time, the
// default is copied to `file` so there is something to edit.
export function readPrompt(file, defaultFile) {
  if (!fs.existsSync(file)) fs.copyFileSync(defaultFile, file);
  const lines = Object.fromEntries(SECTIONS.map((name) => [name, []]));
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    const header = /^\[(\w+)\]\s*$/.exec(line);
    if (header) {
      if (!SECTIONS.includes(header[1])) throw new Error(`${file}: unknown section [${header[1]}]`);
      current = lines[header[1]];
    } else {
      current?.push(line);
    }
  }
  const prompt = Object.fromEntries(SECTIONS.map((name) => [name, lines[name].join('\n').trim()]));
  for (const name of SECTIONS) {
    if (!prompt[name]) throw new Error(`${file} has no [${name}] section`);
  }
  return prompt;
}

export const MAX_WISH = 500;

// Fills the template: {{name}} is replaced by the value, {{#name}}…{{/name}} is kept only
// when the value is non-empty and {{^name}}…{{/name}} only when it's empty. Values aren't
// scanned again, so a wish containing "{{" goes to the model as typed. Unknown names throw:
// a typo would otherwise reach the model as literal text.
function fill(text, values) {
  const check = (key) => {
    if (!(key in values)) {
      throw new Error(`Unknown placeholder {{${key}}} in the prompt. Known here: ${Object.keys(values).join(', ')}`);
    }
    return values[key];
  };
  return text
    .replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (m, kind, key, inner) =>
      !!check(key) === (kind === '#') ? inner : '')
    .replace(/\{\{(\w+)\}\}/g, (m, key) => check(key));
}

// Blank lines left by conditional blocks that were dropped.
const tidy = (text) => text.replace(/\n{3,}/g, '\n\n').trim();

// The model's tokenizer expects composed Unicode (NFC); llama-server doesn't normalize
// for it, so text in another form can change the answer.
const nfc = (text) => text.normalize('NFC');

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nowFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' });

function describe({ channel, programme }, template, descChars) {
  let desc = programme.desc?.replace(/\s+/g, ' ').trim() || '';
  if (desc === 'Нет описания') desc = '';
  if (desc.length > descChars) desc = `${desc.slice(0, descChars)}…`;
  return fill(template, {
    title: programme.title,
    time: `${timeFmt.format(programme.start)}–${timeFmt.format(programme.stop)}`,
    description: desc,
    channel: channel.name,
  })
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '');
}

// Option keys are what the model reads as the option's name, and what the answer's
// probabilities are keyed by: the channel name, made unique if two channels share one.
function optionKeys(candidates) {
  const seen = new Map();
  return candidates.map(({ channel }) => {
    const n = (seen.get(channel.name) || 0) + 1;
    seen.set(channel.name, n);
    return nfc(n === 1 ? channel.name : `${channel.name} (${n})`);
  });
}

// One model call: ranks up to MAX_OPTIONS candidates. Returns { model, request, ranked }
// with ranked = [{ ...candidate, probability }] sorted best first.
async function rankBatch(candidates, { url, model, apiKey, prompt, context, descChars, timeoutMs, signal }) {
  const keys = optionKeys(candidates);
  const request = {
    ...(model && { model }),
    state: nfc(tidy(fill(prompt.state, context))),
    questions: {
      watch: {
        type: 'choice',
        instructions: nfc(tidy(fill(prompt.instructions, context))),
        criteria: Object.fromEntries(candidates.map((c, i) => [keys[i], nfc(describe(c, prompt.option, descChars))])),
      },
    },
  };

  let res;
  try {
    res = await fetch(new URL('/v1/systemone', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    const reason = err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : err.cause?.code || err.message;
    throw new Error(`Can't reach the model at ${url} (${reason})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const message = (() => {
      try {
        return JSON.parse(text).error?.message;
      } catch {
        return null;
      }
    })();
    if (res.status === 501 && /not a decision model/i.test(message || '')) {
      throw new Error(`The model at ${url} is not a decision model. Load a GGUF that has decision metadata.`);
    }
    throw new Error(`The model server answered HTTP ${res.status}: ${message || text.slice(0, 300)}`);
  }
  const body = await res.json();
  const probabilities = body.answers?.watch?.probabilities;
  if (!probabilities) throw new Error(`Unexpected answer from the model server: ${JSON.stringify(body).slice(0, 300)}`);

  return {
    model: body.model,
    request,
    ranked: candidates
      .map((c, i) => ({ ...c, probability: probabilities[keys[i]] ?? 0 }))
      .sort((a, b) => b.probability - a.probability),
  };
}

// Runs `fn` over `items` with at most `limit` calls in flight (llama-server --parallel).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Splits into the fewest batches of at most `size`, evened out (19 by 16 → 10 + 9).
function split(items, size) {
  const count = Math.ceil(items.length / size);
  const per = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, i) => items.slice(i * per, (i + 1) * per));
}

/**
 * Ranks any number of candidates ([{ channel, programme }]). Probabilities are only
 * comparable within one call, so `ranked` is the final round, best first, and `eliminated`
 * counts the candidates knocked out in earlier rounds.
 */
export async function recommend({ candidates, batchSize, parallel, favorites, lastPlayed, wish, ...options }) {
  const size = Math.min(Math.max(batchSize, 2), MAX_OPTIONS);
  const context = {
    now: nowFmt.format(Date.now()),
    favorites: favorites.join(', ') || 'none',
    last_played: lastPlayed || 'nothing yet',
    wish: wish || '',
  };
  // Stopped by the caller (options.signal): no further batches are sent.
  const call = (batch) => {
    options.signal?.throwIfAborted();
    return rankBatch(batch, { ...options, context });
  };

  let pool = candidates;
  let calls = 0;
  let rounds = 0;
  while (pool.length > size) {
    const batches = split(pool, size);
    // Advance enough from each batch that the next round is at most one batch where possible.
    const keep = Math.max(1, Math.floor(size / batches.length));
    const results = await mapLimit(batches, parallel, call);
    calls += batches.length;
    rounds++;
    pool = results.flatMap((r) => r.ranked.slice(0, keep).map(({ probability, ...c }) => c));
  }
  const final = await call(pool);
  return {
    model: final.model,
    request: final.request,
    ranked: final.ranked,
    eliminated: candidates.length - pool.length,
    calls: calls + 1,
    rounds: rounds + 1,
  };
}
