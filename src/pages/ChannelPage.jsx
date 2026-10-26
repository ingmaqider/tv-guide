import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { dayKey, formatDay, formatTime, progress, useApi, useNow } from '../api.js';
import { ChannelLogo, NoGuideBadge, ProgressBar, Status } from '../components.jsx';
import { StarButton } from '../favorites.jsx';
import { PlayingBadge, usePlayer } from '../player.jsx';
import PlayButton from '../PlayButton.jsx';
import PlaylistNotice from '../PlaylistNotice.jsx';

export default function ChannelPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, error, loading } = useApi(`/api/channels/${encodeURIComponent(id)}`);
  const now = useNow();
  const [day, setDay] = useState(() => dayKey(Date.now()));
  const currentRef = useRef(null);
  const { playingId } = usePlayer();

  // Go back to wherever we came from (keeps the search query); fall back to the list.
  const goBack = () => (location.key !== 'default' ? navigate(-1) : navigate('/channels'));

  const days = useMemo(() => {
    const map = new Map();
    for (const p of data?.programmes || []) {
      const key = dayKey(p.start);
      if (!map.has(key)) map.set(key, { key, label: formatDay(p.start), programmes: [] });
      map.get(key).programmes.push(p);
    }
    return [...map.values()];
  }, [data]);

  const selected = days.find((d) => d.key === day) || days[0];

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, [selected]);

  return (
    <div className="app">
      <header className="header">
        <button className="back" onClick={goBack}>← Back</button>
        {data && (
          <div className="channel-header">
            <ChannelLogo channel={data.channel} />
            <h1>
              {data.channel.name}
              {data.channel.id === playingId && <PlayingBadge />}
              {data.noGuide && <NoGuideBadge />}
            </h1>
            <StarButton channelId={data.channel.id} />
            {data.playable && <PlayButton channelId={data.channel.id} />}
          </div>
        )}
      </header>
      <main className="content">
        <PlaylistNotice />
        <Status loading={loading} error={error}>
          {days.length === 0 ? (
            <p className="status">
              {data?.noGuide
                ? "This channel is in your playlist but not in the programme guide, so there's no schedule. You can still play it."
                : 'No programme information for this channel.'}
            </p>
          ) : (
            <>
              <div className="days">
                {days.map((d) => (
                  <button
                    key={d.key}
                    className={`day ${d === selected ? 'active' : ''}`}
                    onClick={() => setDay(d.key)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <ul className="schedule">
                {selected.programmes.map((p) => {
                  const isCurrent = p.start <= now && now < p.stop;
                  const isPast = p.stop <= now;
                  return (
                    <li
                      key={p.start}
                      ref={isCurrent ? currentRef : null}
                      className={`programme ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}`}
                    >
                      <div className="time">{formatTime(p.start)}</div>
                      <div className="row-body">
                        <div className="programme-title">
                          {p.title}
                          {isCurrent && <span className="badge">Now</span>}
                        </div>
                        {isCurrent && <ProgressBar value={progress(p, now)} />}
                        {p.desc && p.desc !== 'Нет описания' && (
                          <div className="muted small desc">{p.desc}</div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Status>
      </main>
    </div>
  );
}
