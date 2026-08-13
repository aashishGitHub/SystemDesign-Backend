# Quorum

A **quorum** is the minimum number of nodes that must respond before an operation counts as done.

That one word covers **two genuinely different mechanisms**. They share a piece of arithmetic but they solve different problems and give different guarantees. Conflating them is the single most common quorum mistake in interviews, so this doc keeps them physically separated:

- **Consensus quorum** — a fixed majority. Used by Raft, Paxos, ZAB. Its job is *safety*: make it impossible for two conflicting decisions to both be considered official.
- **Dynamo-style quorum** — tunable `N`, `W`, `R`. Used by Cassandra, Riak. Its job is to be a *knob*: trade latency against freshness, per request.

---

## The One Math Fact Underneath Everything

Both mechanisms rest on the same pigeonhole argument:

```
If you have N nodes,
and set A has |A| nodes,
and set B has |B| nodes,
and |A| + |B| > N
then A and B must share at least one node.
```

There is no way to pick two groups out of `N` whose sizes add up to more than `N` and have them stay disjoint — you would need more than `N` distinct nodes to do it.

**Majority is just the special case** where both sets are the same size, `⌊N/2⌋ + 1`. Two majorities always add up to more than `N`, so any two majorities overlap. That is why consensus can say "any two quorums overlap" without naming which quorums.

### The part people skip

Overlap by itself is **geometry**. It changes nothing on its own. A shared node only matters if that node **remembers something from the first operation** and then **acts on that memory during the second operation**.

```
Overlap alone:                   useless
Overlap + the shared node
  remembers and refuses:         consensus safety
Overlap + the shared node
  remembers and reports
  a version the reader can
  compare:                       dynamo read-sees-write
```

So whenever you reason about a quorum, ask two questions, not one:

1. Do the two sets overlap? (arithmetic)
2. What does the node in the overlap *do* about it? (protocol)

Question 2 is where almost all the real subtlety lives.

---

## Meaning 1 — Consensus Quorum (fixed majority)

### The problem it solves

You have a replicated cluster. You need exactly one node to be in charge of ordering writes, and you need everyone to agree on what has been committed. The network can partition at any moment, and a node that is cut off **cannot tell the difference between "everyone else is dead" and "I am the one who is isolated."** Both look identical from the inside.

So you cannot solve this by asking a node to be honest about its own situation. You solve it by making the *minority side structurally unable to commit anything*, whether or not it realizes it is the minority. That is [split brain](./split-brain.md) prevention.

### Enough Raft to answer questions about it

Raft is the consensus algorithm most interviewers will reference. Six facts are enough for a quorum discussion:

1. **Time is divided into terms.** A term is just a monotonically increasing integer. Think of it as an election cycle number.
2. **Each term has at most one leader.** Possibly zero, if an election fails.
3. **To become leader you must win a majority of votes** for your term. A node that wants to be leader increments the term, votes for itself, and asks everyone else for a vote.
4. **Each node votes for at most one candidate per term, and it writes that vote to durable storage** (the `votedFor` field) before replying. This persistence matters — it must survive a crash and restart.
5. **Writes flow leader → followers.** The leader appends the write to its own log, sends it to followers, and marks the entry **committed** once a majority of nodes have durably stored it. Only then does the client get an ack.
6. **A candidate cannot win unless its log is at least as up to date as the voter's log.** A voter refuses to vote for anyone whose log is behind its own. This is the "election restriction."

### Why the majority must be strict

Suppose you defined quorum as "any 2 nodes out of 5." During a partition you could get `[A B] | [C D E]`. Both sides contain at least 2 reachable nodes, so both sides elect a leader, and both start committing. Two write streams, no way to reconcile. That is split brain.

With a strict majority of 3, the group of 2 mathematically cannot assemble a quorum. Not "is discouraged from" — cannot.

### Where the overlap actually bites

```
N = 5.  Nodes: A B C D E.

Term 7:  A gets votes from {A, B, C}  → A is leader for term 7.
Term 7:  D tries to get votes from {C, D, E}.

The two vote-sets overlap at C.  3 + 3 = 6 > 5, so they must.

C already has votedFor = A for term 7, persisted to disk.
C replies to D: "no."
D only has {D, E} = 2 votes. Not a majority. D cannot become leader.
```

Notice what did the work. It was not the overlap. It was **C remembering its vote and refusing.** If `votedFor` were not persisted, C could crash, restart with an empty memory, vote for D, and you would have two leaders in term 7 despite perfect majority arithmetic. The durable write is load-bearing.

