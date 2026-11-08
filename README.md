# cf_ai_oncall_triage

**Triage Room** is an on-call partner that runs entirely on Cloudflare. You paste whatever paged you (an alert, a stack trace, a few hundred lines of logs) and it:

1. pulls out the signals that matter (service, error strings, components, a severity guess),
2. checks them against incidents your team has already resolved,
3. gives you ranked root-cause hypotheses, each with the evidence behind it and a **read-only** check to confirm or rule it out,
4. stays in the incident with you as you paste new output and ask what to look at next,
5. and when you mark the incident resolved, writes a postmortem draft and files the incident into memory, so the next similar page starts with "we've seen this before, here's what fixed it."

I built a version of this at work for a Kubernetes platform, on a different stack. This one is the same idea rebuilt with Cloudflare's primitives, and it turned out to be a good fit: an incident has a long, mostly idle life, which is exactly what Workflows and Durable Objects are good at.

## Try it live

**https://cf-ai-oncall-triage.sathish-kumar-93.workers.dev/**

1. Click **Checkout 503s** under the paste box, then **Start triage**. Signals, memory recall and hypotheses take about 15 seconds.
2. Ask it something, or paste new "output" such as `DB shows 20 connections idle in transaction since the 13:02 deploy`.
3. Click **Resolve** and say what fixed it. The postmortem draft opens, and the incident goes into memory.
4. Paste a similar alert as a new incident. The **Memory** stage and the "Seen before" section should point back to the one you just resolved.
5. Try **Kafka lag** to see triage with nothing to match against.

The deployment is a shared demo with no login, so you'll see incidents other people created. Please don't paste real logs or secrets. If memory looks empty, **Load sample history** in the sidebar adds five made-up past incidents.

## How it maps to the assignment

| Requirement | What this app uses |
| --- | --- |
| LLM | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI, with JSON-schema output for the structured steps. `@cf/baai/bge-base-en-v1.5` for embeddings. |
| Workflow / coordination | A Cloudflare **Workflow** (`TriageWorkflow`) runs each incident as durable steps and then sleeps on `waitForEvent` until a human resolves it. |
| User input | A chat UI served as static assets from the same Worker (the Workers equivalent of Pages). |
| Memory / state | A **Durable Object per incident** (`IncidentRoom`, SQLite) holds the chat, timeline and triage. A single **ledger Durable Object** holds the incident index and long-term memory (memory cards plus embeddings). |

## Architecture

```
 browser (public/)                Worker (src/index.ts)
 ─────────────────                ──────────────────────
 paste report  ── POST /api/incidents ──►  create IncidentRoom DO, open ledger row,
                                           start TriageWorkflow instance
 poll snapshot ◄─ GET  /api/incidents/:id ─ IncidentRoom.snapshot()
 chat          ── POST .../messages ─────► IncidentRoom.reply()  ──► Llama 3.3
 resolve       ── POST .../resolve ──────► workflow.sendEvent("resolved")

 TriageWorkflow (src/workflow.ts), one instance per incident
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  ┌────────────┐  ┌──────────┐
 │ extract      │─►│ recall       │─►│ draft        │─►│ waitForEvent     │─►│ write      │─►│ remember │
 │ signals      │  │ (embed +     │  │ hypotheses   │  │ "resolved"       │  │ postmortem │  │ incident │
 │ Llama, JSON  │  │ ledger scan) │  │ Llama, JSON  │  │ up to 7 days     │  │ Llama      │  │ embed +  │
 └──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘  └────────────┘  │ ledger   │
        every step writes its progress into the IncidentRoom DO                               └──────────┘
```

### Why it's split this way

