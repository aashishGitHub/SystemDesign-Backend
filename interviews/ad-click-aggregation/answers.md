# Answers: Real-Time Event Aggregation (Ad Click Aggregation / Telemetry Pipeline)

> Keyed to [questions.md](./questions.md). Each answer opens with the one-sentence answer, then the reasoning, then a table or code block. Every answer ends with a **Key takeaway**.

---

## Level 1 — Fundamentals

### A1. Telemetry vs a business event

Telemetry is a **fact about system or user behavior**, emitted at high volume, that nobody needs to see individually. A business event ("order placed") is **low volume and individually important** — someone reads that exact row.

| | Telemetry (ad click, player heartbeat) | Business event (order placed) |
|---|---|---|
| Volume | Millions/sec | Hundreds/sec |
| Value of one row | Near zero alone | High alone |
| What you query | Aggregates over time windows | The specific row, by ID |
| Loss tolerance | A few dropped events, acceptable | Zero — it's money or state |

**Key takeaway:** Telemetry is valuable in aggregate; a business event is valuable individually — that difference decides every storage choice downstream.

---

### A2. Why `COUNT(*)` stops working

`COUNT(*)` scans rows at read time. At a few million rows/day it's fine. At a few billion/day, every dashboard refresh becomes a full-table scan competing with every other dashboard refresh, and the table itself becomes too large to index cheaply.

The fix is to **stop counting at read time** and start counting at write time: increment a windowed aggregate as each event arrives, so a read is an O(1) lookup, not an O(n) scan. This is [Scaling Writes](../../patterns/scaling-writes.md)'s core move — aggregate before you write, don't aggregate when you're asked.

**Key takeaway:** Move the counting from read-time (`COUNT(*)`) to write-time (streaming increment) the moment volume outgrows one scan's budget.

---

### A3. Tumbling vs sliding windows

| Window type | Shape | Use case |
|---|---|---|
| **Tumbling** | Fixed, non-overlapping (e.g. 0:00–0:01, 0:01–0:02) | "Clicks per minute" for a dashboard — each event belongs to exactly one window |
| **Sliding** | Fixed size, overlapping, re-evaluated on a smaller step (e.g. 5-min window, 10-sec step) | "Rolling 5-minute error rate" for alerting — you want a smooth, continuously updated signal |

```
Tumbling: |--1min--|--1min--|--1min--|
Sliding:  |----5min----|
             |----5min----|
                |----5min----|
```

**Key takeaway:** Tumbling windows partition time cleanly for reporting; sliding windows smooth a signal for alerting.

---

### A4. Exactly-once is a misleading phrase

**Exactly-once *delivery* is impossible over an unreliable network** — you cannot tell "the ack was lost" apart from "the message was lost," so a sender must always be free to retry. What's achievable is **exactly-once *effect***: at-least-once delivery, plus a receiver that makes duplicate delivery a no-op.

```
send(msg) → no ack received → resend(msg)
  # receiver either never got it (retry is correct)
  # or got it and the ack was lost (retry must be a no-op)
  # the sender cannot tell these apart — so it must always retry,
  # and the receiver must always dedupe.
```

**Key takeaway:** You can't get exactly-once delivery; you get at-least-once delivery plus an idempotent consumer, which is the same outcome.

---

### A5. "Kafka guarantees exactly-once" — the misconception

Kafka's exactly-once semantics (idempotent producers + transactions) guarantee exactly-once **within Kafka** — a producer won't duplicate a record into a Kafka topic, and a consumer-then-produce chain can commit atomically. It does **not** extend to a side effect outside Kafka — incrementing a Redis counter, calling a billing API, writing to S3 — unless that side effect is itself made idempotent.

**Key takeaway:** Kafka's exactly-once stops at Kafka's boundary; any external side effect still needs its own idempotency key.

---

## Level 2 — Requirements & Scale

### A6. Clarifying questions for this design

Ask these before drawing anything, in this order — each one changes the architecture:

1. **What's the event?** Ad clicks, player heartbeats, both? (Changes cardinality and schema.)
2. **Who reads it, and how fresh does it need to be?** A live ops dashboard (seconds) vs a billing report (hours) are different systems.
3. **Does this feed billing or fraud decisions?** If yes, exactness and auditability are non-negotiable somewhere in the pipeline.
4. **Shared across how many apps/tenants?** One noisy tenant must not be able to starve the others.
5. **What's the retention/replay requirement?** "Can we recompute last Tuesday's numbers" decides whether you keep raw events at all.

