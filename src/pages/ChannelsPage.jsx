import { Link } from 'react-router-dom';
import { useApi } from '../api.js';
import { ChannelLogo, NoGuideBadge, Status } from '../components.jsx';
import { StarButton } from '../favorites.jsx';
import { PlayingBadge, usePlayer } from '../player.jsx';
import PlayButton from '../PlayButton.jsx';
import { SearchBox, useChannelSearch } from '../search.jsx';

export default function ChannelsPage() {
  const { data, error, loading } = useApi('/api/channels');
  const { query, setQuery, filtered } = useChannelSearch(data);
  const { playingId } = usePlayer();

  return (
    <>
      <SearchBox query={query} setQuery={setQuery} count={data ? filtered.length : undefined} />
      <Status loading={loading} error={error}>
        <ul className="list">
          {filtered.map((ch) => (
            <li key={ch.id} className={`row ${ch.id === playingId ? 'playing' : ''}`}>
              <Link to={`/channels/${ch.id}`} className="row-link">
                <ChannelLogo channel={ch} />
                <div className="row-body">
                  <div className="channel-name">
                    {ch.name}
                    {ch.id === playingId && <PlayingBadge />}
                    {ch.noGuide && <NoGuideBadge />}
                  </div>
                </div>
              </Link>
              {ch.playable && <PlayButton channelId={ch.id} compact />}
              <StarButton channelId={ch.id} />
            </li>
          ))}
        </ul>
      </Status>
    </>
  );
}
