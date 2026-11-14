import { useEffect, useState } from 'react';
import { send, UNPAIRED, useApi } from './api.js';
import { useConnected, useEvent } from './events.js';

// Phone access (see server/remote.js). On the phone: the pairing screen and a notice when
// the computer can't be reached. On the desktop: the Phone panel and the pairing prompt.

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// The Android app (android/) adds window.TVGuideApp: the device name, "change computer",
// and the volume keys (player.jsx).
const nativeApp = () => window.TVGuideApp;

// Pages opened on this computer (the desktop window, or a browser here) never need pairing.
const onThisComputer = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

// Opened from the desktop's QR code: /?pair=<one-time code>. Taken out of the address
// straight away (before the router starts), so it isn't kept in the history.
const qrCode = new URLSearchParams(location.search).get('pair');
if (qrCode) history.replaceState(history.state, '', location.pathname);

function guessDeviceName() {
  try {
    const name = nativeApp()?.deviceName();
    if (name) return name;
  } catch {
    // An older app without deviceName().
  }
  // "Android 14; Pixel 8 Build/…"; Chrome may reduce the model to "K".
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/|\))/.exec(navigator.userAgent)?.[1];
  return model && model !== 'K' ? model : 'Phone';
}

function ChangeComputer() {
  if (!nativeApp()) return null;
  return (
    <button className="link-button" onClick={() => nativeApp().changeServer()}>
      Use a different computer
    </button>
  );
}

// Shows the app only once this phone is paired. On the computer itself the app shows
// straight away (no wait for /api/hello); it's always paired there.
export function PairGate({ children }) {
  const [hello, setHello] = useState(onThisComputer ? { paired: true } : null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/hello')
      .then((res) => res.json())
      .then(setHello)
      .catch((err) => !onThisComputer && setError(err.message));
    // Removed on the desktop while open, or the API refused a request: pair again.
    const unpaired = () => setHello({ paired: false });
    window.addEventListener(UNPAIRED, unpaired);
    return () => window.removeEventListener(UNPAIRED, unpaired);
  }, []);

  if (error) {
    return (
      <div className="pair">
        <h1>TV Guide</h1>
        <p className="status error">Can't reach TV Guide on the computer: {error}</p>
        <button className="update-button" onClick={() => location.reload()}>Try again</button>
        <ChangeComputer />
      </div>
    );
  }
  if (!hello) return null;
  return hello.paired ? children : <PairScreen />;
}

function PairScreen() {
  const [name, setName] = useState(guessDeviceName);
  // With a QR code it pairs on its own, without waiting for Allow on the computer.
  const [state, setState] = useState({ status: qrCode ? 'scanned' : 'idle', error: null });

  const pair = async (extra) => {
    setState({ status: extra.code ? 'scanned' : 'waiting', error: null });
    try {
      const res = await send('/api/pair', 'POST', { name: name.trim(), ...extra });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      location.reload();
    } catch (err) {
      setState({ status: 'idle', error: err.message });
    }
  };

  useEffect(() => {
    if (qrCode) pair({ code: qrCode });
  }, []);

  if (state.status === 'scanned') {
    return (
      <div className="pair">
        <h1>TV Guide</h1>
        <p>Pairing with the computer…</p>
      </div>
    );
  }

  const waiting = state.status === 'waiting';
  return (
    <div className="pair">
      <h1>TV Guide</h1>
      <p>Connect this phone to TV Guide on the computer. You'll be asked to allow it there once.</p>
      <form
        className="pair-form"
        onSubmit={(e) => {
          e.preventDefault();
          pair({});
        }}
      >
        <label className="muted small" htmlFor="device-name">Name of this phone</label>
        <input
          id="device-name"
          className="search"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          disabled={waiting}
        />
        <button className="play-button" type="submit" disabled={waiting || !name.trim()}>
          {waiting ? 'Waiting…' : 'Connect'}
        </button>
      </form>
      {waiting && <p className="notice">Now click <strong>Allow</strong> in TV Guide on the computer.</p>}
      {state.error && <p className="status error">{state.error}</p>}
      <ChangeComputer />
    </div>
  );
}

