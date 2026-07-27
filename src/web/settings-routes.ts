import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { REASONING_EFFORTS, TEXT_VERBOSITIES } from '../openai-options.js';
import {
  USER_SELECTABLE_MODELS,
  isUserReasoningEffort,
  isUserSelectableModel,
  isUserVerbosity,
  resolveModelSettings,
  saveUserModelSettings,
} from '../user-model-settings.js';
import { cleanExpiredWebSessions } from './web-session.js';
import { requireMutationSession, requireSession } from './web-route-guards.js';

/**
 * Per-user model settings HTTP API under /api/web/settings/model. The row in
 * user_model_settings is keyed by the session's user_id, so the same choice
 * applies to every channel lane of that user (web/Telegram/Discord). A user
 * can only ever read and write their own row — there is no id parameter.
 *
 * GET returns the effective state (saved values merged over config defaults)
 * plus the whitelisted options and per-model tariffs for the picker. PUT
 * validates every field against the whitelist and answers with the applied
 * state. DELETE removes the row, returning the user to the config defaults.
 * Changes apply from the next turn; an in-flight request keeps the settings
 * it started with.
 *
 * Errors carry a machine-readable `error` code (never a localized sentence):
 * the bilingual web client maps codes to RU/EN text. Writes are restricted to
 * users with at least one linked EVE character — an anonymous guest choosing
 * a model would amplify the operator's bill with no accountability.
 */

type ModelSettingsBody = {
  model?: unknown;
  reasoning_effort?: unknown;
  verbosity?: unknown;
};

function hasLinkedCharacter(db: Db, userId: number): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM eve_accounts WHERE user_id = ? LIMIT 1').get(userId)
    ?? db.prepare('SELECT 1 FROM eve_character_links WHERE user_id = ? LIMIT 1').get(userId),
  );
}

function settingsPayload(db: Db, userId: number) {
  const resolved = resolveModelSettings(db, userId);
  return {
    ok: true as const,
    settings: {
      model: resolved.model,
      reasoningEffort: resolved.reasoningEffort,
      verbosity: resolved.verbosity,
      isDefault: resolved.isDefault,
    },
    defaults: {
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
      verbosity: config.openai.textVerbosity,
    },
    options: {
      models: USER_SELECTABLE_MODELS.map((id) => ({
        id,
        tariff: config.usage.pricing[id] ?? null,
      })),
      reasoningEfforts: [...REASONING_EFFORTS],
      verbosities: [...TEXT_VERBOSITIES],
    },
    canCustomize: hasLinkedCharacter(db, userId),
  };
}

/**
 * With OPENAI_RESPONSE_STATE_MODE=server the thread continues through a
 * previous_response_id minted by the OLD model; the provider rejects that
 * cross-model chain. Drop the stored continuation after any settings change
 * so the next turn cold-starts from SQLite instead of failing as «service
 * unavailable».
 */
function resetResponseChains(db: Db, userId: number): void {
  db.prepare(
    "UPDATE agent_threads SET last_response_id = NULL, last_response_message_id = NULL, updated_at = datetime('now') WHERE user_id = ?",
  ).run(userId);
}

export function registerSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/settings')) {
      void cleanExpiredWebSessions(db);
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get('/api/web/settings/model', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return settingsPayload(db, session.userId);
  });

  app.put<{ Body: ModelSettingsBody }>('/api/web/settings/model', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!hasLinkedCharacter(db, session.userId)) {
      return reply.status(403).send({ error: 'character_required' });
    }
    const body = request.body ?? {};

    if (!isUserSelectableModel(body.model)) {
      return reply.status(400).send({ error: 'unknown_model' });
    }
    if (!isUserReasoningEffort(body.reasoning_effort)) {
      return reply.status(400).send({ error: 'invalid_reasoning_effort' });
    }
    if (!isUserVerbosity(body.verbosity)) {
      return reply.status(400).send({ error: 'invalid_verbosity' });
    }

    saveUserModelSettings(db, session.userId, {
      model: body.model,
      reasoningEffort: body.reasoning_effort,
      verbosity: body.verbosity,
    });
    resetResponseChains(db, session.userId);
    return settingsPayload(db, session.userId);
  });

  app.delete('/api/web/settings/model', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    db.prepare('DELETE FROM user_model_settings WHERE user_id = ?').run(session.userId);
    resetResponseChains(db, session.userId);
    return settingsPayload(db, session.userId);
  });
}
