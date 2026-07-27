import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { webApi } from '../../api';
import { useI18n, type Locale } from '../../i18n';
import type { MarketHistoryPoint, MarketHistoryResponse } from '../../types';
import { formatIsk, formatPercent, formatQuantity } from './format';

// Совпадает с HISTORY_ALLOWED_DAYS на сервере (src/web/market-routes.ts);
// 0 = вся накопленная история.
const RANGES = [30, 90, 365, 0] as const;
type RangeDays = (typeof RANGES)[number];

// Серия короче этого — показываем пометку «данных мало».
const SPARSE_THRESHOLD = 7;

const VIEW_W = 720;
const VIEW_H = 360;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PRICE_H = (VIEW_H - PAD.top - PAD.bottom) * 0.72;
const VOLUME_GAP = 8;
const VOLUME_H = VIEW_H - PAD.top - PAD.bottom - PRICE_H - VOLUME_GAP;
const PRICE_BOTTOM = PAD.top + PRICE_H;
const VOLUME_TOP = PRICE_BOTTOM + VOLUME_GAP;
const VOLUME_BOTTOM = VOLUME_TOP + VOLUME_H;

const Y_TICKS = 4;
const X_TICKS = 6;

const localeTag = (locale: Locale) => (locale === 'ru' ? 'ru-RU' : 'en-US');

type Props = {
  typeId: number;
  regionId: number;
};

