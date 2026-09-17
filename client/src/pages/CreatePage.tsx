import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { DEFAULT_PIECE_COUNT, PIECE_COUNT_OPTIONS, gridForPieceCount } from '@puzzlelove/shared';
import { IconImage } from '../components/Icons';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { prepareImage, readError, type PreparedImage } from '../lib/upload';

const KNOWN_ERRORS = ['invalid_image', 'image_too_small', 'file_too_large', 'rate_limited'];

export function CreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pieces, setPieces] = useState<number>(DEFAULT_PIECE_COUNT);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) {
      setError('invalid_image');
      return;
    }
    const prepared = await prepareImage(file);
    setImage(prepared);
    setPreview(URL.createObjectURL(prepared.blob));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void pick(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!image || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('pieces', String(pieces));
      form.append('image', image.blob, 'image.jpg');
      const res = await fetch('/api/rooms', { method: 'POST', body: form });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const { slug } = (await res.json()) as { slug: string };
      navigate(`/r/${slug}`);
    } catch {
      setError('generic');
    } finally {
      setBusy(false);
    }
  };

  const grid = image && image.width > 0 ? gridForPieceCount(pieces, image.width, image.height) : null;

  return (
    <div className="page">
      <header className="page-header">
        <Link to="/" className="brand">
          <span aria-hidden="true">🧩</span>
          <span className="brand-name">PuzzleLove</span>
        </Link>
        <LanguageSwitch />
      </header>

      <main className="card create-card">
        <h1>{t('create.title')}</h1>
        <p className="muted">{t('create.subtitle')}</p>

        <div
          className={`dropzone ${dragOver ? 'over' : ''} ${preview ? 'has-image' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {preview ? (
            <div className="preview">
              <img src={preview} alt="" />
              {grid && (
                <div
                  className="grid-overlay"
                  style={{
                    backgroundSize: `${100 / grid.cols}% ${100 / grid.rows}%`,
                  }}
                />
              )}
            </div>
          ) : (
            <div className="dropzone-empty">
              <IconImage width={40} height={40} />
              <span>{t('create.drop')}</span>
              <span className="muted small">{t('create.or')}</span>
            </div>
          )}
          <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
            {preview ? t('create.change') : t('create.choose')}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        <div className="field-label">{t('create.pieces')}</div>
        <div className="segmented" role="radiogroup" aria-label={t('create.pieces')}>
          {PIECE_COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={pieces === n}
              className={pieces === n ? 'active' : ''}
              onClick={() => setPieces(n)}
            >
              {n}
            </button>
          ))}
        </div>

        {error && <div className="error">{t(KNOWN_ERRORS.includes(error) ? `create.errors.${error}` : 'create.errors.generic')}</div>}

        <button type="button" className="btn primary big" disabled={!image || busy} onClick={submit}>
          {busy ? t('create.creating') : t('create.submit')}
        </button>
        <p className="muted small center">{t('create.expires')}</p>
      </main>
    </div>
  );
}
