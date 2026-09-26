import { parseSqlUtcMs } from '../../sql-utc';
import type { PerimeterMessage } from '../../types';

export const PERIMETER_MESSAGE_LIMIT = 100;

/** Retain row identities and live events newer than the HTTP snapshot. */
export function mergePerimeterHistory(previous: PerimeterMessage[], incoming: readonly PerimeterMessage[]): PerimeterMessage[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  const newest = incoming.reduce((max, message) => Math.max(max, message.id), 0);
  const oldest = incoming.reduce((min, message) => Math.min(min, message.id), Infinity);
  const older = previous.filter((message) => message.id > 0 && message.id < oldest && message.id <= newest);
  const saved = incoming.map((message) => {
    const old = byId.get(message.id);
    return old && old.content === message.content && old.role === message.role
      && old.createdAt === message.createdAt && JSON.stringify(old.meta) === JSON.stringify(message.meta)
      ? old : message;
  });
  const newlySavedUsers = incoming.filter((message) => message.role === 'user' && !byId.has(message.id));
  const tail = previous.filter((message) => {
    if (message.id > newest) return true;
    if (message.id >= 0) return false;
    const match = newlySavedUsers.findIndex((saved) => saved.content === message.content);
    if (match < 0) return true;
    newlySavedUsers.splice(match, 1);
    return false;
  });
  const next = [...older, ...saved, ...tail].slice(-PERIMETER_MESSAGE_LIMIT);
  return next.length === previous.length && next.every((message, i) => message === previous[i]) ? previous : next;
}

/** Sequence invalidates requests started before reset or a newer history read. */
export class PerimeterHistoryGate {
  private version = 0;
  begin(): number { return ++this.version; }
  invalidate(): void { this.version++; }
  accepts(version: number): boolean { return version === this.version; }
}

export function perimeterElapsedSeconds(createdAt: string | undefined, now: number, startedAt: number): number {
  const created = createdAt ? parseSqlUtcMs(createdAt) : NaN;
  return Math.max(0, Math.floor((now - (Number.isFinite(created) ? created : startedAt)) / 1000));
}
