import { NavLink, Outlet } from 'react-router-dom';
import { NowPlaying } from './player.jsx';
import PlaylistNotice from './PlaylistNotice.jsx';
import { RecommendButton, RecommendPanel } from './recommend.jsx';
import { ThemeSwitch } from './theme.jsx';
import UpdateButton from './UpdateButton.jsx';

export default function Layout() {
  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>TV Guide</h1>
          <div className="header-actions">
            <RecommendButton />
            <UpdateButton />
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
        <PlaylistNotice />
        <RecommendPanel />
        <Outlet />
      </main>
    </div>
  );
}
