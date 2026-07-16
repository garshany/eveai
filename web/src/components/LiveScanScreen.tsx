import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { LocaleSwitch, useI18n } from '../i18n';
import { MenuIcon, RadarIcon, RouteIcon } from '../icons';
import type { ScanPayload } from '../types';

type Props = { csrfToken: string; onMenu: () => void; onPrompt: (prompt: string) => void };

export function LiveScanScreen({ csrfToken, onMenu, onPrompt }: Props) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<ScanPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await webApi.getScan()); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('requestFailed')); }
  }, [t]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const stop = async () => { await webApi.stopScan(csrfToken); await load(); };
  const monitor = data?.monitor;
  const progress = monitor && monitor.progress.total > 0 ? Math.min(100, Math.round((monitor.progress.completed / monitor.progress.total) * 100)) : 0;

  return <section className="workspace-screen">
    <header className="workspace-header"><button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button><div><span className="workspace-kicker">EVE-KILL · ESI</span><h1>{t('scanTitle')}</h1><p>{t('scanLead')}</p></div><LocaleSwitch /></header>
    <div className="workspace-scroll">
      <section className={`feed-status ${data?.source.running ? 'feed-status--live' : ''}`}><span className="feed-status__pulse" /><div><strong>{data?.source.running ? t('feedLive') : t('feedDown')}</strong><small>{t('sourceRest')}</small></div><time>{formatTime(data?.source.lastSuccessAt, locale)}</time></section>
      {error ? <div className="workspace-error" role="alert">{error}</div> : null}
      {data && !monitor ? <div className="scan-empty"><RadarIcon size={52} /><h2>{t('noScan')}</h2><p>{t('noScanLead')}</p><button className="button button--primary" type="button" onClick={() => onPrompt(t('startPrompt'))}><RouteIcon />{t('startPrompt')}</button></div> : null}
      {monitor ? <>
        <section className={`scan-route scan-route--${(monitor.threatLevel ?? 'LOW').toLowerCase()}`}><div className="scan-route__top"><div><span>{monitor.origin.name}</span><b>→</b><strong>{monitor.destination.name}</strong></div><em>{monitor.threatLevel ?? (monitor.baselineReady ? 'LOW' : 'SYNC')}</em></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="scan-route__meta"><span>{monitor.progress.completed}/{monitor.progress.total}</span><span>{monitor.progress.remaining ?? '—'} {t('jumpsLeft')}</span><button type="button" onClick={() => void stop()}>{t('stopScan')}</button></div></section>
        <div className="scan-grid"><article><span>{t('currentSystem')}</span><strong>{monitor.current.name}</strong><small>{formatTime(monitor.lastLocationCheck, locale)}</small></article><article><span>{t('destination')}</span><strong>{monitor.destination.name}</strong><small>{monitor.ship.name} · {monitor.ship.ehp.toLocaleString()} EHP</small></article><article><span>{t('killsSeen')}</span><strong>{monitor.killsSeen}</strong><small>{monitor.baselineReady ? 'baseline + live feed' : 'baseline sync'}</small></article></div>
        <section className="danger-list"><header><h2>{t('dangerEvents')}</h2><span>{monitor.dangerEvents.length}</span></header>{monitor.dangerEvents.length ? monitor.dangerEvents.slice().reverse().map((event, index) => <article key={`${event.time}-${index}`}><em className={`threat-dot threat-dot--${event.threatLevel.toLowerCase()}`} /> <div><strong>{event.systemName}</strong><p>{event.description}</p></div><time>{formatTime(event.time, locale)}</time></article>) : <p className="danger-list__empty">{t('noThreats')}</p>}</section>
      </> : null}
    </div>
  </section>;
}

function formatTime(value: string | null | undefined, locale: 'ru' | 'en') { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date); }
