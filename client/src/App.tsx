import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage';
import { CreatePage } from './pages/CreatePage';
import { PlayPage } from './pages/PlayPage';

export function App() {
  return (
    <BrowserRouter>
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
