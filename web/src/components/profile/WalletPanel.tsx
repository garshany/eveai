import { useCallback, useMemo } from 'react';
import { webApi } from '../../api';
import { useI18n, type Locale } from '../../i18n';
import type { ProfileWalletResponse } from '../../types';
import { formatIsk } from '../market/format';
import { FreshnessBar, useProfileData, useProfileSync } from './shared';

type Props = { csrfToken: string };

const VIEW_W = 720;
const VIEW_H = 260;
const PAD = { top: 12, right: 12, bottom: 24, left: 64 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;
const PLOT_BOTTOM = PAD.top + PLOT_H;

const localeTag = (locale: Locale) => (locale === 'ru' ? 'ru-RU' : 'en-US');

/** Кошелёк: баланс + история за 30 дней из журнала (дельты барами, баланс линией). */
export function WalletPanel({ csrfToken }: Props) {
  const { locale, t } = useI18n();
  const loader = useCallback(() => webApi.profile.wallet(), []);
  const { data, loading, error, reload } = useProfileData<ProfileWalletResponse>(loader);
  const { syncing, sync } = useProfileSync(csrfToken, ['wallet', 'wallet_journal'], reload);

  if (loading && !data) return <div className="panel-loading">{t('loading')}…</div>;
  if (error) return <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void reload()}>{t('retry')}</button></div>;
  if (!data) return null;

  return (
    <section className="profile-panel">
      <FreshnessBar freshness={data.freshness} syncing={syncing} onSync={() => void sync()} />
      <div className="chart-stats">
        <article className="chart-stat">
          <span className="chart-stat__label">{t('balance')}</span>
          <strong className="chart-stat__value">
            {data.balance === null ? '—' : `${formatIsk(data.balance, locale, { compact: false })} ISK`}
          </strong>
        </article>
      </div>
      {data.journal.length === 0
        ? <p className="profile-panel__empty">{t('profileJournalEmpty')}</p>
        : <WalletChart data={data} />}
    </section>
  );
}

/**
 * Простой SVG-чарт (как PriceChart, без библиотек): бары дневной дельты
 * от нулевой линии и линия баланса на конец дня, где он известен.
 */
function WalletChart({ data }: { data: ProfileWalletResponse }) {
  const { locale, t } = useI18n();
  const journal = data.journal;

  const geometry = useMemo(() => {
    let maxDelta = 0;
    let balanceLo = Number.POSITIVE_INFINITY;
    let balanceHi = Number.NEGATIVE_INFINITY;
    for (const day of journal) {
      maxDelta = Math.max(maxDelta, Math.abs(day.delta));
      if (day.balance !== null) {
        balanceLo = Math.min(balanceLo, day.balance);
        balanceHi = Math.max(balanceHi, day.balance);
      }
    }
    const hasBalance = Number.isFinite(balanceLo) && Number.isFinite(balanceHi);
    if (maxDelta === 0 && !hasBalance) return null;
    if (hasBalance && balanceHi === balanceLo) {
      balanceLo -= Math.max(Math.abs(balanceHi) * 0.05, 1);
      balanceHi += Math.max(Math.abs(balanceHi) * 0.05, 1);
    }
    const n = journal.length;
    // Ось X — реальные даты, а не индексы: провалы без записей видны как разрывы.
    const times = journal.map((day) => Date.parse(`${day.date}T00:00:00Z`));
    const t0 = times[0] ?? 0;
    const t1 = times[n - 1] ?? 0;
    const xForTime = (time: number) => (t1 === t0
      ? PAD.left + PLOT_W / 2
      : PAD.left + ((time - t0) * PLOT_W) / (t1 - t0));
    const zeroY = maxDelta === 0 ? PLOT_BOTTOM : PAD.top + PLOT_H / 2;
    const yForDelta = (value: number) => zeroY - (maxDelta === 0 ? 0 : (value / maxDelta) * (PLOT_H / 2 - 8));
    const yForBalance = (value: number) => PLOT_BOTTOM - ((value - balanceLo) / (balanceHi - balanceLo)) * PLOT_H;
    const barWidth = Math.max(1, (PLOT_W / n) * 0.6);
    const bars = journal.map((day, index) => {
      const y = yForDelta(day.delta);
      return {
        x: Math.round(xForTime(times[index] ?? t0) - barWidth / 2),
        y: Math.round(Math.min(y, zeroY)),
        width: Math.round(barWidth),
        height: Math.max(1, Math.round(Math.abs(y - zeroY))),
        up: day.delta >= 0,
      };
    });
    const balancePoints = journal
      .map((day, index) => (day.balance === null ? null : { x: xForTime(times[index] ?? t0), y: yForBalance(day.balance) }))
      .filter((point): point is { x: number; y: number } => point !== null);
    const linePath = balancePoints.length > 1
      ? balancePoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${Math.round(point.x)},${Math.round(point.y)}`).join(' ')
      : '';
    const first = journal[0]?.date ?? '';
    const last = journal[n - 1]?.date ?? '';
    return { bars, linePath, zeroY: Math.round(zeroY), hasBalance, first, last };
  }, [journal]);

  if (!geometry) return <p className="profile-panel__empty">{t('profileJournalEmpty')}</p>;

  const dateLabel = (value: string) => new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));

  return (
    <section className="chart-panel" aria-label={t('profileWalletChartTitle')}>
      <div className="chart chart--wallet">
        <svg
          className="chart__svg"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={t('profileWalletChartTitle')}
        >
          <line className="chart__grid" x1={PAD.left} x2={VIEW_W - PAD.right} y1={geometry.zeroY} y2={geometry.zeroY} />
          {geometry.bars.map((bar, index) => (
            <rect
              key={journal[index]?.date ?? index}
              className={`wallet-chart__bar${bar.up ? ' wallet-chart__bar--up' : ' wallet-chart__bar--down'}`}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
            />
          ))}
          {geometry.linePath ? <path className="chart__line" d={geometry.linePath} /> : null}
          <text className="chart__axis-label" x={PAD.left} y={VIEW_H - 6} textAnchor="start">{dateLabel(geometry.first)}</text>
          <text className="chart__axis-label" x={VIEW_W - PAD.right} y={VIEW_H - 6} textAnchor="end">{dateLabel(geometry.last)}</text>
        </svg>
      </div>
    </section>
  );
}
