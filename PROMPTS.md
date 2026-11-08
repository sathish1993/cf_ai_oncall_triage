# Prompt history

This app was built with AI-assisted coding, using Claude (Claude Code), as the assignment allows. Below are the prompts I gave it, in order and verbatim, followed by notes on what each one produced and what I changed or decided along the way.

The prompts the *app itself* sends to Llama 3.3 at runtime are a separate thing. They live in [`src/prompts.ts`](src/prompts.ts).

---

## 1. Kickoff

> cloudflare application asks for
>
> We plan to fast track candidates who complete an assignment to build a type of [AI-powered application](https://agents.cloudflare.com/) on Cloudflare. An AI-powered application should include the following components:
>
> * LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> * Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> * User input via chat or voice (recommend using Pages or Realtime)
> * Memory or state
>
> Find additional documentation [here](https://developers.cloudflare.com/agents/).
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.

The assistant read my resume and proposed two ideas tied to work I've done:

1. an on-call triage agent (close to the AI on-call debugging agent I built at Oracle), and
2. a rollout copilot that walks a staged multi-region change through approval gates (close to my region-build automation work).

## 2. Choosing the idea

> lets do oncalll triage agent. https://github.com/sathish1993/cf_ai_oncall_triage

What came out of this, and the decisions behind it:

- **Workflow shape.** One Workflow instance per incident: `extract signals → recall → draft hypotheses → waitForEvent("resolved") → postmortem → remember`. Every model call is its own `step.do` with retries, so a flaky call doesn't re-run finished steps or post duplicate messages.
- **State.** A SQLite-backed Durable Object per incident (chat, stage timeline, triage, postmortem), plus one ledger Durable Object for the incident index and long-term memory. I kept embeddings in the ledger with a cosine scan instead of Vectorize, so the whole thing deploys with one `wrangler deploy`. The README covers when that should change.
- **Memory cards.** Resolved incidents are condensed into a signal-focused card before embedding, rather than embedding the raw chat.
- **Safety.** Hypotheses must come with read-only checks, and mutating actions are tagged `[mutating]`.
- **Offline mode.** Wrangler needs an account for the AI binding even in local dev, so a `wrangler.mock.jsonc` and `src/mock-ai.ts` let the full flow run with canned responses. This is how the flow was tested end to end (create → triage → chat → resolve → postmortem → memory) before deploying.
- **UI fixes found while testing.** The CDN-loaded Markdown libraries were vendored into `public/vendor/` so the app has no third-party runtime dependencies, and a horizontal overflow on phone widths was fixed.

## 3. Code review

> run a code-review skill on the opened PR

The review found ten issues. All of them were fixed:

- **Resolve was not guarded.** A double click, or a stale incident, could resolve it twice or get stuck in "resolving". Resolving is now an atomic claim on the Durable Object (`beginResolve`), and it's rolled back if the workflow can't be signalled.
- **A step that ran out of retries left the UI polling forever.** The workflow now catches that case, marks the running stage and the incident as `failed`, and the UI shows the failure and stops polling.
- **A retried hypotheses step could post the triage message twice.** It also opened a window where a resolve could be overwritten back to "investigating". Both are fixed by one idempotent `completeTriage` call that writes the triage, the message, the stages and the status together.
- **A failed workflow start left a zombie incident.** Creating an incident now marks it failed when the workflow can't be started.
- **Cleanup.** Requests for unknown ids are rejected from the ledger before any Durable Object is created. The poll endpoint no longer calls the Workflows status API, which the UI never read. Sample history is embedded in one batched call. Seeded rows are filtered out in SQL instead of in the browser.
- **Concurrent chat replies.** Two chat turns sent at once can be answered without seeing each other. I kept this behaviour and corrected the class comment, which claimed otherwise.

## 4. Understanding the layout

> ok explain me in simple tree structure, what folders we have and significance of those

The answer was a chat explanation only. No code changed.

## 5. Documentation

> document all the process and available api, its input and response with examples.

This added [`docs/API.md`](docs/API.md). It covers the incident lifecycle and status/stage model, every HTTP endpoint with curl examples, responses and error codes, and the Workflow steps and Durable Object methods. I captured the response shapes and error codes from a local run before writing it up.

## 6. Deploying and testing

> ok now what do you need for prod deploy? how do I test if everything works as expected?

> I deployed myself in cloudflare, check this out https://cf-ai-oncall-triage.sathish-kumar-93.workers.dev/
>
> test it our for me with basic examples

The assistant's sandbox could read the deployed page but couldn't send POST requests to it, so it wrote `scripts/smoke.mjs` instead. The script runs the basic examples against any deployment and prints a pass or fail for each check.

> it worked. I was able debug 503 error and resolve it

I confirmed the deployed app end to end against the real Llama 3.3: triage, chat, resolve and postmortem all worked on the Checkout 503s example.

> https://cf-ai-oncall-triage.sathish-kumar-93.workers.dev/?i=20261108-2f8d2705

The assistant reviewed this first real incident's data and found three problems in the model's behaviour. It tightened the prompts in `src/prompts.ts` to fix them:

- The chat assistant read a bare "200" as "error rate is now 0%". It now asks what an ambiguous reply means instead of inventing a metric.
- The chat assistant said it had "marked the incident resolved/closed", which it can't do. It now tells the engineer to press Resolve.
- The postmortem timeline used the tool's own timestamps (16:13Z) instead of the alert's times (13:02 deploy, 13:05 errors). It now takes production event times from the report and labels tool times as response times.