The same argument protects committed data. An entry is committed once a majority stored it. Any future leader was elected by a majority. Those two majorities overlap, so at least one voter in the new election already had the committed entry — and rule 6 means that voter refuses to vote for any candidate missing it. So a committed entry can never be lost by a leader change.

### Sizing

```
quorum  = ⌊N/2⌋ + 1
failures tolerated = N − quorum

N=1  quorum 1  tolerates 0
N=3  quorum 2  tolerates 1
N=4  quorum 3  tolerates 1     ← same tolerance as N=3, costs more
N=5  quorum 3  tolerates 2
N=6  quorum 4  tolerates 2     ← same tolerance as N=5, costs more
N=7  quorum 4  tolerates 3
```

Even `N` buys nothing: it adds a replica, more write fan-out and more coordination, without improving fault tolerance. It also makes an exact 50/50 partition possible, which stalls the entire cluster. **Odd `N` is always the right choice.**

### Reads are the sharp edge

Writes are easy to reason about — no majority, no commit. Reads are where people get it wrong.

A leader that has been partitioned away does not instantly know it. Until its own election timeout fires, it still believes it is the leader. If it serves reads out of local state during that window, it can return data that the real majority has already superseded. **A naive leader read is not automatically linearizable.**

Real systems handle this one of three ways:

- **ReadIndex / quorum read** — before answering, the leader confirms with a majority that it is still leader, then answers. Correct, costs a round trip.
- **Leader lease** — the leader holds a time-bounded [lease](./lease.md) and may serve reads locally until it expires. Fast, but depends on bounded clock drift.
- **Read through the log** — put the read in the log like a write. Correct, slowest.

And in ZooKeeper specifically, reads are served by any follower from local state by default, so **a ZooKeeper read can be stale** unless the client calls `sync()` first. Writes go through the leader and are majority-committed; reads are deliberately not.

---

## Meaning 2 — Dynamo-Style Quorum (tunable N, W, R)

### The setup

There is no leader here. Every replica is equal, and any node can coordinate a request. Three numbers control it:

- **`N`** — the replication factor. How many replicas hold a copy of this key. Set per keyspace/table, not per request.
- **`W`** — how many replicas must acknowledge a write before the client is told "ok." Set per request.
- **`R`** — how many replicas must respond to a read before the client is given an answer. Set per request.

`W` and `R` are **not** "how many nodes we send to." The coordinator typically sends to **all `N`**; `W` and `R` are just how many replies it waits for before returning. The rest continue in the background.

### The flow, step by step

```
WRITE, N=3, W=2

client → coordinator
coordinator → replica1, replica2, replica3      (sends to all 3)
replica1 ack  ✓
replica2 ack  ✓                                  ← 2 acks reached, W satisfied
coordinator → client: "ok"                       ← client unblocked here
replica3 ack  ✓  (arrives later, or never)
```

```
READ, N=3, R=2

client → coordinator
coordinator → replica1, replica2, replica3
replica1 responds: value=7, version 12
replica2 responds: value=5, version 9            ← 2 responses, R satisfied
coordinator compares versions, picks 7
coordinator → client: 7
coordinator → replica2: "you're stale, here's 7" ← read repair, in background
```

That last step is [read repair](./read-repair.md), and it is a separate mechanism from the quorum, not part of it.

### The condition: `W + R > N`

By the pigeonhole fact, `W + R > N` means the set of replicas that acknowledged the write and the set of replicas that answered the read **must share at least one node**. So the read is guaranteed to *encounter* at least one replica holding the new value.

```
N=3, W=2, R=2 → 4 > 3  ✅ balanced, the common default
N=3, W=3, R=1 → 4 > 3  ✅ fast reads, fragile writes (any node down blocks writes)
N=3, W=1, R=3 → 4 > 3  ✅ fast writes, slow reads — but see the trap below
N=3, W=1, R=1 → 2 > 3  ✗ eventual consistency only, fastest
```

**And again, overlap alone is not the guarantee.** Encountering the new value is worthless if the coordinator cannot tell which of the returned values is newest. So every Dynamo-style store carries a versioning scheme:

- **Last-write-wins timestamps** (Cassandra) — the coordinator picks the highest timestamp. Simple, but it silently discards the losing write, and it is only as trustworthy as your clock sync.
- **[Vector clocks](./vector-clocks.md)** (Dynamo paper, Riak) — the coordinator can distinguish "newer than" from "concurrent with." Concurrent writes are returned to the client as **siblings** to resolve. No silent loss, more work for the application.

