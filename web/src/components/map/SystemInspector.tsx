/**
 * Инспектор системы: почему она такая, а не просто какая она.
 *
 * Каждое слагаемое опасности показывается со своей формулировкой, а список
 * килов отвечает на исходный вопрос пилота дословно — кто кого убил, на чём и
 * сколько это стоило.
 */

import { useEffect, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { MapBubbleSystem, MapKillEvent } from '../../types';
import { bandColor } from './renderer';
import { bandLabelKey, dangerTermKey } from './labels';

type Props = {
  system: MapBubbleSystem;
  onClose: () => void;
  onRouteTo: (systemId: number) => void;
  onAvoid: (systemId: number) => void;
  onAsk: (systemId: number) => void;
};

export function SystemInspector({ system, onClose, onRouteTo, onAvoid, onAsk }: Props) {
  const { t, locale } = useI18n();
  const [kills, setKills] = useState<MapKillEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setKills(null);
    void (async () => {
      try {
        const payload = await webApi.map.system(system.systemId);
        if (!cancelled) setKills(payload.kills);
      } catch {
        if (!cancelled) setKills([]);
      }
    })();
    return () => { cancelled = true; };
  }, [system.systemId]);

  const camp = system.gateCamps.filter((gate) => gate.killCount >= 2);

  return <section className="perimeter-inspector" aria-label={system.name}>
    <header className="perimeter-inspector__head">
      <div>
        <h3>{system.name}</h3>
        <p className="perimeter-inspector__sub">
          {system.security.toFixed(1)} · {system.regionName ?? '—'} · {t('perimeterJumpsAway', { jumps: String(system.jumps) })}
        </p>
      </div>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t('dockClose')}>×</button>
    </header>

    <div className="perimeter-inspector__score">
      <span
        className="perimeter-inspector__band"
        style={{ background: bandColor(system.danger.band) }}
      >{t(bandLabelKey(system.danger.band))}</span>
      <span className="perimeter-inspector__value">{Math.round(system.danger.score * 100)}%</span>
    </div>

    {/* Разбор оценки: красная точка без объяснения — не разведданные. */}
    <ul className="perimeter-terms">
      {system.danger.terms.length === 0
        ? <li className="perimeter-terms__empty">{t('perimeterNoSignals')}</li>
        : system.danger.terms.map((term) => <li key={term.key}>
          <span className="perimeter-terms__key">{dangerTermKey(term.key) ? t(dangerTermKey(term.key)!) : term.key}</span>
          <span className="perimeter-terms__detail">{term.detail}</span>
          <span className="perimeter-terms__weight">{term.value >= 0 ? '+' : ''}{Math.round(term.value * 100)}</span>
        </li>)}
    </ul>

    <dl className="perimeter-stats">
      <div><dt>{t('perimeterKills15m')}</dt><dd>{system.activity.kills15m}</dd></div>
      <div><dt>{t('perimeterKills1h')}</dt><dd>{system.activity.kills1h}</dd></div>
      <div><dt>{t('perimeterPvp1h')}</dt><dd>{system.activity.pvpKills1h}</dd></div>
      <div><dt>{t('perimeterBaseline')}</dt><dd>{system.baselineShipKills}</dd></div>
    </dl>

    {camp.length > 0 ? <div className="perimeter-camp">
      <strong>{t('perimeterCamp')}</strong>
      <ul>
        {camp.map((gate) => <li key={gate.stargateId}>
          {t('perimeterCampGate', { gate: gate.connectedSystemName, kills: String(gate.killCount) })}
        </li>)}
      </ul>
    </div> : null}

    <h4 className="perimeter-inspector__section">{t('perimeterRecentKills')}</h4>
    {kills === null
      ? <p className="perimeter-inspector__muted">{t('loading')}</p>
      : kills.length === 0
        ? <p className="perimeter-inspector__muted">{t('perimeterNoKills')}</p>
        : <ul className="perimeter-kills">
          {kills.map((kill) => <li key={kill.killmailId}>
            <a href={kill.url ?? `https://eve-kill.com/kill/${kill.killmailId}`} target="_blank" rel="noreferrer noopener">
              <span className="perimeter-kills__victim">
                {kill.victimCharacterName ?? t('perimeterUnknownPilot')} · {kill.victimShipName ?? '—'}
              </span>
              <span className="perimeter-kills__attacker">
                ← {kill.finalBlowCharacterName ?? (kill.isNpc ? t('perimeterNpc') : t('perimeterUnknownPilot'))}
                {kill.finalBlowShipName ? ` · ${kill.finalBlowShipName}` : ''}
                {kill.attackerCount > 1 ? ` +${kill.attackerCount - 1}` : ''}
              </span>
              <span className="perimeter-kills__meta">
                {formatIsk(kill.totalValue, locale)} · {formatAge(kill.killmailTimeMs, locale)}
              </span>
            </a>
          </li>)}
        </ul>}

    <div className="perimeter-inspector__actions">
      <button type="button" onClick={() => onRouteTo(system.systemId)}>{t('perimeterRouteHere')}</button>
      <button type="button" onClick={() => onAvoid(system.systemId)}>{t('perimeterAvoid')}</button>
      <button type="button" onClick={() => onAsk(system.systemId)}>{t('perimeterAskAgent')}</button>
    </div>
  </section>;
}

function formatIsk(value: number, locale: 'ru' | 'en'): string {
  const formatter = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', {
    maximumFractionDigits: 1,
  });
  if (value >= 1_000_000_000) return `${formatter.format(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${formatter.format(value / 1_000_000)}M`;
  return formatter.format(value);
}

function formatAge(timeMs: number, locale: 'ru' | 'en'): string {
  const minutes = Math.max(0, Math.round((Date.now() - timeMs) / 60_000));
  if (locale === 'ru') return minutes < 60 ? `${minutes} мин назад` : `${Math.round(minutes / 60)} ч назад`;
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