// The connection to the computer dropped (it's off, or the phone left the Wi-Fi). Shown
// after a moment so a quick reconnect doesn't flash it.
export function ConnectionNotice() {
  const connected = useConnected();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) return setShow(false);
    const id = setTimeout(() => setShow(true), 2000);
    return () => clearTimeout(id);
  }, [connected]);
  if (!show) return null;
  return (
    <div className="notice" role="status">
      Lost the connection to TV Guide on the computer. Reconnecting… <ChangeComputer />
    </div>
  );
}

// The phone's counterpart of the desktop's Phone panel: which computer it's connected to,
// and Unpair. Confirmed inline: Android's WebView answers confirm() with "cancel".
function ConnectionPanel({ onClose }) {
  const { data: hello } = useApi('/api/hello');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  // Removes this phone on the computer too. The server then closes this page's socket
  // (4401); the event here doesn't wait for that.
  const unpair = async () => {
    setError(null);
    try {
      const res = await send('/api/unpair', 'POST');
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      window.dispatchEvent(new Event(UNPAIRED));
    } catch (err) {
      setError(`Couldn't unpair: ${err.message}`);
    }
  };

  return (
    <section className="recommend phone-panel">
      <div className="recommend-head">
        <h2>Connection</h2>
        <button className="recommend-close" onClick={onClose} aria-label="Close connection settings">✕</button>
      </div>
      <p>
        Connected to TV Guide on <strong>{location.hostname}</strong>
        {hello?.device && (
          <>
            {' '}as <strong>{hello.device}</strong>
          </>
        )}
        .
      </p>
      {confirming ? (
        <>
          <p>
            Unpair this phone? It's removed on the computer too. To use it again, connect and allow it on the
            computer again.
          </p>
          <div className="connection-actions">
            <button className="play-button danger" onClick={unpair}>Unpair</button>
            <button className="update-button" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="connection-actions">
          <button className="update-button" onClick={() => setConfirming(true)}>Unpair this phone</button>
          <ChangeComputer />
        </div>
      )}
      {error && <p className="recommend-error">{error}</p>}
    </section>
  );
}

// --- Desktop (and the phone's Connection panel) ---

// "Phone" on the desktop; "Connection" on the phone.
export function PhoneButton({ open, onClick }) {
  const { data: config } = useApi('/api/config');
  const remote = useEvent('remote');
  if (!config) return null;
  if (config.remote) {
    return (
      <button className={`update-button ${open ? 'active' : ''}`} onClick={onClick} aria-expanded={open}>
        Connection
      </button>
    );
  }
  if (!remote) return null;
  return (
    <button className={`update-button ${open ? 'active' : ''}`} onClick={onClick} aria-expanded={open} title="Control TV Guide from your phone">
      Phone{remote.enabled && remote.listening ? ' ●' : ''}
    </button>
  );
}

// Asked when a phone wants to pair; shown on top of whatever page is open.
export function PairingPrompt() {
  const remote = useEvent('remote');
  if (!remote?.pending.length) return null;
  const answer = (id, allow) => send(`/api/remote/pairings/${id}`, 'POST', { allow });
  return remote.pending.map((p) => (
    <div key={p.id} className="notice pairing" role="alert">
      <span>
        <strong>{p.name}</strong> ({p.ip}) wants to control TV Guide.
      </span>
      <span className="pairing-actions">
        <button className="play-button" onClick={() => answer(p.id, true)}>Allow</button>
        <button className="update-button" onClick={() => answer(p.id, false)}>Deny</button>
      </span>
    </div>
  ));
}

function FirewallHint({ platform, port }) {
  if (platform === 'win32') {
    return (
      <p className="muted small">
        If Windows asks, allow TV Guide on private networks. Otherwise the phone can't connect.
      </p>
    );
  }
  if (platform !== 'linux') return null;
  return (
    <p className="muted small">
      Phone can't connect? A firewall may be blocking port {port}. On Fedora:{' '}
      <code>
        sudo firewall-cmd --permanent --add-port={port}/tcp && sudo firewall-cmd --reload
      </code>
    </p>
  );
}

export function PhonePanel({ open, onClose }) {
  const { data: config } = useApi('/api/config');
  if (!open || !config) return null;
  return config.remote ? <ConnectionPanel onClose={onClose} /> : <DesktopPhonePanel onClose={onClose} />;
}

