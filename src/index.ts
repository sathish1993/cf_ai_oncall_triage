import { embed } from "./llm";
import { SAMPLE_HISTORY } from "./samples";
import type { Env } from "./types";

export { IncidentRoom } from "./incident-room";
export { IncidentLedger } from "./ledger";
export { TriageWorkflow } from "./workflow";

const MAX_REPORT = 12_000;
const MAX_MESSAGE = 4_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error("api error", url.pathname, err);
      return json({ error: (err as Error).message ?? "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const ledger = env.LEDGER.get(env.LEDGER.idFromName("global"));
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "incidents", ":id", "messages"]
  const method = request.method;

  if (parts[1] === "incidents" && parts.length === 2) {
    if (method === "GET") {
      return json({ incidents: await ledger.list(), memory: await ledger.memoryCount() });
    }
    if (method === "POST") {
      const { report } = await body<{ report?: string }>(request);
      const text = (report ?? "").trim();
      if (!text) return json({ error: "Paste an alert, error or log excerpt first." }, 400);
      const id = newId();
      const workflowId = `triage-${id}`;
      const room = env.INCIDENT.get(env.INCIDENT.idFromName(id));
      await room.init(id, text.slice(0, MAX_REPORT), workflowId);
      await ledger.open(id, provisionalTitle(text));
      await env.TRIAGE.create({ id: workflowId, params: { incidentId: id, report: text.slice(0, MAX_REPORT) } });
      return json({ id }, 201);
    }
  }

  if (parts[1] === "incidents" && parts[2]) {
    const id = parts[2];
    if (!/^[a-z0-9-]{6,40}$/.test(id)) return json({ error: "bad incident id" }, 400);
    const room = env.INCIDENT.get(env.INCIDENT.idFromName(id));
    const snap = await room.snapshot();
    if (!snap.meta.id) return json({ error: "no such incident" }, 404);

    if (parts.length === 3 && method === "GET") {
      let workflow = "unknown";
      try {
        workflow = (await (await env.TRIAGE.get(String(snap.meta.workflowId))).status()).status;
      } catch {
        /* status is best effort; the room's stages are the source of truth for the UI */
      }
      return json({ ...snap, workflow });
    }

    if (parts[3] === "messages" && method === "POST") {
      const { text } = await body<{ text?: string }>(request);
      const msg = (text ?? "").trim();
      if (!msg) return json({ error: "empty message" }, 400);
      const reply = await room.reply(msg.slice(0, MAX_MESSAGE));
      return json({ reply });
    }

    if (parts[3] === "resolve" && method === "POST") {
      const { note } = await body<{ note?: string }>(request);
      const text = (note ?? "").trim();
      if (!text) return json({ error: "Say what fixed it, so it can be remembered." }, 400);
      if (snap.meta.status === "resolved") return json({ error: "already resolved" }, 409);
      if (!snap.meta.triage) return json({ error: "triage is still running" }, 409);
      await room.addMessage("user", `Resolved: ${text.slice(0, MAX_MESSAGE)}`);
      await room.setMeta({ status: "resolving" });
      const instance = await env.TRIAGE.get(String(snap.meta.workflowId));
      await instance.sendEvent({ type: "resolved", payload: { note: text.slice(0, MAX_MESSAGE) } });
      return json({ ok: true }, 202);
    }
  }

  if (parts[1] === "memory" && parts[2] === "seed" && method === "POST") {
    let added = 0;
    for (const s of SAMPLE_HISTORY) {
      const vector = await embed(env, `${s.title}\n${s.signals}`);
      await ledger.remember(s.id, s, vector, Date.now() - s.daysAgo * 86_400_000);
      added++;
    }
    return json({ added });
  }

  return json({ error: "not found" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function newId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${day}-${crypto.randomUUID().slice(0, 8)}`;
}

function provisionalTitle(report: string): string {
  const line = report.split("\n").find((l) => l.trim()) ?? "New incident";
  return line.trim().slice(0, 70);
}
