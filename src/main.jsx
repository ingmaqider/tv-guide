import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, ScrollRestoration } from 'react-router-dom';
import Layout from './Layout.jsx';
import ChannelsPage from './pages/ChannelsPage.jsx';
import ChannelPage from './pages/ChannelPage.jsx';
import FavoritesPage from './pages/FavoritesPage.jsx';
import { FavoritesProvider } from './favorites.jsx';
import { PlayerProvider } from './player.jsx';
import { RecommendProvider } from './recommend.jsx';
import ScrollButtons from './ScrollButtons.jsx';
import './styles.css';

// ScrollRestoration remembers the scroll position of each history entry, so going back
// from a channel returns to the same spot in the list (list data is cached in useApi so
// the page is fully rendered when the position is restored).
function Root() {
  return (
    <>
      <ScrollRestoration />
      <Outlet />
      <ScrollButtons />
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Navigate to="/favorites" replace /> },
          { path: 'favorites', element: <FavoritesPage /> },
          { path: 'channels', element: <ChannelsPage /> },
          // The old Now tab, now called Channels.
          { path: 'now', element: <Navigate to="/channels" replace /> },
        ],
      },
      { path: 'channels/:id', element: <ChannelPage /> },
      { path: '*', element: <Navigate to="/favorites" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <FavoritesProvider>
      <PlayerProvider>
        <RecommendProvider>
          <RouterProvider router={router} />
        </RecommendProvider>
      </PlayerProvider>
    </FavoritesProvider>
  </React.StrictMode>,
);
