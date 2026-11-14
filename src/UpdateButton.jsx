import { useCallback, useEffect, useRef, useState } from 'react';
import { reloadAll, send } from './api.js';
import { useEventEffect } from './events.js';

const busy = (s) => s?.update.state === 'downloading' || s?.update.state === 'processing';
const mb = (bytes) => (bytes / 1e6).toFixed(0);

function label(status) {
  const u = status?.update;
  if (u?.state === 'downloading') {
    return u.total
      ? `Downloading ${Math.round((u.received / u.total) * 100)}%`
      : `Downloading ${mb(u.received)} MB`;
  }
  if (u?.state === 'processing') return 'Processing…';
  return 'Update EPG';
}

// Starts a server-side EPG download and, once the server has swapped in the new data,
// refetches everything on the page. Progress comes as the `epg` event, so an update
// started on another device shows here too.
export default function UpdateButton() {
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState(null);
  const version = useRef(null);
  // Only report the outcome of an update we saw running, not a stale one from earlier.
  const watching = useRef(false);
  const running = busy(status);

  const onEpg = useCallback((s) => {
    setStatus(s);
    if (version.current === null) version.current = s.version;
    if (s.version !== version.current) {
      version.current = s.version;
      reloadAll();
    }
    if (busy(s)) {
      watching.current = true;
    } else if (watching.current) {
      watching.current = false;
      setMessage(s.update.state === 'error' ? `Update failed: ${s.update.error}` : 'EPG updated');
    }
  }, []);
  useEventEffect('epg', onEpg);

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(id);
  }, [message]);

  const start = async () => {
    setMessage(null);
    try {
      const res = await send('/api/epg/update', 'POST');
      // Report the outcome even if the update fails before the first poll sees it running.
      if (res.status === 202) watching.current = true;
      setStatus(await res.json());
    } catch (err) {
      setMessage(`Update failed: ${err.message}`);
    }
  };

  return (
    <div className="update">
      <button className="update-button" onClick={start} disabled={running}>
        {label(status)}
      </button>
      {message && <span className={`update-message ${message.startsWith('Update failed') ? 'error' : ''}`}>{message}</span>}
    </div>
  );
}