### The second inequality nobody puts in the table

`W + R > N` gives you **read/write overlap.** It says nothing about **write/write overlap.**

For two write quorums to be forced to overlap, you need a second condition:

```
W + W > N     i.e.   2W > N     i.e.   W > N/2     (W must be a majority)
```

Watch what happens when you satisfy the first inequality but violate the second — `N=3, W=1, R=3`:

```
Client A writes x=7, needs 1 ack. Lands on replica1. Client A gets "ok."
Client B writes x=9, needs 1 ack. Lands on replica2. Client B gets "ok."
The two write sets are {r1} and {r2} — disjoint. 1 + 1 = 2, not > 3.

Later read at R=3 sees:   r1: x=7 (ts=100)
                          r2: x=9 (ts=101)
                          r3: x=old

Last-write-wins picks x=9. x=7 is gone forever.
Client A received a successful acknowledgement for a write that no longer exists.
```

`W + R > N` held the entire time. It did not help, because the damage was between two writes, and that inequality was never about writes vs writes.

### Even both inequalities are not linearizability

This is the honest, senior-level position, and it is worth stating plainly: **leaderless quorums are not linearizable, even with `W + R > N` and `W > N/2`.** There is no single point that serializes operations. Known gaps include:

- **Concurrent read during a write.** The write has reached some replicas and not others. Two reads overlapping that write may legitimately return different answers.
- **Partial write with no rollback.** A write reaches 1 replica but fails to reach `W`. The client gets an error. That one replica is **not** rolled back. Subsequent reads may or may not surface the value the client was told had failed.
- **Sloppy quorum** (below) deliberately breaks the overlap guarantee.
- **Replica restored from an old backup** can reintroduce data that was correctly superseded.

If you actually need linearizable operations on a leaderless store, you escalate to consensus for those specific operations — Cassandra's lightweight transactions (`IF NOT EXISTS`, `IF col = ...`) run Paxos per key at `SERIAL` consistency, at several times the cost of a normal write.

### Sloppy quorum and hinted handoff

A **strict** quorum uses only the `N` nodes that actually own the key (the "preference list" on the [hash ring](./consistent-hashing.md)). If enough of those are down, the write fails.

A **sloppy** quorum keeps the write alive by handing it to a *substitute* node that does not normally own the key, and counting that substitute's ack toward `W`. The substitute stores the data with a note — a **hint** — saying "this belongs to node C, deliver it when C returns." When C comes back, the substitute replays it. That replay is [hinted handoff](./hinted-handoff.md).

The tradeoff is explicit: **you traded away the overlap guarantee for availability.** A subsequent read of the real `N` owners can completely miss a "successful" sloppy write, because the value is not on any of them yet. This is a durability/availability mechanism, not a consistency one.

Terminology note worth being careful about: in Cassandra, hints are stored during outages but **do not count toward the consistency level** — a write at `QUORUM` still fails if it cannot reach a real quorum of replicas. Only `CL=ANY` accepts a hint as satisfying the write, which is the genuinely sloppy setting. *(Worth re-verifying in current Cassandra docs before you assert it in an interview — behavior around hints has changed across major versions.)*

### Anti-entropy

Nothing above ensures that a replica outside both quorums ever catches up. Three background mechanisms do that, and they are separate from quorum:

- **[Read repair](./read-repair.md)** — fix staleness discovered while serving a read. Only fixes data people actually read.
- **[Hinted handoff](./hinted-handoff.md)** — replay writes missed during a short outage.
- **[Merkle tree](./merkle-trees.md) repair** — compare whole replica ranges via hash trees and sync differences. Catches cold data nothing reads.

---

## The Two Meanings, Side by Side

| | Consensus quorum (Raft, Paxos, ZAB) | Dynamo-style quorum (Cassandra, Riak) |
|---|---|---|
| Who orders writes | A single elected leader | No leader; any node coordinates |
| Size | Fixed **majority**: `⌊N/2⌋ + 1` | **Tunable** `W`, `R` per request |
| Purpose | Safety — only one majority can exist at a time, so two conflicting decisions can never both be official | Latency/freshness knob per request |
| What the overlap node does | Remembers its vote / its log, and **refuses** | Returns a **version** the coordinator compares |
| Can it be "sloppy"? | **Never** — a non-majority write is not a write | **Yes, deliberately** — writes to a substitute node during failure |
| Linearizable? | Yes for writes, by construction. Reads need ReadIndex, a lease, or a log read | **No**, even with `W+R>N`. Needs Paxos-per-key (LWT) for that |
| Below quorum | Cannot make progress, by design | Can still serve via substitutes + hinted handoff |
| Conflict resolution | Not needed — the leader ordered everything | Required — LWW timestamps or vector clocks |

