import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// Case-insensitive, and ё matches е: EPG titles use either spelling for the same film.
const normalize = (text) => text.normalize('NFC').toLocaleLowerCase().replaceAll('ё', 'е');

// Filters channels by name, and with `programmes` also by the title of what's on now (for
// lists from /api/now). The query lives in the URL (?q=) so it survives navigating to a
// channel and back.
export function useChannelSearch(channels, { programmes = false } = {}) {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') || '';

  // preventScrollReset: typing shouldn't make ScrollRestoration jump to the top.
  const setQuery = (value) =>
    setParams(value ? { q: value } : {}, { replace: true, preventScrollReset: true });

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    if (!channels || !q) return channels || [];
    const matches = (text) => !!text && normalize(text).includes(q);
    return channels.filter((ch) => matches(ch.name) || (programmes && matches(ch.current?.title)));
  }, [channels, query, programmes]);

  return { query, setQuery, filtered };
}

export function SearchBox({ query, setQuery, count, programmes = false }) {
  return (
    <>
      <input
        className="search"
        type="search"
        placeholder={programmes ? 'Search channels and what’s on now…' : 'Search channels…'}
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
