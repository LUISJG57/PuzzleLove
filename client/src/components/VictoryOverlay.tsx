import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { CompletedEvent } from '@puzzlelove/shared';
import { IconX } from './Icons';

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface Props {
  data: CompletedEvent;
  isGlobal: boolean;
  clockOffset: number;
  myClientId: string;
  onClose: () => void;
  onAgain: () => void;
}

export function VictoryOverlay({ data, isGlobal, clockOffset, myClientId, onClose, onAgain }: Props) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!data.nextPuzzleAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [data.nextPuzzleAt]);

  const secondsLeft = data.nextPuzzleAt ? Math.ceil((data.nextPuzzleAt - (now + clockOffset)) / 1000) : null;
  const maxCount = Math.max(1, ...data.scores.map((s) => s.count));

  return (
    <div className="victory-backdrop">
      <div className="card victory">
        <button className="icon-btn close" type="button" onClick={onClose} aria-label={t('common.close')}>
          <IconX />
        </button>
        <div className="victory-emoji" aria-hidden="true">
          🎉
        </div>
        <h2>{t('victory.title')}</h2>
        <div className="victory-time">
          <span className="muted">{t('victory.time')}</span>
          <strong>{formatDuration(data.durationMs)}</strong>
        </div>

        {data.scores.length > 0 && (
          <div className="ranking">
            <div className="field-label">{t('victory.ranking')}</div>
            <ol>
              {data.scores.map((s, i) => (
                <li key={s.clientId} className={s.clientId === myClientId ? 'me' : ''}>
                  <span className="rank">{i === 0 ? '🏆' : i + 1}</span>
                  <span className="dot" style={{ background: s.color }} />
                  <span className="rname">{s.name}</span>
                  <span className="bar">
                    <span style={{ width: `${(s.count / maxCount) * 100}%`, background: s.color }} />
                  </span>
                  <strong>{s.count}</strong>
                </li>
              ))}
            </ol>
          </div>
        )}

        {isGlobal ? (
          <p className="next-puzzle">
            {secondsLeft !== null && secondsLeft > 0 ? t('victory.nextIn', { seconds: secondsLeft }) : t('victory.nextSoon')}
          </p>
        ) : (
          <div className="victory-actions">
            <button className="btn primary" type="button" onClick={onAgain}>
              {t('victory.again')}
            </button>
            <Link className="btn" to="/new">
              {t('victory.newRoom')}
            </Link>
          </div>
        )}
        <button className="btn ghost" type="button" onClick={onClose}>
          {t('victory.viewPuzzle')}
        </button>
      </div>
    </div>
  );
}
