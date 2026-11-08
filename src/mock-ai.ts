// Deterministic stand-ins for Workers AI, used only when MOCK_AI=1.
// They let the whole flow (workflow steps, waitForEvent, memory recall, UI) run locally
// without a Cloudflare account. They are not meant to be clever.

import type { ChatMessage } from "./llm";

const lastUser = (messages: ChatMessage[]) =>
  [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

export function mockChat(messages: ChatMessage[]): string {
  const system = messages[0]?.content ?? "";
  if (system.includes("blameless postmortem")) {
    return [
      "## Summary",
      "Mock postmortem generated without a model.",
      "## Impact",
      "Unknown; measure error rate for the affected window.",
      "## Timeline",
      "- See the incident timeline.",
      "## Root cause",
      "Taken from the resolution note.",
      "## Resolution",
      "See the resolution note.",
      "## What helped",
      "- Fast triage.",
      "## What slowed us down",
      "- Nothing recorded.",
      "## Follow-ups",
      "- Service owner: add an alert for this signal.",
    ].join("\n");
  }
  return `(mock) I read: "${lastUser(messages).slice(0, 120)}". With a real model I would map this to the hypotheses above.`;
}

export function mockJson(kind: string, messages: ChatMessage[]): unknown {
  const text = lastUser(messages);
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "Incident";
  const errors = text.match(/[A-Za-z]*(?:Error|Exception|refused|timeout|OOMKilled|expired)[^\n]{0,60}/g) ?? [];
  if (kind === "signals") {
    return {
      title: firstLine.slice(0, 70),
      service: text.match(/service[=: ]+([\w-]+)/i)?.[1] ?? "unknown",
      symptom: firstLine.slice(0, 120),
      error_signatures: errors.slice(0, 3),
      components: [],
      severity_guess: "sev2",
      started_hint: "",
    };
  }
  if (kind === "hypotheses") {
    const related = [...text.matchAll(/id=([\w-]+)/g)].map((m) => m[1]).slice(0, 1);
    return {
      hypotheses: [
        {
          cause: "Recent change to the affected service",
          confidence: 0.5,
          evidence: errors.slice(0, 2),
          check: "kubectl rollout history deploy/<service>",
        },
      ],
      first_actions: ["Check the last deploy time against the alert start"],
      related_incident_ids: related,
      open_questions: ["When did the alert start?"],
    };
  }
  if (kind === "memory") {
    return {
      title: firstLine.slice(0, 70),
      signals: errors.join("; ") || firstLine,
      root_cause: "See postmortem",
      fix: "See postmortem",
      tags: ["mock"],
    };
  }
  throw new Error(`no mock for ${kind}`);
}

export function mockEmbed(text: string): number[] {
  const v = new Array(256).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % 256] += 1;
  }
  return v;
}
