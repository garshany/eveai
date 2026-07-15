import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Brand } from './Brand';
import { ShieldIcon, TargetIcon } from '../icons';

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
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;

  return (
    <main className="login" style={{ '--route-image': `url(${routeImage})` } as CSSProperties}>
      <header className="login__header">
        <Brand />
        <a className="service-state" href="/health" target="_blank" rel="noreferrer">
          <span className="service-state__dot" />
          Системы доступны
        </a>
      </header>

      <section className="login__content" aria-labelledby="login-title">
        <div className="login__copy">
          <h1 id="login-title"><span>Разведка</span><span>начинается с вопроса</span></h1>
          <p>
            Подключите персонажа, чтобы получать ответы с учётом ваших маршрутов,
            активов и ситуации в Новом Эдеме.
          </p>

          <div className="login__actions">
            <button
              className="button button--primary button--login"
              type="button"
              onClick={onConnect}
              disabled={busy || !ssoConfigured}
            >
              <TargetIcon size={26} />
              {ssoConfigured ? 'Войти через EVE Online' : 'EVE SSO не настроен'}
            </button>
            <button className="text-action" type="button" onClick={onGuest} disabled={busy}>
              Продолжить без подключения
            </button>
          </div>

          {error ? <p className="inline-error" role="alert">{error}</p> : null}

          <div className="trust-note">
            <ShieldIcon size={24} />
            <span>Доступ можно отозвать в любой момент</span>
          </div>
        </div>
      </section>

      <footer className="login__footer">
        <button type="button" onClick={() => setPrivacyOpen(true)}>
          <ShieldIcon size={19} /> Конфиденциальность
        </button>
        <span className="login__footer-divider" />
        <a href="/health" target="_blank" rel="noreferrer">Статус сервиса</a>
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
            <h2 id="privacy-title">Конфиденциальность</h2>
            <p>
              Токены EVE хранятся только на сервере в зашифрованном виде. Браузер
              получает HttpOnly-сессию и никогда не видит ключи провайдера или ESI.
            </p>
            <button className="button button--primary" type="button" onClick={() => setPrivacyOpen(false)}>
              Понятно
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
