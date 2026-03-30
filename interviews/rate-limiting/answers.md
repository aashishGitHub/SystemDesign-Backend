# Answers: Rate Limiting

> Keyed to [questions.md](./questions.md). Read questions first.
> Each answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Fundamentals & API Contracts

### A1. Why rate limiting exists

Rate limiting protects shared capacity from abuse, accidental spikes, and noisy neighbors. Auth only tells you *who* sent the request; it does not prevent one valid token from saturating your infrastructure.

| Concern | Without Limiter | With Limiter |
|---|---|---|
| Abuse bot using valid API key | Saturates DB/queue | Capped at policy rate |
| Buggy client retry loop | Cascading traffic storms | Requests bounded |
| Free-tier tenant vs paid tenant fairness | No isolation | Enforced per-plan limits |

---

### A2. Rate limiting vs throttling vs quota

| Term | Definition | Typical Window |
|---|---|---|
| Rate limiting | Enforce max request rate over short intervals | per second/minute |
| Throttling | Actively slow or shape traffic (delay/drop) | continuous |
| Quota | Total allowance over larger period | per day/month |

In interviews: rate limiting is usually real-time request admission; quota is billing/commercial allowance.

---

### A3. What keys to limit

| Key | Best Use | Weakness |
|---|---|---|
| IP | First-layer abuse control at edge | NAT/shared proxies cause false positives |
| API key/token | Developer-level limits | Token leakage risks |
| user_id | End-user fairness | Missing for anonymous traffic |
| tenant_id | Multi-tenant isolation | One bad user can consume tenant pool |
| endpoint | Protect expensive routes | Needs composition with identity key |

Best practice: compose multiple limits, e.g. `tenant + endpoint` and `user + endpoint`.

---

### A4. 429 contract and headers

Use `429 Too Many Requests` to make client behavior deterministic (backoff/retry later). Include remaining/reset hints.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 12
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 1711701120

{"error":"rate_limited","policy":"user:read-api:100/min"}
```

---

## Level 2 — Algorithm Selection

### A5. Token bucket vs leaky bucket behavior

| Algorithm | Burst Handling | Output Shape | Typical Use |
|---|---|---|---|
| Token bucket | Allows burst until bucket empty | Spiky but bounded | Public APIs, user-facing traffic |
| Leaky bucket | Smooths to constant drain rate | Near-constant | Downstream protection, egress shaping |

Token bucket is usually preferred for API UX because legitimate short bursts pass.

---

### A6. Fixed-window boundary unfairness

A client can send full quota at end of minute and full quota again at next minute start, effectively 2x burst.

```text
Limit: 100/min
12:00:59.900 → send 100 (allowed)
12:01:00.100 → send 100 (allowed)
Effective in 200ms: 200 requests
```

That edge effect is why fixed window is simple but less fair.

---

### A7. Sliding log vs sliding counter

| Aspect | Sliding Log | Sliding Counter |
|---|---|---|
| Precision | Exact | Approximate |
| Storage | O(number of requests) | O(number of sub-windows) |
| Cost | Higher CPU/memory | Much cheaper |
| Scale fit | Low/medium traffic keys | High-cardinality APIs |

Most production systems use sliding counter or token bucket for cost reasons.

---

### A8. Algorithm pick by endpoint type

| Endpoint | Recommended Algorithm | Why |
|---|---|---|
| Login API | Sliding window counter | Fairness + anti-bruteforce |
| Search API | Token bucket | Burst-friendly reads |
| Webhook ingest | Leaky bucket + queue | Smooth downstream load |
| Payment create | Token bucket + strict per-user cap | Prevent abuse while preserving UX |

---

## Level 3 — Single-Node Implementations

### A9. Token bucket minimal state

Per key you need: `tokens`, `last_refill_ts`, `capacity`, `refill_rate`.

```ts
type Bucket = { tokens: number; lastRefillMs: number };