**Key takeaway:** The first question that matters is "who reads this, and how fresh does it need to be" — it's the one that splits hot path from cold path.

---

### A7. Sizing the throughput

```
50,000,000 DAU
× 20 events / session (assume ~1 session/user/day for the estimate)
= 1,000,000,000 events/day
÷ 86,400 s/day
≈ 11,600 events/sec average
```

Real traffic isn't flat — assume a **peak-to-average ratio of 5–8x** for a live-event-driven product (a season finale, a live match): **~60,000–90,000 events/sec peak**. State this ratio explicitly; don't silently design for average and get surprised by peak.

**Key takeaway:** ~1B events/day is ~12K/sec average — but design and load-test for 5–8x that at peak, not the average.

---

### A8. Ranking the SLAs

| SLA | Priority here | Why |
|---|---|---|
| **Durability** | Highest | A lost event that feeds billing is a compliance problem, not a bug |
| **Availability of ingestion** | High | The client can't hold events forever; the door must stay open |
| **Consistency of the read path** | Low, tunable | Dashboards can be seconds stale; that's the whole point of the hot/cold split |
| **Latency of ingestion ack** | Medium | Fast enough that clients don't build up local backlogs, not sub-ms |

**Key takeaway:** Durability of the write beats freshness of the read — you can always recompute a stale aggregate, never an event you never durably accepted.

---

### A9. Staleness: live dashboard vs daily report

A "live viewers" dashboard can be **10–30 seconds stale** — nobody notices, and the cost of exactness (waiting for every last-arriving event) isn't worth it. A "daily ad revenue" report must be **exact**, because someone gets paid or billed from that number, and being 0.5% off is a real dollar discrepancy at scale.

This single answer is why the architecture forks into two paths instead of one: **one system cannot cheaply be both fast and exact**, so don't ask it to be.

**Key takeaway:** "How stale can this be" is the one product question that determines whether you need one pipeline or two.

---

### A10. Exact counts AND sub-second dashboards *(Failure mode)*

They're different systems because they're different trade-offs on the **same underlying data**, not different data. A sub-second dashboard needs an in-memory, approximate, windowed aggregate — waiting for every late event would make it not sub-second anymore. An exact billing number needs to wait for the *last* late event and recompute — which makes it not sub-second.

The failure mode is trying to serve both from one code path: you either make the dashboard slow (waiting for lateness), or you make billing wrong (closing windows too early). The fix is the Lambda split in A22 — two paths, reconciled, never merged into one.

**Key takeaway:** Don't build one system that's both fast and exact — build a fast approximate one and a slow exact one, and reconcile them.

---

## Level 3 — Ingestion API Design

### A11. The ingestion endpoint

```http
POST /v1/events
Idempotency-Key: <client-generated UUID per batch>
Content-Type: application/json

{
  "tenant_id": "espn-plus",
  "session_id": "sess_9f2a...",
  "events": [
    { "event_id": "evt_01...", "type": "ad_click", "ts": "2026-09-21T10:00:03.120Z", "ad_id": "ad_442", "attrs": {...} },
    { "event_id": "evt_02...", "type": "ad_click", "ts": "2026-09-21T10:00:04.900Z", "ad_id": "ad_119", "attrs": {...} }
  ]
}
```

| Response | Meaning |
|---|---|
| `202 Accepted` | Durably written to the log (or the outbox); processing is async |
| `400 Bad Request` | Malformed batch — reject before it touches the log |
| `409 Conflict` (optional) | Same `Idempotency-Key` already accepted, different body — reject, don't silently accept |
| `429 Too Many Requests` | Backpressure — see A14 |
| `503 Service Unavailable` | The log itself is unavailable — see A13 |

Batch, don't send one event per call — one HTTP round-trip per event at this volume is the throughput bottleneck, not Kafka.

**Key takeaway:** Batch client-side, ack with `202` once durably queued, and never `200` before the write is durable.

---

### A12. Idempotent retries from a mobile client

Every batch carries a client-generated `Idempotency-Key`. The ingestion service checks it against a short-TTL dedupe store (ElastiCache) with an atomic `SETNX` **before** producing to Kafka.

```go
func ingest(batch Batch) int {
    key := batch.IdempotencyKey
    // atomic: only one caller wins the SETNX
    isNew, err := redisClient.SetNX(ctx, key, "1", 24*time.Hour).Result()
    if err != nil {
        return http.StatusServiceUnavailable // circuit-break here — see A32
    }
    if !isNew {
        return http.StatusAccepted // already accepted — treat retry as success, not error
    }
    if err := kafkaProducer.Produce(topic, batch.Events); err != nil {
        return http.StatusServiceUnavailable
    }
    return http.StatusAccepted
}
```

