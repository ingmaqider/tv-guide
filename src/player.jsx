import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchJson, send } from './api.js';
import { useFavorites } from './favorites.jsx';

const POLL_MS = 3000;
const PlayerContext = createContext(null);

export const rowId = (channelId) => `channel-${channelId}`;

// Centered so the sticky header doesn't cover the row; instant like the ScrollButtons.
function scrollToRow(channelId) {
  const row = document.getElementById(rowId(channelId));
  row?.scrollIntoView({ block: 'center', behavior: 'instant' });
  return !!row;
}

// What the VLC window opened by this app is doing ({ state, channel, programme }), polled
// from the server. Play and the controls update it from their responses straight away.
export function PlayerProvider({ children }) {
  const [status, setStatus] = useState({ state: 'closed', channel: null });
  const [revealId, setRevealId] = useState(null);

  useEffect(() => {
    let timer;
    let stopped = false;
    const poll = () => {
      fetchJson('/api/player')
        .then((s) => !stopped && setStatus(s))
        .catch((err) => console.error('Failed to get player status', err))
        .finally(() => {
          if (!stopped) timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const command = useCallback(async (name) => {
    const res = await send(`/api/player/${name}`, 'POST');
    const body = await res.json();
    if (res.ok) setStatus(body);
  }, []);

  const value = useMemo(
    () => ({
      ...status,
      playingId: status.channel?.id ?? null,
      update: setStatus,
      command,
      revealId,
      setRevealId,
    }),
    [status, command, revealId],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export const usePlayer = () => useContext(PlayerContext);

// Finishes a reveal started in NowPlaying once the list contains the row (it may still be
// loading, or be about to lose the search filter that hid the row).
export function useReveal(channels) {
  const { revealId, setRevealId } = usePlayer();
  useEffect(() => {
    if (revealId && scrollToRow(revealId)) setRevealId(null);
  }, [revealId, channels, setRevealId]);
}

const LABELS = { playing: '▶ Playing', paused: '❚❚ Paused', opening: 'Opening…' };

export function PlayingBadge() {
  const { state } = usePlayer();
  return (
    <span className={`badge playing-badge ${state}`} title="In the VLC window opened from TV Guide">
      {LABELS[state] || LABELS.playing}
    </span>
  );
}

// Shown in the header while VLC plays (or has paused) one of our channels.
export function NowPlaying() {
  const { state, channel, programme, command, setRevealId } = usePlayer();
  const { ids } = useFavorites();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (!channel) return null;

  // Row hidden by a search, or not on this tab: drop the search, and leave Favorites only
  // if the channel isn't one. The list scrolls once it shows the row (useReveal).
  const reveal = () => {
    if (scrollToRow(channel.id)) return;
    setRevealId(channel.id);
    navigate(pathname === '/favorites' && ids.has(channel.id) ? '/favorites' : '/channels');
  };

  return (
    <div className="now-playing" aria-live="polite">
      <button className="now-playing-reveal" onClick={reveal} title="Show in the list">
        <span className="now-playing-state">{LABELS[state]}</span>
        <span className="now-playing-title">
          <strong>{channel.name}</strong>
          {programme && <span className="muted"> · {programme.title}</span>}
        </span>
      </button>
      {state !== 'opening' && (
        <span className="now-playing-controls">
          <button className="update-button" onClick={() => command('pause')}>
            {state === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button className="update-button" onClick={() => command('stop')}>
            Stop
          </button>
        </span>
      )}
    </div>
  );
}
