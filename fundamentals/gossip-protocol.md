# Gossip Protocol

Nodes periodically exchange state with a few **random** peers instead of everyone talking to everyone. Information spreads exponentially through the cluster the same way a rumor does — no central coordinator, no single point of failure, and it scales to thousands of nodes.

---

## The Problem

A central coordinator that tracks cluster membership and health is a single point of failure and a bottleneck at scale — every node would need to talk to it, and it becomes the thing that must never go down. Gossip removes the coordinator entirely: every node knows a *little* and shares it with a *few* others, and correct global knowledge emerges from the aggregate.

---

## How It Works

1. Every node keeps a local view of cluster state (which nodes exist, their heartbeat counters, any metadata).
2. On a fixed interval, each node picks **1–3 random peers** and exchanges its state with them — "here's everything I know, what do you know that I don't?"
3. Each side merges the two views, keeping whichever version of each entry is newer (usually via a version/heartbeat counter).
4. Repeat. Within `O(log N)` rounds, a piece of new information (a node joining, a node dying) has propagated to the entire cluster.

```
Round 0: A learns "D joined"                     (1 node knows)
Round 1: A gossips to B, C                       (3 nodes know)
Round 2: B gossips to E, C gossips to F          (5-7 nodes know)
Round 3: ...                                     (exponential spread)
```

---

## Analogy

> Office gossip. Nobody sends a company-wide email — one person tells two coworkers at lunch, each of them mentions it to someone else during the afternoon, and by the next day everyone knows, even though no single message reached more than a couple of people.

---

## The Subtlety That Trips People Up

Gossip gives you **eventual** consistency of membership view, not instant — during the propagation window, different nodes can legitimately disagree about who's in the cluster. This is fine for membership/failure detection (a few extra seconds of disagreement rarely matters), but it means gossip alone is the wrong tool for anything requiring an immediate, agreed-upon decision (like "who is the leader right now") — that needs consensus, not gossip, layered on top.

---

## Interview Questions

**Q1. Why pick random peers instead of, say, always gossiping to your immediate neighbors?**
Random peer selection is what gives gossip its exponential, `O(log N)` spread — always talking to fixed neighbors would propagate information linearly around a ring or graph structure, taking `O(N)` rounds to reach everyone. Randomness means information reaches a fresh, previously-unaware part of the cluster almost every round.

**Q2. How does a node know which version of a piece of state is newer when merging?**
Each piece of state carries a version number or heartbeat counter that increments every time it changes at its origin node — when two nodes merge views, they just keep the higher version for each entry. No clock synchronization is needed because it's a logical counter, not wall-clock time.

**Q3 (depth). Does gossip guarantee every node eventually has an identical view of the cluster?**
Eventually yes, assuming the cluster is connected and gossip keeps running — but "eventually" is doing real work in that sentence. There's no bound on when any *specific* node converges, only a probabilistic expectation (`O(log N)` rounds on average). A system that needs a guaranteed-consistent membership view at a specific moment cannot rely on gossip alone.

**Q4 (senior). Why does Cassandra use gossip for membership but Raft-based systems (etcd, ZooKeeper) don't?**
Cassandra is leaderless and designed to scale to very large, dynamic clusters where a central membership authority would be a bottleneck and single point of failure — gossip fits that shape. Raft-based systems are small, fixed-size clusters (typically 3–7 nodes) where the whole point is a single agreed-upon state; running gossip there would add propagation delay and disagreement windows to a system explicitly built to avoid ambiguity.

---

## Where This Shows Up in This Repo

- [consistent-hashing/deep-dive.md §10 — Gossip Protocol: Ring Membership Without a Master](../interviews/consistent-hashing/deep-dive.md#10-gossip-protocol-ring-membership-without-a-master)
- [kv-store/deep-dive.md §8 — Membership and Failure Detection: Gossip + Phi Accrual](../interviews/kv-store/deep-dive.md#8-membership-and-failure-detection-gossip--phi-accrual)
- [heartbeat.md](./heartbeat.md) and [phi-accrual-failure-detection.md](./phi-accrual-failure-detection.md) — gossip is usually the transport that spreads heartbeat/liveness information cluster-wide
