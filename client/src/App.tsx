import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage';
import { CreatePage } from './pages/CreatePage';
import { PlayPage } from './pages/PlayPage';

export function App() {
  // basename keeps every <Link> and <Navigate> inside the game's path prefix.
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<PlayPage />} />
        <Route path="/r/:slug" element={<PlayPage />} />
        <Route path="/new" element={<CreatePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
