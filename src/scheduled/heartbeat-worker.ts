import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation, pruneExpiredEsiCache } from '../eve/esi-client.js';
import { prunePlans } from '../agent/planner.js';
import { getAccessToken } from '../eve/sso.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import { getUserOutboundChatId } from '../auth/user-resolver.js';
import { sendOutbound } from '../messaging/outbound.js';
import { runModelText } from '../agent/model.js';
import {
  parseChecks,
  parseState,
  saveState,
  type HeartbeatConfigRow,
  type HeartbeatCheckType,
  type HeartbeatState,
} from './heartbeat-config.js';
import type { UserContext } from '../auth/user-resolver.js';


const HEARTBEAT_CRON = '*/5 * * * *'; // every 5 minutes, checks per-user intervals internally
const WALLET_CHANGE_THRESHOLD = 10_000_000; // 10M ISK minimum change to notify

let cronJob: Cron | null = null;

export function startHeartbeat(db: Db): void {
  console.log('[heartbeat] Starting heartbeat worker');
  // protect: true prevents overlapping ticks — a slow tick (ESI backoff, LLM
  // summarize) must not race a new one on the same users/state.
  cronJob = new Cron(HEARTBEAT_CRON, { protect: true }, async () => {
    try {
      await runHeartbeatTick(db);
    } catch (err) {
      console.error('[heartbeat] tick error:', err);
    }
  });
}

export function stopHeartbeat(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[heartbeat] Stopped');
  }
}

let ticksSinceCacheSweep = 0;
const CACHE_SWEEP_EVERY_TICKS = 12; // every ~1h at the 5-min cron

async function runHeartbeatTick(db: Db): Promise<void> {
  const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Piggyback maintenance on the existing cron: prune expired ESI cache rows so
  // the shared esi_cache table can't grow without bound.
  if (ticksSinceCacheSweep++ >= CACHE_SWEEP_EVERY_TICKS) {
    ticksSinceCacheSweep = 0;
    try {
      const removed = pruneExpiredEsiCache(db);
      if (removed > 0) console.log('[heartbeat] pruned %d expired esi_cache rows', removed);
      prunePlans(db);
    } catch (err) {
      console.error('[heartbeat] maintenance sweep failed:', err);
    }
  }

  const rows = db.prepare(`
    SELECT * FROM heartbeat_config
    WHERE enabled = 1
    AND (last_run_at IS NULL OR
         strftime('%s', 'now') - strftime('%s', last_run_at) >= interval_seconds)
  `).all() as HeartbeatConfigRow[];

  for (const row of rows) {
    try {
      await processUserHeartbeat(db, row, nowUtc);
    } catch (err) {
      console.error('[heartbeat] user=%d char=%d error:', row.user_id, row.character_id, err);
    }
  }
}

async function processUserHeartbeat(
  db: Db,
  row: HeartbeatConfigRow,
  nowUtc: string,
): Promise<void> {
  const ctx: UserContext = { userId: row.user_id };
  const chatId = getUserOutboundChatId(db, row.user_id);
  if (!chatId) return;

  const tokenResult = await getAccessToken(db, ctx);
  if (!tokenResult) {
    // Dead/expired token: still record the attempt so the user is retried at
    // their configured interval, not on every 5-minute tick (each retry hits
    // the EVE SSO token endpoint).
    db.prepare(
      'UPDATE heartbeat_config SET last_run_at = ? WHERE user_id = ? AND character_id = ?',
    ).run(nowUtc, row.user_id, row.character_id);
    console.warn('[heartbeat] user=%d char=%d: no valid EVE token, skipping until next interval', row.user_id, row.character_id);
    return;
  }

  // Record capability snapshot so callEsiOperation doesn't reject with 428
  await getEveCapabilities(db, 'heartbeat', ctx);

  const checks = parseChecks(row.checks_json);
  const state = parseState(row.state_json);
  const findings: string[] = [];

  console.log('[heartbeat] user=%d char=%d: running %d checks: %s', row.user_id, row.character_id, checks.length, checks.join(','));

  for (const check of checks) {
    try {
      const result = await runCheck(db, ctx, row.character_id, check, state);
      if (result) {
        findings.push(result);
        console.log('[heartbeat] check=%s: found something', check);
      }
    } catch (err) {
      console.error('[heartbeat] check=%s user=%d error:', check, row.user_id, err);
    }
  }

  // Save state and last_run_at
  console.log('[heartbeat] saving state: %s', JSON.stringify(Object.keys(state)));
  saveState(db, row.user_id, row.character_id, state);
  db.prepare(
    "UPDATE heartbeat_config SET last_run_at = ? WHERE user_id = ? AND character_id = ?",
  ).run(nowUtc, row.user_id, row.character_id);

  if (findings.length === 0) {
    console.log('[heartbeat] user=%d char=%d: nothing new', row.user_id, row.character_id);
    return;
  }

  const characterName = getCharacterName(db, row.character_id);
  const summary = await summarizeFindings(characterName, findings);

  sendOutbound(chatId, summary);
  console.log('[heartbeat] user=%d char=%d: sent %d findings', row.user_id, row.character_id, findings.length);
}

