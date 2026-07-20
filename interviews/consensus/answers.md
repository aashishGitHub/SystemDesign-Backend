# Answers: Distributed Consensus & Coordination

> Keyed to [questions.md](./questions.md). Read questions first — attempt each before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on decisions that matter.
> Illustrative numbers are labeled as such. Consensus latency figures are given relative to a network round-trip, not as absolute benchmarks.

---

## Level 1 — The Core Problem

### A1. What consensus solves

Distributed consensus lets a group of independent machines **agree on a single value (or a single ordered sequence of decisions) and never disagree later — even though some of them may crash and the network may drop or delay messages.**

Every coordination task reduces to this: who is the leader, does this lock belong to client A or client B, what is the committed order of these commands. Without agreement, two nodes make conflicting decisions and there is no safe way to merge them after the fact.

| Property | What consensus guarantees |
|---|---|
| Agreement (safety) | No two correct nodes decide different values |
| Validity | The decided value was actually proposed by some node |
| Termination (liveness) | If enough nodes are up and can communicate, a decision is eventually reached |
| Integrity | A node decides at most once; decisions are never reversed |

---

### A2. Why `is_leader = true` in SQL still causes two leaders

```
Failure 1 — Stale leadership (no lease / no expiry):
  Node A sets is_leader=true, becomes leader.
  Node A is network-partitioned from the DB but keeps acting as leader.
  An operator/watchdog sees A as "gone" and lets Node B set is_leader=true.
  Now A (still running, still thinks it's leader) and B both act as leader.

Failure 2 — Lost update / race without atomic compare-and-set:
  Node A reads is_leader=false, Node B reads is_leader=false (same instant).
  Both write is_leader=true. Without a single atomic CAS + fencing, both "won."
```

The row tells you who *claimed* leadership; it does nothing to *revoke* a leader who has stopped talking to the DB but is still running. The missing pieces are (1) a time-bounded **lease** that expires so a silent leader loses authority, and (2) a **fencing token** so a resumed stale leader's writes are rejected. Those are exactly what a consensus-backed service provides.

---

### A3. Split-brain and why it is worse than a stale cache

**Split-brain** is when a cluster partitions and more than one node believes it holds an exclusive role (leader, lock owner, primary) at the same time. Each side accepts writes independently, producing two divergent, both-"authoritative" histories.

```
Stale cache: worst case = you serve an old value. Recoverable — refetch from source.
Split-brain leader/lock: two writers mutate the same authoritative state.
  → Two "primaries" both accept conflicting orders / balances / config changes.
  → There is NO source of truth to refetch from — both are equally "official."
  → Automatic merge is generally impossible for ordered/mutable state.
```

A read-only cache diverging is a performance/freshness problem. A split-brain leader is a **correctness/data-loss** problem: money double-spent, a job run twice, config flapping between two values. This is why coordination systems choose to **stop** (refuse writes on the minority side) rather than risk two writers — they are CP in CAP terms.

---

### A4. Why a single coordinator is a SPOF (and the GC pause)

A single coordinator gives you one source of truth *only while it is alive and reachable*. It has two fatal properties:

```
1. Availability: if the coordinator dies, ALL coordination stops. It is a
   single point of failure for the entire control plane.

2. Failover is unsafe by construction:
   - The coordinator has a long GC pause (say 20s). It is not dead — just frozen.
   - A watchdog times it out and promotes a standby coordinator.
   - The original coordinator wakes up mid-request, still believing it is in charge.
   - Now two coordinators issue decisions → split-brain.
```

The GC pause is the canonical example because a frozen-but-alive process is indistinguishable from a dead one over the network — you cannot tell "crashed" from "slow." The fix is not "a better coordinator"; it is **replicating the decision across a majority** so no single node's liveness gates the system, plus **leases + fencing tokens** so a resumed straggler cannot act on stale authority.

---

## Level 2 — The Replicated State Machine Model

### A5. The replicated state machine (RSM) model

An RSM keeps N replicas identical by having each replica start from the same initial state and apply the **same commands in the same order**. If the inputs and order are identical and each command is deterministic, the outputs are identical.

```
Replica = deterministic state machine + an ordered input log.

  same initial state
+ same ordered log of commands  ⇒  same final state on every replica
+ deterministic apply
```

The **log** is the primitive (not the state) because agreeing on an append-only ordered sequence is a clean, well-defined consensus problem: nodes only ever need to agree on "what is the command at slot i." Replicating *state* directly is far harder — states are large, and you'd need to agree on every mutation's effect and merge concurrent edits. Agreeing on an ordered log turns "keep these machines identical" into "agree on the next log entry," which is exactly what Paxos/Raft/ZAB do.

---

### A6. The determinism requirement

Every command in the log must be **deterministic**: applying it to a given state must produce the same result on every replica.

```
Non-deterministic (BROKEN):
  SET expiry = NOW() + 60s      # NOW() differs per replica → states diverge
  SET id = random_uuid()        # different UUID per replica
  SET rank = shuffle(items)     # different order per replica

Fixed — resolve non-determinism at the LEADER, then log the concrete result:
  SET expiry = 1720000060       # leader computed the timestamp, logs the value
  SET id = "3f9a...c2"          # leader generated the UUID, logs the value
```

The rule: **compute non-deterministic values once, on the proposer/leader, and put the concrete result in the log** — not the instruction that would recompute it. This is a classic real bug: replicating "increment by a random amount" instead of "set to 42" causes silent replica divergence that only surfaces on failover.

---

### A7. Every coordination need is one problem

All four reduce to *agree on an ordered log of decisions*:

| Coordination need | As an RSM / log problem |
|---|---|
| (a) Elect one leader | Agree on the log entry `LEADER = nodeX for term T`; first one committed wins |
| (b) Distributed lock | Agree on the entry `LOCK held by clientA`; release is another committed entry |
| (c) Cluster config | Config is just committed entries in the log; every replica reads the same value |
| (d) Group membership | `ADD nodeY` / `REMOVE nodeZ` are committed log entries applied in order |

Because they are the same problem, one consensus-backed key-value log (etcd, ZooKeeper) serves all of them. You do not build four systems; you build one replicated log and express each need as commands on it.

