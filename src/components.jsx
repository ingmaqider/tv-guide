import { useState } from 'react';

export function ChannelLogo({ channel }) {
  const [failed, setFailed] = useState(false);
  if (!channel.icon || failed) {
    return <div className="logo logo-fallback">{channel.name.slice(0, 2)}</div>;
  }
  return (
    <img className="logo" src={channel.icon} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}

export function Status({ loading, error, children }) {
  if (error) return <p className="status error">Error: {error.message}</p>;
  if (loading) return <p className="status">Loading TV guide… (the first load can take a few seconds)</p>;
  return children;
}

export function ProgressBar({ value }) {
  return (
    <div className="progress">
      <div className="progress-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

// A channel from the playlist that the EPG doesn't list: playable, but no schedule.
export const NoGuideBadge = () => (
  <span className="badge no-guide-badge" title="In your playlist, but not in the programme guide">
    No guide
  </span>
);