- **One Workflow instance per incident, not one request.** Triage is three model calls in a row, and resolution can be days later. Making each model call its own `step.do` means a Workers AI blip retries just that step (with exponential backoff), and a finished step is never re-run, so a retry can't post a duplicate triage message. While the workflow waits on `waitForEvent` it holds no compute at all.
- **A Durable Object per incident.** The workflow and the engineer both write to the incident at the same time (stage updates on one side, chat messages on the other). A single DO serialises those writes, so there's no read-modify-write race and no external lock. The UI reads one snapshot from one place.
- **Memory is a separate, single DO.** Recall needs to look across incidents, so it can't live in the per-incident objects. Today it's a brute-force cosine scan over SQLite rows, which is plenty for a few hundred incidents and keeps the deploy to one `wrangler deploy` with no index to provision. The obvious next step at scale is moving the vectors to Vectorize and keeping the ledger as the index; the `recall()` method is the only thing that would change.
- **Memory cards, not raw transcripts.** When an incident is resolved, Llama condenses it into a card written in terms of observable signals (error strings, components), and only that card is embedded. Matching a new page's signals against past signals works much better than matching against long chat logs full of people's names and timestamps.
- **Read-only by default.** The hypothesis prompt asks for one read-only check per hypothesis and makes the model tag anything that changes production with `[mutating]`. The assistant also can't run anything, and it's told never to pretend it did. On-call tooling that confidently suggests `kubectl delete` is worse than none.

The full lifecycle, every endpoint (with request and response examples) and the internal Workflow and Durable Object interfaces are documented in [docs/API.md](docs/API.md).

## Try it

You need Node 20+ and a Cloudflare account (the Workers free plan includes Workers AI, Workflows and SQLite-backed Durable Objects, which is enough for a demo).

```bash
npm install
npx wrangler login
npm run dev          # local Worker; Workers AI calls go to your account
```

Open http://localhost:8787, press **Load sample history** in the sidebar (it adds five made-up past incidents so recall has something to match), then pick the **Checkout 503s** example and press **Start triage**. That one should be matched to the past connection-pool incident. **Kafka lag** has no match in the sample history, so you can see what triage does without memory to lean on. Chat with it, then press **Resolve**, say what fixed it, and watch the postmortem and memory steps finish. If you start a new incident that looks like the one you just resolved, recall will find it.

### No Cloudflare account?

`npm run dev:mock` runs the same Worker, Workflow and Durable Objects locally with canned model responses (`src/mock-ai.ts`) and no AI binding. The answers are useless, but it lets you click through every stage, including the `waitForEvent` resume.

### Deploy

```bash
npx wrangler deploy
```

Wrangler creates the Durable Object classes and the Workflow from `wrangler.jsonc` on the first deploy. It prints the `*.workers.dev` URL when it's done.

To check a deployment end to end (seed memory, triage with and without a memory match, chat, resolve, postmortem, memory), run:

```bash
node scripts/smoke.mjs https://cf-ai-oncall-triage.<you>.workers.dev
```

## Repo layout

```
src/index.ts          HTTP API and static asset routing
src/workflow.ts       TriageWorkflow: the durable steps above
src/incident-room.ts  IncidentRoom Durable Object: chat, stages, triage, postmortem
src/ledger.ts         IncidentLedger Durable Object: incident index and long-term memory
src/prompts.ts        every system prompt and JSON schema the app sends to Llama
src/llm.ts            Workers AI calls (chat, JSON mode, embeddings) and cosine similarity
src/mock-ai.ts        canned responses for offline dev
src/samples.ts        sample incident history for the demo
scripts/smoke.mjs     end-to-end smoke test against a running deployment
public/               chat UI (plain HTML/CSS/JS, no build step)
PROMPTS.md            the AI-assisted coding prompts used to build this
docs/API.md           incident lifecycle, HTTP API with examples, internal interfaces
```

## Known limits

- No auth. Anyone with the URL shares one incident list. A real deployment would sit behind Cloudflare Access and key the ledger by team.
- The UI polls the incident snapshot every 1.5s while something is running, and stops when nothing is in flight. A WebSocket from the Durable Object would be nicer, but polling was simpler and was enough here.
- Chat replies aren't streamed.
- The model only sees what you paste. It has no access to your clusters or dashboards. Read-only tools (logs, metrics) behind an MCP server are the natural next step, and it's what the work version does.
