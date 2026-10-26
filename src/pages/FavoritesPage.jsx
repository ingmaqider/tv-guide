import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api.js';
import { Status } from '../components.jsx';
import { useFavorites } from '../favorites.jsx';
import NowList from '../NowList.jsx';
import { SearchBox, useChannelSearch } from '../search.jsx';

export default function FavoritesPage() {
  // Favorites are parsed first on server start, so this is available before /api/now.
  const { data, error, loading } = useApi('/api/now?favorites=1', 60000);
  const { ids, loaded } = useFavorites();

  const favorites = useMemo(
    () => (data ? data.channels.filter((ch) => ids.has(ch.id)) : []),
    [data, ids],
  );
  const { query, setQuery, filtered } = useChannelSearch(favorites, { programmes: true });

  return (
    <>
      <SearchBox query={query} setQuery={setQuery} count={data ? filtered.length : undefined} programmes />
      <Status loading={loading || !loaded} error={error}>
        {favorites.length === 0 ? (
          <p className="status">
            No favorites yet. Tap ☆ next to a channel on the <Link to="/now">Now</Link> or{' '}
            <Link to="/channels">Channels</Link> tab to add it here.
          </p>
        ) : (
          <NowList channels={filtered} />
        )}
      </Status>
    </>
  );
}
