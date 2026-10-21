import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, send } from './api.js';

const FavoritesContext = createContext(null);

export function FavoritesProvider({ children }) {
  const [ids, setIds] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchJson('/api/favorites')
      .then(setIds)
      .catch((err) => console.error('Failed to load favorites', err))
      .finally(() => setLoaded(true));
  }, []);

  // Optimistic update; the server's response is the source of truth, and we revert on failure.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const toggle = useCallback((id) => {
    const prev = idsRef.current;
    const on = !prev.includes(id);
    const next = on ? [...prev, id] : prev.filter((x) => x !== id);
    idsRef.current = next;
    setIds(next);
    send(`/api/favorites/${encodeURIComponent(id)}`, on ? 'PUT' : 'DELETE')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setIds)
      .catch((err) => {
        console.error('Failed to update favorites', err);
        setIds(prev);
      });
  }, []);

  const value = useMemo(() => ({ ids: new Set(ids), loaded, toggle }), [ids, loaded, toggle]);
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export const useFavorites = () => useContext(FavoritesContext);

export function StarButton({ channelId }) {
  const { ids, toggle } = useFavorites();
  const on = ids.has(channelId);
  return (
    <button
      className={`star ${on ? 'on' : ''}`}
      onClick={() => toggle(channelId)}
      aria-pressed={on}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
    >
      {on ? '★' : '☆'}
    </button>
  );
}
