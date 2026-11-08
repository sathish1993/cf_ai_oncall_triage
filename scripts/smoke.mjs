// End-to-end smoke test against a running Triage Room.
// Usage: node scripts/smoke.mjs https://cf-ai-oncall-triage.<you>.workers.dev
// Needs Node 18+ (built-in fetch). Creates real incidents and calls Workers AI.

const BASE = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
let failures = 0;

const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const check = (cond, msg, detail = "") => (cond ? ok(msg) : bad(detail ? `${msg} (${detail})` : msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(id, label, done, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await api(`/incidents/${id}`);
    if (data.meta?.status === "failed") {
      bad(`${label}: incident failed: ${data.meta.error}`);
      return data;
    }
    if (done(data)) {
      ok(`${label} in ${Math.round((Date.now() - start) / 1000)}s`);
      return data;
    }
    await sleep(2000);
  }
  bad(`${label}: timed out after ${timeoutMs / 1000}s`);
  return (await api(`/incidents/${id}`)).data;
}

const stage = (snap, name) => snap.stages?.find((s) => s.name === name) ?? {};

const CHECKOUT = `[FIRING:1] HighErrorRate checkout-api (prod-us-east)
error_rate_5xx = 18.4% (threshold 2%) for 6m
deploy checkout-api v2026.11.08-3 finished 13:02 UTC
java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms.
HikariPool-1 - Pool stats (total=20, active=20, idle=0, waiting=187)`;

const KAFKA = `[FIRING] ConsumerLagHigh group=invoice-builder topic=billing.events lag=1.2M and rising
WARN consumer poll timeout has expired. The time between subsequent calls to poll() was longer than max.poll.interval.ms (300000)
INFO Request joining group due to: rebalance failed. Members joined/left 41 times in 15 minutes`;

console.log(`Testing ${BASE}\n`);

console.log("1. Basics");
{
  const r = await api("/incidents");
  check(r.status === 200 && Array.isArray(r.data.incidents), "GET /api/incidents returns a list");
  const s = await api("/memory/seed", {});
  check(s.status === 200 && s.data.added === 5, "sample history loaded", JSON.stringify(s.data));
  const e = await api("/incidents", { report: "  " });
  check(e.status === 400, "blank report rejected with 400");
  const n = await api("/incidents/20200101-deadbeef");
  check(n.status === 404, "unknown incident returns 404");
}

console.log("\n2. Triage with a match in memory (Checkout 503s)");
const created = await api("/incidents", { report: CHECKOUT });
check(created.status === 201 && created.data.id, "incident created", JSON.stringify(created.data));
const id = created.data.id;
let snap = await waitFor(id, "triage finished", (d) => d.meta?.status === "investigating");
check(!!snap.meta?.signals?.title, `signals extracted: "${snap.meta?.signals?.title}" ${snap.meta?.severity}`);
check((snap.meta?.triage?.hypotheses ?? []).length > 0, `hypotheses: ${snap.meta?.triage?.hypotheses?.[0]?.cause}`);
check(/pool/i.test(stage(snap, "recall").detail || ""), `recall found the pool incident: ${stage(snap, "recall").detail}`);
check(
  (snap.meta?.related ?? []).some((r) => r.id === "hist-pool-exhaustion"),
  "triage cites the past pool-exhaustion incident",
  "model chose not to cite it; check the triage message",
);
check(snap.messages?.some((m) => m.role === "assistant"), "triage message posted to chat");

console.log("\n3. Chat");
{
  const t0 = Date.now();
  const r = await api(`/incidents/${id}/messages`, {
    text: "Rollout history shows v2026.11.08-3 at 13:02. DB shows 20 connections idle in transaction. What next?",
  });
  check(r.status === 200 && r.data.reply?.length > 20 && !/couldn't reach the model/.test(r.data.reply), `reply in ${Date.now() - t0}ms`);
  console.log(`    "${(r.data.reply || "").slice(0, 220).replace(/\n/g, " ")}…"`);
}

console.log("\n4. Resolve, postmortem, memory");
{
  const r = await api(`/incidents/${id}/resolve`, {
    note: "Rolled back to v2026.11.08-2. The new retry path never closed its transaction on timeout.",
  });
  check(r.status === 202, "resolve accepted (202)");
  const again = await api(`/incidents/${id}/resolve`, { note: "again" });
  check(again.status === 409, "second resolve rejected (409)");
  snap = await waitFor(id, "postmortem and memory done", (d) => stage(d, "memory").status === "done");
  check((snap.meta?.postmortem || "").includes("## "), `postmortem written (${(snap.meta?.postmortem || "").length} chars)`);
  check(/saved as/.test(stage(snap, "memory").detail || ""), `memory: ${stage(snap, "memory").detail}`);
}

console.log("\n5. Triage with no match (Kafka lag)");
{
  const c = await api("/incidents", { report: KAFKA });
  const s = await waitFor(c.data.id, "triage finished", (d) => d.meta?.status === "investigating");
  check((s.meta?.triage?.hypotheses ?? []).length > 0, `hypotheses: ${s.meta?.triage?.hypotheses?.[0]?.cause}`);
  console.log(`    recall: ${stage(s, "recall").detail}`);
}

console.log(`\n${failures ? `${failures} check(s) failed` : "All checks passed"}. Open ${BASE}/?i=${id} to see the first incident in the UI.`);
process.exit(failures ? 1 : 0);
