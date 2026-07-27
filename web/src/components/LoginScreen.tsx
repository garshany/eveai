import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Brand } from './Brand';
import { ChartIcon, ShieldIcon, TargetIcon } from '../icons';
import { LocaleSwitch, useI18n } from '../i18n';
import {
  INITIAL_TURNSTILE_TOKEN_STATE,
  reduceTurnstileToken,
  type TurnstileTokenEvent,
  type TurnstileTokenState,
} from '../turnstile-token';
import { TurnstileWidget } from './TurnstileWidget';

type LoginScreenProps = {
  busy: boolean;
  ssoConfigured: boolean;
  error: string | null;
  turnstileSiteKey: string | null;
  onConnect: (turnstileToken?: string) => Promise<boolean>;
  onGuest: (turnstileToken?: string) => Promise<boolean>;
  onShowSupport: () => void;
};

type PendingLoginAction = 'connect' | 'guest';

export function LoginScreen({
  busy,
  ssoConfigured,
  error,
  turnstileSiteKey,
  onConnect,
  onGuest,
  onShowSupport,
}: LoginScreenProps) {
  const { t } = useI18n();
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [turnstileState, setTurnstileState] = useState<TurnstileTokenState>(INITIAL_TURNSTILE_TOKEN_STATE);
  const [turnstileVisible, setTurnstileVisible] = useState(false);
  const turnstileRef = useRef(turnstileState);
  const actionsRef = useRef({ onConnect, onGuest });
  const pendingActionRef = useRef<PendingLoginAction | null>(null);
  const routeImage = `${import.meta.env.BASE_URL}assets/orbit-route.png`;

  useEffect(() => {
    actionsRef.current = { onConnect, onGuest };
  });

  // Токен одноразовый: после сброшенного состояния (resetWidget) виджет
  // перемонтируется сам, потому что рендерится только в фазе idle.
  const applyTurnstileEvent = useCallback((event: TurnstileTokenEvent) => {
    const transition = reduceTurnstileToken(turnstileRef.current, event);
    turnstileRef.current = transition.state;
    setTurnstileState(transition.state);
    if (transition.resetWidget) pendingActionRef.current = null;
  }, []);

  const executeAction = useCallback(async (action: PendingLoginAction) => {
    const current = turnstileRef.current;
    const token = current.phase === 'idle' ? undefined : current.token;
    if (current.phase === 'ready') applyTurnstileEvent({ type: 'requestStarted' });
    const run = action === 'connect' ? actionsRef.current.onConnect : actionsRef.current.onGuest;
    const succeeded = await run(token);
    if (turnstileRef.current.phase === 'inFlight') {
      applyTurnstileEvent(succeeded ? { type: 'requestSucceeded' } : { type: 'requestFailed' });
    }
  }, [applyTurnstileEvent]);

  // Стабильный коллбэк: иначе TurnstileWidget перемонтирует виджет на каждый
  // рендер (onToken у него в зависимостях эффекта) и теряет выданный токен.
  const handleTurnstileToken = useCallback((token: string | null) => {
    if (!token) {
      applyTurnstileEvent({ type: 'tokenExpired' });
      return;
    }
    applyTurnstileEvent({ type: 'tokenReceived', token });
    const pending = pendingActionRef.current;
    if (!pending) return;
    pendingActionRef.current = null;
    void executeAction(pending);
  }, [applyTurnstileEvent, executeAction]);

  useEffect(() => {
    if (!privacyOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPrivacyOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [privacyOpen]);

  // Без siteKey или с уже полученным токеном действие выполняется сразу;
  // иначе показываем виджет и запоминаем отложенное действие.
  const runWithTurnstile = (action: PendingLoginAction) => {
    if (!turnstileSiteKey || turnstileRef.current.phase !== 'idle') {
      void executeAction(action);
      return;
    }
    pendingActionRef.current = action;
    setTurnstileVisible(true);
  };

  const turnstileBusy = turnstileState.phase === 'inFlight';

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
            {turnstileSiteKey && turnstileVisible && turnstileState.phase === 'idle' ? (
              <div className="login__turnstile">
                <p className="login__turnstile-caption">{t('turnstilePrompt')}</p>
                <TurnstileWidget siteKey={turnstileSiteKey} onToken={handleTurnstileToken} />
              </div>
            ) : null}
            <button
              className="button button--primary button--login"
              type="button"
              onClick={() => runWithTurnstile('connect')}
              disabled={busy || turnstileBusy || !ssoConfigured}
            >
              <TargetIcon size={26} />
              {ssoConfigured ? t('loginEve') : t('ssoMissing')}
            </button>
            <button className="text-action" type="button" onClick={() => runWithTurnstile('guest')} disabled={busy || turnstileBusy}>
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
        <button type="button" onClick={onShowSupport}>
          <ChartIcon size={19} /> {t('supportTransparencyLink')}
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
