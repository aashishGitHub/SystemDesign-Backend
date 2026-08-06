# Heartbeat

A small periodic "I'm alive" message sent from one node to another. Its absence — not its content — is the signal: enough missed heartbeats means the sender is presumed dead (or unreachable, which looks the same from the outside).

---

## The Problem

Distributed systems need to know which nodes are up to route around dead ones, but there's no direct way to "ask" a node if it's alive — a request to a dead node just times out, indistinguishable at first from a request to a slow-but-alive node. Heartbeats turn liveness into a continuous, cheap background signal instead of an expensive per-decision probe.

---

## How It Works

1. Every node sends a lightweight "alive" ping to its peers (or a central coordinator) on a fixed interval (e.g. every 1 second).
2. Each receiver tracks the last time it heard from each peer.
3. If no heartbeat arrives within a **timeout window** (a multiple of the interval, to absorb jitter), the peer is marked suspected/dead.
4. Downstream systems (leader election, load balancers, cluster membership) react to that state change.

```
Node B heartbeats every 1s. Node A's timeout = 5s of silence.

t=0,1,2,3,4  heartbeats arrive on schedule → B considered alive
t=5..9       silence — no heartbeat
t=9          5s since last heartbeat exceeded → A marks B DEAD
```

---

## Analogy

> A ship radioing "still afloat" every hour on a fixed schedule. Missing one call might just be static. Missing five in a row is when the coast guard gets worried — the absence of the routine, not any single message, is the alarm.

---

## The Subtlety That Trips People Up

**A missed heartbeat means "unreachable," not "dead."** A node can be fully alive and correct but partitioned from the network, or paused by a long GC — a fixed timeout can't distinguish "dead" from "slow" from "network is briefly congested" (this is the FLP/Two Generals result stated informally: you cannot reliably tell "crashed" from "slow" in an asynchronous network). Every heartbeat-based failure detector is making a probabilistic call, and the timeout you choose is really a dial between **false-positive rate** (declaring alive nodes dead) and **detection speed** (how long a genuinely dead node stays "alive" in the cluster's view).

---

## Interview Questions

**Q1. Why not just check liveness only when you need to route a request, instead of continuously?**
Continuous heartbeats amortize the cost and give you a *pre-computed* answer the instant you need to route — checking on-demand means every routing decision pays a timeout's worth of latency when the target happens to be down. Heartbeats trade a small constant background cost for near-zero-latency failure detection at decision time.

**Q2. What's the tradeoff in picking the heartbeat timeout?**
A short timeout detects real failures fast but risks false positives from transient network jitter or GC pauses — flapping a healthy node in and out of the cluster. A long timeout is more tolerant of jitter but leaves a genuinely dead node "alive" in the cluster's view for longer, during which requests keep getting routed to it and failing.

**Q3 (depth). Two nodes both stop hearing from each other due to a network partition — can they both correctly conclude the other is dead?**
They can each *conclude* the other is unreachable, but "unreachable to me" isn't the same as "dead" — the other node might be alive and heartbeating fine to a third node. This is exactly why failure detection alone doesn't decide cluster membership safely; it has to be combined with quorum/consensus so that only the majority side can act on the belief that the minority side is gone. See [split-brain](./split-brain.md).

**Q4 (senior). Why might you use a Phi Accrual failure detector instead of a fixed heartbeat timeout?**
A fixed timeout is a single hard threshold that can't adapt to a node whose heartbeat interval naturally varies (e.g. under load). Phi Accrual instead computes a continuous suspicion score from the historical distribution of heartbeat arrival times, so the "how sure are we this node is dead" question gets a tunable confidence level instead of a binary yes/no at one arbitrary cutoff. See [phi-accrual-failure-detection](./phi-accrual-failure-detection.md).

---

## Where This Shows Up in This Repo

- [consensus/deep-dive.md §9 — The Theory: FLP, Two Generals, and Impossibility](../interviews/consensus/deep-dive.md#9-the-theory-flp-two-generals-and-impossibility) — "you can't tell slow from dead," stated formally
- [consensus/deep-dive.md §6 — Raft Leader Election and Terms](../interviews/consensus/deep-dive.md#6-raft-leader-election-and-terms) — heartbeats as the mechanism that suppresses unnecessary elections
- [consistent-hashing/answers.md — A27 Ring oscillation](../interviews/consistent-hashing/answers.md#a27-ring-oscillation) — what happens when heartbeat-based detection flaps on a live node
- [phi-accrual-failure-detection.md](./phi-accrual-failure-detection.md) and [gossip-protocol.md](./gossip-protocol.md) — the two mechanisms usually built on top of raw heartbeats
