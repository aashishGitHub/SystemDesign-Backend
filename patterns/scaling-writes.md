# Pattern: Scaling Writes

> **Interviewer signal:** "1M events/sec", "ingest every GPS ping", "ad click aggregator", "metrics pipeline", "black-Friday spike", "every user uploads a workout".

Writes are the hard side. You can't cache your way out of them, every one must be made durable, and for any given key there's exactly one place it can go. So while [scaling reads](./scaling-reads.md) is mostly about making copies, scaling writes is about **reducing the number of writes, spreading them across independent owners, and absorbing bursts** — in that order.

📖 Source outline: [hellointerview.com — Scaling Writes](https://www.hellointerview.com/learn/system-design/patterns/scaling-writes) (prose paywalled; depth below is this repo's own).

---

## Table of Contents

1. [Why Writes Are Fundamentally Harder Than Reads](#1-why-writes-are-fundamentally-harder-than-reads)
2. [Write Amplification: Count the Real Number](#2-write-amplification-count-the-real-number)
3. [Rung 1: Pick a Write-Optimized Engine](#3-rung-1-pick-a-write-optimized-engine)
4. [Rung 2: Reduce the Number of Writes](#4-rung-2-reduce-the-number-of-writes)
5. [Rung 3: Queues as Shock Absorbers](#5-rung-3-queues-as-shock-absorbers)
6. [Rung 4: Load Shedding and Backpressure](#6-rung-4-load-shedding-and-backpressure)
7. [Rung 5: Partitioning and Sharding](#7-rung-5-partitioning-and-sharding)
8. [Rung 6: Hierarchical Aggregation](#8-rung-6-hierarchical-aggregation)
9. [Hot Keys and Hot Shards](#9-hot-keys-and-hot-shards)
10. [Resharding Without Downtime](#10-resharding-without-downtime)
11. [Durability Dials](#11-durability-dials)
12. [Decision Framework](#12-decision-framework)
13. [Where This Shows Up in This Repo](#13-where-this-shows-up-in-this-repo)
14. [Real-World Cases](#14-real-world-cases)
15. [Interview Questions](#15-interview-questions)
16. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Writes Are Fundamentally Harder Than Reads

| | Reads | Writes |
|---|---|---|
| Can you copy your way out? | Yes — replicas, caches, CDN | **No.** Every replica must apply every write |
| Can you serve stale? | Usually | No — a write must land |
| Durability cost | None | `fsync`, replication acks, WAL |
| Ordering | Irrelevant | Often required per key |
| Concurrency | Unlimited readers | One owner per key (or you get [contention](./dealing-with-contention.md)) |
| Bottleneck shape | Fan-out and latency | Throughput and disk I/O |

The asymmetry that matters most: **adding replicas increases total write work.** Ten replicas means the write stream is executed eleven times across the fleet. So the moment your problem is genuinely write-bound, the entire read-scaling toolbox is not just unhelpful — it's actively counterproductive.

The first question in any "scale writes" problem is therefore: **are these writes the same key or different keys?**

- *Different keys* (1M users each writing their own row) → a partitioning problem, and mostly tractable.
- *The same key* (1M writes to one counter) → no partitioning helps, and you must change the data model. See [§9](#9-hot-keys-and-hot-shards).

Asking that distinction out loud early is one of the highest-signal moves in this pattern.

---

## 2. Write Amplification: Count the Real Number

"10,000 writes/sec" is never 10,000 writes. Do the accounting on a whiteboard:

```
1 logical write: INSERT INTO posts (…)
   ├─ WAL append                                        ×1
   ├─ heap/table page write                             ×1
   ├─ 5 secondary indexes → 5 B-tree updates            ×5
   ├─ replication to 2 replicas (each replays all of it)×2 of everything above
   ├─ LSM compaction rewriting the same data 10–30×
   │    over its lifetime (leveled)                     ×10–30 eventually
   └─ backup / CDC stream / search indexer               ×N

→ 10k logical writes/sec can easily be 100k+ physical IOPS.
```

Two consequences worth stating:

1. **Dropping an unused index can be a bigger write win than adding hardware.** The cheapest write optimization is deleting write work you don't need.
2. **Fan-out-on-write is write amplification by design.** A celebrity with 50M followers posting once is 50M writes. That's the same fact from the [read-scaling](./scaling-reads.md#9-precomputation-materialized-views-and-cqrs) side, seen from the write side — and it's why the celebrity problem exists at all. [`social-feed §1`](../interviews/social-feed/deep-dive.md#1-fan-out-models)

→ [`storage-engines §8 Amplification and the RUM Conjecture`](../interviews/storage-engines/deep-dive.md#8-amplification-and-the-rum-conjecture)

---

## 3. Rung 1: Pick a Write-Optimized Engine

Storage engine choice can be a 10× write-throughput difference, and it's a decision you make once.

| | B-Tree (Postgres, MySQL/InnoDB) | LSM-Tree (Cassandra, RocksDB, ScyllaDB, Bigtable) |
|---|---|---|
| Write path | Locate page → **random** in-place update | Append to memtable → **sequential** flush |
| Write amplification | Lower steady-state, but random I/O | Higher (compaction), but sequential I/O |
| Read path | One traversal, predictable | May check memtable + N SSTables → needs Bloom filters |
| Best for | Balanced workloads, strong transactions | **Write-heavy, high-ingest** |

The reason LSM wins on ingest is mechanical: a write becomes an in-memory insert plus a sequential WAL append, and the expensive reorganization is deferred to background compaction. You're trading read amplification and background I/O for write throughput — the **RUM conjecture** in action (you can optimize Read, Update, or Memory — pick two).

Other engine-level knobs to name:

- **Group commit** — batch many transactions' `fsync` into one. This is the difference between ~hundreds and ~tens of thousands of durable commits per second, and it's usually already on. [`storage-engines §9`](../interviews/storage-engines/deep-dive.md#9-durability-wal-fsync-and-group-commit)
- **Compaction strategy** — size-tiered favours writes, leveled favours reads. Getting this wrong shows up as write stalls when compaction can't keep up with ingest. [`§6`](../interviews/storage-engines/deep-dive.md#6-compaction-size-tiered-vs-leveled)
- **Deletes aren't free in an LSM** — a delete is a tombstone (another write) and reclaims nothing until compaction. High-churn workloads can be dominated by tombstones. [`§7`](../interviews/storage-engines/deep-dive.md#7-tombstones-and-the-problem-of-deletes)
- **Right store for the shape**: append-only time series → a TSDB or a log; unbounded event ingest → Kafka, not a relational table.

→ [`storage-engines §3 The LSM-Tree Write Path`](../interviews/storage-engines/deep-dive.md#3-the-lsm-tree-write-path) · [`§12 Choosing and Tuning an Engine`](../interviews/storage-engines/deep-dive.md#12-choosing-and-tuning-an-engine) · [`fundamentals/write-ahead-log.md`](../fundamentals/write-ahead-log.md) · [`fundamentals/segmented-log.md`](../fundamentals/segmented-log.md)

---

## 4. Rung 2: Reduce the Number of Writes

**The highest-leverage rung, and the one candidates skip.** Before distributing writes, ask whether they need to exist.

### Batching

```
Naive:   1M events/sec → 1M INSERTs/sec → 1M transactions, 1M fsyncs
Batched: buffer 1000 events or 100ms (whichever first)
         → 1,000 batch INSERTs/sec
         → ~1000× fewer transactions, and the disk does sequential work
```

Batch on **size OR time, whichever trips first** — size alone stalls forever on a quiet stream, time alone doesn't bound memory. The cost is latency (up to your flush interval) and a durability window: events buffered in memory are lost if the process dies, so either accept that (metrics, analytics) or persist to a durable log first (orders, payments). **Naming that tradeoff explicitly is the point** — batching is trivially correct for telemetry and unacceptable for money.

### Aggregation and coalescing

If the consumer only needs a count, don't store the events:

```
100,000 clicks on ad 42 in one second
  → naive: 100,000 rows
  → aggregate at the edge/collector: 1 row  {ad:42, second:…, count:100000}
```

For **state-conveying** writes, only the latest value matters — a driver's location, a user's presence, a document's cursor position. Coalescing 10 GPS pings into the newest one loses nothing the product needs. (Same distinction as in [real-time updates](./realtime-updates.md#10-interview-questions): valid for state, invalid for events where each item is independently meaningful.)

### Sampling and approximation

Exact counts are expensive; approximate structures are cheap and often sufficient:

| Need | Exact cost | Approximate |
|---|---|---|
| Unique visitors | A set of all IDs | **HyperLogLog** — ~12KB for billions of items, ~2% error |
| "Have I seen this URL?" | A full index | **Bloom filter** |
| Top-K | Full sort | Count-Min Sketch + heap |
| p99 latency | All samples | t-digest / HDR histogram |

The interview move is to **ask whether exactness is required**. "Is 2% error on the unique-visitor count acceptable?" is usually yes, and it converts an unbounded-memory problem into a fixed 12KB one.

→ [`url-shortener §7 Click Analytics: Kafka, HyperLogLog, and Async Decoupling`](../interviews/url-shortener/deep-dive.md#7-click-analytics-kafka-hyperloglog-and-async-decoupling) · [`fundamentals/bloom-filters.md`](../fundamentals/bloom-filters.md) · [`web-crawler §3`](../interviews/web-crawler/deep-dive.md#3-url-deduplication-with-bloom-filters)

### Write less per write

Delta encoding instead of full documents, columnar/compressed formats for analytics, dropping fields nobody queries, and — the one that bites hardest in practice — **not writing high-cardinality labels into a metrics system**, which is the same problem wearing a different hat. [`observability §4 The Cardinality Problem`](../interviews/observability/deep-dive.md#4-the-cardinality-problem)

---

## 5. Rung 3: Queues as Shock Absorbers

Put a durable log between the request path and the database.

```
        spiky, bursty                      smooth, controlled
  client ──────────► API ──► [Kafka] ──► consumers ──► DB
                     ↑                      ↑
              accepts fast,          drains at a rate the DB
              202 Accepted           can actually sustain
```

What this genuinely buys:

- **Burst absorption.** A 10× spike lasting 30 seconds becomes queue depth, not errors — the queue trades latency for availability.
- **Decoupling.** The DB can be slow, restarting, or failing over; ingestion keeps accepting.
- **Replay.** A durable log lets you re-process after a consumer bug — you can rebuild derived state from the log, which a synchronous write path can never offer.
- **Natural batching.** Consumers read in batches, which composes with rung 2.
- **Ordering per key** via partition key, so per-entity sequencing survives.

The critical caveat to state before the interviewer does: **a queue absorbs bursts, not sustained overload.** If arrival rate exceeds drain rate *on average*, queue depth grows without bound and you've converted a fast failure into unbounded latency plus eventual data loss — which is strictly worse, because it fails silently and later. Queue depth and consumer lag are the SLIs; a sustained overload needs more consumers, faster writes, or [shedding](#6-rung-4-load-shedding-and-backpressure).

Second caveat: the write is now **asynchronous**, so the API returns before the data is durable in the DB. That changes your contract — you owe the client either a `202 Accepted` with a status endpoint, or a read path that tolerates not-yet-visible writes. Don't quietly pretend a queued write is a committed one.

→ [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) · [`recommendation-system §3 Kafka: The Backbone You Cannot Skip`](../interviews/recommendation-system/deep-dive.md#3-kafka-the-backbone-you-cannot-skip) · [`search-autocomplete §5 Batch vs Streaming`](../interviews/search-autocomplete/deep-dive.md#5-the-update-pipeline-batch-vs-streaming-kafka--flink)

---

## 6. Rung 4: Load Shedding and Backpressure

When demand genuinely exceeds capacity, you have exactly three options: queue it (bounded), shed it, or fall over. Falling over is the only unacceptable one, and it's the default if you don't choose.

**Shed by priority, not at random:**

```
Queue depth / latency exceeds threshold →
   1. drop analytics & telemetry writes            (nobody notices)
   2. drop/defer non-critical notifications        (delayed, not lost)
   3. degrade: coarser aggregation, longer batches
   4. reject new writes with 429 + Retry-After     (honest, client can back off)
   ---------------------------------------------------
   NEVER shed: payments, orders, audit log
```

**Backpressure** is the cooperative version: instead of accepting work you can't do, signal upstream to slow down — TCP does this natively, Kafka consumers do it by not polling, gRPC/HTTP/2 via flow control, and your API does it with `429`/`503` plus `Retry-After`. The anti-pattern is an unbounded in-memory buffer, which converts overload into an OOM crash and loses everything buffered rather than just the excess.

**Retry storms are the amplifier that turns a blip into an outage.** A client that retries 3× on timeout triples load exactly when the system is least able to serve it. The mitigations to name: exponential backoff **with jitter** (without jitter, retries synchronize into waves), retry *budgets* (cap retries as a fraction of total traffic rather than per-request), circuit breakers that fail fast instead of piling on, and idempotency keys so retries are safe to serve.

→ [`fundamentals/circuit-breaker.md`](../fundamentals/circuit-breaker.md) · [`rate-limiting §7 Failure Modes and Graceful Degradation`](../interviews/rate-limiting/deep-dive.md#7-failure-modes-and-graceful-degradation) · [`notification-system §6 Priority, Rate Control`](../interviews/notification-system/deep-dive.md#6-priority-rate-control-and-user-preferences)

**Shed or autoscale?** Autoscaling has a lag measured in tens of seconds to minutes (instance boot, warmup, connection pools, cold caches), so it cannot answer a 5-second spike — shedding and queueing cover the gap while capacity arrives. Also, autoscaling the *stateless* tier is easy and autoscaling the *database* is not, so scaling the front end into a fixed-capacity backend just moves the queue and can make things worse.

---

## 7. Rung 5: Partitioning and Sharding

Once you've minimized and smoothed the writes, the only way to exceed one node's throughput is more independent owners.

### Three cuts, often confused

| Cut | What it splits | Example |
|---|---|---|
| **Horizontal sharding** | Rows across nodes by a key | Users A–M on shard 1, N–Z on shard 2 |
| **Vertical partitioning** | Columns of one table | Hot `user(id, name)` in one table; cold `user_bio_blob` in another |
| **Functional / vertical sharding** | Tables by service | Orders DB, inventory DB, auth DB — separate stores |

Functional decomposition is often the *cheapest* first cut: moving the write-heavy `events` table off the box that serves `orders` gives immediate relief with no shard-key decision and no distributed queries.

### Choosing the shard key

The key decides everything downstream:

- **Range partitioning** (`created_at`, sequential IDs) keeps range scans efficient but creates a **hot spot on the newest range** — every insert goes to the last shard. Time-ordered keys are the classic write-scaling mistake.
- **Hash partitioning** distributes uniformly and kills range queries.
- **Composite** (`hash(tenant_id) + timestamp`) is usually the answer: distribute across tenants, keep time-ordering within one.
- **Consistent hashing with virtual nodes** minimizes data movement when the topology changes — [`consistent-hashing`](../interviews/consistent-hashing/README.md) has 32 questions and 25 diagrams on this.

Two properties to check out loud: **cardinality** (enough distinct values to spread across shards — `status` is a terrible key) and **uniformity** (no single value dominating — `country` puts most of your traffic on one shard).

→ [`sharding-replication §2 Choosing the Right Cut`](../interviews/sharding-replication/deep-dive.md#2-sharding-strategies-choosing-the-right-cut) · [`§1 Why Databases Hit a Ceiling`](../interviews/sharding-replication/deep-dive.md#1-why-databases-hit-a-ceiling) · [`kv-store §2 Placing Keys on the Ring`](../interviews/kv-store/deep-dive.md#2-partitioning-placing-keys-on-the-ring) · [`recommendation-system §4 The Art of Even Distribution`](../interviews/recommendation-system/deep-dive.md#4-partitioning-the-art-of-even-distribution)

The costs you inherit: no cross-shard transactions without a [saga](./multi-step-processes.md), scatter-gather for non-key queries, and resharding as a project. [`sharding-replication §5`](../interviews/sharding-replication/deep-dive.md#5-cross-shard-queries-and-distributed-transactions)

---

## 8. Rung 6: Hierarchical Aggregation

For counting/metrics workloads, the strongest technique: aggregate at every level so the volume shrinks as it moves up.

```
1M clients each emitting 100 events/sec  =  100M events/sec
        │
        ├─ CLIENT-side: batch + pre-aggregate per 10s
        │      → 1M × 0.1/sec = 100k messages/sec
        │
        ├─ COLLECTOR/edge: aggregate per region per 10s
        │      → ~thousands/sec
        │
        ├─ REGIONAL rollup: per minute
        │      → tens/sec
        │
        └─ GLOBAL store: per-minute rows
               → a rounding error
```

Each level reduces volume by orders of magnitude, so the global store never sees anything resembling the raw rate. This is how metrics systems, ad-click aggregators, top-K pipelines, and view counters actually work — and it's the expected answer for "count 100M events/sec".

Design details interviewers probe:
- **Aggregation must be associative/commutative** for the hierarchy to be valid — sums and counts compose; medians don't (which is why you use approximate structures like t-digest that *do* merge).
- **Late-arriving data** needs a watermark policy: how long do you keep a time bucket open, and what happens to events that arrive after it closes? Answer explicitly — "drop after 5 minutes and record a late-event counter" is a fine answer; ignoring the question isn't.
- **Idempotency across levels** so a retried batch doesn't double-count — dedupe by batch ID, or make the aggregate a max/set-union rather than a sum where possible.
- **Two paths (lambda-ish)**: a fast approximate path for live dashboards plus a slower exact batch recompute for billing-grade numbers, because ad revenue can't be off by 2%.

→ [`observability §3 Metrics and the Prometheus Model`](../interviews/observability/deep-dive.md#3-metrics-and-the-prometheus-model) · [`§12 Push vs Pull Collection`](../interviews/observability/deep-dive.md#12-push-vs-pull-and-the-collection-architecture) · [`§13 The Cost of Observability at Scale`](../interviews/observability/deep-dive.md#13-the-cost-of-observability-at-scale)

---

## 9. Hot Keys and Hot Shards

Sharding distributes *keys*. It does nothing when the traffic is all one key.

```
Shard 1: ████████████████████████████  ← Taylor Swift's post
Shard 2: █
Shard 3: █
Shard 4: █
```

### Split all keys

Add a random suffix so one logical key becomes N physical keys, and sum on read:

```
write: INCR  counter:post42:{random 0..99}
read:  SUM over counter:post42:0 … counter:post42:99
```

Write throughput ×100. Cost: reads get 100× more expensive, and you pay that cost on *every* key, even the 99.9% that were never hot. Fine for a small number of known-hot aggregates (global counters), wasteful as a blanket policy.

### Split hot keys dynamically

Detect hotness (a Count-Min Sketch or a sampled counter over recent traffic), then split only those keys and keep a small routing table of which keys are split. Best of both — most keys stay cheap to read — at the cost of a detection pipeline, a routing lookup, and the transition window while a key is being promoted.

### Other tools

| Technique | Detail |
|---|---|
| **Local pre-aggregation** | Each app instance buffers and flushes one aggregated write per interval. 1000 instances × 1 write/sec beats 1M writes/sec, and needs no key splitting at all — usually the best first answer |
| **Dedicated shard** | Isolate the whale (a huge tenant) onto its own shard so it can't hurt others |
| **Vnodes / finer partitions** | More, smaller partitions spread load better and make rebalancing cheaper |
| **Change the data model** | Append-only event rows instead of a contended counter, aggregated asynchronously — no hot mutable key exists at all |

→ [`sharding-replication §6 Hot Shards and Load Imbalance`](../interviews/sharding-replication/deep-dive.md#6-hot-shards-and-load-imbalance) · [`kv-store §12 Capacity Planning and Hot Partitions`](../interviews/kv-store/deep-dive.md#12-capacity-planning-and-hot-partitions) · read-side symmetry: [`scaling-reads §11`](./scaling-reads.md#11-failure-modes)

---

## 10. Resharding Without Downtime

Going from 4 shards to 8 while serving traffic is a favourite senior question.

**Why naive modulo hashing is the trap:** `hash(key) % 4` → `hash(key) % 8` relocates roughly **half** of all keys. Every relocated key is unreadable at its new location until moved and unwritable at the old one once cut over.

**The techniques:**

| Approach | How it works | Tradeoff |
|---|---|---|
| **Pre-allocated logical shards** | Create 1024 logical shards on day one, map many to each physical node. "Resharding" = reassigning logical shards, no rehashing | **Best answer.** Requires foresight; 1024 is cheap insurance |
| **Consistent hashing + vnodes** | Only `1/N` of keys move when a node joins | Standard for KV stores; range queries suffer |
| **Range splitting** | A range that gets too big/hot splits in two (HBase, Spanner, DynamoDB partitions) | Automatic and adaptive; needs a metadata/routing tier |
| **Dual-write + backfill** | Write to old and new, backfill history, verify, then cut reads over, then stop old writes | Works for *any* migration, including changing the key entirely. Most operationally involved |

The **dual-write migration** in order, because this is the answer to "how do you actually do it":

```
1. Deploy new topology, writes go to BOTH old and new (new is shadow)
2. Backfill historical data into the new topology
3. VERIFY — continuously compare old vs new; reconcile drift
   (checksums / Merkle-style comparison — never skip this step)
4. Shift READS gradually: 1% → 10% → 50% → 100%, watching error rates
5. Stop writing to old; keep it as a rollback path for a while
6. Decommission
```

Every step must be independently reversible, and step 3 is the one people omit and regret — a silent divergence discovered after cutover means data loss with no clean rollback. Comparison technique: [`fundamentals/merkle-trees.md`](../fundamentals/merkle-trees.md).

→ [`sharding-replication §7 Online Re-sharding Without Downtime`](../interviews/sharding-replication/deep-dive.md#7-online-re-sharding-without-downtime) · [`consistent-hashing/answers.md`](../interviews/consistent-hashing/answers.md)

---

## 11. Durability Dials

Every write has a durability level, and it's a **choice** you should make per data class rather than inherit.

```
weakest ──────────────────────────────────────────────────► strongest

in-memory only        → lost on process crash        (presence, cursors)
OS buffer (no fsync)  → lost on machine crash        (metrics, logs)
fsync'd WAL, 1 node   → lost on disk/host loss       (single-node DBs)
replicated W=1        → lost if that one replica dies
quorum W=⌈(N+1)/2⌉    → survives minority failure    (default for important data)
W=N / sync all        → survives all-but-one, slowest
+ cross-region        → survives a region loss       (money, compliance)
```

Each step costs latency, and the honest framing is: **which of these writes am I allowed to lose, and how many?** Telemetry can lose a second's worth without anyone caring. An order cannot lose one, ever. Designing both to the same durability level means either wasting a lot of money or taking an unacceptable risk — the [kv-store's tunable `W`](../interviews/kv-store/deep-dive.md#4-tunable-consistency-n-w-r-quorums) exists precisely so this can be set per request.

Related knobs worth naming: group commit amortizes `fsync` across concurrent transactions; async replication makes writes fast and creates a data-loss window on failover; and `fsync` on cheap cloud disks is much slower than people assume, which is often the *actual* write ceiling. [`fundamentals/quorum.md`](../fundamentals/quorum.md) · [`storage-engines §9`](../interviews/storage-engines/deep-dive.md#9-durability-wal-fsync-and-group-commit)

---

## 12. Decision Framework

```
Same key, or different keys?
├─ SAME KEY (one counter, one celebrity, one hot row)
│    ► Sharding will NOT help. In order:
│      local pre-aggregation → append-only + async rollup
│      → split hot key (suffix) → dedicated shard
│
└─ DIFFERENT KEYS
   │
   ├─ Can I write FEWER times?  ← always ask first
   │    batching · aggregation · coalescing state updates ·
   │    sampling / HLL / Bloom · drop unused indexes
   │    ──────────────────────────────► DO THIS FIRST
   │
   ├─ Is the load spiky or sustained?
   │    spiky ────────────────────────► QUEUE (absorb; 202 Accepted)
   │    sustained over capacity ──────► SHED BY PRIORITY + backpressure
   │                                     (a queue only defers this)
   │
   ├─ Is the engine wrong for the workload?
   │    high ingest on a B-tree ──────► LSM / TSDB / append-only log
   │    ────────────────────────────── + group commit, compaction tuning
   │
   ├─ Is it a counting/metrics workload?
   │    ──────────────────────────────► HIERARCHICAL AGGREGATION
   │                                     (client → collector → region → global)
   │
   └─ Still above one node's throughput, or dataset too big?
        ──────────────────────────────► SHARD
          • functional split first (cheapest)
          • then horizontal: composite key (hash(tenant) + time)
          • pre-allocate 1024 logical shards NOW
          • never range-partition on time alone
```

---

## 13. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **Sharding & replication** | The home topic: ceilings, key choice, hot shards, online resharding | [`§1`](../interviews/sharding-replication/deep-dive.md#1-why-databases-hit-a-ceiling) · [`§2`](../interviews/sharding-replication/deep-dive.md#2-sharding-strategies-choosing-the-right-cut) · [`§6`](../interviews/sharding-replication/deep-dive.md#6-hot-shards-and-load-imbalance) · [`§7`](../interviews/sharding-replication/deep-dive.md#7-online-re-sharding-without-downtime) · [`§9`](../interviews/sharding-replication/deep-dive.md#9-pattern-recognition--when-to-shard) |
| **Storage engines** | Why LSM ingests faster, amplification accounting, WAL/fsync/group commit, compaction | [`§3 LSM write path`](../interviews/storage-engines/deep-dive.md#3-the-lsm-tree-write-path) · [`§6 Compaction`](../interviews/storage-engines/deep-dive.md#6-compaction-size-tiered-vs-leveled) · [`§8 RUM`](../interviews/storage-engines/deep-dive.md#8-amplification-and-the-rum-conjecture) · [`§9 Durability`](../interviews/storage-engines/deep-dive.md#9-durability-wal-fsync-and-group-commit) |
| **Ride sharing** | Millions of drivers pinging GPS every few seconds — the canonical write-heavy ingest | [`§2 Location Updates at Scale`](../interviews/ride-sharing/deep-dive.md#2-location-updates-at-scale) |
| **Observability** | Metrics ingest, cardinality as a write-scaling failure, collection architecture, cost | [`§3`](../interviews/observability/deep-dive.md#3-metrics-and-the-prometheus-model) · [`§4 Cardinality`](../interviews/observability/deep-dive.md#4-the-cardinality-problem) · [`§7 Sampling`](../interviews/observability/deep-dive.md#7-sampling-head-based-vs-tail-based) · [`§12`](../interviews/observability/deep-dive.md#12-push-vs-pull-and-the-collection-architecture) · [`§13 Cost`](../interviews/observability/deep-dive.md#13-the-cost-of-observability-at-scale) |
| **URL shortener** | Click analytics decoupled via Kafka, counted with HyperLogLog instead of rows | [`§7`](../interviews/url-shortener/deep-dive.md#7-click-analytics-kafka-hyperloglog-and-async-decoupling) |
| **Social feed** | Fan-out-on-write *is* write amplification; the celebrity case is the limit | [`§1 Fan-Out Models`](../interviews/social-feed/deep-dive.md#1-fan-out-models) · [`§2 Celebrity`](../interviews/social-feed/deep-dive.md#2-the-celebrity-problem) · [`§4 Sharding`](../interviews/social-feed/deep-dive.md#4-data-model--sharding) |
| **KV store** | Ring placement, tunable `W`, hot partitions, LSM as the local engine | [`§2`](../interviews/kv-store/deep-dive.md#2-partitioning-placing-keys-on-the-ring) · [`§4 N,W,R`](../interviews/kv-store/deep-dive.md#4-tunable-consistency-n-w-r-quorums) · [`§9 LSM`](../interviews/kv-store/deep-dive.md#9-the-local-storage-engine-lsm) · [`§12 Hot Partitions`](../interviews/kv-store/deep-dive.md#12-capacity-planning-and-hot-partitions) |
| **Message queues** | The shock absorber itself: partitions, consumer groups, lag, delivery semantics | [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) |
| **Consistent hashing** | Minimizing data movement on topology change — 32 Q&A + 25 diagrams | [`consistent-hashing/deep-dive.md`](../interviews/consistent-hashing/deep-dive.md) · [`answers.md`](../interviews/consistent-hashing/answers.md) |
| **Search autocomplete** | Batch vs streaming update pipelines (Kafka + Flink) feeding a read structure | [`§5`](../interviews/search-autocomplete/deep-dive.md#5-the-update-pipeline-batch-vs-streaming-kafka--flink) |
| **Recommendation system** | Kafka as the ingest backbone, and partitioning for even distribution | [`§3`](../interviews/recommendation-system/deep-dive.md#3-kafka-the-backbone-you-cannot-skip) · [`§4`](../interviews/recommendation-system/deep-dive.md#4-partitioning-the-art-of-even-distribution) |
| **Rate limiting** | The admission-control tier that protects the write path, and how it degrades | [`§4 Redis`](../interviews/rate-limiting/deep-dive.md#4-distributed-limiting-with-redis) · [`§7 Graceful Degradation`](../interviews/rate-limiting/deep-dive.md#7-failure-modes-and-graceful-degradation) |
| **Notification system** | Bulk fan-out to 50M users, priority tiers, provider rate control | [`§4 Fan-out`](../interviews/notification-system/deep-dive.md#4-fan-out-and-bulk-targeting) · [`§6 Priority`](../interviews/notification-system/deep-dive.md#6-priority-rate-control-and-user-preferences) |
| **Web crawler** | Bloom-filter dedup and a politeness-constrained frontier — write reduction by design | [`§3`](../interviews/web-crawler/deep-dive.md#3-url-deduplication-with-bloom-filters) · [`§2 URL Frontier`](../interviews/web-crawler/deep-dive.md#2-the-url-frontier-priority-meets-politeness) |

---

## 14. Real-World Cases

| Case | What's done | Lesson |
|---|---|---|
| **Ad click aggregators** | Client/collector pre-aggregation → stream processing → per-minute rollups, plus a slower exact batch path for billing | Two paths: fast-approximate for dashboards, slow-exact for money |
| **Metrics systems (Prometheus-style)** | Local scrape + aggregation, then federation/rollup upward; cardinality strictly governed | The bill is set by *label cardinality*, not request rate. Governance is an architecture concern |
| **Strava-style activity upload** | Bulk upload of a whole activity, then async processing into leaderboards and segments | Batch the write at the source; do the expensive derivation off the request path |
| **Uber location ingest** | Very high-frequency location writes into an in-memory/geo-indexed tier rather than a durable RDBMS per ping | Match durability to the data — a GPS ping from 4 seconds ago is worthless, so don't `fsync` it |
| **Twitter/X timelines** | Fan-out-on-write for most users, read-time merge for celebrities | The write amplification of precomputation has a ceiling; hybrid past it |
| **Cassandra / DynamoDB at scale** | LSM engines, partition-per-key, and explicit hot-partition guidance in their own docs | Vendors document hot partitions prominently because it's the #1 way users break these systems |
| **Kafka as a front door** | Accept-and-log at the edge, derive everything downstream | The durable log becomes the system of record, and every store becomes a rebuildable projection |

*(Company internals change and are often undisclosed — treat these as directionally accurate patterns, not verified current implementations.)*

---

## 15. Interview Questions

**Q1. Why can't you scale writes the way you scale reads?**
Because reads can be satisfied by copies and writes can't. A replica or cache multiplies read capacity, but every replica must *apply* every write, so adding replicas increases total write work rather than dividing it — ten replicas means the write stream executes eleven times across the fleet. On top of that, writes must be made durable (`fsync`, replication acks), often need per-key ordering, and for any given key there's exactly one owner. So the write toolbox is different: reduce the number of writes, spread distinct keys across independent owners, and absorb bursts. The first thing I'd establish is whether the writes are to the *same* key or *different* keys, because that determines which half of the toolbox applies.

**Q2. 10,000 writes/sec. How much disk I/O is that really?**
Considerably more than 10,000. Each logical insert is a WAL append, a table page write, one B-tree update per secondary index, and then all of that again on each replica; if it's an LSM, compaction will rewrite the same data ten to thirty times over its lifetime; and CDC, backups, and search indexers each add another copy. So 10k logical writes is plausibly 100k+ physical IOPS. This matters because it reframes optimization: dropping two unused indexes can beat a hardware upgrade, and it's a much cheaper change.

**Q3. LSM or B-tree for a write-heavy workload?**
LSM. A B-tree write locates a page and updates it in place, which is random I/O and forces a read-modify-write of the page; an LSM write is an in-memory memtable insert plus a sequential WAL append, deferring all reorganization to background compaction. Sequential beats random by a wide margin, especially on spinning disks and still meaningfully on SSDs. The cost is read amplification — a read may check the memtable plus several SSTables, which is why LSMs lean on Bloom filters — plus background compaction I/O that can cause write stalls if it can't keep up with ingest. That's the RUM conjecture: optimize reads, updates, or memory, pick two.

**Q4 (depth). 1M events/sec into a database. Walk me through your design.**
I wouldn't write 1M rows per second, so the first move is reduction rather than distribution. I'd batch at the producer — flush on 1000 events or 100ms, whichever first — which collapses a million transactions into a thousand, and if the consumer only needs counts I'd pre-aggregate so the raw events never get stored at all. Then I'd put a durable log like Kafka between ingest and storage, partitioned by entity key so ordering is preserved per key, which lets the API accept at burst rate while consumers drain at a sustainable rate and gives me replay if a consumer has a bug. Storage would be an LSM or purpose-built time-series store, not a B-tree relational table. And I'd ask whether exactness is required, because HyperLogLog for uniques and sketches for top-K turn unbounded-memory problems into fixed small ones. Only after all that would I discuss sharding, and I'd pick a composite key like `hash(tenant) + timestamp` rather than time alone.

**Q5 (depth). You put a queue in front. The write rate doubles permanently. What happens?**
The queue fails, just later and less visibly. A queue is a shock absorber for *bursts*: it works because arrival rate exceeds drain rate temporarily and the backlog drains afterwards. If arrival exceeds drain on average, queue depth grows without bound, so latency grows without bound and eventually you hit retention limits and lose data — which is strictly worse than rejecting requests up front, because it fails silently and the loss is discovered late. So queue depth and consumer lag are my primary SLIs, and sustained overload has only three real answers: increase drain capacity, reduce the write volume at the source, or shed load by priority. I'd also make sure the API contract is honest about asynchrony — a `202 Accepted` with a status endpoint, not a `200` implying durability the system hasn't achieved yet.

**Q6 (depth). One counter, 1M increments/sec. Sharding doesn't help. Now what?**
Right — sharding distributes keys, and there's only one key here, so no partitioning scheme touches this. I'd start with local pre-aggregation, which is usually sufficient and requires no data-model change: each app instance accumulates in memory and flushes one aggregated increment per second, so 1000 instances produce 1000 writes/sec instead of a million, at the cost of losing up to a second of counts if an instance dies. If I need more, I split the key with a random suffix into 100 physical counters and sum on read — write throughput ×100, but reads become 100× more expensive, so I only do this for keys I know are hot rather than as a blanket policy, which means I need hotness detection via a sketch plus a small routing table. The most robust option changes the data model entirely: write append-only event rows, which have no contention at all, and compute the counter asynchronously — then there's no hot mutable key in the system. Which one I pick depends on whether reads need the exact live value or can tolerate a slightly delayed aggregate.

**Q7 (senior). Take a system from 4 shards to 8 with no downtime.**
The naive answer breaks because `hash(key) % 4` → `% 8` relocates about half of all keys. My preferred position is to have avoided this by pre-allocating logical shards — create 1024 logical shards on day one and map many to each physical node, so scaling out is reassigning logical shards with no rehashing. Failing that, consistent hashing with virtual nodes moves only `1/N` of keys. If I have to migrate live with a key change, it's dual-write plus backfill: deploy the new topology and write to both, backfill history, then — the step people skip — continuously verify by comparing old against new with checksums or Merkle-style range comparison and reconcile drift, then shift reads gradually at 1/10/50/100% watching error rates, then stop writing to the old topology while keeping it as a rollback path before decommissioning. Every step has to be independently reversible, and skipping verification means discovering silent divergence after cutover, when there's no clean rollback left.

**Q8 (senior). Load shed or autoscale?**
Both, on different timescales, and neither substitutes for the other. Autoscaling has a lag of tens of seconds to minutes — boot, warmup, connection pools, cold caches — so it cannot answer a five-second spike; queueing and shedding cover the window until capacity arrives. Shedding has to be by priority, not random: drop telemetry first, then defer non-critical notifications, then degrade to coarser aggregation, then return `429` with `Retry-After`, and never shed payments or audit writes. The deeper point is that autoscaling the stateless tier while the database stays fixed just moves the queue downstream and can make things worse by pointing more connections at a saturated store. I'd also make sure clients use exponential backoff with jitter and retry budgets, since retry storms are what turn a brief overload into an outage, and unjittered retries synchronize into repeating waves.

**Q9 (senior). What's the cost of batching, and when is it not acceptable?**
Two costs. Latency: a write isn't visible until the batch flushes, so a 100ms window adds up to 100ms. And durability: buffered events live in process memory, so a crash loses the whole in-flight batch. That's a perfectly good trade for metrics, logs, analytics, and view counts, where losing a second of data changes nothing. It's unacceptable for orders, payments, and audit records — there, if I want batching's throughput I have to make the buffer durable first, which usually means appending to a replicated log synchronously and batching the *downstream* database writes instead. So the answer isn't "batch or don't", it's "where is the durability boundary", and I'd place it per data class rather than uniformly.

**Q10 (staff). Design a metrics pipeline for 100M events/sec.**
Nothing in that pipeline ever sees 100M events/sec except the client library, and that's the whole design. Hierarchical aggregation: the client SDK aggregates in-process into counters and histograms and emits every 10 seconds, which reduces volume by orders of magnitude immediately; a local or per-host collector aggregates across processes; a regional tier aggregates across hosts and does per-minute rollups; only pre-aggregated per-minute series reach the global store. Each level must use associative, commutative aggregations for this to be valid — sums and counts merge trivially, medians don't, which is why latency is carried as mergeable histograms or t-digests rather than raw percentiles. I'd need an explicit watermark policy for late data: how long a time bucket stays open, and a counter for events that arrive after it closes, so the loss is measured rather than invisible. Retries need to be idempotent across levels, deduped by batch ID, or the aggregate double-counts. And the real operational risk isn't event rate at all — it's **label cardinality**, since one high-cardinality label like user ID or request ID multiplies series count and blows up both memory and cost, so cardinality governance is part of the architecture rather than an afterthought. Finally, if any of these numbers are billed on, I'd run a slower exact batch recompute alongside the streaming path, because approximate is fine for a dashboard and not fine for an invoice.

**Q11 (staff). You've done everything and the write path is still saturated. What's left?**
At that point the remaining moves are about changing the problem rather than the plumbing. First, question the requirement: does every event need to be stored, or is a sample statistically sufficient — a 1% sample with known error bounds is often as useful and a hundred times cheaper. Second, split by data class and stop paying uniform costs: separate the small set of writes that need quorum durability and cross-region replication from the large set that can live at weaker durability in a cheaper store, because averaging those requirements is what makes the whole path expensive. Third, functional decomposition — move the write-heavy stream entirely off the transactional database into a purpose-built store, so the two workloads stop competing for the same IOPS and buffer pool. Fourth, push work to the client, which is genuinely the largest untapped capacity in most systems — batching, aggregation, and dedup on a billion devices costs me nothing. And fifth, accept a bounded loss deliberately, with an SLO on it, rather than pretending the system is lossless while it silently drops data under stress. The failure I'd want to avoid is scaling the write tier to handle a volume that nobody actually needs stored.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **Core asymmetry** | Reads scale by copying; every copy *adds* write work |
| **First question** | Same key or different keys? Same key ⇒ sharding won't help |
| **Write amplification** | WAL + heap + N indexes + replicas + compaction — 10k logical ≈ 100k+ physical IOPS |
| **Cheapest write win** | Drop unused indexes |
| **LSM vs B-tree** | LSM: sequential append + background compaction ⇒ high ingest. B-tree: random in-place |
| **RUM conjecture** | Optimize Read, Update, or Memory — pick two |
| **Group commit** | Amortize `fsync` across concurrent commits. Hundreds → tens of thousands of commits/sec |
| **LSM deletes** | Tombstones are *more* writes; space returns only after compaction |
| **Batching rule** | Flush on size OR time, whichever first. Size alone stalls; time alone is unbounded memory |
| **Batching cost** | Added latency + in-memory data lost on crash. Fine for telemetry, not for money |
| **Coalescing** | State-conveying writes (location, presence) only need the latest value |
| **HyperLogLog** | ~12KB for billions of uniques, ~2% error. Ask if exactness is required |
| **Queue = shock absorber** | Absorbs **bursts**, not sustained overload |
| **Sustained overload** | Queue depth grows unbounded → latency + silent data loss. Worse than fast rejection |
| **Async contract** | Queued ≠ committed. Owe the client a `202` + status endpoint |
| **Load shedding order** | Telemetry → non-critical notifications → degrade → `429`. Never payments/audit |
| **Backpressure** | Signal upstream to slow down. Unbounded in-memory buffer = OOM instead of shedding |
| **Retry storm** | Retries triple load exactly when you're weakest. Backoff **with jitter**, retry budgets, circuit breaker |
| **Autoscaling lag** | Tens of seconds to minutes — can't answer a 5s spike. And you can't autoscale the DB |
| **Horizontal sharding** | Rows across nodes by key |
| **Vertical partitioning** | Columns split by access pattern (hot vs cold) |
| **Functional sharding** | Whole tables/services to separate stores. Often the cheapest first cut |
| **Shard key must have** | High cardinality + uniformity. `status` and `country` are bad keys |
| **Time-ordered key trap** | Range-partitioning on time puts every insert on the newest shard |
| **Composite key** | `hash(tenant_id) + timestamp` — distribute across tenants, order within one |
| **Hierarchical aggregation** | client → collector → region → global; each level cuts volume by orders of magnitude |
| **Aggregation must be** | Associative + commutative. Sums merge, medians don't (use t-digest) |
| **Late data** | Needs an explicit watermark policy + a late-event counter |
| **Split all keys** | Random suffix ⇒ write ×N, read ×N. Only worth it for known-hot keys |
| **Split hot keys dynamically** | Detect with a sketch, split only those, keep a routing table |
| **Best hot-key first move** | Local pre-aggregation per instance — no key splitting needed |
| **Resharding: modulo trap** | `%4` → `%8` moves ~half of all keys |
| **Best resharding answer** | Pre-allocate 1024 logical shards on day one |
| **Dual-write migration** | both-write → backfill → **verify** → shift reads 1/10/50/100% → stop old → decommission |
| **The skipped step** | Verification. Silent drift found after cutover has no rollback |
| **Durability dial** | memory → OS buffer → fsync → W=1 → quorum → W=N → cross-region. Set it per data class |
| **The real question** | Which writes am I allowed to lose, and how many? |

---

## Related

- **Patterns:** [Scaling Reads](./scaling-reads.md) (check which side is actually saturated) · [Dealing with Contention](./dealing-with-contention.md) (when the hot key must also be *correct*) · [Long-Running Tasks](./long-running-tasks.md) (the queue + worker tier) · [Multi-Step Processes](./multi-step-processes.md) (cross-shard writes need sagas)
- **Fundamentals:** [write-ahead-log](../fundamentals/write-ahead-log.md) · [segmented-log](../fundamentals/segmented-log.md) · [consistent-hashing](../fundamentals/consistent-hashing.md) · [quorum](../fundamentals/quorum.md) · [bloom-filters](../fundamentals/bloom-filters.md) · [merkle-trees](../fundamentals/merkle-trees.md) · [circuit-breaker](../fundamentals/circuit-breaker.md)
- **Topics:** [`sharding-replication`](../interviews/sharding-replication/README.md) · [`storage-engines`](../interviews/storage-engines/README.md) · [`message-queues`](../interviews/message-queues/README.md) · [`kv-store`](../interviews/kv-store/README.md) · [`observability`](../interviews/observability/README.md) · [`ride-sharing`](../interviews/ride-sharing/README.md)
