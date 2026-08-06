# Consistent Hashing

A way to map both **keys** and **nodes** onto the same circular hash space so that adding or removing one node moves only **~1/N** of the keys — not almost all of them.

> This is a primer. The full 8-level deep dive with 32 questions and 25 diagrams lives in [`interviews/consistent-hashing/`](../interviews/consistent-hashing/README.md) — go there for anything past the summary below.

---

## The Problem

Naive sharding with `hash(key) % N` reshuffles nearly every key whenever `N` changes: going from 4 to 5 nodes remaps ~80% of keys. For a cache, that means a mass cache-miss flood — a thundering herd against the database — every time you scale.

---

## How It Works

1. Hash both nodes and keys onto the same ring (e.g. 0 to 2³²−1).
2. A key belongs to whichever node is the **first one found walking clockwise** from the key's position.
3. Adding a node only steals keys from its immediate clockwise neighbor — every other node is untouched.
4. In practice, each physical node gets **many virtual positions** (vnodes, e.g. 256), because 3–10 random points on a circle are not evenly spaced — vnodes smooth that out statistically.

---

## Analogy

> Round tables at a wedding, seated clockwise by last-name hash. Adding one more table only reseats the people between the new table and the next one — everyone else stays put.

---

## The Subtlety That Trips People Up

The ring solves **mass remapping**. It does **not** solve **hot keys** — one viral key can still overwhelm the single node that owns it, because consistent hashing only balances the *key space*, not *access frequency* per key. That needs a separate fix (local cache, key splitting, dedicated replicas).

---

## Interview Questions

**Q1. Why a ring instead of a line?**
A line has an edge case: the node at the highest position has no successor, so its range is undefined. Wrapping the line into a ring gives every node a well-defined successor with no special case.

**Q2. With 3 physical nodes and no virtual nodes, what can go wrong?**
Three random hash positions are rarely evenly spaced — one node can end up owning 50%+ of the ring while another owns under 1%. Virtual nodes (100+ per physical node) fix this via the law of large numbers, not by design — it's a statistical smoothing, not a guarantee.

**Q3 (depth). Does consistent hashing help with a single overloaded key?**
No — that's a common trap. A key deterministically maps to exactly one node; if that one key gets 100x the traffic, that node is still overloaded regardless of ring topology. Fix hot keys with an L1 cache, key splitting (`user:1:shard:N`), or dedicated read replicas — not by touching the ring.

**Q4 (senior). You're asked to migrate a live system from modulo hashing to consistent hashing with zero downtime — outline it in three sentences.**
Dual-read with fallback: try the new ring first, fall back to the old modulo node on a miss, and populate the ring as you go. Dual-write to both systems during the transition so neither falls behind. Once the ring is fully warm, cut reads over, then writes, then decommission the old path.

---

## Where This Shows Up in This Repo

- [interviews/consistent-hashing/](../interviews/consistent-hashing/README.md) — the full topic (ring mechanics, vnodes, replication/quorum, real systems, failure modes, architect tradeoffs)
- [web-crawler/deep-dive.md §6 — Distributing Work by Domain](../interviews/web-crawler/deep-dive.md#6-distributing-work-consistent-hashing-by-domain)
- [kv-store/deep-dive.md §2 — Partitioning: Placing Keys on the Ring](../interviews/kv-store/deep-dive.md#2-partitioning-placing-keys-on-the-ring)
