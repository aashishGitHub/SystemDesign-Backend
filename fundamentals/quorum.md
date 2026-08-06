# Quorum

A **quorum** is the minimum number of nodes that must agree before an operation counts as done. The word covers **two different mechanisms** in system design — conflating them is the single most common quorum mistake in interviews.

---

## The Two Meanings

| | Consensus quorum (Raft, Paxos, ZooKeeper) | Dynamo-style quorum (Cassandra, DynamoDB, Riak) |
|---|---|---|
| Size | Fixed **majority**: `⌊N/2⌋ + 1` | **Tunable**: any `W`, `R` you choose |
| Purpose | Safety — only one majority can exist at a time, so two conflicting decisions can never both get quorum | Latency/consistency knob per request |
| Can it be "sloppy"? | **Never** — a non-majority write is not a write | **Yes, deliberately** — sloppy quorum writes to a substitute node during a failure |
| Strong consistency? | Always, by construction | Only if `W + R > N` |
| Failure behavior | Below-majority partition simply cannot make progress (by design) | Below-quorum partition can still serve via substitutes + hinted handoff |

They rhyme because both rely on the same math fact: **any two "more than half" groups must overlap by at least one member.** Consensus uses that overlap to guarantee only one leader/decision exists. Dynamo-style stores use the *generalized* form (`W + R > N`, which doesn't require either to be a majority) to guarantee a read overlaps a write.

---

## How the Math Works

```
Consensus majority:      quorum = ⌊N/2⌋ + 1        (both W and R are this same majority)
Failures tolerated:      N − quorum = ⌊(N−1)/2⌋

Dynamo-style tunable:    any W, R with  W + R > N   guarantees overlap
  N=3, W=2, R=2 → W+R=4 > 3 ✅ strong, balanced
  N=3, W=3, R=1 → W+R=4 > 3 ✅ strong, fast reads, slow writes
  N=3, W=1, R=1 → W+R=2 < 3 ✗ eventual only, fastest
```

---

## Analogy

> Consensus quorum is a courtroom jury: you need more than half to convict, full stop, or the trial hangs — no partial verdicts. Dynamo quorum is a group buying a gift: you choose ahead of time how many people must chip in (`W`) and how many must be asked before you're sure everyone agrees on the amount (`R`) — you can trade off speed for certainty per purchase.

---

## The Subtlety That Trips People Up

`W + R > N` guarantees a read's replica set **overlaps** the write's replica set — it does **not** guarantee every replica is caught up. A replica outside both the write quorum and the read quorum can sit stale indefinitely without violating the condition; that's what anti-entropy (read repair, Merkle trees) is for, not the quorum formula itself.

---

## Interview Questions

**Q1. Why must a consensus quorum be a strict majority, not just "more than one"?**
So any two quorums are forced to overlap by at least one node. If quorum were, say, 40% of a 5-node cluster (2 nodes), two disjoint groups of 2 could each claim quorum during a partition and both elect a leader — split brain. Majority makes that mathematically impossible.

**Q2. N=5 cluster: what's the quorum, and how many failures does it tolerate? Why not N=6 for "more safety"?**
Quorum = 3, tolerates 2 failures. N=6 also has quorum 4 and tolerates only 2 failures — the *same* fault tolerance for a strictly more expensive cluster (more replicas, more write fan-out, more coordination). Odd N is the efficient choice; even N pays for nothing.

**Q3 (depth). Given N=3, why would anyone pick W=1, R=1 over W=2, R=2?**
Throughput and latency: `W=1,R=1` returns as soon as the fastest single replica responds, so tail latency is much lower and each node acks independently. The cost is eventual consistency only — acceptable for things like "like counts" or metrics, unacceptable for account balances.

**Q4 (senior). A Dynamo-style write succeeds with sloppy quorum during a node outage — did it use a "quorum"?**
Yes, but not the *preferred* one: it counted a substitute node's ack toward `W` because the intended replica was unreachable. This is legal precisely because Dynamo-style quorum is a tunable availability knob, not a safety invariant — a consensus system could never do this, because "any 2 nodes count" would break the overlap guarantee that makes consensus safe.

**Q5 (staff). Your on-call sees a Cassandra read at `LOCAL_QUORUM` return a value, then a follow-up read moments later return something older. Is `W+R>N` broken?**
No — `W+R>N` guarantees the read set intersects the write set for *one* write, not monotonic reads across separate requests hitting different coordinators/replicas. Without session guarantees (read-your-writes, monotonic reads), two independent quorum reads can legitimately land on different overlapping-but-not-identical replica subsets. Fix at the client-consistency layer, not by raising `R`.

---

## Where This Shows Up in This Repo

- [kv-store/deep-dive.md §4 — Tunable Consistency: N, W, R Quorums](../interviews/kv-store/deep-dive.md#4-tunable-consistency-n-w-r-quorums) — the Dynamo-style mechanism in full, including a coordinator sketch
- [consensus/deep-dive.md §13 — Quorum Math and Cluster Sizing](../interviews/consensus/deep-dive.md#13-quorum-math-and-cluster-sizing) — the majority mechanism, sizing table, why odd N
- [consistent-hashing/answers.md — A18 Quorum consistency condition](../interviews/consistent-hashing/answers.md#a18-quorum-consistency-condition) and [A19 Sloppy quorum](../interviews/consistent-hashing/answers.md#a19-sloppy-quorum) — quorum applied on top of the hash ring, with diagrams
- [sharding-replication/deep-dive.md](../interviews/sharding-replication/deep-dive.md) — leaderless/quorum replication as one of the three replication layouts