function allow(nowMs: number, b: Bucket, capacity: number, refillPerSec: number, cost = 1): boolean {
  const elapsed = Math.max(0, nowMs - b.lastRefillMs);
  const refill = (elapsed / 1000) * refillPerSec;
  b.tokens = Math.min(capacity, b.tokens + refill);
  b.lastRefillMs = nowMs;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
```

---

### A10. Why monotonic clock

Wall clock can jump backward/forward due to NTP or manual changes, creating wrong refill math. Use monotonic time for elapsed calculations.

```ts
// Node.js monotonic source:
const nowMs = Number(process.hrtime.bigint() / 1_000_000n);
```

Monotonic time guarantees non-decreasing elapsed intervals.

---

### A11. Memory risk for 5M keys

| Item | Rough Cost |
|---|---|
| Per-key struct (~80 bytes incl. map overhead) | ~80 B |
| 5M active keys | ~400 MB |
| GC/fragmentation/headroom | 1.5x-2x overhead |

Mitigations:
- TTL-evict idle keys
- shard by process
- keep limiter state in Redis for large fleets

---

### A12. Why local-only limiter breaks at scale

With 10 gateways each allowing 100 req/min per key locally, aggregate allowed is ~1000 req/min. Global policy is violated.

| Deployment | Effective Limit |
|---|---|
| 1 gateway local limiter | 100/min |
| 10 gateways local limiter | ~1000/min |
| 10 gateways shared distributed state | 100/min global |

Local limiter is good only as a secondary safety layer.

---

## Level 4 — Distributed Enforcement with Redis

### A13. `INCR` + `EXPIRE` race

If process crashes between `INCR` and `EXPIRE`, key may persist without TTL (or TTL setup inconsistently), corrupting limits.

```lua
-- Bad multi-step pattern (not atomic):
INCR key
EXPIRE key 60
```

Fix by atomic script/transaction where increment and TTL logic are one operation.

---

### A14. Why Lua for token consumption

Lua executes atomically on Redis single thread, so read-modify-write is race-free.

```lua
-- KEYS[1]=bucket_key, ARGV: now_ms, capacity, refill_per_sec, cost
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or tonumber(ARGV[2])
local ts = tonumber(data[2]) or tonumber(ARGV[1])
local elapsed = math.max(0, tonumber(ARGV[1]) - ts)
tokens = math.min(tonumber(ARGV[2]), tokens + (elapsed/1000)*tonumber(ARGV[3]))
if tokens < tonumber(ARGV[4]) then return {0, tokens} end
tokens = tokens - tonumber(ARGV[4])
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], 120000)
return {1, tokens}
```

---

### A15. Avoiding hot keys

| Technique | Effect |
|---|---|
| Hash-tag shard prefix (tenant hash buckets) | Spreads writes |
| Hierarchical key split (`tenant`, `tenant:endpoint`) | Avoids single giant bucket |
| Local pre-filter bucket before Redis | Reduces Redis QPS for obvious denies |
| Separate heavy tenants to dedicated Redis cluster | Isolation |

Example key: `rl:{tenantHash42}:tenant_abc:/v1/search`.

---

### A16. Global vs region-local state

| Model | Pros | Cons |
|---|---|---|
| Global shared state | Strong global fairness | Cross-region latency + dependency |
| Region-local with budget split | Low latency + resilient | Slight over-admit risk globally |

Common pattern: allocate per-region budget (e.g., 40/30/30) and reconcile asynchronously.

---

## Level 5 — Correctness, Retries, and Failure Modes

### A17. Retries and idempotency

Network timeouts cause clients to retry; if each retry burns a token, legitimate users are over-penalized.

```ts
// Deduplicate token charge by request-id for short window
const dedupeKey = `rl:req:${requestId}`;
if (await redis.set(dedupeKey, "1", { NX: true, PX: 30_000 })) {
  consumeToken(); // first seen
} else {
  // retry: don't consume again
}
```

---

### A18. Fail-open vs fail-closed

| Route Type | Preferred Mode | Reason |
|---|---|---|
| Login / payment / write abuse-prone | Fail-closed | Safety over availability |
| Public read API / low risk endpoints | Fail-open (with local cap) | Availability over strictness |

This should be policy-driven per endpoint, not one global mode.

---

### A19. Clock skew handling

Skew can create extra refill or under-refill if each node computes time independently.

| Mitigation | Detail |
|---|---|
| Use monotonic local clock for local limiters | avoids backward jumps |
| Use Redis server time for shared script | single source for distributed decisions |
| Clamp elapsed to `[0, max_interval]` | avoids huge refill jumps after pauses |

---

### A20. Redis timeout storm protection

Use circuit breaker + fallback limiter to prevent gateway thread pool exhaustion.

```ts
if (redisCircuit.open()) {
  return localEmergencyLimiter.allow(key) // cheap fallback
}
const result = await redisLimiter.allowWithTimeout(key, 5); // ms budget
redisCircuit.record(result.ok);
return result;
```

Also cap concurrent limiter calls and fail fast.

---

## Level 6 — Policy & Product Design

### A21. Composing hierarchical limits

Evaluate all relevant buckets and deny if any critical bucket denies.

```ts
const checks = [
  { key: `tenant:${tenantId}`, cost: 1 },
  { key: `tenant:${tenantId}:user:${userId}`, cost: 1 },
  { key: `tenant:${tenantId}:ep:${endpoint}`, cost: endpointCost }
];
for (const c of checks) if (!allow(c.key, c.cost)) return deny(c.key);
return allowRequest();
```

Order checks from cheapest/highest-signal to expensive.

---

### A22. Weighted cost endpoints

Weighted token costs protect expensive APIs without separate hardcoded limits.

| Endpoint | Cost |
|---|---|
| `GET /profile` | 1 |
| `GET /search` | 2 |
| `POST /upload` | 10 |
| `POST /export` | 20 |

In token-bucket math: consume `cost` tokens instead of `1`.

---

### A23. Real-time policy updates

| Component | Role |
|---|---|
| Policy store (DB/config service) | source of truth |
| Gateway cache | local hot policy read |
| Pub/sub invalidation | push updates quickly |
| Versioned policy IDs | safe rollout and rollback |

Policy pull-on-miss + push-on-change gives low latency and fast convergence without gateway restart.

---

### A24. Safe internal exemptions

Never exempt by IP alone. Use authenticated service identity (mTLS/JWT) + explicit policy scope.

```ts
if (request.isInternal && request.mtlsSpiffeId?.startsWith("spiffe://prod/")) {
  // still enforce guardrail limit, just higher tier
  policyTier = "internal_service_tier";
} else {
  policyTier = "external_default";
}
```

This prevents attacker spoofing through NAT/VPN paths.

---

## Level 7 — Observability & Operations

### A25. Mandatory metrics

| Metric | Why |
|---|---|
| `allow_count`, `deny_count` by policy key | correctness + abuse visibility |
| decision latency p50/p95/p99 | hot path performance |
| Redis errors/timeouts | dependency health |
| fallback mode activations | degraded-operation detection |
| top denied tenants/users/endpoints | support + customer debugging |

Also track `false_positive_rate` via downstream signals (support tickets, conversion drops).

---

### A26. Detecting false positives

| Signal | Interpretation |
|---|---|
| Deny spikes with no traffic spike | policy likely too strict |
| Paid tenant sudden deny increase after config change | rollout regression |
| App retries explode after 429 rollout | client contract mismatch |
| Support tickets mentioning 429 | real user impact |

Use canary policy rollout (1%-5%-25%-100%) and compare deny deltas before global enable.

---

### A27. Pre-launch load tests

| Test | Purpose |
|---|---|
| Steady state at expected QPS | baseline latency/cost |
| 5x burst for 60s | burst correctness |
| Hot-key tenant simulation | shard/hotspot behavior |
| Redis partial outage | fail-open/fail-closed behavior |
| Policy reload storm | config propagation safety |

Success criteria should include both latency and decision accuracy (expected allow/deny ratios).

---

### A28. Incident rollback controls

| Control | Expected Speed |
|---|---|
| Disable specific policy version | seconds |
| Endpoint-level mode switch (open/closed) | seconds |
| Tenant allowlist override with TTL | immediate temporary relief |
| Global emergency fallback profile | one-click |

Every control should be audited with actor + timestamp + reason.

---

## Level 8 — Architect-Level Tradeoffs

### A29. Edge + gateway layered limiting

| Layer | Role |
|---|---|
| CDN/Edge | coarse IP/device flood protection near attacker |
| API Gateway | identity-aware per-user/tenant/endpoint limits |
| Service-level limiter | protect expensive internals from trusted callers |

Layering reduces blast radius and keeps expensive checks off overloaded origins.

---

### A30. Rate + concurrency limiting

Rate limit caps arrival rate; concurrency limit caps in-flight work. Both are needed for expensive downstreams.

```ts
if (!rateLimiter.allow(key)) return deny429();
if (!concurrencyLimiter.tryAcquire(routeKey)) return deny503Busy();
try { return await handler(); }
finally { concurrencyLimiter.release(routeKey); }
```

This prevents queue explosion even when request rate is legal.

---

### A31. Beyond IP against botnets

| Signal | Why it helps |
|---|---|
| API key reputation | catches abused keys |
| Device/browser fingerprint | identifies rotating IP bot clients |
| Session age/behavior score | distinguishes humans from automation |
| ASN / geo anomaly signals | blocks hostile network clusters |

Modern abuse control is risk-scored multi-signal, not single-key limiting.

---

### A32. Approximate structures in rate limiting

| Structure | Good For | Tradeoff |
|---|---|---|
| Count-Min Sketch | high-cardinality counting | overestimation bias |
| Bloom Filter | seen-before checks | false positives |
| HyperLogLog | unique-cardinality dashboards | approximate only |

Use approximations for telemetry/pre-filtering, not final billing-grade enforcement.

---

## Bonus — Senior Questions

### AB1. Policy versioning and audit

| Requirement | Implementation |
|---|---|
| Who changed policy? | signed change events |
| What changed? | diffed JSON with version hash |
| When applied? | rollout timeline per region |
| Why changed? | mandatory reason field/ticket |

---

### AB2. Live algorithm migration

```text
Phase 1: shadow mode (compute new decision, do not enforce)
Phase 2: compare old/new mismatch metrics
Phase 3: 1% enforce → 10% → 50% → 100%
Phase 4: keep rollback toggle for one full peak cycle
```

Never switch algorithm globally in one step.

---

### AB3. Customer-facing usage dashboard

| Field | Value Example |
|---|---|
| Current plan | Pro |
| Limit | 10,000 requests/min |
| Remaining | 3,245 |
| Reset ETA | 00:18 |
| Last 24h denied count | 112 |

This reduces support burden and improves trust.

---

### AB4. Buckets that must not be shared

| Endpoint Pair | Why Separate |
|---|---|
| `/auth/login` and `/search` | brute-force risk differs from read traffic |
| `/payments/create` and `/profile/get` | fraud-sensitive vs harmless reads |
| admin APIs and public APIs | operational safety |

Shared buckets can cause low-risk traffic to starve critical operations.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| 429 contract | Always include retry/reset headers |
| Token bucket | burst-friendly and most common |
| Leaky bucket | smoothing and downstream stability |
| Fixed window flaw | boundary double-spend |
| Sliding counter | fairness with bounded memory |
| Local-only limiter | breaks global correctness |
| Redis Lua | atomic read-modify-write |
| Hot key | shard + hierarchical keys + local prefilter |
| Fail-open/closed | policy by endpoint criticality |
| Retries | dedupe with idempotency key |
| Clock skew | use monotonic/Redis time |
| Weighted costs | expensive routes consume more tokens |
| Layered defense | edge + gateway + service limiter |
| Concurrency limit | protects in-flight capacity |
| Approximate DS | telemetry/pre-filter, not billing enforcement |
