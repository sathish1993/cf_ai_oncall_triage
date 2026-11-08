import type { IncidentRoom } from "./incident-room";
import type { IncidentLedger } from "./ledger";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  INCIDENT: DurableObjectNamespace<IncidentRoom>;
  LEDGER: DurableObjectNamespace<IncidentLedger>;
  TRIAGE: Workflow<TriageParams>;
  /** "1" swaps Workers AI for deterministic canned responses (local dev and tests only). */
  MOCK_AI?: string;
}

export interface TriageParams {
  incidentId: string;
  report: string;
}

export interface Signals {
  title: string;
  service: string;
  symptom: string;
  error_signatures: string[];
  components: string[];
  severity_guess: "sev1" | "sev2" | "sev3" | "sev4";
  started_hint?: string;
}

export interface Hypothesis {
  cause: string;
  confidence: number;
  evidence: string[];
  check: string;
}

export interface Triage {
  hypotheses: Hypothesis[];
  first_actions: string[];
  related_incident_ids: string[];
  open_questions: string[];
}

export interface MemoryCard {
  title: string;
  signals: string;
  root_cause: string;
  fix: string;
  tags: string[];
}

export interface RecallHit {
  id: string;
  title: string;
  root_cause: string;
  fix: string;
  similarity: number;
}

export type StageName = "signals" | "recall" | "hypotheses" | "resolution" | "postmortem" | "memory";
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export const STAGES: StageName[] = ["signals", "recall", "hypotheses", "resolution", "postmortem", "memory"];

export type ChatRole = "user" | "assistant" | "system";
