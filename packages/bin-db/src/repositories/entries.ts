import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';

export interface Entry {
  id: string;
  rawText: string;
  sessionId: string | null;
  aiDecision: unknown | null; // AI 当时怎么归类的，原样存 JSON 便于回放
  createdAt: number;
}

interface EntryRow {
  id: string;
  raw_text: string;
  session_id: string | null;
  ai_decision: string | null;
  created_at: number;
}

function mapEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    rawText: row.raw_text,
    sessionId: row.session_id,
    aiDecision: row.ai_decision ? safeParse(row.ai_decision) : null,
    createdAt: row.created_at,
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 追加一条录入原话。
 * 这张表只增不改：AI 的归类可能出错，原话留着才能追溯、重新归类。
 */
export function appendEntry(
  db: Db,
  input: { rawText: string; sessionId?: string | null; aiDecision?: unknown },
): Entry {
  const id = randomUUID();
  const now = Date.now();

  db.prepare('INSERT INTO entries (id, raw_text, session_id, ai_decision, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    input.rawText,
    input.sessionId ?? null,
    input.aiDecision === undefined ? null : JSON.stringify(input.aiDecision),
    now,
  );

  return { id, rawText: input.rawText, sessionId: input.sessionId ?? null, aiDecision: input.aiDecision ?? null, createdAt: now };
}

export function getEntryById(db: Db, id: string): Entry | null {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
  return row ? mapEntry(row) : null;
}

export function listRecentEntries(db: Db, limit = 50): Entry[] {
  const rows = db
    .prepare('SELECT * FROM entries ORDER BY created_at DESC LIMIT ?')
    .all(limit) as EntryRow[];
  return rows.map(mapEntry);
}