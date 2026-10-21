import { useApi } from '../api.js';
import { Status } from '../components.jsx';
import NowList from '../NowList.jsx';
import { SearchBox, useChannelSearch } from '../search.jsx';

export default function NowPage() {
  const { data, error, loading } = useApi('/api/now', 60000);
  const { query, setQuery, filtered } = useChannelSearch(data?.channels);

  return (
    <>
      <SearchBox query={query} setQuery={setQuery} count={data ? filtered.length : undefined} />
      <Status loading={loading} error={error}>
        <NowList channels={filtered} />
      </Status>
    </>
  );
}
