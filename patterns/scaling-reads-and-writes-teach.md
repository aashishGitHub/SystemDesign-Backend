# Teach Script: Scaling Reads & Scaling Writes

> **What this file is:** a demo-first walkthrough of these two companion patterns, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the diagnostic, don't just recognize the vocabulary.
> **Not a replacement for:** [`scaling-reads.md`](./scaling-reads.md) and [`scaling-writes.md`](./scaling-writes.md) (the full pattern write-ups, each with its own decision framework and interview Q&A). This is the narrated version, covering both at once because they're explicitly companions — "check which side is actually saturated" is the first line of both files.
> **Every number and fact below is pulled from this repo's own [`scaling-reads.md`](./scaling-reads.md) and [`scaling-writes.md`](./scaling-writes.md)** — nothing here is a new claim.

---

## 1. The symptom

Your primary database is at 90% CPU and climbing. You do the textbook thing: you add five read replicas. You wait for the dashboards to calm down.

**Latency gets *worse*.** Not "no better" — measurably worse than before you touched anything. The team is confused, because "add replicas when the database is struggling" is supposed to be the correct move, and everyone in the room has done it successfully before. Nothing about this deployment failed. The replicas synced fine, the app is routing reads to them correctly, and the system is still degrading in front of you.

## 2. Why you should care

This is the single highest-leverage diagnostic mistake in all of database scaling, precisely because "add read replicas" is the *right* answer roughly half the time and an *actively harmful* one the other half — and the only way to know which half you're in is to ask one question before touching anything. Skipping that question is exactly what separates a candidate who's operated a real database from one who's only read about scaling it.

## 3. What / Why / How

1. **What is structurally different about a read and a write** that lets the same symptom — high CPU, rising latency — hide two completely different diagnoses?
2. **Why does the exact same fix — adding replicas — help in one case and actively hurt in the other?**
3. **How do you correctly diagnose which side is saturated, and what's the right toolbox once you know?**

## 4. Umbrella words — kill them before using them

**"Scale it."** This hides the one asymmetry everything else in both patterns is built on: **reads can be satisfied by copies, and copies are cheap — a cache, a replica, a CDN edge, all just duplicate an answer that's allowed to be slightly stale. Writes cannot be copied away — every replica must independently *apply* every single write.** That one sentence is why "add capacity" means something completely different on each side.

**"It's slow."** On the read side this decomposes into a specific diagnostic table worth memorizing: mean latency fine but p99 terrible → an outlier (contention, a hot row, occasional full scans), not volume — adding replicas won't touch it; all latencies degrading as load rises → a genuine capacity ceiling, where replicas *do* help; bad even at low load → a missing index or bad query plan, which no amount of hardware fixes; CPU low but disk I/O pinned → the working set doesn't fit in RAM, so the fix is memory or a cache, not more nodes.

**"Write amplification."** A number like "10,000 writes/sec" is never actually 10,000 writes. Decompose it: one logical insert is a WAL append, a heap/page write, one B-tree update *per secondary index*, then all of that *again* on every replica, plus — for an LSM engine — background compaction rewriting the same data 10 to 30 times over its lifetime. **10,000 logical writes/sec can easily be 100,000+ physical IOPS.** This is why dropping two unused indexes can be a bigger win than a hardware upgrade — it's deleting write work you never needed, not optimizing it.

## 5. The boxes — built one need at a time, as a diagnosis, not an architecture

This topic's "boxes" are a decision process, not a system diagram — but the same rule applies: don't reach for a tool until the previous step has told you which one is actually needed.

**Your system is slow. The first, mandatory question, before anything else: is this a read problem or a write problem?** Not "which one seems more likely" — actually check. A read-saturated primary and a write-saturated primary look identical on a CPU graph, and the correct fix for one is actively harmful applied to the other. This is exactly the fork the symptom in section 1 fell into blind.

