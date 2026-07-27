import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { buildUsageReport, type UsageReport } from '../usage/stats.js';
import { getGcpBillingSnapshot } from '../usage/gcp-billing.js';
import { readWebSession } from './web-session.js';

export const TRANSPARENCY_PUBLIC_PATH = '/api/web/transparency';

/**
 * Estimate shown only while no live billing export data exists, and always
 * labeled as an estimate. Component list from the owner's measurements; only
 * the monthly total is configurable (INFRA_ESTIMATE_USD_MONTHLY).
 */
const INFRA_ESTIMATE_COMPONENTS = [
  'ВМ eveai-1 (e2-small, europe-west3-c)',
  'Диск данных eveai-data',
  'Загрузочный диск ВМ',
  'Суточные снапшоты обоих дисков (расписание eveai-daily, хранение 7 дней)',
];

function withTariffs(report: UsageReport) {
  const known = new Set(report.models.map((entry) => entry.model));
  const pricedOnly = Object.keys(config.usage.pricing)
    .filter((model) => !known.has(model))
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
    }));
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
        note: 'Оценка по замерам оператора, а не живой биллинг.',
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
    models: withTariffs(report),
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
      models: withTariffs(report),
    };
  });
}
