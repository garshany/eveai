import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { buildUsageReport, type UsageReport } from '../usage/stats.js';
import { getGcpBillingSnapshot } from '../usage/gcp-billing.js';
import { readWebSession } from './web-session.js';

export const TRANSPARENCY_PUBLIC_PATH = '/api/web/transparency';

/**
 * Static infrastructure configuration shown only while no live billing
 * export data exists. Component list from the owner's measurements; only
 * the monthly total is configurable (INFRA_ESTIMATE_USD_MONTHLY).
 */
// Language-neutral technical labels: the API has no locale, and proper nouns
// (VM/disk names, GCP terms) read the same in RU and EN.
const INFRA_ESTIMATE_COMPONENTS = [
  'VM eveai-1 (e2-small, europe-west3-c)',
  'Disk eveai-data (pd-balanced)',
  'Boot disk eveai-1',
  'Daily snapshots, 7-day retention (eveai-daily)',
];

function withTariffs(report: UsageReport, options: { includeUnusedPriced: boolean }) {
  const known = new Set(report.models.map((entry) => entry.model));
  // Public page only: advertise the tariff of the model the deployment
  // actually runs, even before its first event. Models nobody ever ran must
  // not appear as "$0.00 spent" rows, and the personal endpoint reflects the
  // caller's own events exclusively.
  const pricedOnly = options.includeUnusedPriced
    ? [config.openai.model]
      .filter((model) => !known.has(model) && config.usage.pricing[model])
      .map((model) => ({
        model,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costMicros: 0,
        unknownCostEvents: 0,
      }))
    : [];
  return [...report.models, ...pricedOnly].map((entry) => ({
    ...entry,
    // null = no tariff configured for this model; cost is unknown, not zero.
    tariff: config.usage.pricing[entry.model] ?? null,
  }));
}

function buildInfrastructurePayload() {
  const snapshot = getGcpBillingSnapshot();
  const hasActuals = snapshot.monthToDateUsd !== null;
  return {
    status: snapshot.status,
    monthToDateUsd: snapshot.monthToDateUsd,
    byService: snapshot.byService,
    asOf: snapshot.asOf,
    error: snapshot.error,
    // The export lags hours behind; asOf says when the numbers were read.
    actualsNote: hasActuals
      ? 'Фактические расходы из выгрузки биллинга GCP в BigQuery; выгрузка отстаёт на несколько часов.'
      : null,
    estimate: hasActuals
      ? null
      : {
        monthlyUsd: config.infra.estimateMonthlyUsd,
        components: INFRA_ESTIMATE_COMPONENTS,
        // Deliberately no timestamp: this is a static configuration, and
        // stamping it with "now" would claim a freshness nobody verified.
      },
  };
}

function buildPublicPayload(db: Db) {
  const report = buildUsageReport(db);
  return {
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    currentModel: config.openai.model,
    totals: report.totals,
    daily: report.daily,
    monthly: report.monthly,
    models: withTariffs(report, { includeUnusedPriced: true }),
    infrastructure: buildInfrastructurePayload(),
    fx: config.fx.usdRubRate !== null
      ? { usdRubRate: config.fx.usdRubRate, date: config.fx.usdRubRateDate }
      : null,
    donations: { boostyUrl: config.donations.boostyUrl },
  };
}

export function registerTransparencyRoutes(app: FastifyInstance, db: Db): void {
  // Public on purpose: aggregate figures only, identical for every caller,
  // short-cached by the onRequest hook exception. It must NEVER expose a
  // per-user row — personal spend lives only on the session-gated route below.
  app.get(TRANSPARENCY_PUBLIC_PATH, async () => buildPublicPayload(db));

  app.get(`${TRANSPARENCY_PUBLIC_PATH}/me`, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = readWebSession(db, request);
    if (!session) {
      return reply.status(401).send({ error: 'Сессия истекла. Обновите страницу.' });
    }
    const report = buildUsageReport(db, { userId: session.userId });
    return {
      generatedAt: new Date().toISOString(),
      currency: 'USD',
      totals: report.totals,
      daily: report.daily,
      monthly: report.monthly,
      models: withTariffs(report, { includeUnusedPriced: false }),
    };
  });
}
