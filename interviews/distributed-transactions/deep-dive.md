# Deep Dive: Distributed Transactions & Consistency

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> Code is illustrative pseudocode / TS / SQL. Verify exact vendor APIs against current docs.

---

## Table of Contents

1. [The Problem: Why Local ACID Doesn't Cross Boundaries](#1-the-problem-why-local-acid-doesnt-cross-boundaries)
2. [The Dual-Write Problem](#2-the-dual-write-problem)
3. [CAP Theorem — Stated Correctly](#3-cap-theorem--stated-correctly)
4. [PACELC — The Everyday Tradeoff](#4-pacelc--the-everyday-tradeoff)
5. [The Consistency Models Spectrum](#5-the-consistency-models-spectrum)
6. [Client-Centric (Session) Guarantees](#6-client-centric-session-guarantees)
7. [Two-Phase Commit (2PC)](#7-two-phase-commit-2pc)
8. [The Blocking Problem and 3PC](#8-the-blocking-problem-and-3pc)
9. [The Saga Pattern](#9-the-saga-pattern)
10. [Saga Isolation and Countermeasures](#10-saga-isolation-and-countermeasures)
11. [Transactional Outbox and CDC](#11-transactional-outbox-and-cdc)
12. [Idempotency and "Exactly Once"](#12-idempotency-and-exactly-once)
13. [Isolation Levels and Anomalies](#13-isolation-levels-and-anomalies)
14. [Concurrency Control: MVCC, OCC, and 2PL](#14-concurrency-control-mvcc-occ-and-2pl)
15. [Spanner, Percolator, and Redesigning Boundaries](#15-spanner-percolator-and-redesigning-boundaries)
16. [Failure Modes and Observability](#16-failure-modes-and-observability)
17. [Anti-Patterns to Name and Avoid](#17-anti-patterns-to-name-and-avoid)
18. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Problem: Why Local ACID Doesn't Cross Boundaries

### 🟢 Beginner — The Two Separate Bank Tellers

Imagine you want to move $100 from your account at Bank A to a friend's account at Bank B. Inside Bank A, a single teller can take $100 out of your account and log it in one motion — if anything goes wrong, they tear up the slip and nothing happened. That's a local transaction: one ledger, one clerk, all-or-nothing.

But Bank A's teller cannot reach into Bank B's vault. Two banks, two ledgers, two clerks who can't see each other's books. Now "take from A and add to B, all-or-nothing" is genuinely hard: what if A's clerk finishes but B's clerk drops the slip? The money vanished. Distributed transactions are the whole science of making two clerks who can't see each other's books still agree on "both or neither."

---

### 🟡 Senior — Where the Guarantee Ends

A database transaction's ACID guarantees are enforced by **one engine with one write-ahead log and one commit record**. `COMMIT` means "the log record is durably on disk"; recovery replays that one log. There is exactly one authority.

```
Single DB (works):
  BEGIN
    UPDATE accounts SET bal = bal - 100 WHERE id = 'A'
    UPDATE accounts SET bal = bal + 100 WHERE id = 'B'
  COMMIT            # one log, one fsync, one decision -> atomic

Two DBs (no shared authority):
  dbA.commit(bal -= 100)   # dbA's log says committed
  dbB.commit(bal += 100)   # dbB's log — separate; may fail independently
  # there is no single log/record that covers both
```

| Property | Single DB | Two DBs |
|---|---|---|
| Atomicity | Free (one commit record) | Needs 2PC or Saga |
| Isolation | Free (one lock manager) | No cross-DB locks |
| Durability | Per engine | Per engine (independent) |
| Consistency (invariants) | Enforced by constraints | Application must span both |

The instant you have two logs, you need a **protocol** to make them agree. That protocol is either blocking-but-atomic (2PC) or available-but-eventually-consistent (Saga).

---

### 🔴 Architect — The Cost You're Actually Signing Up For

When someone says "make it transactional across services," translate it into the bill:

```
Distributed atomicity costs (pick your poison):
  2PC  -> availability tax:  coordinator/participant failure can block + hold locks
                              effective hot-row throughput ~ 1 / lock_hold_time
  Saga -> consistency tax:   no isolation; other txns see half-finished state;
                              you must design + test compensations for every step

Failure mode to raise in a design review:
  "What happens to in-flight cross-service transactions when service X
   is deploying / GC-pausing / partitioned for 20 seconds?"
  - 2PC answer: they block, locks pile up, dependent requests queue -> collapse
  - Saga answer: they pause mid-flow; state machine resumes on recovery (if durable)
```

**What Google did:** even Google, which *can* build a globally consistent database (Spanner), still tells internal teams to prefer single-Paxos-group (single-shard) transactions and avoid cross-shard 2PC on hot paths, because cross-shard commit-wait + 2PC latency is real. The lesson: distributed atomicity is a tool of last resort, not a default.

---

## 2. The Dual-Write Problem

### 🟢 Beginner — Mailing a Letter and Updating Your Diary

You decide "I paid rent." You write it in your diary, then you go mail the cheque. But between writing in the diary and reaching the mailbox, you get distracted and never mail it. Your diary says "paid," reality says "not paid." Or you mail it first, then forget to write it down — now you think you still owe rent and pay twice.

The problem: two records of the same fact (your diary and the mailbox) that you update one at a time. Any interruption between them and they disagree — permanently, because neither knows the other failed.

---

### 🟡 Senior — Why No Ordering Is Safe

The dual-write problem appears whenever one logical action must update **two systems that can't share a commit** — classically a database and a message broker.

```
Order 1: DB then publish
  db.insert(order)         # ✅ committed
  broker.publish(event)    # ❌ crash here -> order exists, no event ever fires

Order 2: publish then DB
  broker.publish(event)    # ✅ sent
  db.insert(order)         # ❌ fails -> consumers act on a nonexistent order

Order 3: "just retry"
  retry publish after crash -> may double-publish (consumer sees duplicate)
  retry DB after publish    -> may double-insert
```

| "Fix" | Why it fails |
|---|---|
| DB then publish | Crash after commit → event lost |
| Publish then DB | DB failure → event references nothing |
| Retry either | Reintroduces duplicates (no idempotency) |
| 2PC between DB and broker (XA) | Blocking, poor broker support, operationally fragile |

The only robust fix is to make the second write **derive atomically from the first**: write the event into the **same DB transaction** (outbox, §11), then ship it asynchronously with at-least-once + idempotent consumers.

---

### 🔴 Architect — Detecting Silent Divergence

Dual-write bugs are insidious because they're **silent** — no error is thrown; two systems just quietly disagree. You detect them with reconciliation, not exceptions.

```
Reconciliation job (runs continuously):
  every N minutes:
    db_orders   = SELECT id FROM orders WHERE created_at > t-Δ
    emitted     = events seen on the OrderPlaced topic in the same window
    missing     = db_orders - emitted        # committed but never published
    orphan      = emitted  - db_orders        # published but no DB row
    alert if |missing| > 0 or |orphan| > 0

Grafana alert intuition:
  rate(orders_committed) - rate(events_published)  should hover near 0
  sustained gap > threshold for 5m -> page: "dual-write divergence"
```

**Real-world framing:** this is precisely the class of bug that pushed the industry toward the **outbox pattern and log-based CDC (Debezium)**. Rather than *detecting* divergence after the fact, you make divergence *structurally impossible* by giving the event and the row a single commit. A senior candidate names the reconciliation job as a safety net but insists the real fix is architectural.

---

## 3. CAP Theorem — Stated Correctly

### 🟢 Beginner — Two Clerks and a Cut Phone Line

Two shops share one stock ledger, kept in sync by phone. The phone line gets cut (a "partition"). A customer wants the last item at shop 1. The clerk has two choices:

1. **Refuse to sell** until the phone line is back and they can confirm shop 2 hasn't sold it — safe, but the customer is turned away (chose **Consistency**, gave up **Availability**).
2. **Sell it anyway** and hope shop 2 didn't — the customer is happy, but maybe you just sold the same item twice (chose **Availability**, gave up **Consistency**).

You can't have both while the line is cut. That's CAP. And notice: **when the phone works, you have both.** The dilemma only exists during the outage.

---

### 🟡 Senior — The Precise Statement and the Big Misconception

**CAP (Brewer conjecture 2000; Gilbert & Lynch proof 2002):** in an asynchronous network, a store cannot simultaneously guarantee **C**onsistency (linearizability), **A**vailability (every request to a live node responds), and **P**artition tolerance.

```
THE MISCONCEPTION (wrong):  "pick 2 of {C, A, P}"
WHY IT'S WRONG:             P is not a design choice — the network causes partitions.
THE CORRECT FRAMING:        P is mandatory. DURING a partition, choose C or A.
                            With NO partition, you can have BOTH C and A.
```

| Label | Behavior during a partition |
|---|---|
| **CP** | Sacrifice availability: refuse/limit requests to stay consistent |
| **AP** | Sacrifice consistency: keep serving, possibly stale/divergent |
| **"CA"** | Not a real distributed system — a single node, or one that just dies on partition |

Also disentangle the two C's: **CAP's C is linearizability** (a replication-layer property), while **ACID's C is invariant preservation** (an application/constraint property). Interviewers love when you catch that.

---

### 🔴 Architect — Choosing C or A Per Operation, Not Per System

Mature systems don't pick CP or AP globally — they pick **per operation**, because different data has different needs.

```
Same product, different endpoints:
  GET  /product/{id}/likes     -> AP: stale count is fine, never fail
  POST /checkout/reserve-seat  -> CP: refuse rather than double-sell the last seat

Tunable stores make this explicit (e.g., quorum settings):
  read/write with strong quorum  -> CP behavior for that call
  read/write with low quorum     -> AP behavior for that call
```

**What Amazon Dynamo did (2007 paper):** chose **AP** for the shopping cart — an "add to cart" must never fail, even during a partition. The price is that concurrent divergent carts are **merged (unioned) at read time**, which can resurrect a removed item. Amazon judged that acceptable for a cart and unacceptable for, say, a payment. The architect's job is to make that judgment per operation and state it out loud in the design review: *"This endpoint is AP because a stale read here is harmless; that one is CP because a stale read moves money."*

---

## 4. PACELC — The Everyday Tradeoff

### 🟢 Beginner — Waiting for Everyone to Confirm

You're planning dinner with three friends over text. To be *sure* everyone's coming, you wait until all three reply before booking — that's slow but certain. Or you book as soon as the first replies — fast, but maybe someone can't make it. Even when everyone's phone works fine (no outage), you're trading **speed for certainty** on every decision. That everyday trade — not the rare outage — is what PACELC adds to CAP.

---

### 🟡 Senior — The Else Branch Is the Point

**PACELC (Daniel Abadi, 2012):** *if* **P**artition → **A** vs **C**; **E**lse → **L**atency vs **C**onsistency.

CAP only speaks about the rare partition. PACELC's insight is the **else** branch: even in perfect health, synchronous replication for strong consistency costs latency, while async replication for low latency weakens consistency. That trade happens on every single request.

```
Write path, healthy network:
  Strong (EC): ack only after a quorum/majority of replicas persist  -> higher latency
  Fast   (EL): ack after the local/leader write; replicate async      -> lower latency, staler reads
```

| Classification | Partition behavior | Normal behavior | Illustrative system |
|---|---|---|---|
| **PC/EC** | Consistent | Consistent (slower) | Spanner |
| **PA/EL** | Available | Low latency (weaker) | DynamoDB/Cassandra (tuned that way) |
| **PC/EL** | Consistent | Low latency | Some MongoDB configs |
| **PA/EC** | Available | Consistent when healthy | Rare in practice |

(Labels depend on configuration — treat as illustrative.)

---

### 🔴 Architect — Latency Budgets Force the Choice

PACELC becomes concrete when you write down a latency budget and a replication topology.

```
Scenario: 3 replicas, one per region; RTT us-east<->eu-west ≈ 80ms

Strong write (majority ack across regions):
  commit latency ≈ RTT to the 2nd-closest replica ≈ tens of ms per write
  -> a synchronous cross-region strong write can't be a 5ms p99 operation. Physics.

Fast write (local ack, async replicate):
  commit latency ≈ local fsync (~1-2ms)
  -> but a read from another region may miss the last write (EL: weaker consistency)
```

**What Spanner accepts:** it is deliberately **PC/EC** — it *adds* latency (TrueTime commit-wait, ~2ε, a few ms) on every commit to guarantee external consistency. Google decided that predictable strong semantics were worth a few milliseconds for their transactional workloads. The architect's move: **don't apply one global answer.** Put counters/feeds on EL, put money/inventory on EC, and defend each with the latency budget. Blanket "strong everywhere" is a latency tax on data that never needed it.

---

## 5. The Consistency Models Spectrum

### 🟢 Beginner — The Group Chat Retelling

Three friends recount a party in a group chat. **Linearizable**: everyone's story matches the exact real-time order events happened — no disagreement, ever. **Sequential**: everyone agrees on *an* order that respects how each person experienced their own night, but it might not match the wall clock. **Causal**: everyone agrees that a reply came after the message it replied to, but unrelated jokes might be remembered in different orders. **Eventual**: after everyone stops talking, the stories finally match — but mid-conversation they can conflict.

---

### 🟡 Senior — Ordered from Strongest to Weakest

```
Strength:  Linearizable  >  Sequential  >  Causal  >  Eventual

Linearizable: effects appear instantly at one point, consistent with REAL time.
Sequential:   one global order respecting each client's program order (not real time).
Causal:       cause-before-effect preserved for all; concurrent ops may reorder.
Eventual:     if writes stop, replicas converge; no ordering meanwhile.
```

| Model | Real-time order? | Single global order? | Cost | Typical use |
|---|---|---|---|---|
| Linearizable | Yes | Yes | High (consensus/quorum) | Locks, leader election, money |
| Sequential | No | Yes | Medium | Rare in practice as a target |
| Causal | No | No (only causal) | Lower | Collaborative apps, comments/replies |
| Eventual | No | No | Lowest | Counters, feeds, caches, DNS |

The practical middle ground most large systems live in is **causal + session guarantees** (§6): far cheaper than linearizability, but avoids the jarring "reply before message" and "my own write vanished" bugs.

---

### 🔴 Architect — What Each Model Costs to Enforce

```
Enforcement mechanics & cost:
  Linearizable: every op through consensus (Raft/Paxos) or single-leader + sync quorum reads
                -> cross-node round trips on the critical path (latency + availability cost)
  Causal:       track causal metadata (version vectors / dependencies), deliver in causal order
                -> metadata overhead, but no global coordination
  Eventual:     async replication + conflict resolution (LWW / CRDTs)
                -> cheapest; must design merge/GC for tombstones

Capacity note: a linearizable register's throughput is bounded by the consensus group's
commit rate; you scale it by SHARDING (many groups), not by adding replicas
(replicas add durability/read-scale, not write throughput for one key).
```

**Failure mode to name:** teams reach for linearizability by default, then discover a single hot key is throttled by one consensus group's commit rate. The fix is either (a) shard the key space so no single group is hot, or (b) demote that data to causal/eventual if its semantics allow. Choosing the *weakest model that's still correct* for each data class is the architect's core consistency decision.

---

## 6. Client-Centric (Session) Guarantees

### 🟢 Beginner — Remembering Your Own Order at a Café

You tell the barista "oat milk, no sugar." Even if a different barista makes your next drink, you expect them to honor what you just said — you should never have to see your own instruction ignored. And your loyalty-points total should never jump *down* to an older number as you refresh the app. These "about *my* experience" promises are cheaper than making the whole café agree on everything — they only track *your* session.

---

### 🟡 Senior — The Four Guarantees and Their Fixes

These come from the session-guarantees work (Terry et al., Bayou, 1994). They constrain only a **single client's view**, so they're much cheaper than global linearizability.

| Guarantee | Prevents | Typical implementation |
|---|---|---|
| **Read-your-writes** | Your own write vanishing on refresh | Sticky routing to primary after a write; or read a version ≥ your last write |
| **Monotonic reads** | Values going backwards in time as you refresh | Pin the session to a replica, or track last-seen version |
| **Monotonic writes** | Your writes applied out of order | Order writes per session; replicas apply in issue order |
| **Consistent prefix** | Seeing effects before their causes (reply before message) | Deliver writes in a prefix-consistent order |

```
Read-your-writes via version token:
  POST /comment -> returns { version: 4823 }   # client remembers 4823
  GET  /comments?min_version=4823
       -> load balancer routes to a replica whose applied_version >= 4823
       -> guaranteed to include the client's own comment
```

---

### 🔴 Architect — Sticky Sessions and Their Failure Modes

Session guarantees are usually implemented with **stickiness** (route a user to the same replica) or **version tracking** — each has a failure mode.

```
Sticky-to-primary after write:
  Pro: simple read-your-writes
  Con: hot primary if many users just wrote; failover breaks stickiness

Version-token (read a replica >= V):
  Pro: scales reads across replicas
  Con: client must carry V; if all replicas lag > V -> read blocks or falls back to primary

Failure mode: replica far behind
  If a replica's replication lag > session window, read-your-writes silently breaks.
  Alert: replica_lag_seconds > read_your_writes_window  -> depage / route around replica
```

**Real-world framing:** read-your-writes is the single most common consistency requirement in web apps ("I posted, why isn't it there?"), and it's almost always solved with a **session guarantee, not global linearizability**. The architect's win is recognizing that the requirement is *per-session freshness*, priced in milliseconds of sticky routing, not a system-wide consensus upgrade priced in tail latency everywhere.

---

## 7. Two-Phase Commit (2PC)

### 🟢 Beginner — The Wedding Officiant

At a wedding, the officiant asks each partner, one at a time, "Do you take…?" That's phase one: collecting a "yes" from everyone. Only after *both* have said yes does the officiant declare "I now pronounce you married" — phase two, the decision, announced to all. If either had said "no," there's no marriage. Nobody is married until the officiant makes the single, final declaration. 2PC is that officiant for databases.

---

### 🟡 Senior — Protocol and State

```
Roles: 1 coordinator, N participants (each owns a resource/DB).

PHASE 1 — PREPARE:
  coordinator -> all: "prepare"
  each participant: do work, take locks, write PREPARE to durable log, reply YES/NO
                    after YES it is PREPARED: cannot unilaterally abort/commit; holds locks

PHASE 2 — DECIDE:
  if all YES: coordinator logs COMMIT, then -> all: "commit"
  if any NO:  coordinator logs ABORT,  then -> all: "abort"
  each participant: apply, log outcome, RELEASE LOCKS, ack
```

```python
# Coordinator state sketch
def two_phase_commit(participants, txn):
    votes = []
    for p in participants:
        votes.append(p.prepare(txn))          # phase 1
    if all(v == "YES" for v in votes):
        log("COMMIT", txn)                    # durable decision BEFORE telling anyone
        for p in participants: p.commit(txn)  # phase 2
        return "COMMITTED"
    else:
        log("ABORT", txn)
        for p in participants: p.abort(txn)
        return "ABORTED"
```

| Event | Who logs what | Locks |
|---|---|---|
| Participant votes YES | Participant logs PREPARE | Acquired, held |
| Coordinator decides | Coordinator logs COMMIT/ABORT | (still held at participants) |
| Participant applies decision | Participant logs outcome | **Released** |

---

### 🔴 Architect — Latency and Throughput Math

```
Commit latency ≈ prepare RTT + commit RTT + slowest participant fsync
             ≈ 2 × RTT + max_i(fsync_i)

Locks are held for the ENTIRE commit latency. So for a hot row:
  max throughput ≈ 1 / lock_hold_time

Example (illustrative):
  Same-DC RTT ≈ 0.5ms, fsync ≈ 1ms -> lock_hold ≈ 2ms -> hot row caps ~500 txn/s
  Cross-region RTT ≈ 60ms          -> lock_hold ≈ 120ms -> hot row caps ~8 txn/s
```

**What Spanner did:** it uses 2PC for cross-shard writes but layers each participant over a **Paxos group**, and it *co-locates* the transaction leader with the Paxos leader to cut round trips. Even so, Google's guidance is to keep transactions within a single Paxos group ("single-shard") whenever possible, precisely because cross-shard 2PC pays the latency above. The design-review takeaway: model lock-hold time × contention *before* proposing 2PC on a hot path — if it caps a hot row below your required QPS, 2PC is the wrong tool.

---

## 8. The Blocking Problem and 3PC

### 🟢 Beginner — The Officiant Faints

Back to the wedding. Both partners said "yes." Then, before the officiant can say "I pronounce you married," they faint. Now what? The couple can't declare themselves married (only the officiant can), and they can't walk away (they already said yes). Everyone stands frozen until the officiant wakes up. That frozen wedding party — holding everything in place — is 2PC's blocking problem.

---

### 🟡 Senior — Why Participants Can't Decide Alone

```
Timeline of the blocking scenario:
  P1, P2, P3 all vote YES (prepared, holding locks)
  Coordinator writes COMMIT to its log
  Coordinator CRASHES before sending "commit" to anyone
  -> P1, P2, P3 are prepared but undecided. They wait, holding locks.

Why they can't decide:
  - A prepared participant promised it CAN commit -> may not abort.
  - It wasn't told to commit -> may not commit (coordinator might have decided ABORT).
  - It can't safely ask peers: the coordinator may have told a now-unreachable node to commit.
```

3PC (Skeen, 1981) inserts a **pre-commit** phase so a recovering node can infer the outcome:

```
Prepare    -> votes
Pre-commit -> "all agreed; prepare to commit" (ack)   <-- new phase
Commit     -> "do it"

Recovery rule: if a node reached pre-commit, the decision was COMMIT -> non-blocking (fail-stop)
```

| | 2PC | 3PC |
|---|---|---|
| Phases | 2 | 3 |
| Blocking on coordinator crash | Yes | No (fail-stop model) |
| Round trips | 2 | 3 (more latency) |
| Safe under network partition | (blocks, but stays safe) | **Can split-brain** |

---

### 🔴 Architect — Why the Industry Skipped 3PC and Fixed the Coordinator Instead

```
3PC's fatal assumption: a SYNCHRONOUS network with bounded delay and NO partitions.
Real networks partition. Under a partition, 3PC can let two sides reach DIFFERENT
decisions (split brain) -> it trades blocking for INCONSISTENCY. Worse trade.

The real fix (used everywhere): make the COORDINATOR fault-tolerant.
  coordinator + its decision log = a Raft/Paxos replicated group
  -> coordinator crash: a follower takes over, reads the replicated decision, finishes.
  -> no indefinite block, no split brain.
```

**What real systems do:** Spanner replicates the transaction coordinator via Paxos; CockroachDB uses a **transaction record** replicated by Raft plus **write intents**, so a coordinator (gateway) failure doesn't strand the transaction — another node resolves it from the replicated record. This is why you almost never see 3PC in production: the industry chose *consensus-backed coordinators* over 3PC's fragile partition assumptions. In an interview, "I'd make the coordinator a Raft group rather than reach for 3PC" is the staff-level answer.

---

## 9. The Saga Pattern

### 🟢 Beginner — Booking a Whole Vacation

You book a flight, then a hotel, then a rental car — three separate companies, three separate confirmations. There's no magic "book the whole trip atomically" button. If the car company has nothing available, you don't get to un-ring the flight and hotel bells for free — you **cancel** them (maybe eating a fee). A saga is exactly this: do each booking one at a time, and if a later one fails, run the cancellations for the earlier ones.

---

### 🟡 Senior — Steps, Compensations, and the Orchestrator

**Saga (Garcia-Molina & Salem, 1987):** a sequence of local transactions `T1…Tn`, each with a compensating transaction `Ci` that semantically undoes `Ti`. There is no rollback — committed steps are undone by **new** offsetting transactions.

```python
# Orchestration-style saga with compensations
def place_order_saga(order):
    log = []
    try:
        charge_id = payment.charge(order);      log.append(("payment", charge_id))
        resv_id   = inventory.reserve(order);   log.append(("inventory", resv_id))
        order_id  = orders.create(order);       log.append(("orders", order_id))
        notify.send(order)                      # after pivot: retriable, not compensated
        return order_id
    except Exception:
        for step, ref in reversed(log):         # compensate in reverse
            compensate(step, ref)               # refund / release / cancel — idempotent
        raise
```

| | Orchestration | Choreography |
|---|---|---|
| Coordination | Central orchestrator | Event-driven, no center |
| Visibility | One place shows saga state | Flow spread across services |
| Coupling | Loose (services dumb) | Coupled via event contracts |
| Best for | Complex, many-step flows | Simple, few-step flows |
| Unique risk | Orchestrator must be HA | Cyclic/emergent event storms |

---

### 🔴 Architect — Durable Saga State and the Pivot

```
A saga MUST be a durable state machine, or a crash mid-flow leaves orphaned steps:
  - persist saga state after EVERY step and compensation
  - on restart, resume from the last durable state
  - compensations retried with backoff until success; terminal failures -> dead-letter + alert

Pivot transaction (the go/no-go point):
  [compensatable steps]  ->  [PIVOT]  ->  [retriable, non-compensatable steps]
   charge, reserve            confirm       send email, update search index
   (can be refunded/released) (commit)      (never undone; retried until done)
```

**What workflow engines exist for:** systems like Temporal, AWS Step Functions, and Netflix's Conductor-style engines exist precisely to make saga state **durable and resumable** so engineers stop hand-rolling fragile compensation code. The architect-level point: a saga isn't "just call services and catch exceptions" — it's a **durable, resumable state machine with idempotent compensations and a defined pivot**. Without durability, a crash between step 2 and its compensation leaks money or inventory forever.

---

## 10. Saga Isolation and Countermeasures

### 🟢 Beginner — Renovating While People Walk Through

You're renovating a house while tours are happening. Halfway through, one room has the old wallpaper stripped but no new paint. A visitor walks through and judges the house half-done — because it *is*, mid-renovation. A saga has the same problem: between steps, other people see a half-finished state. You either put up a "renovation in progress" sign (a semantic lock) or design the work so a half-state still looks acceptable.

---

### 🟡 Senior — The Missing "I" and How to Fake It

Sagas provide no isolation: each `Ti` commits immediately and is **visible before the saga completes**, so other transactions can read half-done state (a dirty read that may be compensated away).

```
The anomaly:
  T1 (charge) + T2 (reserve stock) commit -> another flow reads "reserved, pending"
  T3 fails -> C2 releases, C1 refunds -> the other flow acted on state that's now void
```

| Countermeasure | How it works | Cost |
|---|---|---|
| **Semantic lock** | Set a `PENDING` status flag; other txns see it and wait/refuse; commit or compensate clears it | App must honor the flag everywhere |
| **Commutative updates** | Use `balance += x` / `-= x` (order-independent) instead of `set` | Not all ops are commutative |
| **Reread / version file** | Before acting/compensating, re-read and verify unchanged (via version) | Extra read; retry on change |
| **Pessimistic view** | Reorder steps so the most-visible/hardest-to-compensate step runs last | Constrains step ordering |

```sql
-- Semantic lock example: readers must respect the PENDING flag
UPDATE seats SET status = 'PENDING', held_by = :saga_id WHERE id = :seat AND status = 'FREE';
-- other sagas see status != 'FREE' -> they skip this seat until it's CONFIRMED or released
```

---

### 🔴 Architect — Testing Saga Isolation Failures with Chaos

```
Chaos scenarios every saga design must survive:
  1. Kill the orchestrator between T2 and T3
     -> on restart, saga resumes; no double-charge, no leaked reservation
     Pass: exactly one charge, reservation eventually released if T3 never succeeds

  2. Duplicate-deliver the "reserve stock" command (at-least-once)
     -> idempotent reserve (keyed by saga_id) reserves once
     Pass: stock decremented exactly once

  3. Compensation fails repeatedly (payment gateway down 30 min)
     -> ret/backoff; after N tries -> dead-letter + page; saga marked NEEDS_ATTENTION
     Pass: no silent money loss; operator can replay

  4. Concurrent saga reads PENDING state (isolation gap)
     -> semantic lock makes the second saga skip/wait
     Pass: no double-allocation of the same unit
```

**Failure mode to name in review:** the **"dirty read → business decision"** chain — e.g., a loyalty-points service reads a not-yet-final order and awards points, then the order's payment step compensates. Without a semantic lock (`PENDING` status the points service honors), you've minted points for a cancelled order. Sagas trade isolation for availability; the countermeasures are how you buy back *just enough* isolation where it matters.

---

## 11. Transactional Outbox and CDC

### 🟢 Beginner — One Envelope for Two Letters

Instead of writing your diary and separately mailing a cheque (two acts that can desync), you put both the diary note *and* the outgoing cheque into a single sealed box that you either seal-and-store completely or not at all. Later, a mail carrier opens the box and mails whatever's inside. Because both went into one box in one motion, they can never disagree — and the carrier can retry mailing safely.

---

### 🟡 Senior — Outbox Mechanics and CDC

Write the event into an **outbox table in the same local transaction** as the business change; a relay publishes it afterward (at-least-once).

```sql
BEGIN;
  INSERT INTO orders (id, status) VALUES ('o1', 'PLACED');
  INSERT INTO outbox (id, topic, payload, sent)
    VALUES ('e1', 'OrderPlaced', '{"orderId":"o1"}', false);
COMMIT;   -- row + event: one atomic commit. No dual-write.
```

```
Two ways to ship the outbox:
  A) Polling relay:  SELECT * FROM outbox WHERE sent=false; publish; mark sent
  B) CDC log-tail:   Debezium reads WAL/binlog, streams committed rows to Kafka
```

| | Polling relay | CDC (log tailing) |
|---|---|---|
| Latency | Poll interval | Near real-time |
| DB load | Extra queries | Reads the log the DB already writes |
| Ordering | Query order | Exact commit order |
| Ops | Simple app code | Operate a connector; handle schema drift |
| Pick when | Modest volume, simplicity | High volume, low latency |

Either way the DB↔event divergence is gone; the remaining relay→broker hop is **at-least-once**, so consumers must be idempotent (§12).

---

### 🔴 Architect — Ordering, Duplicates, and the "Outbox Lag" Alert

```
Guarantees & gotchas:
  - At-least-once publish -> DUPLICATES are normal -> consumers dedup (idempotency key).
  - Ordering: if consumers need per-entity order, partition by entity id (e.g., Kafka key = orderId).
  - Poller must be safe to run concurrently: use SELECT ... FOR UPDATE SKIP LOCKED or a leader.
  - Outbox table grows -> archive/delete sent rows (retention job) or it bloats.

Capacity math (poller):
  throughput = batch_size / poll_interval
  10k events/s needs batch 1000 @ 100ms, or CDC (no polling ceiling).

Grafana alerts:
  outbox_unsent_rows        -> alert if > threshold for 5m (relay stuck/broker down)
  outbox_publish_lag_seconds-> now() - min(created_at where sent=false); page if > SLA
  consumer_dedup_hit_rate   -> spikes indicate a re-delivery storm upstream
```

**Real-world framing:** the outbox + CDC combination (popularized by Debezium and the microservices-patterns community) is the standard, boring, correct answer to "how do you publish an event whenever you change the database without a dual-write?" In an interview, drawing the single `BEGIN … INSERT orders … INSERT outbox … COMMIT` and then the relay is the move that shows you've actually shipped this, not just read about 2PC.

---

## 12. Idempotency and "Exactly Once"

### 🟢 Beginner — The Coat-Check Ticket

You hand your coat to the coat check and get a numbered ticket. If you accidentally ask for your coat twice with the same ticket, you don't get two coats — the number identifies *one* coat. Even if you shout your request three times because the room is loud (retries), the ticket guarantees one outcome. An idempotency key is that ticket: repeat the request all you want, the effect happens once.

---

### 🟡 Senior — Effectively-Once = At-Least-Once + Idempotent Consumer

Exactly-once *delivery* over a lossy network is impossible (you can never be sure a message arrived; acks can be lost forever). So delivery is at-least-once and you neutralize duplicates at the **effect**.

```
Effectively once = at-least-once delivery + idempotent processing

Consumer:
  on message with key k (in ONE transaction):
    if seen(k): return                 # duplicate -> no-op
    apply_effect(m)
    mark_seen(k)                        # same txn as apply_effect, or a crash re-applies
```

```sql
-- Idempotency key for POST /payments (reserve BEFORE charging, same DB as the write)
BEGIN;
  INSERT INTO idempotency_keys (key, status, request_hash)
    VALUES (:key, 'IN_PROGRESS', :hash)
  ON CONFLICT (key) DO NOTHING;        -- unique index on key
COMMIT;
-- inserted 0 rows? -> duplicate: return stored_response if DONE, else 409/retry-after
-- inserted 1 row?  -> do the charge once, then UPDATE ... status='DONE', stored_response=...
```

| Store field | Purpose |
|---|---|
| `key` | Unique per logical attempt (client-generated) |
| `status` | IN_PROGRESS / DONE (handles concurrent duplicates) |
| `request_hash` | Reject key reuse with a *different* body |
| `stored_response` | Replay identical result on duplicate |

---

### 🔴 Architect — Kafka EOS, TTLs, and the Store-Placement Trap

```
Kafka exactly-once (EOS, since 0.11 / 2017):
  1) Idempotent producer: broker dedups retries via ProducerID + per-partition sequence #.
  2) Transactions (transactional.id): atomic multi-partition send + consumer-offset commit
     -> atomic read-process-write. Consumer isolation.level=read_committed skips aborted txns.
  Scope: exactly-once WITHIN Kafka. External side effects (charging a card) still need their own idempotency.

TTL sizing:
  TTL too short -> slow retry after expiry treated as new -> DOUBLE CHARGE.
  Rule: TTL >= max_client_retry_window + max_processing_time (payments often 24h+).

Store-placement trap (this is the dual-write problem again):
  key in Redis + charge in Postgres = TWO systems, no atomic commit
    -> crash between them -> "done" recorded but no charge, or charge with no key.
  Put the key row and the business write in the SAME DB, SAME transaction.
```

**What Stripe does (public docs):** exposes an `Idempotency-Key` request header; the API stores the first result and **replays it** for any retry with the same key, so a client that times out and retries a charge never double-charges. The architect-level insight: idempotency isn't a nice-to-have on money endpoints — it's the mechanism that makes at-least-once networks safe, and it must be co-located with the write it protects.

---

## 13. Isolation Levels and Anomalies

### 🟢 Beginner — Reading a Document Someone Else Is Editing

You're reading a shared Google Doc while a coworker edits it. **Dirty read**: you read a sentence they're mid-typing and will delete. **Non-repeatable read**: you read a paragraph, scroll away, scroll back, and it's changed. **Phantom**: you count the bullet points, look again, and a new bullet appeared. Isolation levels are the rules for how much of your coworker's in-progress editing you're allowed to see.

---

### 🟡 Senior — The Levels and the Anomaly Ladder

```
Anomalies, weakest protection to strongest:
  Dirty read          -> read uncommitted data (may be rolled back)
  Non-repeatable read -> same row read twice differs (another txn updated+committed)
  Phantom             -> same range query returns new rows (another txn inserted)
  Write skew          -> two txns read an overlapping constraint, write different rows, both commit
```

| Level | Dirty read | Non-repeatable | Phantom | Write skew |
|---|---|---|---|---|
| Read Uncommitted | ✅ possible | ✅ | ✅ | ✅ |
| Read Committed | ❌ prevented | ✅ | ✅ | ✅ |
| Repeatable Read (ANSI) | ❌ | ❌ prevented | ✅ | ✅ |
| Snapshot Isolation | ❌ | ❌ | ❌ (usually) | ✅ still possible |
| Serializable / SSI | ❌ | ❌ | ❌ | ❌ prevented |

```sql
-- Write skew (snapshot isolation permits this):
-- Invariant: at least one doctor must remain on call.
-- Txn A: SELECT count(*) FROM oncall WHERE on_call=true;  -- reads 2 (snapshot)
--        UPDATE oncall SET on_call=false WHERE name='alice';
-- Txn B: SELECT count(*) ... -> also reads 2 (snapshot); UPDATE ... WHERE name='bob';
-- Both commit (different rows, no write-write conflict) -> zero on call. Invariant broken.
```

---

### 🔴 Architect — The Vendor Naming Trap and What to Actually Set

```
The trap that burns senior candidates:
  PostgreSQL REPEATABLE READ  == Snapshot Isolation (stronger than ANSI RR; stops phantoms)
                                 BUT still allows write skew.
  Oracle SERIALIZABLE         == Snapshot Isolation (NOT truly serializable) -> write skew possible.
  PostgreSQL SERIALIZABLE     == SSI (Serializable Snapshot Isolation) -> truly serializable.

PostgreSQL SSI (since 9.1): runs SI but TRACKS read/write dependencies among concurrent
txns and ABORTS one when a dangerous cycle (that would cause write skew) is detected.
Cost: occasional "could not serialize access" errors -> the app MUST retry.
```

**Failure mode to name:** a team sets Oracle/PostgreSQL to "the strongest-sounding level" and assumes their multi-row invariant is safe — but if that level is really snapshot isolation, **write skew silently violates the invariant** (double-booked on-call, negative aggregate balance across accounts). The correct move: for cross-row invariants, use true `SERIALIZABLE`/SSI (and add retry-on-serialization-failure), or materialize the conflict with `SELECT … FOR UPDATE` / a constraint. In a design review, always ask *"is that level actually serializable, or snapshot isolation wearing the name?"*

---

## 14. Concurrency Control: MVCC, OCC, and 2PL

### 🟢 Beginner — Editing Copies vs Locking the Original

Two ways to let many people work on one document. **Locking (pessimistic):** whoever holds the pen is the only one who can write; everyone else waits. **Versioned copies (MVCC):** everyone gets a snapshot copy to read freely, and edits create a new version — nobody waits to *read*. **Optimistic:** everyone edits their copy assuming no clash, and only at save time do you check "did anyone change this since I started?" — if so, redo.

---

### 🟡 Senior — Three Mechanisms, Three Fits

```
MVCC (multi-version): each write creates a new row version; readers see their snapshot.
  -> readers don't block writers, writers don't block readers.

OCC (optimistic): read a version, compute, on commit verify version unchanged (CAS); else retry.
  -> no locks held; great when conflicts are rare.

2PL (pessimistic): acquire locks (growing phase), hold to commit, then release (shrinking phase).
  -> guarantees serializability; risks lock waits + deadlock.
```

```sql
-- OCC: compare-and-swap with a version column
UPDATE accounts SET balance = balance - 50, version = version + 1
 WHERE id = 'a1' AND version = 7;     -- 0 rows affected -> someone won -> re-read + retry

-- Pessimistic: lock the hot row up front
BEGIN;
  SELECT balance FROM accounts WHERE id = 'a1' FOR UPDATE;   -- others block here
  UPDATE accounts SET balance = balance - 50 WHERE id = 'a1';
COMMIT;
```

| | MVCC | OCC | 2PL (pessimistic) |
|---|---|---|---|
| Readers block writers | No | No | Yes (read locks) |
| Best when | Read-heavy | Low contention | High contention hot rows |
| Failure mode | Version bloat / GC lag | Retry storms under contention | Deadlocks, lock waits |
| Examples | Postgres, InnoDB, Oracle | App-level CAS, some KV stores | Traditional RDBMS locking |

---

### 🔴 Architect — MVCC Garbage Collection and Contention Math

```
MVCC's hidden cost is GARBAGE COLLECTION of dead versions:
  Postgres: VACUUM removes dead tuples; if it falls behind -> table/index BLOAT,
            slower scans, and (worst case) transaction-ID wraparound risk.
  InnoDB:   purge threads reclaim old versions; long-running txns pin old versions
            (a single 6-hour reporting query can block purge -> history bloat).

OCC contention math (why it collapses under load):
  If P(conflict per attempt) = c, expected attempts ≈ 1 / (1 - c).
  c = 0.9 -> ~10 attempts per success -> 90% wasted work -> switch to pessimistic locking.

Rule of thumb:
  Hot single row (inventory count for a flash sale) -> pessimistic (FOR UPDATE) or atomic decrement.
  Scattered low-contention updates -> OCC/version CAS.
```

**Failure mode to name:** a long-running analytics transaction on an MVCC database (Postgres/InnoDB) **pins old row versions**, so GC/VACUUM can't reclaim them and the database bloats — a classic production incident where "a harmless read query" degrades write performance cluster-wide. The architect watches `oldest running transaction age` and `dead tuple count`, and isolates long reads (read replica) so they don't stall version cleanup on the primary.

---

## 15. Spanner, Percolator, and Redesigning Boundaries

### 🟢 Beginner — Synchronized Watches vs a Shared Notebook

**Spanner's idea:** give every data center an extremely accurate, synchronized watch (to within a few milliseconds), so that even machines across the planet can agree on the order things happened — then wait out the tiny uncertainty before declaring a transaction done. **Percolator's idea:** on a system that can only safely change one line of a shared notebook at a time, cleverly designate one "master line"; the whole multi-line change counts as done the instant that one master line flips.

---

### 🟡 Senior — How Each System Buys Cross-Node Atomicity

```
SPANNER (Google, OSDI 2012) — externally consistent (linearizable) transactions:
  1) TrueTime: clock API returning an interval [earliest, latest] with bounded uncertainty ε
               (GPS + atomic clocks). TT.now() = [t-ε, t+ε].
  2) 2PC over Paxos groups: each shard is a Paxos group; cross-shard txns run 2PC where every
     participant (and coordinator) is replicated -> no single-machine SPOF.
  Commit-wait: after choosing commit timestamp s, WAIT until TT.now().earliest > s before
               releasing -> guarantees real time has passed s -> external consistency.

PERCOLATOR (Google, OSDI 2010) — snapshot-isolation txns on Bigtable (single-row atomic only):
  Client-driven 2PC using a timestamp oracle + extra 'lock'/'write' columns.
  The trick: one cell is the PRIMARY lock. The whole multi-row commit is atomic because it
  hinges on a SINGLE-ROW atomic swap of that primary lock -> replaced by a write = committed.
  Secondary locks are cleaned up lazily; crashed clients are recovered via the primary.
```

| | Spanner | Percolator |
|---|---|---|
| Consistency | External (linearizable) | Snapshot isolation |
| Built on | Paxos groups + TrueTime | Bigtable + timestamp oracle |
| Atomic commit point | 2PC over Paxos (commit-wait) | Single-row swap of the primary lock |
| Latency profile | Low-ms commit-wait per txn | High per-txn (many RPCs) — batch/throughput oriented |
| Designed for | OLTP, strongly consistent serving | Incremental index building (batch) |

---

### 🔴 Architect — The Best Distributed Transaction Is the One You Deleted

```
Redesign boundaries so cross-service atomicity becomes ONE local transaction:
  Principle (DDD): the unit of consistency = the unit of transaction = the AGGREGATE.
  Put data that must be strongly consistent TOGETHER in one service/DB.
  Let everything else communicate via events (eventual consistency).

Before: Order service + Inventory service must be atomic ("reserve + place")
After:  fold "reserve stock" and "create order line" into ONE order-fulfillment aggregate
        -> single local ACID commit; no 2PC, no saga for that core.
        Email / search index / analytics -> outbox events (eventual).

Design-review question that drives the split:
  "Which invariants MUST hold synchronously?"  <- only those constrain the boundary.
  Everything else can be eventual -> smaller strong-consistency core -> cheaper, faster.
```

**What Google's own guidance reflects:** even with Spanner available, teams are steered toward single-shard (single-Paxos-group) transactions because cross-shard 2PC + commit-wait costs latency. The staff-level lesson generalizes: **first try to make the atomic work local by moving the boundary; reach for 2PC/Spanner-class machinery only for the irreducible strongly-consistent core.** In an interview, proposing a boundary redesign *before* proposing 2PC is the single strongest signal of seniority on this topic.

---

## 16. Failure Modes and Observability

### 🟢 Beginner — The Chain of Dominoes

In distributed transactions, one stall causes the next. A coordinator pauses → locks pile up → dependent requests queue → threads exhaust → the service falls over. The first domino (a 2-second GC pause) is never the real story; the chain it triggers is. Knowing these failure modes means knowing which domino to catch.

---

### 🟡 Senior — The Common Failure Modes

```
Failure 1: 2PC coordinator stall/crash
  Effect: prepared participants block, holding locks -> dependent txns queue
  Symptom: rising lock-wait time, growing "prepared but undecided" count
  Fix: consensus-backed coordinator (Raft/Paxos); timeouts + coordinator failover

Failure 2: Saga orchestrator crash mid-flow
  Effect: steps done, compensations not run -> leaked money/inventory
  Symptom: sagas stuck in non-terminal state; reservations never released
  Fix: durable saga state machine; resume on restart; dead-letter for stuck compensations

Failure 3: Dual-write divergence
  Effect: DB says X, event stream says not-X (silent)
  Symptom: reconciliation gap; downstream missing/orphan records
  Fix: outbox/CDC (structural), reconciliation job (safety net)

Failure 4: Idempotency store desync (wrong placement)
  Effect: key recorded but business write not (or vice versa) -> double charge or lost charge
  Symptom: duplicate charges on retry; support tickets
  Fix: key + write in same DB/txn; request-hash guard; adequate TTL

Failure 5: Write skew under "serializable"-named-but-SI level
  Effect: multi-row invariant violated silently
  Symptom: negative aggregate balance, double-booked on-call
  Fix: true SERIALIZABLE/SSI + retry, or SELECT ... FOR UPDATE / constraint

Failure 6: MVCC version bloat from long transactions
  Effect: VACUUM/purge can't reclaim -> bloat, slow scans, wraparound risk
  Symptom: table/index size grows; oldest-txn age climbs
  Fix: kill/relocate long reads (replica); tune autovacuum
```

---

### 🔴 Architect — Alerts and Chaos Tests

```
Grafana/PromQL-style alerts (illustrative):
  # 2PC danger
  txn_prepared_undecided_count > 0 for 30s              -> page (blocking risk)
  lock_wait_seconds:p99 > 5x baseline                    -> investigate contention
  # Saga health
  sagas_in_nonterminal_state{age>15m} > 0                -> stuck saga
  saga_compensation_deadletter_total increasing          -> compensations failing
  # Dual-write
  rate(orders_committed) - rate(events_published) != ~0  -> divergence
  outbox_publish_lag_seconds > SLA                        -> relay stuck / broker down
  # Idempotency
  duplicate_charge_total > 0                              -> idempotency broken (sev1)
  # MVCC
  pg_oldest_txn_age_seconds > 3600                        -> long txn pinning versions
  dead_tuples_ratio > 0.3                                 -> vacuum falling behind

Chaos experiments:
  1. Kill coordinator between prepare and commit
     Pass: failover coordinator finishes the decision; no indefinite block.
  2. Kill saga orchestrator between step 2 and step 3
     Pass: on restart, saga resumes; exactly one charge; reservation released if it can't complete.
  3. Duplicate-deliver every message (force at-least-once)
     Pass: idempotent consumers -> effects applied once; no double charge.
  4. Inject 30s partition between two services mid-checkout
     Pass: AP paths keep serving; CP paths refuse cleanly; no split-brain writes to money.
  5. Run a 1-hour reporting query on the OLTP primary
     Pass: monitoring catches version pinning; reads are on a replica, not the primary.
```

**Real-world framing:** the recurring production story across companies is not exotic — it's the **silent dual-write divergence** and the **stuck saga with a leaked reservation**. Both are invisible until a customer complains, which is why the senior deliverable is *structural* prevention (outbox, durable saga state) plus *reconciliation + alerting* as the safety net. Detection-only is not a design; prevention-first with detection as backup is.

---

## 17. Anti-Patterns to Name and Avoid

### 🟢 Beginner — The "Just Add a Transaction" Reflex

The most common mistake is reaching for a big global transaction to fix every consistency worry — like using a sledgehammer for every nail. Most consistency needs are better served by smaller, cheaper tools (a session guarantee, an idempotency key, an event), and the sledgehammer (2PC everywhere) often makes availability *worse*.

---

### 🟡 Senior — Named Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Alternative |
|---|---|---|
| "Just wrap it in a transaction" across services | No shared commit log across engines | Saga, or redesign boundary to one local txn |
| Naive dual-write (DB then publish) | Crash between = permanent divergence | Transactional outbox / CDC |
| 2PC on the hot path across many services | Blocking + lock-hold caps throughput; availability = product of parts | Saga + eventual; reserve 2PC for one strong-consistency core |
| "CAP: pick 2 of 3" | P isn't optional; misframes the choice | During partition: C vs A; else: L vs C (PACELC) |
| Assuming Oracle/PG "Serializable"/"RR" stops write skew | Those are snapshot isolation | True SERIALIZABLE/SSI + retry, or FOR UPDATE |
| Idempotency key in a different store than the write | Recreates the dual-write problem | Same DB, same transaction |
| Retry without idempotency | Double charge / double side effect | Idempotency key; idempotent consumers |
| Non-idempotent compensations | Retry → double refund/release | Key compensations; make them idempotent |
| Saga without durable state | Crash mid-flow → leaked money/inventory | Durable state machine (workflow engine) |
| "Strong consistency everywhere" | Latency tax (EL→C) on data that doesn't need it | Right-size per data class (PACELC) |
| Long OLTP read on MVCC primary | Pins versions → bloat → wraparound risk | Run on a replica; tune vacuum |
| 3PC to fix 2PC blocking | Assumes no partitions → split-brain | Consensus-backed coordinator (Raft/Paxos) |

---

### 🔴 Architect — The Design-Review Checklist

```
Before approving any "distributed transaction" design, ask:
  1. Which invariants MUST be synchronous? (Only those justify strong tooling.)
     -> Can we redesign the boundary so that core is ONE local transaction?
  2. If cross-service atomicity is real: Saga (available, no isolation) or 2PC (atomic, blocking)?
     -> Is the coordinator consensus-backed? What's the lock-hold time × contention?
  3. DB write + event: is it an outbox/CDC, or a naive dual-write time bomb?
  4. Every retryable path: is there an idempotency key, co-located with the write?
  5. Reader consistency: which model per endpoint? (linearizable only where a stale read is unsafe)
  6. Isolation level: is it ACTUALLY serializable, or snapshot isolation wearing the name?
  7. Failure drill: what happens to in-flight txns during a 30s partition / GC pause / deploy?
```

**The staff-level summary:** distributed transactions are a spectrum of *costs*, not a feature you turn on. The best engineers **minimize the strongly-consistent core** (boundary redesign), make the rest **eventually consistent with idempotent events** (outbox + effectively-once), and reserve **2PC/Spanner-class atomicity** for the irreducible money-moving center — always pricing the choice in latency and availability out loud.

---

## Quick Recall Cheat Sheet

> Close this file. Try to answer these from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| ACID across DBs | Atomicity breaks first — no shared commit log across engines |
| Dual-write problem | DB write + publish can't be atomic naively; crash between = permanent divergence |
| Outbox | Event inserted in the SAME local txn as the write; relay/CDC publishes at-least-once |
| CDC | Tail WAL/binlog (Debezium); near-real-time, no added query load |
| CAP (correct) | P is mandatory; during partition choose C or A; NOT "pick 2 of 3" |
| CAP provenance | Brewer conjecture 2000; Gilbert & Lynch proof 2002; C = linearizability |
| CAP-C vs ACID-C | CAP-C = linearizability; ACID-C = invariant preservation |
| PACELC | If Partition: A vs C; Else: Latency vs C (Abadi 2012); the else-branch is the daily tax |
| Consistency spectrum | Linearizable > sequential > causal > eventual |
| Linearizability | Effects at one instant, consistent with REAL time; single-object recency |
| Session guarantees | Read-your-writes, monotonic reads, monotonic writes, consistent prefix |
| Read-your-writes fix | Sticky-to-primary or read a replica ≥ your version (not global linearizability) |
| Eventual OK when | Stale read can't cause an irreversible/invariant-violating action |
| 2PC | Prepare/vote then commit/abort; locks held between; coordinator logs the decision |
| 2PC blocking | Coordinator dies after YES votes → participants stuck holding locks |
| Fix 2PC | Consensus-backed coordinator (Raft/Paxos) — Spanner does this |
| 3PC | Adds pre-commit (non-blocking under fail-stop) but split-brains on partition → unused |
| Saga | Local txns + compensating txns (Garcia-Molina & Salem 1987); compensate, don't rollback |
| Orchestration vs choreography | Central control+visibility vs loose coupling+emergent flow |
| Pivot transaction | Compensatable steps before it; retriable non-compensatable steps after |
| Saga isolation gap | Committed steps visible early → dirty reads; use semantic locks / commutativity |
| Idempotency key | Reserve before work, same DB as the write; duplicate returns stored result; TTL + request-hash |
| Effectively once | Impossible for delivery; = at-least-once + idempotent consumer |
| Kafka EOS | Idempotent producer (PID+seq) + transactions; consumer read_committed |
| ANSI levels | RU→RC→RR→Serializable prevent dirty→non-repeatable→phantom |
| Snapshot isolation | Consistent snapshot; still allows write skew |
| Write skew | Two txns read a shared constraint, write different rows, both commit → invariant broken |
| Naming trap | Postgres RR & Oracle "Serializable" = snapshot isolation; only SSI stops write skew |
| MVCC | Versioned rows; readers don't block writers; Postgres/InnoDB/Oracle; needs VACUUM/purge |
| OCC vs 2PL | CAS/version (low contention) vs locks (hot rows, deadlock risk) |
| Spanner | TrueTime + 2PC over Paxos groups; commit-wait for external consistency (PC/EC) |
| Percolator | Client 2PC on Bigtable; single-row swap of PRIMARY lock = atomic commit point; SI |
| Avoid the problem | Redesign boundary (DDD aggregate) so atomic work is one local transaction |
| Choose the model | 2PC (atomic+isolated), Saga (atomic, no isolation), eventual (just converge) |
| Design-review reflex | Minimize the strong core; eventual + idempotent for the rest; price 2PC in latency/availability |
