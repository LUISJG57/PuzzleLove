import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_NAME_LENGTH, PLAYER_COLORS } from '@puzzlelove/shared';
import { randomColor, savePlayer, type LocalPlayer } from '../lib/player';
import { sounds } from '../audio/sounds';
import { LanguageSwitch } from './LanguageSwitch';

export function NameDialog({ initial, onDone }: { initial: LocalPlayer | null; onDone: (p: LocalPlayer) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? randomColor());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    sounds.unlock();
    onDone(savePlayer(name, color));
  };

  return (
    <div className="modal-backdrop">
      <form className="modal card name-dialog" onSubmit={submit}>
        <div className="modal-top">
          <span className="brand-mark">🧩</span>
          <LanguageSwitch />
        </div>
        <h1>{t('name.title')}</h1>
        <p className="muted">{t('name.subtitle')}</p>
        <input
          autoFocus
          className="input"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          placeholder={t('name.placeholder')}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('name.placeholder')}
        />
        <div className="field-label">{t('name.color')}</div>
        <div className="swatches">
          {PLAYER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${c === color ? 'selected' : ''}`}
              style={{ background: c }}
              aria-label={c}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <button className="btn primary big" type="submit" disabled={!name.trim()}>
          {t('name.submit')}
        </button>
      </form>
    </div>
  );
}
