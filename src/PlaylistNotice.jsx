import { useEffect, useRef } from 'react';
import { reloadAll, useApi } from './api.js';

const POLL_MS = 30000;
const whenFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Explains why Play buttons are missing (or may be out of date) when the playlist can't be
// downloaded. When a download succeeds later, refetches everything so the buttons appear.
export default function PlaylistNotice() {
  const { data } = useApi('/api/playlist', POLL_MS);
  const version = useRef(null);

  useEffect(() => {
    if (!data) return;
    if (version.current !== null && data.version !== version.current) reloadAll();
    version.current = data.version;
  }, [data?.version]);

  if (!data?.configured || !data.error) return null;
  return (
    <div className="notice" role="status">
      {data.error}.{' '}
      {data.streams
        ? `Play uses the playlist saved ${whenFmt.format(data.updatedAt)}.`
        : 'Play buttons are hidden until it loads.'}{' '}
      Retrying every minute.
    </div>
  );
}
