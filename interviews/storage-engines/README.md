# System Design: Database Storage Engines (LSM-Tree vs B-Tree)

> **Target:** Senior / Staff engineers at distributed-systems and database orgs (Google, Meta, Amazon, DataStax-style vendors).
> **Style:** Interview-grill format — question first, then the defended engineering choice.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note the tradeoffs you missed.
3. Use `deep-dive.md` for senior/architect depth, real-system behavior, and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Why Storage Engines Matter | The memory/disk gap, random vs sequential I/O, the read/write/space tradeoff |
| 2 | B-Tree Fundamentals | Pages, fanout, height, in-place updates, page splits, fill factor, WAL/redo |
| 3 | LSM-Tree Write Path | WAL → MemTable → immutable SSTable; why append-only writes are fast |
| 4 | LSM Read Path & Bloom Filters | MemTable → SSTables newest-first, Bloom filters, sparse index, block cache |
| 5 | Compaction | Size-tiered vs leveled, tombstones/deletes, write stalls |
| 6 | Amplification & the RUM Conjecture | Read/write/space amplification; optimize two, pay in the third |
| 7 | Durability & Recovery | WAL, fsync, group commit, checkpoints, crash recovery, MVCC/snapshots |
| 8 | Architect Tradeoffs | Engine choice by workload, compaction tuning, write-stall incidents, SSD wear, capacity math |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 39 structured questions (8 levels + bonus). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, real systems, cheat sheet. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-system behavior, production incidents, cheat sheet. |

---

## Problem Statement

> You are choosing and operating the storage engine underneath a new database service. The write path must sustain a high-ingest workload; the read path must serve both point lookups and range scans; and the system must survive process crashes and power loss without losing acknowledged writes.
>
> **PUT key value** — durably store a key-value pair (acknowledged only when safe)
> **GET key** — retrieve the current value for a key (point lookup)
> **SCAN start end** — return all keys in a range, in sorted order
>
> **Key Constraints:**
> - An acknowledged write must survive an immediate power loss (durability)
> - Point reads and range scans must both be efficient
> - Sustain high write throughput without unbounded latency spikes
> - Storage cost (disk footprint vs logical data size) must stay bounded
> - Concurrent readers must see a consistent snapshot, never a half-written state

---

## How a Senior Engineer Thinks About This

A strong answer starts from physics, not from a product name. Disk (even SSD) is orders of magnitude slower than RAM, and *sequential* I/O is far cheaper than *random* I/O. Every storage-engine design is a strategy for turning the workload's access pattern into as much sequential I/O as possible while keeping enough index structure in memory to find data fast. That framing makes the B-tree-vs-LSM choice a consequence of the workload, not a matter of taste.

Next, they name the fundamental tension explicitly: the RUM conjecture (Athanassoulis et al., 2016). You can optimize for reads, for writes, or for space — but improving two typically worsens the third. B-trees update in place: read-optimized and space-tight, but every write is a random-ish page write with a full-page WAL cost. LSM-trees append and merge later: write-optimized, but a read may have to consult many SSTables, and space temporarily balloons before compaction reclaims it. Everything else (Bloom filters, compaction strategy, block cache) is a lever on one of these three axes.

Finally, a senior candidate is explicit about durability and failure behavior. They separate "the write is in memory" from "the write is on stable storage," explain what `fsync` actually guarantees and what group commit buys, and describe crash recovery for each engine (replay the WAL into a fresh MemTable for an LSM; redo/undo from a checkpoint for a B-tree). They can also point at the operational sharp edges — compaction-induced write stalls, tombstone build-up, and SSD write-amplification wear — before the interviewer asks.
