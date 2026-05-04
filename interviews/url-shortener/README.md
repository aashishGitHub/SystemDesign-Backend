# URL Shortener (TinyURL / Bitly) — System Design Interview Guide

**Target Audience:** Senior (L5) and Staff (L6+) engineers interviewing at Google, Meta, Amazon, Microsoft, Uber  
**Estimated Study Time:** 6–10 hours across 3 passes  
**Difficulty:** Medium-Hard (common screen) → Hard (Staff-level depth expected)

---

## How to Use This Guide (3-Pass Method)

| Pass | Time | Goal | Files |
|------|------|------|-------|
| **Pass 1 — Orientation** | 30 min | Understand the problem space, constraints, and tradeoffs at a high level | `README.md` → `deep-dive.md` §1–2 |
| **Pass 2 — Drill** | 2–3 hrs | Work through every question blind (cover answers), then self-grade | `questions.md` → `answers.md` |
| **Pass 3 — Simulate** | 45 min | Whiteboard a full design in 45 min. Use the cheat sheet only for numbers | `deep-dive.md` Quick Recall Cheat Sheet |

**Pro tip:** On Pass 2, speak your answers aloud. Interviewers evaluate communication, not just correctness.

---

## Learning Path (8 Levels)

| Level | Theme | Mastery Signal |
|-------|-------|----------------|
| **L1 — Fundamentals** | What is URL shortening, why it exists, basic flow | Can explain to a PM or non-engineer without jargon |
| **L2 — Encoding & ID Generation** | Base62, MD5, Snowflake, counter service | Can compare approaches and cite failure modes for each |
| **L3 — Redirect & HTTP** | 301 vs 302, redirect latency, caching headers | Can explain analytics implications of HTTP status codes |
| **L4 — Caching & Read Optimization** | Redis, cache-aside, TTL, hot-key problem | Can design a cache layer that handles 115K req/sec |
| **L5 — Analytics** | Click counting, geo/device tracking, async pipelines | Can design analytics that don't slow down redirects |
| **L6 — Scale & Sharding** | DB sharding, replication, consistent hashing | Can partition 100M URLs/day across multiple DB nodes |
| **L7 — Abuse & Security** | Rate limiting, URL blacklisting, spam prevention | Can reason about adversarial users at scale |
| **L8 — Architect-Level** | 5-nines HA, multi-region, SLO design, post-mortems | Can design for Google-scale reliability |

---

## Files in This Guide

| File | Purpose | Lines |
|------|---------|-------|
| `README.md` | Orientation, learning path, problem statement | ~120 |
| `questions.md` | 35+ interview questions across 8 levels | ~200 |
| `answers.md` | Full answers with TypeScript code and comparison tables | ~800 |
| `deep-dive.md` | 8 deep-dive sections with analogies, code, failure modes | ~1000 |

---

## Problem Statement

Design a URL shortening service like TinyURL or Bitly.

**Core Behavior:**
- A user submits a long URL (e.g., `https://www.example.com/some/very/long/path?with=query&params=true`)
- The service returns a short URL (e.g., `https://tinyurl.com/abc1234`)
- When a user visits the short URL, they are redirected to the original long URL
- Optionally: the user may request a custom alias (e.g., `tinyurl.com/my-launch`)

### Exact Constraints

| Constraint | Value | Notes |
|-----------|-------|-------|
| URL creation rate | 100M / day | ~1,157 writes/sec average |
| Redirect rate | 10B / day | ~115,741 reads/sec average |
| Peak redirect rate | ~115K / sec | Assume 2× average for peak |
| Read:Write ratio | 100:1 | Extremely read-heavy |
| Short code length | 7 characters | |
| Alphabet | Base62 (a-z, A-Z, 0-9) | 62^7 = 3.5 trillion codes |
| Redirect latency SLO | < 10ms P99 | Must be served from cache |
| Data retention | 5 years default | Earlier if URL has explicit TTL |
| URL max length | 2048 characters | Standard browser limit |
| Availability target | 99.99% | ~52 min downtime/year |

### Non-Functional Requirements (Senior-level scope)
- Globally unique short codes (no duplicates ever)
- Short codes must not be predictable (no sequential guessing)
- Analytics: total clicks, unique visitors, geo breakdown, device type
- Custom aliases with availability check
- Abuse prevention: rate limiting, malware URL blocking
- Multi-region read replicas for < 10ms P99 globally

---

## How a Senior Engineer Thinks About This

A senior engineer does not immediately jump to "I'll use a hash function." They first ask: **what are the invariants?** The most critical invariant here is global uniqueness of short codes — once a code is issued, it must map to exactly one long URL forever (within its TTL). Collision on a short code means a user who clicks a link lands on the wrong page. That is worse than a 404. The entire encoding and ID generation strategy flows from this constraint.

The second thing a senior engineer notices is the **asymmetry of the workload**. With a 100:1 read:write ratio and a < 10ms P99 latency SLO, the redirect path must never touch the database on the hot path. Every redirect must be served from a cache layer (Redis or a CDN edge cache). This means the entire architecture is shaped by cache design — TTL strategy, cache invalidation on expiry, and what happens on a cache miss. The "write path" (URL creation) is comparatively boring; the "read path" (redirect) is where the design lives or dies.

The third insight is that **analytics and redirect must be decoupled**. If you try to count every click synchronously in the redirect handler, you add latency and become a bottleneck. The standard production pattern is to return the 302 immediately and emit an event to Kafka/Kinesis asynchronously. A separate analytics consumer service processes these events, aggregates by short code, and writes to a time-series or column store. This is exactly what Bitly does. The redirect path stays under 10ms; the analytics pipeline has its own SLO (e.g., < 5 minutes eventual consistency on click counts).