**If it's a read problem:** first ask whether it's bad even at low load (a query-plan problem — go run `EXPLAIN`, no infrastructure change touches this) or whether it degrades specifically as load rises (a genuine capacity story). If genuine capacity: is the same data read repeatedly? If yes, a **cache** is almost always the highest-leverage move — a cache hit is sub-millisecond and removes load from the database entirely, versus a replica which still costs a real database query. Replicas earn their place when reads are *diverse* (low repetition, so a cache's hit rate would be poor) or when you need geographic locality or a failover target. Only after caching and replication are you looking at precomputation (materialized views, denormalization) or, as a last resort, sharding the reads.

**If it's a write problem, the order is different, and the very first rung is the one people skip entirely: can you write *fewer times*, before you distribute anything?** Batching (flush on size or time, whichever trips first — collapsing a million transactions into a thousand), aggregation/coalescing (a driver's location or a user's presence only needs the *latest* value — nine stale updates carry zero information the product needs), and approximate structures (HyperLogLog for unique counts, ~12KB regardless of whether the true count is a thousand or a billion, at ~2% error) can each cut real write volume before you've touched a single server.

**Only then: is the load spiky or sustained?** Spiky → a **queue** absorbs it, converting a burst into queue depth instead of errors — but say the caveat out loud before the interviewer does: a queue absorbs *bursts*, not *sustained* overload; if arrival rate exceeds drain rate on average, queue depth grows without bound and you've converted a fast, visible failure into a slow, silent one. Sustained overload above real capacity → **shed by priority** (drop telemetry first, defer non-critical notifications, degrade granularity, only then reject with `429` — and never shed payments or the audit log) plus **backpressure**, never an unbounded in-memory buffer that just delays the crash into an OOM.

**Now — the gap that produces the symptom from section 1, made explicit.** If, after all of this, the write side is still above one node's throughput, the fix is sharding — spreading *different* keys across independent owners. But **replicas are never the write-scaling tool**, because — say this exact sentence, it's the crux — **every replica must apply every write it receives, so adding replicas multiplies write work across the fleet, it never divides it.** Adding five replicas to a write-saturated primary doesn't relieve the primary of anything; it adds the cost of replicating every single write to five additional destinations, on top of the write load that was already too much.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **reads scale by making copies, because a stale copy is usually acceptable and a copy only has to serve requests once it exists; writes cannot be copied away, because every replica must independently apply every write, so the very same fix — adding replicas — divides read load across the fleet while it simultaneously multiplies write load across it.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact syntax for a covering index or cursor-based pagination, the precise `HyperLogLog` error-rate figure for your specific implementation, the literal Redis commands for a cache-aside read — useful specifics to reach for once you know *why* you're reaching for them, not things to memorize cold.

**Understand once, then trust it:** *why* an LSM-tree ingests faster than a B-tree (sequential append plus deferred, background compaction versus random in-place page updates — the RUM conjecture: optimize read, update, or memory, pick two) — know the property and when it applies, you don't need to re-derive the mechanics from scratch each time; consistent hashing as the standard fix for minimizing data movement when you reshard — know it's the answer, the mechanics live in their own topic.

**This is the actual idea — think hard here:** (1) the one mandatory question before touching anything is **"read problem or write problem, and same key or different keys"** — get either wrong and your fix can be actively harmful, exactly like section 1; (2) "can I write fewer times" is the single highest-leverage, most-skipped rung on the write side, and it comes *before* any infrastructure change, not after; (3) a queue is a shock absorber for **bursts only** — mistaking it for a permanent capacity fix just delays a failure and makes it silent instead of loud; (4) sharding distributes **keys** — it does nothing at all for one single overloaded key or row, on *either* side of this pattern pair, and that single fact is worth naming unprompted whenever "just shard it" comes up as an answer to a hot-key problem.

## 7. The build — the smallest thing that actually shows the mechanism

No real database cluster here — the arithmetic that actually matters, "reads divide across a fleet, writes multiply across it," is fully visible with two small functions:

```python
# save as replica_arithmetic_demo.py, run with: python3 replica_arithmetic_demo.py

def primary_workload(num_replicas, write_ops):
    """The primary must process every write once, AND ship/replicate every
    write to every replica — that replication is real, additional work,
    not free. Reads are assumed fully offloaded to replicas."""
    own_processing = write_ops
    replication_cost = write_ops * num_replicas
    return own_processing + replication_cost

def per_replica_workload(num_replicas, read_ops, write_ops):
    """Reads DIVIDE across replicas. Writes do NOT — every replica applies
    every write it receives, in full, no matter how many other replicas
    exist."""
    if num_replicas == 0:
        return 0
    reads_per_replica = read_ops / num_replicas
    writes_per_replica = write_ops
    return reads_per_replica + writes_per_replica

def report(label, read_ops, write_ops, num_replicas=5):
    before = read_ops + write_ops
    primary_after = primary_workload(num_replicas, write_ops)
    replica_after = per_replica_workload(num_replicas, read_ops, write_ops)
    print(f"--- {label} ({read_ops} reads/sec, {write_ops} writes/sec) ---")
    print(f"Before (primary alone handles everything): {before} ops/sec")
    print(f"After adding {num_replicas} replicas: primary={primary_after:.0f} ops/sec, each replica~={replica_after:.0f} ops/sec")
    print()

report("Scenario A — READ-heavy",  read_ops=9500, write_ops=500)
report("Scenario B — WRITE-heavy", read_ops=500,  write_ops=9500)
```

Run it. In the read-heavy scenario, the primary's own burden drops from **10,000 to 3,000** ops/sec, and each replica comfortably carries about 2,400 — adding replicas was exactly the right call. In the write-heavy scenario — the same five replicas, the same total 10,000 ops/sec starting point — the primary's burden **climbs from 10,000 to 57,000**, because it now has to replicate every one of its 9,500 writes/sec to all five replicas on top of processing them itself. You added five machines and made the actual bottleneck almost six times worse. This is section 1's symptom, reproduced as pure arithmetic.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Change `num_replicas=5` to `num_replicas=20` in the write-heavy `report()` call and rerun. The primary's burden climbs to **199,500** ops/sec — nearly 20× the original problem. Notice the direction: in a write-bound system, **adding more replicas makes the actual bottleneck worse in direct proportion to how many you add.** That's the opposite of what "scaling out" is supposed to mean, and it's a mechanical certainty, not a tuning mistake — it follows directly from "every replica applies every write."

**Sabotage 2 (walk it in your head, no code needed).** Now take the read-heavy scenario — the one where replicas genuinely helped — and change one fact: those 9,500 reads/sec aren't spread across many different rows, they're all reads of the *exact same* row (a single viral post). Walk it: replicas still help here, because a read only has to be served by *one* node, and any of the five replicas can serve that hot row's data equally well — this is exactly what a cache or a read replica is *for*. Now flip it to the write side: imagine those 9,500 *writes*/sec aren't to different rows either — they're all increments to one single shared counter. Walk that: **no number of replicas or shards touches this at all**, because every one of those writes must still be serialized through whichever single node legitimately owns that one row — replication doesn't parallelize ownership, and sharding distributes *different* keys, not repeated writes to the *same* key. A hot read key is solved by copying; a hot write key requires changing the data model (batch it, pre-aggregate it locally, split it into sub-counters) — the two "hot key" problems that sound identical are solved by opposite mechanisms.

## 9. One-sentence recap

Same words as before, on purpose: **reads scale by making copies, because a stale copy is usually acceptable and a copy only has to serve requests once it exists; writes cannot be copied away, because every replica must independently apply every write, so the very same fix — adding replicas — divides read load across the fleet while it simultaneously multiplies write load across it.**

## 10. What transfers

Swap Postgres for MySQL, or Redis for Memcached, and this lesson is unchanged — the exact engine and command syntax are the incidental, swappable pieces. What transfers to **every** system that separates reads from writes at all, regardless of stack: the mandatory diagnostic question — read-bound or write-bound, same key or different keys — asked *before* any fix, because the wrong answer can make things actively worse, not just fail to help; "reduce the write volume itself" as the highest-leverage, most-skipped move on the write side; a queue's absorption being bounded to bursts, never sustained load; and the fact that no amount of horizontal scaling — replicas or shards — touches a single overloaded key, on either the read or the write side, for structurally opposite reasons.

---

## Recall check — answer these without scrolling up

1. **Describe the core asymmetry in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What breaks if you skip each diagnostic step?**
   - *Model answers:* skip "read problem or write problem" → you can add replicas to a write-bound system and make the actual bottleneck worse, exactly like section 1. Skip "can I write fewer times" and jump straight to sharding → you pay the operational cost of a distributed write path for volume that batching or aggregation could have eliminated for free. Skip "is this a hot single key" and reach for more shards → nothing improves, because sharding only ever distributes *different* keys.
3. **What would you look at first if a database was struggling in production?** *(Model answer: whether latency is bad even at low load [query plan — `EXPLAIN` it] or specifically rises with load [genuine capacity]; then whether CPU or disk I/O is the actual pinned resource, and on the write side, the read:write ratio of that load, since "the database is at 90% CPU" tells you nothing about which half of the scaling toolbox to use until you know that.)*

If you answered all three cold, go read [`scaling-reads.md`](./scaling-reads.md) and [`scaling-writes.md`](./scaling-writes.md) anyway — this script deliberately skipped hierarchical aggregation pipelines, online resharding mechanics, durability dials, and the full failure-mode tables (cache stampede/penetration/avalanche, retry storms, hot-shard detection) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
