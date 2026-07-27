import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { formatDate, formatDateTime, formatDay, formatMonth } from '../dates';
import { LocaleSwitch, useI18n } from '../i18n';
import { MenuIcon } from '../icons';
import type { ModelPricing, MyTransparency, TransparencyPayload, UsageDailyRow, UsageSums } from '../types';

type Locale = 'ru' | 'en';

type Props = {
  hasSession: boolean;
  onMenu?: () => void;
  onBackToLogin?: () => void;
};

type CostView = { kind: 'unknown' } | { kind: 'value'; usd: number; atLeast: boolean };

export function SupportScreen({ hasSession, onMenu, onBackToLogin }: Props) {
  const { locale, t } = useI18n();
  const [payload, setPayload] = useState<TransparencyPayload | null>(null);
  const [mine, setMine] = useState<MyTransparency | null>(null);
  const [mineFailed, setMineFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await webApi.getTransparency();
      setPayload(data);
      if (hasSession) {
        // The personal line is optional: an expired session or a failed fetch
        // just hides it — we never show anyone else's figures instead.
        try {
          setMine(await webApi.getMyTransparency());
          setMineFailed(false);
        } catch {
          setMine(null);
          setMineFailed(true);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      setLoading(false);
    }
  }, [hasSession, t]);

  useEffect(() => { void load(); }, [load]);

  const totals = payload?.totals ?? null;
  const heroCost = totals ? costView(totals, totals.costComplete) : null;
  const mineCost = mine ? costView(mine.totals, mine.totals.costComplete) : null;
  const infra = payload?.infrastructure ?? null;
  const fx = payload?.fx ?? null;
  const fxNote = fx ? t('supportFxNote').replace('{rate}', String(fx.usdRubRate)).replace('{date}', formatDate(fx.date, locale)) : null;
  const dailyMax = payload ? Math.max(0, ...payload.daily.map((row) => rowTokens(row))) : 0;

  return <section className="workspace-screen">
    <header className="workspace-header">
      {onMenu ? <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button> : null}
      <div><span className="workspace-kicker">{t('supportKicker')}</span><h1>{t('supportTitle')}</h1><p>{t('supportLead')}</p></div>
      {onBackToLogin ? <button className="button" type="button" onClick={onBackToLogin}>{t('supportBackToLogin')}</button> : null}
      <LocaleSwitch />
    </header>
    <div className="workspace-scroll">
      {loading ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void load()}>{t('retry')}</button></div> : null}
      {payload && totals && heroCost && infra ? <>
        <section className="support-hero">
          <div className="support-hero__grid">
            <div className="support-stat">
              <span className="support-stat__label">{t('supportTokensTotal')}</span>
              <strong className="support-stat__value">{formatInt(totals.totalTokens, locale)}</strong>
              <small className="support-stat__note">
                {formatInt(totals.events, locale)} {t('supportEvents')}
                {totals.since ? ` · ${t('supportSince').replace('{date}', formatDay(totals.since, locale))}` : ''}
              </small>
            </div>
            <div className="support-stat">
              <span className="support-stat__label">{t('supportCostTotal')}</span>
              <strong className="support-stat__value support-stat__value--accent">{costText(heroCost, locale, t('supportCostUnknownShort'))}</strong>
              {heroCost.kind === 'unknown' ? <small className="support-stat__note">{t('supportCostUnknown')}</small> : null}
              {heroCost.kind === 'value' && heroCost.atLeast ? <small className="support-stat__note">{t('supportCostIncomplete')}</small> : null}
              {heroCost.kind === 'value' && fx && fxNote ? <small className="support-stat__note">{formatRub(heroCost.usd, fx.usdRubRate, locale)} · {fxNote}</small> : null}
            </div>
            <div className="support-stat">
              <span className="support-stat__label">{t('supportCurrentModel')}</span>
              <strong className="support-stat__value support-stat__value--text">{payload.currentModel}</strong>
            </div>
          </div>
          <div className="support-breakdown">
            <div className="support-breakdown__item"><span>{t('supportInputTokens')}</span><strong>{formatInt(totals.inputTokens, locale)}</strong></div>
            <div className="support-breakdown__item"><span>{t('supportOutputTokens')}</span><strong>{formatInt(totals.outputTokens, locale)}</strong></div>
            <div className="support-breakdown__item"><span>{t('supportCachedTokens')}</span><strong>{formatInt(totals.cachedTokens, locale)}</strong></div>
            <div className="support-breakdown__item"><span>{t('supportCacheWriteTokens')}</span><strong>{formatInt(totals.cacheWriteTokens, locale)}</strong></div>
            <div className="support-breakdown__item"><span>{t('supportReasoningTokens')}</span><strong>{formatInt(totals.reasoningTokens, locale)}</strong></div>
          </div>
        </section>

        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('supportInfraTitle')}</h2></header>
          {infra.monthToDateUsd !== null ? <>
            <div className="support-stat support-stat--inline">
              <span className="support-stat__label">{t('supportInfraMonthToDate')}</span>
              <strong className="support-stat__value support-stat__value--accent">{formatUsd(infra.monthToDateUsd, locale)}</strong>
              {fx && fxNote ? <small className="support-stat__note">{formatRub(infra.monthToDateUsd, fx.usdRubRate, locale)} · {fxNote}</small> : null}
            </div>
            {infra.byService.length > 0 ? <div className="support-table">
              <table>
                <thead><tr><th>{t('supportInfraService')}</th><th className="num">{t('supportCost')}</th></tr></thead>
                <tbody>{infra.byService.map((row) => <tr key={row.service}><td>{row.service}</td><td className="num">{formatUsd(row.costUsd, locale)}</td></tr>)}</tbody>
              </table>
            </div> : null}
            {infra.actualsNote ? <p className="support-note">{infra.actualsNote}</p> : null}
            {infra.asOf ? <p className="support-note">{t('supportInfraAsOf').replace('{date}', formatDateTime(infra.asOf, locale))}</p> : null}
            {infra.status === 'error' ? <p className="support-note support-note--warn">{t('supportInfraStale')}</p> : null}
          </> : null}
          {infra.monthToDateUsd === null && infra.estimate ? <>
            <div className="support-stat support-stat--inline">
              <span className="support-stat__label">{t('supportInfraMonthly')}</span>
              <strong className="support-stat__value support-stat__value--accent">{formatUsd(infra.estimate.monthlyUsd, locale)}</strong>
              {fx && fxNote ? <small className="support-stat__note">{formatRub(infra.estimate.monthlyUsd, fx.usdRubRate, locale)} · {fxNote}</small> : null}
            </div>
            <ul className="support-components">{infra.estimate.components.map((item) => <li key={item}>{item}</li>)}</ul>
            {infra.status === 'error' ? <p className="support-note support-note--warn">{t('supportInfraStale')}</p> : null}
          </> : null}
          {infra.monthToDateUsd === null && !infra.estimate && infra.error ? <p className="support-note support-note--warn">{infra.error}</p> : null}
        </section>

        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('supportDailyTitle')}</h2></header>
          {dailyMax > 0
            ? <DailyChart daily={payload.daily} locale={locale} label={t('supportDailyTitle')} />
            : <p className="support-note">{t('supportDailyEmpty')}</p>}
        </section>

        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('supportModelsTitle')}</h2></header>
          <p className="support-note">{t('supportTariffLegend')}</p>
          <div className="support-table">
            <table>
              <thead><tr>
                <th>{t('supportModel')}</th>
                <th className="num">{t('supportTokens')}</th>
                <th className="num">{t('supportCost')}</th>
                <th className="num">$/1M</th>
              </tr></thead>
              <tbody>{payload.models.map((row) => <tr key={row.model}>
                <td className="support-table__model">{row.model}</td>
                <td className="num">{formatInt(rowTokens(row), locale)}</td>
                <td className="num">{rowCostText(row, locale, t('supportCostUnknownShort'))}</td>
                <td className="num">{row.tariff ? formatTariff(row.tariff) : t('supportTariffMissing')}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('supportMonthlyTitle')}</h2></header>
          {payload.monthly.length > 0 ? <div className="support-table">
            <table>
              <thead><tr>
                <th>{t('supportMonth')}</th>
                <th className="num">{t('supportTokens')}</th>
                <th className="num">{t('supportCost')}</th>
              </tr></thead>
              <tbody>{payload.monthly.map((row) => <tr key={row.month}>
                <td className="num">{formatMonth(row.month, locale)}</td>
                <td className="num">{formatInt(rowTokens(row), locale)}</td>
                <td className="num">{rowCostText(row, locale, t('supportCostUnknownShort'))}</td>
              </tr>)}</tbody>
            </table>
          </div> : <p className="support-note">{t('supportNoData')}</p>}
        </section>

        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('supportIntegrationsTitle')}</h2></header>
          <ul className="support-integrations">
            <li>
              <a href="https://esi.evetech.net" target="_blank" rel="noopener noreferrer">EVE ESI</a>
              <span>{t('supportIntegrationEsi')}</span>
            </li>
            <li>
              <a href="https://developers.eveonline.com/static-data" target="_blank" rel="noopener noreferrer">EVE SDE</a>
              <span>{t('supportIntegrationSde')}</span>
            </li>
            <li>
              <a href="https://eve-kill.com" target="_blank" rel="noopener noreferrer">EVE-KILL</a>
              <span>{t('supportIntegrationEveKill')}</span>
            </li>
            {payload.donations.boostyUrl ? <li>
              <a href={payload.donations.boostyUrl} target="_blank" rel="noopener noreferrer">Boosty</a>
              <span>{t('supportIntegrationBoosty')}</span>
            </li> : null}
          </ul>
        </section>

        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('supportPersonalTitle')}</h2></header>
          {!hasSession ? <p className="support-note">{t('supportPersonalGuest')}</p> : null}
          {hasSession && mine && mineCost ? <div className="support-personal">
            <div className="support-stat support-stat--inline">
              <span className="support-stat__label">{t('supportTokensTotal')}</span>
              <strong className="support-stat__value">{formatInt(mine.totals.totalTokens, locale)}</strong>
            </div>
            <div className="support-stat support-stat--inline">
              <span className="support-stat__label">{t('supportCostTotal')}</span>
              <strong className="support-stat__value support-stat__value--accent">{costText(mineCost, locale, t('supportCostUnknownShort'))}</strong>
              {mineCost.kind === 'unknown' ? <small className="support-stat__note">{t('supportCostUnknown')}</small> : null}
              {mineCost.kind === 'value' && mineCost.atLeast ? <small className="support-stat__note">{t('supportCostIncomplete')}</small> : null}
            </div>
          </div> : null}
          {hasSession && mineFailed && !loading ? <p className="support-note">{t('supportPersonalUnavailable')}</p> : null}
        </section>

        {payload.donations.boostyUrl ? <section className="support-panel support-donate">
          <header className="support-panel__head"><h2>{t('supportDonateTitle')}</h2></header>
          <p className="support-donate__text">{t('supportDonateText')}</p>
          <a className="support-donate__link" href={payload.donations.boostyUrl} target="_blank" rel="noopener noreferrer">
            <span>{t('supportDonateCta')}</span>
            <span className="support-donate__url">{payload.donations.boostyUrl}</span>
          </a>
        </section> : null}

        <p className="support-note support-updated">{t('supportUpdated').replace('{date}', formatDateTime(payload.generatedAt, locale))}</p>
      </> : null}
    </div>
  </section>;
}

