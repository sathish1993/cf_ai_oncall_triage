import { DurableObject } from "cloudflare:workers";
import { chat, type ChatMessage } from "./llm";
import { CHAT_PROMPT } from "./prompts";
import {
  STAGES,
  type ChatRole,
  type Env,
  type RecallHit,
  type Signals,
  type StageName,
  type StageStatus,
  type Triage,
} from "./types";

export interface IncidentMeta {
  id?: string;
  workflowId?: string;
  status?: string;
  title?: string;
  severity?: string;
  created_at?: number;
  signals?: Signals;
  triage?: Triage;
  related?: RecallHit[];
  resolution?: string;
  postmortem?: string;
}

export interface Snapshot {
  meta: IncidentMeta;
  stages: { name: StageName; status: StageStatus; detail: string | null; at: number | null }[];
  messages: { seq: number; role: ChatRole; content: string; at: number }[];
}

const CHAT_HISTORY = 16;

/**
 * One Durable Object per incident. It owns everything about that incident: the original
 * report, the chat, the triage output, and the per-stage timeline the workflow writes to.
 * Because a single object serialises its requests, the workflow and a chatting engineer
 * can write to it at the same time without races.
 */
export class IncidentRoom extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stages (
        name TEXT PRIMARY KEY,
        ord INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        at INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  init(id: string, report: string, workflowId: string): void {
    if (this.getMeta("id")) return;
    this.setMeta({ id, report, workflowId, status: "triaging", created_at: Date.now() });
    STAGES.forEach((name, ord) =>
      this.sql.exec(`INSERT OR IGNORE INTO stages (name, ord, status) VALUES (?, ?, 'pending')`, name, ord),
    );
    this.addMessage("user", report);
  }

  setMeta(fields: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(fields)) {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, k, JSON.stringify(v));
    }
  }

  getMeta<T = unknown>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setStage(name: StageName, status: StageStatus, detail?: string): void {
    this.sql.exec(
      `UPDATE stages SET status = ?, detail = COALESCE(?, detail), at = ? WHERE name = ?`,
      status,
      detail ?? null,
      Date.now(),
      name,
    );
  }

  addMessage(role: ChatRole, content: string): number {
    return this.sql
      .exec<{ seq: number }>(
        `INSERT INTO messages (role, content, at) VALUES (?, ?, ?) RETURNING seq`,
        role,
        content,
        Date.now(),
      )
      .one().seq;
  }

  snapshot(): Snapshot {
    const meta: Record<string, unknown> = {};
    for (const row of this.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta`)) {
      meta[row.key] = JSON.parse(row.value);
    }
    delete meta.report; // already the first message
    return {
      meta: meta as IncidentMeta,
      stages: this.sql
        .exec<Snapshot["stages"][number]>(`SELECT name, status, detail, at FROM stages ORDER BY ord`)
        .toArray(),
      messages: this.sql
        .exec<Snapshot["messages"][number]>(`SELECT seq, role, content, at FROM messages ORDER BY seq`)
        .toArray(),
    };
  }

  /** Plain-text record of the incident, used as model context for chat and the postmortem. */
  transcript(): string {
    const stages = this.sql
      .exec<{ name: string; status: string; detail: string | null; at: number | null }>(
        `SELECT name, status, detail, at FROM stages WHERE at IS NOT NULL ORDER BY at`,
      )
      .toArray()
      .map((s) => `${iso(s.at)} [${s.name}] ${s.status}${s.detail ? `: ${s.detail}` : ""}`);
    const msgs = this.sql
      .exec<{ role: string; content: string; at: number }>(`SELECT role, content, at FROM messages ORDER BY seq`)
      .toArray()
      .map((m) => `${iso(m.at)} ${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`);
    return `TIMELINE\n${stages.join("\n")}\n\nCONVERSATION\n${msgs.join("\n\n")}`;
  }

  /** A turn of conversation with the engineer, grounded in this incident's state. */
  async reply(text: string): Promise<string> {
    this.addMessage("user", text);
    const triage = this.getMeta("triage");
    const signals = this.getMeta("signals");
    const history = this.sql
      .exec<{ role: ChatRole; content: string }>(
        `SELECT role, content FROM (SELECT seq, role, content FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
        CHAT_HISTORY,
      )
      .toArray()
      .filter((m) => m.role !== "system") as ChatMessage[];

    const context = [
      `ORIGINAL REPORT:\n${String(this.getMeta("report") ?? "").slice(0, 4000)}`,
      signals ? `EXTRACTED SIGNALS:\n${JSON.stringify(signals)}` : "Signals are still being extracted.",
      triage ? `AUTOMATED TRIAGE:\n${JSON.stringify(triage)}` : "Automated triage has not finished yet.",
      `STATUS: ${this.getMeta("status")}`,
    ].join("\n\n");

    let answer: string;
    try {
      answer = await chat(this.env, [{ role: "system", content: `${CHAT_PROMPT}\n\n${context}` }, ...history]);
    } catch (err) {
      answer = `I couldn't reach the model just now (${(err as Error).message}). Try again in a moment.`;
    }
    this.addMessage("assistant", answer || "I don't have anything useful to add to that yet.");
    return answer;
  }
}

const iso = (t: number | null) => (t ? new Date(t).toISOString().replace(/\.\d+Z$/, "Z") : "");
