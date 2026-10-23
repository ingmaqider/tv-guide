import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, send } from './api.js';

const POLL_MS = 3000;
const PlayerContext = createContext(null);

// What the VLC window opened by this app is doing ({ state, channel, programme }), polled
// from the server. Play and the controls update it from their responses straight away.
export function PlayerProvider({ children }) {
  const [status, setStatus] = useState({ state: 'closed', channel: null });

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
    () => ({ ...status, playingId: status.channel?.id ?? null, update: setStatus, command }),
    [status, command],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export const usePlayer = () => useContext(PlayerContext);

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
  const { state, channel, programme, command } = usePlayer();
  if (!channel) return null;
  return (
    <div className="now-playing" aria-live="polite">
      <span className="now-playing-state">{LABELS[state]}</span>
      <Link to={`/channels/${channel.id}`} className="now-playing-title">
        <strong>{channel.name}</strong>
        {programme && <span className="muted"> · {programme.title}</span>}
      </Link>
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