function getCharacterName(db: Db, characterId: number): string {
  const row = db.prepare('SELECT character_name FROM eve_accounts WHERE character_id = ?')
    .get(characterId) as { character_name: string } | undefined;
  return row?.character_name ?? `Character ${characterId}`;
}

function sdeName(db: Db, typeId: number): string {
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  return row?.name ?? `type:${typeId}`;
}

async function resolveName(db: Db, ctx: UserContext, entityId: number): Promise<string> {
  const result = await callEsiOperation<Array<{ id: number; name: string }>>(
    db, 'post_universe_names', { ids: JSON.stringify([entityId]) }, ctx,
  );
  if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
    return result.data[0].name;
  }
  return `ID:${entityId}`;
}

// ── Check dispatcher ──

async function runCheck(
  db: Db, ctx: UserContext, characterId: number,
  check: HeartbeatCheckType, state: HeartbeatState,
): Promise<string | null> {
  switch (check) {
    case 'mail': return await checkMail(db, ctx, characterId, state);
    case 'skills': return await checkSkills(db, ctx, characterId, state);
    case 'wallet': return await checkWallet(db, ctx, characterId, state);
    case 'industry': return await checkIndustry(db, ctx, characterId, state);
    case 'contracts': return await checkContracts(db, ctx, characterId, state);
    case 'killmails': return await checkKillmails(db, ctx, characterId, state);
    case 'orders': return await checkOrders(db, ctx, characterId, state);
    case 'notifications': return await checkNotifications(db, ctx, characterId, state);
    case 'pi': return await checkPI(db, ctx, characterId);
    default: return null;
  }
}

// ── MAIL ──

