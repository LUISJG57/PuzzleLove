import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { IconX } from '../components/Icons';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { prepareImage, readError } from '../lib/upload';
import { AnalyticsPanel } from './AnalyticsPanel';

interface QueueEntry {
  id: string;
  imageUrl: string;
  createdAt: string;
}

interface AdminStatus {
  authenticated: boolean;
  enabled: boolean;
  global?: { imageUrl: string; players: number; completed: boolean; groups: number; pieces: number };
  queue?: QueueEntry[];
}

export function AdminPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'game' | 'analytics'>('game');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/status');
    setStatus((await res.json()) as AdminStatus);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.authenticated) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [status?.authenticated, refresh]);

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const code = await readError(res);
      setError(code === 'admin_disabled' ? t('admin.disabled') : t('admin.wrongPassword'));
      return;
    }
    setPassword('');
    await refresh();
  };

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    await refresh();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareImage(file);
      const form = new FormData();
      form.append('image', prepared.blob, 'image.jpg');
      const res = await fetch('/api/admin/queue', { method: 'POST', body: form });
      if (!res.ok) setError(t(`create.errors.${await readError(res)}`, { defaultValue: t('create.errors.generic') }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refresh();
  };

  const next = async () => {
    setBusy(true);
    try {
      await fetch('/api/admin/next', { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`page${status?.authenticated && tab === 'analytics' ? ' page-wide' : ''}`}>
      <header className="page-header">
        <Link to="/" className="brand">
          <span aria-hidden="true">🧩</span>
          <span className="brand-name">PuzzleLove</span>
        </Link>
        <LanguageSwitch />
      </header>

      {!status ? (
        <div className="card admin-card">{t('common.loading')}</div>
      ) : !status.authenticated ? (
        <form className="card admin-card narrow" onSubmit={login}>
          <h1>{t('admin.title')}</h1>
          {!status.enabled && <p className="error">{t('admin.disabled')}</p>}
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder={t('admin.password')}
            aria-label={t('admin.password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn primary big" type="submit" disabled={!password}>
            {t('admin.login')}
          </button>
        </form>
      ) : (
        <main className={`card admin-card${tab === 'analytics' ? ' wide' : ''}`}>
          <div className="row between">
            <h1>{t('admin.title')}</h1>
            <button className="btn ghost" type="button" onClick={logout}>
              {t('admin.logout')}
            </button>
          </div>

          <div className="segmented tabs" role="tablist">
            {(['game', 'analytics'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {t(`admin.tabs.${k}`)}
              </button>
            ))}
          </div>

          {tab === 'analytics' && <AnalyticsPanel />}

          {tab === 'game' && status.global && (
            <section className="admin-section">
              <div className="field-label">{t('admin.current')}</div>
              <div className="current-global">
                <img src={status.global.imageUrl} alt="" />
                <div>
                  <span className={`badge ${status.global.completed ? 'done' : ''}`}>
                    {status.global.completed ? t('admin.completed') : t('admin.inProgress')}
                  </span>
                  <p className="muted">
                    {t('admin.status', {
                      players: status.global.players,
                      groups: status.global.groups,
                      pieces: status.global.pieces,
                    })}
                  </p>
                  <button className="btn" type="button" onClick={next} disabled={busy}>
                    {t('admin.next')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {tab === 'game' && (
            <section className="admin-section">
              <div className="row between">
                <div className="field-label">
                  {t('admin.queue')} ({status.queue?.length ?? 0})
                </div>
                <button className="btn primary" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? t('admin.uploading') : t('admin.upload')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>
              {error && <p className="error">{error}</p>}
              {status.queue && status.queue.length > 0 ? (
                <ol className="queue">
                  {status.queue.map((q, i) => (
                    <li key={q.id}>
                      <img src={q.imageUrl} alt="" />
                      <span className="queue-pos">{i + 1}</span>
                      <button className="icon-btn danger" type="button" onClick={() => remove(q.id)} aria-label={t('common.delete')}>
                        <IconX />
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">{t('admin.queueEmpty')}</p>
              )}
            </section>
          )}
        </main>
      )}
    </div>
  );
}
