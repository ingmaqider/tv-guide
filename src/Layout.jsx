import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ConnectionNotice, PairingPrompt, PhoneButton, PhonePanel } from './phone.jsx';
import { NowPlaying } from './player.jsx';
import PlaylistNotice, { RefreshPlaylistButton } from './PlaylistNotice.jsx';
import { RecommendButton, RecommendPanel } from './recommend.jsx';
import { ThemeSwitch } from './theme.jsx';
import UpdateButton from './UpdateButton.jsx';

export default function Layout() {
  const [phoneOpen, setPhoneOpen] = useState(false);
  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>TV Guide</h1>
          <div className="header-actions">
            <RecommendButton />
            <RefreshPlaylistButton />
            <UpdateButton />
            <PhoneButton open={phoneOpen} onClick={() => setPhoneOpen(!phoneOpen)} />
            <ThemeSwitch />
          </div>
        </div>
        <NowPlaying />
        <nav className="tabs">
          <NavLink to="/favorites" className="tab">Favorites</NavLink>
          <NavLink to="/channels" className="tab">Channels</NavLink>
        </nav>
      </header>
      <main className="content">
        <ConnectionNotice />
        <PairingPrompt />
        <PlaylistNotice />
        <PhonePanel open={phoneOpen} onClose={() => setPhoneOpen(false)} />
        <RecommendPanel />
        <Outlet />
      </main>
    </div>
  );
}
