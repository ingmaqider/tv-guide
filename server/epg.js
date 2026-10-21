import fs from 'node:fs/promises';

// "20261015060000 +0000" -> epoch ms
export function parseXmltvDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])?(\d{2})?(\d{2})?/.exec(value || '');
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offset = sign ? (sign === '-' ? -1 : 1) * ((+oh || 0) * 60 + (+om || 0)) * 60000 : 0;
  return utc - offset;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

const attrRegex = (name) => new RegExp(`\\s${name}="([^"]*)"`);
const ID_RE = attrRegex('id');
const SRC_RE = attrRegex('src');
const START_RE = attrRegex('start');
const STOP_RE = attrRegex('stop');
const CHANNEL_RE = attrRegex('channel');
const attr = (re, head) => {
  const m = re.exec(head);
  return m ? decodeEntities(m[1]) : null;
};

const SLASH = 0x2f;
const YIELD_EVERY = 20000;
const yieldToEventLoop = () => new Promise((r) => setImmediate(r));

/**
 * XMLTV data backed by the raw file buffer. Instead of building a DOM, it scans for tags by
 * byte offset: programmes keep only start/stop/title plus their position in the buffer, and
 * descriptions/icons are decoded on demand (see details()).
 *
 * Programmes are parsed in passes (parseProgrammes) so some channels can be served before
 * the whole file is done; isLoaded() tells whether a channel's schedule is ready.
 */
export class Epg {
  static async open(file) {
    const epg = new Epg(await fs.readFile(file));
    epg.parseChannels();
    return epg;
  }

  constructor(buf) {
    this.buf = buf;
    this.channels = [];
    this.programmes = new Map();
    this.loaded = new Set();
    this.complete = false;
    this.titles = new Map(); // titles repeat a lot ("Новости"), so intern them
  }

  isLoaded(id) {
    return this.complete || this.loaded.has(id);
  }

  programmesOf(id) {
    return this.programmes.get(id) || [];
  }

  parseChannels() {
    const { buf } = this;
    let i = 0;
    for (;;) {
      const a = buf.indexOf('<channel ', i);
      if (a < 0) break;
      const gt = buf.indexOf('>', a);
      if (gt < 0) break;
      const head = buf.toString('utf8', a, gt);
      let end = gt + 1;
      if (buf[gt - 1] !== SLASH) {
        const close = buf.indexOf('</channel>', gt);
        if (close < 0) break;
        end = close + '</channel>'.length;
      }
      i = end;
      const id = attr(ID_RE, head);
      if (id === null) continue;
      this.channels.push({
        id,
        name: this.textOf('display-name', gt, end) || id,
        icon: this.attrOf('icon', SRC_RE, gt, end),
      });
    }
  }

  /**
   * Parses programmes for the channels in `ids`, or for every channel not loaded yet when
   * `ids` is omitted. Yields to the event loop periodically so requests keep being served.
   */
  async parseProgrammes(ids) {
    const { buf } = this;
    const wanted = ids ? (id) => ids.has(id) : (id) => !this.loaded.has(id);
    const touched = new Set();
    let i = 0;
    let n = 0;
    for (;;) {
      if (++n % YIELD_EVERY === 0) await yieldToEventLoop();
      const a = buf.indexOf('<programme ', i);
      if (a < 0) break;
      const gt = buf.indexOf('>', a);
      if (gt < 0) break;
      let end = gt + 1;
      if (buf[gt - 1] !== SLASH) {
        const close = buf.indexOf('</programme>', gt);
        if (close < 0) break;
        end = close + '</programme>'.length;
      }
      i = end;

      const head = buf.toString('utf8', a, gt);
      const id = attr(CHANNEL_RE, head);
      if (id === null || !wanted(id)) continue;
      const start = parseXmltvDate(attr(START_RE, head));
      const stop = parseXmltvDate(attr(STOP_RE, head));
      if (Number.isNaN(start) || Number.isNaN(stop)) continue;

      let title = this.textOf('title', gt, end) || '';
      const interned = this.titles.get(title);
      if (interned === undefined) this.titles.set(title, title);
      else title = interned;

      let list = this.programmes.get(id);
      if (!list) this.programmes.set(id, (list = []));
      list.push({ start, stop, title, pos: gt + 1, end });
      touched.add(id);
    }

    for (const id of touched) this.programmes.get(id).sort((x, y) => x.start - y.start);
    // Mark loaded only after sorting, so requests never see a half-built schedule.
    if (ids) for (const id of ids) this.loaded.add(id);
    else this.complete = true;
  }

  // Description and icon of a programme, decoded from the buffer.
  details(p) {
    return {
      desc: this.textOf('desc', p.pos, p.end) || '',
      icon: this.attrOf('icon', SRC_RE, p.pos, p.end),
    };
  }

  // Trimmed text of the first <tag …>…</tag> within [from, to), or null.
  textOf(tag, from, to) {
    const { buf } = this;
    const open = buf.indexOf(`<${tag}`, from);
    if (open < 0 || open >= to) return null;
    const gt = buf.indexOf('>', open);
    if (gt < 0 || gt >= to || buf[gt - 1] === SLASH) return null;
    const close = buf.indexOf(`</${tag}>`, gt);
    if (close < 0 || close >= to) return null;
    return decodeEntities(buf.toString('utf8', gt + 1, close).trim());
  }

  // Attribute of the first <tag …> within [from, to), or null.
  attrOf(tag, re, from, to) {
    const { buf } = this;
    const open = buf.indexOf(`<${tag}`, from);
    if (open < 0 || open >= to) return null;
    const gt = buf.indexOf('>', open);
    if (gt < 0 || gt >= to) return null;
    return attr(re, buf.toString('utf8', open, gt));
  }
}

// Index of the programme airing at `time`, or -1.
export function findCurrent(list, time) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= time) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && list[hi].stop > time ? hi : -1;
}