---

### A8. Why order matters as much as content

If two replicas apply the same commands in different orders, they reach different states — the whole RSM guarantee collapses.

```
Start: balance = 100
Commands (same set, different order):

Replica 1:  DEPOSIT +50  →  MULTIPLY x2   ⇒  (100+50)*2 = 300
Replica 2:  MULTIPLY x2  →  DEPOSIT +50   ⇒  (100*2)+50 = 250

Same two commands. Different order. Divergent state.
```

Consensus therefore must agree on a **total order** (the log index), not just the set of commands. This is why the log is indexed and why "committed at index i" is the unit of agreement. Agreeing *what* happened is not enough; you must agree *when* (in what sequence) it happened.

---

## Level 3 — Paxos

### A9. Paxos roles and phases

**Roles:** *Proposers* (propose values), *Acceptors* (vote; a majority must accept for a value to be chosen), *Learners* (learn the chosen value). One physical node usually plays multiple roles.

**Phases (single-decree, basic Paxos):**

```
Phase 1 — Prepare / Promise:
  Proposer picks a proposal number n, sends prepare(n) to acceptors.
  Each acceptor: if n > any prepare it has seen, it PROMISES not to accept
    anything numbered < n, and returns the highest-numbered value it has
    already accepted (if any).

Phase 2 — Accept / Accepted:
  If the proposer hears promises from a MAJORITY:
    - If any acceptor returned a previously-accepted value, the proposer MUST
      re-propose that value (with number n). Otherwise it may propose its own.
    - It sends accept(n, value). Acceptors accept it unless they've since
      promised a higher number.
  When a majority accepts, the value is CHOSEN.
```

Phase 1 establishes the right to propose and discovers any value that might already be chosen; Phase 2 gets a majority to commit to a value. The "adopt the highest previously-accepted value" rule in Phase 2 is what preserves safety across competing proposers.

---

### A10. Why a majority quorum — the intersection property

Any two majorities of the same set **must share at least one node**. That shared node is the carrier of information between decisions and is the entire safety argument.

```
N = 5.  Majority = 3.
Quorum A = {1,2,3}   Quorum B = {3,4,5}
Intersection = {3}   ← always non-empty for any two majorities

Because every accept requires a majority, and every new prepare talks to a
majority, the new proposer is GUARANTEED to hear from at least one acceptor
that saw the previously chosen value → it re-proposes that value → no two
different values can ever be chosen.
```

| Quorum choice | Safe? | Why |
|---|---|---|
| Majority (⌊N/2⌋+1) | Yes | Any two majorities intersect on ≥1 node |
| "Any 2 nodes" (fixed) | No | Two disjoint pairs can both "decide" different values |
| All N nodes | Safe but fragile | One node down blocks all progress → no liveness |

**Tradeoff: Safety vs Liveness in quorum size.** Requiring *all* nodes is safe but a single failure halts progress. Majority is the smallest quorum that still guarantees intersection, so it maximizes fault tolerance while staying safe. That is why majority is universal.

---

### A11. Proposal numbers and the promise

A **proposal number** (ballot) is a globally unique, monotonically increasing number that totally orders proposals (typically `(counter, nodeId)` so no two proposers ever collide).

When an acceptor responds to `prepare(n)`, it **promises**: "I will not accept any proposal numbered less than n," and it reports back the highest-numbered value it has already accepted.

```
Acceptor state: promised_n = 0, accepted_n = null, accepted_val = null

on prepare(n):
    if n > promised_n:
        promised_n = n
        return PROMISE(accepted_n, accepted_val)   # may be null
    else:
        return REJECT(promised_n)                    # a higher number already seen
```

This prevents an **older/slower proposer from overwriting a newer decision**: once a majority has promised to number n, any proposal with a smaller number is dead. It is the mechanism that makes competing proposers converge instead of clobbering each other.

---

### A12. Multi-Paxos and its key optimization

Basic Paxos agrees on **one** value. **Multi-Paxos** runs Paxos independently for each slot of a log (slot 0, slot 1, …), producing an ordered sequence — a replicated log.

The critical optimization: **elect a stable leader and skip Phase 1**.

```
Basic Paxos per slot: Phase 1 (prepare) + Phase 2 (accept) = 2 round-trips/entry.

Multi-Paxos optimization:
  Run Phase 1 ONCE to become the "distinguished proposer" (leader) for a range
  of future slots. While the leader is stable, every new command needs only
  Phase 2 (accept) → 1 round-trip per committed entry.
```

| | Basic Paxos per entry | Multi-Paxos (stable leader) |
|---|---|---|
| Round-trips to commit | 2 (prepare + accept) | 1 (accept only) |
| Leader | None (any proposer) | One distinguished leader |
| Contention | Dueling proposers can livelock | Single leader → no dueling |

**Tradeoff: Leaderless resilience vs steady-state latency.** Basic Paxos needs no leader (any node can drive a decision) but pays two round-trips and risks livelock from dueling proposers. Multi-Paxos halves steady-state latency and eliminates dueling, at the cost of needing a leader-election / re-prepare step whenever the leader fails. Every practical system (including Raft, which is essentially a well-specified Multi-Paxos) chooses the stable-leader design.

---

## Level 4 — Raft

### A13. Terms in Raft

A **term** is a monotonically increasing integer that divides time into a sequence of "reigns." Each term begins with an election; a term has **at most one leader**.

Terms serve two jobs:

```
1. Logical clock / staleness detector:
   Every RPC carries the sender's term. If a node sees a term > its own, it
   immediately steps down to follower and adopts the higher term. If it sees
   a term < its own, it rejects the message. This is how a stale leader is
   detected and demoted the instant it talks to an up-to-date node.

2. At-most-one-leader-per-term guarantee:
   A node votes at most once per term, and a candidate needs a majority.
   Two candidates cannot both get a majority in the same term (majorities
   intersect), so no term ever has two leaders.
```

Terms replace real clocks with a logical clock, which is why Raft never needs synchronized time for safety (only for liveness/timeouts).

---

### A14. Raft leader election

