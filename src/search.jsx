import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// Filters channels by name. The query lives in the URL (?q=) so it survives navigating
// to a channel and back.
export function useChannelSearch(channels) {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') || '';

  // preventScrollReset: typing shouldn't make ScrollRestoration jump to the top.
  const setQuery = (value) =>
    setParams(value ? { q: value } : {}, { replace: true, preventScrollReset: true });

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!channels || !q) return channels || [];
    return channels.filter((ch) => ch.name.toLocaleLowerCase().includes(q));
  }, [channels, query]);

  return { query, setQuery, filtered };
}

export function SearchBox({ query, setQuery, count }) {
  return (
    <>
      <input
        className="search"
        type="search"
        placeholder="Search channels…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {count !== undefined && (
        <p className="muted small">
          {count} {count === 1 ? 'channel' : 'channels'}
        </p>
      )}
    </>
  );
}
