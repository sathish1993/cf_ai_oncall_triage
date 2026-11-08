// Triage Room front end. Plain JS, no build step. Polls the incident's Durable Object
// snapshot while the workflow is moving, and stops polling once nothing is in flight.

const $ = (id) => document.getElementById(id);

const EXAMPLES = {
  "Checkout 503s": `[FIRING:1] HighErrorRate checkout-api (prod-us-east)
error_rate_5xx = 18.4% (threshold 2%) for 6m
deploy checkout-api v2026.11.08-3 finished 13:02 UTC

13:05:41 ERROR [http-nio-8080-exec-41] c.s.checkout.OrderController - order submit failed
java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms.
    at com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)
    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:197)
13:05:43 WARN  HikariPool-1 - Pool stats (total=20, active=20, idle=0, waiting=187)`,
  "DNS timeouts": `payments-worker-7d9f8c6b5-x2kqp  CrashLoopBackOff
kubectl logs payments-worker-7d9f8c6b5-x2kqp --previous
2026/11/08 14:11:02 charge failed: Post "https://api.processor.example/v2/charges": dial tcp: lookup api.processor.example on 10.96.0.10:53: read udp 10.244.3.17:41822->10.96.0.10:53: i/o timeout
2026/11/08 14:11:07 retrying (attempt 4/5)
kube-system/coredns-5d78c9869d-8gq2l  CPU throttled 92% over last 10m`,
  "Kafka lag": `[FIRING] ConsumerLagHigh group=invoice-builder topic=billing.events lag=1.2M and rising
consumer logs:
INFO  [Consumer clientId=invoice-builder-3] Request joining group due to: rebalance failed due to 'The coordinator is not aware of this member.'
WARN  [Consumer clientId=invoice-builder-3] consumer poll timeout has expired. This means the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms (300000)
INFO  Revoke previously assigned partitions billing.events-4, billing.events-5
Members joined/left 41 times in 15 minutes`,
};

const state = { id: null, snap: null, timer: null, pending: false, incidents: [] };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const md = (text) => DOMPurify.sanitize(marked.parse(text || "", { breaks: true }));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const STAGE_LABEL = {
  signals: "Signals",
  recall: "Memory",
  hypotheses: "Hypotheses",
  resolution: "Resolution",
  postmortem: "Postmortem",
  memory: "Remember",
};

// ---------- sidebar ----------
async function loadList() {
  const { incidents, memory } = await api("/incidents");
  state.incidents = incidents;
  $("memory-count").textContent = memory;
  const ul = $("incident-list");
  ul.innerHTML = "";
  const live = incidents;
  if (!live.length) ul.innerHTML = `<li class="empty">Nothing open. Quiet shift so far.</li>`;
  for (const i of live) {
    const li = document.createElement("li");
    if (i.id === state.id) li.className = "active";
    li.innerHTML = `<button><div class="t">${esc(i.title)}</div><div class="s">${i.severity ? `<span class="sev ${esc(i.severity)}">${esc(i.severity)}</span>` : ""}<span class="status ${esc(i.status)}">${esc(i.status)}</span><span>${ago(i.created_at)}</span></div></button>`;
    li.querySelector("button").onclick = () => openIncident(i.id);
    ul.appendChild(li);
  }
}

// ---------- intake ----------
function showIntake() {
  state.id = null;
  stopPolling();
  history.replaceState(null, "", "/");
  $("incident").hidden = true;
  $("intake").hidden = false;
  $("sidebar").classList.remove("open");
  $("report").focus();
  loadList().catch(() => {});
}

for (const [label, text] of Object.entries(EXAMPLES)) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = () => ($("report").value = text);
  $("examples").appendChild(b);
}

$("start").onclick = async () => {
  const report = $("report").value.trim();
  $("intake-error").textContent = "";
  if (!report) return ($("intake-error").textContent = "Paste something first.");
  $("start").disabled = true;
  try {
    const { id } = await api("/incidents", { method: "POST", body: { report } });
    $("report").value = "";
    await openIncident(id);
  } catch (e) {
    $("intake-error").textContent = e.message;
  } finally {
    $("start").disabled = false;
  }
};

$("new-incident").onclick = showIntake;
$("menu").onclick = () => $("sidebar").classList.toggle("open");

$("seed").onclick = async () => {
  $("seed").textContent = "Loading…";
  try {
    const { added } = await api("/memory/seed", { method: "POST" });
    $("seed").textContent = `Loaded ${added} past incidents`;
    await loadList();
  } catch (e) {
    $("seed").textContent = `Failed: ${e.message}`;
  }
};

// ---------- incident view ----------
async function openIncident(id) {
  state.id = id;
  state.snap = null;
  history.replaceState(null, "", `/?i=${encodeURIComponent(id)}`);
  $("intake").hidden = true;
  $("incident").hidden = false;
  $("resolve-form").hidden = true;
  $("sidebar").classList.remove("open");
  $("log").innerHTML = "";
  await refresh();
  loadList().catch(() => {});
}

