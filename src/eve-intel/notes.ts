/**
 * intel_note — personal intel notebook for EVE Online players.
 * Save, search, list, and delete notes tied to systems, regions, or entities.
 */

import type { Db } from '../db/sqlite.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NoteRow {
  note_id: number;
  system_id: number | null;
  system_name: string | null;
  region_id: number | null;
  region_name: string | null;
  entity_name: string | null;
  tag: string;
  text: string;
  created_at: string;
}

interface SdeRegionRow {
  region_id: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTE_LENGTH = 2000;
/** Per-user retention cap: the oldest note is evicted once this is exceeded. */
const MAX_NOTES_PER_USER = 500;
const MAX_RESULTS = 30;

// ---------------------------------------------------------------------------
// SDE resolution helpers
// ---------------------------------------------------------------------------

function resolveSystem(db: Db, name: string): { systemId: number; systemName: string; regionId: number; regionName: string } | null {
  const row = db.prepare(`
    SELECT s.system_id, s.name AS system_name,
           r.region_id, r.name AS region_name
    FROM sde_systems s
    JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.name = ? COLLATE NOCASE
    LIMIT 1
  `).get(name) as { system_id: number; system_name: string; region_id: number; region_name: string } | undefined;
  if (!row) return null;
  return { systemId: row.system_id, systemName: row.system_name, regionId: row.region_id, regionName: row.region_name };
}

function resolveRegion(db: Db, name: string): { regionId: number; regionName: string } | null {
  const row = db.prepare(`
    SELECT region_id, name FROM sde_regions WHERE name = ? COLLATE NOCASE LIMIT 1
  `).get(name) as SdeRegionRow | undefined;
  if (!row) return null;
  return { regionId: row.region_id, regionName: row.name };
}

// ---------------------------------------------------------------------------
// Format note for output
// ---------------------------------------------------------------------------

function formatNote(row: NoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.note_id,
    text: row.text,
    tag: row.tag,
    created_at: row.created_at,
  };
  if (row.system_name) out.system = row.system_name;
  if (row.region_name) out.region = row.region_name;
  if (row.entity_name) out.entity = row.entity_name;
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function saveNote(
  db: Db,
  userId: number,
  args: Record<string, unknown>,
): unknown {
  const text = String(args.text ?? '').trim();
  if (!text) return { ok: false, error: 'Note text is empty.' };
  if (text.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `Note too long (${text.length}). Max ${MAX_NOTE_LENGTH} chars.` };
  }

  const tag = String(args.tag ?? 'general').trim().toLowerCase();
  const entityName = typeof args.entity_name === 'string' ? args.entity_name.trim() || null : null;

  let systemId: number | null = null;
  let systemName: string | null = null;
  let regionId: number | null = null;
  let regionName: string | null = null;

  // Resolve system if provided
  const rawSystem = typeof args.system === 'string' ? args.system.trim() : null;
  if (rawSystem) {
    const resolved = resolveSystem(db, rawSystem);
    if (resolved) {
      systemId = resolved.systemId;
      systemName = resolved.systemName;
      regionId = resolved.regionId;
      regionName = resolved.regionName;
    } else {
      // Store name even if not in SDE (wormhole systems may not resolve)
      systemName = rawSystem;
    }
  }

  // Resolve region if provided and not already set via system
  const rawRegion = typeof args.region === 'string' ? args.region.trim() : null;
  if (rawRegion && !regionId) {
    const resolved = resolveRegion(db, rawRegion);
    if (resolved) {
      regionId = resolved.regionId;
      regionName = resolved.regionName;
    } else {
      regionName = rawRegion;
    }
  }

