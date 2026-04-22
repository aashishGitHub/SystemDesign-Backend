# System Design: Rate Limiting

> **Target:** Senior / Staff backend engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended implementation choices.

---

## How to Use This Guide

1. Attempt each question in `questions.md` without opening answers.
2. Check your reasoning in `answers.md`.
3. Use `deep-dive.md` to practice senior/staff depth, failure modes, and production tradeoffs.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Requirements | Why rate limiting exists and what to limit |
| 2 | Core Algorithms | Token bucket, leaky bucket, fixed/sliding windows |
| 3 | Single-Node Implementations | In-memory and local gateway limiters |
| 4 | Distributed State | Redis-based limits across many API servers |
| 5 | Correctness & Race Conditions | Atomicity, clock skew, retries, idempotency |
| 6 | Policy Design | Per-user/IP/tenant/endpoint plans and quotas |
| 7 | Multi-Layer Architecture | Edge + gateway + service-layer enforcement |
| 8 | Operations & Scale | Capacity planning, observability, incident handling |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 32 structured interview questions (8 levels + bonus). |
| [answers.md](./answers.md) | Answers keyed to each question, with code/table per answer. |
| [deep-dive.md](./deep-dive.md) | Beginner → Senior → Architect depth, failure modes, and cheat sheet. |

---

## Problem Statement

> Design a global rate-limiting system for a public API platform.
> Every request must be evaluated in low latency and either allowed or rejected with a clear policy reason.
>
> The system should support:
> - `per-user`, `per-IP`, `per-tenant`, and `per-endpoint` limits
> - burst handling (short spikes) and sustained quotas (per minute/hour/day)
> - distributed enforcement across many API gateway replicas and regions
> - policy updates without gateway restarts

**Key Constraints:**
- Peak traffic: **3M requests/sec** globally
- Rate-limit decision p99: **<= 5ms** at the gateway
- High availability: limiter should not become single point of failure
- Correctness: avoid overselling tokens due to race conditions
- Operational controls: route-specific fail-open or fail-closed behavior

---

## How a Senior Engineer Thinks About This

A strong answer separates **policy** from **enforcement**. Policy defines who gets what quota (free tier vs paid, endpoint weight, burst multipliers). Enforcement is a hot-path decision engine that must stay fast and predictable under load.

Next, they choose the algorithm by behavior requirement, not trend: token bucket for burst tolerance, sliding window counter for smoother fairness, and fixed windows only when simplicity is more important than precision.

Finally, they reason about failure modes first: Redis outage, network partition, hot keys, and clock skew. A senior design explicitly states degraded behavior (`fail-open` for non-critical read APIs, `fail-closed` for write-heavy abuse-prone routes) and includes alerts/runbooks before launch.