async function refresh() {
  if (!state.id) return;
  const id = state.id;
  let snap;
  try {
    snap = await api(`/incidents/${id}`);
  } catch (e) {
    $("log").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  if (id !== state.id) return;
  const prev = state.snap;
  state.snap = snap;
  render(snap, prev);
  schedule(snap);
}

function inFlight(snap) {
  if (["failed", "stale"].includes(snap.meta.status)) return false;
  const busy = snap.stages.some((s) => s.status === "running" && s.name !== "resolution");
  const triaging = snap.stages.some((s) => s.status === "pending" && ["signals", "recall", "hypotheses"].includes(s.name));
  const finishing = snap.meta.status === "resolving" || (snap.meta.status === "resolved" && !snap.meta.postmortem) ||
    (snap.meta.status === "resolved" && snap.stages.find((s) => s.name === "memory")?.status !== "done");
  return busy || triaging || finishing;
}

function schedule(snap) {
  stopPolling();
  if (inFlight(snap)) state.timer = setTimeout(refresh, 1500);
}
function stopPolling() {
  clearTimeout(state.timer);
  state.timer = null;
}

function render(snap, prev) {
  const m = snap.meta;
  $("inc-title").textContent = m.title || "New incident";
  $("inc-sev").textContent = m.severity || "";
  $("inc-sev").className = `sev ${m.severity || ""}`;
  $("inc-sev").hidden = !m.severity;
  $("inc-status").textContent = m.status;
  $("inc-status").className = `status ${m.status}`;
  $("inc-id").textContent = m.id;
  $("resolve-open").disabled = !(m.triage && m.status === "investigating");

  $("stages").innerHTML = snap.stages
    .map((s) => `<li class="${s.status}" title="${esc(s.detail || "")}"><div class="n">${STAGE_LABEL[s.name]}</div><div class="d">${esc(s.detail || s.status)}</div></li>`)
    .join("");

  const lastSeq = prev && prev.meta.id === m.id ? prev.messages.at(-1)?.seq ?? 0 : -1;
  const newMsgs = lastSeq === -1 ? snap.messages : snap.messages.filter((x) => x.seq > lastSeq);
  if (lastSeq === -1) $("log").innerHTML = "";
  if (newMsgs.length) {
    document.querySelector(".thinking")?.remove();
    for (const msg of newMsgs) appendMessage(msg.role, msg.content, msg.seq === snap.messages[0]?.seq);
  }
  const triageDone = snap.stages.find((s) => s.name === "hypotheses")?.status === "done";
  const parked = ["failed", "stale"].includes(m.status);
  if (parked) document.querySelector(".thinking")?.remove();
  if (m.status === "failed" && !document.querySelector(".failed-note")) {
    const div = document.createElement("div");
    div.className = "msg assistant thinking failed-note";
    div.textContent = `Triage stopped: ${m.error || "a step failed"}. Start a new incident to retry.`;
    $("log").appendChild(div);
  }
  if (!triageDone && !parked && !document.querySelector(".thinking")) {
    thinking("Working through the triage steps…");
  }

  if (m.postmortem) {
    $("postmortem").hidden = false;
    $("postmortem-body").innerHTML = md(m.postmortem);
    if (!prev?.meta.postmortem) $("postmortem").open = true;
  } else {
    $("postmortem").hidden = true;
  }
}

function appendMessage(role, content, isReport = false) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "user") {
    div.innerHTML = `<div class="who">${isReport ? "Report" : "You"}</div><pre>${esc(content)}</pre>`;
  } else {
    div.innerHTML = `<div class="who">Triage</div><div class="md">${md(content)}</div>`;
  }
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
}

function thinking(text) {
  const div = document.createElement("div");
  div.className = "msg assistant thinking";
  div.textContent = text;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
}

// composer
const box = $("message");
box.addEventListener("input", () => {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 180)}px`;
});
box.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = box.value.trim();
  if (!text || state.pending || !state.id) return;
  state.pending = true;
  $("send").disabled = true;
  box.value = "";
  box.style.height = "auto";
  try {
    await api(`/incidents/${state.id}/messages`, { method: "POST", body: { text } });
  } catch (err) {
    thinking(`Couldn't send: ${err.message}`);
  } finally {
    state.pending = false;
    $("send").disabled = false;
    await refresh();
  }
};

// resolve
$("resolve-open").onclick = () => {
  $("resolve-form").hidden = false;
  $("resolve-note").focus();
};
$("resolve-cancel").onclick = () => ($("resolve-form").hidden = true);
$("resolve-form").onsubmit = async (e) => {
  e.preventDefault();
  const note = $("resolve-note").value.trim();
  if (!note) return $("resolve-note").focus();
  try {
    await api(`/incidents/${state.id}/resolve`, { method: "POST", body: { note } });
    $("resolve-note").value = "";
    $("resolve-form").hidden = true;
  } catch (err) {
    thinking(`Couldn't resolve: ${err.message}`);
  }
  await refresh();
  loadList().catch(() => {});
};

$("copy-pm").onclick = async (e) => {
  e.preventDefault();
  await navigator.clipboard.writeText(state.snap?.meta.postmortem || "");
  $("copy-pm").textContent = "Copied";
  setTimeout(() => ($("copy-pm").textContent = "Copy Markdown"), 1500);
};

// boot
const initial = new URLSearchParams(location.search).get("i");
if (initial) openIncident(initial);
else showIntake();