```
Trigger:
  A follower hears nothing from a leader within its (randomized) election timeout.
  It assumes the leader is dead.

Becoming a candidate:
  1. Increment currentTerm.
  2. Vote for itself.
  3. Send RequestVote(term, candidateId, lastLogIndex, lastLogTerm) to all peers.
  4. Reset its election timer.

Winning:
  A candidate becomes leader when it receives votes from a MAJORITY (including
  its own). It immediately sends heartbeats (empty AppendEntries) to assert
  leadership and suppress other elections.

Voting rules (a follower grants a vote iff):
```

```python
def handle_request_vote(req):
    if req.term < current_term:
        return Reply(current_term, vote_granted=False)
    if req.term > current_term:            # newer term seen → step down
        current_term = req.term
        voted_for = None
        state = FOLLOWER
    # up-to-date check (see A17): candidate log must be at least as current
    up_to_date = (req.last_log_term > my_last_log_term) or \
                 (req.last_log_term == my_last_log_term and
                  req.last_log_index >= my_last_log_index)
    if voted_for in (None, req.candidate_id) and up_to_date:
        voted_for = req.candidate_id       # at most one vote per term
        reset_election_timer()
        return Reply(current_term, vote_granted=True)
    return Reply(current_term, vote_granted=False)
```

**No two leaders in one term:** each node votes at most once per term, and a majority is required to win. Two candidates cannot each collect a majority in the same term because any two majorities overlap on a node that only voted once. Split votes (no majority) simply cause the term to end with no leader; a new randomized timeout fires and a new term/election begins.

---

### A15. Raft log replication, end to end

```
1. Client sends command to the leader (followers redirect clients to the leader).
2. Leader APPENDS the command to its own log as a new entry (term, index, command).
   The entry is now durable on the leader but NOT yet committed.
3. Leader sends AppendEntries(entry) to all followers (in parallel).
4. Each follower that passes the log-consistency check appends the entry and acks.
5. Once the entry is stored on a MAJORITY of nodes (leader + enough followers),
   the leader marks it COMMITTED and advances its commitIndex.
6. Leader applies the command to its state machine, then RESPONDS "success"
   to the client.
7. Leader piggybacks the new commitIndex on the next AppendEntries; followers
   then apply the committed entry to their own state machines.
```

The leader tells the client **success only after the entry is committed** (durable on a majority and applied). This is the safety-critical line: if the leader crashes the instant after acking, the entry survives because it is already on a majority, and any new leader must contain it (see A17/A22).

**Tradeoff: Latency vs Durability.** Committing needs one round-trip to a majority before the client hears "success." You could ack earlier (after only the leader writes) for lower latency, but then a leader crash loses acknowledged writes — violating the core constraint. Raft chooses durability; the round-trip is the price.

---

### A16. Log Matching Property and the consistency check

The **Log Matching Property** states: if two logs contain an entry with the same index and term, then (a) they store the same command at that index, and (b) all preceding entries are identical. In other words, matching index+term ⇒ identical logs up to that point.

It is enforced by the `AppendEntries` **consistency check**:

```python
def handle_append_entries(req):
    if req.term < current_term:
        return Reply(current_term, success=False)
    reset_election_timer()
    # Consistency check: my log must already match the leader at prevLogIndex.
    if req.prev_log_index >= len(log) or \
       log[req.prev_log_index].term != req.prev_log_term:
        return Reply(current_term, success=False)   # gap or mismatch → reject
    # Delete any conflicting suffix, then append the new entries.
    append_and_overwrite_conflicts(req.entries, at=req.prev_log_index + 1)
    if req.leader_commit > commit_index:
        commit_index = min(req.leader_commit, index_of_last_new_entry)
    return Reply(current_term, success=True)
```

Each `AppendEntries` includes `prevLogIndex`/`prevLogTerm` — the entry immediately before the new ones. The follower accepts only if it already has a matching entry there. **On rejection, the leader decrements `nextIndex` for that follower and retries**, walking backward until it finds the last point where the logs agree, then overwrites the follower's divergent suffix forward. This is how a follower with a stale or divergent tail is repaired to match the leader exactly.

---

### A17. The election restriction (up-to-date rule)

**Rule:** a voter refuses its vote to any candidate whose log is **less up-to-date** than its own. "More up-to-date" is defined as: higher last-log-term wins; if terms tie, longer log (higher last-log-index) wins.

```
Candidate C: lastLogTerm=4, lastLogIndex=9
Voter V:     lastLogTerm=5, lastLogIndex=6

C's last term (4) < V's last term (5) → C is LESS up-to-date → V refuses.
```

Because a leader needs a majority to win, and any majority overlaps the majority that stored any committed entry, this rule guarantees the winner's log **contains every committed entry**. The disaster it prevents: a node that missed committed entries becoming leader and then overwriting/erasing those committed entries on the rest of the cluster — i.e., losing acknowledged writes. This is Raft's **Leader Completeness** guarantee, and it is why Raft never needs to "backfill" committed entries into a new leader.

---

## Level 5 — Failure Modes & Theory

### A18. FLP impossibility, in plain language

**FLP (Fischer, Lynch, Paterson, 1985)** proves: in a *fully asynchronous* system (no bound on message delay or processing time) where even *one* process may crash, there is **no deterministic algorithm that guarantees consensus is always reached** (guarantees both safety and termination). The core issue: you cannot distinguish a crashed process from an arbitrarily slow one, so any algorithm can be forced to wait forever at exactly the wrong moment.

How real algorithms exist despite it:

```
FLP forbids guaranteeing BOTH:
   (safety = never wrong)  AND  (liveness = always eventually decides)
in a fully async model with a possible crash.

Paxos/Raft keep SAFETY unconditionally (they are NEVER wrong), and relax the
liveness guarantee: they only guarantee termination when the network is
"well-behaved enough" (partial synchrony — messages eventually arrive within
some bound). They use TIMEOUTS to approximate this.

So: FLP is not "consensus is impossible." It is "you cannot guarantee it
always terminates in a purely async model." In practice networks are mostly
synchronous, so timeouts let progress happen almost always.
```

**The key interview line:** consensus algorithms never sacrifice safety to dodge FLP; they sacrifice *guaranteed liveness in the worst case*. A pathological network can stall Raft forever (repeated split votes), but it will never make Raft decide two different values.

---

