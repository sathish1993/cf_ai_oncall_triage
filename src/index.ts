import { embedMany } from "./llm";
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
      try {
        await env.TRIAGE.create({ id: workflowId, params: { incidentId: id, report: text.slice(0, MAX_REPORT) } });
      } catch (err) {
        // Don't leave an incident that looks live but has no workflow behind it.
        await room.fail(`could not start triage: ${(err as Error).message}`);
        await ledger.update(id, { status: "failed" });
        throw err;
      }
      return json({ id }, 201);
    }
  }

  if (parts[1] === "incidents" && parts[2]) {
    const id = parts[2];
    if (!/^\d{8}-[0-9a-f]{8}$/.test(id)) return json({ error: "bad incident id" }, 400);
    // Check the ledger first so a request for a made-up id never instantiates a Durable Object.
    if (!(await ledger.has(id))) return json({ error: "no such incident" }, 404);
    const room = env.INCIDENT.get(env.INCIDENT.idFromName(id));

    if (parts.length === 3 && method === "GET") {
      return json(await room.snapshot());
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
      const claim = await room.beginResolve();
      if (claim !== "ok") return json({ error: `can't resolve an incident that is ${claim}` }, 409);
      try {
        const instance = await env.TRIAGE.get(`triage-${id}`);
        await instance.sendEvent({ type: "resolved", payload: { note: text.slice(0, MAX_MESSAGE) } });
      } catch (err) {
        await room.abortResolve();
        throw err;
      }
      await room.addMessage("user", `Resolved: ${text.slice(0, MAX_MESSAGE)}`);
      return json({ ok: true }, 202);
    }
  }

  if (parts[1] === "memory" && parts[2] === "seed" && method === "POST") {
    const vectors = await embedMany(env, SAMPLE_HISTORY.map((s) => `${s.title}\n${s.signals}`));
    await Promise.all(
      SAMPLE_HISTORY.map((s, i) => ledger.remember(s.id, s, vectors[i], Date.now() - s.daysAgo * 86_400_000)),
    );
    const added = SAMPLE_HISTORY.length;
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