function DailyChart({ daily, locale, label }: { daily: UsageDailyRow[]; locale: Locale; label: string }) {
  const values = daily.map((row) => rowTokens(row));
  const max = Math.max(0, ...values);
  const width = 720;
  const height = 176;
  const padTop = 20;
  const padBottom = 24;
  const innerHeight = height - padTop - padBottom;
  const slot = width / Math.max(daily.length, 1);
  const barWidth = Math.max(2, slot * 0.62);
  const baseline = height - padBottom;
  const labelIndexes = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  return <svg className="support-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    <text className="support-chart__tick" x={0} y={12}>{formatCompact(max, locale)}</text>
    <line className="support-chart__grid" x1={0} x2={width} y1={padTop} y2={padTop} />
    <line className="support-chart__axis" x1={0} x2={width} y1={baseline} y2={baseline} />
    {daily.map((row, index) => {
      const value = values[index] ?? 0;
      const barHeight = max > 0 && value > 0 ? Math.max(1, (value / max) * innerHeight) : 0;
      return <rect
        key={row.day}
        className={index === daily.length - 1 ? 'support-chart__bar support-chart__bar--today' : 'support-chart__bar'}
        x={index * slot + (slot - barWidth) / 2}
        y={baseline - barHeight}
        width={barWidth}
        height={barHeight}
      ><title>{`${formatDay(row.day, locale)}: ${formatInt(value, locale)}`}</title></rect>;
    })}
    {labelIndexes.map((index) => <text
      key={index}
      className="support-chart__tick"
      x={index * slot + slot / 2}
      y={height - 8}
      textAnchor="middle"
    >{formatDay(daily[index]?.day ?? '', locale)}</text>)}
  </svg>;
}