### A19. Two Generals vs FLP

The **Two Generals Problem**: two generals must agree to attack simultaneously but can only communicate via messengers crossing hostile territory (messages can be lost). It proves that **guaranteed agreement over an unreliable channel is impossible with any finite number of messages** — no matter how many acks you send, the last message might be the lost one, so neither side can ever be *certain* the other received confirmation.

```
                 | Two Generals              | FLP
-----------------|---------------------------|-------------------------------
About            | Unreliable COMMUNICATION  | Async timing + a PROCESS CRASH
Faulty element   | The network (message loss)| A process (may crash)
Channel assumed  | Lossy (messages dropped)  | Reliable eventually, but async
Conclusion       | No certain agreement over | No deterministic algorithm
                 | a lossy link in finite    | guarantees termination with
                 | messages                  | one crash-fault, fully async
```

**Two Generals is about the network; FLP is about process crashes plus timing.** Two Generals says a perfectly reliable *link* is needed for certainty (so real systems settle for high-probability agreement via retries). FLP assumes messages eventually get through but shows crashes + unbounded delay still block guaranteed termination. Both are circumvented the same way in practice: retries + timeouts + accepting probabilistic (not absolute) liveness.

---

### A20. 5-node cluster splits 3-2

```
Majority side (3 nodes):
  - Can still form a quorum (3 ≥ ⌊5/2⌋+1 = 3).
  - Elects/keeps a leader, commits writes normally.
  - This side stays AVAILABLE and consistent.

Minority side (2 nodes):
  - Cannot reach a quorum of 3.
  - Cannot elect a leader; if it held the old leader, that leader cannot
    commit new entries (no majority to ack) and steps down / stalls.
  - It REFUSES writes. Reads may be served but risk being stale unless
    linearizable-read machinery is used.
```

| Side | Quorum reachable? | Accepts writes? | Behavior |
|---|---|---|---|
| Majority (3) | Yes | Yes | Elects leader, commits, stays consistent |
| Minority (2) | No | No | Cannot commit; blocks/refuses writes |

Only the **majority side can accept writes**. This is CP behavior: the minority sacrifices availability to preserve consistency (no split-brain). When the partition heals, the minority nodes catch up by receiving the missing committed entries from the leader.

---

### A21. Why randomized election timeouts

Raft randomizes each node's election timeout (illustratively, each picks a value uniformly from a range like 150–300 ms).

```
Fixed timeout (BROKEN):
  Leader dies → all followers time out at the SAME instant → all become
  candidates at once → they split the vote (no one gets a majority) →
  term ends with no leader → they all time out together AGAIN → repeat.
  This is an election LIVELOCK — the cluster never elects a leader.

Randomized timeout (FIX):
  Each follower times out at a different moment. Usually ONE follower times
  out first, becomes candidate, and collects a majority before any other
  follower even starts → clean single-winner election on the first try.
```

Randomization prevents **repeated split votes** — a specific liveness failure. It is a probabilistic fix (occasionally two nodes still tie and re-randomize), which is exactly how Raft sidesteps FLP: it cannot *guarantee* a leader is elected in bounded time, but it makes it overwhelmingly likely, fast.

---

### A22. Why an old leader can't corrupt the committed log

Suppose an old leader L1 (term 3) is partitioned into the minority while a new leader L2 (term 4) is elected on the majority side. Raft prevents L1 from doing damage through several interlocking rules:

```
1. L1 cannot commit new entries: it cannot reach a majority (it's in the
   minority), so its post-partition writes are never committed — they stay
   uncommitted local entries and were never acked to clients.

2. Term check demotes L1: the moment L1 contacts any up-to-date node (or
   heals), it sees term 4 > 3, and immediately steps down to follower.

3. Leader Completeness: L2 was elected only because its log contained all
   COMMITTED entries (the up-to-date election restriction, A17). So nothing
   committed before the partition is missing on L2's side.

4. Log repair overwrites divergence: L1's uncommitted tail (entries it wrote
   alone in the minority) is overwritten by L2's log via the AppendEntries
   consistency check when L1 rejoins as a follower. Uncommitted ≠ acked, so
   discarding it loses nothing the client was promised.
```

**The guarantee:** only *uncommitted* entries (never acked to any client) are ever discarded. Every entry that was committed (acked) is present on the new leader and survives. Split-brain is prevented not by stopping two leaders from *existing* transiently, but by ensuring the stale one can never *commit* and its orphan writes are safely discarded.

---

## Level 6 — Coordination Services

### A23. ZooKeeper vs etcd vs Consul

| Service | Consensus / broadcast protocol | Most common uses |
|---|---|---|
| **ZooKeeper** | ZAB (ZooKeeper Atomic Broadcast) | Leader election, config, locks; metadata store for Kafka (historically), HBase, Hadoop |
| **etcd** | Raft | Kubernetes' backing store (all cluster state), service discovery, leader election, config |
| **Consul** | Raft (for the consistent KV/catalog) + gossip (SWIM-based) for membership/health | Service discovery, health checking, KV config, service mesh |

Notes worth stating in an interview:
- **ZAB** is not Paxos; it is a primary-backup atomic broadcast protocol designed for ZooKeeper's needs, though it shares the majority-quorum idea.
- **etcd** is the reference "Raft in production" system; Kubernetes stores *all* its state in etcd, which is why etcd health = cluster health.
- **Consul** deliberately separates two concerns: strong-consistency data goes through **Raft**, while large-scale failure detection/membership uses a **gossip (SWIM-style)** protocol that scales to many nodes without every node paying consensus cost.
- **Kafka**: historically used ZooKeeper for controller election and metadata; newer versions use **KRaft** (a Raft-based internal metadata quorum) to remove the ZooKeeper dependency.

---

### A24. Leader election with ephemeral sequential nodes

