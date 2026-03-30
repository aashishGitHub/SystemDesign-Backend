# Interview Questions: Rate Limiting

> Attempt all questions before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.

---

## Level 1 — Fundamentals & API Contracts
*Goal: verify core understanding before implementation.*

**Q1.** What exact system problem does rate limiting solve, and why is authentication alone not enough?

**Q2.** What is the difference between *rate limiting*, *throttling*, and *quotas*?

**Q3.** Which entities should be limit keys in a real API platform (`user_id`, IP, API key, tenant, endpoint), and when does each one fail?

**Q4.** Why should a rejected request return `429 Too Many Requests`, and what response headers should be included?

---

## Level 2 — Algorithm Selection
*Goal: choose the correct algorithm for required behavior.*

**Q5.** Token bucket vs leaky bucket: what user-visible behavior differs during burst traffic?

**Q6.** Why does a fixed-window counter cause boundary burst unfairness (double-spend around minute edges)?

**Q7.** Sliding-window log vs sliding-window counter: what precision/memory tradeoff do you get?

**Q8.** For these endpoints, which algorithm would you pick and why: login API, search API, webhook ingestion API, and payment create API?

---

## Level 3 — Single-Node Implementations
*Goal: implement a correct limiter in one process first.*

**Q9.** What minimal state must a token bucket maintain per key, and how is it updated per request?

**Q10.** Why must limiter math use monotonic time rather than wall-clock time?

**Q11.** If you keep in-memory counters for 5 million active keys, what memory risks appear and how do you mitigate them?

**Q12.** Why does a local in-memory limiter become incorrect once you scale API gateways horizontally?

---

## Level 4 — Distributed Enforcement with Redis
*Goal: enforce one shared limit across many gateway replicas.*

**Q13.** What race condition exists in naive Redis `INCR` then `EXPIRE` rate-limit code?

**Q14.** Why is a Lua script (or atomic server-side command) preferred for token consumption?

**Q15.** How do you design Redis keys to avoid hot-key bottlenecks for very popular tenants?

**Q16.** In multi-region systems, should rate-limit state be globally shared or region-local with safety buffers?

---

## Level 5 — Correctness, Retries, and Failure Modes
*Goal: avoid false blocks and abuse gaps in production.*

**Q17.** How can client retries incorrectly consume extra tokens, and how do idempotency keys help?

**Q18.** When should a limiter fail-open vs fail-closed if Redis is unavailable?

**Q19.** How does clock skew between gateway nodes affect refill math and fairness?

**Q20.** Redis latency spikes to 200ms: what protection pattern should the gateway use to avoid cascading failures?

---

## Level 6 — Policy & Product Design
*Goal: model limits that match business plans and abuse controls.*

**Q21.** How do you combine hierarchical limits (global tenant + per-user + per-endpoint) in one decision?

**Q22.** How do weighted costs (`POST /upload` costs 10 tokens, `GET /profile` costs 1) change limiter design?

**Q23.** A customer upgrades from free to pro. How do you apply new limits without redeploying gateways?

**Q24.** How do you exempt trusted internal traffic safely without creating a bypass attackers can abuse?

---

## Level 7 — Observability & Operations
*Goal: run the limiter as a production platform service.*

**Q25.** Which metrics are mandatory for a rate limiter (correctness + performance + business)?

**Q26.** How do you detect that your limiter is blocking legitimate traffic (false positives)?

**Q27.** What load tests should you run before enabling a new limit policy globally?

**Q28.** During an incident caused by an overly strict policy, what rollback controls should exist?

---

## Level 8 — Architect-Level Tradeoffs
*Goal: show deep system thinking beyond textbook implementations.*

**Q29.** How do edge/CDN rate limits and gateway rate limits complement each other?

**Q30.** Why combine rate limiting with concurrency limiting for expensive downstream services?

**Q31.** Attackers rotate IPs via botnets. What additional identity signals should rate limiting use?

**Q32.** When are approximate algorithms (Count-Min Sketch, Bloom filters) acceptable in rate limiting?

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** How will we version and audit policy changes for compliance and incident forensics?

**QB2.** What is our migration strategy when changing algorithm type (fixed window → token bucket) for a live tenant?

**QB3.** What customer-facing dashboard fields should expose limit usage and reset estimates?

**QB4.** Which endpoints should never share the same bucket, even for the same tenant?
