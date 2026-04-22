# System Design: Distributed Caching

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
| 1 | Fundamentals & Motivation | Why caching exists, cache hit/miss, latency impact |
| 2 | Caching Strategies | Cache-aside, write-through, write-back, write-around |
| 3 | Eviction Policies | LRU, LFU, FIFO, TTL-based expiration |
| 4 | Redis Deep Dive | Data structures, persistence, cluster mode |
| 5 | Cache Invalidation | TTL, event-driven, write-through invalidation |
| 6 | Failure Modes | Stampede, penetration, avalanche, breakdown |
| 7 | Multi-Layer Caching | L1 in-process, L2 distributed, L3 CDN |
| 8 | Production Operations | Capacity planning, monitoring, cache warming |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 35+ structured interview questions (8 levels + bonus). |
| [answers.md](./answers.md) | Answers keyed to each question, with code/table per answer. |
| [deep-dive.md](./deep-dive.md) | Beginner → Senior → Architect depth, failure modes, and cheat sheet. |

---

## Problem Statement

> Your e-commerce platform has 100M active users. Product pages load in 800ms, with 60% of that time spent querying the database.
> The database is at 80% CPU during peak hours. Adding read replicas helps, but replication lag causes stale data issues.
>
> Design a distributed caching layer that:
> - reduces p99 read latency to < 50ms for hot data
> - handles 1M requests/sec with sub-millisecond cache latency
> - maintains consistency between cache and database
> - survives node failures without cascading to the database

**Key Constraints:**
- Peak read throughput: **1M reads/sec**
- Cache hit latency p99: **< 5ms**
- Cache hit ratio target: **> 95%** for hot data
- Data freshness: stale reads acceptable up to **30 seconds** for catalog, **0 seconds** for inventory
- Availability: cache failure should not take down the site

---

## How a Senior Engineer Thinks About This

A strong answer separates **read optimization** from **consistency guarantees**. Caching is primarily about reads — writes go to the database, and the cache is a derived view. The hard part is keeping that view fresh enough.

Next, they choose the caching strategy by write pattern: cache-aside for read-heavy workloads with infrequent writes, write-through when consistency matters more than write latency, and write-back only when write throughput is critical and some data loss is acceptable.

Finally, they reason about failure modes proactively: what happens when the cache is cold (stampede), when a key doesn't exist in the database (penetration), when many keys expire at once (avalanche), and when a hot key's cache node fails (breakdown). A senior design includes mitigations for each before the interviewer asks.
