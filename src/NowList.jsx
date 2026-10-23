import { Link } from 'react-router-dom';
import { formatTime, progress, useNow } from './api.js';
import { ChannelLogo, ProgressBar } from './components.jsx';
import { StarButton } from './favorites.jsx';
import { PlayingBadge, usePlayer } from './player.jsx';
import PlayButton from './PlayButton.jsx';

// Channels with what's on now and next; shared by the Now and Favorites tabs.
export default function NowList({ channels }) {
  const now = useNow();
  const { playingId } = usePlayer();

  return (
    <ul className="list">
      {channels.map((ch) => (
        <li key={ch.id} className={`row ${ch.id === playingId ? 'playing' : ''}`}>
          <Link to={`/channels/${ch.id}`} className="row-link">
            <ChannelLogo channel={ch} />
            <div className="row-body">
              <div className="channel-name">
                {ch.name}
                {ch.id === playingId && <PlayingBadge />}
              </div>
              {ch.current ? (
                <>
                  <div className="programme-title">
                    <span className="time">
                      {formatTime(ch.current.start)}–{formatTime(ch.current.stop)}
                    </span>
                    {ch.current.title}
                  </div>
                  <ProgressBar value={progress(ch.current, now)} />
                </>
              ) : (
                <div className="muted">No programme information</div>
              )}
              {ch.next && (
                <div className="muted small">
                  Next: {formatTime(ch.next.start)} {ch.next.title}
                </div>
              )}
            </div>
          </Link>
          {ch.playable && <PlayButton channelId={ch.id} compact />}
          <StarButton channelId={ch.id} />
        </li>
      ))}
    </ul>
  );
}