// Matches the backend definition of totalTokens (input + output); the other
// categories are subsets/side-channels shown separately in the breakdown.
function rowTokens(sums: UsageSums): number {
  return sums.inputTokens + sums.outputTokens;
}

// costMicros === 0 with unknown-cost events means "no tariff", not "free" —
// showing $0 there would read as a lie.
function costView(sums: UsageSums, complete: boolean): CostView {
  if (sums.costMicros === 0 && sums.unknownCostEvents > 0) return { kind: 'unknown' };
  return { kind: 'value', usd: sums.costMicros / 1_000_000, atLeast: !complete };
}

function costText(view: CostView, locale: Locale, unknownLabel: string): string {
  if (view.kind === 'unknown') return unknownLabel;
  return `${view.atLeast ? '≥ ' : ''}${formatUsd(view.usd, locale)}`;
}

function rowCostText(sums: UsageSums, locale: Locale, unknownLabel: string): string {
  return costText(costView(sums, sums.unknownCostEvents === 0), locale, unknownLabel);
}

function formatTariff(tariff: ModelPricing): string {
  return [tariff.input, tariff.output, tariff.cached, tariff.reasoning].map((value) => `$${value}`).join(' / ');
}

function formatInt(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatUsd(usd: number, locale: Locale): string {
  const abs = Math.abs(usd);
  const tiny = abs > 0 && abs < 0.01;
  const formatted = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: tiny ? 4 : 2,
  }).format(usd);
  return `$${formatted}`;
}

function formatRub(usd: number, rate: number, locale: Locale): string {
  const rub = usd * rate;
  const formatted = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: rub < 100 ? 2 : 0,
    maximumFractionDigits: rub < 100 ? 2 : 0,
  }).format(rub);
  return `≈ ${formatted} ₽`;
}
