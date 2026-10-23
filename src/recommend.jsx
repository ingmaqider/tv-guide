import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatTime, send, useApi } from './api.js';
import { ChannelLogo } from './components.jsx';
import { PlayingBadge, useLastPlayed } from './lastPlayed.jsx';
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

// Kept above the router so the result survives opening a channel and coming back.
export function RecommendProvider({ children }) {
  const [state, setState] = useState({ open: false, status: 'idle' });
  const [wish, setWish] = useState(loadWish);
  const [scope, setScope] = useState('favorites');

  // `wish` is the free text typed in the panel; the server puts it into the prompt's
  // {{wish}} placeholder.
  const run = useCallback(async (text, scope) => {
    saveWish(text);
    const startedAt = Date.now();
    setState((s) => ({ ...s, open: true, status: 'loading', error: null, startedAt }));
    try {
      // The server answers 503 while favorites' schedules are still loading.
      let res;
      while ((res = await send('/api/recommend', 'POST', { wish: text, scope })).status === 503) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setState({ open: true, status: 'done', result: body, seconds: Math.round((Date.now() - startedAt) / 1000) });
    } catch (err) {
      setState({ open: true, status: 'error', error: err.message });
    }
  }, []);

  const show = useCallback(() => setState((s) => ({ ...s, open: true })), []);
  const close = useCallback(() => setState({ open: false, status: 'idle' }), []);
  const value = useMemo(() => ({ ...state, wish, setWish, scope, setScope, run, show, close }),
    [state, wish, scope, run, show, close],);
  return <RecommendContext.Provider value={value}>{children}</RecommendContext.Provider>;
}

const useRecommend = () => useContext(RecommendContext);

export function RecommendButton() {
  const { data: config } = useApi('/api/config');
  const { status, show } = useRecommend();
  if (!config?.recommend) return null;
  return (
    <button className="update-button" onClick={show} disabled={status === 'loading'} title="Ask the decision model what to watch now">
      {status === 'loading' ? 'Thinking…' : 'Recommend'}
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
          disabled={status === 'loading'}
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
  const { status, wish, setWish, scope, run } = useRecommend();
  const loading = status === 'loading';
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
      <button className="update-button" type="submit" disabled={loading}>
        {loading ? 'Thinking…' : 'Ask'}
      </button>
    </form>
  );
}

const percent = (p) => `${Math.round(p * 100)}%`;

export function RecommendPanel() {
  const { open, status, result, error, startedAt, seconds, scope, close } = useRecommend();
  const { id: playingId } = useLastPlayed();
  const [showAll, setShowAll] = useState(false);
  if (!open) return null;

  const ranked = result?.ranked || [];
  const shown = showAll ? ranked : ranked.slice(0, TOP);

  return (
    <section className="recommend" aria-live="polite">
      <div className="recommend-head">
        <h2>Recommended now</h2>
        {status !== 'loading' && (
          <button className="recommend-close" onClick={close} aria-label="Close recommendations">✕</button>
        )}
      </div>

      <WishForm />
      <div className="recommend-scope">
        <ScopeSwitch />
        {scope !== 'favorites' && status !== 'loading' && <span className="muted small">Slower: many model calls</span>}
      </div>
      {status === 'loading' && (
        <p className="muted">
          Asking the model… <Elapsed since={startedAt} />
        </p>
      )}
      {status === 'error' && <p className="recommend-error">{error}</p>}

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