Per-event `event_id`s (not just the batch key) let the hot-path stream processor dedupe again downstream, since Kafka's own producer retries can still create duplicate records at the log level.

**Key takeaway:** Dedupe at the door with a client-supplied idempotency key and an atomic `SETNX`, then dedupe again downstream by `event_id` because the log itself can still duplicate.

---

### A13. Kafka unavailable at ingestion time

The ingestion API must **never block the client** waiting for Kafka to come back — that just moves the outage onto every client's UI thread. Two defensible options, in order of preference:

1. **Local durable buffer** (e.g. write to an outbox table or a local disk-backed queue) and return `202`; a relay drains it into Kafka once it's healthy again.
2. If no local buffer exists, **fail fast with `503`** and a `Retry-After` header — the client already has retry logic from A12, so a fast, honest failure is better than a slow, silent one.

Blocking the HTTP thread on Kafka is the wrong answer in both cases — it turns a Kafka outage into an ingestion-tier outage too.

**Key takeaway:** Never let a downstream outage become a synchronous block on the client — buffer locally or fail fast, never hang.

---

### A14. Backpressure

Backpressure has to be visible at three layers, or it just moves the queue somewhere invisible:

| Layer | Signal | Response |
|---|---|---|
| Client → API | `429` with `Retry-After` | Client backs off and retries with jitter |
| API → Kafka | Producer's local send buffer fills | API stops accepting new batches, returns `429` |
| Consumer → downstream store | Redis/S3 write latency climbing | Consumer slows its poll loop; **never** drops the read from Kafka — the offset commit protects you |

The one thing backpressure must never do is silently drop data to relieve pressure — that turns a capacity problem into a correctness problem.

**Key takeaway:** Push backpressure all the way back to the client with `429` + `Retry-After`; never resolve it by silently dropping events.

---

### A15. Triplicate batch from a client bug *(Failure mode)*

| Layer | Catches it? | Cost |
|---|---|---|
| Ingestion API, `Idempotency-Key` check (A12) | Yes, if the client reused the same key on retry — cheapest | ~1 Redis round-trip |
| Ingestion API, if the client generated a *new* key each time (the actual bug) | No — looks like 3 distinct batches | — |
| Stream processor, dedupe by `event_id` | Yes | One extra state lookup per event in the hot path |
| Cold-path batch job, dedupe by `event_id` at recompute time | Yes, always — this is the backstop | Reprocessing cost, but correctness is guaranteed here |

If the bug generates a fresh idempotency key each retry, the door-level check (A12) can't catch it — that's exactly why `event_id`-level dedupe has to exist independently, deeper in the pipeline, and why the cold path is the final word.

**Key takeaway:** Idempotency keys catch retries with the same key; `event_id` dedupe catches everything else — you need both, and the cold path is always the backstop.

---

## Level 4 — Partitioning & Delivery Semantics

### A16. The partition key

Partition on **`session_id`** (or `user_id`), not `event_type` and not randomly. The key decides two things at once: which events are **ordered relative to each other** (only events with the same key are ordered), and which events **land on the same consumer**, which is what lets a stream processor keep per-session state without cross-partition coordination.

```
partition = hash(session_id) % num_partitions
```

Partitioning by `event_type` creates a handful of enormous, unevenly-loaded partitions (one per type) — the classic hot-partition mistake. Partitioning randomly loses ordering entirely.

**Key takeaway:** Partition by the entity you need ordered and colocated — `session_id` here — never by a low-cardinality field like event type.

---

### A17. Partition count and its real ceiling

Start from throughput, not a round number: if one partition sustains **~5–10 MB/s** (a reasonable planning number, `⚠️ verify` against current Kafka/MSK guidance) and you need ~90K events/sec peak at ~500 bytes/event (~45 MB/s), that's **roughly 5–9 partitions** for throughput alone — but the real ceiling partition count sets is **maximum parallel consumers**. One partition is read by exactly one consumer in a group at a time, so partition count is a hard cap on horizontal scale-out, not just a throughput dial.

**Key takeaway:** Partition count isn't just a throughput number — it's the hard ceiling on how many consumers can ever work the topic in parallel.

---

### A18. Consumer group rebalances

A rebalance fires when a consumer joins, leaves, crashes, or is considered dead by a missed heartbeat, or when partition count changes. During a rebalance, **all consumers in the group pause** while partitions are reassigned — in-flight, uncommitted work on the reassigned partitions gets **reprocessed** by whichever consumer picks them up next, from the last committed offset.

