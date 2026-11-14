import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatTime, send, useApi } from './api.js';
import { ChannelLogo } from './components.jsx';
import { setLatest, useEvent } from './events.js';
import { PlayingBadge, usePlayer } from './player.jsx';
import PlayButton from './PlayButton.jsx';

const TOP = 3;
const WISH_KEY = 'recommendWish';
// Which channels to rank. Not remembered: the slow ones should be a choice each time.
const SCOPES = [
  { value: 'favorites', label: 'Favorites' },
  { value: 'playable', label: 'Playable', needs: 'playlist' },
  { value: 'all', label: 'All' },
];
const RecommendContext = createContext(null);

// The last wish is kept for next time; storage can be unavailable (private mode).
const loadWish = () => {
  try {
    return localStorage.getItem(WISH_KEY) || '';
  } catch {
    return '';
  }
};
const saveWish = (wish) => {
  try {
    localStorage.setItem(WISH_KEY, wish);
  } catch {
    // Not remembered then; nothing else depends on it.
  }
};

const IDLE = { id: 0, status: 'idle' };
const stopRun = () => send('/api/recommend', 'DELETE').catch((err) => console.error('Failed to stop', err));

// The run itself lives on the server and is shared by every open UI (the `recommend`
// event: { id, status: idle | running | done | error | stopped, message, result, … }), so
// one started on the phone shows here too and survives the phone locking its screen.
// Whether the panel is open, the wish and the scope belong to this page. Kept above the
// router so the panel survives opening a channel and coming back.
export function RecommendProvider({ children }) {
  const run = useEvent('recommend') || IDLE;
  const [open, setOpen] = useState(false);
  const [wish, setWish] = useState(loadWish);
  const [scope, setScope] = useState('favorites');
  // Refused before it started (no model, wish too long): shown until the next Ask.
  const [refused, setRefused] = useState(null);
  // Runs asked for here: closing the panel stops those, not one started on another device.
  const mine = useRef(new Set());

  // A new run, from any device, opens the panel. The first message is the state at
  // connect, which shouldn't.
  const seenId = useRef(null);
  useEffect(() => {
    if (seenId.current !== null && run.id !== seenId.current && run.status === 'running') setOpen(true);
    seenId.current = run.id;
  }, [run.id, run.status]);

  // `text` is the free text typed in the panel; the server puts it into the prompt's
  // {{wish}} placeholder.
  const ask = useCallback(async (text, scope) => {
    saveWish(text);
    setOpen(true);
    setRefused(null);
    try {
      const res = await send('/api/recommend', 'POST', { wish: text, scope });
      const body = await res.json();
      if (res.status === 202) {
        mine.current.add(body.id);
        setLatest('recommend', body);
      } else if (res.status !== 409) {
        // 409: one is already running (started elsewhere); the panel shows that one.
        setRefused(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setRefused(err.message);
    }
  }, []);

  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    setRefused(null);
    if (run.status === 'running' && mine.current.has(run.id)) stopRun();
  }, [run.id, run.status]);

  const value = useMemo(() => {
    // A refusal shows as an error in place of the last run.
    const shown = refused ? { ...run, status: 'error', error: refused } : run;
    return { ...shown, open, wish, setWish, scope, setScope, run: ask, stop: stopRun, show, close };
  }, [run, refused, open, wish, scope, ask, show, close]);
  return <RecommendContext.Provider value={value}>{children}</RecommendContext.Provider>;
}

const useRecommend = () => useContext(RecommendContext);

export function RecommendButton() {
  const { data: config } = useApi('/api/config');
  const { status, show } = useRecommend();
  if (!config?.recommend) return null;
  return (
    <button className="update-button" onClick={show} title="Ask the decision model what to watch now">
      {status === 'running' ? 'Thinking…' : 'Recommend'}
    </button>
  );
}

// Seconds since `since`, ticking: a run over all channels can take a minute or more.
function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>;
}