async function checkMail(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{ mail_id: number; from: number; subject: string; timestamp: string }>>(
    db, 'get_characters_character_id_mail', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return null;

  // First run: seed a baseline silently instead of dumping the whole inbox.
  // An empty first poll must still seed (to 0) so the next real mail is
  // reported instead of being swallowed as another "first run".
  if (state.last_mail_id === undefined) {
    state.last_mail_id = result.data.length > 0 ? Math.max(...result.data.map((m) => m.mail_id)) : 0;
    return null;
  }
  if (result.data.length === 0) return null;

  const lastId = state.last_mail_id;
  const newMail = result.data.filter((m) => m.mail_id > lastId);
  if (newMail.length === 0) return null;

  state.last_mail_id = Math.max(...newMail.map((m) => m.mail_id));

  const details: string[] = [];
  for (const mail of newMail.slice(0, 5)) {
    const body = await callEsiOperation<{ body: string }>(
      db, 'get_characters_character_id_mail_mail_id',
      { character_id: characterId, mail_id: mail.mail_id }, ctx,
    );
    const bodyText = body.ok ? body.data.body?.slice(0, 300) ?? '' : '';
    const sender = await resolveName(db, ctx, mail.from);
    details.push(`От: ${sender}\nТема: ${mail.subject}\n${bodyText}`);
  }
  const extra = newMail.length > 5 ? `\n...и ещё ${newMail.length - 5}` : '';
  return `[ПОЧТА] ${newMail.length} новых:\n\n${details.join('\n\n')}${extra}`;
}

// ── SKILLS ──

async function checkSkills(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    skill_id: number; finished_level: number; finish_date?: string; queue_position: number;
  }>>(
    db, 'get_characters_character_id_skillqueue', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return null;

  const now = new Date();
  const currentIds = result.data
    .filter((s) => s.finish_date && new Date(s.finish_date) > now)
    .map((s) => s.skill_id);
  const prevIds = new Set(state.last_skillqueue_ids ?? []);

  // Skills that were in queue but are no longer (completed)
  const completedIds = [...prevIds].filter((id) => !currentIds.includes(id));
  const findings: string[] = [];

  if (completedIds.length > 0) {
    // Find levels from the previous queue data or current skills
    const names = completedIds.map((id) => sdeName(db, id));
    findings.push(`Завершены: ${names.join(', ')}`);
  }

  // Notify about an empty queue once, not on every interval.
  if (result.data.length === 0 || currentIds.length === 0) {
    if (!state.empty_queue_notified) {
      state.empty_queue_notified = true;
      findings.push('Очередь скиллов пуста!');
    }
  } else {
    state.empty_queue_notified = false;
  }

  state.last_skillqueue_ids = currentIds;

  if (findings.length === 0) return null;
  return `[СКИЛЛЫ] ${findings.join('. ')}`;
}

// ── WALLET ──

async function checkWallet(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<number>(
    db, 'get_characters_character_id_wallet', { character_id: characterId }, ctx,
  );
  if (!result.ok || typeof result.data !== 'number') return null;

  const balance = result.data;
  const prev = state.last_wallet_balance;
  state.last_wallet_balance = balance;

  // First run — just record, don't notify
  if (prev === undefined) return null;

  const delta = balance - prev;
  if (Math.abs(delta) < WALLET_CHANGE_THRESHOLD) return null;

  const sign = delta > 0 ? '+' : '';
  const fmt = (n: number) => {
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(0) + 'M';
    return n.toLocaleString('en-US');
  };
  return `[КОШЕЛЁК] ${sign}${fmt(delta)} ISK (было ${fmt(prev)} → стало ${fmt(balance)})`;
}

// ── INDUSTRY ──

async function checkIndustry(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    job_id: number; activity_id: number; blueprint_type_id: number;
    product_type_id: number; status: string; runs: number; end_date: string;
  }>>(
    db, 'get_characters_character_id_industry_jobs', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return null;

  const prevJobIds = new Set(state.last_industry_job_ids ?? []);
  const activeJobs = result.data.filter((j) => j.status === 'active');
  const currentActiveIds = activeJobs.map((j) => j.job_id);

  // Jobs that were active but are no longer (completed)
  const completedIds = [...prevJobIds].filter((id) => !currentActiveIds.includes(id));
  state.last_industry_job_ids = currentActiveIds;

  if (completedIds.length === 0 && prevJobIds.size > 0) return null;
  if (completedIds.length === 0) return null; // first run or nothing changed

  const completedJobs = result.data.filter((j) => completedIds.includes(j.job_id));
  const lines = completedJobs.map((j) => {
    const product = sdeName(db, j.product_type_id || j.blueprint_type_id);
    const activity = j.activity_id === 1 ? 'Manufacturing' : j.activity_id === 3 ? 'TE Research' :
      j.activity_id === 4 ? 'ME Research' : j.activity_id === 5 ? 'Copying' :
      j.activity_id === 8 ? 'Invention' : `Activity ${j.activity_id}`;
    return `${activity}: ${j.runs}x ${product}`;
  });

  if (lines.length === 0) return null;
  return `[ИНДУСТРИЯ] Завершено:\n${lines.join('\n')}`;
}

// ── CONTRACTS ──

async function checkContracts(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    contract_id: number; type: string; status: string; title: string;
    price: number; issuer_id: number; date_issued: string;
  }>>(
    db, 'get_characters_character_id_contracts', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return null;

  // First run: seed silently instead of reporting historical contracts.
  if (state.last_contract_id === undefined) {
    state.last_contract_id = result.data.length > 0
      ? Math.max(...result.data.map((c) => c.contract_id))
      : 0;
    return null;
  }

  const lastId = state.last_contract_id;
  // New contracts assigned to this character (not issued by them)
  const newContracts = result.data
    .filter((c) => c.contract_id > lastId && c.issuer_id !== characterId && c.status === 'outstanding');

  if (newContracts.length === 0) {
    // Still update tracking
    if (result.data.length > 0) {
      state.last_contract_id = Math.max(...result.data.map((c) => c.contract_id));
    }
    return null;
  }

  state.last_contract_id = Math.max(...result.data.map((c) => c.contract_id));

  const lines = newContracts.slice(0, 5).map((c) => {
    const price = c.price > 0 ? ` за ${(c.price / 1e6).toFixed(0)}M ISK` : '';
    return `${c.type}: ${c.title || '(без названия)'}${price}`;
  });

  return `[КОНТРАКТЫ] ${newContracts.length} новых:\n${lines.join('\n')}`;
}

// ── KILLMAILS ──

async function checkKillmails(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const details: string[] = [];
  const seenIds = new Set<number>();

  // Check ESI for killmails
  const result = await callEsiOperation<Array<{ killmail_id: number; killmail_hash: string }>>(
    db, 'get_characters_character_id_killmails_recent', { character_id: characterId }, ctx,
  );

  // First run: seed silently instead of reporting historical killmails.
  if (state.last_killmail_id === undefined) {
    if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
      state.last_killmail_id = Math.max(...result.data.map((k) => k.killmail_id));
    } else {
      state.last_killmail_id = 0;
    }
    return null;
  }

  const lastId = state.last_killmail_id;
  if (result.ok && Array.isArray(result.data)) {
    const newEsiKills = result.data.filter((k) => k.killmail_id > lastId && !seenIds.has(k.killmail_id));

    for (const km of newEsiKills) {
      seenIds.add(km.killmail_id);
      if (details.length < 3) {
        const detail = await callEsiOperation<{
          victim: { character_id?: number; ship_type_id: number };
          solar_system_id: number;
          killmail_time: string;
        }>(
          db, 'get_killmails_killmail_id_killmail_hash',
          { killmail_id: km.killmail_id, killmail_hash: km.killmail_hash }, ctx,
        );
        if (!detail.ok) continue;
        const isLoss = detail.data.victim?.character_id === characterId;
        const ship = sdeName(db, detail.data.victim.ship_type_id);
        const system = db.prepare('SELECT name FROM sde_systems WHERE system_id = ?')
          .get(detail.data.solar_system_id) as { name: string } | undefined;
        details.push(`${isLoss ? 'Потерян' : 'Уничтожен'} ${ship} в ${system?.name ?? '?'}`);
      }
    }
  }

  if (seenIds.size === 0) return null;

  // Update state with highest seen killmail_id
  state.last_killmail_id = Math.max(...seenIds);

  const total = seenIds.size;
  const extra = total > 3 ? `\n...и ещё ${total - 3}` : '';
  return `[KILLMAILS] ${total} новых:\n${details.join('\n')}${extra}`;
}

