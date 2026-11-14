import { useEffect, useRef, useState } from 'react';
import { reloadAll, send, useApi } from './api.js';
import { useEvent } from './events.js';

const whenFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Explains why Play buttons are missing (or may be out of date) when the playlist can't be
// downloaded. When a download succeeds later, refetches everything so the buttons appear.
// The status comes as the `playlist` event; the server keeps retrying while a page is open.
export default function PlaylistNotice() {
  const data = useEvent('playlist');
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

// "Refresh playlist", on the phone: downloads the playlist on the computer now.
export function RefreshPlaylistButton() {
  const { data: config } = useApi('/api/config');
  const [state, setState] = useState({ busy: false, message: null });

  useEffect(() => {
    if (!state.message) return;
    const id = setTimeout(() => setState((s) => ({ ...s, message: null })), 5000);
    return () => clearTimeout(id);
  }, [state.message]);

  if (!config?.remote || !config.playlist) return null;

  const refresh = async () => {
    setState({ busy: true, message: null });
    try {
      const res = await send('/api/playlist/refresh', 'POST');
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
      setState({ busy: false, message: `Playlist updated: ${body.streams} channels` });
    } catch (err) {
      setState({ busy: false, message: err.message, error: true });
    }
  };

  return (
    <div className="update">
      <button className="update-button" onClick={refresh} disabled={state.busy}>
        {state.busy ? 'Refreshing…' : 'Refresh playlist'}
      </button>
      {state.message && <span className={`update-message ${state.error ? 'error' : ''}`}>{state.message}</span>}
    </div>
  );
}
