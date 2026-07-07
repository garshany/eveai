/**
 * active-fitting — resolve the saved fitting matching the current ship,
 * format it for AI context, and persist to USER.md.
 */

import { readFile, access } from 'node:fs/promises';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';
import type { UserContext } from '../auth/user-resolver.js';
import { resolveUserProfilePath, writeUserProfileAtomic } from './user-profile-storage.js';
import { getLinkedCharacter } from './sso.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EsiFittingItem {
  type_id: number;
  flag: number;
  quantity: number;
}

interface EsiFitting {
  fitting_id: number;
  name: string;
  description: string;
  ship_type_id: number;
  items: EsiFittingItem[];
}

// EVE inventory slot flag ranges
const SLOT_RANGES: Array<[string, number, number]> = [
  ['High', 11, 18],
  ['Mid', 19, 26],
  ['Low', 27, 34],
  ['Rig', 92, 95],
  ['Subsystem', 125, 130],
  ['Drone Bay', 87, 87],
  ['Fighter Bay', 158, 158],
  ['Cargo', 5, 5],
];

function slotCategory(flag: number): string {
  for (const [name, lo, hi] of SLOT_RANGES) {
    if (flag >= lo && flag <= hi) return name;
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Resolve fitting for current ship
// ---------------------------------------------------------------------------

export async function resolveActiveFitting(
  db: Db,
  ctx: UserContext,
  shipTypeId: number,
  shipTypeName: string,
): Promise<string | null> {
  try {
    const result = await callEsiOperation<EsiFitting[]>(
      db, 'get_characters_character_id_fittings',
      { character_id: getLinkedCharacter(db, ctx)?.characterId },
      ctx,
    );

    if (!result.ok || !Array.isArray(result.data)) return null;

    // Find fittings matching current ship type
    const matching = result.data.filter((f) => f.ship_type_id === shipTypeId);
    if (matching.length === 0) return null;

    // Pick the first matching fitting (most recently saved)
    const fit = matching[0];

    // Resolve module names from SDE
    const typeIds = [...new Set(fit.items.map((i) => i.type_id))];
    const nameMap = new Map<number, string>();
    if (typeIds.length > 0) {
      for (let i = 0; i < typeIds.length; i += 500) {
        const chunk = typeIds.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT type_id, name FROM sde_types WHERE type_id IN (${ph})`,
        ).all(...chunk) as Array<{ type_id: number; name: string }>;
        for (const r of rows) nameMap.set(r.type_id, r.name);
      }
    }

    // Group items by slot
    const slotGroups = new Map<string, string[]>();
    for (const item of fit.items) {
      const slot = slotCategory(item.flag);
      const name = nameMap.get(item.type_id) ?? `type_id:${item.type_id}`;
      const entry = item.quantity > 1 ? `${name} x${item.quantity}` : name;
      if (!slotGroups.has(slot)) slotGroups.set(slot, []);
      slotGroups.get(slot)!.push(entry);
    }

    // Format as readable text
    const lines: string[] = [`[${shipTypeName}, ${fit.name}]`];
    const slotOrder = ['High', 'Mid', 'Low', 'Rig', 'Subsystem', 'Drone Bay', 'Fighter Bay', 'Cargo'];
    for (const slot of slotOrder) {
      const modules = slotGroups.get(slot);
      if (modules && modules.length > 0) {
        lines.push('');
        for (const mod of modules) {
          lines.push(mod);
        }
      }
    }

    const fittingText = lines.join('\n');

    // Persist to USER.md
    await persistActiveFitting(db, ctx, fittingText);

    return fittingText;
  } catch (err) {
    console.warn('[active-fitting] failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persist to USER.md
// ---------------------------------------------------------------------------

const SECTION_MARKER = '## Active Fitting';

async function persistActiveFitting(db: Db, ctx: UserContext, fittingText: string): Promise<void> {
  const characterId = getLinkedCharacter(db, ctx)?.characterId;
  if (!characterId) return;
  const path = resolveUserProfilePath(ctx, characterId);
  try {
    await access(path);
  } catch {
    return; // file doesn't exist
  }

  let content = await readFile(path, 'utf-8');

  // Neutralize any line that would look like a Markdown section heading inside
  // the fenced block — otherwise a fitting line like "## Wallet" corrupts the
  // section-boundary search on the next re-save. A zero-width space before the
  // '#' is invisible but breaks the '\n## ' boundary match.
  const safeFitting = fittingText.replace(/^(\s*)#/gm, '$1\u200B#');
  const newSection = `${SECTION_MARKER}\n\`\`\`\n${safeFitting}\n\`\`\``;

  // Replace existing section or append before ## Wallet
  const sectionStart = content.indexOf(SECTION_MARKER);
  if (sectionStart !== -1) {
    // Find next ## heading after the section
    const nextHeading = content.indexOf('\n## ', sectionStart + SECTION_MARKER.length);
    if (nextHeading !== -1) {
      content = content.slice(0, sectionStart) + newSection + '\n\n' + content.slice(nextHeading + 1);
    } else {
      content = content.slice(0, sectionStart) + newSection + '\n';
    }
  } else {
    // Insert before ## Wallet or append at end
    const walletPos = content.indexOf('## Wallet');
    if (walletPos !== -1) {
      content = content.slice(0, walletPos) + newSection + '\n\n' + content.slice(walletPos);
    } else {
      content = content.trimEnd() + '\n\n' + newSection + '\n';
    }
  }

  await writeUserProfileAtomic(path, content);
  console.log('[active-fitting] persisted to USER.md');
}

// ---------------------------------------------------------------------------
// Manual fitting override — user pastes an EFT fit via chat
// ---------------------------------------------------------------------------

export async function writeManualFitting(db: Db, ctx: UserContext, fittingText: string): Promise<{ ok: boolean; error?: string }> {
  const characterId = getLinkedCharacter(db, ctx)?.characterId;
  if (!characterId) return { ok: false, error: 'No character linked.' };
  const path = resolveUserProfilePath(ctx, characterId);
  try {
    await access(path);
  } catch {
    return { ok: false, error: 'USER.md not found. Refresh profile first.' };
  }

  await persistActiveFitting(db, ctx, fittingText.trim());
  return { ok: true };
}
