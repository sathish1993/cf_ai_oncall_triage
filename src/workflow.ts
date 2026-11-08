import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { chat, chatJson, embed } from "./llm";
import {
  HYPOTHESES_PROMPT,
  HYPOTHESES_SCHEMA,
  MEMORY_PROMPT,
  MEMORY_SCHEMA,
  POSTMORTEM_PROMPT,
  SIGNALS_PROMPT,
  SIGNALS_SCHEMA,
} from "./prompts";
import type { Env, MemoryCard, RecallHit, Signals, Triage, TriageParams } from "./types";

const MODEL_STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

export interface ResolutionEvent {
  note: string;
}

/**
 * The life of one incident, as durable steps:
 *
 *   signals -> recall -> hypotheses -> (wait for "resolved") -> postmortem -> memory
 *
 * Each model call is its own step, so a Workers AI hiccup retries that step only, and a
 * finished step is never re-run (no duplicate chat messages, no double-billing the model).
 * The workflow then sleeps on waitForEvent, for up to a week, until a human resolves the
 * incident from the chat. Nothing is held in memory while it waits.
 */
export class TriageWorkflow extends WorkflowEntrypoint<Env, TriageParams> {
  async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
    const { incidentId, report } = event.payload;
    const room = this.env.INCIDENT.get(this.env.INCIDENT.idFromName(incidentId));
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName("global"));

    const signals = await step.do("extract signals", MODEL_STEP, async () => {
      await room.setStage("signals", "running");
      const s = await chatJson<Signals>(
        this.env,
        "signals",
        [
          { role: "system", content: SIGNALS_PROMPT },
          { role: "user", content: report },
        ],
        SIGNALS_SCHEMA,
      );
      await room.setMeta({ signals: s, title: s.title, severity: s.severity_guess });
      await ledger.update(incidentId, { title: s.title, severity: s.severity_guess });
      await room.setStage("signals", "done", `${s.severity_guess} · ${s.service} · ${s.symptom}`);
      return s;
    });

    const similar = await step.do("recall similar incidents", MODEL_STEP, async () => {
      await room.setStage("recall", "running");
      const vector = await embed(this.env, signalText(signals));
      const hits = await ledger.recall(vector, 3, incidentId);
      const strong = hits.filter((h) => h.similarity >= 0.65);
      await room.setStage(
        "recall",
        "done",
        strong.length
          ? strong.map((h) => `${h.title} (${h.similarity.toFixed(2)})`).join("; ")
          : "no close match in memory",
      );
      return hits;
    });

    const triage = await step.do("draft hypotheses", MODEL_STEP, async () => {
      await room.setStage("hypotheses", "running");
      const t = await chatJson<Triage>(
        this.env,
        "hypotheses",
        [
          { role: "system", content: HYPOTHESES_PROMPT },
          {
            role: "user",
            content: [
              `SIGNALS:\n${JSON.stringify(signals, null, 2)}`,
              `PAST INCIDENTS FROM MEMORY:\n${similar.length ? similar.map(pastIncident).join("\n") : "(none)"}`,
              `RAW REPORT:\n${report.slice(0, 6000)}`,
            ].join("\n\n"),
          },
        ],
        HYPOTHESES_SCHEMA,
      );
      t.hypotheses = (t.hypotheses ?? []).sort((a, b) => b.confidence - a.confidence).slice(0, 4);
      await room.setMeta({ triage: t, related: similar.filter((h) => t.related_incident_ids?.includes(h.id)) });
      await room.addMessage("assistant", renderTriage(signals, t, similar));
      await room.setStage("hypotheses", "done", t.hypotheses[0]?.cause ?? "no hypothesis");
      await room.setStage("resolution", "running", "waiting for an engineer to resolve");
      await room.setMeta({ status: "investigating" });
      await ledger.update(incidentId, { status: "investigating" });
      return t;
    });

    let resolution: ResolutionEvent;
    try {
      const evt = await step.waitForEvent<ResolutionEvent>("wait for resolution", {
        type: "resolved",
        timeout: "7 days",
      });
      resolution = evt.payload;
    } catch {
      await step.do("mark stale", async () => {
        await room.setStage("resolution", "failed", "not resolved within 7 days");
        await room.setMeta({ status: "stale" });
        await ledger.update(incidentId, { status: "stale" });
      });
      return { incidentId, outcome: "stale" };
    }

    await step.do("record resolution", async () => {
      await room.setStage("resolution", "done", resolution.note.slice(0, 200));
      await room.setMeta({ status: "resolved", resolution: resolution.note });
      await ledger.update(incidentId, { status: "resolved" });
    });

    await step.do("write postmortem", MODEL_STEP, async () => {
      await room.setStage("postmortem", "running");
      const record = await room.transcript();
      const md = await chat(
        this.env,
        [
          { role: "system", content: POSTMORTEM_PROMPT },
          {
            role: "user",
            content: `INCIDENT: ${signals.title}\nSIGNALS: ${JSON.stringify(signals)}\nTRIAGE: ${JSON.stringify(triage)}\nRESOLUTION NOTE: ${resolution.note}\n\n${record.slice(0, 12000)}`,
          },
        ],
        1400,
      );
      await room.setMeta({ postmortem: md });
      await room.setStage("postmortem", "done", "draft ready");
    });

    await step.do("remember incident", MODEL_STEP, async () => {
      await room.setStage("memory", "running");
      const card = await chatJson<MemoryCard>(
        this.env,
        "memory",
        [
          { role: "system", content: MEMORY_PROMPT },
          {
            role: "user",
            content: `SIGNALS: ${JSON.stringify(signals)}\nTOP HYPOTHESIS: ${triage.hypotheses[0]?.cause ?? ""}\nWHAT ACTUALLY FIXED IT: ${resolution.note}`,
          },
        ],
        MEMORY_SCHEMA,
      );
      const vector = await embed(this.env, `${card.title}\n${card.signals}`);
      await ledger.remember(incidentId, card, vector);
      await room.setStage("memory", "done", `saved as "${card.title}"`);
    });

    return { incidentId, outcome: "resolved" };
  }
}

export function signalText(s: Signals): string {
  return [s.title, s.service, s.symptom, ...(s.error_signatures ?? []), ...(s.components ?? [])].join("\n");
}

function pastIncident(h: RecallHit): string {
  return `- id=${h.id} similarity=${h.similarity} title="${h.title}" root_cause="${h.root_cause}" fix="${h.fix}"`;
}

function renderTriage(s: Signals, t: Triage, similar: RecallHit[]): string {
  const lines: string[] = [];
  lines.push(`**${s.title}** · ${s.severity_guess} · service \`${s.service}\``);
  lines.push("");
  lines.push("**Most likely causes**");
  t.hypotheses.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.cause} (${Math.round(h.confidence * 100)}%)`);
    for (const e of h.evidence ?? []) lines.push(`   - ${e}`);
    if (h.check) lines.push(`   - Check: \`${h.check.replace(/`/g, "'")}\``);
  });
  if (t.first_actions?.length) {
    lines.push("", "**Do first**");
    for (const a of t.first_actions) lines.push(`- ${a}`);
  }
  const related = similar.filter((h) => t.related_incident_ids?.includes(h.id));
  if (related.length) {
    lines.push("", "**Seen before**");
    for (const r of related) lines.push(`- ${r.title}: ${r.root_cause}. Fixed by: ${r.fix}`);
  }
  if (t.open_questions?.length) {
    lines.push("", "**I'd want to know**");
    for (const q of t.open_questions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
}
