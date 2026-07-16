import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Brand } from './Brand';
import { ShieldIcon, TargetIcon } from '../icons';
import { LocaleSwitch, useI18n } from '../i18n';

type LoginScreenProps = {
  busy: boolean;
  ssoConfigured: boolean;
  error: string | null;
  onConnect: () => void;
  onGuest: () => void;
};

export function LoginScreen({
  busy,
  ssoConfigured,
  error,
  onConnect,
  onGuest,
}: LoginScreenProps) {
  const { t } = useI18n();
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;

  return (
    <main className="login" style={{ '--route-image': `url(${routeImage})` } as CSSProperties}>
      <header className="login__header">
        <Brand />
        <a className="service-state" href="/health" target="_blank" rel="noreferrer">
          <span className="service-state__dot" />
          {t('serviceReady')}
        </a>
        <LocaleSwitch />
      </header>

      <section className="login__content" aria-labelledby="login-title">
        <div className="login__copy">
          <h1 id="login-title"><span>{t('loginLine1')}</span><span>{t('loginLine2')}</span></h1>
          <p>{t('loginLead')}</p>

          <div className="login__actions">
            <button
              className="button button--primary button--login"
              type="button"
              onClick={onConnect}
              disabled={busy || !ssoConfigured}
            >
              <TargetIcon size={26} />
              {ssoConfigured ? t('loginEve') : t('ssoMissing')}
            </button>
            <button className="text-action" type="button" onClick={onGuest} disabled={busy}>
              {t('guestContinue')}
            </button>
          </div>

          {error ? <p className="inline-error" role="alert">{error}</p> : null}

          <div className="trust-note">
            <ShieldIcon size={24} />
            <span>{t('revocable')}</span>
          </div>
        </div>
      </section>

      <footer className="login__footer">
        <button type="button" onClick={() => setPrivacyOpen(true)}>
          <ShieldIcon size={19} /> {t('privacy')}
        </button>
        <span className="login__footer-divider" />
        <a href="/health" target="_blank" rel="noreferrer">{t('serviceStatus')}</a>
      </footer>

      {privacyOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setPrivacyOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="privacy-title">{t('privacy')}</h2>
            <p>{t('privacyText')}</p>
            <button className="button button--primary" type="button" onClick={() => setPrivacyOpen(false)}>
              {t('understood')}
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
