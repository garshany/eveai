import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = 'cloudflare-turnstile-script';

export function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    const render = () => {
      if (disposed || !containerRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: 'session',
        theme: 'dark',
        callback: (token: string) => { setFailed(false); onToken(token); },
        'expired-callback': () => onToken(null),
        'error-callback': () => { setFailed(true); onToken(null); },
      });
      setReady(true);
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if (window.turnstile) render();
      else existing.addEventListener('load', render, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      disposed = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [onToken, siteKey]);

  const retry = () => {
    if (!widgetIdRef.current || !window.turnstile) return;
    setFailed(false);
    window.turnstile.reset(widgetIdRef.current);
  };

  return (
    <div className="turnstile-shell">
      {ready ? null : <div className="turnstile-shell__placeholder" aria-hidden="true"><span className="turnstile-shell__pulse" />{t('turnstileLoading')}</div>}
      <div className="turnstile-widget" ref={containerRef} aria-label="Bot protection" />
      {failed ? (
        <div className="turnstile-shell__error" role="alert">
          <span>{t('turnstileFailed')}</span>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
    </div>
  );
}
