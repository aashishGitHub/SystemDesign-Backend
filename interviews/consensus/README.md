# System Design: Distributed Consensus & Coordination

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended design and safety reasoning.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note the safety argument you missed.
3. Use `deep-dive.md` for senior/architect depth, real-world systems (etcd, ZooKeeper, Spanner, CockroachDB), and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | The Core Problem | Why nodes must agree, split-brain, why a single coordinator is a SPOF |
| 2 | Replicated State Machine | Why a replicated log is the primitive; deterministic apply |
| 3 | Paxos | Proposer/acceptor/learner, prepare/accept, majority quorum, Multi-Paxos |
| 4 | Raft | Leader election, terms, log replication, commit index, safety, log matching |
| 5 | Failure Modes & Theory | Split brain, partitions, log divergence, FLP, Two Generals |
| 6 | Coordination Services | ZooKeeper (ZAB), etcd, Consul; locks, config, discovery, leader election |
| 7 | Quorum Math & Membership | Odd sizes, ⌊N/2⌋+1, fault tolerance, joint consensus, why 2 nodes is bad |
| 8 | Architect Tradeoffs | Keep consensus off the hot path, leases, geo-distributed groups, when NOT to use it |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 35 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, real-system references. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, Paxos/Raft mechanics, real production stories, cheat sheet. |

---

## Problem Statement

> You are designing the **coordination layer** for a large distributed platform: a fleet of stateless application servers needs a strongly-consistent control plane to elect one active leader per job, store cluster configuration and service-discovery data, and hand out distributed locks. It must behave correctly even when machines crash and the network partitions.
>
> **PUT /kv/{key}** — store a value in the replicated store (linearizable)
> **GET /kv/{key}** — read the current value (must not return stale committed data)
> **POST /election/campaign** — a node attempts to become the single active leader
>
> **Key Constraints:**
> - There must be **at most one leader** at any moment — never two nodes both acting as primary (no split-brain).
> - A write acknowledged to the client must **never be lost**, even if the node that accepted it crashes immediately after.
> - The system must keep serving as long as a **majority** of nodes are alive and can reach each other.
> - A minority partition must **refuse** writes rather than diverge (choose consistency over availability under partition).
> - Cluster membership can change (add/remove nodes) without downtime and without ever risking two disjoint quorums.

---

## How a Senior Engineer Thinks About This

A strong answer starts by naming the failure the system exists to prevent: **split-brain**. Two nodes each believing they are the leader will accept conflicting writes, and once those diverge there is no safe automatic merge for the control plane. That is why you cannot just "use a database with a boolean is_leader flag" or a single coordinator — a single coordinator is a single point of failure, and a naive flag has no way to prevent two writers during a partition. Consensus is the machinery that makes "exactly one decision, agreed by a majority, never reversed" a primitive you can build on.

Next, they reframe every coordination need — leader election, locks, config, membership — as the *same* problem: getting a set of nodes to **agree on an ordered log of commands** despite crashes and message loss. This is the replicated state machine model. If all replicas start identical and apply the same commands in the same order, they stay identical. Consensus (Paxos, Raft, ZAB) is just how you agree on the *next entry in that log*. A senior candidate does not memorize Paxos phases; they explain why a majority quorum guarantees any two decisions overlap on at least one node, which is the entire safety argument.

Finally, an architect is explicit about **cost and boundaries**. Consensus adds a network round-trip to a majority on every committed write, so you keep it off the hot data path — use it for the small, critical metadata (who is leader, where is shard X, cluster config), and let the bulk data plane run on cheaper replication. They know the theory limits (FLP: no async algorithm can guarantee both safety and termination, so we use timeouts and accept that liveness depends on the network eventually behaving), the quorum math (⌊N/2⌋+1, odd cluster sizes, why 2 nodes is strictly worse than 1 for writes), and when to *not* use consensus at all — if the data can tolerate eventual consistency, CRDTs or leaderless replication avoid the coordination tax entirely.