---

## Analogy

> Consensus quorum is a courtroom jury: you need more than half to convict, full stop, or the trial hangs — no partial verdicts, and a juror who already voted cannot un-vote for a second trial in the same session. Dynamo quorum is a group buying a gift: you choose ahead of time how many people must chip in (`W`) and how many must be asked before you trust the amount (`R`) — and if someone is unreachable you can let their roommate hold the cash for them (sloppy quorum), which keeps the purchase moving but means asking the original group may not reveal the money exists yet.

---

## What a Quorum Does NOT Give You

Five separate gaps. Interviewers probe these because they separate "read the formula" from "operated the system."

1. **Not "all replicas are current."** `W + R > N` guarantees an *overlap*, not universal freshness. A replica outside both quorums can stay stale indefinitely without violating anything. Anti-entropy fixes that, not the formula.
2. **Not monotonic reads.** Two successive quorum reads can hit different overlapping-but-not-identical replica subsets, so a later read can legitimately return an *older* value than an earlier one. Fix with session guarantees at the client layer, not by raising `R`.
3. **Not read-your-writes.** Same reason. A client that just wrote may read from a coordinator whose chosen replicas resolve to an older version. This is a session-level guarantee, separate from quorum.
4. **Not atomic.** A write that fails to reach `W` is not rolled back on the replicas that did accept it. "Failed" does not mean "did not happen."
5. **Not conflict resolution.** Quorum tells you *which replicas to ask*. It does not tell you which of the answers is right. That needs versioning, and if the versioning is LWW you are accepting silent write loss under clock skew.

---

## How Real Systems Map Onto This

| System | Which mechanism | Notes |
|---|---|---|
| **etcd, Consul** | Consensus (Raft) | Majority quorum. Linearizable reads available; serializable (possibly stale) reads are the cheaper option. |
| **ZooKeeper** | Consensus (ZAB) | Majority for writes. Reads served locally by any follower and **may be stale** unless you `sync()`. |
| **Cassandra** | Dynamo-style | `N` per keyspace, consistency level per query: `ONE`, `QUORUM`, `LOCAL_QUORUM`, `EACH_QUORUM`, `ALL`, `ANY`. LWW timestamps. LWT uses Paxos for the cases needing real consensus. |
| **Riak** | Dynamo-style | Closest to the original paper — vector clocks, siblings returned to the app. |
| **DynamoDB (AWS)** | **Actually consensus**, despite the name | Modern DynamoDB is not a tunable-`W`/`R` leaderless store. Each partition has a leader elected via Paxos; you choose eventually-consistent (default, cheaper) or strongly-consistent reads. *I am fairly confident of this from the 2022 USENIX ATC DynamoDB paper, but verify before asserting it — the name misleads a lot of published material.* |
| **Couchbase** | Leader-per-vBucket + majority durability | Writes go to the **active** node for that vBucket, so it is not a leaderless quorum write. Durability levels (`majority`, `majorityAndPersistToActive`, `persistToMajority`) add majority-quorum acknowledgement on top. *Verify the exact level names against current docs.* |

The DynamoDB row matters for you specifically: a lot of interview material lists DynamoDB as the canonical tunable-quorum store because of the paper's name, and it is worth knowing the modern service is a different design.

---

## Interview Questions

**Q1. Why must a consensus quorum be a strict majority, not just "more than one"?**
So any two quorums are forced to overlap by at least one node. If quorum were 2 of 5, two disjoint groups of 2 could each claim quorum during a partition and both elect a leader — split brain. Majority makes that arithmetically impossible.

**Q2. N=5 cluster: what's the quorum, how many failures does it tolerate, and why not N=6 for "more safety"?**
Quorum = 3, tolerates 2 failures. N=6 has quorum 4 and *also* tolerates only 2 — identical fault tolerance for a strictly more expensive cluster, plus it admits a 3/3 split that stalls everything. Odd N is the efficient choice.