type ChartGeometry = {
  xFor: (index: number) => number;
  yForPrice: (value: number) => number;
  yTicks: Array<{ y: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
  bandPath: string;
  linePath: string;
  bars: Array<{ x: number; y: number; width: number; height: number }>;
};

/**
 * График истории цен: линия average, полупрозрачная полоса lowest–highest,
 * бары дневного объёма внизу. Собственный SVG (без chart-библиотек), геометрия
 * в viewBox-координатах; контейнер держит aspect-ratio 720/360, поэтому
 * проекция курсора из clientX в viewBox линейна. Tooltip — HTML поверх SVG.
 */
export function PriceChart({ typeId, regionId }: Props) {
  const { locale, t } = useI18n();
  const [days, setDays] = useState<RangeDays>(90);
  const [history, setHistory] = useState<MarketHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (range: RangeDays) => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    setHoverIndex(null);
    try {
      const payload = await webApi.market.history(typeId, regionId, range);
      if (current !== generation.current) return;
      setHistory(payload.history);
    } catch (reason) {
      if (current !== generation.current) return;
      setHistory(null);
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [typeId, regionId, t]);

  useEffect(() => {
    setHistory(null);
    void load(days);
  }, [days, load]);

  const series = useMemo(() => history?.series ?? [], [history]);
  const geometry = useMemo(() => buildGeometry(series, locale), [series, locale]);

  const onMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const xView = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const fraction = Math.min(1, Math.max(0, (xView - PAD.left) / PLOT_W));
    setHoverIndex(Math.round(fraction * (series.length - 1)));
  };

  const hovered = hoverIndex !== null ? series[hoverIndex] : undefined;
  const hoverX = hoverIndex !== null ? geometry?.xFor(hoverIndex) ?? 0 : 0;
  // Тултип у краёв не должен уезжать за пределы контейнера.
  const hoverXPct = (hoverX / VIEW_W) * 100;
  const tooltipShift = hoverXPct < 15 ? '0' : hoverXPct > 85 ? '-100%' : '-50%';

  const rangeLabel = (range: RangeDays) => {
    if (range === 30) return t('marketChartRange30');
    if (range === 90) return t('marketChartRange90');
    if (range === 365) return t('marketChartRange365');
    return t('marketChartRangeAll');
  };

  return (
    <section className="chart-panel" aria-label={t('marketChartTitle')}>
      {history && series.length > 0 ? <StatsStrip history={history} /> : null}
      <div className="chart-range" role="group" aria-label={t('marketChartTitle')}>
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            className={`chart-range__button${range === days ? ' chart-range__button--active' : ''}`}
            onClick={() => setDays(range)}
          >
            {rangeLabel(range)}
          </button>
        ))}
      </div>
      {loading ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button type="button" onClick={() => void load(days)}>{t('retry')}</button>
        </div>
      ) : null}
      {!loading && !error && series.length === 0 ? (
        <p className="chart-note">{t('marketChartEmpty')}</p>
      ) : null}
      {!loading && !error && series.length > 0 && geometry ? (
        <>
          {series.length < SPARSE_THRESHOLD ? <p className="chart-note">{t('marketChartSparse')}</p> : null}
          <div className="chart">
            <svg
              className="chart__svg"
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={t('marketChartAria')}
              onMouseMove={onMouseMove}
              onMouseLeave={() => setHoverIndex(null)}
            >
              {geometry.yTicks.map((tick) => (
                <g key={tick.y}>
                  <line className="chart__grid" x1={PAD.left} x2={VIEW_W - PAD.right} y1={tick.y} y2={tick.y} />
                  <text className="chart__axis-label" x={PAD.left - 6} y={tick.y} textAnchor="end" dominantBaseline="middle">
                    {tick.label}
                  </text>
                </g>
              ))}
              {geometry.xTicks.map((tick) => (
                <text key={tick.x} className="chart__axis-label" x={tick.x} y={VIEW_H - 8} textAnchor="middle">
                  {tick.label}
                </text>
              ))}
              {series.length > 1 ? <path className="chart__band" d={geometry.bandPath} /> : null}
              {geometry.bars.map((bar, index) => (
                <rect
                  key={series[index]?.date ?? index}
                  className={`chart__bar${index === hoverIndex ? ' chart__bar--hover' : ''}`}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                />
              ))}
              {series.length > 1 ? <path className="chart__line" d={geometry.linePath} /> : null}
              {series.length === 1 ? (
                <circle className="chart__dot" cx={geometry.xFor(0)} cy={geometry.yForPrice(series[0]?.average ?? 0)} r={3} />
              ) : null}
              {hovered && hoverIndex !== null ? (
                <g>
                  <line className="chart__cursor" x1={hoverX} x2={hoverX} y1={PAD.top} y2={VOLUME_BOTTOM} />
                  <circle className="chart__dot" cx={hoverX} cy={geometry.yForPrice(hovered.average)} r={3.5} />
                </g>
              ) : null}
            </svg>
            {hovered ? (
              <div className="chart-tooltip" style={{ left: `${hoverXPct}%`, transform: `translateX(${tooltipShift})` }}>
                <span className="chart-tooltip__date">{formatFullDate(hovered.date, locale)}</span>
                <TooltipRow label={t('marketChartAverage')} value={`${formatIsk(hovered.average, locale)} ISK`} />
                <TooltipRow label={t('marketChartHighest')} value={`${formatIsk(hovered.highest, locale)} ISK`} />
                <TooltipRow label={t('marketChartLowest')} value={`${formatIsk(hovered.lowest, locale)} ISK`} />
                <TooltipRow label={t('marketChartVolume')} value={formatQuantity(hovered.volume, locale)} />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="chart-tooltip__row">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

/** Карточки агрегатов из stats ответа history: изменения, волатильность, объём, тренд. */
function StatsStrip({ history }: { history: MarketHistoryResponse }) {
  const { locale, t } = useI18n();
  const stats = history.stats;

  const changeCard = (label: string, value: number | null) => (
    <article className="chart-stat" key={label}>
      <span className="chart-stat__label">{label}</span>
      <strong className={`chart-stat__value${trendClass(value)}`}>{signedPercent(value, locale)}</strong>
    </article>
  );

  return (
    <div className="chart-stats">
      {changeCard(t('marketChartChange7d'), stats.change_7d_percent)}
      {changeCard(t('marketChartChange30d'), stats.change_30d_percent)}
      {changeCard(t('marketChartChange90d'), stats.change_90d_percent)}
      <article className="chart-stat">
        <span className="chart-stat__label">{t('marketChartVolatility')}</span>
        <strong className="chart-stat__value">{formatPercent(stats.daily_log_return_stddev_percent, locale)}</strong>
      </article>
      <article className="chart-stat">
        <span className="chart-stat__label">{t('marketChartAvgVolume')}</span>
        <strong className="chart-stat__value">{formatQuantity(stats.mean_daily_volume, locale)}</strong>
      </article>
      <article className="chart-stat">
        <span className="chart-stat__label">{t('marketChartTrend')}</span>
        <strong className={`chart-stat__value${trendClass(stats.trend_slope_per_day)}`}>
          {stats.trend_slope_per_day === null
            ? '—'
            : t('marketChartPerDay').replace('{value}', signedIsk(stats.trend_slope_per_day, locale))}
        </strong>
      </article>
    </div>
  );
}

function trendClass(value: number | null): string {
  if (value === null || value === 0) return '';
  return value > 0 ? ' chart-stat__value--up' : ' chart-stat__value--down';
}

function signedPercent(value: number | null, locale: Locale): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${formatPercent(value, locale)}`;
}

function signedIsk(value: number, locale: Locale): string {
  return `${value > 0 ? '+' : ''}${formatIsk(value, locale)}`;
}

function formatShortDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatFullDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function buildGeometry(series: MarketHistoryPoint[], locale: Locale): ChartGeometry | null {
  if (series.length === 0) return null;
  const n = series.length;

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let maxVolume = 0;
  for (const point of series) {
    if (point.lowest < lo) lo = point.lowest;
    if (point.highest > hi) hi = point.highest;
    if (point.volume > maxVolume) maxVolume = point.volume;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const span = hi - lo;
  const padY = span === 0 ? Math.max(hi * 0.05, 1) : span * 0.06;
  lo -= padY;
  hi += padY;

  const xFor = (index: number) => (n === 1 ? PAD.left + PLOT_W / 2 : PAD.left + (index * PLOT_W) / (n - 1));
  const yForPrice = (value: number) => PRICE_BOTTOM - ((value - lo) / (hi - lo)) * PRICE_H;

  const yTicks = Array.from({ length: Y_TICKS }, (_, tick) => {
    const value = lo + ((hi - lo) * tick) / (Y_TICKS - 1);
    return { y: yForPrice(value), label: formatIsk(value, locale) };
  });

  const xTickCount = Math.min(X_TICKS, n);
  const seen = new Set<number>();
  const xTicks: Array<{ x: number; label: string }> = [];
  for (let tick = 0; tick < xTickCount; tick += 1) {
    const index = xTickCount === 1 ? 0 : Math.round((tick * (n - 1)) / (xTickCount - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    const point = series[index];
    if (point) xTicks.push({ x: xFor(index), label: formatShortDate(point.date, locale) });
  }

  const topEdge = series
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(xFor(index))},${round(yForPrice(point.highest))}`)
    .join(' ');
  const bottomEdge = [...series]
    .reverse()
    .map((point, reverseIndex) => `L${round(xFor(n - 1 - reverseIndex))},${round(yForPrice(point.lowest))}`)
    .join(' ');
  const bandPath = n > 1 ? `${topEdge} ${bottomEdge} Z` : '';

  const linePath = n > 1
    ? series.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(xFor(index))},${round(yForPrice(point.average))}`).join(' ')
    : '';

  const barWidth = Math.max(1, (PLOT_W / n) * 0.7);
  const bars = series.map((point, index) => {
    const height = maxVolume === 0 ? 0 : (point.volume / maxVolume) * VOLUME_H;
    return {
      x: round(xFor(index) - barWidth / 2),
      y: round(VOLUME_BOTTOM - height),
      width: round(barWidth),
      height: round(height),
    };
  });

  return { xFor, yForPrice, yTicks, xTicks, bandPath, linePath, bars };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
