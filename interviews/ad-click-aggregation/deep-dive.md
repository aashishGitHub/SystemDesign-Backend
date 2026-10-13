# Deep Dive: Real-Time Event Aggregation

> **deep-dive** — everything here is beyond a 45-minute interview answer.
> Read it to be un-rattleable in follow-ups, not to recite it.

---

## Table of Contents

1. [The hot path / cold path split](#1-the-hot-path--cold-path-split)
2. [Idempotent ingestion and the dual-write problem](#2-idempotent-ingestion-and-the-dual-write-problem)
3. [Kafka partitioning and consumer groups, in depth](#3-kafka-partitioning-and-consumer-groups-in-depth)
4. [Approximate counting: Count-Min Sketch and HyperLogLog](#4-approximate-counting-count-min-sketch-and-hyperloglog)
5. [Watermarks and late-arriving data](#5-watermarks-and-late-arriving-data)
6. [Reliability: circuit breakers, backpressure, multi-region](#6-reliability-circuit-breakers-backpressure-multi-region)
7. [Observability: what "system health" means for an event pipeline](#7-observability-what-system-health-means-for-an-event-pipeline)
8. [Real-world implementations](#8-real-world-implementations)
9. [Quick Recall Cheat Sheet](#9-quick-recall-cheat-sheet)

---

## 1. The hot path / cold path split

### 🟢 Beginner — two clocks in the same kitchen

Think of a restaurant kitchen with two clocks. One clock tells the expediter "how many plates have gone out in the last five minutes" — close enough is fine, it's just for pacing the floor. The other clock is the till at the end of the night, which must be exactly right down to the cent, because that's what the restaurant gets paid on. Nobody tries to make one clock do both jobs.

### 🟡 Senior — Lambda architecture, mechanically

The speed layer and batch layer both read the same raw event stream independently. The speed layer maintains **incremental, windowed state** — it never re-reads history, it only updates as new events arrive, which is what makes it fast but also what makes it approximate (it can't "go back" cheaply to fix a late event without extra machinery). The batch layer re-reads the **entire relevant window from the immutable archive** every time it runs, which is what makes it slow but exact.

```go
// Speed layer: incremental, stateful, cheap per-event
func onEvent(event Event, windowState map[string]int64) {
    windowState[event.WindowKey]++ // O(1) per event
}

// Batch layer: full re-scan, expensive, but always correct
func recompute(hour string, archive S3Archive) int64 {
    events := archive.ReadPartition(hour) // O(n) over the whole hour
    return exactCount(events)
}
```

| | Speed layer | Batch layer |
|---|---|---|
| Reads | Incrementally, from the live stream | Fully, from the immutable archive |
| Cost per query | O(1) — already aggregated | O(n) — recomputed on demand or on schedule |
| Correctness | Approximate (sketches, watermark cutoff) | Exact |
| Latency | Seconds | Minutes to hours |

### 🔴 Architect — the cost nobody mentions until it bites

The real cost of Lambda architecture isn't infrastructure — it's that **the aggregation logic is written twice**, in two different programming models (a streaming DSL and a batch DSL), and they must agree on every edge case: how a window boundary is defined, how a duplicate is detected, how a null field is handled. In production, these two implementations drift — a bug fix lands in the batch job and not the stream job, or vice versa — and the first anyone hears about it is a reconciliation delta that shouldn't exist (Q30).

The Kappa alternative removes the duplication by making the batch layer just "replay the stream job over a wider window," but it has its own tax: your Kafka retention window becomes your recompute window, so a 7-day retention means you cannot recompute anything older than 7 days without a separate cold-storage replay path anyway — which, at that point, is Lambda again with extra steps. **The honest framing for an interview:** Lambda's duplication is a maintenance cost you pay explicitly; Kappa's simplicity is a retention constraint you pay implicitly. Neither one is free.

**Capacity math worth having ready:** at ~90K events/sec peak and ~500 bytes/event, that's ~45 MB/s into Kafka. Over a 7-day retention window with replication factor 3, that's roughly `45 MB/s × 604,800s × 3 ≈ 78 TB` of Kafka storage at peak-sustained load `⚠️ verify against actual traffic shape — this assumes peak sustained for the full window, which is a conservative upper bound, not the expected average`. This is exactly why the cheap, long-lived copy belongs in S3, not in Kafka.

---

## 2. Idempotent ingestion and the dual-write problem

### 🟢 Beginner — the "did you hear me?" problem

If you shout a question across a noisy room and get no answer, you don't know if the other person didn't hear you, or heard you and answered but you didn't hear *them*. So you shout again. If they did hear you the first time, your second shout needs to not confuse them into answering twice.

### 🟡 Senior — where duplicates actually come from

Duplicates enter this system at three distinct layers, and each needs its own defense:

| Layer | Duplicate source | Defense |
|---|---|---|
| Client → API | Network timeout, client retries | Client-supplied `Idempotency-Key`, checked atomically before producing |
| API → Kafka | Producer retry after an ack timeout (the ack was lost, not the write) | Kafka idempotent producer (sequence numbers per producer session) |
| Kafka → consumer | Consumer crash after processing, before committing offset | Consumer-side dedupe by `event_id` in the state store |

```java
void applyEvent(Event event, StateStore stateStore) {
    if (stateStore.seen(event.getEventId())) {
        return; // no-op: this is the exactly-once EFFECT, not exactly-once delivery
    }
    stateStore.markSeen(event.getEventId());
    stateStore.increment(event.getWindowKey());
}
```

### 🔴 Architect — the dual-write problem, named

The moment your ingestion service does two separate writes — one to a database or dedupe store, one to Kafka — without a shared transaction, there's a crash window between them that leaves the two out of sync. Crash after the dedupe write but before the Kafka produce, and you've marked an event "seen" that never actually reached the log — a **silent drop**, which is worse than a duplicate because nothing alerts on it.

The standard fix is the **transactional outbox**: write the event to an outbox table in the same local transaction as any other state change, and have a separate relay process (or a CDC reader on the outbox table itself) push outbox rows into Kafka. This turns "two writes, no transaction" into "one write, one transaction," and moves the dual-write problem to the relay, whose only job is to be idempotent about re-delivering rows it's already sent — a much smaller surface than the original ingestion path. See [Multi-Step Processes §8](../../patterns/multi-step-processes.md#8-the-dual-write-problem-and-the-outbox) for the general pattern.

---

## 3. Kafka partitioning and consumer groups, in depth

### 🟢 Beginner — mailboxes on a street

A partition is like a mailbox on a street. Mail addressed with the same house number always goes to the same mailbox, in the order it was dropped off. Different mailboxes can be collected in any order relative to each other — there's no guarantee the mail carrier visits house 1 before house 2.

### 🟡 Senior — the partition count decision

```
throughput_partitions = peak_bytes_per_sec / per_partition_throughput_ceiling
                       = 45 MB/s / ~7.5 MB/s (planning number ⚠️ verify)
                       ≈ 6 partitions, for throughput alone

parallelism_partitions = max consumers you'll ever want reading this topic at once
```

Pick the **larger** of the two, with headroom — partition count can be increased later on most Kafka setups, but existing keys don't get rebalanced across the new partitions automatically, so a mid-life increase temporarily breaks your ordering guarantee for any key whose events span the change. Plan for growth up front rather than resizing under load.

| Scenario | Consumers | Partitions | Outcome |
|---|---|---|---|
| Balanced | 6 | 6 | Each consumer owns exactly one partition |
| Under-provisioned consumers | 3 | 6 | Each consumer owns two partitions — fine, just less parallel |
| Over-provisioned consumers | 12 | 6 | 6 consumers idle — partition count is a hard ceiling |

### 🔴 Architect — rebalance storms and static membership

A naive deployment (rolling restart of a consumer fleet) can trigger a rebalance **per pod restart**, and if the rolling restart is faster than the rebalance completes, you get a **rebalance storm** — the group never stabilizes long enough to make progress, because a new rebalance starts before the last one finished reassigning. The mitigation is **static group membership** (a stable `group.instance.id` per consumer instance `⚠️ verify current Kafka client config name`), which tells the coordinator "this is the same member coming back," avoiding a full rebalance for a brief restart and only triggering one after a genuine session timeout.

**Incident shape worth knowing:** a rebalance storm during a deploy looks like "the pipeline is up, brokers are healthy, but consumer lag is climbing and never recovers" — the classic false-positive-healthy state that only lag-as-age (not error rate) catches.

---

## 4. Approximate counting: Count-Min Sketch and HyperLogLog

### 🟢 Beginner — a bouncer with a bad memory, and a party headcount by eye

A Count-Min Sketch is like a bouncer checking a few different, overlapping lists for a name and reporting the smallest number of times any list shows it — a deliberately pessimistic guess that only ever overcounts. HyperLogLog is like guessing how many people are at a party by looking for the "most surprising" thing you notice — the longest streak of coin flips coming up heads in a row tells you roughly how many coins were flipped, without counting each one.

### 🟡 Senior — the math shape, not the proof

Count-Min Sketch: a `d × w` grid of counters, `d` hash functions, one increment per row per insert, estimate = min across the `d` cells for that item. Error is bounded by the sketch width `w` and is always an **overestimate**, never an underestimate — because collisions can only add extra weight into a cell, never remove it.

HyperLogLog: hashes each item, and for each hash, records the position of the **leftmost 1-bit** (equivalently, the length of the leading run of zeros) into one of `m` registers (bucketed by a few bits of the hash). The insight is that the *maximum* run length observed across many random hashes is a statistical estimator of `log2(cardinality)` — more distinct items make a long run more likely to appear somewhere. Standard error is roughly `1.04/√m` `⚠️ verify against the specific HLL variant and register count in use`.

```go
// Count-Min Sketch: insert and estimate
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

### 🔴 Architect — when the error is a business decision, not a bug

The width of a Count-Min Sketch (and therefore its error rate and memory footprint) is a **capacity-planning decision made with the product team**, not a purely technical one: "we're willing to overcount clicks-per-ad by up to 0.5% on the live dashboard, because the exact number is what we bill from, 6 hours later." Stating that trade-off out loud, with a number, is the signal that separates "I know these data structures exist" from "I know how to use them in a real system."

The failure mode to name unprompted: a sketch sized for the *average* ad's cardinality will systematically overcount **the most popular ad more than a niche one**, because collision rate scales with how many distinct events share the sketch's limited width — if leaderboard-style "top ad by clicks" ranking matters, a fixed sketch width can bias the ranking itself, not just the totals.

---

## 5. Watermarks and late-arriving data

### 🟢 Beginner — the mail cutoff at the post office

A post office has a last pickup time. Mail dropped before it goes out today. Mail dropped after it waits for tomorrow's batch — the post office doesn't reopen today's already-departed truck just because one more letter showed up five minutes late.

### 🟡 Senior — watermark mechanics

A watermark is a **claim about how out-of-order the stream can be**: "no event with a timestamp earlier than `W` will arrive after this point, except events later than `W - allowed_lateness`." The stream processor tracks the watermark per partition (usually derived from the max event timestamp seen minus a configured slack) and closes a window only once the watermark passes the window's end.

```
window: [10:00, 10:01)
allowed_lateness: 2 minutes
watermark passes 10:01 at wall-clock 10:03  →  window closes, result emitted
event with ts=10:00:45 arrives at wall-clock 10:05  →  TOO LATE, routed to the late-events sink
```

### 🔴 Architect — allowed lateness is a latency/completeness trade you name explicitly

A longer `allowed_lateness` captures more genuinely late-but-valid events (a mobile client that was offline, per Q29) at the direct cost of dashboard freshness — every window waits that much longer before it's considered final. This is not a technical default to leave at whatever the framework ships with; it should be set from the product's actual offline-tolerance requirement ("our mobile client buffers up to 40 minutes offline" implies your watermark slack needs to cover that, or you accept that offline sessions systematically undercount on the hot path and always get corrected by the cold path instead). Naming this trade-off explicitly, with the client behavior that drives the number, is the senior signal.

---

## 6. Reliability: circuit breakers, backpressure, multi-region

### 🟢 Beginner — a fuse box

A circuit breaker is a fuse. When something downstream is drawing too much trouble, the fuse trips and stops sending more current its way — better a dark room than a house fire. Backpressure is what happens upstream of the fuse: the appliance itself slows down instead of forcing current through a tripped breaker.

### 🟡 Senior — where each mechanism actually sits

```
Client → [rate limit: per-client, edge] → API → [circuit breaker: dedupe store] → Kafka
                                            ↓ (buffer or 503, never hang)
Kafka → [backpressure: consumer poll rate] → Stream processor
```

| Mechanism | Sits between | Protects |
|---|---|---|
| Rate limit | Client and API | The ingestion tier from one noisy client |
| Circuit breaker | API and its synchronous dependency (dedupe store) | The API's own latency/availability from a degraded dependency |
| Backpressure | Consumer and its downstream write target | The downstream store from being overwhelmed, without dropping Kafka's own durability guarantee |

### 🔴 Architect — the failover trade you must say out loud

Cross-region Kafka replication (MirrorMaker2-style, or a managed equivalent `⚠️ verify current tooling and naming`) is asynchronous — replication lag is not zero, so a regional failover always has a bounded-but-nonzero loss window equal to however far behind the standby was at the moment of failure. Stating "we lose at most `replication_lag_p99` seconds of events on a regional failover, and here's the metric that bounds it" is a materially stronger answer than "we failover to another region" without a number attached. This is the same discipline as [Cross-Pattern Truth #6](../../patterns/README.md#the-cross-pattern-truths) — name what's allowed to be lost, explicitly, rather than implying nothing is.

---

## 7. Observability: what "system health" means for an event pipeline

### 🟢 Beginner — a car dashboard, not a firehose

A car's dashboard doesn't show you every sensor reading in the engine. It shows you speed, fuel, and a handful of warning lights — the small set of signals that tell you whether to worry, without drowning you in telemetry you can't act on.

### 🟡 Senior — the metric-to-decision mapping

Every health metric should map to a specific action, or it doesn't belong on the dashboard:

| Metric | If it degrades, the action is |
|---|---|
| Consumer lag (age) | Scale out consumers, or investigate a stuck partition |
| Ingestion 429/503 rate | Check if it's one noisy tenant (scale their quota) or a capacity ceiling (scale the tier) |
| Hot-vs-cold delta per hour | Investigate sketch sizing or a watermark misconfiguration before it reaches finance |
| Per-tenant throughput share | Confirm quota isolation is actually holding under the current spike |
| Cross-region replication lag | Know your current failover loss bound before you need it |

### 🔴 Architect — alerting on the failure mode that produces zero errors

The hardest incident to catch in a pipeline like this is the one where **nothing throws an exception**: a client SDK silently stops sending (a bad app release, a misconfigured endpoint), and every existing dashboard — error rate, 5xx count, even consumer lag — stays flat and green, because there's simply nothing arriving to fail. The only signal that catches this is a **per-source expected-rate baseline** with an alert on deviation below it, which is a fundamentally different kind of check than every threshold-on-error alert in the rest of the stack. Naming this failure mode unprompted, and the specific metric that catches it, is close to the highest-signal thing you can say in this whole topic — it's exactly what a JD asking you to "define system health" is testing for.

---

## 8. Real-world implementations

### 🟢 Beginner — everyone building this hits the same wall

Any company running a product with millions of users and an ads or analytics business — a streaming platform, a search engine, a social feed — eventually builds some version of "ingest a firehose of events, serve an approximate real-time view, and reconcile it against an exact batch view." The shape repeats because the underlying trade-off (fast-and-approximate vs slow-and-exact) is not specific to any one company.

### 🟡 Senior — named, verifiable examples

- **Google's internal ad systems** are the canonical example an interviewer expects here — aggregating billions of ad events/day with both real-time reporting and exact billing reconciliation is a well-known internal-scale problem at Google `⚠️ I don't have a verified, citable source for Google's specific internal architecture — treat this as the well-known shape of the problem, not a claim about their actual implementation`.
- **The Lambda architecture** itself is a named, documented pattern (associated with Nathan Marz, formerly of Twitter/BackType) for exactly this speed-layer/batch-layer split `⚠️ I'm not fully certain of the precise attribution details — verify before citing it by name to an interviewer as more than "a named pattern from the big-data community."`
- **Kafka** originated at LinkedIn specifically to solve high-throughput event pipeline problems of this shape, which is why its partitioning and consumer-group model maps so directly onto this topic.

### 🔴 Architect — the Couchbase CDC → Kafka → SSE shape, as a lived example

This is worth having ready as your own, first-hand architecture reference, distinct from the generic examples above:

Couchbase exposes its internal replication stream — the **Database Change Protocol (DCP)** — as a way to read every document mutation in commit order, without polling and without a separate dual-write from the application. Two production consumers of that stream matter here:

1. **Couchbase's Kafka connector** is built directly on DCP — it turns "every mutation in this bucket" into a Kafka topic, which means Kafka's event log is populated by **reading the database's own change log**, not by the application code doing a second, separate write. This sidesteps the dual-write problem from §2 entirely for the ingestion side: there's only one write (to Couchbase), and the event stream is derived from it, not written alongside it.
2. **Couchbase's Eventing service** lets you run a function directly against that same mutation stream inside the cluster — for a use case like live counters, this can push an increment out the moment a document changes, without a separate stream-processing tier for the simplest aggregations.

The real-time delivery side — getting that change out to a live dashboard — is the same hop-1/hop-2 problem the [sse](../sse/) topic covers: hop 1 is the SSE connection itself, hop 2 is getting the Couchbase-sourced event to whichever pod holds that connection, typically via the same kind of bus (NATS, Kafka, Redis pub/sub) already in the diagram above.

**The framing worth saying out loud in an interview:** "I've built the CDC-sourced version of this — reading a database's own change stream instead of dual-writing to a queue — and it removes an entire failure class (the dual-write gap in §2) at the cost of coupling your event schema to your document schema, which is a trade-off worth naming rather than a strictly better answer."

---

## 9. Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Central split | Hot path: fast, approximate. Cold path: slow, exact. Never merge them — reconcile them. |
| Lambda architecture | Speed layer + batch layer + serving layer that merges both; costs you double-written logic |
| Kappa architecture | Batch layer replaced by "replay the stream"; costs you a retention-bounded recompute window |
| Exactly-once | Doesn't exist as delivery; exists as effect — at-least-once + idempotent consumer |
| Idempotency layers | Client key at the door, producer sequence numbers into Kafka, `event_id` dedupe at the consumer |
| Dual-write problem | Two writes, no shared transaction, crash window between them — fixed by transactional outbox |
| Partition key | Pick the entity that needs ordering and colocation — `session_id`, never event type |
| Partition count | Sets throughput AND the hard ceiling on parallel consumers — size for the larger need |
| Consumer rebalance | Pauses the WHOLE group, reprocesses from last committed offset — design for idempotency, not avoidance |
| Hot-key counter | One global counter caps at one partition's throughput — write-shard the key, sum on read |
| Count-Min Sketch | Fixed memory, one-directional overcount error, answers "how many of X" at huge cardinality |
| HyperLogLog | Fixed memory, ~1-2% error, answers "how many distinct X" — a different problem than counting |
| Watermark | How long a window waits for late data before it closes and reports, final |
| Late data after watermark | Never reopens a closed window — goes to cold-path reconciliation instead |
| Reconciliation | Cold, exact, replayed number always wins and overwrites the hot estimate in place |
| Circuit breaker placement | On the synchronous dependency (dedupe store), never on the durable log itself |
| Backpressure | Push it all the way back to the client (`429`); never resolve it by silently dropping events |
| Multi-region | Pin sessions to a home region to avoid creating the double-count; failover loss is bounded by replication lag |
| Lag as age vs count | Age is throughput-independent and answers "how stale right now" — count lies across throughput levels |
| Silent data loss | Produces zero errors — only a per-source expected-rate baseline alert catches it |
| Couchbase CDC angle | DCP-sourced Kafka feed removes the dual-write problem entirely, at the cost of coupling event schema to document schema |
