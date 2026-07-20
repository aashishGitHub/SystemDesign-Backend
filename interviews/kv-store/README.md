# System Design: Distributed Key-Value Store (Dynamo-Style)

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended design choices.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note what you missed.
3. Use `deep-dive.md` for senior/architect depth, real-world system implementations, and failure modes.

This topic overlaps two siblings. It summarizes them and links out rather than re-teaching:
- [Consistent Hashing](../consistent-hashing/README.md) — the partitioning layer (ring, vnodes, preference lists).
- [Storage Engines](../storage-engines/README.md) — the single-node LSM tree, SSTables, compaction, Bloom filters.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Requirements & API | Why a KV store; `get`/`put` contract; scale, availability, latency targets |
| 2 | Partitioning | Consistent hashing + vnodes; how a coordinator routes a key to nodes |
| 3 | Replication | N replicas via the preference list; sync vs async replication |
| 4 | Tunable Consistency & Quorums | N/W/R, the W+R>N rule, sloppy quorum + hinted handoff |
| 5 | Conflict Resolution | Last-write-wins, vector clocks / version vectors, CRDTs, siblings |
| 6 | Anti-Entropy & Failure Detection | Read repair, Merkle trees, gossip, phi-accrual detector |
| 7 | Local Storage Engine | Commit log + MemTable + SSTable + compaction + Bloom filters |
| 8 | Architect Tradeoffs | Dynamo (AP) vs Bigtable/HBase (CP) vs Spanner; hot partitions; capacity math |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 32 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, real-system references. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-world implementations, production incidents, cheat sheet. |

---

## Problem Statement

> Design a distributed, highly-available key-value store like Amazon DynamoDB or Apache Cassandra. Clients call `put(key, value)` and `get(key)` against any node in the cluster. The system must stay writable during node and network failures, scale horizontally by adding commodity nodes, and let each workload trade consistency for latency and availability.
>
> **PUT /kv/{key}** — store a value for a key
> **GET /kv/{key}** — retrieve the value for a key
>
> **Key Constraints (illustrative — confirm real numbers with the interviewer):**
> - Billions of keys; average value ~1 KB (values from bytes to a few hundred KB)
> - ~1,000,000 ops/sec at peak, read-skewed but write-heavy enough to matter
> - 99.9% availability target for writes even during a single-DC or node outage
> - Single-key `get`/`put` p99 latency in the low single-digit milliseconds intra-DC
> - Multi-region deployment; must tolerate losing a whole datacenter

---

## How a Senior Engineer Thinks About This

A strong answer starts by justifying the data model before any boxes are drawn. A key-value store buys massive horizontal scale and predictable single-key latency by giving up joins, secondary indexes, and multi-key transactions. So the first question is always: *is the access pattern truly key-at-a-time?* If the interviewer needs range scans or ACID across keys, a pure Dynamo-style store is the wrong tool and you should say so out loud.

Next, a senior decomposes the system into three orthogonal layers and treats each as a separate decision. **Partitioning** (consistent hashing + virtual nodes) decides *where* a key lives — this is delegated to the [consistent hashing](../consistent-hashing/README.md) machinery. **Replication and consistency** (the preference list, N/W/R quorums, sloppy quorum, conflict resolution) decides *how many copies* and *how fresh* — this is the heart of the Dynamo paper. **Local storage** (the LSM engine covered in [storage engines](../storage-engines/README.md)) decides *how one node persists its share* durably and fast. Keeping these layers separate is what lets you reason about failure in each independently.

Finally, a senior candidate is explicit about the CAP tradeoff and where this design sits. Dynamo-style stores are AP: they stay available and writable during a partition and reconcile divergence later with vector clocks, read repair, and anti-entropy. That is a deliberate choice — Amazon's shopping cart must never reject an "add to cart," so occasional conflicting versions are acceptable and resolved at read time. They contrast this with CP designs (Bigtable/HBase leader-per-tablet, Spanner with TrueTime) that prefer rejecting writes during a partition to keep a single linearizable history. Naming that tradeoff, and the correct quorum math (`W + R > N`, classically N=3/W=2/R=2), is what separates a memorized answer from a designed one.