```
Recipe (ZooKeeper-style):
  1. Every candidate creates an EPHEMERAL SEQUENTIAL znode under /election/:
       /election/n_0000000001   (candidate A)
       /election/n_0000000002   (candidate B)
       /election/n_0000000003   (candidate C)
     "Ephemeral" = auto-deleted when the creator's session ends (crash/timeout).
     "Sequential" = the service assigns a strictly increasing suffix.

  2. The candidate with the LOWEST sequence number is the leader.
     (A, holding n_...001, is leader.)

  3. Herd-effect avoidance: a candidate does NOT watch the leader. It watches
     ONLY the next-lower znode. B watches A's znode; C watches B's znode.

  4. When a candidate's watched predecessor disappears, it wakes up and
     re-checks whether it is now the lowest. If yes → it becomes leader.
     If no → it sets a watch on its new predecessor.
```

```python
def campaign(zk, path="/election"):
    my_node = zk.create(f"{path}/n_", ephemeral=True, sequential=True)
    while True:
        children = sorted(zk.get_children(path))
        my_seq = children.index(basename(my_node))
        if my_seq == 0:
            return "I AM LEADER"                     # lowest sequence wins
        predecessor = children[my_seq - 1]           # watch ONLY the next-lower
        if zk.exists(f"{path}/{predecessor}", watch=True):
            wait_for_watch_event()                   # sleep until predecessor gone
        # loop re-evaluates leadership after predecessor disappears
```

**Exactly one leader:** the sequence numbers give a total order, so there is always exactly one lowest node. **Herd-effect avoided:** if all N candidates watched the leader, a leader death would wake all N at once (a thundering herd of N re-reads). Watching only your immediate predecessor means a single death wakes exactly *one* node — the next in line — turning an O(N) stampede into O(1) work per failover.

---

### A25. Sessions / leases and automatic failover

A **session** (ZooKeeper) or **lease** (etcd) is a time-bounded liveness token between a client and the cluster. The client must keep it alive with periodic heartbeats/keepalives; if the cluster stops hearing from the client for the session timeout, it **expires the session** and reclaims everything tied to it.

```
Session lifecycle:
  1. Client connects, cluster grants a session with TTL (e.g., 10s).
  2. Client sends heartbeats every TTL/3 to keep it alive.
  3. Ephemeral znodes / lease-bound keys exist ONLY while the session lives.
  4. Client crashes / partitions / GC-pauses past the TTL:
       → cluster expires the session
       → ALL its ephemeral nodes are deleted, ALL its held locks released
       → watchers fire → failover happens automatically
```

This is *the* mechanism that makes automatic failover possible: **a crashed leader's ephemeral leadership znode disappears on its own**, without any human or external watchdog deciding it is dead. The lease turns "detect the leader died" into "the leader's own token expired," which the cluster can decide unilaterally and safely.

**Tradeoff: Failover speed vs false positives.** A short session TTL detects real failures faster but is more likely to expire a healthy-but-briefly-slow client (GC pause, transient network blip), causing an unnecessary failover. A long TTL avoids false positives but leaves a dead leader's locks held longer. Tune TTL to just above your worst realistic pause.

---

### A26. The GC-pause lock problem — and fencing tokens

This is the classic distributed-lock hazard: **a lease can expire while the holder is frozen, so "I hold the lock" is never safe to trust at the moment you act.**

```
t=0   Client 1 acquires lock (lease TTL = 10s).
t=1   Client 1 starts a 30s stop-the-world GC pause (frozen, not dead).
t=10  Lease expires. Cluster grants the lock to Client 2.
t=11  Client 2 enters the critical section, writes to storage.
t=31  Client 1 wakes up, STILL believes it holds the lock, writes to storage.
      → Two writers in the critical section → corruption.
```

**The fix is a fencing token** (a monotonically increasing number issued with each lock grant), enforced at the **resource**, not the client:

```python
# The lock service issues a monotonically increasing token with each grant.
token1 = lock_service.acquire("job-42")   # returns 33
# ... Client 1 pauses; lease expires ...
token2 = lock_service.acquire("job-42")   # Client 2 gets 34

# The RESOURCE (DB / storage) rejects any write with a token <= the last it saw.
storage.write(data, fencing_token=34)     # Client 2: accepted, records 34
storage.write(data, fencing_token=33)     # Client 1 wakes up: 33 < 34 → REJECTED
```

**Key insight:** you cannot make the *lock hold* perfectly safe (any process can freeze at any time), so you make the *effect* safe. The resource remembers the highest token it has served and rejects anything stale. A lock alone is advisory; a lock **plus fencing** is enforceable. This is the standard answer, popularized in Martin Kleppmann's writing on distributed locking.

---

## Level 7 — Quorum Math & Membership Changes

### A27. Quorum and fault-tolerance formulas

```
Quorum (majority)        = ⌊N/2⌋ + 1
Failures tolerated       = N − quorum = ⌈N/2⌉ − 1   (i.e. ⌊(N−1)/2⌋)
```

| N | Quorum ⌊N/2⌋+1 | Failures tolerated |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 6 | 4 | 2 |
| 7 | 4 | 3 |

**Why odd numbers:** going from an odd N to the next even N adds a node but **does not add fault tolerance** while it *does* raise the quorum (more nodes must ack every write, so higher latency and more to go wrong). N=3 and N=4 both tolerate exactly 1 failure; N=5 and N=6 both tolerate 2. So even sizes cost you availability and latency for zero resilience gain — always pick odd (3, 5, 7).

---

### A28. Why 2 nodes is worse than 1

```
N=1:  quorum = 1.  Failures tolerated = 0.  The single node serves writes
      whenever it is up.

N=2:  quorum = ⌊2/2⌋+1 = 2.  Failures tolerated = 2 − 2 = 0.
      BOTH nodes must ack every write. If EITHER node is down, you have no
      quorum → NO writes at all.
```

| Cluster | Quorum | Failures tolerated | Write available when… |
|---|---|---|---|
| 1 node | 1 | 0 | that 1 node is up |
| 2 nodes | 2 | 0 | BOTH nodes are up |
| 3 nodes | 2 | 1 | any 2 of 3 are up |

