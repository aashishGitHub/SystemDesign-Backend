# Deep Dive: Distributed Consensus & Coordination

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> Numbers labeled "illustrative" are order-of-magnitude teaching values, not benchmarks. Consensus latency is described relative to a network round-trip.

---

## Table of Contents

1. [The Core Problem: Why You Need Agreement](#1-the-core-problem-why-you-need-agreement)
2. [The Replicated State Machine and the Log](#2-the-replicated-state-machine-and-the-log)
3. [Paxos: The Foundational Algorithm](#3-paxos-the-foundational-algorithm)
4. [Multi-Paxos and Leader-Based Consensus](#4-multi-paxos-and-leader-based-consensus)
5. [Raft: Consensus Designed to Be Understood](#5-raft-consensus-designed-to-be-understood)
6. [Raft Leader Election and Terms](#6-raft-leader-election-and-terms)
7. [Raft Log Replication and Commit](#7-raft-log-replication-and-commit)
8. [Raft Safety: Why Committed Means Committed](#8-raft-safety-why-committed-means-committed)
9. [The Theory: FLP, Two Generals, and Impossibility](#9-the-theory-flp-two-generals-and-impossibility)
10. [Split Brain and Network Partitions](#10-split-brain-and-network-partitions)
11. [Coordination Services: ZooKeeper, etcd, Consul](#11-coordination-services-zookeeper-etcd-consul)
12. [Recipe: Leader Election, Locks, and Leases](#12-recipe-leader-election-locks-and-leases)
13. [Quorum Math and Cluster Sizing](#13-quorum-math-and-cluster-sizing)
14. [Membership Changes Without Split-Brain](#14-membership-changes-without-split-brain)
15. [Read Optimizations and Geo-Distributed Consensus](#15-read-optimizations-and-geo-distributed-consensus)
16. [When NOT to Use Consensus](#16-when-not-to-use-consensus)
17. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Core Problem: Why You Need Agreement

### 🟢 Beginner — The Two Managers Who Never Talk

Imagine a store with two managers. Each can approve refunds. Normally they coordinate by walking over and talking. One day the intercom breaks and they can't reach each other. A customer asks manager A for a refund; A approves it. The same customer walks to manager B and asks again; B, unable to check with A, also approves. The store paid twice.

The problem isn't that either manager is bad — it's that **two people with authority who can't communicate will make conflicting decisions.** Distributed consensus is the rulebook that guarantees, no matter what breaks, there is effectively *one* decision-maker and *one* answer for anything that must not be done twice.

---

### 🟡 Senior — Why "Just Use a Database Flag" Fails

The naive design: a shared row `leader = nodeX`. It fails in two independent ways.

```python
# BROKEN attempt 1: read-then-write race (no atomicity)
row = db.get("leader")
if row is None:
    db.set("leader", my_id)      # Node A and Node B both saw None → both set it

# BROKEN attempt 2: no revocation (no lease)
db.set("leader", my_id)          # A becomes leader
# A gets partitioned from clients but KEEPS RUNNING and acting as leader.
# An operator points traffic at B. Now A and B both act as leader.
```

The two missing primitives are exactly what consensus systems provide:

| Missing primitive | What it prevents | How consensus provides it |
|---|---|---|
| Atomic compare-and-set on a majority | Two nodes both "winning" the write | A value is chosen only via majority agreement |
| Time-bounded lease + fencing token | A stale leader acting after it lost authority | Session expiry revokes; fencing rejects stale writes |

A single atomic write in one database still leaves the *revocation* problem: the database can't tell a frozen-but-alive leader from a dead one, and it has no way to stop the frozen one from resuming. You need a lease that expires and a fencing token that the downstream resource enforces.

---

### 🔴 Architect — The Cost of Getting This Wrong

Split-brain is not a theoretical edge case; it is a top cause of correctness incidents in distributed systems. The blast radius:

```
Failure chain from one undetected split-brain:
  1. Network partition isolates the current primary (still alive).
  2. A watchdog/orchestrator promotes a standby to primary.
  3. Both primaries accept writes to the same authoritative state.
  4. Partition heals. Now there are TWO divergent histories.
  5. There is no correct automatic merge for ordered/mutable state
     (balances, sequence numbers, config) → manual reconciliation,
     data loss, or an outage while you figure out which history is "real."

Why you can't "just detect and fix it later":
  - You often can't tell WHICH writes are correct after the fact.
  - The two histories may both have been acked to different clients.
```

**The architectural rule:** for anything where "done twice" or "two answers" is a correctness violation (leadership, locks, unique IDs, balances, config), you route the decision through consensus and accept that the minority side becomes *unavailable* during a partition. Availability of the minority is the price of never having two truths. This is the CP choice in CAP, made deliberately.

---

## 2. The Replicated State Machine and the Log

### 🟢 Beginner — Everyone Follows the Same Recipe

Give five cooks the same starting ingredients and the exact same recipe steps in the exact same order, and they all produce the same dish. If one cook adds salt before mixing and another after, the dishes differ — even though both "added salt."

A replicated state machine works this way: every server starts identical and follows the same list of instructions in the same order. The magic isn't in the servers; it's in agreeing on **the ordered list of instructions**. That list is called the log.

---

### 🟡 Senior — The Log Is the Primitive

```
Replica = deterministic state machine + append-only ordered log.

  index:   0        1         2         3
  log:  [SET x=1] [SET y=2] [INCR x] [DEL y]
           │          │         │        │
           ▼          ▼         ▼        ▼
  apply in order on every replica → identical state everywhere
```

You replicate the *log*, not the *state*, because agreeing on "what is the single command at slot i" is a small, crisp consensus problem, whereas agreeing on arbitrary state merges is not.

```python
class ReplicatedStateMachine:
    def __init__(self):
        self.log = []          # the agreed-upon ordered commands
        self.state = {}        # derived purely from applying the log
        self.last_applied = -1

    def apply_committed(self, commit_index):
        # Deterministic replay: same log + same order ⇒ same state everywhere.
        while self.last_applied < commit_index:
            self.last_applied += 1
            cmd = self.log[self.last_applied]
            self.state = cmd.apply(self.state)   # MUST be deterministic
```

| Replicate the... | Difficulty | Why |
|---|---|---|
| Current state directly | Hard | Must agree on/merge every concurrent mutation; large payloads |
| Ordered log of commands | Tractable | One agreement per slot; deterministic replay reconstructs state |

---

### 🔴 Architect — The Determinism Trap in Production

The single most common way an RSM silently breaks: a command that is **not deterministic**. It works fine until a failover, then replicas disagree.

```
Real failure pattern:
  Command logged:  "SET session.expiry = NOW() + 3600"
  Leader applies:  expiry = 10:00:00 + 3600
  Follower applies (later, on failover): expiry = 10:00:05 + 3600
  → Replicas now hold DIFFERENT expiry times for the same session.
  → Divergence is invisible until the follower becomes leader and serves
    the "wrong" value. No error is ever logged.

Fix (resolve non-determinism at the leader BEFORE logging):
  Leader computes expiry = 1720000000, logs "SET session.expiry = 1720000000".
  Every replica now applies the identical concrete value.
```

**Design-review checklist for any replicated command:** no wall-clock reads, no RNG, no map/set iteration order dependence, no reads of un-replicated local state, no floating-point that varies by platform. If a value must be non-deterministic, **compute it once on the proposer and log the result**, never the generator.

---

## 3. Paxos: The Foundational Algorithm

### 🟢 Beginner — The Auction Where the Highest Bidder Sets the Rule

Picture an auction hall. Anyone can propose a decision, but to make it stick they need most of the room to agree. Before you shout your proposal, you first ask the room: "Has anyone already agreed to something?" If the room says "yes, we leaned toward X," honesty requires you to champion X rather than your own idea. That way, once a majority has leaned toward a value, nobody can later push a *different* value through — every new bidder is forced to carry the existing one forward.

That "ask first, then adopt whatever the majority already favored" discipline is the heart of Paxos. It's how a chaotic room full of independent proposers still converges on exactly one answer.

---

### 🟡 Senior — Single-Decree Paxos Mechanics

```
Roles: Proposer, Acceptor (majority needed), Learner.

Phase 1 — Prepare/Promise:
  Proposer → prepare(n)                # n = unique, increasing ballot number
  Acceptor: if n > highest prepare seen:
              promise not to accept anything < n
              reply with (accepted_n, accepted_val) if it already accepted one

Phase 2 — Accept/Accepted:
  Proposer, on a MAJORITY of promises:
    if any promise carried a value → MUST reuse the highest-numbered one
    else → may use its own value
  Proposer → accept(n, value)
  Acceptor: accept unless it has since promised a higher n
  When a MAJORITY accepts → value is CHOSEN (permanent).
```

```python
class Acceptor:
    def __init__(self):
        self.promised_n = 0
        self.accepted_n = None
        self.accepted_val = None

    def on_prepare(self, n):
        if n > self.promised_n:
            self.promised_n = n
            return ("PROMISE", self.accepted_n, self.accepted_val)
        return ("REJECT", self.promised_n)

    def on_accept(self, n, val):
        if n >= self.promised_n:          # not superseded by a later prepare
            self.promised_n = n
            self.accepted_n = n
            self.accepted_val = val
            return ("ACCEPTED", n)
        return ("REJECT", self.promised_n)
```

The safety-critical line is "reuse the highest-numbered previously-accepted value." Without it, two proposers could get different values chosen. With it, once any value could have been chosen, every subsequent proposal carries it forward.

---

### 🔴 Architect — Why Paxos Is Famously Hard to Implement

Basic Paxos as published (Lamport's "The Part-Time Parliament," and later "Paxos Made Simple") describes agreeing on a *single* value. Turning it into a working replicated log surfaces a pile of under-specified problems:

```
Gaps you must fill to ship real Paxos:
  - Log of many values: run an instance per slot → need Multi-Paxos + a leader.
  - Leader election / distinguished proposer: not specified by basic Paxos.
  - Dueling proposers: two proposers keep out-bidding each other's ballots →
    LIVELOCK (no value ever chosen) unless you add backoff/leadership.
  - Filling log gaps: if slot 5 is chosen but slot 4 isn't, you must resolve 4.
  - Membership changes, snapshots, log compaction: all left as exercises.

Consequence: "Paxos" in industry almost always means a specific, heavily-
engineered Multi-Paxos variant, and papers like Google's "Paxos Made Live"
(Chubby) document how much extra work the real system needed beyond the paper.
```

This difficulty — a correct algorithm that is treacherous to implement and reason about — is precisely the motivation that produced Raft.

---

## 4. Multi-Paxos and Leader-Based Consensus

### 🟢 Beginner — Elect a Chairperson, Skip the Formalities

Doing a full auction for *every* single decision is exhausting. Instead the room elects a chairperson. Once everyone trusts the chair, the chair just says "next decision is X" and the room nods — no need to re-run the "has anyone already agreed?" ritual each time. If the chair leaves, the room holds one election and picks a new chair. This is dramatically faster in the common case where the chair is stable.

---

### 🟡 Senior — Amortizing Phase 1

```
Basic Paxos per log slot:
  slot i: prepare(n) + accept(n, v)   → 2 round-trips per entry

Multi-Paxos:
  Run Phase 1 (prepare) ONCE over a whole RANGE of future slots to become the
  stable leader. Then each new command is just Phase 2:
  slot i: accept(n, v)                 → 1 round-trip per entry
```

| | Basic Paxos / slot | Multi-Paxos (stable leader) |
|---|---|---|
| Round-trips to commit an entry | 2 | 1 |
| Who can propose | Anyone (dueling risk) | The elected leader only |
| Livelock risk | Yes (dueling proposers) | No (single proposer) |
| Recovery cost | None (no leader) | One election on leader failure |

**Tradeoff: Leaderless flexibility vs steady-state speed.** Basic Paxos needs no leader and any node can drive a decision, but pays double round-trips and can livelock. Multi-Paxos concentrates proposals in one leader for single-round-trip commits, paying a re-election whenever the leader dies. Every high-throughput system chooses the leader-based design — including Raft, which is essentially a carefully-specified Multi-Paxos.

---

### 🔴 Architect — The Leader Is a Throughput Bottleneck and a Failure Domain

```
Because ALL writes flow through one leader:
  - The leader's disk fsync rate caps cluster write throughput.
  - The leader's uplink caps replication bandwidth.
  - A slow leader (bad disk, GC, CPU steal) slows the WHOLE cluster, even
    though followers are healthy.

Mitigations architects reach for:
  - Batching: the leader batches many client commands into one AppendEntries
    → amortizes the per-round-trip cost across many entries.
  - Pipelining: send the next batch before the previous is acked.
  - Sharding: split data into MANY consensus groups, each with its own leader,
    so leadership (and load) is spread across machines (see §15).
  - Leadership balancing: don't let all shard leaders pile onto one node.
```

The interview-grade insight: a single consensus group does **not** scale writes horizontally — adding nodes adds fault tolerance and read capacity (with care), not write throughput. To scale writes you add *more groups*, not more members.

---

## 5. Raft: Consensus Designed to Be Understood

### 🟢 Beginner — One Clear Boss at a Time

Raft's whole philosophy: keep it simple enough that a human can hold it in their head. There is always exactly one boss (the leader). The boss takes all requests, writes them down, and tells everyone else to write down the same thing in the same order. If the boss goes quiet, the team holds a quick election and picks a new boss. That's it — three states (follower, candidate, leader) and a couple of rules.

---

### 🟡 Senior — The Three States and Why Understandability Matters

Raft was introduced by Diego Ongaro and John Ousterhout in 2014 ("In Search of an Understandable Consensus Algorithm"). Its explicit design goal was **understandability** — the authors argued Paxos was so hard to understand that implementations diverged from the theory and introduced bugs.

```
Raft node is always in exactly one of three states:

   ┌───────────┐  times out (no heartbeat)   ┌───────────┐
   │ FOLLOWER  │ ──────────────────────────► │ CANDIDATE │
   └───────────┘                             └───────────┘
        ▲   ▲                                    │  wins majority
        │   │ discovers current leader/higher    ▼
        │   └─────────── term ────────────  ┌───────────┐
        │        steps down (higher term)   │  LEADER   │
        └───────────────────────────────────└───────────┘
```

Raft decomposes consensus into three sub-problems you can study independently:

| Sub-problem | Raft's mechanism | Section |
|---|---|---|
| Leader election | Terms + randomized timeouts + majority votes | §6 |
| Log replication | Leader-driven AppendEntries + commit index | §7 |
| Safety | Election restriction + Log Matching + term rules | §8 |

---

### 🔴 Architect — Why "Understandable" Is an Operational Property

```
Understandability is not academic vanity — it has production consequences:

  - etcd, Consul, TiKV, CockroachDB, and many others implemented Raft
    correctly enough to ship because the spec is followable.
  - Operators can reason about failovers: "leader died → election → new leader
    with all committed entries" is a sentence you can debug at 3 a.m.
  - The Raft paper ships a formal safety argument and TLA+ specification, so
    implementers can check their design against a reference.

Contrast: several early Paxos-based systems documented (in their own papers)
how much the real implementation diverged from the textbook and how many
subtle bugs that introduced. Choosing an understandable protocol is choosing
fewer 3 a.m. incidents.
```

The architectural takeaway: when picking a consensus library, prefer one whose model you and your on-call team can fully explain. A consensus bug is a *silent data-loss* bug — the most expensive kind.

---

## 6. Raft Leader Election and Terms

### 🟢 Beginner — Waiting Rooms with Different Timers

Everyone on the team has a stopwatch. As long as the boss keeps checking in, everyone resets their stopwatch. If the boss goes silent, whoever's stopwatch runs out *first* stands up and says "I'll be boss — vote for me." Because everyone's stopwatch is set to a slightly different length, usually just one person stands up first, gets the votes, and becomes boss cleanly. If two happen to stand at once and tie, they sit back down, reset random timers, and try again.

---

### 🟡 Senior — Terms as a Logical Clock

```
Term = a monotonically increasing integer. Each term has at most one leader.

Every RPC carries the sender's term. The universal rule:
  if incoming.term > my.term:  adopt it, become FOLLOWER   (I'm stale)
  if incoming.term < my.term:  reject the message           (sender is stale)
```

```python
def become_candidate(self):
    self.current_term += 1               # new term
    self.state = CANDIDATE
    self.voted_for = self.id             # vote for self
    votes = 1
    self.reset_election_timer()          # randomized, e.g. 150–300 ms (illustrative)
    for peer in self.peers:
        reply = peer.request_vote(
            term=self.current_term,
            candidate_id=self.id,
            last_log_index=self.last_log_index(),
            last_log_term=self.last_log_term(),
        )
        if reply.term > self.current_term:
            self.step_down(reply.term)   # someone is ahead → abandon election
            return
        if reply.vote_granted:
            votes += 1
    if votes >= self.majority():
        self.become_leader()             # send heartbeats immediately
```

**No two leaders per term:** each node casts at most one vote per term, and winning needs a majority. Two candidates can't both get a majority in the same term because the majorities would overlap on a node that only voted once.

---

### 🔴 Architect — Tuning Election Timeouts and Avoiding Flapping

```
Election timeout budget (illustrative order-of-magnitude, tune per environment):
  heartbeat interval        ~ 50–100 ms
  election timeout range     ~ 10× heartbeat, randomized (e.g., 500–1000 ms)
  Rule of thumb: election_timeout >> heartbeat, so a healthy leader's
  heartbeats always beat every follower's timer.

Failure modes from bad tuning:
  - Timeout TOO LOW: normal jitter / a brief GC pause on the leader triggers
    a needless election → leadership churn → every election stalls writes.
  - Timeout TOO HIGH: real leader failure takes a long time to detect →
    long write outage.

Flapping leader (leadership churn) symptoms:
  - Frequent term increases (monitor the current term number; it should be
    stable for long periods).
  - Repeated "stepping down / becoming leader" log lines.
  Root causes: overloaded leader disk (heartbeats delayed), CPU starvation,
  network jitter, or co-location with a noisy data plane (see §11 / AB3).

Guardrail: alert on term-change rate. A term that increments many times per
minute means the cluster can't hold a stable leader — investigate the leader's
disk/CPU/network before anything else.
```

---

## 7. Raft Log Replication and Commit

### 🟢 Beginner — The Boss's Notebook, Copied to Everyone

The boss writes each instruction in a notebook, numbered in order. Then the boss dictates it to the team so everyone copies it into their own notebook at the same line number. Once *most* of the team has copied line 7, the boss considers line 7 "official" and acts on it — and only then tells the customer "done." If the boss had acted before most people copied it, and then the boss got hit by a bus, that instruction would vanish. Waiting for "most people have it" is what makes it safe.

---

### 🟡 Senior — AppendEntries and the Commit Index

```
Flow for one client command:
  1. Client → Leader: command
  2. Leader appends {term, index, command} to its log (uncommitted)
  3. Leader → all Followers: AppendEntries(prevLogIndex, prevLogTerm, [entry], leaderCommit)
  4. Followers pass the consistency check, append, and ACK
  5. Entry replicated on a MAJORITY → leader advances commitIndex
  6. Leader applies to state machine, replies "success" to client
  7. Next AppendEntries carries the new commitIndex → followers apply too
```

```python
def handle_append_entries(self, req):
    if req.term < self.current_term:
        return Reply(self.current_term, success=False)
    if req.term > self.current_term:
        self.step_down(req.term)
    self.reset_election_timer()          # a valid leader is alive
    # --- Log Matching consistency check ---
    if req.prev_log_index >= 0:
        if req.prev_log_index >= len(self.log) or \
           self.log[req.prev_log_index].term != req.prev_log_term:
            return Reply(self.current_term, success=False)   # gap/mismatch → leader retries lower
    # --- Append, overwriting any conflicting suffix ---
    self.append_overwriting_conflicts(req.entries, start=req.prev_log_index + 1)
    if req.leader_commit > self.commit_index:
        self.commit_index = min(req.leader_commit, self.last_log_index())
    return Reply(self.current_term, success=True)
```

**The client hears "success" only after commit** (majority-durable + applied). That single rule is what makes an acked write survive an immediate leader crash.

| When leader acks client | Durability | Risk |
|---|---|---|
| After local append only | Weak | Leader crash loses acked write → violates the contract |
| After majority commit (Raft) | Strong | Survives any minority failure; costs one round-trip |

---

### 🔴 Architect — Backtracking, Snapshots, and Throughput Math

```
Follower repair (leader with a lagging/divergent follower):
  On AppendEntries reject, leader decrements nextIndex[follower] and retries,
  walking backward until logs agree, then streams the correct suffix forward.
  Optimization: followers can return a conflict hint (term + first index of
  that term) so the leader skips backward by whole terms, not one entry at a
  time — important when a follower is far behind.

Snapshots / log compaction:
  The log can't grow forever. Periodically each node snapshots its state
  machine and discards log entries before the snapshot. A follower that is too
  far behind (leader already discarded the entries it needs) is caught up via
  InstallSnapshot instead of AppendEntries.

Throughput math (illustrative):
  If each commit needs 1 fsync and the disk does ~1,000 fsync/s, a naive
  design caps at ~1,000 commits/s. BATCHING 100 commands per fsync raises the
  ceiling to ~100,000 commands/s at the same fsync rate. This is why every
  serious Raft implementation batches and pipelines — the disk fsync rate,
  not the network, is usually the first wall.
```

**Real production story:** etcd exposes `wal_fsync_duration_seconds` and `backend_commit_duration_seconds` precisely because slow disk fsync is the number-one cause of etcd (and therefore Kubernetes control-plane) latency. The standard remediation is dedicated local SSD/NVMe for the etcd data directory — a disk decision that directly gates cluster-wide write latency.

---

## 8. Raft Safety: Why Committed Means Committed

### 🟢 Beginner — You Can Only Promote Someone Who Read All the Minutes

Before you make someone the new boss, you check that they've read *all* the official meeting minutes so far. You'd never promote someone who missed the last three decisions — they might "undo" things everyone already agreed on. Raft's rule is the same: you can only elect a leader whose notebook is at least as complete as everyone else's. That guarantees the new boss already knows every official decision.

---

### 🟡 Senior — The Election Restriction and Leader Completeness

```
Up-to-date comparison (voter refuses a less-complete candidate):
  candidate MORE up-to-date if:
     candidate.lastLogTerm  > voter.lastLogTerm
  OR (candidate.lastLogTerm == voter.lastLogTerm
      AND candidate.lastLogIndex >= voter.lastLogIndex)
```

```python
def log_is_up_to_date(self, cand_last_term, cand_last_index):
    my_term = self.last_log_term()
    my_index = self.last_log_index()
    if cand_last_term != my_term:
        return cand_last_term > my_term        # higher last term wins
    return cand_last_index >= my_index          # tie on term → longer log wins
```

Because a leader needs a majority to be elected, and any committed entry is on a majority, the two majorities overlap on at least one node — and that node will refuse to vote for anyone missing the committed entry. Therefore **the new leader's log contains every committed entry.** This is the **Leader Completeness Property**, and it's why Raft never has to copy committed entries *into* a new leader.

| Property | Statement |
|---|---|
| Election Safety | At most one leader per term |
| Log Matching | Same index+term ⇒ identical command and identical prefix |
| Leader Completeness | A leader's log holds every entry committed in earlier terms |
| State Machine Safety | No two nodes ever apply different commands at the same log index |

---

### 🔴 Architect — The "Commit Only in Current Term" Subtlety

This is the subtle rule that trips up implementers and makes for a great senior interview probe:

```
A leader may NOT consider an entry from a PREVIOUS term committed just because
it is now stored on a majority. It must commit an entry from its OWN current
term first; that carries the earlier entries with it.

Why: without this rule, an entry replicated to a majority by an old leader
could later be OVERWRITTEN by a newer leader — an entry could appear committed
and then vanish. The Raft paper shows this exact scenario (its Figure 8).

Practical consequence — the no-op on election:
  A freshly elected leader immediately appends and commits a NO-OP entry in
  its new term. This:
    (a) establishes the leader's true commit index for the term, and
    (b) lets it safely advance commit over inherited entries.
  Only after this may it serve linearizable reads (see §15) without risking
  returning data that is not yet truly committed.
```

**The architect's reading:** "committed" in Raft is a promise that the entry is permanent under all future leader changes. Preserving that promise requires the current-term rule and the post-election no-op. If someone claims their consensus system "commits on majority, always," ask them how they handle the previous-term case — it separates people who read the paper from people who read a blog post.

---

## 9. The Theory: FLP, Two Generals, and Impossibility

### 🟢 Beginner — You Can't Tell "Slow" from "Dead"

Text a friend "want to meet at 7?" and get no reply. Are they ignoring you, did the text fail, or are they just slow? You genuinely cannot tell from silence alone. That single ambiguity — *is the other side dead or just slow?* — is the root of the deepest results in distributed systems. Because you can never be *sure*, no protocol can *promise* to always reach a decision quickly. Real systems cope by setting a deadline ("if no reply by 6:45, I'll assume no") — a timeout — and accepting they'll occasionally be wrong.

---

### 🟡 Senior — Two Impossibility Results, Two Different Causes

```
FLP (Fischer, Lynch, Paterson, 1985):
  In a FULLY ASYNCHRONOUS system (no timing bounds) where even ONE process may
  crash, NO deterministic algorithm can guarantee consensus is always reached
  (both safety AND termination). Root cause: can't distinguish crashed from slow.

Two Generals Problem:
  Two parties over a LOSSY channel can never be CERTAIN they agree, with any
  finite number of messages. Root cause: the last confirming message might be
  the one that's lost, forever.
```

| | Two Generals | FLP |
|---|---|---|
| Faulty element | The network (message loss) | A process (may crash) + async timing |
| Channel | Unreliable / lossy | Reliable eventually, but unbounded delay |
| Conclusion | No certain agreement over a lossy link | No guaranteed termination with 1 crash, async |
| Real-world escape | Retries + accept high-probability agreement | Timeouts (partial synchrony) + accept probabilistic liveness |

**How Paxos/Raft live with FLP:** they never give up **safety** (they are *never* wrong, even in the worst case). They only give up *guaranteed* termination — they add timeouts to assume the network is "synchronous enough" most of the time, and randomization to make progress overwhelmingly likely. A truly adversarial network can stall them forever, but can never make them decide two different values.

---

### 🔴 Architect — What This Means for SLAs and On-Call

```
FLP in operational terms:
  "We cannot guarantee a leader is elected within X ms in the worst case."
  You CAN say: "Under normal (partially synchronous) conditions, failover
  completes within ~election_timeout + a round-trip." You CANNOT promise it
  under an arbitrarily bad network.

Design consequences:
  1. Never build a system whose CORRECTNESS depends on a timeout being right.
     Timeouts affect LIVENESS (when you make progress), never SAFETY (whether
     you're correct). If a wrong timeout can cause two leaders, your design is
     broken — timeouts should only cause a (possibly premature) new election,
     which is still safe.
  2. Set timeouts from measured tail latency, not guesses. Too tight → false
     failovers under load; too loose → slow recovery.
  3. Expect and monitor "no progress" windows during pathological partitions —
     they are permitted by theory. Alert on "no committed entry for N seconds"
     and "leaderless for N seconds" rather than assuming they can't happen.
```

The mature stance: consensus systems trade *guaranteed liveness* for *unconditional safety*, and that trade is the right one — a system that is occasionally unavailable is recoverable; a system that is occasionally wrong is not.

---

## 10. Split Brain and Network Partitions

### 🟢 Beginner — The Island That Keeps Its Own Books

Imagine a company with offices connected by phone. A storm cuts the line, splitting them into two groups. If both groups keep approving budgets independently, when the line comes back there are two conflicting sets of books. The safe rule: only the group with *most* of the company can keep making decisions; the smaller group must pause until reconnected. Nobody likes pausing, but it beats two irreconcilable ledgers.

---

### 🟡 Senior — Majority Rules Under Partition

```
5-node cluster splits 3 | 2:

  MAJORITY side {A,B,C}          MINORITY side {D,E}
  ─────────────────────          ──────────────────
  quorum = 3, reachable          quorum = 3, NOT reachable
  elects/keeps leader            cannot elect a leader
  commits writes                 cannot commit (no majority acks)
  STAYS AVAILABLE (CP: C)        REFUSES writes (CP: sacrifices A)
```

```python
def can_make_progress(reachable_nodes, cluster_size):
    quorum = cluster_size // 2 + 1
    return reachable_nodes >= quorum

can_make_progress(3, 5)   # True  → majority side serves writes
can_make_progress(2, 5)   # False → minority side blocks
```

Only one side can ever hold a majority (majorities can't be disjoint), so **at most one side makes progress** — split-brain of *committed* state is impossible. When the partition heals, the minority nodes receive the missing committed entries via AppendEntries/InstallSnapshot and rejoin.

| Side | Quorum? | Writes | Reads | On heal |
|---|---|---|---|---|
| Majority | Yes | Yes | Linearizable (with read-index/lease) | Unaffected |
| Minority | No | Blocked | Stale unless it defers to leader | Catches up from leader |

---

### 🔴 Architect — Asymmetric Partitions and the "Zombie Leader"

```
Nastier than a clean split: an ASYMMETRIC partition.
  The old leader can SEND to followers but not RECEIVE their acks (or vice
  versa), or it's isolated from followers but still reachable by CLIENTS.

  Danger: the isolated old leader keeps ACCEPTING client requests it can never
  commit, and might serve STALE READS from its local state if it naively reads
  locally.

Protections:
  - The old leader cannot COMMIT (needs majority acks it can't get) → no acked
    write is ever lost, and clients' writes just hang/time out rather than
    "succeeding" incorrectly.
  - Linearizable reads (read-index/lease, §15) force the leader to CONFIRM it
    still has majority support before answering → a zombie leader fails the
    check and stops serving reads.
  - A LEASE (with clock bound) causes the old leader to stop serving once its
    lease can't be renewed.

Chaos test to validate this:
  Use iptables to create a ONE-WAY partition on the leader (drop inbound acks).
  Expected: client writes to the old leader time out (never falsely succeed);
  a new leader is elected on the majority side; no acked write is lost; the old
  leader stops serving reads within its lease/read-index window.
```

**The architect's line:** the dangerous case is never the clean 50/50 split (that's textbook) — it's the *partial* / *asymmetric* / *slow* partition where a node is "mostly working." Your safety must come from the *inability to reach a majority*, not from any node correctly self-diagnosing that it's isolated.

---

## 11. Coordination Services: ZooKeeper, etcd, Consul

### 🟢 Beginner — The Town Hall Everyone Trusts

Instead of every group building its own voting system, a town builds one trusted town hall. Need to pick a leader? Ask the hall. Need to claim the only fishing license? Ask the hall. Need the official copy of the rules? Read them at the hall. The hall itself is run by a small council that votes internally so it never gives two different answers. Everyone else just *uses* it. ZooKeeper, etcd, and Consul are that town hall.

---

### 🟡 Senior — Same Idea, Different Protocols

| Service | Consensus / broadcast | Data model | Signature uses | Membership/health |
|---|---|---|---|---|
| **ZooKeeper** | ZAB (atomic broadcast) | Hierarchical znodes | Locks, election, config; Kafka (historically), HBase, Hadoop | Sessions + heartbeats |
| **etcd** | Raft | Flat KV (revisions) | Kubernetes' entire state store, discovery, election, config | Leases + keepalive |
| **Consul** | Raft (consistent KV/catalog) | KV + service catalog | Service discovery, health checks, KV config, mesh | **SWIM-style gossip** for scale |

```
Key architectural distinctions to state in an interview:

  ZAB ≠ Paxos: ZooKeeper Atomic Broadcast is a primary-backup atomic broadcast
  protocol tailored to ZooKeeper. It shares the majority-quorum idea but is its
  own algorithm.

  etcd = "Raft in production": the reference implementation people study.
  Kubernetes stores ALL cluster state in etcd → etcd health == cluster health.

  Consul deliberately SPLITS concerns:
    - strong-consistency data (KV, catalog) → Raft (a small server quorum)
    - large-scale failure detection/membership → gossip (SWIM-based), which
      scales to thousands of agents WITHOUT each one paying consensus cost.
```

---

### 🔴 Architect — Sizing, Blast Radius, and the Kafka/KRaft Story

```
Sizing the consensus quorum:
  - Run an ODD number of SERVER (voting) members: 3 (tolerate 1) or 5
    (tolerate 2). Rarely 7 (tolerate 3) — writes get slower as the quorum grows.
  - Do NOT scale the voting quorum for read throughput. Instead:
      ZooKeeper: observers (non-voting) absorb reads.
      etcd: linearizable reads go through the leader; serializable (possibly
            stale) reads can hit followers.
      Consul: many gossip agents, few Raft servers; use stale reads for scale.

Blast radius:
  - Kubernetes: if the etcd quorum loses majority, the control plane can't
    accept changes (existing pods keep running, but you can't schedule/update).
    → etcd availability is a first-class SLO; back it up (snapshots) regularly.

Real production story — Kafka's move OFF ZooKeeper:
  For years Kafka used ZooKeeper for controller election and cluster metadata.
  Operating a SECOND distributed system (ZK) alongside Kafka was a top
  operational complaint, and metadata scaled poorly. Kafka introduced KRaft
  (KIP-500): a built-in Raft-based metadata quorum that removes the ZooKeeper
  dependency, letting Kafka self-manage its metadata. The lesson: one
  well-run consensus quorum beats bolting on a second distributed system.
```

**Guardrails to cite:** dedicated fast disks for the consensus data dir; keep the store SMALL (it's a control plane, not a database); monitor quorum health, leader stability (term-change rate), and fsync latency; take regular snapshots so you can rebuild the quorum after catastrophic loss.

---

## 12. Recipe: Leader Election, Locks, and Leases

### 🟢 Beginner — The Numbered Deli Ticket

At a busy deli, you pull a numbered ticket. Whoever holds the lowest number is served next. If that person leaves, the next-lowest is up — automatically, no argument, because the numbers give a clear order. Coordination services do exactly this for leadership: each candidate grabs a numbered ticket, lowest number leads, and if the leader leaves, the next number takes over.

---

### 🟡 Senior — Two Canonical Recipes

**Recipe 1 — Ephemeral sequential nodes (ZooKeeper-style):**

```python
def campaign(zk, path="/election"):
    me = zk.create(f"{path}/n_", ephemeral=True, sequential=True)  # e.g. n_0000000007
    while True:
        kids = sorted(zk.get_children(path))
        i = kids.index(basename(me))
        if i == 0:
            return "LEADER"                       # lowest sequence number wins
        pred = kids[i - 1]                          # watch ONLY the predecessor
        if zk.exists(f"{path}/{pred}", watch=True): # avoids the herd effect
            wait_for_deletion_event()
        # predecessor gone → loop and re-check whether I'm now lowest
```

Ephemeral = the znode vanishes when the creator's session ends (crash/timeout) → automatic failover. Watching only the predecessor means one death wakes exactly one node, not all N.

**Recipe 2 — Lease + fencing token (etcd/lock-service style, storage-agnostic sketch):**

```typescript
// Depends on the store providing an ATOMIC compare-and-set (etcd revisions /
// ZooKeeper versions provide this). fencingToken is the safety mechanism.
async function tryAcquire(kv: KV, nodeId: string, ttlMs: number): Promise<Lease | null> {
  const now = Date.now();
  const current = await kv.get("leader");
  if (current && current.expiresAt > now) return null;      // valid holder exists
  const fencingToken = (current?.fencingToken ?? 0) + 1;    // monotonic, never reused
  const ok = await kv.compareAndSet("leader", current, {    // atomic CAS
    nodeId, fencingToken, expiresAt: now + ttlMs,
  });
  return ok ? { nodeId, fencingToken, expiresAt: now + ttlMs } : null;
}
```

| Recipe | Failover trigger | Herd control | Safety mechanism |
|---|---|---|---|
| Ephemeral sequential | Session/ephemeral node expiry | Watch predecessor only | Total order via sequence number |
| Lease + fencing | Lease TTL expiry | N/A (single key CAS) | Fencing token enforced downstream |

---

### 🔴 Architect — The Fencing Token Is Non-Negotiable

```
The failure a lock ALONE cannot prevent (GC-pause double writer):
  t=0   Client1 acquires lock (TTL 10s), token=33
  t=1   Client1 enters a 30s STOP-THE-WORLD GC pause (frozen, not dead)
  t=10  lease expires → Client2 acquires lock, token=34
  t=11  Client2 writes to storage with token=34  (accepted)
  t=31  Client1 wakes, STILL thinks it holds the lock, writes with token=33
        → storage sees 33 < last-seen 34 → REJECTED. Corruption prevented.

Why the resource, not the client, must enforce it:
  You can NEVER guarantee a client won't freeze between "check lock" and "do
  work" — any process can pause at any instruction. So you make the EFFECT
  safe: the downstream resource remembers the highest token it has honored and
  rejects anything older. A lock without fencing is advisory only.
```

**Tradeoff: TTL vs failover speed vs false failover.** A short TTL frees a dead leader's lock fast but risks expiring a merely-slow client (needless failover). A long TTL avoids false positives but strands the lock when a holder truly dies. Set TTL > worst realistic pause (GC, IO stall) and rely on fencing tokens to make the *overlap window* safe rather than trying to make TTL perfect. This exact problem is the canonical argument (popularized by Martin Kleppmann) for why "a distributed lock" is not, by itself, sufficient for correctness.

---

## 13. Quorum Math and Cluster Sizing

### 🟢 Beginner — You Need More Than Half to Decide

In a club of 5, you need at least 3 to pass any motion. Why more than half? So two different groups can never each pass conflicting motions at the same time — any two "more-than-half" groups must share at least one member, and that member won't vote for both sides. That shared-member guarantee is the whole reason majority voting is safe.

---

### 🟡 Senior — The Formulas and the Table

```
Quorum (majority)     = ⌊N/2⌋ + 1
Failures tolerated    = N − quorum = ⌊(N−1)/2⌋
```

| N | Quorum | Failures tolerated | Notes |
|---|---|---|---|
| 1 | 1 | 0 | No fault tolerance |
| 2 | 2 | 0 | Worse than 1: needs BOTH up |
| 3 | 2 | 1 | Smallest useful cluster |
| 4 | 3 | 1 | Same tolerance as 3, higher cost |
| 5 | 3 | 2 | Common production default |
| 6 | 4 | 2 | Same tolerance as 5, higher cost |
| 7 | 4 | 3 | Diminishing returns |

```python
def sizing(n):
    q = n // 2 + 1
    return {"quorum": q, "tolerates": n - q}

sizing(3)   # quorum 2, tolerates 1
sizing(5)   # quorum 3, tolerates 2
```

**Why odd:** each jump from odd N to the next even N raises the quorum (slower writes, more to coordinate) without improving fault tolerance. Always pick 3, 5, or 7.

---

### 🔴 Architect — Sizing for Latency, Not Just Tolerance

```
More voters ≠ better. The quorum size sets your WRITE latency floor:
  every commit waits for the ⌊N/2⌋+1-th fastest ack (including the leader).
  N=3 waits for the 2nd-fastest; N=7 waits for the 4th-fastest → longer tail.

Sizing decisions:
  - Default to 3 for most services (tolerate 1 node/1 AZ loss).
  - Use 5 when you need to tolerate 2 simultaneous failures (e.g., one node
    down for maintenance AND still survive a second failure), or to spread
    across more failure domains.
  - Avoid 7+ unless you truly need to survive 3 failures; the write-latency and
    membership-management cost rarely pays off.

Failure-domain placement (critical):
  Counting nodes is not enough — count INDEPENDENT failure domains. Five nodes
  in ONE availability zone tolerate 2 NODE failures but ZERO AZ failures.
  Spread the N members across AZs so a whole-AZ loss still leaves a majority:
    5 nodes as 2+2+1 across three AZs survives losing any one AZ.

Scaling reads without touching the voting quorum:
  Add non-voting learners/observers (ZooKeeper observers, etcd learners) that
  receive the log and serve reads but DON'T count toward quorum → read scale
  without slowing writes.
```

**The architect's rule:** cluster size is a fault-tolerance AND latency AND failure-domain decision at once. State all three when you justify "why 5 nodes across 3 AZs" in a design review.

---

## 14. Membership Changes Without Split-Brain

### 🟢 Beginner — Don't Swap the Whole Committee at Once

If a 3-person committee wants to become a different 3-person committee, they can't all resign and appoint replacements in the same instant — for a moment nobody's sure who's in charge, and two rival sub-groups might each think they're the real committee. Instead they add or remove one member at a time, so there's always a clear, overlapping majority who knows the current roster.

---

### 🟡 Senior — The Disjoint-Majority Hazard and Joint Consensus

```
DANGER — swapping C_old → C_new in one step:
  C_old = {A,B,C}   C_new = {C,D,E}
  Nodes adopt the change at slightly different times:
    {A,B} still on C_old → their majority (2/3) elects Leader1
    {D,E} already on C_new → their majority (2/3) elects Leader2
  {A,B} and {D,E} are DISJOINT → two leaders → split-brain.

FIX 1 — Joint consensus (Raft's general two-phase change):
  Phase 1: commit a joint config C_old,new. During it, EVERY decision needs a
           majority of C_old AND a majority of C_new simultaneously.
  Phase 2: commit C_new alone.
  Since every decision overlaps BOTH configs, no two disjoint majorities exist.

FIX 2 — Single-server change (simpler, common in practice):
  Add or remove ONE node at a time. Adjacent configs differ by one member, so
  their majorities always overlap → no disjoint-majority window.
```

| Approach | Handles | Complexity |
|---|---|---|
| Joint consensus | Arbitrary config change (swap many at once) | Higher (two-phase bookkeeping) |
| Single-server change | One add/remove at a time | Lower (used by etcd, Consul, CockroachDB) |

---

### 🔴 Architect — Learners, Catch-Up, and the Safe Growth Runbook

```
Growing 3 → 5 safely (single-server, with learners):

  1. Add node D as a LEARNER (non-voting). It streams the log / a snapshot to
     catch up WITHOUT counting toward quorum. (If you counted an empty node
     toward quorum immediately, a failure could lose committed data.)
  2. Once D is caught up, PROMOTE it to voter → cluster is {A,B,C,D}, quorum 3,
     still tolerates 1.
  3. Add node E as a learner; let it catch up; promote → {A,B,C,D,E}, quorum 3,
     tolerates 2.
  Fault tolerance actually improves only at step 3 (reaching N=5).

What goes wrong if you skip learners / add both at once:
  - Empty new members counted toward quorum raise the ack bar before they hold
    any data → a couple of failures right after can lose committed entries.
  - A big-bang membership swap risks the disjoint-majority split-brain (above).

Real systems:
  etcd:        `etcdctl member add --learner`, then `member promote`.
  CockroachDB: adds replicas as non-voting, snapshots them, then promotes.
  Consul:      autopilot manages non-voting/staging and safe promotion.

Removing nodes: remove voters one at a time too; never drop below a majority of
the CURRENT config, and remember removing a node LOWERS the quorum threshold —
which is usually what you want when decommissioning.
```

**The architect's checklist for any membership change:** one node at a time, new nodes catch up as learners first, never create a window with two possible majorities, and verify quorum health before and after each step.

---

## 15. Read Optimizations and Geo-Distributed Consensus

### 🟢 Beginner — Proving You're Still the Boss Before Answering

If you've been out of the room, before you confidently answer "the latest decision is X," you should double-check you're still the boss and haven't missed anything. But constantly double-checking is slow. So the team gives the boss a short "you're definitely still boss until 3:05" guarantee — within that window the boss can answer instantly. After it, they check again. That's the trade between always-verifying (slow, always correct) and trusting a short guarantee (fast, correct only if clocks agree).

---

### 🟡 Senior — Lease Reads vs Read Index

A linearizable read must not return data older than the latest committed write. Three options, cheapest-last:

```
1. Read through the log: append a read as a log entry, wait for commit.
   Correct, slowest (full commit round-trip).

2. Read Index:
   - Leader notes its commitIndex as the read index.
   - Leader exchanges ONE heartbeat round with a majority to confirm it's still
     leader (nobody's on a higher term).
   - Leader waits until its state machine applied up to the read index, then
     answers locally.
   → One majority round-trip, NO log write, NO clock assumption.

3. Lease Read:
   - Leader holds a lease: "guaranteed leader until time T" (followers promised
     not to elect anyone before T).
   - While clock now < T − safety_margin, leader answers reads LOCALLY, zero RTT.
   → Fastest; correctness depends on BOUNDED CLOCK DRIFT.
```

| Method | Cost/read | Assumption | Failure risk |
|---|---|---|---|
| Through-log | Full commit RTT | None | Slow |
| Read index | 1 majority RTT | Majority reachable | None beyond availability |
| Lease read | 0 (local) | Bounded clock skew | Stale read if clock drifts past margin |

**Tradeoff: read latency vs a clock assumption.** The lease read swaps a network round-trip for trust in clock bounds. If a leader's clock is slow/paused, it may serve a stale read after a new leader was already elected. Read index avoids the clock dependency for one round-trip. Also recall (§8): a freshly elected leader must commit+apply a no-op in its term before *any* of these reads are safe.

---

### 🔴 Architect — Geo-Distributed Consensus: Many Small Groups

```
ANTI-PATTERN: one global consensus group over ALL data across continents.
  Every commit needs a cross-continent majority → ~inter-region RTT per write.

PATTERN (Spanner, CockroachDB): shard data into ranges; each range is its OWN
consensus group; place each group's leader/leaseholder near its data's users.

  ┌─────────── us-east ───────────┐   ┌─────────── eu-west ───────────┐
  │ Range R1 (US users)           │   │ Range R2 (EU users)           │
  │  Raft group: us-east 1a/1b/1c │   │  Raft group: eu-west 1a/1b/1c │
  │  leader/leaseholder in us-east│   │  leader/leaseholder in eu-west│
  │  → US writes commit LOCALLY   │   │  → EU writes commit LOCALLY   │
  └───────────────────────────────┘   └───────────────────────────────┘
  Cross-region cost paid ONLY for cross-range/cross-region transactions.
```

```
Spanner:      Paxos group per shard + TrueTime (a clock API that returns an
              uncertainty interval). It waits out that interval to assign
              globally-ordered commit timestamps WITHOUT a global consensus
              round on every write.
CockroachDB:  Raft group per range; a per-range LEASEHOLDER serves reads and
              coordinates writes, placed near the accessing region; supports
              lease reads for local linearizable reads.

Placement levers an architect pulls:
  - Pin a range's leaseholder to the region that reads/writes it most.
  - Keep a local majority of replicas in the primary region for fast commits;
    put extra replicas elsewhere for disaster tolerance.
  - Partition the schema so the COMMON transaction stays within one region's
    ranges (avoid cross-region 2-phase commits on the hot path).
```

**Tradeoff: data locality vs cross-shard transactions.** Per-shard groups make single-shard, single-region operations fast, but a transaction spanning shards in different regions must coordinate across groups (two-phase commit over their leaders) and pays cross-region latency. You design partitioning so cross-region transactions are the exception, not the rule.

---

## 16. When NOT to Use Consensus

### 🟢 Beginner — Not Every Decision Needs a Committee

If two people independently add items to a shared shopping list, you don't need a committee vote — you just merge both lists; nothing is lost. But if two people try to spend the same $100, you *do* need a single authority, because "merging" a double-spend is nonsense. Use a committee (consensus) only for decisions where two answers can't be safely combined.

---

### 🟡 Senior — The Litmus Test and the Alternatives

```
LITMUS TEST:
  "If two replicas make different decisions during a partition, can I MERGE
   them automatically and correctly later?"
     YES → you don't need consensus (use CRDTs / eventual consistency).
     NO  → you need consensus (one leader, one lock, one balance, one order).
```

| Workload | Use instead of consensus | You give up | You keep |
|---|---|---|---|
| Counters, sets, presence, collaborative text — mergeable ops | **CRDTs** | A single global order (linearizability) | Availability everywhere; deterministic convergence |
| Huge-scale KV where partition-time availability > strict consistency | **Dynamo-style leaderless quorums** (tunable N/W/R, hinted handoff) | Strong consistency (reads can be stale) | Always-writable, high availability |
| Immutable/append-only data, idempotent writes | Simple replication / log shipping | Coordination guarantees you don't need | Simplicity, throughput |

```
Example CRDT: a G-Counter (grow-only counter).
  Each replica keeps a per-replica count; the value = SUM of all entries;
  merge = element-wise MAX. Concurrent increments on both sides of a partition
  both survive and converge — no coordination, no consensus, no lost updates.
```

**Named tradeoff: coordination cost vs consistency.** Consensus gives one authoritative order at the price of a majority round-trip per write and minority unavailability under partition. CRDTs/eventual consistency stay cheap and available everywhere but only promise *convergence*, not a single order. Match the tool to whether "two answers" is mergeable or catastrophic.

---

### 🔴 Architect — Hybrid Architectures: Consensus for the Core, Eventual for the Bulk

```
The mature large-scale design is almost always HYBRID:

  CONSENSUS (small, critical, must-be-single-valued):
    - Who is the leader/primary for each shard
    - Shard → node routing/placement map
    - Cluster membership, config, feature flags
    - Distributed locks / leases / unique-ID allocation

  EVENTUAL / LEADERLESS (large, high-volume, mergeable or idempotent):
    - Bulk application data behind those leaders
    - Caches, analytics, telemetry, presence
    - Multi-region user data with CRDT/last-writer-wins where acceptable

Why: consensus caps throughput at majority-round-trip speed and makes the
minority unavailable under partition. You confine that cost to the tiny core
that truly needs one answer, and let everything else run cheap and available.
```

**Real-world shape:** Kubernetes keeps *cluster state* in etcd (consensus) while running *workloads* never touch etcd per request. Dynamo-lineage stores (Cassandra, DynamoDB) run the *data plane* leaderless/eventually-consistent, and reach for consensus/lightweight-transactions only for the rare operation that needs it. The architect's skill is drawing that line: **shrink the set of facts that need global agreement to the smallest possible core, and keep consensus off the hot path.**

---

## Quick Recall Cheat Sheet

> Close this file. Try to answer these from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Consensus goal | Agree on one ordered log of decisions despite crashes and message loss; never disagree later |
| Split-brain | Two nodes both act as leader/owner → two authoritative histories → no safe merge |
| Single-coordinator flaw | SPOF + can't tell frozen (GC) from dead → unsafe failover |
| Replicated state machine | Same start + same ordered commands + deterministic apply ⇒ identical replicas |
| Log is the primitive | Agreeing on "entry at slot i" is clean consensus; replicating raw state isn't |
| Determinism rule | Compute NOW()/random on the leader; log the concrete value, not the generator |
| Paxos roles/phases | Proposer/Acceptor/Learner; Prepare-Promise then Accept-Accepted; majority chooses |
| Majority intersection | Any two majorities share ≥1 node → carries the chosen value forward → safety |
| Paxos safety rule | A new proposer must reuse the highest previously-accepted value |
| Multi-Paxos win | Stable leader skips Phase 1 → 1 round-trip/entry instead of 2 |
| Why Paxos is hard | Basic Paxos = one value; real log needs leader, gap-filling, membership, snapshots |
| Raft goal | Understandability; decomposed into election + replication + safety |
| Raft term | Monotonic logical clock; ≤1 leader/term; higher term demotes a stale node |
| Raft commit | Committed once on a majority; leader acks client only after commit+apply |
| Log Matching | Same index+term ⇒ identical command and identical prefix; enforced by prevLogIndex check |
| AppendEntries reject | Leader decrements nextIndex and retries backward until logs agree |
| Election restriction | Refuse a vote to a less up-to-date candidate → new leader has all committed entries |
| Leader Completeness | A new leader's log contains every committed entry (no backfill needed) |
| Commit-in-current-term | A leader commits prior-term entries only via a current-term entry (Fig-8 rule) |
| New-leader no-op | Commit+apply a no-op in the new term before serving reads → avoids stale reads |
| FLP (1985) | No deterministic async algorithm guarantees termination with 1 crash; keep safety, relax liveness |
| Two Generals | No certain agreement over a lossy channel in finite messages (network fault) |
| Timeouts vs safety | Timeouts affect liveness only; a wrong timeout must never cause two leaders |
| Randomized timeouts | Prevent repeated split votes / election livelock |
| Partition rule | Only the majority side makes progress; minority refuses writes (CP) |
| Zombie leader | Old leader can't reach majority → can't commit; read-index/lease stops its stale reads |
| ZooKeeper/etcd/Consul | ZAB / Raft / Raft(+SWIM gossip); town-hall coordination services |
| Kafka KRaft | Kafka replaced ZooKeeper with a built-in Raft metadata quorum (KIP-500) |
| Ephemeral-node election | Lowest sequential znode = leader; watch only predecessor to avoid herd effect |
| Session/lease | Time-bounded liveness token; expiry auto-releases locks/leadership → enables failover |
| Fencing token | Monotonic number enforced at the RESOURCE; rejects a woken stale lock holder |
| Quorum formula | ⌊N/2⌋+1; failures tolerated = N − quorum; use odd N (3, 5, 7) |
| Why 2 nodes is bad | Quorum 2, tolerates 0, needs BOTH up → worse than 1 node |
| Failure domains | Count independent domains, not just nodes; spread across AZs (e.g., 2+2+1) |
| Membership change | One node at a time or joint consensus → never two disjoint majorities |
| Learners | New nodes catch up as non-voting learners before counting toward quorum |
| Lease read vs read index | Lease = local/zero-RTT/trusts clock; read index = one majority RTT/no clock assumption |
| Geo consensus | Per-shard Raft/Paxos groups, leaseholder near the data (Spanner, CockroachDB) |
| Keep off hot path | Consensus for leadership/routing/config; data plane replicates cheaply, hits leader directly |
| When NOT to use it | Mergeable/eventual data → CRDTs or Dynamo-style; give up global order, keep availability |
| Disk fsync | Consensus commit latency tracks fsync; give the log dedicated fast SSD/NVMe |
