# System Design: Database Sharding & Replication

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
| 1 | Fundamentals & Motivation | Why sharding exists, vertical vs horizontal scaling limits |
| 2 | Sharding Strategies | Range, hash, directory-based sharding and when each breaks |
| 3 | Replication Models | Leader-follower, multi-master, replication topologies |
| 4 | Consistency & Lag | Replication lag, read-your-own-writes, monotonic reads |
| 5 | Cross-Shard Operations | Scatter-gather, distributed joins, global transactions |
| 6 | Hot Shards & Re-sharding | Hot key mitigation, online resharding, zero-downtime migration |
| 7 | Advanced Patterns | CQRS, change data capture, global distribution |
| 8 | System Integration | Applying sharding decisions inside end-to-end design problems |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 32 structured interview questions (8 levels + bonus). |
| [answers.md](./answers.md) | Answers keyed to each question, with code/table per answer. |
| [deep-dive.md](./deep-dive.md) | Beginner → Senior → Architect depth, failure modes, and cheat sheet. |

---

## Problem Statement

> You have a single PostgreSQL instance serving a social platform.
> The users table now has **2 billion rows**. Writes are at **50K/sec** peak, reads at **500K/sec** peak.
> The instance is CPU-bound, running out of disk, and replication lag on the read replica is 30 seconds.
>
> Design a sharded, replicated database architecture that:
> - scales writes beyond a single node
> - keeps read latency under 10ms at p99
> - maintains strong consistency for critical paths (payments, seat holds)
> - supports online resharding without downtime

**Key Constraints:**
- Peak write throughput: **50K writes/sec** globally
- Read latency p99: **<= 10ms**
- RTO (Recovery Time Objective): **< 30 seconds** on node failure
- RPO (Recovery Point Objective): **< 1 second** data loss tolerance
- Data size: **10 TB** total, growing at **1 TB/month**

---

## How a Senior Engineer Thinks About This

A strong answer starts by distinguishing **what to shard** from **how to shard**. Not every table needs sharding — only write-hot tables do. Static or reference data stays on a single replicated node.

Next, they pick the sharding key by traffic pattern: range-based for chronological data (logs, events), hash-based for user-centric data, and directory-based when the key space is irregular or reassignment is frequent. They proactively call out**hot key anti-patterns** (e.g., celebrity users, popular events) and how to mitigate them.

Finally, they reason about the consistency tier per use case: eventual consistency is fine for feeds and analytics, but write-read-own consistency is required for profile updates, and strong consistency is required for balance deductions. A senior answer explicitly names the replication mode (sync vs async) per route and acknowledges the latency cost of synchronous cross-region replication.
