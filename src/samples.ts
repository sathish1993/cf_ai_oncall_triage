import type { MemoryCard } from "./types";

// A small, made-up incident history so recall has something to match on a fresh deploy.
// Loaded only when someone presses "Load sample history" in the UI.
export const SAMPLE_HISTORY: (MemoryCard & { id: string; daysAgo: number })[] = [
  {
    id: "hist-pool-exhaustion",
    daysAgo: 6,
    title: "Checkout API 5xx after deploy, DB connection pool exhausted",
    signals:
      "HikariPool-1 - Connection is not available, request timed out after 30000ms; p99 latency 30s; 503 from checkout-api; started minutes after rollout",
    root_cause: "New release opened a transaction per request in a retry loop and never released connections on timeout",
    fix: "Rolled back checkout-api, then capped pool wait at 2s and fixed the leaked transaction",
    tags: ["database", "deploy", "connection-pool"],
  },
  {
    id: "hist-ndots-dns",
    daysAgo: 21,
    title: "Intermittent DNS timeouts from pods calling external APIs",
    signals:
      "dial tcp: lookup api.partner.example on 10.96.0.10:53: i/o timeout; CoreDNS CPU throttled; spikes during traffic peaks",
    root_cause: "ndots:5 default made every external lookup try five search domains first, overloading CoreDNS",
    fix: "Set ndots:2 in pod dnsConfig, used FQDNs with trailing dot, and scaled CoreDNS replicas",
    tags: ["kubernetes", "dns", "coredns"],
  },
  {
    id: "hist-sidecar-oom",
    daysAgo: 34,
    title: "Pods restarting with OOMKilled, proxy sidecar memory growth",
    signals:
      "Last State: Terminated Reason: OOMKilled container linkerd-proxy; memory climbs steadily under long-lived connections; restarts every ~40 minutes",
    root_cause: "Proxy sidecar memory limit sized for short requests; long-lived streaming connections held buffers",
    fix: "Raised proxy memory limit to 256Mi and set an idle timeout on the streaming endpoint",
    tags: ["kubernetes", "service-mesh", "oom"],
  },
  {
    id: "hist-cert-expiry",
    daysAgo: 58,
    title: "Partner webhooks failing TLS handshake, expired intermediate cert",
    signals:
      "x509: certificate has expired or is not yet valid; SSL handshake failed; only outbound calls to one partner; started at 00:00 UTC",
    root_cause: "Cert bundle in the base image pinned an intermediate that expired; renewal job only covered leaf certs",
    fix: "Rebuilt image with updated CA bundle; added expiry alerting for the whole chain at 21 days",
    tags: ["tls", "certificates"],
  },
  {
    id: "hist-disk-pressure",
    daysAgo: 90,
    title: "Node evictions under DiskPressure from runaway debug logging",
    signals:
      "The node was low on resource: ephemeral-storage; Evicted pods across one node pool; kubelet DiskPressure=True",
    root_cause: "A config flag left DEBUG logging on in production, filling node disk with container logs",
    fix: "Reverted log level, added log rotation limits and an alert on node ephemeral-storage at 80%",
    tags: ["kubernetes", "logging", "disk"],
  },
];
