# PACELC Theorem

CAP only describes the rare case — a network partition. PACELC adds the trade that happens on **every single request, even when the network is perfectly healthy**: if there's a partition, choose Availability or Consistency (that's the "PAC" — pure CAP); **else** (network healthy), choose lower Latency or stronger Consistency (the "ELC").

---

## The Problem CAP Leaves Out

CAP is silent about the 99.99% of the time when there's no partition at all. But even then, a strongly consistent write (wait for a quorum/majority of replicas to durably ack) is slower than a fast write (ack locally, replicate asynchronously). That latency-vs-consistency trade is happening on every request your system serves, not just during outages — PACELC is the framework that names it.

---

## How It Works

```
PACELC:  if Partition → Availability vs Consistency   (this part IS just CAP)
         Else (healthy) → Latency vs Consistency        (the part CAP never addresses)

Write path, network healthy:
  Strong (EC): ack only after a quorum of replicas persist the write  → higher latency
  Fast   (EL): ack after the local/leader write; replicate async      → lower latency, staler reads possible
```

| Classification | During a partition | During normal operation | Illustrative system |
|---|---|---|---|
| PC/EC | Consistent | Consistent (slower) | Spanner |
| PA/EL | Available | Low latency (weaker) | DynamoDB/Cassandra, tuned that way |
| PC/EL | Consistent | Low latency | Some MongoDB configurations |
| PA/EC | Available | Consistent when healthy | Rare in practice |

(Labels depend on configuration, not the product name alone — treat as illustrative, not a fixed classification.)

---

## Analogy

> Planning dinner with three friends by text. To be *certain* everyone's coming, you wait for all three replies before booking — slow but sure. Or you book as soon as the first friend replies — fast, but someone might not show. Nobody's phone is broken in this scenario; you're trading speed for certainty on every single plan, not just during some rare communication breakdown. That everyday trade is PACELC's "else" branch.

---

## The Subtlety That Trips People Up

The **"else" branch is the actual point of PACELC**, and it's the part people forget after learning CAP — many engineers can recite "CP vs AP during a partition" but go blank when asked "what do you trade off when the network is fine?" That second question is PACELC's whole contribution: latency and consistency trade against each other on *every* write, driven by real physics (cross-region round-trip time), not by failure.

---

## Interview Questions

**Q1. What does PACELC add that CAP doesn't already say?**
CAP only tells you what to sacrifice during a partition — it says nothing about system behavior the rest of the time. PACELC's "else" branch names the latency-vs-consistency trade that exists on every request under completely normal, healthy network conditions, which is the situation a system spends the overwhelming majority of its time in.

**Q2. Why can't a synchronous, strongly-consistent cross-region write also be low-latency?**
Because a majority ack requires waiting for the round-trip to at least one remote region, and cross-region round-trip time is bounded by physics (the speed of light over that distance) — for a ~80ms RTT between two continents, a synchronous multi-region commit simply cannot land in single-digit milliseconds. This is a real constraint, not an engineering shortfall to be optimized away.

**Q3 (depth). Google Spanner is PC/EC — it makes every commit slower even with no partition. Why would anyone accept that?**
Spanner adds a deliberate "commit-wait" (a few milliseconds, TrueTime-bounded) on every transaction specifically to guarantee external consistency — a stronger, harder guarantee than most systems offer. Google judged that predictable strong semantics were worth a small, bounded latency tax for their transactional workloads, where correctness bugs from weaker consistency would be far costlier than a few extra milliseconds per commit.

**Q4 (senior). How would you use PACELC to justify different consistency settings for different endpoints in the same product?**
State each endpoint's latency budget and blast radius explicitly: a social feed's like-count can be EL (fast, eventually consistent) because staleness is invisible to the user and costs nothing; a payment or inventory-decrement endpoint should be EC (consistent, accept the latency) because a stale read there causes double-spends or oversold inventory. The architect's move is picking this per operation and defending it with a stated latency budget — not applying one blanket policy ("always strong" or "always fast") system-wide.

---

## Where This Shows Up in This Repo

- [distributed-transactions/deep-dive.md §4 — PACELC: The Everyday Tradeoff](../interviews/distributed-transactions/deep-dive.md#4-pacelc--the-everyday-tradeoff) — the dinner-planning analogy, the classification table, and the Spanner TrueTime commit-wait example with real RTT numbers
- [cap-theorem.md](./cap-theorem.md) — the partition-only half of this same idea