// ── ORDERS ──

async function checkOrders(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    order_id: number; type_id: number; price: number;
    volume_remain: number; volume_total: number; is_buy_order: boolean;
  }>>(
    db, 'get_characters_character_id_orders', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return null;

  const currentIds = result.data.map((o) => o.order_id);
  const prevIds = state.last_order_ids ?? [];

  // Orders that disappeared (filled or expired)
  const goneIds = prevIds.filter((id) => !currentIds.includes(id));
  state.last_order_ids = currentIds;

  if (goneIds.length === 0 || prevIds.length === 0) return null;

  return `[ОРДЕРА] ${goneIds.length} ордеров исполнено/истекло. Активных осталось: ${currentIds.length}.`;
}

// ── NOTIFICATIONS ──

async function checkNotifications(
  db: Db, ctx: UserContext, characterId: number, state: HeartbeatState,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    notification_id: number; type: string; text: string;
    timestamp: string; sender_id: number; sender_type: string;
  }>>(
    db, 'get_characters_character_id_notifications', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return null;

  // First run: seed a baseline silently. An empty first poll seeds to 0 so the
  // next real notification is reported rather than swallowed as a first run.
  if (state.last_notification_id === undefined) {
    state.last_notification_id = result.data.length > 0 ? Math.max(...result.data.map((n) => n.notification_id)) : 0;
    return null;
  }
  if (result.data.length === 0) return null;

  const lastId = state.last_notification_id;
  const important = new Set([
    'StructureUnderAttack', 'StructureLostShields', 'StructureLostArmor',
    'StructureDestroyed', 'StructureFuelAlert', 'StructureAnchoring',
    'StructureServicesOffline', 'WarDeclaredV2', 'WarAdopted',
    'WarInherited', 'WarRetractedByConcord', 'AllWarDeclaredMsg',
    'CorpWarDeclaredV2', 'EntosisCaptureStarted', 'SovStructureReinforced',
    'OrbitalAttacked', 'TowerAlertMsg', 'StationServiceEnabled',
    'StationServiceDisabled', 'OwnershipTransferred',
  ]);

  const newNotifs = result.data
    .filter((n) => n.notification_id > lastId && important.has(n.type));

  if (result.data.length > 0) {
    state.last_notification_id = Math.max(...result.data.map((n) => n.notification_id));
  }

  if (newNotifs.length === 0) return null;

  const lines = newNotifs.slice(0, 5).map((n) => `${n.type} (${n.timestamp.slice(0, 16)})`);
  return `[УВЕДОМЛЕНИЯ] ${newNotifs.length} важных:\n${lines.join('\n')}`;
}

