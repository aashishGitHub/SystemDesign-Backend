# System Design: Consistent Hashing

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended implementation choices.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note what you missed.
3. Use `deep-dive.md` for senior/architect depth, real-world company implementations, and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | The Core Problem | Why modulo hashing collapses when nodes change |
| 2 | The Hash Ring | How consistent hashing eliminates mass remapping |
| 3 | Virtual Nodes | How vnodes solve uneven distribution at scale |
| 4 | Ring Operations | How nodes join and leave without full reshuffling |
| 5 | Replication on the Ring | Preference lists, quorums, sloppy quorum, hinted handoff |
| 6 | Real Systems | Cassandra, DynamoDB, Redis Cluster, Akamai, Memcached |
| 7 | Failure Modes | Hot keys, biased hash, ring oscillation, heterogeneous nodes |
| 8 | Architect Tradeoffs | Jump consistent hash, range vs hash sharding, zero-downtime migration |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 32 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, company references. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-world company implementations, pattern recognition, anti-patterns, cheat sheet. |

---

## Problem Statement

> You are designing a distributed cache cluster. The cluster starts with 4 nodes. The system must be able to add nodes when load increases and remove nodes during maintenance — without causing a full cache flush or requiring all data to be remapped.
>
> **POST /cache/set** — store a key-value pair in the appropriate node
> **GET /cache/get?key=K** — retrieve the value for key K from the correct node
>
> **Key Constraints:**
> - Adding or removing one node should move at most 1/N of all keys
> - A key must always resolve to the same node for a given cluster state
> - Node additions/removals should not require downtime for other nodes
> - Load must be distributed approximately evenly across all nodes
> - At peak: 5M keys across 10 cache nodes, 200k reads/sec

---

## How a Senior Engineer Thinks About This

A strong answer starts with the failure mode of naive sharding: `hash(key) % n` remaps nearly all keys when n changes, causing a thundering herd against the database behind the cache. That context makes the purpose of consistent hashing immediately clear.

Next, they distinguish between the ring abstraction (which solves mass remapping) and virtual nodes (which solve uneven distribution). The ring alone with 3 physical nodes is still risky — three random points on a circle are unlikely to be evenly spaced. Virtual nodes are not an optimization; they are a correctness requirement at scale.

Finally, a senior candidate is explicit about replication and failure behavior. A distributed cache without replication is a single point of failure per key range. They name the quorum parameters (N, W, R), state the consistency/availability tradeoff explicitly, and describe what happens during a node failure before recovery completes.