// The QR code to pair a phone: a link to the phone listener with a one-time code. Shown
// while the panel is open; the server makes a new code when this one expires or is used,
// and drops it when the panel closes.
function PairingQr({ remote }) {
  const [chosen, setChosen] = useState(null);
  const [svg, setSvg] = useState(null);
  const address = remote.addresses.includes(chosen) ? chosen : remote.addresses[0];
  const code = remote.code?.value;
  const url = code && address && `http://${address}:${remote.port}/?pair=${code}`;

  useEffect(() => {
    if (!code) send('/api/remote/code', 'POST').catch((err) => console.error('Failed to get a pairing code', err));
  }, [code]);
  useEffect(() => () => void send('/api/remote/code', 'DELETE').catch(() => {}), []);

  useEffect(() => {
    if (!url) return setSvg(null);
    let current = true;
    // Loaded on demand: only the desktop's Phone panel draws QR codes, phones never do.
    import('qrcode')
      .then((QRCode) => QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }))
      .then((s) => current && setSvg(s))
      .catch((err) => console.error('Failed to draw the QR code', err));
    return () => {
      current = false;
    };
  }, [url]);

  if (!address) return null;
  return (
    <div className="pair-qr">
      {/* Generated SVG from our own URL; dark on white whatever the theme, for scanners. */}
      <div className="pair-qr-code" aria-label="QR code for pairing a phone" role="img" dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
      <div>
        <p>
          <strong>Scan to pair:</strong> tap <em>Scan QR code</em> in the TV Guide app, or point the phone's camera
          at it to open TV Guide in the phone's browser. No need to allow it here.
        </p>
        {remote.addresses.length > 1 && (
          <div className="theme-switch pair-qr-addresses" role="group" aria-label="Address in the QR code">
            {remote.addresses.map((a) => (
              <button key={a} type="button" className={a === address ? 'active' : ''} aria-pressed={a === address} onClick={() => setChosen(a)}>
                {a}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Each code works once and is replaced every 5 minutes.</p>
      </div>
    </div>
  );
}

function DesktopPhonePanel({ onClose }) {
  const remote = useEvent('remote');
  const [busy, setBusy] = useState(false);
  if (!remote) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      await send('/api/remote', 'PUT', { enabled: !remote.enabled });
    } finally {
      setBusy(false);
    }
  };
  const revoke = (device) => {
    if (confirm(`Remove ${device.name}? It will have to be paired again.`)) {
      send(`/api/remote/devices/${device.id}`, 'DELETE');
    }
  };

  return (
    <section className="recommend phone-panel">
      <div className="recommend-head">
        <h2>Phone</h2>
        <button className="recommend-close" onClick={onClose} aria-label="Close phone settings">✕</button>
      </div>
      <label className="phone-toggle">
        <input type="checkbox" checked={remote.enabled} onChange={toggle} disabled={busy} />
        Let phones on this network control TV Guide
      </label>
      {remote.error && <p className="recommend-error">{remote.error}</p>}
      {remote.enabled && remote.listening && (
        <>
          <PairingQr remote={remote} />
          <p>
            Or type this computer's address in the app:{' '}
            {remote.addresses.length ? (
              remote.addresses.map((a, i) => (
                <span key={a}>
                  {i > 0 && ' or '}
                  <strong className="phone-address">{a}</strong>
                </span>
              ))
            ) : (
              <strong>not connected to a network</strong>
            )}
          </p>
          <p className="muted small">
            In a phone browser, open <code>http://{remote.addresses[0] || '…'}:{remote.port}</code>. The phone is
            asked to pair the first time; allow it here.
          </p>
          <FirewallHint platform={remote.platform} port={remote.port} />
        </>
      )}
      <h3 className="phone-devices-title">Paired phones</h3>
      {remote.devices.length ? (
        <ul className="phone-devices">
          {remote.devices.map((d) => (
            <li key={d.id}>
              <span>
                <strong>{d.name}</strong>
                <span className="muted small"> · paired {dateFmt.format(d.pairedAt)} · last used {dateFmt.format(d.lastSeen)}</span>
              </span>
              <button className="update-button" onClick={() => revoke(d)}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None yet.</p>
      )}
    </section>
  );
}
