# System Design: Real-Time Event Aggregation (Ad Click Aggregation, Telemetry Pipelines)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber — and any team whose job title includes "real-time," "telemetry," or "analytics" (an Event Hub / streaming-analytics team, for example).
> **Style:** Interview-grill format — question first, then defended choices.

---

## How to Use This Guide

1. Start with [simple-diagram.md](./simple-diagram.md) — the one mental model everything else hangs off.
2. Attempt [questions.md](./questions.md) cold, level by level.
3. Check yourself against [answers.md](./answers.md).
4. Whiteboard the system from [diagrams.md](./diagrams.md) — 13 diagrams plus the one-page master.
5. Go deep with [deep-dive.md](./deep-dive.md) for failure modes, capacity math, and real-world implementations.
6. Revise from the 🎯 master diagram at the end of `diagrams.md`, the night before.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals | Why `COUNT(*)` breaks, tumbling vs sliding windows, why exactly-once is a myth |
| 2 | Requirements & Scale | Clarifying questions, back-of-envelope throughput, ranking SLAs |
| 3 | Ingestion API | Idempotent `POST /events`, backpressure, buffering vs failing fast |
| 4 | Partitioning & Delivery | Kafka partition keys, consumer groups, rebalances, at-least-once + idempotency |
| 5 | High-Level Architecture | Hot path vs cold path, Lambda vs Kappa, where OpenSearch and Redis fit |
| 6 | Counting at Scale | Count-Min Sketch, HyperLogLog, watermarks, late data, reconciliation |
| 7 | Reliability & Scaling | Circuit breakers, rate limiting, multi-tenant isolation, multi-region failover |
| 8 | Observability & Trade-offs | Defining "system health," lag-as-age, silent data loss, cost trade-offs |

---

## Files

| File | Purpose |
|---|---|
| [simple-diagram.md](./simple-diagram.md) | **Start here.** The drawable mental model, plus a detailed reference version. |
| [questions.md](./questions.md) | 41 leveled questions + 4 bonus, L1 → L8. Attempt cold. |
| [answers.md](./answers.md) | Every answer, with code or a table, ending in a Key takeaway. |
| [diagrams.md](./diagrams.md) | 13 whiteboard-ready diagrams, plus the 🎯 one-page master diagram. |
| [deep-dive.md](./deep-dive.md) | 🟢🟡🔴 depth — capacity math, failure modes, real-world implementations. |

---

## Problem Statement

> Design a real-time event-ingestion and aggregation system — ad clicks, or any high-volume product telemetry (player heartbeats, impressions, interactions) — shared across multiple apps/brands. The system must power a live, near-real-time dashboard **and** produce exact, auditable totals for reporting or billing.
>
> **POST /events** — ingest a batch of events, idempotently.
> **GET /dashboard/{metric}** — read a live, windowed aggregate.
> **GET /reports/{metric}?date=** — read an exact, reconciled total.

**Key Constraints:**
- ~50M DAU across 4 apps/brands, ~20 events/session → **~12K events/sec average, ~60–90K peak** (5–8x for a live event)
- Live dashboard: **seconds of staleness acceptable**, approximate counts acceptable
- Reporting/billing totals: **must be exact**, must be reproducible/auditable from raw data
- No event may be silently lost between ingestion and the exact report, even under retries, rebalances, or a regional outage
- Multi-tenant: one brand's traffic spike must not degrade another brand's pipeline

---

## Patterns in play

| Pattern | Role | Where it shows up here |
|---|---|---|
| [Scaling Writes](../../patterns/scaling-writes.md) | ● central | L4, L6 Q16–Q17, Q26 — the ingestion firehose, and the hot-key counter trap |
| [Counting & top-K at scale](../../patterns/README.md#gaps--recurring-sub-problems-not-yet-written-up) | ● central | L6 Q26–Q30 — Count-Min Sketch, HyperLogLog; this topic is the authoritative depth for this gap pattern |
| [Real-Time Updates](../../patterns/realtime-updates.md) | ○ present | L5, L8 Q25 — hop 2, counters pushed to the dashboard over SSE |
| [Multi-Step Processes](../../patterns/multi-step-processes.md) | ○ present | L3, L4 Q12, Q19 — idempotency as the universal tax, the dual-write problem |
| [Long-Running Tasks](../../patterns/long-running-tasks.md) | ○ present | L6, L7 Q30–Q31 — the nightly batch reconciliation job as a sweeper |

---

## Real-Time Event Aggregation in an Interview

### When to reach for this design
- The prompt says "real-time," "telemetry," "analytics pipeline," or names a metric that needs both a live view and an exact report.
- "Design ad click aggregation," "design a view-count system," "design a metrics/monitoring ingestion pipeline."
- A JD or prompt explicitly asks you to "define what system health means" for a data pipeline.

### Where it breaks down (know the limits)
- If there's no live-dashboard requirement at all, you don't need the hot path — just an exact batch pipeline. Don't build Lambda when Kappa-without-a-speed-layer (plain batch) would do.
- If every event is individually high-value (a payment, an order), this is the wrong topic — that's [payment-system](../payment-system/) or [e-commerce](../e-commerce/), not aggregation.
- Approximate counting structures (Count-Min Sketch, HLL) are the wrong answer the moment a regulator or a contract requires an exact number at read time, not just eventually.

### The five sentences that score
1. "One log, read twice — a fast approximate path and a slow exact path, never merged into one system."
2. "Exactly-once delivery doesn't exist — I get exactly-once effect from at-least-once delivery plus an idempotent consumer."
3. "I partition by the entity that needs ordering, and the partition count is also my consumer-parallelism ceiling."
4. "The cold, replayed number always wins reconciliation — it corrects the hot number in place."
5. "System health here is lag measured as age, not count — because count lies across different throughput levels."

---

## How a Senior Engineer Thinks About This

The naive instinct is to build one pipeline that's "real-time and accurate" — and that instinct is the whole trap. A stream processor that waits for every possible late event to arrive before reporting a number isn't real-time anymore; a stream processor that reports the instant a window closes is real-time but will occasionally be wrong. The senior move is refusing to let one system be graded on both axes, and instead building two: a **speed layer** that's cheap, approximate, and fast, and a **batch layer** that's exact and slow, with an explicit reconciliation step that lets the exact number correct the approximate one after the fact, without anyone re-running the whole pipeline.

The second insight is that **idempotency is not a nice-to-have bolted onto ingestion — it's the tax every layer of this system pays**, because at-least-once delivery is unavoidable the moment a network is involved. A client retries after a timeout. A Kafka producer retries after a lost ack. A consumer reprocesses after a rebalance. Each of these is a duplicate-delivery event, and each layer needs its own idempotency mechanism — a client-supplied key at the door, sequence numbers into the log, `event_id` dedupe in consumer state — because no single layer can absorb all three failure modes on its own.

The third insight, and the one a JD asking "define system health" is really testing, is that **the metrics that catch real incidents are not the obvious ones**. Error rate and raw throughput stay green during the worst failure mode in this whole topic — a client silently going quiet — because a healthy-looking pipeline processing zero events from one source produces no errors at all. Consumer lag measured as *age*, not count, and a per-source expected-rate baseline are the two signals that actually catch what error-rate dashboards miss. Naming that unprompted, with the specific reason count-based lag lies, is what separates a candidate who's operated one of these pipelines from one who's only designed one on a whiteboard.
