/**
 * Слияние живых событий «Периметра» с тем, что уже на экране.
 *
 * Поток доставляет одно и то же повторно (переподключение, реплей, два события
 * в одном тике React), а экран обязан показать каждое сообщение и каждый кил
 * ровно один раз. Чистые функции — чтобы это проверялось тестом, а не глазами.
 */

import type { MapKillEvent, PerimeterMessage } from '../../types';

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
