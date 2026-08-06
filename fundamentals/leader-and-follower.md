# Leader and Follower

One node (the **leader**) is the only one allowed to accept writes; every other node (a **follower**) replicates the leader's log and can serve reads. It's the default way to get strong consistency without asking every node to agree on every operation.

---

## The Problem

If every node can accept writes independently, two nodes can accept conflicting writes to the same key at the same time — now you need conflict resolution (vector clocks, CRDTs, last-write-wins) on every read. Electing one leader sidesteps the conflict entirely: there is only ever one node deciding the order of writes.

---

## How It Works

1. One node is elected leader (via a consensus protocol like Raft, or an external coordinator like ZooKeeper/etcd).
2. Clients send writes only to the leader. The leader appends to its local log, then replicates that log to followers.
3. A write is "committed" once a quorum of followers have it durably (see [quorum](./quorum.md)).
4. If the leader dies, the followers run a **leader election** and pick a new leader — usually the one with the most up-to-date log, to avoid losing committed writes.

---

## Analogy

> A newsroom with one editor-in-chief. Every story (write) goes through the editor first, gets a sequence number, and is then distributed to every desk (follower) in that exact order. If the editor is hit by a bus, the desks vote for whoever has read the most recent stories to take over — so no published story gets forgotten.

---

## The Subtlety That Trips People Up

**"Leader" doesn't automatically mean "strongly consistent."** If followers serve reads without checking they're caught up, a client can read stale data right after its own write lands on the leader — this is why systems that want strict reads route them through the leader (or use a **lease read** / **read index**, see [lease](./lease.md)), and why "eventually consistent read replicas" is a deliberate, named tradeoff, not a bug.

---

## Interview Questions

**Q1. Why elect a leader at all instead of letting every node accept writes (multi-leader / leaderless)?**
A single leader gives you a single, unambiguous order for every write — the log *is* the source of truth, so replication is just "copy the log," and reads never need conflict resolution. The cost is a write bottleneck (one node's throughput) and a failure domain (that one node going down needs an election before writes resume).

**Q2. How does a new leader avoid losing a write that was already acknowledged to a client?**
The election restriction: a candidate can only win if its log is at least as up-to-date as a majority of the cluster's logs (Raft compares last log term + index). Since any committed entry is on a majority of nodes, any node that can win an election must have seen it — so a new leader can never silently drop a committed write.

**Q3 (depth). Two nodes both believe they're the leader after a network partition heals unevenly — what prevents both from accepting writes?**
Quorum: only the side of the partition with a majority of nodes can commit new writes, because commits require a quorum ack. The minority-side "leader" (really a stale leader that hasn't yet stepped down) can accept writes locally but can never get them committed — and a well-designed client/proxy uses a fencing token or term number to reject writes from the stale leader once it discovers a higher term exists.

**Q4 (senior). When would you deliberately choose multi-leader or leaderless replication over single-leader?**
When write availability across regions matters more than avoiding conflicts — e.g. active-active multi-region writes (Netflix-style), or Dynamo-style stores that accept the write always and resolve conflicts later with vector clocks. Single-leader forces every write through one region/node, which is a latency and availability cost multi-leader is designed to remove, in exchange for owning conflict resolution yourself.

---

## Where This Shows Up in This Repo

- [consensus/deep-dive.md §5 — Raft: Consensus Designed to Be Understood](../interviews/consensus/deep-dive.md#5-raft-consensus-designed-to-be-understood) and [§6 — Raft Leader Election and Terms](../interviews/consensus/deep-dive.md#6-raft-leader-election-and-terms)
- [sharding-replication/deep-dive.md §3 — Replication: Copies for Safety and Speed](../interviews/sharding-replication/deep-dive.md#3-replication-copies-for-safety-and-speed) — single-leader vs multi-leader vs leaderless as the three real-world layouts
