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