A 2-node cluster tolerates the *same* zero failures as a single node, but now **requires both** to be up to make progress — so its write availability is *lower* (you've doubled the failure surface with no resilience benefit) and any partition between the two halts everything. If you're going to pay for a second node, pay for a third: 3 nodes is the first size that actually tolerates a failure.

---

### A29. Why you can't hot-swap the whole membership

If you switch from old config C_old to new config C_new in one atomic-looking step, different nodes adopt the new config at slightly different times — and during that window **two disjoint majorities can form**, each electing its own leader.

```
C_old = {A, B, C}       C_new = {C, D, E}

During an uncoordinated switch:
  {A, B} still think config is C_old → majority of C_old (2 of 3) → elect Leader1
  {D, E} already think config is C_new → majority of C_new (2 of 3) → elect Leader2
  A and B never talked to D and E. Two leaders, two committed histories. SPLIT-BRAIN.

The root cause: C_old's majority {A,B} and C_new's majority {D,E} are DISJOINT.
```

**Joint consensus (Raft's two-phase change)** avoids this: the cluster first enters a transitional config **C_old,new** in which a decision requires a majority of *both* C_old and C_new simultaneously. Because every decision needs overlap with both, no split-brain is possible during the transition. Once C_old,new is committed, the cluster moves to C_new alone.

```
Phase 1: commit C_old,new  → agreement needs majority of C_old AND majority of C_new
Phase 2: commit C_new      → now only C_new majority is required
At no point can two disjoint majorities decide independently.
```

**Simpler alternative (also used by Raft):** change membership **one node at a time**. Adding/removing a single node guarantees the old and new majorities always overlap (they differ by one member), so no disjoint-majority window exists — no joint-consensus bookkeeping needed.

---

### A30. Safely growing 3 → 5 nodes

```
Do it ONE node at a time (single-server change):

  Start: {A,B,C}  quorum=2, tolerates 1 failure.
  Step 1: add D → {A,B,C,D}  quorum=3, tolerates 1 failure.
          (New node should first catch up / snapshot-sync as a non-voting
           learner so it doesn't drag down quorum while empty.)
  Step 2: add E → {A,B,C,D,E}  quorum=3, tolerates 2 failures.

Your fault tolerance ACTUALLY improves only at Step 2 (reaching N=5). At the
intermediate N=4 you still tolerate just 1 failure — so don't celebrate early.
```

**What goes wrong if you add both at once:** jumping {A,B,C} → {A,B,C,D,E} in one shot risks the disjoint-majority hazard of A29 (and the two empty new nodes could be counted toward quorum before they have any data, so a couple of failures right after the change could lose committed entries). Add nodes sequentially, let each new node **catch up as a non-voting learner** before it counts toward quorum, and only then promote it. This is exactly how etcd (`member add --learner`) and CockroachDB/Consul manage growth.

---

## Level 8 — Architect-Level Tradeoffs

### A31. Keeping consensus off the hot path

Consensus is expensive per operation (a round-trip to a majority, plus a durable log write). "Keep it off the hot path" means: **run consensus only for the small, rarely-changing, correctness-critical metadata, and serve the high-volume data plane with cheaper mechanisms.**

| Put it THROUGH consensus (control plane) | Keep it OUT of consensus (data plane) |
|---|---|
| Who is the current leader / primary | Every user read/write of application data |
| Where does shard X live (routing table) | Streaming bytes, media, bulk records |
| Cluster config, feature flags, membership | Cache fills, analytics events |
| Distributed lock ownership, leases | Idempotent, retryable, high-QPS operations |

```
Pattern: consensus decides the ONE fact "Node 7 is the leader for shard X."
That single committed fact is read millions of times but WRITTEN rarely.
Once clients know the leader, they talk to it DIRECTLY — no consensus per request.
The data plane replicates via cheaper primary-backup / quorum writes, not a
full consensus round per byte.
```

**Tradeoff: Consistency cost vs throughput.** Everything through consensus is trivially correct but caps your throughput at consensus speed. The architect's job is to shrink the set of facts that truly need global agreement to the smallest possible core (leadership, routing, config) and let the bulk data ride on top of those decisions. Kubernetes is the textbook example: cluster *state* lives in etcd (consensus), but running *workloads* do not hit etcd on every request.

---

### A32. Lease reads and read index

A linearizable read must not return data older than the latest committed write. The naive-safe way is to push the read *through the log* (or confirm leadership with a majority round-trip) — expensive. Two optimizations:

```
Read Index:
  1. Leader records its current commitIndex as the "read index."
  2. Leader confirms it is STILL the leader by exchanging one round of
     heartbeats with a majority (nobody has moved to a higher term).
  3. Once its state machine has applied up to the read index, it serves the
     read locally.
  → Avoids writing a log entry, but still pays ONE majority round-trip to
    confirm leadership. Safe under all conditions.

Lease Read (leader lease):
  1. The leader holds a time-based lease: "I am guaranteed leader until time T"
     (granted because followers promise not to elect a new leader before then).
  2. While within the lease (clock now < T minus a safety margin), the leader
     serves reads LOCALLY with NO round-trip at all.
  → Fastest possible linearizable read.
```

| Method | Cost per read | Depends on | Risk |
|---|---|---|---|
| Read through log | Full commit round-trip | Nothing extra | Slowest, safest |
| Read index | One majority heartbeat round-trip | Majority reachable | Safe; still a round-trip |
| Lease read | Zero round-trips (local) | **Bounded clock drift** | Stale read if clocks drift past the safety margin |

**Tradeoff: Read latency vs clock-drift assumption.** The lease read is essentially free but **trades a network round-trip for a clock assumption**: it is only safe if real clock skew stays within the lease's safety margin. If a leader's clock runs slow (or is paused) it might serve reads believing its lease is still valid after a new leader was already elected — a stale read. The read index avoids the clock dependency at the cost of one round-trip. Systems like etcd and CockroachDB support both and default to the safe option, using lease reads only where clock bounds are trusted.

---

### A33. Geo-distributed consensus without cross-continent latency per write

The trick is **many small consensus groups, each local**, instead of one global consensus over everything.

```
Anti-pattern: one Raft/Paxos group spanning US-EU-ASIA for ALL data.
  Every commit needs a majority ACROSS continents → ~cross-region RTT on every
  write. Unusable for latency-sensitive workloads.

Pattern (Spanner, CockroachDB): SHARD the keyspace into ranges. Each range is
its OWN consensus group (a "Paxos group" in Spanner / a "Raft group per range"
in CockroachDB). Place each group's replicas — and its leader/leaseholder —
close to where that data is accessed.
```

```
Range covering EU-users data:
  replicas in eu-west-1a/1b/1c → leader/leaseholder in eu-west-1
  → EU writes commit with an INTRA-region majority (fast).
Range covering US-users data:
  replicas + leaseholder in us-east-1 → US writes commit locally.

Cross-region cost is paid ONLY when you touch data in another region, or for a
transaction that spans ranges in multiple regions.
```

- **Spanner** uses Paxos groups per shard and **TrueTime** (a clock with a bounded uncertainty interval) to order transactions globally without a global consensus round on every commit.
- **CockroachDB** runs a Raft group per range and concentrates reads/writes on a per-range **leaseholder**, placed near the data's users.

**Tradeoff: Locality vs cross-shard transactions.** Per-shard groups make single-shard operations fast and local, but a transaction spanning shards in different regions must coordinate across groups (two-phase commit over the involved leaders) — paying cross-region latency. You design the sharding/partitioning so that the common-case transaction stays within one region's ranges.

---

### A34. When NOT to use consensus

Use consensus only when you truly need **linearizable, single-order agreement**. If the data can tolerate temporary divergence that later converges, a leaderless / eventually-consistent design avoids the coordination tax entirely.

| Workload profile | Better than consensus | What you give up |
|---|---|---|
| High-write, "add-to-set" / counters / presence, conflicts are mergeable | **CRDTs** (conflict-free replicated data types) | Linearizability — you get *eventual*, deterministic convergence, not a single global order |
| Massive-scale KV where availability during partitions beats strict consistency (shopping cart, session store) | **Dynamo-style leaderless quorums** (tunable N/W/R, hinted handoff) | Strong consistency — reads may be stale; concurrent writes reconciled later |

```
Litmus test:
  "If two replicas make different decisions during a partition, can I merge
   them automatically and correctly later?"
    YES → you probably don't need consensus (use CRDTs / eventual consistency).
    NO  → you need consensus (leadership, locks, unique ordering, balances).
```

**Named tradeoff: Coordination cost vs consistency.** Consensus buys you one global order at the price of a majority round-trip and unavailability of the minority during partitions. CRDTs/eventual consistency stay available and cheap everywhere but can only guarantee *convergence*, not a single authoritative order. Pick eventual consistency when the operations commute or conflicts are safely mergeable; pick consensus when "there can be only one answer" (one leader, one lock owner, one balance).

---

### A35. Three follow-ups before "use a distributed lock for one worker per job"

```
1. "Is the job effect idempotent, or must it run EXACTLY once?"
   → Guards against: the fundamental impossibility of exactly-once execution
     under crashes. A lock gives mutual exclusion, not exactly-once. If the
     worker can crash mid-job after side effects, you need idempotency or a
     transactional outbox — the lock alone won't save you.

2. "Does the resource enforce a FENCING TOKEN?"
   → Guards against: the GC-pause / expired-lease double-writer problem (A26).
     Without the downstream resource rejecting stale tokens, the lock is only
     advisory and two workers can still both act.

3. "What is the lease TTL relative to the max job duration and max pause?"
   → Guards against: a long job outliving its lease (lease expires mid-work →
     a second worker starts) OR a TTL so long that a genuinely dead worker
     blocks the job for minutes. TTL must exceed worst-case pause but be short
     enough for acceptable failover.
```

Bonus follow-up worth raising: *"What happens to in-flight work when the lock is lost?"* — a correct worker must **stop touching the resource the instant it can no longer confirm it holds the lock**, not finish its current operation optimistically.

---

## Bonus — Senior Questions

### AB1. Healthy cluster, doubled commit latency

Before blaming the network, two self-inflicted causes dominate:

```
Cause 1 — Slow / saturated disk (fsync latency):
  Every committed Raft/Paxos entry must be durably persisted (fsynced) before
  it's acked. If the disk is slow (noisy neighbor, HDD instead of SSD, or a
  full disk), commit latency tracks fsync latency.
  Confirm: measure WAL/fsync latency; etcd exposes wal_fsync and backend_commit
  duration metrics. If those spiked, it's disk, not network.

Cause 2 — Too much data in the store / large snapshots:
  Coordination stores are meant for SMALL metadata. If someone dumped large
  values or millions of keys, every operation, compaction, and snapshot
  transfer gets slower; leader elections and follower catch-up drag.
  Confirm: check DB size and per-key value sizes against the store's guidance
  (e.g., etcd's recommended DB size limits). Look for large values / key churn.
```

**Tradeoff: Commit durability vs latency.** You cannot skip the fsync without risking losing acknowledged writes on a power failure, so the answer is faster/dedicated disks (local SSD/NVMe) for the consensus log, not weaker durability. And keep the store small — consensus systems are control planes, not databases.

---

### AB2. Three-datacenter cluster with slow writes

```
Why writes are slow:
  A write commits only after a MAJORITY acks. With replicas spread across 3
  regions, the majority almost always includes at least one REMOTE replica, so
  every commit pays a cross-region round-trip to the nearest-enough majority.

Placement strategy:
  - Use an ODD total (e.g., 5) so there's always a clean majority.
  - Keep the LEADER and enough replicas for a local majority in your PRIMARY
    region, so common-case commits stay intra-region. Put the remaining
    replicas in other regions for disaster tolerance.
  - The classic 2-2-1 layout: 2 replicas in region A, 2 in region B, and ONE
    "tiebreaker" (witness) node in a THIRD region C. The tiebreaker breaks
    ties and prevents a split-brain if A and B partition, without you having
    to run a full third datacenter — but note commits still need a majority,
    so if you want intra-region commit latency, concentrate the leader's local
    majority in one region.
```

**Tradeoff: Disaster tolerance vs write latency.** Spreading replicas widely survives a whole-region loss but makes every commit cross a region. Concentrating a majority in one region gives fast commits but means losing that region loses your write availability until failover. The tiebreaker-in-a-third-region pattern is the standard compromise: it guarantees a majority can always form after any single-region failure while keeping most commits regional.

---

### AB3. Co-locating the consensus cluster with the data plane

```
Danger: resource contention starves the consensus layer, which then triggers
false failovers and elections precisely when the system is busy.

Specific contentions to call out:
  - DISK/IO: the consensus log needs low-latency fsync. A busy data plane
    saturating the same disk spikes commit latency (see AB1) → slow commits,
    then election timeouts fire → spurious leader changes under load.
  - CPU: a GC pause or CPU starvation in the co-located process freezes
    heartbeats → the node looks dead → unnecessary failover / re-election.
  - MEMORY: the data plane's memory pressure can push the consensus process
    into swap or OOM, taking a voting member down.
  - Failure correlation: co-location couples failure domains — one bad host
    now takes out both a data node AND a consensus voter at once, eroding your
    quorum math (you assumed independent failures).
```

**Tradeoff: Hardware cost vs isolation/stability.** Co-location saves machines but couples the control plane's stability to the data plane's load — the opposite of what you want, since the control plane must stay calm *especially* when the data plane is stressed. Give consensus members dedicated (or at least resource-isolated, cgroup-limited) nodes with their own fast disk. This is why managed Kubernetes runs etcd on dedicated control-plane nodes.

---

### AB4. Stale reads right after a leader change

```
Why it happens:
  A newly elected leader has all COMMITTED entries in its log (Leader
  Completeness), but it may not have APPLIED them to its state machine yet, and
  in Raft it does not know its true commitIndex for the new term until it
  commits something in that term. So immediately after election, serving reads
  from its (not-yet-caught-up) state machine can return stale data.

The one thing a new leader must do before serving reads:
  Commit a NO-OP entry in its OWN (new) term and apply up through it.
  - Committing a no-op in the current term advances the commitIndex to include
    all prior entries (Raft only counts an entry committed once an entry from
    the CURRENT term is committed above it).
  - The leader then applies up to that commit index, so its state machine
    reflects every committed write before it answers any read.
```

**Tradeoff: Failover speed vs read correctness.** Serving reads instantly after election is faster but can leak stale data; the no-op commit (plus applying up to it, and the read-index/lease machinery from A32) adds a small delay after each election in exchange for linearizable reads. Every correct Raft implementation pays this: a fresh leader establishes its commit point in its own term before it is trusted to answer reads.

---

## Consensus Decision Guide — Quick Reference

### Which protocol / approach?

| Situation | Best Choice | Reason |
|---|---|---|
| Need a single ordered log, want understandable code | Raft | Designed for understandability; strong tooling (etcd) |
| Academic/legacy system, per-slot flexibility | Multi-Paxos | Foundational; stable-leader optimization matches Raft |
| Need a ready-made coordination service (K8s ecosystem) | etcd (Raft) | Battle-tested; Kubernetes' own store |
| JVM ecosystem, Kafka/Hadoop lineage | ZooKeeper (ZAB) | Mature recipes for locks/election |
| Service discovery + health at large scale | Consul (Raft + SWIM gossip) | Splits strong-consistency KV from scalable membership |
| Data tolerates eventual consistency / mergeable conflicts | CRDTs / Dynamo-style | Avoid consensus tax; stay available under partition |

### Which cluster size?

| Need to tolerate | Use N | Quorum | Note |
|---|---|---|---|
| 1 failure | 3 | 2 | Smallest useful cluster |
| 2 failures | 5 | 3 | Common production default |
| 3 failures | 7 | 4 | Diminishing returns; higher write latency |
| — | Never 2 or 4 | — | Even sizes add cost, not fault tolerance |

### Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Consensus goal | Agree on one ordered log of decisions despite crashes and message loss; never disagree later |
| Split-brain | Two nodes both act as leader/owner → divergent authoritative writes → no safe merge |
| Single coordinator flaw | SPOF + can't distinguish frozen (GC pause) from dead → unsafe failover |
| Replicated state machine | Same start + same ordered commands + deterministic apply = identical replicas |
| Why the log is the primitive | Agreeing on "next entry at slot i" is a clean consensus problem; state is not |
| Determinism rule | Compute NOW()/random on the leader, log the concrete value, not the instruction |
| Paxos phases | Prepare/Promise (claim + discover) → Accept/Accepted (commit to a majority) |
| Majority intersection | Any two majorities share ≥1 node → carries the chosen value forward → safety |
| Multi-Paxos optimization | Stable leader skips Phase 1 → 1 round-trip per entry instead of 2 |
| Raft term | Monotonic logical clock; ≤1 leader per term; higher term demotes a stale leader |
| Raft commit | Entry committed once on a majority; leader acks client only after commit |
| Log Matching | Same index+term ⇒ identical command and identical prefix; enforced by prevLogIndex check |
| Election restriction | Voter refuses candidate with less up-to-date log → new leader has all committed entries |
| FLP (1985) | No deterministic async algorithm guarantees termination with one crash; keep safety, relax liveness |
| Two Generals | No certain agreement over a lossy channel in finite messages (network fault, not crash) |
| Randomized timeouts | Prevent repeated split votes / election livelock |
| Old leader can't corrupt | It can't reach a majority → never commits; its uncommitted tail is overwritten |
| Quorum formula | ⌊N/2⌋+1; failures tolerated = N − quorum; use odd N (3,5,7) |
| Why 2 nodes is bad | Quorum 2, tolerates 0 failures, needs BOTH up → worse than 1 node |
| Joint consensus | Membership change needs majority of BOTH old and new configs → no disjoint majorities |
| Ephemeral-node election | Lowest sequential znode = leader; watch only your predecessor to avoid herd effect |
| Session / lease | Time-bounded liveness token; expiry auto-releases locks/leadership → enables failover |
| Fencing token | Monotonic number enforced at the resource; rejects a woken stale lock holder's writes |
| Keep consensus off hot path | Consensus for leadership/routing/config; data plane replicates cheaply, hits leader directly |
| Lease read vs read index | Lease read = local, zero RTT, trusts clock; read index = one majority RTT, no clock assumption |
| Geo consensus | Per-shard Raft/Paxos groups, leaseholder near the data (Spanner Paxos groups, CockroachDB ranges) |
| New-leader no-op | Commit+apply a no-op in the new term before serving reads → avoids stale reads |
| When NOT to use consensus | Mergeable/eventual data → CRDTs or Dynamo-style; give up single global order, keep availability |
