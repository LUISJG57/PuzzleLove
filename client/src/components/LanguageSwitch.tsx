import { useTranslation } from 'react-i18next';

export function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage === 'en' ? 'en' : 'es';
  return (
    <div className="lang-switch" role="group" aria-label={t('common.language')}>
      {(['es', 'en'] as const).map((lng) => (
        <button
          key={lng}
          type="button"
          className={current === lng ? 'active' : ''}
          aria-pressed={current === lng}
          onClick={() => void i18n.changeLanguage(lng)}
        >
          {lng.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
