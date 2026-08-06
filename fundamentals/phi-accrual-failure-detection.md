# Phi Accrual Failure Detection

Instead of a fixed heartbeat timeout ("dead after 5 seconds of silence"), compute a continuous **suspicion score (φ)** from the historical pattern of heartbeat arrivals. The application decides how suspicious is suspicious enough, instead of the detector hard-coding one universal cutoff.

---

## The Problem

A fixed timeout is a single number that has to work for every network condition and every node — too short and jittery networks cause false alarms (flapping healthy nodes), too long and real failures take forever to notice. Real heartbeat arrival times aren't perfectly regular; they follow a distribution, and a fixed threshold throws that distribution's information away.

---

## How It Works

1. Track the recent **history of intervals** between heartbeats from a given node (a sliding window of samples).
2. Compute the mean and variance of that history, treating arrival times as roughly following a statistical distribution.
3. When a heartbeat is late, compute **φ = -log₁₀(probability that a heartbeat would still arrive this late, given the historical distribution)**. The longer the silence relative to history, the higher φ climbs.
4. The caller picks a threshold (e.g. φ > 8 means "suspect dead") — higher thresholds mean more tolerance for jitter before declaring death, lower thresholds mean faster (but noisier) detection.

```
Historical heartbeat interval: mean ~1s, low variance (steady network)
  → silence of 3s → φ climbs fast → high suspicion quickly

Historical heartbeat interval: mean ~1s, but often bursts to 4s under load
  → silence of 3s → φ stays low → the detector has "learned" this node is bursty
```

---

## Analogy

> A friend who's chronically 5-10 minutes late to everything vs. one who's always exactly on time. If the punctual friend is 20 minutes late, you're worried immediately. If the chronically-late friend is 20 minutes late, you're only mildly concerned — same lateness, very different suspicion, because your model of "normal" for each person is different. Phi accrual builds that per-node "normal" automatically instead of using one rule for everyone.

---

## The Subtlety That Trips People Up

φ is not a boolean — it's a **continuously increasing confidence level**, and different subsystems in the same cluster can use *different* thresholds against the same underlying φ value. A load balancer might stop routing new traffic to a node at a low φ (mildly suspicious, be cautious) while a leader-election system waits for a much higher φ before triggering a costly re-election (only act on strong suspicion). A fixed-timeout detector can't offer this — it only has one signal, "timed out" or not.

---

## Interview Questions

**Q1. What specifically does a fixed heartbeat timeout throw away that phi accrual keeps?**
The historical *shape* of how heartbeats normally arrive for that specific node — its variance, its typical jitter, whether it's a bursty or steady sender. A fixed timeout applies one number to every node regardless of its normal behavior; phi accrual adapts per node from observed history.

**Q2. Why is φ expressed on a logarithmic scale instead of a raw probability?**
Raw probabilities of "still alive" shrink extremely fast and become hard to reason about or compare (0.01, 0.0001, 0.000001…). The `-log10` transform turns that into a clean, roughly linear-feeling scale (φ=1, φ=8, φ=16) where each unit increase represents an order-of-magnitude drop in the probability the silence is normal — easier to pick a meaningful threshold against.

**Q3 (depth). Two subsystems watching the same node pick different φ thresholds — is that a bug?**
No — it's the intended design. A low-cost, reversible action (temporarily deprioritizing a node for new traffic) should trigger on a low, cautious φ. A high-cost, hard-to-reverse action (triggering a full leader election, marking a node permanently dead and starting data re-replication) should require a much higher φ, because the cost of a false positive is much higher there. One shared φ signal, multiple thresholds calibrated to the cost of acting on it.

**Q4 (senior). Does phi accrual solve the fundamental "can't tell slow from dead" problem?**
No — nothing can, that's an impossibility result (see [heartbeat](./heartbeat.md), FLP/Two Generals), not an engineering gap. Phi accrual just makes the tradeoff *adaptive and tunable per situation* instead of a single blind guess baked into a fixed timeout; it reduces false positives from normal jitter, but a sufficiently long, genuine network partition still looks identical to a dead node, forever, from the outside.

---

## Where This Shows Up in This Repo

- [kv-store/deep-dive.md §8 — Membership and Failure Detection: Gossip + Phi Accrual](../interviews/kv-store/deep-dive.md#8-membership-and-failure-detection-gossip--phi-accrual)
- [consistent-hashing/answers.md — A27 Ring oscillation](../interviews/consistent-hashing/answers.md#a27-ring-oscillation) — Cassandra's phi accrual detector as the fix for heartbeat-timeout flapping, with a diagram
- [heartbeat.md](./heartbeat.md) — the raw signal phi accrual is built on top of
