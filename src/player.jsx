import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { send, useApi } from './api.js';
import { setLatest, useEvent } from './events.js';
import { useFavorites } from './favorites.jsx';

const CLOSED = { state: 'closed', channel: null, volume: null };
const PlayerContext = createContext(null);
// Same as the server's MAX_VOLUME (VLC's own slider goes to 125%).
const MAX_VOLUME = 125;
const VOLUME_STEP = 5;
// While dragging the slider, at most this often to VLC.
const VOLUME_SEND_MS = 150;

export const rowId = (channelId) => `channel-${channelId}`;

// Centered so the sticky header doesn't cover the row; instant like the ScrollButtons.
function scrollToRow(channelId) {
  const row = document.getElementById(rowId(channelId));
  row?.scrollIntoView({ block: 'center', behavior: 'instant' });
  return !!row;
}

const update = (status) => setLatest('player', status);

// What the VLC window opened by this app is doing ({ state, channel, programme, volume }),
// pushed by the server (the `player` event). Play and the controls update it from their
// responses straight away.
export function PlayerProvider({ children }) {
  const status = useEvent('player') || CLOSED;
  const [revealId, setRevealId] = useState(null);

  const command = useCallback(async (name, body) => {
    const res = await send(`/api/player/${name}`, 'POST', body);
    const next = await res.json();
    if (res.ok) update(next);
  }, []);

  // The volume just chosen here is shown until VLC reports it, so the slider doesn't jump
  // back while requests are in flight. Sends are throttled while dragging.
  const [chosen, setChosen] = useState(null); // { value, at }
  const volume = chosen && Date.now() - chosen.at < 1500 ? chosen.value : status.volume;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const toSend = useRef(null);
  const sendTimer = useRef(null);
  const setVolume = useCallback(
    (v) => {
      const value = Math.min(MAX_VOLUME, Math.max(0, Math.round(v)));
      setChosen({ value, at: Date.now() });
      volumeRef.current = value;
      toSend.current = value;
      sendTimer.current ??= setTimeout(() => {
        sendTimer.current = null;
        command('volume', { value: toSend.current }).catch((err) => console.error('Failed to set volume', err));
      }, VOLUME_SEND_MS);
    },
    [command],
  );

  // In the Android app the hardware volume keys control VLC while it's open (MainActivity
  // asks the page through tvGuideVolumeStep).
  const vlcOpen = status.volume != null;
  useEffect(() => {
    const app = window.TVGuideApp;
    if (!app) return;
    app.setVolumeKeys(vlcOpen);
    window.tvGuideVolumeStep = (direction) => {
      if (volumeRef.current != null) setVolume(volumeRef.current + direction * VOLUME_STEP);
    };
  }, [vlcOpen, setVolume]);

  const value = useMemo(
    () => ({
      ...status,
      volume,
      setVolume,
      playingId: status.channel?.id ?? null,
      update,
      command,
      revealId,
      setRevealId,
    }),
    [status, volume, setVolume, command, revealId],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export const usePlayer = () => useContext(PlayerContext);

// Finishes a reveal started in NowPlaying once the list contains the row (it may still be
// loading, or be about to lose the search filter that hid the row).
export function useReveal(channels) {
  const { revealId, setRevealId } = usePlayer();
  useEffect(() => {
    if (revealId && scrollToRow(revealId)) setRevealId(null);
  }, [revealId, channels, setRevealId]);
}

const LABELS = { playing: '▶ Playing', paused: '❚❚ Paused', opening: 'Opening…' };

export function PlayingBadge() {
  const { state } = usePlayer();
  return (
    <span className={`badge playing-badge ${state}`} title="In the VLC window opened from TV Guide">
      {LABELS[state] || LABELS.playing}
    </span>
  );
}

// VLC's volume, on the phone only (the desktop has VLC's own window for that).
function VolumeControl() {
  const { volume, setVolume } = usePlayer();
  if (volume == null) return null;
  return (
    <div className="volume">
      <button className="volume-step" onClick={() => setVolume(volume - VOLUME_STEP)} aria-label="Quieter">−</button>
      <input
        type="range"
        min="0"
        max={MAX_VOLUME}
        step="1"
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        aria-label="VLC volume"
      />
      <button className="volume-step" onClick={() => setVolume(volume + VOLUME_STEP)} aria-label="Louder">+</button>
      <span className="volume-value">{volume}%</span>
    </div>
  );
}

// Shown in the header while VLC plays (or has paused) one of our channels.
export function NowPlaying() {
  const { state, channel, programme, command, setRevealId } = usePlayer();
  const { ids } = useFavorites();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data: config } = useApi('/api/config');
  if (!channel) return null;

  // Row hidden by a search, or not on this tab: drop the search, and leave Favorites only
  // if the channel isn't one. The list scrolls once it shows the row (useReveal).
  const reveal = () => {
    if (scrollToRow(channel.id)) return;
    setRevealId(channel.id);
    navigate(pathname === '/favorites' && ids.has(channel.id) ? '/favorites' : '/channels');
  };

  return (
    <div className="now-playing" aria-live="polite">
      <button className="now-playing-reveal" onClick={reveal} title="Show in the list">
        <span className="now-playing-state">{LABELS[state]}</span>
        <span className="now-playing-title">
          <strong>{channel.name}</strong>
          {programme && <span className="muted"> · {programme.title}</span>}
        </span>
      </button>
      {state !== 'opening' && (
        <span className="now-playing-controls">
          <button className="update-button" onClick={() => command('pause')}>
            {state === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button className="update-button" onClick={() => command('stop')}>
            Stop
          </button>
        </span>
      )}
      {config?.remote && <VolumeControl />}
    </div>
  );
}