// ── PI ──

async function checkPI(
  db: Db, ctx: UserContext, characterId: number,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    planet_id: number; planet_type: string; last_update: string;
    num_pins: number; solar_system_id: number;
  }>>(
    db, 'get_characters_character_id_planets', { character_id: characterId }, ctx,
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;

  const stale: string[] = [];
  const now = Date.now();
  const STALE_HOURS = 24;

  for (const planet of result.data) {
    const updated = new Date(planet.last_update).getTime();
    const hoursAgo = (now - updated) / (1000 * 60 * 60);
    if (hoursAgo > STALE_HOURS) {
      const system = db.prepare('SELECT name FROM sde_systems WHERE system_id = ?')
        .get(planet.solar_system_id) as { name: string } | undefined;
      stale.push(`${planet.planet_type} в ${system?.name ?? '?'} (${Math.round(hoursAgo)}ч назад)`);
    }
  }

  if (stale.length === 0) return null;
  return `[PI] ${stale.length} планет требуют внимания:\n${stale.join('\n')}`;
}

// ── Model summary ──

async function summarizeFindings(characterName: string, findings: string[]): Promise<string> {
  const systemPrompt = `You are an EVE Online assistant. Summarize the following heartbeat check results for character "${characterName}".
Be concise, use Russian language. Plain text only, no markdown or HTML.
If there are mail messages, briefly describe each and suggest if any action is needed.
Start with a short header line. Keep it under 1500 characters.`;

  const userPrompt = findings.join('\n\n---\n\n');

  try {
    return await runModelText(systemPrompt, userPrompt);
  } catch (err) {
    console.error('[heartbeat] model summarize failed:', err);
    return `${characterName}:\n\n${findings.join('\n\n')}`;
  }
}
