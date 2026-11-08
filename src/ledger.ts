import { DurableObject } from "cloudflare:workers";
import { cosine } from "./llm";
import type { Env, MemoryCard, RecallHit } from "./types";

export interface IncidentSummary {
  id: string;
  title: string;
  status: string;
  severity: string | null;
  created_at: number;
  resolved_at: number | null;
  in_memory: boolean;
}

/**
 * One instance ("global") per deployment. It is both the incident index shown in the
 * sidebar and the team's long-term memory of resolved incidents (memory card + embedding).
 *
 * Recall is a brute-force cosine scan in SQLite-backed storage. That is fine for the
 * hundreds of incidents a team accumulates; past that, the embeddings would move to Vectorize
 * and this object would keep only the index.
 */
export class IncidentLedger extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      signals TEXT,
      root_cause TEXT,
      fix TEXT,
      tags TEXT,
      embedding TEXT
    )`);
  }

  open(id: string, title: string): void {
    this.sql.exec(
      `INSERT INTO incidents (id, title, status, created_at) VALUES (?, ?, 'triaging', ?)
       ON CONFLICT(id) DO NOTHING`,
      id,
      title,
      Date.now(),
    );
  }

  update(id: string, fields: { title?: string; status?: string; severity?: string }): void {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || !["title", "status", "severity"].includes(k)) continue;
      this.sql.exec(`UPDATE incidents SET ${k} = ? WHERE id = ?`, v, id);
    }
  }

  remember(id: string, card: MemoryCard, embedding: number[], resolvedAt = Date.now()): void {
    this.sql.exec(
      `INSERT INTO incidents (id, title, status, created_at, resolved_at, signals, root_cause, fix, tags, embedding)
       VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status='resolved', resolved_at=excluded.resolved_at,
         signals=excluded.signals, root_cause=excluded.root_cause, fix=excluded.fix,
         tags=excluded.tags, embedding=excluded.embedding`,
      id,
      card.title,
      resolvedAt,
      resolvedAt,
      card.signals,
      card.root_cause,
      card.fix,
      JSON.stringify(card.tags),
      JSON.stringify(embedding),
    );
  }

  recall(query: number[], k = 3, excludeId?: string): RecallHit[] {
    const rows = this.sql
      .exec<{ id: string; title: string; root_cause: string; fix: string; embedding: string }>(
        `SELECT id, title, root_cause, fix, embedding FROM incidents WHERE embedding IS NOT NULL AND id != ?`,
        excludeId ?? "",
      )
      .toArray();
    return rows
      .map((r) => ({
        id: r.id,
        title: r.title,
        root_cause: r.root_cause,
        fix: r.fix,
        similarity: Math.round(cosine(query, JSON.parse(r.embedding) as number[]) * 1000) / 1000,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  list(): IncidentSummary[] {
    return this.sql
      .exec<{
        id: string;
        title: string;
        status: string;
        severity: string | null;
        created_at: number;
        resolved_at: number | null;
        has_embedding: number;
      }>(
        `SELECT id, title, status, severity, created_at, resolved_at, embedding IS NOT NULL AS has_embedding
         FROM incidents ORDER BY created_at DESC LIMIT 100`,
      )
      .toArray()
      .map(({ has_embedding, ...r }) => ({ ...r, in_memory: has_embedding === 1 }));
  }

  memoryCount(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents WHERE embedding IS NOT NULL`).one().n;
  }
}