  const result = db.prepare(`
    INSERT INTO intel_notes (user_id, system_id, system_name, region_id, region_name, entity_name, tag, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, systemId, systemName, regionId, regionName, entityName, tag, text);

  // Bound per-user growth: evict the oldest notes past the retention cap.
  db.prepare(`
    DELETE FROM intel_notes
    WHERE user_id = ?
      AND note_id NOT IN (
        SELECT note_id FROM intel_notes WHERE user_id = ? ORDER BY note_id DESC LIMIT ?
      )
  `).run(userId, userId, MAX_NOTES_PER_USER);

  console.log(`[intel_note] saved note #${result.lastInsertRowid} for user=${userId}, system=${systemName ?? 'none'}, tag=${tag}`);

  return {
    ok: true,
    note_id: Number(result.lastInsertRowid),
    system: systemName,
    region: regionName,
    entity: entityName,
    tag,
  };
}

function searchNotes(
  db: Db,
  userId: number,
  args: Record<string, unknown>,
): unknown {
  const conditions: string[] = ['user_id = ?'];
  const params: unknown[] = [userId];

  // Filter by system
  const rawSystem = typeof args.system === 'string' ? args.system.trim() : null;
  if (rawSystem) {
    const resolved = resolveSystem(db, rawSystem);
    if (resolved) {
      conditions.push('system_id = ?');
      params.push(resolved.systemId);
    } else {
      conditions.push('system_name = ? COLLATE NOCASE');
      params.push(rawSystem);
    }
  }

  // Filter by region
  const rawRegion = typeof args.region === 'string' ? args.region.trim() : null;
  if (rawRegion) {
    const resolved = resolveRegion(db, rawRegion);
    if (resolved) {
      conditions.push('region_id = ?');
      params.push(resolved.regionId);
    } else {
      conditions.push('region_name = ? COLLATE NOCASE');
      params.push(rawRegion);
    }
  }

  // Filter by entity
  const entityName = typeof args.entity_name === 'string' ? args.entity_name.trim() : null;
  if (entityName) {
    conditions.push('entity_name = ? COLLATE NOCASE');
    params.push(entityName);
  }

  // Filter by tag
  const tag = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : null;
  if (tag) {
    conditions.push('tag = ?');
    params.push(tag);
  }

  // Text search (LIKE)
  const query = typeof args.query === 'string' ? args.query.trim() : null;
  if (query) {
    conditions.push('text LIKE ?');
    params.push(`%${query}%`);
  }

  const sql = `
    SELECT note_id, system_id, system_name, region_id, region_name, entity_name, tag, text, created_at
    FROM intel_notes
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ${MAX_RESULTS}
  `;

  const rows = db.prepare(sql).all(...params) as NoteRow[];

  return {
    ok: true,
    count: rows.length,
    notes: rows.map(formatNote),
  };
}

function listNotes(db: Db, userId: number): unknown {
  const rows = db.prepare(`
    SELECT note_id, system_id, system_name, region_id, region_name, entity_name, tag, text, created_at
    FROM intel_notes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ${MAX_RESULTS}
  `).all(userId) as NoteRow[];

  return {
    ok: true,
    count: rows.length,
    notes: rows.map(formatNote),
  };
}

function deleteNote(db: Db, userId: number, args: Record<string, unknown>): unknown {
  const noteId = typeof args.note_id === 'number' ? args.note_id : null;
  if (!noteId) return { ok: false, error: 'note_id is required for delete.' };

  const result = db.prepare('DELETE FROM intel_notes WHERE note_id = ? AND user_id = ?').run(noteId, userId);
  if (result.changes === 0) {
    return { ok: false, error: `Note #${noteId} not found or access denied.` };
  }

  return { ok: true, deleted: noteId };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function executeIntelNote(
  db: Db,
  userId: number,
  args: Record<string, unknown>,
): unknown {
  const action = String(args.action ?? 'search');

  switch (action) {
    case 'save':
      return saveNote(db, userId, args);
    case 'search':
      return searchNotes(db, userId, args);
    case 'list':
      return listNotes(db, userId);
    case 'delete':
      return deleteNote(db, userId, args);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}