function ScopeSwitch() {
  const { data: config } = useApi('/api/config');
  const { status, scope, setScope } = useRecommend();
  return (
    <div className="theme-switch" role="group" aria-label="Channels to consider">
      {SCOPES.filter((o) => !o.needs || config?.[o.needs]).map((o) => (
        <button
          key={o.value}
          type="button"
          className={scope === o.value ? 'active' : ''}
          aria-pressed={scope === o.value}
          disabled={status === 'running'}
          onClick={() => setScope(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// The wish box: focused when the panel opens, Enter asks.
function WishForm() {
  const { status, wish, setWish, scope, run, stop } = useRecommend();
  const loading = status === 'running';
  return (
    <form
      className="wish"
      onSubmit={(e) => {
        e.preventDefault();
        if (!loading) run(wish.trim(), scope);
      }}
    >
      <input
        autoFocus
        className="search wish-input"
        value={wish}
        onChange={(e) => setWish(e.target.value)}
        maxLength={500}
        placeholder="What are you in the mood for?"
        aria-label="What are you in the mood for"
      />
      {/* Separate keys: reusing one element would turn it back into a submit button while
          the click on Stop is still being handled, and the form would ask again. */}
      {loading ? (
        <button key="stop" className="update-button" type="button" onClick={stop}>
          Stop
        </button>
      ) : (
        <button key="ask" className="update-button" type="submit">
          Ask
        </button>
      )}
    </form>
  );
}

const percent = (p) => `${Math.round(p * 100)}%`;

export function RecommendPanel() {
  const { open, status, result, error, message, startedAt, seconds, scope, close } = useRecommend();
  const { playingId } = usePlayer();
  const [showAll, setShowAll] = useState(false);
  if (!open) return null;

  const ranked = result?.ranked || [];
  const shown = showAll ? ranked : ranked.slice(0, TOP);

  return (
    <section className="recommend" aria-live="polite">
      <div className="recommend-head">
        <h2>Recommended now</h2>
        <button className="recommend-close" onClick={close} aria-label="Close recommendations">✕</button>
      </div>

      <WishForm />
      <div className="recommend-scope">
        <ScopeSwitch />
        {scope !== 'favorites' && status !== 'running' && <span className="muted small">Slower: many model calls</span>}
      </div>
      {status === 'running' && (
        <p className="muted">
          {message || 'Asking the model…'} <Elapsed since={startedAt} />
        </p>
      )}
      {status === 'error' && <p className="recommend-error">{error}</p>}
      {status === 'stopped' && <p className="muted">Stopped after {seconds} s.</p>}

      {status === 'done' && (
        <>
          <ul className="list">
            {shown.map((r) => (
              <li key={r.id} className={`row ${r.id === playingId ? 'playing' : ''}`}>
                <Link to={`/channels/${r.id}`} className="row-link">
                  <ChannelLogo channel={r} />
                  <div className="row-body">
                    <div className="channel-name">
                      {r.name}
                      {r.id === playingId && <PlayingBadge />}
                    </div>
                    <div className="programme-title">
                      <span className="time">
                        {formatTime(r.programme.start)}–{formatTime(r.programme.stop)}
                      </span>
                      {r.programme.title}
                    </div>
                  </div>
                  <div className="probability" title="The model's probability for this pick">
                    {percent(r.probability)}
                  </div>
                </Link>
                {r.playable && <PlayButton channelId={r.id} compact />}
              </li>
            ))}
          </ul>
          {ranked.length > TOP && (
            <button className="link-button" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show top 3' : `Show all ${ranked.length} finalists`}
            </button>
          )}
          <p className="muted small">
            {result.considered} programmes considered
            {result.calls > 1 && ` in ${result.calls} model calls; the final round of ${ranked.length} is shown`}
            {` (${seconds} s)`}.
          </p>
          <details className="recommend-details">
            <summary>Request</summary>
            <p className="muted small">
              Model: {result.model || 'unknown'}. Edit the prompt in <code>{result.promptFile}</code>;
              changes apply on the next Recommend.
            </p>
            <pre>{JSON.stringify(result.request, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
