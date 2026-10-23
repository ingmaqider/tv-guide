import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchJson } from './api.js';

const LastPlayedContext = createContext(null);

// The channel Play was last clicked on, so lists can highlight it. Set by PlayButton from
// the server's response; the server keeps it across restarts.
export function LastPlayedProvider({ children }) {
  const [id, setId] = useState(null);

  useEffect(() => {
    fetchJson('/api/last-played')
      .then((last) => setId(last.id))
      .catch((err) => console.error('Failed to load last played channel', err));
  }, []);

  const value = useMemo(() => ({ id, setId }), [id]);
  return <LastPlayedContext.Provider value={value}>{children}</LastPlayedContext.Provider>;
}

export const useLastPlayed = () => useContext(LastPlayedContext);

export const PlayingBadge = () => (
  <span className="badge playing-badge" title="Play was last clicked on this channel">
    ▶ Playing
  </span>
);