```
Before: [P0,P1] → C1   [P2,P3] → C2
C2 crashes → rebalance → ALL consumers pause
After:  [P0] → C1   [P1,P2,P3] → C1  (or redistributed)
```

This is exactly why offset-commit timing (A19) and idempotent processing matter — a rebalance guarantees some reprocessing will happen.

**Key takeaway:** A rebalance pauses the whole group and reprocesses some work from the last committed offset — design consumers to be idempotent, not to avoid rebalances.

---

### A19. At-least-once + idempotent effect

Pick **at-least-once** for the hot path — it's cheaper and simpler than Kafka's exactly-once transactions, and the stream processor needs idempotent state updates anyway to survive rebalances (A18). Get the exactly-once *effect* by keying every state update on `event_id`:

```java
void apply(Event event, StateStore stateStore) {
    if (stateStore.hasSeen(event.getEventId())) {   // idempotency check
        return;
    }
    stateStore.increment(event.getWindowKey(), event.getEventId());
}
```

This is the same idempotency tax that shows up at every layer of this system — see [Multi-Step Processes §9](../../patterns/multi-step-processes.md#9-idempotency-why-exactly-once-is-a-lie).

**Key takeaway:** At-least-once delivery plus a dedupe-by-`event_id` state update gives you exactly-once effect without Kafka transactions.

---

### A20. Poison message on one partition *(Failure mode)*

**Other partitions are unaffected** — each partition is consumed and committed independently, so one stuck partition doesn't block the others (unless a single-threaded consumer is reading all of them, which is the actual mistake to avoid). For the stuck partition itself: retry a bounded number of times with backoff, then move the message to a **dead-letter topic** and advance the offset so the partition can proceed — don't let one bad record halt the whole partition forever.

**Key takeaway:** Isolate poison messages to a DLQ after bounded retries so one bad record can't halt an entire partition indefinitely.

---

## Level 5 — High-Level Architecture

### A21. The two paths

```
Clients → Ingestion API → Kafka (the one log)
                              │
                 ┌────────────┴────────────┐
                 ▼ hot path                 ▼ cold path
        Stream processor              S3 archive
        (windowed, approx)            (raw, exact)
                 │                          │
                 ▼                          ▼
        Redis counters → Dashboard    Batch job → Reporting store
```

Both paths read the **same log**, independently, at their own pace. Neither path is a dependency of the other in real time — the cold path's only relationship to the hot path is the nightly reconciliation in A30.

**Key takeaway:** One log, two independent readers — a fast approximate one and a slow exact one — never one path feeding the other in real time.

---

### A22. Lambda architecture

Lambda architecture is exactly the split in A21, named: a **speed layer** (stream processing, approximate, low latency) and a **batch layer** (exact, replayed from the raw log, high latency), with a **serving layer** that merges both for queries — recent data from the speed layer, corrected historical data from the batch layer.

| Cost | Why |
|---|---|
| Two codebases | The aggregation logic is written twice — once as a stream job, once as a batch job — and they must agree |
| Operational overhead | Two systems to run, monitor, and page on, not one |
| Reconciliation logic | Someone has to own "when the batch layer disagrees with the speed layer, which wins, and how do we correct the served number" |

**Key takeaway:** Lambda buys you fast approximate results and exact results from the same data, at the cost of maintaining the aggregation logic twice.

---

### A23. Kappa architecture

Kappa drops the batch layer and treats **everything as a stream**, including reprocessing — instead of a separate batch job over S3, you replay the Kafka log from an earlier offset through the same stream processor to recompute. It's the right call when the stream processor's aggregation logic is already correct and cheap enough to re-run, and you don't want to maintain two codebases.

It's the *wrong* call when reprocessing needs fundamentally different compute (e.g. a Spark join across datasets that don't fit a streaming model), or when your Kafka retention window is shorter than how far back you'd ever need to recompute — Kappa needs the log itself to be the replayable source of truth, not a separate archive.

**Key takeaway:** Kappa trades the batch layer for "replay the stream" — pick it when reprocessing logic can run as a stream job and retention covers your recompute window.

---

### A24. Where OpenSearch fits — and doesn't

OpenSearch fits as the **query layer for humans** — ad-ops and support engineers running ad-hoc, faceted queries ("clicks on ad X, from region Y, last Tuesday") through Kibana/OpenSearch Dashboards. It's fed by the cold path, as a derived index.

