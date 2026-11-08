# Triage Room: process and API reference

This document covers three things:

1. [The incident lifecycle](#1-the-incident-lifecycle): what happens, step by step, from paste to postmortem.
2. [The HTTP API](#2-http-api): every endpoint the UI calls, with request, response and error examples.
3. [Internal interfaces](#3-internal-interfaces): the Workflow steps and the Durable Object methods the API and the Workflow use.

All examples use `http://localhost:8787` (`npm run dev`). For a deployed Worker, swap in your `*.workers.dev` URL.

---

## 1. The incident lifecycle

```
 engineer                 Worker API              IncidentRoom DO        TriageWorkflow           IncidentLedger DO
 ────────                 ──────────              ───────────────        ──────────────           ─────────────────
 paste report ──POST /api/incidents──► init room ───────────►│
                                       open ledger row ─────────────────────────────────────────────►│
                                       create workflow ──────────────────────►│
                          ◄── 201 {id}                                         │
                                                                               │ 1. extract signals (Llama, JSON)
                                                              ◄── signals, title, severity ──────────┤──► update title/severity
                                                                               │ 2. recall (embed + cosine scan)
                                                                               │◄──────────── top 3 past incidents
                                                                               │ 3. draft hypotheses (Llama, JSON)
                                                              ◄── completeTriage (message + status "investigating")
 poll GET /api/incidents/:id ──────────► snapshot()                             │
 chat POST .../messages ───────────────► reply() ──► Llama                      │ 4. waitForEvent("resolved")
                                                                               │    (sleeps up to 7 days, no compute)
 resolve POST .../resolve ─────────────► beginResolve() ── sendEvent ─────────►│
                                                                               │ 5. record resolution
                                                                               │ 6. write postmortem (Llama)
                                                              ◄── postmortem ──┤
                                                                               │ 7. remember (Llama card + embed) ──►│ remember()
```

### Incident status

`meta.status` on the incident, which is mirrored as `status` in the incident list:

| Status | Meaning | Set by |
| --- | --- | --- |
| `triaging` | Incident created. Workflow steps 1 to 3 are running. | `POST /api/incidents` |
| `investigating` | Triage posted. Waiting for an engineer to resolve. Chat is open. | Workflow step 3 |
| `resolving` | Resolve accepted. Postmortem and memory steps are running. | `POST /api/incidents/:id/resolve` |
| `resolved` | Postmortem written. The incident is in memory once the `memory` stage is `done`. | Workflow step 5 |
| `stale` | Nobody resolved it within 7 days. The workflow ended. | Workflow timeout |
| `failed` | A step failed on every retry, or the workflow could not start. `meta.error` says why. | Workflow error handler, or the create endpoint |

Only an incident in `investigating` can be resolved. Every other status returns `409`.

### Stages

Each incident has six stages. The UI shows them as a progress bar. Every stage has a `status` (`pending`, `running`, `done`, `failed` or `skipped`) and a short `detail` string.

| Stage | Workflow step | What `detail` shows when done |
| --- | --- | --- |
| `signals` | extract signals | `sev2 · checkout-api · 5xx after deploy` |
| `recall` | recall similar incidents | matches with similarity ≥ 0.65, or `no close match in memory` |
| `hypotheses` | draft hypotheses | the top-ranked cause |
| `resolution` | wait for resolution | `running` while it waits, then the engineer's resolution note |
| `postmortem` | write postmortem | `draft ready` |
| `memory` | remember incident | `saved as "<memory card title>"` |

### Retries and failure

Every model call is its own Workflow step, with 3 retries, exponential backoff starting at 5 s, and a 2-minute timeout. A finished step is never re-run. The writes inside each step are idempotent, so a retry can't post a duplicate message. If a step fails every retry, the workflow marks the running stage `failed`, sets the incident to `failed`, and stops. The UI then shows the error and stops polling.

---

## 2. HTTP API

- All requests and responses are JSON (`content-type: application/json`).
- Every response sets `cache-control: no-store`.
- Every error has the same shape: `{ "error": "<human-readable message>" }`.
- Any path that doesn't start with `/api/` serves the UI from `public/`.
- There is no authentication (see "Known limits" in the README).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/incidents` | List incidents, plus the memory size |
| `POST` | `/api/incidents` | Open an incident and start triage |
| `GET` | `/api/incidents/:id` | Full incident snapshot (polled by the UI) |
| `POST` | `/api/incidents/:id/messages` | Chat about the incident |
| `POST` | `/api/incidents/:id/resolve` | Resolve, which triggers the postmortem and memory steps |
| `POST` | `/api/memory/seed` | Load the 5 sample past incidents (demo helper) |

Incident ids look like `20261108-38f647cd`: the UTC date plus 8 hex characters. Any other format returns `400`.

---

### `GET /api/incidents`

Lists the 100 most recent incidents, newest first. The sample-history rows are left out. `memory` is the number of resolved incidents available for recall, and it does include the samples.

```bash
curl http://localhost:8787/api/incidents
```

**200**

```json
{
  "incidents": [
    {
      "id": "20261108-38f647cd",
      "title": "Checkout API 5xx from DB connection pool timeouts after deploy",
      "status": "investigating",
      "severity": "sev2",
      "created_at": 1794145271002,
      "resolved_at": null,
      "in_memory": false
    },
    {
      "id": "20261108-a745a929",
      "title": "invoice-builder consumer group stuck in rebalance loop",
      "status": "resolved",
      "severity": "sev2",
      "created_at": 1794141100000,
      "resolved_at": 1794143900000,
      "in_memory": true
    }
  ],
  "memory": 6
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | incident id |
| `title` | string | first line of the report until the signals step sets a proper title |
| `status` | string | see [Incident status](#incident-status) |
| `severity` | `sev1`…`sev4` or `null` | `null` until the signals step finishes |
| `created_at`, `resolved_at` | epoch ms or `null` | |
| `in_memory` | boolean | whether this incident is in memory and can be recalled |

---

### `POST /api/incidents`

Opens an incident. This creates its Durable Object, adds it to the ledger, and starts a `TriageWorkflow` instance. The call returns as soon as triage has started. Poll the snapshot to watch progress.

**Request**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `report` | string | yes | Alert, stack trace or logs. Trimmed and capped at 12,000 characters. |

```bash
curl -X POST http://localhost:8787/api/incidents \
  -H 'content-type: application/json' \
  -d '{"report":"[FIRING] HighErrorRate checkout-api 18% 5xx\njava.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms."}'
```

**201**

```json
{ "id": "20261108-38f647cd" }
```

**Errors**

| Code | Body | When |
| --- | --- | --- |
| 400 | `{"error":"Paste an alert, error or log excerpt first."}` | `report` is missing or blank |
| 500 | `{"error":"<reason>"}` | The workflow could not start. The incident is still created, but marked `failed`. |

---

### `GET /api/incidents/:id`

Returns everything about one incident: its metadata, the stage progress and the full chat. While anything is in flight, the UI polls this every 1.5 s.

```bash
curl http://localhost:8787/api/incidents/20261108-38f647cd
```

**200**, shown while the incident is waiting for resolution:

```json
{
  "meta": {
    "id": "20261108-38f647cd",
    "workflowId": "triage-20261108-38f647cd",
    "created_at": 1794145271000,
    "status": "investigating",
    "title": "Checkout API 5xx from DB connection pool timeouts after deploy",
    "severity": "sev2",
    "signals": {
      "title": "Checkout API 5xx from DB connection pool timeouts after deploy",
      "service": "checkout-api",
      "symptom": "18% of requests return 5xx since 13:05 UTC",
      "error_signatures": [
        "SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms"
      ],
      "components": ["HikariCP", "database"],
      "severity_guess": "sev2",
      "started_hint": "minutes after deploy v2026.11.08-3 at 13:02 UTC"
    },
    "triage": {
      "hypotheses": [
        {
          "cause": "New release leaks DB connections, exhausting the pool",
          "confidence": 0.8,
          "evidence": [
            "Pool stats show active=20, idle=0, waiting=187",
            "Errors began 3 minutes after the deploy finished",
            "Matches past incident hist-pool-exhaustion (similarity 0.86)"
          ],
          "check": "kubectl rollout history deploy/checkout-api -n prod"
        }
      ],
      "first_actions": ["[mutating] Roll back checkout-api to the previous release"],
      "related_incident_ids": ["hist-pool-exhaustion"],
      "open_questions": ["Did DB-side connection count also spike?"]
    },
    "related": [
      {
        "id": "hist-pool-exhaustion",
        "title": "Checkout API 5xx after deploy, DB connection pool exhausted",
        "root_cause": "New release opened a transaction per request in a retry loop and never released connections on timeout",
        "fix": "Rolled back checkout-api, then capped pool wait at 2s and fixed the leaked transaction",
        "similarity": 0.86
      }
    ]
  },
  "stages": [
    { "name": "signals",    "status": "done",    "detail": "sev2 · checkout-api · 18% of requests return 5xx since 13:05 UTC", "at": 1794145273000 },
    { "name": "recall",     "status": "done",    "detail": "Checkout API 5xx after deploy, DB connection pool exhausted (0.86)", "at": 1794145273400 },
    { "name": "hypotheses", "status": "done",    "detail": "New release leaks DB connections, exhausting the pool", "at": 1794145279000 },
    { "name": "resolution", "status": "running", "detail": "waiting for an engineer to resolve", "at": 1794145279000 },
    { "name": "postmortem", "status": "pending", "detail": null, "at": null },
    { "name": "memory",     "status": "pending", "detail": null, "at": null }
  ],
  "messages": [
    { "seq": 1, "role": "user",      "content": "[FIRING] HighErrorRate checkout-api 18% 5xx ...", "at": 1794145271000 },
    { "seq": 2, "role": "assistant", "content": "**Checkout API 5xx from DB connection pool timeouts after deploy** · sev2 · ...", "at": 1794145279000 }
  ]
}
```

`meta` fills in over time. These fields appear as the workflow progresses:

| Field | Appears after |
| --- | --- |
| `id`, `workflowId`, `created_at`, `status` | creation |
| `signals`, `title`, `severity` | `signals` stage |
| `triage`, `related` | `hypotheses` stage |
| `resolution` | resolve |
| `postmortem` (Markdown string) | `postmortem` stage |
| `error` | only when `status` is `failed` |

Message `role` is `user` or `assistant`. The first message is always the original report. `seq` only ever goes up, and the UI uses it to append only new messages.

**Errors**

| Code | Body | When |
| --- | --- | --- |
| 400 | `{"error":"bad incident id"}` | The id is not in the `YYYYMMDD-xxxxxxxx` format |
| 404 | `{"error":"no such incident"}` | The id is not in the ledger |

---

### `POST /api/incidents/:id/messages`

Sends one chat turn. The reply is grounded in this incident's original report, its signals, its triage and up to the last 16 messages. The assistant is told it cannot run commands, and never to claim it did. You can chat at any time, including while triage is still running.

**Request**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | Trimmed and capped at 4,000 characters |

```bash
curl -X POST http://localhost:8787/api/incidents/20261108-38f647cd/messages \
  -H 'content-type: application/json' \
  -d '{"text":"rollout history shows v2026.11.08-3 went out at 13:02. DB shows 20 connections held idle in transaction."}'
```

**200**

```json
{
  "reply": "That supports hypothesis 1. Connections held 'idle in transaction' right after the deploy point to the new release not committing or rolling back on its timeout path. Rolling back is the fastest fix. [mutating] kubectl rollout undo deploy/checkout-api -n prod"
}
```

The user message and the reply are both stored, so they also show up in the next snapshot. If the model call fails, `reply` holds a short "couldn't reach the model" note and the status is still 200, so the chat never breaks.

**Errors**

| Code | Body | When |
| --- | --- | --- |
| 400 | `{"error":"empty message"}` | `text` is missing or blank |
| 400 / 404 | as for `GET /api/incidents/:id` | bad id, or unknown id |

---

### `POST /api/incidents/:id/resolve`

Resolves the incident. This sends the `resolved` event to the waiting workflow, which then writes the postmortem and saves the incident to memory. The response is `202` because that work happens afterwards. Poll the snapshot until the `memory` stage is `done`.

**Request**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `note` | string | yes | What actually fixed it. It goes into the postmortem and the memory card. Capped at 4,000 characters. |

```bash
curl -X POST http://localhost:8787/api/incidents/20261108-38f647cd/resolve \
  -H 'content-type: application/json' \
  -d '{"note":"Rolled back to v2026.11.08-2. New retry path never closed its transaction on timeout."}'
```

**202**

```json
{ "ok": true }
```

**Errors**

| Code | Body | When |
| --- | --- | --- |
| 400 | `{"error":"Say what fixed it, so it can be remembered."}` | `note` is missing or blank |
| 409 | `{"error":"can't resolve an incident that is triaging"}` | Triage hasn't finished yet |
| 409 | `{"error":"can't resolve an incident that is resolving"}` | Already being resolved (double click, or a second engineer) |
| 409 | `{"error":"can't resolve an incident that is resolved"}` | Already resolved |
| 409 | `{"error":"can't resolve an incident that is stale"}` / `failed` | The workflow is no longer waiting |
| 500 | `{"error":"<reason>"}` | The workflow could not be signalled. The incident goes back to `investigating`, so you can retry. |

Resolving is an atomic claim on the incident's Durable Object. If two requests race, exactly one gets `202`.

---

### `POST /api/memory/seed`

A demo helper. It loads the five sample past incidents from `src/samples.ts` into memory, embedding them all in one batched call. You can run it more than once, because each sample has a fixed id and is overwritten in place.

```bash
curl -X POST http://localhost:8787/api/memory/seed
```

**200**

```json
{ "added": 5 }
```

---

### Anything else under `/api/`

**404** `{"error":"not found"}`

---

## 3. Internal interfaces

You don't call these over HTTP. They're how the Worker, the Workflow and the two Durable Objects talk to each other, via RPC on Durable Object stubs. They're documented here because this is where the design decisions live.

### TriageWorkflow (`src/workflow.ts`)

- **Instance id:** `triage-<incidentId>`
- **Params:** `{ incidentId: string, report: string }`

| # | Step name | Calls | Writes |
| --- | --- | --- | --- |
| 1 | `extract signals` | Llama 3.3, JSON schema `SIGNALS_SCHEMA` | room: `signals`, `title`, `severity`. ledger: title, severity |
| 2 | `recall similar incidents` | bge-base embedding, then `ledger.recall(vector, 3)` | room: `recall` stage detail |
| 3 | `draft hypotheses` | Llama 3.3, JSON schema `HYPOTHESES_SCHEMA` | `room.completeTriage(...)` (one atomic write). ledger: status |
| 4 | `wait for resolution` | `step.waitForEvent({ type: "resolved", timeout: "7 days" })` | (none) |
| 4b | `mark stale` | runs only on timeout | room and ledger: `stale` |
| 5 | `record resolution` | (no model call) | room: `resolution`, status `resolved`. ledger: status |
| 6 | `write postmortem` | Llama 3.3, Markdown, using `room.transcript()` | room: `postmortem` |
| 7 | `remember incident` | Llama 3.3, JSON schema `MEMORY_SCHEMA`, then embed the card | `ledger.remember(id, card, vector)` |
| on error | `mark failed` | (no model call) | `room.fail(reason)`. ledger: `failed` |

**Event payload** (sent by the resolve endpoint): `{ type: "resolved", payload: { note: string } }`

**Return value:** `{ incidentId, outcome: "resolved" | "stale" }`

### IncidentRoom Durable Object (`src/incident-room.ts`)

There is one per incident, addressed by `idFromName(incidentId)`. Storage is SQLite, with three tables: `messages`, `stages` and `meta` (key/value JSON).

| Method | Used by | What it does |
| --- | --- | --- |
| `init(id, report, workflowId)` | create endpoint | Creates the meta, the six pending stages and the first message. Does nothing if it already exists. |
| `snapshot()` | GET endpoint | `{ meta, stages, messages }` |
| `reply(text)` | messages endpoint | Stores the user turn, calls Llama with the incident context, stores and returns the answer |
| `addMessage(role, content)` | workflow, resolve | Appends a chat message and returns its `seq` |
| `setStage(name, status, detail?)` | workflow | Updates one stage |
| `setMeta(fields)` / `getMeta(key)` / `getTriage()` | workflow | Key/value incident data |
| `completeTriage(triage, related, message, topCause)` | workflow step 3 | Atomic and idempotent. Stores the triage, posts the message, advances the stages and sets `investigating`. Returns `false` if it was already done. |
| `beginResolve()` | resolve endpoint | Atomic claim. Returns `"ok"` and sets `resolving` only when the status is `investigating`. Otherwise returns the current status. |
| `abortResolve()` | resolve endpoint | Goes back to `investigating` if `sendEvent` failed |
| `fail(reason)` | workflow, create endpoint | Marks running stages `failed` and the incident `failed` |
| `transcript()` | workflow step 6 | Plain-text timeline and conversation, used as postmortem context |

### IncidentLedger Durable Object (`src/ledger.ts`)

There is a single instance, `idFromName("global")`. One SQLite table, `incidents`, serves as both the index and the memory.

| Method | What it does |
| --- | --- |
| `open(id, title)` | Adds a `triaging` row |
| `has(id)` | Checks that the incident exists. The API calls this before touching any incident DO. |
| `update(id, {title?, status?, severity?})` | Partial update |
| `remember(id, card, embedding, resolvedAt?)` | Stores the memory card and its embedding, and marks the row resolved |
| `recall(vector, k, excludeId?)` | Cosine similarity against every remembered incident. Returns the top `k` as `{id, title, root_cause, fix, similarity}`. |
| `list()` | The 100 newest non-sample incidents |
| `memoryCount()` | Number of incidents with an embedding |

### Models and prompts

| Use | Model | Prompt (in `src/prompts.ts`) |
| --- | --- | --- |
| Signal extraction | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON mode, temperature 0.1 | `SIGNALS_PROMPT` + `SIGNALS_SCHEMA` |
| Hypotheses | same | `HYPOTHESES_PROMPT` + `HYPOTHESES_SCHEMA` |
| Chat | same, temperature 0.3 | `CHAT_PROMPT` + incident context |
| Postmortem | same | `POSTMORTEM_PROMPT` |
| Memory card | same, JSON mode | `MEMORY_PROMPT` + `MEMORY_SCHEMA` |
| Embeddings | `@cf/baai/bge-base-en-v1.5` (768 dims) | (none) |

When JSON mode returns a string instead of an object, `parseJsonLoose` strips any code fences and parses the outermost `{...}`. If that also fails, the step throws and Workflows retries it.
