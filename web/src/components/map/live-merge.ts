/**
 * Слияние живых событий «Периметра» с тем, что уже на экране.
 *
 * Поток доставляет одно и то же повторно (переподключение, реплей, два события
 * в одном тике React), а экран обязан показать каждое сообщение и каждый кил
 * ровно один раз. Чистые функции — чтобы это проверялось тестом, а не глазами.
 */

import type { MapKillEvent, PerimeterMessage, UniverseActivity } from '../../types';

/**
 * Дописывает к ленте чата живые советы, которых в ней ещё нет.
 *
 * Дедуп идёт и против уже показанного, и внутри самой пачки: два одинаковых
 * события, пришедшие до следующего рендера, иначе давали две строки с одним
 * ключом. Сообщения не новее `clearedBeforeId` — это то, что пилот уже стёр.
 */
export function mergeAdvisoryMessages(
  previous: PerimeterMessage[],
  incoming: readonly PerimeterMessage[],
  clearedBeforeId: number,
): PerimeterMessage[] {
  const known = new Set(previous.map((message) => message.id));
  const additions: PerimeterMessage[] = [];
  for (const message of incoming) {
    if (known.has(message.id) || message.id <= clearedBeforeId) continue;
    known.add(message.id);
    additions.push(message);
  }
  return additions.length > 0 ? [...previous, ...additions] : previous;
}

/**
 * Список килов инспектора с учётом свежих событий по этой системе.
 *
 * Свежее — сверху, без повторов по killmailId, с потолком: инспектор
 * показывает последние, а не всю историю долгого полёта. Возвращает тот же
 * массив, если добавить нечего, чтобы не будить лишний рендер.
 */
export function mergeSystemKills(
  existing: MapKillEvent[],
  incoming: readonly MapKillEvent[],
  systemId: number,
  cap = 30,
): MapKillEvent[] {
  const known = new Set(existing.map((kill) => kill.killmailId));
  const additions: MapKillEvent[] = [];
  for (const kill of incoming) {
    if (kill.systemId !== systemId || known.has(kill.killmailId)) continue;
    known.add(kill.killmailId);
    additions.push(kill);
  }
  if (additions.length === 0) return existing;
  return [...additions, ...existing]
    .sort((a, b) => b.killmailTimeMs - a.killmailTimeMs)
    .slice(0, cap);
}

/**
 * Килы, которых экран ещё не видел, каждый один раз; сам набор увиденных не
 * трогает — это решает вызывающий.
 */
export function unseenKills(kills: readonly MapKillEvent[], seen: ReadonlySet<number>): MapKillEvent[] {
  const batch = new Set<number>();
  return kills.filter((kill) => {
    if (seen.has(kill.killmailId) || batch.has(kill.killmailId)) return false;
    batch.add(kill.killmailId);
    return true;
  });
}

/** A live-stream kill and when this tab received it (client clock). */
export type ReceivedKill = { kill: MapKillEvent; receivedAtMs: number };

const BAND_ORDER = ['calm', 'watch', 'elevated', 'hostile', 'lethal'];
const UNIVERSE_WINDOW_MS = 60 * 60_000;
const UNIVERSE_15M_MS = 15 * 60_000;

/**
 * Whole-map activity with the live stream's kills laid over the last polled
 * snapshot.
 *
 * The cluster rollup is polled every 15 s; without this the whole-map view
 * learned of a kill up to a poll later than the bubble next to it. Only kills
 * received after the snapshot arrived are added (earlier ones are, or will be,
 * in it), each once by killmailId, and a PvP kill lifts a calm system to
 * `watch` at least — never lowers anything. Returns the same object when there
 * is nothing to add.
 */
export function overlayLiveKills(
  activity: UniverseActivity,
  received: readonly ReceivedKill[],
  snapshotReceivedAtMs: number,
  now = Date.now(),
): UniverseActivity {
  const seen = new Set<number>();
  const fresh: MapKillEvent[] = [];
  for (const entry of received) {
    const kill = entry.kill;
    if (entry.receivedAtMs <= snapshotReceivedAtMs || seen.has(kill.killmailId)) continue;
    if (now - kill.killmailTimeMs > UNIVERSE_WINDOW_MS) continue;
    seen.add(kill.killmailId);
    fresh.push(kill);
  }
  if (fresh.length === 0) return activity;

  const next: UniverseActivity = {
    ...activity,
    systemIds: [...activity.systemIds],
    kills1h: [...activity.kills1h],
    kills15m: [...activity.kills15m],
    npcKills1h: [...activity.npcKills1h],
    valueDestroyed1h: [...activity.valueDestroyed1h],
    gateKills1h: [...activity.gateKills1h],
    bands: [...activity.bands],
    totals: { ...activity.totals },
  };
  const indexOf = new Map<number, number>();
  next.systemIds.forEach((id, index) => indexOf.set(id, index));

  for (const kill of fresh) {
    let index = indexOf.get(kill.systemId);
    if (index === undefined) {
      index = next.systemIds.length;
      indexOf.set(kill.systemId, index);
      next.systemIds.push(kill.systemId);
      next.kills1h.push(0);
      next.kills15m.push(0);
      next.npcKills1h.push(0);
      next.valueDestroyed1h.push(0);
      next.gateKills1h.push(0);
      next.bands.push('calm');
    }
    next.valueDestroyed1h[index] = (next.valueDestroyed1h[index] ?? 0) + Math.round(kill.totalValue);
    if (kill.isNpc) {
      next.npcKills1h[index] = (next.npcKills1h[index] ?? 0) + 1;
      continue;
    }
    next.kills1h[index] = (next.kills1h[index] ?? 0) + 1;
    if (now - kill.killmailTimeMs <= UNIVERSE_15M_MS) next.kills15m[index] = (next.kills15m[index] ?? 0) + 1;
    if (BAND_ORDER.indexOf(next.bands[index] ?? 'calm') < 1) next.bands[index] = 'watch';
    next.totals.kills1h += 1;
  }
  next.totals.activeSystems = next.systemIds.length;
  return next;
}
