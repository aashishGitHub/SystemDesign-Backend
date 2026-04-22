# Deep Dive: Rate Limiting

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions

---

## Table of Contents

1. [Why Rate Limiting Exists](#1-why-rate-limiting-exists)
2. [Algorithm Selection Under Interview Pressure](#2-algorithm-selection-under-interview-pressure)
3. [Token Bucket Internals](#3-token-bucket-internals)
4. [Distributed Limiting with Redis](#4-distributed-limiting-with-redis)
5. [Layered Enforcement: Edge, Gateway, Service](#5-layered-enforcement-edge-gateway-service)
6. [Policy Design for Real Products](#6-policy-design-for-real-products)
7. [Failure Modes and Graceful Degradation](#7-failure-modes-and-graceful-degradation)
8. [Observability and Capacity Planning](#8-observability-and-capacity-planning)
9. [Design Review Checklist](#9-design-review-checklist)
10. [Real-World Company Use Cases](#10-real-world-company-use-cases)
11. [Pattern Recognition — How to Identify When Rate Limiting is Needed](#11-pattern-recognition--how-to-identify-when-rate-limiting-is-needed)
12. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Rate Limiting Exists

### 🟢 Beginner — The Airport Security Analogy

Airport security has a fixed number of scanners. If everyone rushes at once, the line collapses. A controlled flow keeps the system stable and fair.

Rate limiting does the same for APIs: it controls how fast callers can consume shared backend capacity.

---

### 🟡 Senior — Protection Goals in Practice

```text
Client -> CDN -> API Gateway -> Services -> Databases/Queues
                    ^ limiter sits here to protect all downstream tiers
```

| Goal | What Limiter Prevents |
|---|---|
| Fairness | one tenant monopolizing shared resources |
| Reliability | cascading retries during partial outages |
| Cost control | accidental overuse of expensive endpoints |

The limiter is part of your reliability envelope, not just a security add-on.

---

### 🔴 Architect — Failure-First Thinking

At review time, define critical behavior before code:
- Which routes are fail-open vs fail-closed?
- What error budget is acceptable for false denies?
- How quickly can policy rollback happen?

Real incident pattern: teams deployed aggressive login limits globally and locked out legitimate users in corporate NAT networks. Root cause was keying only on IP. Architect-level fix: identity + route + risk score composition.

---

## 2. Algorithm Selection Under Interview Pressure

### 🟢 Beginner — Choose by Behavior, Not by Name

If users need short bursts (scrolling/searching), token bucket fits.
If downstream must stay smooth (e.g., webhook workers), leaky bucket helps.

---

### 🟡 Senior — Decision Matrix

```ts
function chooseLimiter(endpointType: "interactive" | "write-critical" | "batch-ingest") {
  if (endpointType === "interactive") return "token_bucket";
  if (endpointType === "write-critical") return "sliding_counter";
  return "leaky_bucket";
}
```

| Algorithm | Strength | Weakness |
|---|---|---|
| Fixed window | simplest, cheap | unfair boundary bursts |
| Sliding counter | better fairness | slightly approximate |
| Token bucket | burst-friendly | needs refill math correctness |
| Leaky bucket | smooth output | less UX-friendly for bursts |

---

### 🔴 Architect — Hybrid Is Normal

Large systems often combine algorithms:
- Edge: fixed/sliding for cheap flood filtering
- Gateway: token bucket for user-facing fairness
- Service queue: leaky/concurrency limiter to protect CPU-bound workers

Interview signal: explicitly say no single algorithm solves all layers.

---

## 3. Token Bucket Internals

### 🟢 Beginner — Water Tank Mental Model

Bucket refills at a fixed rate. Requests spend tokens. No tokens means wait/reject.

---

### 🟡 Senior — Correct State Update

```ts
type Bucket = { tokens: number; lastMs: number };

function take(b: Bucket, nowMs: number, capacity: number, refillPerSec: number, cost = 1) {
  const refill = ((nowMs - b.lastMs) / 1000) * refillPerSec;
  b.tokens = Math.min(capacity, b.tokens + Math.max(0, refill));
  b.lastMs = nowMs;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
```

| Field | Why Needed |
|---|---|
| `tokens` | remaining allowance |
| `lastMs` | compute elapsed refill |
| `capacity` | burst ceiling |
| `refillPerSec` | steady-state throughput |

Use monotonic time for `nowMs` to avoid clock-jump bugs.

---

### 🔴 Architect — Precision and Drift

At high QPS, floating-point drift can accumulate. Common mitigation:
- store milli-tokens as integers
- clamp elapsed interval to max bound
- use Redis TIME in distributed scripts

Capacity example:
```text
Policy: 600 req/min, burst 120
refill_per_sec = 10
```
This gives quick burst tolerance while keeping sustained rate predictable.

---

## 4. Distributed Limiting with Redis

### 🟢 Beginner — One Shared Scoreboard

With many gateway servers, each one must see the same counter. Redis acts as shared state.

---

### 🟡 Senior — Atomic Lua Pattern

```lua
-- atomic token consume
-- returns 1 allow, 0 deny
local now = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local refill = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', KEYS[1], 't', 'ts')
local t = tonumber(data[1]) or cap
local ts = tonumber(data[2]) or now
t = math.min(cap, t + math.max(0, now-ts)/1000*refill)
if t < cost then return 0 end
t = t - cost
redis.call('HMSET', KEYS[1], 't', t, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 120000)
return 1
```

| Concern | Mitigation |
|---|---|
| INCR/EXPIRE race | single Lua script |
| Hot keys | key sharding + hierarchical buckets |
| Redis timeout | circuit breaker + local fallback |

---

### 🔴 Architect — Multi-Region Strategy

Global strong state adds cross-region latency and blast radius. Common compromise:
- region-local limiters with preallocated quota slices
- periodic reconciliation
- emergency global kill switch per tenant

Example budget split for 10k req/s tenant:
`us-east: 4k`, `eu-west: 3k`, `ap-south: 3k`.

---

## 5. Layered Enforcement: Edge, Gateway, Service

### 🟢 Beginner — Three Gates Instead of One

Filter bad traffic as early as possible:
1. Edge blocks obvious floods
2. Gateway enforces customer policy
3. Service protects expensive internals

---

### 🟡 Senior — Layer Responsibilities

```text
Edge(CDN/WAF): IP/device coarse limits
Gateway: API key/user/tenant + endpoint weighted limits
Service: concurrency + queue depth safeguards
```

| Layer | Latency Budget | Decision Signal |
|---|---|---|
| Edge | sub-ms to low-ms | IP/ASN/fingerprint |
| Gateway | <=5ms p99 | identity + policy |
| Service | local memory fast path | CPU/DB saturation |

Layered design reduces cost and improves resilience.

---

### 🔴 Architect — Avoiding Policy Conflicts

A common failure is inconsistent limits across layers causing confusing 429s.
Fix:
- central policy registry
- layer-specific derived policies generated from one source
- response headers include `policy_id` for debugging

This improves supportability and postmortem speed.

---

## 6. Policy Design for Real Products

### 🟢 Beginner — Plans and Fairness

Free users get smaller buckets, paid users larger ones. Some endpoints cost more because they are expensive.

---

### 🟡 Senior — Policy Model

```json
{
  "policy_id": "pro-v3",
  "limits": [
    {"key":"tenant", "rate":"10000/min", "burst":2000},
    {"key":"tenant:endpoint:/upload", "rate":"1000/min", "burst":200},
    {"key":"tenant:user", "rate":"300/min", "burst":60}
  ],
  "costs": {"/upload": 10, "/search": 2, "/profile": 1}
}
```

| Policy Capability | Why It Matters |
|---|---|
| hierarchical keys | isolate noisy users without blocking tenant |
| weighted costs | protect expensive endpoints |
| versioning | safe rollouts and rollbacks |

---

### 🔴 Architect — Change Management

Policy rollouts should be progressive:
`shadow -> 1% -> 10% -> 50% -> 100%`.

Store every change as auditable event with actor and ticket reference.
For regulated workloads, this becomes a compliance requirement, not just good practice.

---

## 7. Failure Modes and Graceful Degradation

### 🟢 Beginner — Assume Dependencies Will Break

Your limiter depends on Redis/network/config systems. Design fallback behavior beforehand.

---

### 🟡 Senior — Common Failure Matrix

```ts
if (redisUnavailable) {
  return route.isCritical ? deny503Or429() : localLimiterOrAllow();
}
```

| Failure | Expected Behavior |
|---|---|
| Redis timeout spike | open breaker, fallback mode |
| Config service stale | keep last-known-good policy |
| Hot tenant storm | isolate tenant shard + tighter local caps |

Never block gateway threads waiting on slow limiter dependencies.

---

### 🔴 Architect — Blast Radius Control

Use cell-based architecture:
- dedicate limiter clusters per tenant tier or region
- prevent one tenant from exhausting shared Redis CPU
- add per-cell circuit breaker thresholds

Real-world pattern from large API platforms: isolating enterprise tenants prevents free-tier bot storms from impacting paying traffic.

---

## 8. Observability and Capacity Planning

### 🟢 Beginner — What to Watch First

Track three things first: allowed vs denied requests, limiter latency, and dependency errors.

---

### 🟡 Senior — Operational Dashboards

```promql
sum(rate(rate_limiter_deny_total[5m])) by (policy_id)
histogram_quantile(0.99, sum(rate(rate_limiter_decision_latency_ms_bucket[5m])) by (le))
sum(rate(rate_limiter_redis_errors_total[5m]))
```

| Dashboard Panel | Threshold Example |
|---|---|
| decision latency p99 | alert if > 5ms for 10m |
| deny ratio by tenant | anomaly detection vs baseline |
| fallback activations | alert if non-zero sustained |
| top denied endpoints | catches accidental strict policies |

---

### 🔴 Architect — Capacity Math

Back-of-envelope:
```text
Traffic: 3M req/s
Limiter checks/request: avg 2.5 buckets
Redis ops/s needed: 7.5M
```

If one Redis shard safely handles ~250k ops/s, you need ~30 shards plus headroom.
Always capacity-plan to peak + failover, not average traffic.

---

## 9. Design Review Checklist

### 🟢 Beginner — Must-Have Basics

- Correct 429 response contract
- Clear key selection (`tenant/user/endpoint`)
- Chosen algorithm explained with behavior

---

### 🟡 Senior — Review Questions

```text
1) What is fail-open/closed policy per route?
2) How are retries deduplicated?
3) How are hot keys isolated?
4) How fast can policy rollback happen?
```

| Review Area | Pass Criteria |
|---|---|
| Correctness | no known race in token consume path |
| Performance | p99 decision <= target |
| Operability | metrics + on-call runbook present |

---

### 🔴 Architect — “Ready for Peak” Criteria

System is ready only if:
- chaos test for Redis partial outage passed
- canary policy rollout automation exists
- audit trail and rollback work under load

Without these, you have an algorithm demo, not a production limiter.

---

## 10. Real-World Company Use Cases

### 🟢 Beginner — Same Problem, Different Scale

Every major API company has rate limiting. The difference is in what they limit, how they enforce it, and what happens when they get it wrong. Reading their public engineering posts shows you what "production rate limiting" actually looks like.

---

### 🟡 Senior — How Major Companies Do It

**Stripe — Idempotency-Aware Rate Limiting**

Stripe's API handles payments. Their core insight: rate limiting and idempotency must be designed together. A client retrying a timed-out payment should not count as a new token consumption.

```text
Stripe key design:
  rl:live:user:{user_id}           → 100 req/s per user (global)
  rl:live:user:{user_id}:/charges  → 25 req/s per /charges endpoint
  idempotency:{idempotency_key}    → 30-min dedup window per request

Algorithm: token bucket per user per endpoint
Burst: up to 25x burst allowed momentarily (for legitimate batch use)
Fail mode: 429 with Retry-After + remaining tokens in response body
```

Why it matters for interviews: Stripe famously documents their idempotency key design in public. Any payment API question must combine rate limiting + idempotency or the answer is incomplete.

---

**GitHub API — Dual Quota System**

GitHub uses two separate quota types, not one:

| Quota Type | Scope | Limit | Reset |
|---|---|---|---|
| Primary rate limit | per authenticated user | 5,000 req/hour | rolling hourly |
| Secondary rate limit | per endpoint + concurrency | varies | short window |
| Unauthenticated | per IP | 60 req/hour | rolling hourly |

```text
GitHub response headers:
  X-RateLimit-Limit: 5000
  X-RateLimit-Remaining: 4823
  X-RateLimit-Reset: 1372700873    ← Unix timestamp when window resets
  X-RateLimit-Used: 177
  Retry-After: 60                  ← only on secondary limit hit
```

Interview pattern to cite: GitHub's secondary rate limit exists because primary (hourly) limits do not prevent a client from making 100 concurrent requests in 1 second and hammering a search endpoint. **Concurrency limits complement rate limits.**

---

**Twitter/X — Fan-out Rate Limiting Under Celebrity Traffic**

Twitter's rate limiting challenge: when a celebrity (100M followers) posts, a cascading read storm hits timeline endpoints. Rate limiting must protect the timeline service without blocking millions of legitimate users.

```text
Twitter solution:
  Tier 1: CDN edge limit per IP (blocks obvious floods)
  Tier 2: Per user_id GET /timeline → 900 req/15min window (sliding)
  Tier 3: Application-level: fan-out queue throttled per celebrity account
  Tier 4: If downstream DB is saturated, return cached timeline (degrade quality)
```

Key pattern: Twitter does NOT rate limit celebrity reads directly. They rate limit **fan-out write workers** that populate timelines. Rate limiting operates on both the write pipeline and the read path — not just at the API surface.

---

**Cloudflare — Edge Rate Limiting Without a Central Store**

Cloudflare rate limits at the edge — across 300+ PoPs worldwide. A single global Redis would add 100ms latency. Their solution:

```text
Cloudflare approach:
  - Each edge node maintains local counters (in-memory)
  - Counters are periodically synchronized using gossip (eventually consistent)
  - Short-term accuracy: approximate (may allow 5-10% over limit briefly)
  - Long-term accuracy: converges to correct limit within seconds

This is intentionally "soft" rate limiting:
  Exact correctness sacrificed for <1ms decision latency.
```

When to cite this: any time an interviewer asks "what if Redis adds too much latency?" — approximate edge-local counters with eventual sync is the production answer.

---

**AWS API Gateway — Tiered Quota System**

AWS API Gateway uses a two-tier system that maps directly to business tiers:

```text
Account-level quota: 10,000 req/s per AWS account (default)
Usage plan per API key:
  - burst limit: short-term spike ceiling (token bucket capacity)
  - rate limit: sustained rate (token refill rate)

Example usage plan:
  "premium_plan": { rate: 1000/s, burst: 5000 }
  "basic_plan":   { rate: 100/s,  burst: 500  }
```

AWS maps `burst` directly to the token bucket capacity and `rate` to the refill rate. This makes token bucket vocabulary a first-class concept in their public docs — cite this when choosing token bucket in an interview.

---

### 🔴 Architect — Production Incidents From Rate Limiting Failures

**Incident 1 — The IP-Only Limiter That Broke Corporate Clients (common pattern)**

A SaaS platform keyed rate limits only on source IP. A Fortune 500 client had all 10,000 employees behind a single corporate NAT gateway. One employee's automated script hit the limit and locked out the entire company from the API.

```text
Root cause: IP keying fails for shared egress (NAT, VPN, university networks)
Fix: composite key = API_key + endpoint
     IP-level limit only as last-resort flood control
     Increase IP limit generously, tighten API-key limit precisely
```

**Incident 2 — Retry Storm After 429 Rollout (GitHub incident, 2012)**

GitHub deployed a new rate limit on the search API. Clients immediately started hitting 429s and retried without exponential backoff. Within 60 seconds, the retry storm doubled the incoming traffic.

```text
Root cause: clients treated 429 as transient error and retried immediately
Fix from GitHub side:
  - Retry-After header (clients must respect it)
  - Jittered retry guidance in error body
  - SDK update to enforce backoff
Fix on your system side:
  - Rate limit on "retry" traffic (track X-Retry-Count header)
  - Return 429 with long Retry-After on suspected retry storms
```

**Incident 3 — Redis Failover Cascade (production anti-pattern)**

A payment platform's Redis primary failed. The gateway was configured fail-closed. All API requests returned 429. The platform was completely unavailable for 4 minutes during Redis leader election.

```text
Root cause: fail-closed on Redis unavailability was too broad
Fix: fail-closed only on specific high-risk routes (/payments, /auth)
     fail-open with local emergency limiter on read routes
     circuit breaker with sub-200ms timeout on Redis calls
```

**Incident 4 — Clock Skew Breaking Token Refill (distributed systems)**

A gateway fleet used wall-clock time for token refill. An NTP sync pushed one node's clock back 15 seconds. That node refilled tokens it had already dispensed, effectively granting 25 seconds of tokens twice. Abuse users noticed within minutes.

```text
Root cause: wall-clock non-monotonic in distributed systems
Fix: monotonic clock for local calculations
     Redis server TIME command for distributed scripts (single time authority)
     Cap elapsed interval to max_window to bound any drift impact
```

---

## 11. Pattern Recognition — How to Identify When Rate Limiting is Needed

### 🟢 Beginner — The Interview Signal Checklist

When you hear these phrases in an interview, rate limiting should appear in your design immediately:

| Interview Signal | Rate Limiting Response |
|---|---|
| "public API" | per-API-key + per-IP limits at gateway |
| "free and paid tiers" | tiered token bucket per plan |
| "prevent abuse" | per-user + per-endpoint limits |
| "millions of users" | distributed Redis-based enforcement |
| "login endpoint" | strict sliding window counter anti-bruteforce |
| "flash sale / event spike" | burst-tolerant token bucket + queue |
| "third-party integration" | per-client-API-key limit |
| "payment / financial API" | strictest per-user limit + idempotency |

---

### 🟡 Senior — Algorithm Pattern Matching

Use this table when you have a requirement and need to pick an algorithm immediately in an interview:

| Requirement Signal | Algorithm Choice | Why |
|---|---|---|
| "allow short bursts" | Token bucket | burst = bucket capacity |
| "smooth downstream load" | Leaky bucket | drain rate = downstream capacity |
| "prevent boundary double-spend" | Sliding window counter | no window-edge problem |
| "exact fairness over precision" | Sliding window log | exact but expensive |
| "simplest possible" | Fixed window counter | cheap, good enough for low-risk routes |
| "expensive endpoint protection" | Token bucket with weighted cost | `POST /upload` costs 10 tokens |
| "brute-force login protection" | Sliding window counter, per-user-per-IP | no burst, tight fairness |
| "webhook or event ingestion" | Leaky bucket + queue | smooth for consumers |
| "global limit across regions" | Regional token buckets with budget split | avoids cross-region latency |
| "multi-tenant SaaS" | Hierarchical: tenant → user → endpoint | isolation at every level |

---

**Spotting the key to limit on:**

```text
Scenario → what key to use

"API key in header"
  → key = api_key + endpoint (most common)

"Anonymous users, no login"
  → key = IP address (with generous limit, not strict)

"B2B SaaS with enterprise clients"
  → key = tenant_id + endpoint (never IP, corporate NAT)

"Mobile app with user accounts"
  → key = user_id + endpoint (JWT-extracted)

"Webhook delivery to customer servers"
  → key = destination_url_hash (protect their server too)

"Internal microservices calling each other"
  → key = service_identity (mTLS SPIFFE ID) + route
```

---

### 🔴 Architect — Reading System Design Signals Like a Senior

**Signal: "The interviewer says the system needs to handle 10M users"**

Implication chain:
```text
10M users → cannot store counters in single Redis instance
           → need Redis Cluster with hash-slot sharding
           → need local prefilter to reduce Redis QPS
           → need hot-key detection for high-traffic users
```

**Signal: "The interviewer says 'what if a user sends too many requests?'"**

This question has two traps:
1. Beginners answer: "add a rate limit" — too vague
2. Intermediate: "use Redis INCR" — ignores atomicity and distributed state
3. Senior answer: token bucket + Lua script + circuit breaker + fail behavior per route

**Signal: "Design a payment API" or "Design Stripe"**

Automatically think:
```text
1. Per-user token bucket (100 req/min for free, 1000 for paid)
2. Per-endpoint weighted cost (/charge = 10 tokens, /retrieve = 1)
3. Idempotency key deduplication (window = 24h for payment operations)
4. Fail-closed on limiter unavailability (never let unlimited payments through)
5. Retry-After headers + SDK-enforced backoff
```

**Signal: "Design Twitter / social feed"**

Rate limiting applies in places beginners miss:
```text
- API tier: GET /timeline → 900 req/15min per user (obvious)
- Fan-out tier: limit writes per celebrity account (non-obvious)
- Search tier: expensive FTS → strict per-user concurrency limit
- Notification delivery: rate limit push notifications per user (UX)
```

**Signal: "The system needs to be globally available"**

Regional rate limit budgets, not single global Redis:
```text
If global limit = 10,000 req/s for a tenant:
  us-east-1: 4,000 (largest user base)
  eu-west-1: 3,000
  ap-south-1: 3,000
  Overflow: configurable per-region spill

Reconciliation: async token replenishment every 100ms
Emergency: global kill switch overrides all region budgets
```

---

**Anti-Patterns to Call Out in Any Rate Limiting Design:**

| Anti-Pattern | Why It Fails | Correct Alternative |
|---|---|---|
| IP-only limit | Corporate NAT, VPN proxy false positives | Composite key: API key + endpoint |
| Global fail-closed on Redis outage | Completely blocks availability | Per-route fail mode (open/closed) |
| INCR then EXPIRE (not atomic) | Race condition — key can live forever without TTL | Lua script or SET with px |
| Identical limit for all endpoints | Expensive routes can be abused cheaply | Weighted token cost per endpoint |
| No Retry-After header | Clients retry immediately → amplifies traffic | Always include Retry-After + jitter hint |
| Limit by wall-clock time | NTP jumps can grant double tokens | Monotonic time + Redis TIME |
| Same bucket for auth and search | Auth failure blackout causes search degradation | Always separate buckets by endpoint criticality |

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Limiter purpose | fairness + reliability + cost control |
| Token bucket | best default for burst-friendly APIs |
| Leaky bucket | smooth output for downstream stability |
| Fixed window issue | boundary burst unfairness |
| Sliding counter | near-fair with bounded memory |
| Monotonic time | prevents clock-jump refill bugs |
| Redis Lua | atomic distributed decision |
| Hot key mitigation | shard + isolate heavy tenants |
| Retry safety | idempotency/dedupe keys |
| Fail-open/closed | route-criticality decision |
| Layered defense | edge + gateway + service limiter |
| Weighted endpoints | expensive routes cost more tokens |
| Observability | deny ratio + p99 latency + fallback count |
| Capacity math | plan for peak and failover, not average |
| Rollout strategy | shadow then progressive canary |
| Auditability | every policy change must be traceable |
| Stripe pattern | token bucket + idempotency key dedup per request |
| GitHub pattern | primary hourly + secondary concurrency — both needed |
| Twitter pattern | rate limit fan-out writes, not just API reads |
| Cloudflare pattern | local edge counters + gossip sync for sub-ms decisions |
| AWS API Gateway | burst = bucket capacity, rate = refill rate |
| IP-only anti-pattern | breaks under NAT/VPN — always composite with identity |
| Retry storm fix | Retry-After header + jitter hint in 429 body |
| Redis failover fix | per-route fail mode — not one global open/closed |
| Clock skew fix | monotonic local + Redis TIME for distributed scripts |
| Key identification | public API → api_key+ep, B2B → tenant_id, mobile → user_id |
| Algorithm: burst ok | token bucket |
| Algorithm: smooth output | leaky bucket |
| Algorithm: brute force | sliding window counter |
| Algorithm: simplest | fixed window counter |
| Signal: payment API | fail-closed + idempotency + per-user limit |
| Signal: social feed | rate limit fan-out writers, not only reads |
| Signal: global system | regional budget split + async reconciliation |
