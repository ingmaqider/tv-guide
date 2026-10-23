import { useEffect, useState } from 'react';
import { send } from './api.js';
import { useLastPlayed } from './lastPlayed.jsx';

// Asks the server to open the channel's stream in VLC. `compact` is the icon-only
// version used in list rows.
export default function PlayButton({ channelId, compact = false }) {
  const [state, setState] = useState({ status: 'idle', message: null });
  const { setId: setLastPlayed } = useLastPlayed();

  const play = async () => {
    setState({ status: 'starting', message: null });
    try {
      const res = await send(`/api/channels/${encodeURIComponent(channelId)}/play`, 'POST');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setLastPlayed(body.lastPlayed.id);
      setState({ status: 'idle', message: 'Opening in VLC…' });
    } catch (err) {
      setState({ status: 'idle', message: `Couldn't play: ${err.message}`, error: true });
    }
  };

  useEffect(() => {
    if (!state.message) return;
    const id = setTimeout(() => setState((s) => ({ ...s, message: null })), 5000);
    return () => clearTimeout(id);
  }, [state.message]);

  return (
    <div className={`update ${compact ? 'play-compact' : ''}`}>
      <button
        className={compact ? 'play-icon' : 'play-button'}
        onClick={play}
        disabled={state.status === 'starting'}
        title="Play in VLC"
        aria-label="Play in VLC"
      >
        {compact ? '▶' : '▶ Play'}
      </button>
      {state.message && <span className={`update-message ${state.error ? 'error' : ''}`}>{state.message}</span>}
    </div>
  );
}