It does **not** belong as: the ingestion target (no idempotent write semantics the way Kafka has), the hot-path counter store (ElastiCache is far cheaper and faster for a single windowed number), or the source of truth for billing (it's a derived index — if it's ever the *only* place a number lives, the design has a gap, per [`AWS_SERVICE_MAP.md` §2](../../docs/AWS_SERVICE_MAP.md#2-patterns--aws-realization)).

**Key takeaway:** OpenSearch is the human ad-hoc query layer over the cold path, never the ingestion target and never the sole source of a billed number.

---

### A25. Where ElastiCache fits

ElastiCache (Redis) holds the **windowed counters the dashboard reads** — the output of the hot-path stream processor, keyed by window and dimension (e.g. `clicks:ad_442:2026-09-21T10:00`), with a short TTL. It serves what neither Kafka (a log, not queryable by key) nor OpenSearch (too slow for a sub-100ms dashboard tile) can serve directly: a single current number, read thousands of times a second, updated by atomic increments.

**Key takeaway:** Redis is the read path for "what's this counter right now" — atomic increments in, sub-ms reads out, nothing Kafka or OpenSearch is built for.

---

## Level 6 — Deep Dive: Counting at Scale

### A26. Why one atomic counter is the wrong answer

"Clicks per ad, globally, per minute" behind **one key** (`clicks:global:2026-09-21T10:00`) makes every one of ~90K events/sec at peak contend for **the same partition, the same key, the same lock**. That's a hot-partition problem no amount of horizontal scaling fixes, because the bottleneck is one key, not total capacity.

The fix is **write-sharded counters**: increment `clicks:global:{minute}:{shard}` where shard is `hash(event_id) % N`, spread across N keys, and sum the N shards only when reading. This is the exact trap [Scaling Writes](../../patterns/scaling-writes.md) names: same key ⇒ sharding the *system* doesn't help; you have to shard the *key*.

**Key takeaway:** A single hot key caps throughput regardless of cluster size — shard the counter itself across N keys and sum on read.

---

### A27. Count-Min Sketch

A Count-Min Sketch is a fixed-size grid of counters, updated by hashing an item through several hash functions and incrementing one cell per row; a query takes the **minimum** across those cells as the estimate. It answers "approximately how many times has X occurred" in **fixed memory that doesn't grow with cardinality** — the trade you're making is a small, tunable, one-directional error (it can overestimate, never underestimate).

```go
func insert(item string, sketch [][]int, hashes []HashFunc) {
    for i, h := range hashes {
        sketch[i][h(item)%width]++
    }
}

func estimate(item string, sketch [][]int, hashes []HashFunc) int {
    min := math.MaxInt
    for i, h := range hashes {
        if v := sketch[i][h(item)%width]; v < min {
            min = v
        }
    }
    return min
}
```

This answers "how many clicks on ad X" cheaply when the cardinality of ads is too large to keep an exact counter per ad in memory.

**Key takeaway:** Count-Min Sketch trades a small, one-sided overcount error for memory that doesn't scale with the number of distinct keys.

---

### A28. HyperLogLog and the unique-viewer problem

"Total events" is a sum — one number goes up per event, and any counter design handles it. "Unique viewers" requires knowing whether you've **seen this specific viewer before**, which naively means storing every viewer ID you've seen — memory that grows with cardinality, not with count.

HyperLogLog (HLL) estimates cardinality in **fixed memory** (a few KB, regardless of whether the true count is a thousand or a billion) by hashing each item and tracking the longest run of leading zeros observed — a statistical estimator with a small, well-characterized error (~1–2% typical `⚠️ verify` against the specific implementation).

**Key takeaway:** Counting events is a sum; counting *unique* things is a cardinality-estimation problem — that's what HyperLogLog is for, in fixed memory.

---

### A29. Late-arriving events

Define a **watermark** — how long a window stays open for late data after its nominal end (e.g. a 1-minute window stays open an extra 2 minutes). Events arriving within the watermark update the still-open aggregate. Events arriving **after** the watermark closes are counted in a separate "late events" bucket and folded in by the next cold-path reconciliation (A30) — they don't reopen a window that's already been reported, because that would make every downstream consumer's "final" number not actually final.

**Key takeaway:** A watermark bounds how long you wait for late data; anything later than that is corrected by the cold path, not by reopening a closed window.

---

### A30. Reconciling hot (2.1M) vs cold (2.4M) *(Failure mode)*

**The cold-path number is authoritative** — it's computed from the complete, replayed raw log with no watermark cutoff, while the hot number is a windowed estimate that, by design, excluded late arrivals (A29) and may carry sketch error (A27/A28).

Reconciliation doesn't mean "re-run everything": the batch job **overwrites the reporting-store number** for that hour, and — if the dashboard needs to reflect it — pushes a correction to the same Redis key the hot path wrote, tagged so the UI can show "recomputed." You never re-run the *stream processor* retroactively; you let the batch layer's output supersede it for anything already closed.

**Key takeaway:** The cold, replayed, watermark-free number always wins reconciliation — it corrects the hot number in place, it doesn't trigger a hot-path replay.

---

## Level 7 — Reliability & Scaling

### A31. Stream processor down for 20 minutes

**Nothing is lost** — Kafka's retention (days, not minutes) means the events the processor would have consumed are still sitting in the log. On restart, the consumer group resumes from its **last committed offset**, and the 20 minutes of backlog get processed as fast as the processor can catch up — the dashboard is stale for that window, then jumps to current once it catches up. This is exactly why durability lives in the log, not in the processor.

**Key takeaway:** A dead stream processor causes staleness, not loss — Kafka retention plus offset resume means it catches up from exactly where it left off.

---

### A32. Where circuit breakers go

A circuit breaker belongs at **the ingestion API's call into any synchronous downstream dependency it can't buffer around** — most concretely, the idempotency check against ElastiCache. If Redis is unhealthy, the breaker trips: stop calling it, either fail fast or fall back to "accept without dedupe check" for a bounded window (a documented, deliberate trade-off, not a silent one), rather than letting every request hang on a dependency that's down.

It does **not** belong between the API and Kafka's own internal replication — that's Kafka's job, not the application's.

**Key takeaway:** Circuit-break the ingestion API's synchronous dependency (the dedupe store), not the durable log itself — that's a different failure domain.

---

### A33. Where to rate-limit

| Layer | Against whom | Why |
|---|---|---|
| Edge (WAF / API Gateway) | Per-client, coarse | Stop a single misbehaving client fast, before it reaches app logic |
| Ingestion service | Per-tenant (per brand) | Enforce the fair-share quota from A34 |
| Consumer side | Not typically rate-limited | The whole point of the log is to absorb bursts; slow the *processor's* poll loop instead (A14) |

**Key takeaway:** Rate-limit per-client at the edge for abuse, and per-tenant at the ingestion tier for fair-share — the log itself absorbs bursts, it doesn't need limiting.

---

### A34. One brand spikes, three brands must not starve

Give each tenant (brand) its **own Kafka topic** or, at minimum, a **quota-enforced share of ingestion throughput**, rather than one shared topic with no isolation. One shared topic means one brand's partition-level throughput ceiling is shared unfairly under load; per-tenant topics (or a token-bucket quota per tenant at the ingestion API) mean a spike on one brand can't consume another brand's headroom.

**Key takeaway:** Isolate tenants by topic or by an enforced per-tenant quota — a shared, unquota'd topic lets one brand's spike starve the rest.

---

### A35. Multi-region writes without double-counting

Assign each session to **one home region** (e.g. by geo-routing at the edge) so a given session's events are never produced from two regions simultaneously — this removes the double-count at the source rather than trying to dedupe it after the fact. Where cross-region failover happens (A36), the failed-over region's events carry the *same* `session_id`/`event_id` space, so the existing `event_id`-level dedupe (A15) catches any overlap during the failover window itself.

**Key takeaway:** Pin a session to one home region so you don't create the double-count in the first place; let existing `event_id` dedupe absorb the failover-window overlap.

---

### A36. Primary region goes down mid-event *(Failure mode)*

Failover to a standby region's Kafka cluster (MirrorMaker2 / MSK Replicator-style cross-region replication, kept warm `⚠️ verify` current tooling), accepting that you lose **events in flight that hadn't replicated yet** — the size of that loss is bounded by your cross-region replication lag, which you should be alerting on (A37) as its own health metric. Clients buffer locally (A13) and retry against the new regional endpoint once DNS/routing fails over.

Be explicit about the trade-off out loud: this is an availability-over-consistency choice for the ingestion tier, made worse the longer replication lag runs, which is exactly why lag is a first-class metric and not an afterthought.

**Key takeaway:** Regional failover bounds your loss to the replication-lag window — state that number out loud, don't imply zero loss.

---

## Level 8 — Observability & Architect Trade-offs

### A37. Five metrics that define system health

| # | Metric | Why it's on the list |
|---|---|---|
| 1 | **Consumer lag, as age** not count (see A38) | The single best "are we falling behind" signal |
| 2 | **End-to-end ingestion → dashboard latency (p50/p99)** | What the product actually promised — "real-time" |
| 3 | **Ingestion accept rate vs reject rate (`429`/`503`)** | Tells you if clients are being throttled or the door is closed |
| 4 | **Hot-path vs cold-path count delta, per hour** | Catches drift (A30) before it becomes a billing dispute |
| 5 | **Per-tenant throughput share** | Catches the A34 starvation failure before customers notice |

Deliberately not on the list: raw events/sec alone — it tells you volume, not health. A healthy system and an under-attack system can have the same events/sec.

**Key takeaway:** Health is lag-as-age, end-to-end latency, accept/reject rate, hot/cold delta, and per-tenant fairness — not raw throughput.

---

### A38. Lag as count vs lag as age

Lag as a **count** (messages behind) is misleading because the same count means very different things at different throughputs — 10,000 messages behind is instant at 1M/sec and alarming at 100/sec. Lag as **age** (how old is the oldest unprocessed message) is throughput-independent and directly answers the question that matters: "how stale is what the dashboard is showing right now." This is [Cross-Pattern Truth #5](../../patterns/README.md#the-cross-pattern-truths) — alert on age, not count.

**Key takeaway:** Lag-as-count depends on throughput and lies to you; lag-as-age is throughput-independent and answers "how stale, right now."

---

### A39. Detecting silent data loss

The dangerous case is a client type (e.g. one app's SDK) that silently stops sending — no errors anywhere, ingestion looks healthy, but one source just goes quiet. Detect it with a **per-source heartbeat expectation**: alert when any client type's event rate drops below its own historical baseline by more than X%, not just when it hits zero. A dead consumer produces zero errors and a flat graph — the only thing that catches it is comparing "what we expected from this source" against "what we got," continuously.

**Key takeaway:** Silent loss produces zero errors — catch it by alerting on a per-source rate dropping below its own baseline, not on error counts.

---

### A40. Retention: 3 vs 7 vs 30 days

| Retention | Buys you | Costs you |
|---|---|---|
| **3 days** | Enough replay buffer to recover from a multi-day incident | Cheapest; can't recompute anything older than 3 days from the log |
| **7 days** | Covers a full weekly cycle — recompute "last Tuesday" after a Friday bug report | Meaningfully more storage at billions of events/day |
| **30 days** | Recompute a full month for a billing dispute without touching S3 | Storage cost scales linearly; usually cheaper to serve month-old replay needs from the **S3 cold archive** instead, and keep Kafka retention short |

The senior answer names the actual trade-off: Kafka retention is expensive, fast replay; S3 retention is cheap, slow replay. Keep Kafka short (days) and let S3 hold the months-long archive, per A21's split.

**Key takeaway:** Keep Kafka retention short — it's the expensive, fast copy; let S3 be the cheap, long-lived archive for anything older.

---

### A41. "Why not skip Kafka and ingest straight into OpenSearch?" *(Trade-off)*

Because OpenSearch gives up two things Kafka gives you for free: **replay** (OpenSearch has no concept of "re-read everything from an hour ago in order" the way a log's offset does) and **decoupled consumers** (the hot path and cold path can't both read independently from an index the way they read independently from a partitioned log). Skip Kafka and you've coupled ingestion directly to one consumer's write pattern, and you've lost the ability to recompute (A30) or add a third reader later without touching the producer.

**Key takeaway:** Kafka buys replay and multiple independent readers; OpenSearch is a derived index for one kind of read, not a substitute for the log.

---

## Bonus — Questions a Senior Raises Unprompted

### AB1. Click fraud / bot traffic

Fraud detection is a **third reader of the same log**, not a change to ingestion — a dedicated stream job scores each click against velocity/pattern signals (same session clicking every ad in a page, impossibly fast click-after-impression timing) and writes a `fraud_score` alongside the event, which the cold-path billing recompute filters on. It must not live in the hot path's dashboard aggregation — mixing "is this real" scoring into "how many clicks" counting makes both slower and harder to reason about.

**Key takeaway:** Fraud scoring is a separate consumer of the same log, feeding the billing recompute — never inlined into the dashboard's counting path.

---

### AB2. If this data drives ad billing

Everything upstream of the number an advertiser is billed from needs an **audit trail**, not just a count: which raw events contributed, when they were ingested, and proof the recompute is reproducible from S3. This usually means the cold path's output is never just a number — it's a number plus a reference to the exact batch job run and input partition that produced it, so a billing dispute can be answered by replaying, not by trusting.

**Key takeaway:** Billing numbers need a reproducible audit trail back to raw events, not just a count — replayability *is* the auditability.

---

### AB3. Testing for exactly-once effect

Don't test "does Kafka claim exactly-once" — test the property directly: **send the same batch N times and assert the aggregate only moved once.** A good test harness replays a fixed event set through the ingestion API 1x, 2x, and 5x and asserts the cold-path recomputed total is identical across all three runs. Also test the failure injection case: kill the stream processor mid-window and assert the resumed aggregate matches a clean run.

**Key takeaway:** Test idempotency by literally sending duplicates and asserting the aggregate doesn't move — not by trusting a vendor's claim.

---

### AB4. MVP for a two-week live event

Cut the cold path's batch-recompute automation and the fraud-scoring consumer — keep them as a manual/on-call runbook instead of a scheduled job, since a two-week window doesn't need the full nightly reconciliation cadence. **Never cut**: the idempotent ingestion API, the durable log, or `event_id`-level dedupe — those are what make the MVP's numbers trustworthy even if the automation around them is thin. The smallest *correct* version is "durable log + idempotent ingestion + one hot-path consumer," with cold-path recompute done by hand if a dispute comes up.

**Key takeaway:** Cut automation and scheduling first; never cut idempotent ingestion or the durable log — those are what make even a thin MVP's numbers trustworthy.

---

## ⚡ Quick Revision Cheatsheet

**Scale numbers**
- 50M DAU × 20 events/session ≈ 1B events/day ≈ **~12K events/sec average**
- Plan for **5–8x peak** ⇒ **~60K–90K events/sec** at peak (state the ratio, don't hide it)
- One Kafka partition ≈ 5–10 MB/s planning number `⚠️ verify` ⇒ partition count from throughput, but treat it as your consumer-parallelism ceiling first

**Key technology choices**

| Component | Primitive / why | AWS | Native / OSS |
|---|---|---|---|
| Ingestion door | idempotent accept, fast ack | API Gateway + Fargate/Lambda | Nginx + stateless service |
| Idempotency store | atomic `SETNX`, short TTL | ElastiCache (Redis) | Redis |
| Durable log | partitioned, replayable | MSK / Kinesis Data Streams | Kafka |
| Hot-path compute | windowed, stateful, approximate | Managed Flink | Kafka Streams, Flink |
| Hot counters | atomic increment, sub-ms read | ElastiCache (Redis) | Redis |
| Cold archive | cheap, durable, replayable | S3 | HDFS, MinIO |
| Cold-path compute | exact, re-runnable batch | EMR (Spark) / Glue | Spark on K8s |
| Ad-hoc query | derived, faceted index | OpenSearch Service | Elasticsearch |

**Patterns used**
- [Scaling Writes](../../patterns/scaling-writes.md) ● central — aggregate before you write; shard the hot key (A26)
- [Counting & top-K at scale](../../patterns/README.md#gaps--recurring-sub-problems-not-yet-written-up) ● central — Count-Min Sketch, HyperLogLog (A26–A28); this topic is now the authoritative depth for that gap
- [Real-Time Updates](../../patterns/realtime-updates.md) ○ present — hop 2, counters → SSE to the dashboard (A25)
- [Multi-Step Processes](../../patterns/multi-step-processes.md) ○ present — idempotency as the universal tax (A12, A19)
- [Long-Running Tasks](../../patterns/long-running-tasks.md) ○ present — the nightly batch reconciliation job (A30)

**Canonical tradeoffs to memorize**
- **Lambda vs Kappa:** two codebases, always-consistent design vs one codebase, replay-dependent design
- **At-least-once + idempotency vs exactly-once delivery:** the former exists and is cheap; the latter doesn't exist
- **Exact counter vs Count-Min Sketch:** exact and expensive at high cardinality vs approximate and fixed-memory
- **Kafka retention vs S3 archive:** expensive fast replay vs cheap slow replay — keep Kafka short
- **Hot path vs cold path:** fast and approximate (seconds) vs slow and exact (hours) — never merge them into one system

**Common interview mistakes to avoid**
- Reaching for `COUNT(*)` or a single atomic counter and not naming the hot-key problem (A26)
- Claiming "Kafka gives exactly-once" without the boundary caveat (A5)
- Rate-limiting or circuit-breaking the durable log itself instead of a synchronous dependency (A32, A33)
- Treating consumer lag as a count instead of an age (A38) — the AWS-flavored version of this trap is Kinesis shard head-of-line blocking `⚠️ verify`
- Putting OpenSearch in the ingestion or billing path instead of treating it as a derived, human-query layer (A24, A41)
- Implying zero data loss on regional failover instead of naming the replication-lag bound (A36)
