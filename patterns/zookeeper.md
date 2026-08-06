# Deep Dive: ZooKeeper (and etcd, Consul, Chubby)

> **Interviewer signal:** "how do the nodes agree on who's the leader?", "how does a new node find the others?", "how do you make sure only one worker runs this?", "where does cluster config live?", "how do you know a node is dead?"

Not a pattern like the others in this folder — it's the **coordination primitive several of those patterns bottom out in**. When [contention](./dealing-with-contention.md#8-rung-5-distributed-locks-and-why-theyre-last) needs a correctness-grade lock, when [long-running tasks](./long-running-tasks.md#13-scheduled-jobs-and-the-cron-problem) need exactly one scheduler, when a [real-time](./realtime-updates.md#3-hop-2-event-source--the-right-server) connection tier needs to know its own membership — this is the answer, or the thing you'd otherwise reimplement badly.

📖 Source outline: [hellointerview.com — ZooKeeper](https://www.hellointerview.com/learn/system-design/deep-dives/zookeeper) (Summary/References paywalled; the depth below is this repo's own). Primary sources worth reading: *"ZooKeeper: Wait-free coordination for Internet-scale systems"* (Hunt, Konar, Junqueira, Reed — USENIX ATC 2010) and *"The Chubby lock service for loosely-coupled distributed systems"* (Burrows — OSDI 2006), which is the Google system ZooKeeper is modelled on.

---

## Table of Contents

1. [The Motivating Problem](#1-the-motivating-problem)
2. [The Data Model: ZNodes](#2-the-data-model-znodes)
3. [The Ensemble: Roles and Quorum](#3-the-ensemble-roles-and-quorum)
4. [Watches](#4-watches)
5. [ZAB: How Writes Actually Commit](#5-zab-how-writes-actually-commit)
6. [The Consistency Guarantees (and the Big Gotcha)](#6-the-consistency-guarantees-and-the-big-gotcha)
7. [Sessions: Where Ephemeral Nodes Get Their Power](#7-sessions-where-ephemeral-nodes-get-their-power)
8. [The Recipes](#8-the-recipes)
9. [Storage Architecture](#9-storage-architecture)
10. [Failure Behaviour](#10-failure-behaviour)
11. [Limitations — What It Is Not](#11-limitations--what-it-is-not)
12. [ZooKeeper vs etcd vs Consul](#12-zookeeper-vs-etcd-vs-consul)
13. [The Modern World: Who Still Uses It](#13-the-modern-world-who-still-uses-it)
14. [Decision Framework](#14-decision-framework)
15. [Where This Shows Up in This Repo](#15-where-this-shows-up-in-this-repo)
16. [Interview Questions](#16-interview-questions)
17. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Motivating Problem

You have twenty stateless-ish nodes and four questions that all look easy and none of which are:

| Question | Why it's hard |
|---|---|
| **Who is the leader?** | Two nodes both deciding they're leader is [split brain](../fundamentals/split-brain.md), and network partitions make it inevitable without a majority rule |
| **Who is alive?** | A missed heartbeat is indistinguishable from a slow one. Every node needs the *same* answer, not its own opinion |
| **What is the current config?** | Config in a file per host drifts; config in a database can be read stale by half the fleet mid-change |
| **Who holds this lock?** | Locks with TTLs are unsafe against paused holders, and locks without TTLs deadlock on crash |

Each of these is the same problem underneath: **a small amount of metadata that every node must agree on, right now, even while nodes are failing.** That's consensus, and consensus is famously easy to get subtly wrong — so the industry answer is to run one battle-tested consensus service and let every other system delegate to it.

The mental model: **ZooKeeper is not a database. It's a strongly-consistent, replicated, in-memory filesystem for tiny files, with change notifications and automatic cleanup when a client dies.** Those last two features are what make it a coordination service rather than a small key-value store.

→ [`consensus §1 The Core Problem`](../interviews/consensus/deep-dive.md#1-the-core-problem-why-you-need-agreement) · [`§11 Coordination Services`](../interviews/consensus/deep-dive.md#11-coordination-services-zookeeper-etcd-consul)

---

## 2. The Data Model: ZNodes

A hierarchical namespace that looks like a filesystem, where every node ("znode") can hold data *and* have children:

```
/
├── app
│   ├── config                     ← persistent, holds {"maxConns": 500}
│   └── feature-flags
├── services
│   └── payment-api
│       ├── 10.0.1.5:8080          ← EPHEMERAL: vanishes when that host's session dies
│       └── 10.0.1.9:8080          ← so `getChildren` == the live fleet, always
└── election
    ├── n_0000000001               ← EPHEMERAL + SEQUENTIAL → this one is the leader
    ├── n_0000000002
    └── n_0000000003
```

### The four znode flavours, and why they matter

| Type | Behaviour | Used for |
|---|---|---|
| **Persistent** | Stays until explicitly deleted | Config, feature flags, cluster topology |
| **Ephemeral** | **Automatically deleted when the creating client's session ends** | Liveness, service registration, lock ownership |
| **Sequential** | ZooKeeper appends a monotonically increasing 10-digit counter to the name | Ordering, fair FIFO queues, fencing tokens |
| **Ephemeral + Sequential** | Both | **Leader election and distributed locks** — the marquee recipe |

**Ephemeral is the killer feature.** Automatic cleanup on client death is exactly the guarantee you cannot build yourself without reimplementing failure detection and lock expiry — and it's what makes a crashed lock holder self-healing rather than a deadlock. Note that ephemeral znodes **cannot have children**, since their lifetime is tied to a session.

**Sequential is the second killer feature**, for a reason people miss: the counter is assigned by the ensemble, is globally monotonic per parent, and never reuses a value. That makes it a ready-made [fencing token](../fundamentals/fencing.md) — the one thing a Redis lock can't give you.

### Deliberate constraints

- **Data is small.** The default per-znode limit is 1MB (`jute.maxbuffer`), and the intended size is bytes-to-kilobytes. This is a hard design constraint, not a tuning suggestion.
- **No partial reads/writes.** A znode's data is read and written whole, atomically. There's no append, no seek.
- **Every znode has a version**, so you get compare-and-swap for free: `setData(path, data, expectedVersion)` fails if someone else wrote first. That's [optimistic concurrency control](./dealing-with-contention.md#5-rung-2-optimistic-concurrency-control), built in.
- **Reads and writes are on paths, not queries.** There is no indexing, no scanning, no `WHERE`.

---

## 3. The Ensemble: Roles and Quorum

```
        ┌──────────────────────────────────────────┐
        │              ENSEMBLE (5 nodes)          │
        │                                          │
        │   ┌────────┐                             │
        │   │ LEADER │◄── ALL WRITES go here       │
        │   └───┬────┘                             │
        │       │ ZAB broadcast                    │
        │   ┌───┴───┬────────┬────────┐            │
        │   ▼       ▼        ▼        ▼            │
        │ FOLLOWER FOLLOWER FOLLOWER FOLLOWER      │
        │   ▲       ▲        ▲        ▲            │
        │   └───────┴── reads served locally ──────┘
        └──────────────────────────────────────────┘
              (+ optional OBSERVERS: receive updates,
                 serve reads, but do NOT vote)
```

- **Leader** — sequences and proposes every write. Exactly one at a time, per epoch.
- **Followers** — vote on proposals, and serve reads **from their local copy**.
- **Observers** — non-voting replicas. They scale reads and can sit in remote datacentres without slowing down write quorums, since they don't participate in voting. Useful and underused.

**Quorum is a strict majority**: `⌊N/2⌋ + 1`.

| Ensemble size | Quorum | Failures tolerated |
|---|---|---|
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

**Why odd numbers:** 4 nodes need a quorum of 3 and therefore tolerate only 1 failure — the same as 3 nodes — while costing more and making writes slower. An even ensemble buys you nothing but latency. 5 is the common production choice: it tolerates two failures, which means you can lose one node to a failure while another is down for maintenance.

**Why not 100 nodes:** because every write must be acknowledged by a majority, so a bigger ensemble means *more* nodes to convince and therefore **slower writes**. Adding voting members to a consensus cluster degrades write throughput. Add *observers* if you need read capacity; never grow the voting set for performance.

→ [`fundamentals/quorum.md`](../fundamentals/quorum.md) · [`consensus §13 Quorum Math and Cluster Sizing`](../interviews/consensus/deep-dive.md#13-quorum-math-and-cluster-sizing) · [`§14 Membership Changes Without Split-Brain`](../interviews/consensus/deep-dive.md#14-membership-changes-without-split-brain)

---

## 4. Watches

A **one-shot** trigger: "notify me when this znode changes."

```java
byte[] data = zk.getData("/app/config", watcher, stat);   // sets a watch
// … someone updates /app/config …
// → watcher fires ONCE with an event
// → to keep watching, RE-REGISTER by reading again
```

Three properties that generate most ZooKeeper bugs:

1. **One-shot.** After firing, the watch is gone. You must re-register on every read, and the window between firing and re-registering is a window in which you can miss a change. The correct pattern is therefore always **"notification → re-read current state"**, never "notification → apply the delta in the event".
2. **You get told *that* it changed, not *what* changed.** Events carry the path and type, not the new data. This is deliberate — it keeps the ensemble from having to buffer per-client event streams, and it's what "wait-free" in the paper's title is protecting.
3. **You can miss intermediate states.** If a value goes A→B→C while you're re-registering, you'll observe A then C. For coordination that's fine (you care about *current* state); if you need every transition, ZooKeeper is the wrong tool — that's a [message queue](../interviews/message-queues/deep-dive.md).

Watches *are* ordered relative to the data they watch: you will never see a change and then have the watch for it fire later, which is what makes the re-read pattern safe.

### The herd effect, and the fix

```
❌ 500 clients all watch /lock  → lock released → 500 notifications
   → 500 simultaneous create attempts → 499 fail → repeat. O(N) storm per release.

✅ Each client creates /lock/n_XXXX (ephemeral sequential) and watches
   ONLY its immediate predecessor.
   → lock released → EXACTLY ONE notification → O(1) per release,
     and clients acquire in strict FIFO order for free.
```

This "watch your predecessor" trick is the single most quoted ZooKeeper design detail, and it's the reason the election and lock recipes are shaped the way they are.

---

## 5. ZAB: How Writes Actually Commit

**ZAB** (ZooKeeper Atomic Broadcast) is a leader-based atomic broadcast protocol — same family as Raft and Multi-Paxos, with the distinguishing goal of delivering *totally ordered* state updates.

```
Client write
   │
   ├─► any server receives it → FORWARDS to leader
   │
   └─► LEADER:
         1. assign zxid  (64-bit: [epoch:32][counter:32] — monotonic, never reused)
         2. append to its own transaction log (WAL, fsync'd)
         3. PROPOSE to all followers
         4. wait for ACK from a QUORUM (majority, including itself)
         5. COMMIT — broadcast commit, apply to in-memory tree
         6. reply to client
```

Two phases in the protocol's life: **discovery/synchronization** after a leader change (the new leader establishes a new epoch and brings followers up to its log state) and **broadcast** during normal operation.

**The zxid is the concept to remember.** It's a monotonic, globally-ordered stamp on every state change, with an epoch prefix that increments on every leader election. Its consequences:

- Every write is totally ordered, cluster-wide. There is no ambiguity about which happened first.
- The epoch prefix means a *stale* leader from a previous epoch can be detected and ignored — its zxids are strictly lower.
- Clients can compare zxids to reason about progress.
- **It is a natural fencing token** — see [§16 Q5](#16-interview-questions).

→ [`consensus §5 Raft`](../interviews/consensus/deep-dive.md#5-raft-consensus-designed-to-be-understood) · [`§4 Multi-Paxos`](../interviews/consensus/deep-dive.md#4-multi-paxos-and-leader-based-consensus) · [`§7 Log Replication and Commit`](../interviews/consensus/deep-dive.md#7-raft-log-replication-and-commit) · [`§2 The Replicated State Machine`](../interviews/consensus/deep-dive.md#2-the-replicated-state-machine-and-the-log)

---

## 6. The Consistency Guarantees (and the Big Gotcha)

What ZooKeeper actually promises:

| Guarantee | Meaning |
|---|---|
| **Linearizable writes** | All writes are totally ordered and appear to happen instantaneously at a point in time |
| **FIFO client order** | One client's operations are applied in the order it issued them |
| **Atomicity** | A write either fully applies or not at all |
| **Single system image** | A client sees the same view regardless of which server it connects to… *eventually* |
| **Durability** | Once committed, an update survives, as long as a quorum can be reconstituted |

### The gotcha: reads are not linearizable

**This is the highest-value thing to know about ZooKeeper, and the most common misconception.**

Reads are served **locally by whichever server the client is connected to**, without contacting the leader or a quorum. That's what makes reads fast and scalable — and it means a follower lagging behind the leader will happily serve you **stale data**.

```
Leader:   /config = v5 (committed)
Follower: /config = v4 (hasn't applied v5 yet)
Client connected to that follower reads v4. No error. No warning.
```

So ZooKeeper gives you *sequential* consistency for reads, not linearizability. When you need a genuinely current read:

```java
zk.sync(path, callback, ctx);   // flush this server up to the leader's latest zxid
// … then read
```

`sync()` costs a round trip to the leader, which is exactly why it isn't the default. **Interview move:** state the read guarantee correctly, then note that it doesn't undermine the lock and election recipes — because those depend on the *write* path (creating an ephemeral sequential node is a linearizable write, and the ordering comes from the zxid), not on reads being fresh.

→ [`distributed-transactions §3 CAP Theorem — Stated Correctly`](../interviews/distributed-transactions/deep-dive.md#3-cap-theorem--stated-correctly) · [`consensus §15 Read Optimizations`](../interviews/consensus/deep-dive.md#15-read-optimizations-and-geo-distributed-consensus) · [`fundamentals/cap-theorem.md`](../fundamentals/cap-theorem.md)

ZooKeeper is a **CP** system: on partition, the minority side cannot accept writes at all. It chooses consistency over availability, deliberately, which is the only correct choice for a coordination service — an "available" lock service that hands out two locks is worse than one that says no.

---

## 7. Sessions: Where Ephemeral Nodes Get Their Power

A client's session is the unit of liveness, and understanding it precisely is what separates a real answer from a hand-wave.

```
Client connects → ensemble creates a SESSION (id + password + timeout)
   │
   ├─ client sends heartbeats (pings) within the timeout
   ├─ TCP connection drops? → client transparently RECONNECTS to another
   │     server and RESUMES THE SAME SESSION. Ephemeral nodes survive.
   │
   └─ no heartbeat for the full session timeout
         → the ENSEMBLE declares the session EXPIRED
         → all its ephemeral nodes are deleted
         → all its watches are removed
         → locks it held are released; leadership it held is lost
```

The three details that matter:

1. **Session ≠ TCP connection.** A network blip that drops the socket does *not* kill ephemeral nodes, because the client reconnects to a different ensemble member with the same session ID. This is why ZooKeeper tolerates flaky networks better than a naive heartbeat scheme.
2. **The ensemble decides expiry, not the client.** Expiry is a write that goes through consensus, so every node agrees on exactly when a session died. This is what prevents two clients from both believing they hold a lock — the "who is dead" question has a single authoritative answer. Contrast with [gossip-based failure detection](../fundamentals/gossip-protocol.md), where nodes hold independent opinions.
3. **The client may not know its session expired.** If a client is GC-paused or partitioned for longer than the timeout, the ensemble deletes its ephemeral node and hands the lock to someone else, while the paused client resumes believing it's still the holder. **This is the same pause hazard as with Redis locks** — see [contention §8](./dealing-with-contention.md#8-rung-5-distributed-locks-and-why-theyre-last) — and it is *not* solved by using ZooKeeper. What ZooKeeper gives you is the *materials* to solve it: a monotonic zxid/sequence number to use as a fencing token, and a `Disconnected`/`Expired` state the client library surfaces so a correctly written client stops acting the moment it loses certainty.

**Timeout tuning is a real tradeoff**: short timeouts detect failure fast but cause false expiries during GC pauses or network hiccups (and a false expiry means a spurious leader change); long timeouts are stable but leave a dead node's lock held for the whole window. Session timeout must be comfortably longer than your worst-case GC pause.

→ [`fundamentals/heartbeat.md`](../fundamentals/heartbeat.md) · [`fundamentals/lease.md`](../fundamentals/lease.md) · [`fundamentals/phi-accrual-failure-detection.md`](../fundamentals/phi-accrual-failure-detection.md)

---

## 8. The Recipes

### 8.1 Configuration management

```
/app/config  (persistent znode holding a small JSON blob)
   every instance: getData("/app/config", watch=true)
   operator: setData("/app/config", newConfig)
   → all instances notified → all re-read → whole fleet converges in ms
```

Beats config files (no drift, no redeploy) and beats a database (push notification instead of polling, and a strong guarantee that everyone sees the same version). Use the znode **version** for safe concurrent updates, and keep the blob small.

### 8.2 Service discovery

```
/services/payment-api/
    ├── 10.0.1.5:8080     ← each instance creates its own EPHEMERAL znode on startup
    └── 10.0.1.9:8080

Clients: getChildren("/services/payment-api", watch=true)
   → the child list IS the live instance list
   → an instance crashes → session expires → znode vanishes → watchers notified
```

No health-check polling, no stale registry entries, no deregistration logic to get wrong on crash — liveness and registration are the same mechanism. This is also the [hop-2 membership](./realtime-updates.md#3-hop-2-event-source--the-right-server) problem solved.

### 8.3 Leader election

```
1. Every candidate creates  /election/n_  as EPHEMERAL + SEQUENTIAL
      → gets n_0000000001, n_0000000002, n_0000000003 …
2. getChildren("/election")
3. Lowest sequence number = LEADER
4. Everyone else watches ONLY their immediate predecessor  (herd-effect fix)
5. Leader crashes → session expires → its znode is deleted
      → ONLY its successor is notified → checks → becomes leader
```

Elegant properties: automatic failover on crash (ephemeral), deterministic and fair ordering (sequential), O(1) notifications per change (predecessor watching), and no split brain because the ensemble is the single authority on who's alive.

**But:** the new leader must fence the old one. See [§16 Q5](#16-interview-questions).

### 8.4 Distributed lock

Structurally identical to election — the "leader" is simply the lock holder:

```
create /locks/resource42/lock_  (ephemeral + sequential)
  lowest sequence → you hold the lock
  otherwise → watch your predecessor and wait
  release → delete your znode (or just die: ephemeral cleans up)
```

Why this beats a Redis `SET NX` lock: automatic release on client death without a TTL guess, FIFO fairness rather than a random winner, and a built-in monotonic token for fencing. What it does *not* beat it on: latency (a consensus write vs a single in-memory op) and throughput. Use ZooKeeper/etcd when correctness matters, Redis when it's an efficiency lock.

Read/write locks are a variant: writers wait for all lower-numbered nodes; readers wait only for lower-numbered *write* nodes.

### 8.5 Others

**Group membership** (ephemeral children of a group node), **barriers** (a znode whose existence blocks progress, plus a double barrier for enter/exit), **distributed queues** (sequential children consumed in order — works, but ZooKeeper is a poor queue; use a real broker), and **2PC coordination** (the coordinator's state in a znode so a coordinator crash is recoverable — the fix for [2PC's blocking problem](../interviews/distributed-transactions/deep-dive.md#8-the-blocking-problem-and-3pc)).

→ All of these written out from the consensus side: [`consensus §12 Recipe: Leader Election, Locks, and Leases`](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases)

---

## 9. Storage Architecture

```
┌────────────────────────────────────────────────┐
│  IN-MEMORY DATA TREE   ← all reads served here │
│  (the ENTIRE dataset must fit in RAM)          │
└──────────────────┬─────────────────────────────┘
                   │ every write, before commit
                   ▼
┌────────────────────────────────────────────────┐
│  TRANSACTION LOG (WAL) on disk, fsync'd        │  ← the write bottleneck
└──────────────────┬─────────────────────────────┘
                   │ periodically
                   ▼
┌────────────────────────────────────────────────┐
│  SNAPSHOTS (fuzzy — taken without locking)     │  ← bounds recovery time
└────────────────────────────────────────────────┘

Recovery = load latest snapshot + replay txn log after it
```

Three operational facts that fall straight out of this design:

1. **Dataset size is bounded by RAM.** Hence the 1MB znode limit and the "store metadata, not data" rule. There is no paging to disk.
2. **`fsync` on the transaction log is the write bottleneck.** The standard production advice is to put the transaction log on its **own dedicated device**, so it never competes with snapshot writes or anything else — this is the single highest-impact ZooKeeper tuning item, and it's a great concrete detail to cite.
3. **Snapshots are "fuzzy"** — taken while writes continue, so they aren't a point-in-time image. That's safe because replaying the transaction log over a fuzzy snapshot is idempotent, which is a nice illustration of why idempotent state application matters in log-based systems.

This is exactly the [write-ahead log](../fundamentals/write-ahead-log.md) + [snapshot/checkpoint](../interviews/storage-engines/deep-dive.md#10-crash-recovery-and-checkpoints) design used by databases, applied to a coordination service. → [`storage-engines §9 Durability: WAL, fsync, Group Commit`](../interviews/storage-engines/deep-dive.md#9-durability-wal-fsync-and-group-commit)

---

## 10. Failure Behaviour

| Failure | What happens |
|---|---|
| **A follower dies** | Nothing user-visible, as long as quorum holds. Its connected clients reconnect elsewhere and resume sessions |
| **The leader dies** | Election. **Writes are unavailable** for the duration — typically hundreds of milliseconds to a few seconds — then a new leader with a higher epoch takes over. Reads continue from followers (possibly stale) |
| **Quorum lost** (e.g. 3 of 5 down) | **No writes at all.** Remaining nodes can serve stale reads but the cluster is functionally read-only until quorum returns. This is CP behaviour, chosen deliberately |
| **Network partition** | Majority side keeps operating; minority side cannot commit writes. Clients on the minority side get session expiries, and their ephemeral nodes are deleted by the majority — so their locks are released while they may not know it |
| **A client GC-pauses** | Session expires, ephemeral nodes deleted, locks reassigned — while the client believes otherwise. **Fencing tokens are the only protection** |
| **Disk full on the leader** | Writes fail. ZooKeeper needs headroom for logs and snapshots; a full disk is a classic outage cause |
| **Clock skew** | ZooKeeper does not depend on synchronized clocks for correctness (unlike, say, Spanner's TrueTime); it uses zxid ordering and session timeouts measured locally |

The one to internalize: **a minority partition is not merely degraded, it is unusable for writes — and its clients lose their locks.** That's the guarantee that makes split brain impossible, and the reason you must never run a 2-node "cluster".

→ [`consensus §10 Split Brain and Network Partitions`](../interviews/consensus/deep-dive.md#10-split-brain-and-network-partitions) · [`fundamentals/split-brain.md`](../fundamentals/split-brain.md) · [`fundamentals/fencing.md`](../fundamentals/fencing.md)

---

## 11. Limitations — What It Is Not

| Not a… | Why |
|---|---|
| **Database** | Everything in RAM, 1MB per znode, no queries, no indexes, no scans |
| **Message queue** | Watches are one-shot and lossy-by-design for intermediate states. No consumer groups, no durable per-consumer offsets |
| **High-throughput store** | Every write goes through one leader and a majority `fsync`. Adding nodes makes writes **slower**, not faster |
| **Cache** | Wrong performance profile, and coordination writes are precious |
| **Multi-region system** | Cross-region write quorums mean cross-region latency on every write. Observers help reads; the write path doesn't stretch well |

Operational realities to acknowledge: it's a JVM service, so GC tuning matters and a long pause can cause spurious session expiries and leader elections; the ensemble is a hard dependency that can take your whole platform down when misconfigured; and the client libraries have historically been easy to misuse (the raw API is low-level enough that **Apache Curator** exists specifically to provide correct recipe implementations — recommending Curator over hand-rolling the recipes is a credible practical answer).

Rule of thumb: **kilobytes of metadata, thousands of writes per second, and a hard requirement for agreement.** Outside that envelope, something else is the right tool.

→ [`consensus §16 When NOT to Use Consensus`](../interviews/consensus/deep-dive.md#16-when-not-to-use-consensus)

---

## 12. ZooKeeper vs etcd vs Consul

| | **ZooKeeper** | **etcd** | **Consul** |
|---|---|---|---|
| Consensus | ZAB | Raft | Raft |
| Language | Java (JVM) | Go | Go |
| Data model | Hierarchical znodes | Flat keys, **MVCC revisions**, range queries | KV + rich service catalog |
| API | Custom binary protocol | **gRPC / HTTP+JSON** | HTTP+JSON / DNS |
| Liveness | Sessions + ephemeral nodes | **Leases** attached to keys | Sessions + native health checks |
| Watches | One-shot, must re-register | **Streaming watch from a revision** — no missed events in the gap | Blocking queries / streaming |
| Killer feature | Sequential nodes; huge deployed base | Backs **Kubernetes**; clean modern API | Service mesh, multi-DC, **DNS interface**, health checking |
| Best for | Existing Hadoop/Kafka-era ecosystems | Cloud-native, K8s-adjacent coordination | Service discovery + mesh across DCs |

**The most interview-relevant difference:** etcd's watch is from a **revision**, and revisions are retained, so a client that disconnects can resume from where it left off and receive every intervening change — no one-shot re-registration gap. ZooKeeper's one-shot watches force the "re-read current state" pattern. If you need a reliable change *stream*, etcd's model is materially better.

**Chubby** (Google, per the Burrows paper) is the ancestor of this whole family — a coarse-grained lock service with a filesystem-like namespace and, notably, an explicit sequencer mechanism for fencing, which is where the "your lock service should hand you a fencing token" idea comes from.

**Practical guidance:** if you're on Kubernetes you already run etcd, so etcd is the natural choice for new coordination needs — but **do not put application data in the cluster's own etcd**, since bloating it destabilizes the control plane; run your own instance. If you're in a JVM/Hadoop/Kafka-era estate, ZooKeeper is probably already there. If the primary need is service discovery with health checks and DNS across datacentres, Consul is purpose-built for it.

---

## 13. The Modern World: Who Still Uses It

**Still on ZooKeeper:** HBase, Hadoop/YARN HA, Solr, Druid, Pinot, NiFi, Flink (historically for HA), and a very large amount of enterprise infrastructure.

**The headline migration: Kafka removed its ZooKeeper dependency** in favour of **KRaft**, a self-managed Raft-based metadata quorum inside the brokers themselves (the KIP-500 line of work; KRaft became production-ready in the 3.x series, ZooKeeper mode was deprecated, and ZooKeeper support was removed in Kafka 4.0 — *check the current Kafka docs for exact version boundaries before relying on this*).

The reasoning behind that migration is genuinely instructive, and it's a great thing to be able to explain:

1. **Two systems to operate, tune, secure, and monitor** instead of one — a real ops burden and two sets of failure modes.
2. **Metadata scalability.** Partition metadata in ZooKeeper had to be loaded and watched, which bounded how many partitions a cluster could support; a replicated metadata *log* consumed like any other Kafka topic scales far better.
3. **Faster failover and recovery.** Controller failover no longer requires reading a large amount of state out of an external system.
4. **Simplicity of the mental model** — Kafka already *was* a replicated log; using an external consensus system to manage a consensus-shaped problem was redundant.

**ClickHouse Keeper** is the other notable data point: a C++, ZooKeeper-wire-compatible reimplementation using Raft, built because the ZooKeeper dependency (and its JVM/GC characteristics) was the operational pain point rather than the API.

**The pattern to notice, and to say out loud in an interview:** systems are moving from *"depend on an external consensus service"* to *"embed a Raft library"*. Consensus became a library (etcd's raft, Hashicorp's raft, NuRaft) rather than a service you deploy. ZooKeeper isn't obsolete — it's the layer that got absorbed. Knowing *why* it's being absorbed is a more senior answer than knowing it's declining.

---

## 14. Decision Framework

```
Do I need multiple nodes to AGREE on something?
├─ NO ──► Don't use a coordination service. A database, cache, or config
│         file is simpler, and you're not paying consensus latency.
│
└─ YES
   │
   ├─ How much data?
   │    kilobytes of metadata ──► fine
   │    megabytes+ / queryable ─► WRONG TOOL. Use a database
   │
   ├─ Write rate?
   │    thousands/sec ──────────► fine
   │    high throughput ───────► WRONG TOOL. One leader + majority fsync is the ceiling
   │
   ├─ What am I actually doing?
   │    leader election ────────► ephemeral + sequential, watch predecessor
   │    service discovery ─────► ephemeral znodes; getChildren == live set
   │    config distribution ───► persistent znode + watch, use version for CAS
   │    correctness lock ──────► ephemeral + sequential + **FENCING TOKEN**
   │    efficiency lock ───────► don't use ZooKeeper. Redis SET NX is enough
   │    change stream ─────────► prefer **etcd** (revision-based watch, no gaps)
   │
   ├─ Which service?
   │    already on Kubernetes ─► etcd (your OWN instance, not the cluster's)
   │    JVM/Hadoop/Kafka-era ─► ZooKeeper (probably already running)
   │    discovery + health + multi-DC + DNS ─► Consul
   │    building a system, not operating one ─► EMBED a Raft library
   │
   └─ ALWAYS:
        • odd ensemble size; 5 in production; NEVER 2
        • reads are NOT linearizable → sync() when you need current
        • session timeout > worst-case GC pause
        • fencing token on every externally-visible action taken under a lock
        • transaction log on its own dedicated disk
        • use Curator (or equivalent) rather than hand-rolling recipes
```

---

## 15. Where This Shows Up in This Repo

| Topic | How it connects | Go read |
|---|---|---|
| **Consensus** | The theory home: Paxos, Raft, ZAB's siblings, and every recipe here derived from first principles | [`§11 Coordination Services`](../interviews/consensus/deep-dive.md#11-coordination-services-zookeeper-etcd-consul) · [`§12 Recipes`](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases) · [`§5 Raft`](../interviews/consensus/deep-dive.md#5-raft-consensus-designed-to-be-understood) · [`§6 Leader Election`](../interviews/consensus/deep-dive.md#6-raft-leader-election-and-terms) · [`§10 Split Brain`](../interviews/consensus/deep-dive.md#10-split-brain-and-network-partitions) · [`§13 Quorum Math`](../interviews/consensus/deep-dive.md#13-quorum-math-and-cluster-sizing) · [`§16 When NOT to`](../interviews/consensus/deep-dive.md#16-when-not-to-use-consensus) |
| **Seat reservation** | The RedLock debate — why a TTL lock isn't correctness-grade, which is the argument *for* this | [`§4 Distributed Locks and the RedLock Debate`](../interviews/seat-reservation/deep-dive.md#4-distributed-locks-and-the-redlock-debate) |
| **KV store** | The contrast: gossip + phi-accrual for AP-style membership, where nodes hold *independent* opinions instead of consulting one authority | [`§8 Membership and Failure Detection`](../interviews/kv-store/deep-dive.md#8-membership-and-failure-detection-gossip--phi-accrual) |
| **Storage engines** | ZooKeeper's own persistence: WAL + fsync + snapshots + replay recovery | [`§9 Durability`](../interviews/storage-engines/deep-dive.md#9-durability-wal-fsync-and-group-commit) · [`§10 Crash Recovery and Checkpoints`](../interviews/storage-engines/deep-dive.md#10-crash-recovery-and-checkpoints) |
| **Distributed transactions** | Why 2PC blocks on coordinator failure, and how coordinator state in a znode fixes it | [`§7 2PC`](../interviews/distributed-transactions/deep-dive.md#7-two-phase-commit-2pc) · [`§8 The Blocking Problem`](../interviews/distributed-transactions/deep-dive.md#8-the-blocking-problem-and-3pc) · [`§3 CAP Stated Correctly`](../interviews/distributed-transactions/deep-dive.md#3-cap-theorem--stated-correctly) |
| **Sharding & replication** | Who's the primary, and who decides — the failover authority problem | [`§3 Replication`](../interviews/sharding-replication/deep-dive.md#3-replication-copies-for-safety-and-speed) |
| **Message queues** | Kafka's controller/metadata layer, and the KRaft migration off ZooKeeper | [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) |
| **Fundamentals** | Every primitive ZooKeeper packages | [quorum](../fundamentals/quorum.md) · [lease](../fundamentals/lease.md) · [fencing](../fundamentals/fencing.md) · [split-brain](../fundamentals/split-brain.md) · [heartbeat](../fundamentals/heartbeat.md) · [leader-and-follower](../fundamentals/leader-and-follower.md) · [write-ahead-log](../fundamentals/write-ahead-log.md) · [gossip-protocol](../fundamentals/gossip-protocol.md) · [phi-accrual](../fundamentals/phi-accrual-failure-detection.md) |
| **Patterns using it** | [contention](./dealing-with-contention.md#8-rung-5-distributed-locks-and-why-theyre-last) (correctness locks) · [long-running-tasks](./long-running-tasks.md#13-scheduled-jobs-and-the-cron-problem) (one scheduler) · [realtime-updates](./realtime-updates.md#3-hop-2-event-source--the-right-server) (connection-tier membership) · [multi-step-processes](./multi-step-processes.md) (coordinator HA) |

---

## 16. Interview Questions

**Q1. What problem does ZooKeeper solve, in one breath?**
It gives a cluster of nodes one authoritative answer to a small number of questions they must agree on — who's the leader, who's alive, what's the current config, who holds this lock — even while nodes are failing. It's a strongly-consistent replicated in-memory filesystem for tiny files, with change notifications and automatic cleanup when a client dies. The reason it exists as a separate service is that consensus is easy to implement subtly wrong, so one hardened implementation gets deployed and every other system delegates coordination to it rather than reinventing it.

**Q2. Explain ephemeral and sequential znodes, and why the combination matters.**
Ephemeral znodes are deleted automatically when the creating client's session ends, which gives failure detection and cleanup for free — a crashed lock holder releases its lock without anyone running a cleanup job or guessing a TTL. Sequential znodes get a monotonically increasing counter appended by the ensemble, which gives global ordering and never reuses a number. Combined, they're the leader-election and lock recipe: every candidate creates an ephemeral sequential node, lowest number wins, and if the winner dies its node disappears and the next in line takes over. You get automatic failover from ephemeral, deterministic FIFO fairness from sequential, and — a detail people miss — the sequence number doubles as a fencing token, which is the thing a Redis lock can't give you.

**Q3 (depth). Are ZooKeeper reads linearizable?**
No, and this is the most common misconception about it. Reads are served locally by whichever ensemble member the client is connected to, with no contact with the leader or a quorum — which is exactly what makes reads fast and horizontally scalable — so a follower that hasn't yet applied the latest committed write will serve you stale data with no error or warning. Writes *are* linearizable and totally ordered by zxid; reads are sequentially consistent, with FIFO ordering per client. If I need a guaranteed-current read I call `sync()` first, which flushes that server up to the leader's latest zxid at the cost of a round trip — that cost is why it isn't the default. Importantly, this doesn't undermine the lock and election recipes, because those depend on the write path and on zxid ordering, not on reads being fresh.

**Q4 (depth). A client's TCP connection drops. Does it lose its lock?**
No, not by itself — and the distinction between a connection and a session is the point. The session is the unit of liveness: it has an ID, a password, and a timeout, and when the socket drops the client library transparently reconnects to a different ensemble member and *resumes the same session*, so ephemeral nodes and locks survive. The lock is only lost if no heartbeat arrives for the whole session timeout, at which point the ensemble — not the client — declares the session expired, and that expiry goes through consensus so every node agrees on exactly when it happened. That single authoritative answer to "is this client dead" is what prevents two clients from believing they hold the same lock, and it's a real advantage over gossip-based failure detection where nodes hold independent opinions.

**Q5 (senior). Your leader GC-pauses for 40 seconds with a 30-second session timeout. Walk me through it.**
The ensemble stops receiving heartbeats, declares the session expired at 30 seconds, deletes the ephemeral znode, and notifies the successor, which becomes leader and starts doing leader work. At 40 seconds the original process resumes with no idea any of that happened and continues acting as leader — so briefly there are two nodes both convinced they're the leader, which is split brain from the application's point of view even though ZooKeeper itself never violated its guarantees. Using ZooKeeper does *not* solve this on its own, and that's the key point: a lock service can never protect against a paused holder, because the paused process can't detect that time passed. The fix is fencing — the leader carries a monotonically increasing token, naturally the zxid or the sequential node's number, passes it with every write to the protected resource, and the resource rejects any token lower than the highest it has seen. So the stale leader's writes are refused because the new leader's token is higher. Additionally, a correctly written client watches for the `Disconnected`/`Expired` state its library surfaces and stops acting the moment it loses certainty about its session — and I'd set the session timeout comfortably above the worst-case GC pause to make the whole scenario rarer.

**Q6 (senior). 500 clients want the same lock. What's wrong with all of them watching the lock node?**
The herd effect. When the lock is released, all 500 get notified, all 500 try to acquire, 499 fail, and they all re-register and repeat — so every single release causes an O(N) notification storm and a burst of failed attempts, which gets worse as contention rises. The fix is the standard recipe: each client creates its own ephemeral sequential child under the lock node and watches **only its immediate predecessor**. Then a release notifies exactly one client, which is O(1) per release, and as a bonus clients acquire in strict FIFO order rather than randomly, so there's no starvation. This is the single most-quoted ZooKeeper design detail and it's why the lock and election recipes look the way they do.

**Q7 (senior). Why odd-sized ensembles, and why not just run 50 nodes for reliability?**
Quorum is a strict majority, so 4 nodes need 3 and tolerate only 1 failure — identical to a 3-node ensemble, while costing more and making every write slower. Even sizes buy latency and nothing else. Five is the usual production choice because tolerating two failures means you can survive a node failing while another is down for maintenance. And scaling up hurts: every write must be acknowledged by a majority and fsynced, so more voting members means more nodes to convince per write, which makes write throughput and latency *worse*, not better. If I need read capacity I add **observers**, which receive updates and serve reads but don't vote, so they don't slow the write path — and they're the right way to put replicas in a remote region. Growing the voting set for performance is an anti-pattern.

**Q8 (senior). Three of your five nodes go down. What can clients still do?**
Nothing that writes. Quorum is lost, so no proposal can be committed, and that includes session expiries and ephemeral node deletions — the cluster is functionally read-only until quorum returns. The two survivors can still serve reads, but those reads are potentially stale and there's no way for a client to distinguish stale from current without a `sync()`, which itself requires a leader. That's ZooKeeper being deliberately CP: it chooses to become unavailable rather than risk two clients both holding the same lock, which is the only defensible choice for a coordination service — an "available" lock service that grants a lock twice is worse than one that says no. The practical consequence is that ZooKeeper is a hard dependency: when it loses quorum, every system that delegates coordination to it degrades, so its availability has to be engineered as carefully as anything it protects.

**Q9 (staff). Why did Kafka remove ZooKeeper, and what does that tell you?**
Four reasons, and the last is the interesting one. Operationally it meant two distributed systems to deploy, tune, secure, and monitor, with two sets of failure modes and two performance profiles — including the JVM/GC characteristics that cause spurious session expiries. Scalability-wise, partition metadata living in ZooKeeper had to be loaded and watched, which put a practical ceiling on partition counts; moving metadata into a replicated Kafka log consumed like any other topic scales much better. Recovery-wise, controller failover no longer requires pulling large state out of an external system, so failover got faster. And conceptually, Kafka already *was* a replicated log with leader election — using an external consensus system to solve a consensus-shaped problem it already had the machinery for was redundant. What that tells me is the broader industry direction: consensus has become a *library* — etcd's raft, Hashicorp's raft, NuRaft — rather than a service you deploy alongside your system, and ClickHouse Keeper reimplementing the ZooKeeper wire protocol on Raft in C++ is the same story. So ZooKeeper isn't obsolete; it's being absorbed into the systems that used to depend on it. I'd say I should verify exact Kafka version boundaries against current docs, since deprecation and removal spanned several releases.

**Q10 (staff). Can I store my application's data in ZooKeeper? It's already highly available.**
No, and the reasons are structural rather than a matter of degree. The entire dataset lives in RAM on every ensemble member with no paging to disk, so your data size is bounded by the smallest node's memory; znodes are capped at 1MB by default and intended for bytes-to-kilobytes; and there's no query capability at all — no indexes, no scans, no `WHERE` — only path-addressed reads and whole-value writes. On the write path, every write goes through a single leader and requires a majority fsync, so throughput is thousands per second, not the tens of thousands a database gives you, and adding nodes makes it worse. Beyond capacity, there's a blast-radius argument: ZooKeeper is the thing your leader elections and locks depend on, so filling it with application data destabilizes coordination for everything in the platform. The same warning applies to etcd on Kubernetes — never put application data in the cluster's own etcd, because bloating it destabilizes the control plane; run a separate instance. The rule of thumb I'd give is kilobytes of metadata, thousands of writes per second, and a hard requirement for agreement — outside that envelope, use a database.

**Q11 (staff). ZooKeeper or etcd for a greenfield system?**
etcd, in most greenfield cases, and the deciding factor is usually the watch model rather than the consensus algorithm — ZAB and Raft are equivalent for practical purposes. etcd's watches are revision-based and revisions are retained, so a client that disconnects resumes from its last revision and receives every intervening change; ZooKeeper's watches are one-shot, so after firing you must re-register and there's a window in which changes are missed, which forces the "notify then re-read current state" pattern and makes a reliable change *stream* awkward. etcd also has a gRPC/HTTP API rather than a custom binary protocol, is a single Go binary with no JVM or GC tuning, and if I'm on Kubernetes the operational knowledge already exists in the org — though I'd run my own instance rather than sharing the control plane's. I'd choose ZooKeeper if I'm in a JVM/Hadoop/Kafka-era estate where it's already deployed and the team knows it, since adding a second coordination service is worse than using the one you have. And I'd choose Consul if the dominant need is service discovery with native health checks, multi-datacentre support, and a DNS interface, because that's what it's purpose-built for. If I'm building a distributed system rather than operating one, the modern answer is often to embed a Raft library and skip the external dependency entirely.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **What it is** | Strongly-consistent replicated in-memory filesystem for tiny files, with watches + auto-cleanup on client death |
| **What it's for** | Leader election, service discovery, config distribution, correctness-grade locks, group membership |
| **znode** | A path that holds small data *and* can have children. Read/written whole, atomically |
| **Persistent** | Lives until deleted — config, topology |
| **Ephemeral** | **Auto-deleted when the session ends.** The killer feature. Cannot have children |
| **Sequential** | Ensemble appends a monotonic 10-digit counter. Never reused → a free fencing token |
| **Ephemeral + sequential** | The lock / leader-election recipe |
| **znode version** | Built-in compare-and-swap: `setData(path, data, expectedVersion)` |
| **Size limit** | 1MB per znode default (`jute.maxbuffer`); intended for bytes-to-KB |
| **Ensemble roles** | Leader (all writes) · Followers (vote + serve reads) · **Observers** (no vote, scale reads) |
| **Quorum** | `⌊N/2⌋+1`. 3→tolerate 1; 5→tolerate 2; 7→tolerate 3 |
| **Why odd** | 4 nodes tolerate the same as 3 but are slower. Even sizes buy nothing |
| **Why not 50 nodes** | More voters = slower writes. Add **observers** for read capacity, never voters |
| **Never** | A 2-node "cluster" |
| **Watch** | **One-shot** — fires once, must re-register. Tells you *that* it changed, not what |
| **Watch pattern** | Notification → **re-read current state**. Never apply a delta from the event |
| **Intermediate states** | Can be missed (A→B→C observed as A→C). Fine for coordination, wrong for event streams |
| **Herd effect** | 500 watchers on one node → O(N) storm per release |
| **Herd fix** | Watch **only your predecessor** → O(1) notifications + FIFO fairness |
| **ZAB** | Leader-based atomic broadcast; same family as Raft/Multi-Paxos; total order of writes |
| **zxid** | 64-bit `[epoch][counter]`, monotonic, never reused. Total order + stale-leader detection + fencing token |
| **Write path** | Forward to leader → assign zxid → fsync to WAL → propose → **quorum ack** → commit → reply |
| **Writes** | Linearizable, totally ordered |
| **⚠️ Reads** | **NOT linearizable** — served locally by any follower, can be stale. Sequential consistency only |
| **`sync()`** | Flush this server to the leader's latest zxid before reading. Costs a round trip |
| **CAP** | **CP** — minority partition cannot write, deliberately |
| **Session ≠ TCP** | A dropped socket reconnects and *resumes the session*; ephemeral nodes survive |
| **Session expiry** | Decided by the **ensemble** via consensus, so everyone agrees when a client died |
| **GC pause hazard** | Session expires, lock reassigned, paused client resumes still believing it holds it |
| **The only fix** | **Fencing token** (zxid / sequence number) checked by the resource. ZooKeeper supplies it; you must use it |
| **Timeout tuning** | Session timeout must exceed worst-case GC pause; short = false expiries, long = slow failover |
| **Storage** | In-memory tree + fsync'd transaction log (WAL) + periodic fuzzy snapshots; recovery = snapshot + replay |
| **#1 tuning tip** | Put the transaction log on its **own dedicated disk** |
| **Dataset bound** | Everything must fit in RAM. No paging |
| **Leader death** | Election; **writes unavailable** for ~100ms–seconds; reads continue (stale) |
| **Quorum loss** | No writes at all — including session expiries. Read-only until quorum returns |
| **Not a** | Database · message queue · cache · high-throughput store · multi-region system |
| **Envelope** | KB of metadata, thousands of writes/sec, hard agreement requirement |
| **Use Curator** | Don't hand-roll the recipes; the raw API is easy to misuse |
| **etcd difference** | **Revision-based streaming watch** — resume without gaps. Plus gRPC, Go binary, backs Kubernetes |
| **Consul difference** | Native health checks, DNS interface, multi-DC, service mesh |
| **Chubby** | Google's ancestor (Burrows, OSDI 2006) — where the fencing-sequencer idea comes from |
| **Kafka → KRaft** | Removed ZooKeeper: fewer systems to operate, better metadata scalability, faster failover, and Kafka already was a replicated log |
| **The trend** | Consensus became a **library** (raft, NuRaft) rather than a service. ZooKeeper was absorbed, not defeated |
| **K8s warning** | Never store application data in the cluster's own etcd |

---

## Related

- **Patterns:** [Dealing with Contention](./dealing-with-contention.md) (why a Redis lock isn't correctness-grade) · [Long-Running Tasks](./long-running-tasks.md) (exactly one scheduler) · [Real-Time Updates](./realtime-updates.md) (connection-tier membership) · [Multi-Step Processes](./multi-step-processes.md) (coordinator HA)
- **Fundamentals:** [quorum](../fundamentals/quorum.md) · [lease](../fundamentals/lease.md) · [fencing](../fundamentals/fencing.md) · [split-brain](../fundamentals/split-brain.md) · [heartbeat](../fundamentals/heartbeat.md) · [leader-and-follower](../fundamentals/leader-and-follower.md) · [write-ahead-log](../fundamentals/write-ahead-log.md) · [gossip-protocol](../fundamentals/gossip-protocol.md) · [phi-accrual-failure-detection](../fundamentals/phi-accrual-failure-detection.md)
- **Topics:** [`consensus`](../interviews/consensus/README.md) · [`seat-reservation`](../interviews/seat-reservation/README.md) · [`kv-store`](../interviews/kv-store/README.md) · [`distributed-transactions`](../interviews/distributed-transactions/README.md) · [`message-queues`](../interviews/message-queues/README.md)