**Q3. Overlap is just set arithmetic. What makes it actually prevent a second leader?**
The node in the intersection remembers its vote for that term (`votedFor`, persisted to disk before replying) and refuses the second candidate. Without that durable memory, a crash-restart would let the shared node vote twice and you would get two leaders despite perfect majority arithmetic. The arithmetic guarantees the *encounter*; the protocol state is what makes the encounter decisive.

**Q4. N=5 Raft, partition splits it 3 | 2. Can the minority side of 2 serve reads?**
It can never commit a write — no majority. Reads depend entirely on the read strategy. If reads require a ReadIndex confirmation from a majority, the minority cannot serve them. If the system serves reads from local leader state and the old leader is on the minority side, it *will* serve stale reads until its election timeout fires and it steps down. If followers serve reads locally (ZooKeeper-style), the minority serves stale reads freely. So the honest answer is: it depends on the read path, and "quorum protects writes" does not extend to reads for free.

**Q5 (depth). Given N=3, why would anyone pick W=1, R=1 over W=2, R=2?**
Latency and throughput: the request returns as soon as the single fastest replica responds, so tail latency drops sharply and a slow or dead node stops mattering. The cost is eventual consistency. Fine for like counts, view counters, and metrics; unacceptable for balances or inventory.

**Q6 (depth). N=3, W=1, R=3 satisfies `W + R > N`. Is it strongly consistent?**
No. It satisfies read/write overlap but violates write/write overlap (`2W > N` fails: `2 × 1 = 2 < 3`). Two concurrent writes can land on disjoint single replicas, both get acknowledged, and last-write-wins later discards one of them — a client received a success for a write that no longer exists. You need `W > N/2` as well, and even then leaderless quorums are not fully linearizable.

**Q7 (senior). A Dynamo-style write succeeds with sloppy quorum during an outage — did it use a "quorum"?**
Yes, but not the *preferred* one: it counted a substitute node's ack toward `W` because an intended replica was unreachable. That is legal precisely because Dynamo-style quorum is a tunable availability knob rather than a safety invariant. A consensus system could never do this — "any 2 nodes count" would destroy the overlap guarantee that makes it safe. The practical consequence is that a subsequent strict-quorum read of the real owners can miss the write entirely until hinted handoff completes.

**Q8 (staff). On-call sees a Cassandra read at `LOCAL_QUORUM` return a value, then a follow-up read moments later returns something older. Is `W+R>N` broken?**
No. `W+R>N` guarantees the read set intersects the write set for *one* write. It says nothing about ordering across two independent reads, which may hit different coordinators and different overlapping-but-not-identical replica subsets. This is a missing **monotonic reads** session guarantee. Fix it at the client-consistency layer — raising `R` reduces the probability but does not establish the guarantee.

**Q9 (staff). Your `N=3, W=2, R=2` cluster loses one replica for an hour. What actually degrades?**
Writes and reads both still succeed — 2 of 3 is reachable. What degrades is headroom: you now have zero fault tolerance, and a second failure stops the cluster for that key range. Meanwhile the down node accumulates missed writes, so recovery cost grows with outage length, and until hinted handoff plus repair finish, that replica is a stale-answer source. The formula looks healthy the whole time; the risk posture does not.

---

## Where This Shows Up in This Repo

- [kv-store/deep-dive.md §4 — Tunable Consistency: N, W, R Quorums](../interviews/kv-store/deep-dive.md#4-tunable-consistency-n-w-r-quorums) — the Dynamo-style mechanism in full, including a coordinator sketch
- [consensus/deep-dive.md §13 — Quorum Math and Cluster Sizing](../interviews/consensus/deep-dive.md#13-quorum-math-and-cluster-sizing) — the majority mechanism, sizing table, why odd N
- [consistent-hashing/answers.md — A18 Quorum consistency condition](../interviews/consistent-hashing/answers.md#a18-quorum-consistency-condition) and [A19 Sloppy quorum](../interviews/consistent-hashing/answers.md#a19-sloppy-quorum) — quorum applied on top of the hash ring, with diagrams
- [sharding-replication/deep-dive.md](../interviews/sharding-replication/deep-dive.md) — leaderless/quorum replication as one of the three replication layouts

**Related fundamentals:** [split-brain](./split-brain.md) · [leader-and-follower](./leader-and-follower.md) · [lease](./lease.md) · [fencing](./fencing.md) · [read-repair](./read-repair.md) · [hinted-handoff](./hinted-handoff.md) · [merkle-trees](./merkle-trees.md) · [vector-clocks](./vector-clocks.md) · [consistent-hashing](./consistent-hashing.md) · [cap-theorem](./cap-theorem.md)
