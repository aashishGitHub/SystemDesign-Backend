# Deep Dive: Circuit Breaker

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions

---

## Table of Contents

1. [Why Circuit Breakers Exist](#1-why-circuit-breakers-exist)
2. [The Three States and Transitions](#2-the-three-states-and-transitions)
3. [Configuration and Tuning](#3-configuration-and-tuning)
4. [Fallback Strategies](#4-fallback-strategies)
5. [Circuit Breakers in Distributed Systems](#5-circuit-breakers-in-distributed-systems)
6. [Observability and Capacity Planning](#6-observability-and-capacity-planning)
7. [Design Review Checklist](#7-design-review-checklist)
8. [Real-World Company Use Cases](#8-real-world-company-use-cases)
9. [Pattern Recognition — When to Use Circuit Breakers](#9-pattern-recognition--when-to-use-circuit-breakers)
10. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Circuit Breakers Exist

### 🟢 Beginner — The Electrical Breaker Analogy

Your home has a circuit breaker box. When a circuit draws too much current, the breaker trips — cutting power to that circuit before it starts a fire. You don't have to wait for the wires to melt. You just reset the breaker once the problem is fixed.

Software circuit breakers work the same way. When a downstream service starts failing, the circuit breaker trips — cutting off calls to that service before the failures cascade to your entire system. Your service stays healthy while the downstream one recovers.

Without a circuit breaker: service A calls failing service B → threads pile up waiting for timeouts → A's thread pool exhausts → A becomes unavailable → C, which depends on A, also fails. One slow service has now taken down the whole chain. This is a **cascading failure**.

---

### 🟡 Senior — The Problem It Solves

```text
Without circuit breaker:
  Client → Service A → Service B (slow/down)
                       ^
                       Each call waits for timeout (e.g., 30s)
                       A's thread pool fills up
                       A stops accepting new requests
                       Client sees A as unavailable

With circuit breaker:
  Client → Service A → [Circuit Breaker] → Service B (slow/down)
                                ^
                                Trips after threshold
                                Returns immediately (fail-fast)
                                A stays healthy
                                Client retries or gets fallback
```

| Without Circuit Breaker | With Circuit Breaker |
|---|---|
| Threads blocked waiting for timeout | Fails immediately (no thread blocked) |
| Cascades failure upstream | Isolates failure to one dependency |
| Recovery depends on downstream | Can recover independently |
| High latency tail during failure | Predictable fast failure |

Circuit breakers are a **bulkhead** — they isolate a failing compartment from the rest of the ship.

---

### 🔴 Architect — Failure-First Thinking

At design review, define failure behavior before implementation:

- What is the acceptable p99 latency for this call path during a downstream outage?
- Is this dependency in the critical path (fail = user error) or non-critical (fail = degraded experience)?
- What is the fallback and who owns it?

Real incident pattern: a recommendation service called a personalization ML service with a 10-second timeout and no circuit breaker. The ML service suffered GC pauses. The recommendation service's thread pool filled in 45 seconds. The homepage became unavailable for 8 minutes while engineers manually restarted services. Root cause: no fail-fast, no fallback, no breaker.

---

## 2. The Three States and Transitions

### 🟢 Beginner — Traffic Light Mental Model

Think of the circuit breaker as a traffic light with three states:

- 🟢 **Green (Closed)** — Traffic flows normally. Everything is fine.
- 🔴 **Red (Open)** — Traffic is stopped. Too many failures. Give the downstream service time to recover.
- 🟡 **Yellow (Half-Open)** — Let a few cars through to test if the road is clear again.

---

### 🟡 Senior — State Machine Mechanics

```text
              failure threshold exceeded
Closed ────────────────────────────────────► Open
  ▲                                            │
  │                                            │ timeout expires
  │                                            ▼
  │                                        Half-Open
  │          probe succeeds                    │
  └────────────────────────────────────────────┘
                                               │ probe fails
                                               │
                                               ▼
                                             Open (reset timer)
```

**Closed State:**
- All requests pass through to downstream
- Failure counter increments on error (5xx, timeout, connection refused)
- Success counter resets the failure count (or uses sliding window)
- Trips to Open when: `failure_rate > threshold AND request_count > min_volume`

**Open State:**
- All requests rejected immediately — no network call made
- Returns error or fallback response
- Timer starts; transitions to Half-Open after `open_timeout`

**Half-Open State:**
- Allows `probe_count` (e.g., 3) requests through
- If all probes succeed → Closed
- If any probe fails → Open (timer resets)

```ts
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreaker {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  config: {
    failureRateThreshold: number;   // e.g., 0.5 (50%)
    minRequestVolume: number;       // e.g., 20 (ignore if < 20 requests in window)
    openTimeout: number;            // ms until Half-Open probe
    probeCount: number;             // how many probes in Half-Open
    slidingWindowSize: number;      // ms of rolling window
  };
}
```

| Transition | Trigger | Why |
|---|---|---|
| Closed → Open | failure rate exceeds threshold over window | downstream is degraded |
| Open → Half-Open | `openTimeout` expires | give downstream time to recover |
| Half-Open → Closed | all probes succeed | downstream is healthy again |
| Half-Open → Open | any probe fails | not recovered yet — back off |

---

### 🔴 Architect — Sliding Window vs Count-Based

**Count-based (simpler, worse):**
```text
Trip after: N consecutive failures
Problem: N=5 means a single bad burst trips the breaker even if overall error rate is fine
Problem: a success resets the counter — easy to game accidentally
```

**Sliding window (production-grade):**
```text
Trip when: error_rate > 50% AND total_calls > 20 in last 10 seconds
Advantage: requires sustained failure, not just a momentary burst
Resilience4j uses sliding windows; Hystrix used count-based (deprecated)
```

Capacity math for window sizing:
```text
Service SLO: 99.9% success rate
Normal error rate: ~0.1%
Trip threshold: 10% error rate (10× baseline)
Minimum volume: 20 requests (avoids tripping on 1/2 failures at idle)
Window: 10 seconds

At 1,000 req/s → 10k requests per window
At 10% failure rate → 1,000 errors → breaker trips
Recovery probe timeout: 30 seconds
```

---

## 3. Configuration and Tuning

### 🟢 Beginner — Three Knobs to Set

Every circuit breaker has three main settings:
1. **When to trip** — how many failures before opening (threshold)
2. **How long to stay open** — how long to wait before testing recovery (timeout)
3. **How to probe** — how many test requests to send in half-open (probe count)

Getting these wrong causes **false trips** (too sensitive) or **stuck open** (too tolerant).

---

### 🟡 Senior — Tuning by Failure Type

```ts
// Resilience4j-style config (Java) — maps conceptually to any library
CircuitBreakerConfig config = CircuitBreakerConfig.custom()
  .slidingWindowType(COUNT_BASED)
  .slidingWindowSize(20)              // last 20 requests
  .failureRateThreshold(50)           // trip at 50% failure rate
  .slowCallRateThreshold(80)          // also trip if 80% of calls are slow
  .slowCallDurationThreshold(Duration.ofSeconds(2))  // "slow" = >2s
  .waitDurationInOpenState(Duration.ofSeconds(30))   // stay open 30s
  .permittedNumberOfCallsInHalfOpenState(5)          // 5 probes
  .minimumNumberOfCalls(10)           // need ≥10 calls before evaluating
  .build();
```

| Config Parameter | Too Low | Too High | Recommended Starting Point |
|---|---|---|---|
| `failureRateThreshold` | False trips on noise | Misses real failures | 50% for general services, 20% for payments |
| `slidingWindowSize` | Reacts too fast | Slow to detect failures | 20–50 requests or 10–30 seconds |
| `minimumNumberOfCalls` | Trips on 1/2 failures at idle | Slow to trip under load | 10–20 |
| `waitDurationInOpenState` | Hammers recovering service | Stays unavailable too long | 30–60 seconds |
| `permittedCallsInHalfOpen` | Insufficient signal | Delays recovery | 3–10 |

**Error type filtering — what counts as a failure:**

```ts
// Only count server-side errors, not client errors
CircuitBreakerConfig.custom()
  .recordExceptions(IOException.class, TimeoutException.class)
  .ignoreExceptions(BusinessValidationException.class)  // 4xx = client's fault
  .build();
```

Client errors (4xx) should NOT count toward the circuit breaker — they represent bad caller behavior, not downstream health.

---

### 🔴 Architect — Adaptive Thresholds

Static thresholds are a starting point. Production systems often need:

**Slow-call threshold** — a downstream that responds in 5s instead of 50ms is functionally failing even if it returns 200 OK. Configure both error rate AND slow-call rate thresholds.

**Time-based vs count-based windows:**
```text
Count-based: trip after N of last M requests fail
  Good for: stable, consistent traffic
  Bad for: low traffic at night (2/3 failures = 67% rate from just 3 requests)

Time-based: trip after N% failures in last T seconds
  Good for: variable traffic patterns
  Bad for: requires more config tuning
```

**Different timeouts per dependency criticality:**
```text
Payment service: open_timeout=10s (recover fast, critical path)
ML recommendation: open_timeout=60s (non-critical, can stay open longer)
Analytics service: open_timeout=300s (fire-and-forget, tolerate long outage)
```

---

## 4. Fallback Strategies

### 🟢 Beginner — Always Have a Plan B

Opening the circuit without a fallback is just a fast timeout — you still return an error. A good fallback lets your service continue working in a degraded-but-functional way.

Three fallback options in order of preference:
1. **Cache** — return the last known good response
2. **Default** — return a safe default value (empty list, generic response)
3. **Error** — return a clear error to the caller (last resort)

---

### 🟡 Senior — Fallback Patterns by Dependency Type

```ts
async function getRecommendations(userId: string): Promise<string[]> {
  return circuitBreaker.execute(
    // Primary: vector DB call
    () => vectorDB.query(userId, limit=10),

    // Fallback: tiered degradation
    async (error) => {
      // Tier 1: Redis cache (most specific)
      const cached = await redis.get(`recs:${userId}`);
      if (cached) return JSON.parse(cached);

      // Tier 2: Popular items by category (less specific)
      const category = await userProfileService.getCategory(userId);
      return await popularItemsCache.get(category);

      // Tier 3: Global trending (least specific)
      return await popularItemsCache.get("global");
    }
  );
}
```

| Dependency Type | Recommended Fallback |
|---|---|
| User-specific data (recommendations) | Cached last result → category popular → global popular |
| Auth / identity service | Cache recent auth tokens (short TTL) → fail-closed for new sessions |
| Payment / financial | Fail-closed — never silently skip (return explicit error) |
| Analytics / logging | Fail-open — drop the event, log locally |
| Search / ML scoring | Return unranked results or empty list |
| Config / feature flags | Return last-known-good config |

**What NOT to do:**
```ts
// BAD: circuit open but no fallback — same user experience as no breaker
circuitBreaker.execute(() => service.call())
  .catch(() => { throw new Error("Service unavailable"); });

// GOOD: open circuit is invisible to the user
circuitBreaker.execute(() => service.call())
  .catch(() => cache.getStale() ?? defaultResponse());
```

---

### 🔴 Architect — Fallback Blast Radius

Fallbacks can themselves fail. Design fallback chains:

```text
Primary: Vector DB (circuit breaker, timeout 500ms)
  └─ Fallback 1: Redis cache (circuit breaker, timeout 50ms)
       └─ Fallback 2: In-memory LRU cache (no network, always available)
            └─ Fallback 3: Static popular items list (hardcoded, never fails)
```

Never have a fallback that calls another external service without its own circuit breaker. Fallback calling a broken service = double failure.

Fallback SLOs should be defined separately:
```text
Primary p99: 100ms, availability: 99.9%
Fallback p99: 20ms (from cache), availability: 99.99%
Fallback quality: ~70% relevance vs primary
```

---

## 5. Circuit Breakers in Distributed Systems

### 🟢 Beginner — One Breaker Per Dependency, Not One Global Breaker

A common mistake: using one circuit breaker for everything. If your service calls three backends, you need three independent breakers. A failure in the recommendation engine should not trip the circuit breaker protecting the payment service.

---

### 🟡 Senior — Placement and Scope

```text
                    ┌─────────────────────────────────────┐
                    │         API Gateway / BFF            │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
    ┌──────────────────┐  ┌─────────────────┐  ┌──────────────────┐
    │  [CB] Vector DB  │  │ [CB] User Svc   │  │ [CB] Event Queue │
    └──────────────────┘  └─────────────────┘  └──────────────────┘
```

**One breaker per dependency, per client service** — not shared across callers.

```ts
// Separate breaker instances — independent state
const vectorDBBreaker = new CircuitBreaker(vectorDB.query, config.vectorDB);
const userSvcBreaker  = new CircuitBreaker(userSvc.get,    config.userSvc);
const kafkaBreaker    = new CircuitBreaker(kafka.produce,  config.kafka);
```

**Circuit breakers belong in the caller, not the callee.** The caller decides when to stop trying. The callee doesn't know it's being protected.

| Placement | Correct? | Why |
|---|---|---|
| In the calling service | ✅ | Caller controls its own failure budget |
| In the called service | ❌ | Called service doesn't know caller's context |
| At the API gateway | ✅ (for external APIs) | Gateway protects all upstream callers uniformly |
| Shared across microservices | ❌ | One service's failure should not trip another's breaker |

---

### 🔴 Architect — Circuit Breakers and Retries Together

Circuit breakers and retries solve different problems and must be composed carefully:

```text
Wrong order (common mistake):
  Retry → Circuit Breaker
  Problem: 3 retries × 100 failing services = 300 calls before breaker trips
           This AMPLIFIES load on a struggling downstream

Correct order:
  Circuit Breaker → Retry (only inside closed circuit)
  Logic: if circuit is open, don't retry at all — fail fast
         if circuit is closed and call fails, retry with backoff
         if retries exhaust, record failure toward circuit threshold
```

```ts
async function callWithResiliency(fn: () => Promise<any>) {
  // Check circuit first — fail fast if open
  if (circuitBreaker.isOpen()) return fallback();

  try {
    // Retry inside the closed circuit with exponential backoff
    return await retry(fn, { attempts: 3, backoff: "exponential", jitter: true });
  } catch (err) {
    circuitBreaker.recordFailure();
    return fallback();
  }
}
```

**Timeout + Retry + Circuit Breaker interaction:**
```text
Timeout:          individual call maximum wait
Retry:            re-attempt after transient failure
Circuit Breaker:  stop all attempts after sustained failure

Order of operations:
  1. Call starts
  2. Timeout fires if call is slow (individual call boundary)
  3. Retry fires if call fails (multiple attempts)
  4. Circuit Breaker records failure (from timeout or retry exhaustion)
  5. Circuit trips if threshold met (all future calls fail-fast)
```

---

## 6. Observability and Capacity Planning

### 🟢 Beginner — Four Metrics to Watch

1. **Circuit state** — is the breaker currently open?
2. **Failure rate** — what % of calls are failing?
3. **Fallback rate** — how often is the fallback being used?
4. **Recovery time** — how long does the circuit stay open before healing?

---

### 🟡 Senior — Operational Dashboards

```promql
# Circuit state (0=closed, 1=open, 2=half-open) — alert if open > 5min
circuit_breaker_state{service="vector-db"} > 0

# Failure rate over 5-minute window
rate(circuit_breaker_failure_total[5m]) / rate(circuit_breaker_call_total[5m])

# Fallback activation rate
rate(circuit_breaker_fallback_total[5m])

# Time spent in open state per dependency
sum(circuit_breaker_open_duration_seconds_total) by (dependency)
```

| Dashboard Panel | Alert Threshold |
|---|---|
| circuit state | alert immediately if open |
| failure rate | alert if > 10% sustained for 2 min |
| fallback rate | alert if > 5% (indicates primary degraded) |
| recovery time | alert if open > 5 minutes (dependency may need manual fix) |
| probe failures | alert if Half-Open probes failing repeatedly |

**Key log events to emit:**
```ts
logger.warn("circuit_breaker_opened",  { dependency, failureRate, windowMs });
logger.info("circuit_breaker_probing", { dependency, probeNumber });
logger.info("circuit_breaker_closed",  { dependency, recoveryTimeMs });
```

---

### 🔴 Architect — Capacity Math and SLO Impact

**Calculating acceptable open timeout:**
```text
Dependency SLO:      99.9% (43.8 min downtime/month)
Average incident:    5-minute recovery
Open timeout:        30 seconds
Probe attempts:      3 (at 30s intervals = 90s max probe time)

Worst case circuit contribution to downtime:
  Open phase:      30s
  Probe phase:     90s max
  Total:           120s = 2 minutes per incident

If 5 incidents/month:
  Circuit overhead:  10 minutes of fallback mode
  Remaining budget:  43.8 - 10 = 33.8 min of actual downstream outage budget
```

**Thread pool sizing under circuit breaker protection:**
```text
Without circuit breaker:
  100 concurrent users × 30s timeout = 3,000 thread-seconds blocked during outage

With circuit breaker (30ms fail-fast):
  100 concurrent users × 30ms = 3 thread-seconds
  Thread pool freed: 99.9%

This is the primary throughput argument for circuit breakers:
  they turn "service is down for 5 minutes and my thread pool is exhausted"
  into "service is down for 5 minutes and I served 300k cached responses"
```

---

## 7. Design Review Checklist

### 🟢 Beginner — Must-Have Basics

- Every external service call is wrapped in a circuit breaker
- Every circuit breaker has a defined fallback
- Circuit state is observable (metrics/logs)

---

### 🟡 Senior — Review Questions

```text
1) What errors count as failures (4xx excluded?)
2) What is the fallback for each breaker, and can that fallback fail?
3) Are retries inside or outside the circuit breaker?
4) How is the circuit state visible in the dashboard?
5) Is there a runbook for manual circuit reset?
```

| Review Area | Pass Criteria |
|---|---|
| Correctness | error types filtered; retries inside breaker |
| Fallback chain | at least 2 tiers; fallback itself is resilient |
| Observability | state changes emit metrics + logs |
| Operability | manual open/close available for emergency |

---

### 🔴 Architect — "Ready for Production" Criteria

System is ready only if:
- Chaos test (kill downstream service) verified: breaker trips within SLO
- Fallback path verified under load independently of primary
- Circuit state exposed in on-call dashboard with alert
- Manual override (force open / force close) available without deploy
- Probe behavior under sustained Half-Open failure documented

Without fallback validation, you have a breaker that fails fast into the same 503 — just faster.

---

## 8. Real-World Company Use Cases

### 🟢 Beginner — Same Problem at Every Scale

Netflix, Amazon, and Google all use circuit breakers in production. The difference is in how they tune them, where they place them, and how sophisticated their fallbacks are. Learning their patterns shows you what "production circuit breaker" looks like.

---

### 🟡 Senior — How Major Companies Do It

**Netflix — Hystrix (Origin of the Pattern)**

Netflix open-sourced Hystrix in 2011 — the library that popularized circuit breakers in microservices. Their core insight from a 2012 outage: a single slow Amazon API call caused a cascading failure across 30+ services because threads were blocked waiting for timeouts.

```text
Netflix Hystrix design:
  Every external call wrapped in HystrixCommand
  Each command: isolated thread pool (bulkhead)
  Circuit: count-based window, trip at 50% failure rate
  Fallback: required — Hystrix won't let you skip it

Hystrix is now deprecated (moved to Resilience4j),
but the mental model it introduced is the standard.

Key Netflix innovation: thread pool isolation PER dependency
  Vector DB thread pool: 20 threads max
  User service thread pool: 10 threads max
  Payment thread pool: 5 threads max
  → One slow dependency can only consume its own pool
```

---

**Amazon — Dependency Injection of Circuit State**

Amazon's approach (documented in their "Builders' Library"): circuit breakers are not just client-side. They inject circuit state into the **request context** so that downstream services can also adapt.

```text
Amazon pattern:
  Caller opens circuit → sets X-Circuit-Open: true in request header
  Downstream service sees header → skips expensive operations
  Returns lightweight cached response proactively

Why it matters: the circuit is collaborative, not just protective.
  Instead of failing fast silently, the caller signals intent
  so the downstream can serve a fast, cheap response.
```

---

**Uber — Adaptive Circuit Breakers**

Uber's dispatch system uses adaptive circuit breakers that tune thresholds based on traffic patterns rather than static config.

```text
Uber challenge:
  Traffic spikes 10× during surge pricing events
  Static 50% error threshold would trip on legitimate load spike
  because absolute failure count jumps even if rate is fine

Uber solution:
  Dynamic threshold = baseline_error_rate × spike_multiplier
  Baseline sampled from rolling 24h window
  Multiplier adjusts based on detected traffic percentile

Result: circuit breakers that don't false-trip during Super Bowl
  surge pricing events, but still catch genuine failures.
```

---

**Google — Circuit Breakers at the Load Balancer**

Google's internal RPC framework (Stubby/gRPC) places circuit breakers at the **load balancer level**, not the application level.

```text
Google approach:
  Client-side load balancer tracks per-backend health
  Backends that exceed error rate are removed from rotation
  Remaining backends share the load (rebalancing)
  Unhealthy backends probed at low rate (same as Half-Open)

Advantage over application-level breakers:
  Circuit state is shared across all instances of the calling service
  One service instance doesn't need to independently re-learn that a backend is down
  Recovery is coordinated, not per-instance
```

---

### 🔴 Architect — Production Incidents From Circuit Breaker Failures

**Incident 1 — No Fallback, Fast Failures (worse than no breaker)**

A checkout service added a circuit breaker on the inventory service — but with no fallback. The breaker opened correctly during a database failure. But the fallback was `throw new ServiceUnavailableException()`. Users saw "Service Unavailable" immediately instead of waiting. Engineers declared success: "the breaker worked!" But conversion rate dropped 40% in 10 minutes.

```text
Root cause: circuit breaker with no fallback = fast 503 vs slow 503
Fix: fallback returns "inventory not shown" with "Add to cart" still enabled
     (inventory checked at order confirmation, not at browse time)
Lesson: measure fallback quality before measuring breaker correctness
```

**Incident 2 — Breaker Tuned Too Sensitive (false trips)**

A payment platform's circuit breaker was set to trip at 5% error rate. A routine deploy caused a 30-second spike to 6% error rate (normal startup noise). The breaker tripped. The fallback was "queue payment for later processing." 50,000 payments were silently deferred.

```text
Root cause: threshold set at 5×, not 10× baseline error rate
            minimum volume was too low (10 requests, not 50)
            deploy caused legitimate transient spike
Fix: raise threshold to 15%, raise min_volume to 50
     separate deploy circuit from production circuit (canary)
     alert on fallback activation rate, not just circuit state
```

**Incident 3 — Retry Storm After Breaker Closes**

A social platform's circuit breaker closed after 30 seconds open. All 200 instances of the calling service had been queuing requests locally during the open period. When the breaker closed, 200 instances simultaneously flushed their queues — hammering the recovering downstream with 50× normal traffic.

```text
Root cause: retries were buffered locally per instance
            closing the breaker opened all floodgates at once
Fix: staggered breaker recovery (not all instances reset at same time)
     shed buffered requests on circuit open, don't queue them
     downstream's capacity plan must account for recovery burst
     use Half-Open probes to gate recovery — not immediate full open
```

---

## 9. Pattern Recognition — When to Use Circuit Breakers

### 🟢 Beginner — The Interview Signal Checklist

When you hear these phrases, circuit breakers should appear in your design:

| Interview Signal | Circuit Breaker Response |
|---|---|
| "microservices" | wrap each inter-service call |
| "external API dependency" | breaker at the HTTP client layer |
| "high availability / 99.9% SLO" | breaker prevents cascading failures |
| "what if the ML model is slow?" | breaker + cached/default recommendations |
| "resilience" or "fault tolerance" | breaker is the primary tool |
| "payment service calls fraud service" | breaker with fail-closed fallback |
| "real-time recommendations" | breaker on vector DB + cached fallback |
| "event ingestion at high throughput" | breaker on Kafka + local buffer fallback |

---

### 🟡 Senior — Algorithm Pattern Matching

| Requirement Signal | Circuit Breaker Config | Fallback |
|---|---|---|
| Critical path (auth, payments) | low threshold (20%), fail-closed | explicit error — don't silently skip |
| Non-critical (recommendations) | higher threshold (50%), fail-open | stale cache → popular items |
| Async/fire-and-forget (analytics) | high threshold (80%), fail-open | drop + log locally |
| Database calls | slow-call threshold (>500ms) | read replica → cached result |
| External vendor API | standard (50%), longer open timeout | default response or queue for retry |
| Fan-out (notification delivery) | per-destination breaker | skip delivery, log for retry |

**Spotting where breakers belong:**

```text
Scenario → where to place the breaker

"Service A calls Service B (synchronous)"
  → Client-side breaker in A, wrapping the HTTP/gRPC call

"API Gateway calling multiple backends"
  → Breaker at gateway level, per backend route

"Message consumer calling downstream DB"
  → Breaker wrapping DB call inside consumer handler

"Scheduled job calling external API"
  → Breaker wrapping API call; fallback = skip + retry next run

"Service calling its own database"
  → Breaker + read-replica fallback for reads; fail-closed for writes
```

---

### 🔴 Architect — Reading System Design Signals Like a Senior

**Signal: "Design a recommendation system at scale"**

Automatically think:
```text
Vector DB call:      circuit breaker (threshold 50%, open 30s)
                     fallback: Redis cached recs → category popular → global popular

User profile fetch:  circuit breaker (threshold 30%, open 15s)
                     fallback: anonymous profile → segment default

Feature flag fetch:  circuit breaker (threshold 80%, open 60s)
                     fallback: last-known-good config (in-memory)
```

**Signal: "Design a payment system"**

```text
Fraud service:       circuit breaker, FAIL-CLOSED (never skip fraud check)
                     fallback: queue payment for manual review

Core banking API:    circuit breaker, fail-closed
                     fallback: explicit error — do NOT process without confirmation

Notification svc:    circuit breaker, fail-open
                     fallback: queue notification for async retry
```

**Signal: "What happens if the downstream service goes down?"**

This is the direct invitation to discuss circuit breakers. Structure your answer:
```text
1. Without circuit breaker: describe cascading failure (threads, timeouts, upstream impact)
2. With circuit breaker: describe fail-fast, state transitions, recovery
3. Fallback: describe what the user sees (and that it's degraded but functional)
4. Observability: describe how on-call detects and tracks the open circuit
```

**Anti-patterns to call out:**

| Anti-Pattern | Why It Fails | Correct Alternative |
|---|---|---|
| No fallback | fast error = slow error, just quicker | define fallback before adding breaker |
| One global breaker | unrelated failures trip each other | one breaker per dependency |
| Retries outside breaker | amplifies load on failing service | retry inside closed circuit only |
| Breaker on 4xx errors | client bugs trip the breaker | filter to 5xx + timeout + connection error |
| Static threshold for variable traffic | false trips during traffic spikes | time-based sliding window + min volume |
| No manual override | can't force-close stuck open breaker | expose admin endpoint for state override |
| Fallback calls external service | fallback can itself fail | fallback must use local cache or hardcoded default |

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Circuit breaker purpose | fail-fast to prevent cascading failures across service dependencies |
| Closed state | normal operation; failures counted toward threshold |
| Open state | all calls rejected immediately; timer counting down to Half-Open |
| Half-Open state | limited probe requests; success → Closed, failure → Open |
| Sliding window | trip on sustained error rate, not momentary burst |
| Minimum volume | ignore error rate if request count is too low |
| Error type filtering | 4xx = client fault; only 5xx + timeout count toward threshold |
| Slow-call threshold | treat slow response as failure even if it returns 200 |
| Fallback tiers | cached result → default value → explicit error (in order of preference) |
| Retry + breaker order | check breaker first; retry only inside closed circuit |
| Placement | caller-side, per dependency — never shared across services |
| Thread pool isolation | separate pools per dependency (bulkhead pattern) |
| Recovery burst | Half-Open probes gate recovery — prevents flooding on close |
| False trip risk | too-low threshold + no min volume = trips on normal noise |
| Observability | emit state change events; alert on open > 5min |
| Manual override | always expose force-open / force-close for incident response |
| Netflix pattern | Hystrix — per-command thread pool + mandatory fallback |
| Amazon pattern | inject circuit state into request headers (collaborative circuit) |
| Uber pattern | adaptive thresholds calibrated to 24h traffic baseline |
| Google pattern | load-balancer-level breaker with shared state across callers |
| Payment rule | fail-closed — never silently skip auth, fraud, or payment steps |
| Analytics rule | fail-open — drop the event, log locally, never block the user |
| Recommendation rule | fail to stale cache → popular items → global popular |
| Incident: no fallback | fast 503 = slow 503; measure fallback quality first |
| Incident: retry storm | flush queue on close = 50× load spike; shed on open, don't buffer |
| Incident: false trip | threshold at 5× baseline causes trips on deploy noise — use 10× |
