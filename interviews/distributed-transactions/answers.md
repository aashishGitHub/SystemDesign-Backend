# Answers: Distributed Transactions & Consistency

> Keyed to [questions.md](./questions.md). Read questions first — attempt each before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on decisions that matter.
> Code is pseudocode / TS / SQL for illustration; verify exact vendor APIs against current docs.

---

## Level 1 — The Problem

### A1. What ACID means and which letter breaks first across databases

| Letter | Meaning | One-line |
|---|---|---|
| **A** — Atomicity | All operations in the transaction happen, or none do | "All or nothing" |
| **C** — Consistency | The transaction moves the DB from one valid state to another (invariants/constraints hold) | "No broken rules" |
| **I** — Isolation | Concurrent transactions don't corrupt each other's view | "As if run alone" |
| **D** — Durability | Once committed, survives a crash | "Written in stone" |

The moment a transaction spans two databases, **Atomicity** is the hardest to keep. A single engine gives atomicity with one durable log and one commit record. With two independent engines there is no shared log and no shared commit point — each can commit or crash independently, so "all or nothing" now requires a distributed agreement protocol (2PC) or a compensation-based substitute (Saga). Isolation degrades too (there is no cross-database lock manager), but atomicity is the one people assume they still have and don't.

---

### A2. Why "just wrap it in a transaction" fails across services

Local ACID guarantees stop at **one database's boundary**. A `BEGIN…COMMIT` is scoped to a single connection to a single engine that owns one write-ahead log. Payment's DB, Inventory's DB, and Order's DB have three separate logs and three separate commit records.

```
# What people imagine (does not exist):
BEGIN
  payment_db.charge(...)
  inventory_db.reserve(...)
  order_db.insert(...)
COMMIT   # <-- there is no engine that can commit all three atomically

# Reality: three independent commits that can each fail or crash:
payment_db.charge(...)     # committed
inventory_db.reserve(...)  # committed
order_db.insert(...)       # process crashes here -> customer charged, no order
```

To make those three commit atomically you need a distributed atomic-commit protocol (2PC) with a coordinator — which introduces blocking and availability costs (Level 4) — or you abandon atomicity and use a Saga with compensations (Level 5). There is no free `COMMIT` that spans engines.

---

### A3. The dual-write problem

The dual-write problem: a single logical operation must update **two independent systems** (e.g., a database and a message broker), but you can only commit to one at a time, so any crash between them leaves them permanently inconsistent.

```
# Order A: DB first, then publish
db.insert(order)          # committed
publish("OrderPlaced")    # process crashes BEFORE this runs
# -> Order exists in DB, but no event. Search index/email never fire. Silent divergence.

# Order B: publish first, then DB
publish("OrderPlaced")    # sent
db.insert(order)          # crashes / constraint violation
# -> Consumers act on an order that does not exist in the DB. Worse.
```

Retrying doesn't save you: retrying the publish after a DB commit can double-publish; retrying the DB write after a publish can double-insert. The two actions are not covered by one transaction, so **no ordering of them is safe**. The fix is to make the second write derive from the first atomically — the transactional outbox (A25) or CDC (A26).

---

### A4. Charge succeeds, order insert crashes

You have violated atomicity across two systems: the money moved but the business record didn't. `try/catch` can't fix it because the crash can happen *between* the two commits — including after the charge's network response was lost, so you don't even know whether it succeeded.

```
charge = payment.charge(card, $50)   # succeeds at the processor
# <-- crash / timeout / lost response here
order_db.insert(order)               # never runs
```

| Attempted fix | Why it fails |
|---|---|
| `try/catch` + refund in `catch` | The crash can kill the process before `catch` runs; refund never issued |
| Retry the whole handler | Re-charges the card (no idempotency) → double charge |
| Reverse the order (insert first) | Now you can insert an order you failed to charge for |

The real fixes are (1) an **idempotency key** so a retry re-charges nothing (A28), and (2) making charge-and-record a single atomic unit via an **outbox** or a **saga with a compensating refund** (A20, A25).

---

## Level 2 — CAP & PACELC

### A5. CAP stated precisely

**CAP theorem:** in an asynchronous network where messages can be lost or delayed, a distributed data store cannot simultaneously provide all three of:

- **C — Consistency:** every read sees the most recent write (formally, *linearizability*).
- **A — Availability:** every request to a non-failing node receives a non-error response (not necessarily the latest).
- **P — Partition tolerance:** the system keeps operating despite the network dropping/delaying messages between nodes.

History: **Eric Brewer conjectured it in 2000** (PODC keynote). **Seth Gilbert and Nancy Lynch proved it formally in 2002** (their SIGACT News paper). The proof is for the asynchronous model with their specific definitions of C (atomic/linearizable) and A (every request to a live node responds).

---

### A6. Why "pick 2 of 3" is wrong

You do not get to *choose* whether partitions happen — the network decides that. In any real distributed system, **P is not optional**: cables get cut, switches reboot, packets drop. So you cannot "pick CA."

```
Common misconception:  choose 2 of {C, A, P}          <-- WRONG
Correct framing:       P is a given. During a partition,
                       you choose between C and A.
                       When there is NO partition, you can have BOTH.
```

| "System type" | What it really means |
|---|---|
| CP | During a partition, refuse/limit requests to preserve consistency (sacrifice A) |
| AP | During a partition, keep serving with possibly-stale data (sacrifice C) |
| "CA" | Only a single-node system, or one that simply fails entirely on partition — not meaningful for a real distributed store |

The interview-winning sentence: *"CAP is only a dilemma during a partition; the real, everyday tradeoff is captured by PACELC's else-branch — latency vs consistency."* (A8)

---

### A7. The "C" in CAP vs the "C" in ACID

They are different concepts that share a letter.

| | CAP's C | ACID's C |
|---|---|---|
| Means | **Linearizability** — a single-object recency + real-time ordering guarantee across replicas | **Consistency** — the transaction preserves application invariants/constraints (e.g., `balance >= 0`) |
| Enforced by | The replication/consensus layer | The transaction + your constraints/triggers |
| Scope | Distributed reads/writes | A single logical transaction |

CAP's "C" is specifically **linearizability**. ACID's "C" is really the application's responsibility (the DB just enforces declared constraints). Saying "we need consistency" without saying which one is exactly the ambiguity a senior interviewer is probing for.

---

### A8. PACELC

**PACELC (Daniel Abadi, 2012):** *if* there is a **P**artition, choose between **A**vailability and **C**onsistency; **E**lse (normal operation) choose between **L**atency and **C**onsistency.

PACELC's contribution is the *else* branch: even with no partition, replicating synchronously for strong consistency costs latency, while replicating asynchronously lowers latency but weakens consistency. This is the tradeoff you actually pay every millisecond of every day, unlike partitions which are rare.

| Classification | Behavior | Real system (illustrative) |
|---|---|---|
| **PC/EC** | Consistent under partition; consistent (and slower) when healthy | Spanner (strongly consistent; pays latency via commit-wait) |
| **PA/EL** | Available under partition; low-latency (weaker) when healthy | DynamoDB (tunable), Cassandra with low consistency level, classic Dynamo |
| **PC/EL** | Consistent under partition, but favors latency when healthy | Some MongoDB configs (majority writes under partition, fast reads otherwise) |

*Note:* these labels depend on configuration; treat them as illustrative, not immutable properties.

---

### A9. Cart accepts writes on both sides of a partition

This is the **AP choice** (availability over consistency): both partition halves keep accepting "add to cart" so the customer never sees an error. The price is paid at **heal time** — you now have two divergent versions of the cart that must be reconciled.

```
Partition:  Cart on side X = {book}          Cart on side Y = {phone}
Heal:       must merge -> which wins?

Reconciliation options:
  - Last-write-wins (LWW):    simplest, silently drops one add   <-- data loss
  - Merge/union (CRDT-style): cart = {book, phone}               <-- Amazon Dynamo's choice
  - Return both to the app:   app/user resolves                   <-- Dynamo shopping cart
```

**Tradeoff: Availability vs Consistency.** Amazon's original Dynamo explicitly chose AP for the cart: never reject an add-to-cart, reconcile divergent versions at read time (union the carts). The cost is that a *removed* item can reappear after a merge — an acceptable business tradeoff for a cart, unacceptable for a bank balance.

---

## Level 3 — Consistency Models

### A10. Strongest → weakest

| Rank | Model | One-line definition |
|---|---|---|
| 1 (strongest) | **Linearizable** | Every operation appears to take effect instantaneously at a single point between its call and return; reads see the latest committed write in real time |
| 2 | **Sequential** | All operations appear in *some* single total order that respects each client's program order — but not necessarily real-time order |
| 3 | **Causal** | Operations that are causally related are seen in the same order by everyone; concurrent operations may be seen in different orders |
| 4 (weakest) | **Eventual** | If writes stop, all replicas eventually converge to the same value; no ordering guarantee in the meantime |

The key gap between 1 and 2: linearizability respects **real (wall-clock) time** across clients; sequential consistency only respects each client's own order. Between 2 and 3: causal drops the single global order and keeps only cause→effect.

---

### A11. Linearizability precisely, vs sequential

**Linearizability** (Herlihy & Wing, 1990): each operation appears to happen atomically at some instant between its invocation and its response, and that instant order is consistent with **real time**. If write W completes before read R begins (wall-clock), R must see W (or something newer). It's a guarantee about *single objects*.

```
Real time ->
Client1: [--- write x=1 ---]
Client2:                       [--- read x ---]   MUST return 1 (linearizable)

Sequential consistency allows:
Client2's read to return the OLD value, as long as SOME global order
exists that respects each client's own program order.
```

What linearizability adds over sequential: **real-time recency**. Under sequential consistency two clients can disagree with wall-clock reality as long as a consistent global interleaving exists. Linearizability forbids that — it's what CAP's "C" means and what a single-object register needs to behave "like one copy."

---

### A12. The four client-centric (session) guarantees

These come from the session-guarantees line of work (Terry et al., Bayou, 1994) and are weaker/cheaper than global linearizability because they only constrain what a **single client's session** observes.

| Guarantee | Definition | Bug it prevents |
|---|---|---|
| **Read-your-writes** | A client always sees its own prior writes | You post a comment, refresh, and it's gone |
| **Monotonic reads** | If you read a value, later reads never return an *older* value | A notification count goes 5 → 3 → 5 as you refresh (bouncing off stale replicas) |
| **Monotonic writes** | Your writes are applied in the order you issued them | "Set name = A" then "set name = B" lands as A because replicas applied them out of order |
| **Consistent prefix** | Readers see writes in an order consistent with the order they were written (no gaps that reorder cause/effect) | You see a reply before the message it replies to |

These are typically implemented with **sticky sessions** (route a client to the same replica) or by tracking the client's latest-seen version and only reading from replicas caught up to it.

---

### A13. "My own comment is missing on refresh"

This violates **read-your-writes** consistency. The write went to the primary; the refresh read hit a lagging read-replica that hasn't received it yet.

```
POST /comment -> primary (write applied)
GET  /comments -> replica (still behind) -> comment absent
```

**Cheapest fixes that avoid global linearizability:**

| Fix | How it works | Cost |
|---|---|---|
| Sticky read-after-write | Route this user's reads to the primary for N seconds after a write | Slight primary load increase |
| Read own write from cache | Serve the just-written value from the client/session, merge with replica read | App complexity |
| Version token | Client sends "I've seen version V"; only read replicas ≥ V | Track replica versions |

You do **not** need to make the whole system linearizable — you only need this one session to observe its own write. That's the value of client-centric guarantees.

---

### A14. When eventual consistency is / isn't acceptable

**Rule:** eventual consistency is acceptable when a brief stale read cannot cause an *irreversible or invariant-violating* action; it is unacceptable when a decision made on stale data is unsafe to undo.

| Acceptable (eventual OK) | Unacceptable (need strong) |
|---|---|
| Like counts, view counts, follower counts | Account balance for a withdrawal |
| Product reviews list, timeline feed | "Is this the last seat / last unit?" |
| DNS records, CDN cache | Unique-username registration |
| Analytics dashboards | Distributed lock / leader election |

Concrete: a like count that's briefly off by 3 is invisible and self-heals — eventual is right. Selling the last concert seat twice because two nodes both read "1 available" is a refund, an angry customer, and a support ticket — you need linearizable read-modify-write (or a single-owner shard) there.

---

## Level 4 — Two-Phase Commit (2PC)

### A15. 2PC end to end

**Roles:** one **coordinator** (transaction manager) and N **participants** (resource managers, each owning a DB).

```
PHASE 1 — PREPARE (voting):
  Coordinator -> all participants: "PREPARE txn T"
  Each participant:
    - does the work, acquires locks, writes a PREPARE record to its durable log
    - replies YES (I can commit and will honor it) or NO (abort)
    - after voting YES it is in the "prepared" state: it may NOT unilaterally abort or commit;
      it holds its locks and waits.

PHASE 2 — COMMIT/ABORT (decision):
  If ALL voted YES:  Coordinator writes COMMIT to its log, then -> all: "COMMIT"
  If ANY voted NO:   Coordinator writes ABORT  to its log, then -> all: "ABORT"
  Each participant applies the decision, writes it to its log, RELEASES LOCKS, acks.
  Coordinator completes when all acks are in.
```

**Locks are held from PREPARE until the decision arrives** — this is the whole cost. Durable logging at both the participant (on vote YES) and the coordinator (on decision) is what makes it recoverable across crashes.

---

### A16. The blocking problem

If the coordinator crashes **after participants voted YES but before broadcasting the decision**, prepared participants are stuck: they promised they can commit, so they may not abort, but they haven't been told to commit either.

```
P1, P2, P3 all voted YES (prepared, holding locks)
Coordinator crashes before sending COMMIT/ABORT
-> P1, P2, P3 must WAIT indefinitely, holding locks
-> They cannot ask each other: they don't know if the coordinator
   decided COMMIT (and told someone) or ABORT.
```

They can't decide unilaterally because a prepared participant doesn't know the *global* outcome — the coordinator might have already told a now-unreachable participant to commit. Committing or aborting on a guess risks violating atomicity. So they block until the coordinator recovers and replays its log. **This is why 2PC is called a blocking protocol**, and why the coordinator is a single point of failure.

---

### A17. Why 2PC hurts availability and latency

| Cost | Mechanism | System-design metric hit |
|---|---|---|
| **Availability** | Coordinator crash while participants are prepared → participants block, holding locks; any transaction touching those rows stalls | Uptime / error rate: one coordinator failure freezes part of the dataset |
| **Latency & throughput** | Locks held across ≥2 network round trips (prepare + commit) → contention; every commit waits for the slowest participant | p99 latency and max throughput both drop; "commit waits for the slowest node" |

Latency math intuition: commit latency ≈ 2 × RTT + slowest participant's disk fsync, and locks are held that whole time, so the **effective throughput on hot rows is bounded by 1 / (lock-hold time)**. Cross-region 2PC (RTT tens of ms) can cap a hot row at low tens of transactions/sec. This is why 2PC is avoided on the hot path of high-throughput services.

---

### A18. 3PC and why it's rarely used

**3PC (Skeen, 1981)** inserts a **pre-commit** phase between prepare and commit so that no single crash leaves participants unable to decide: prepare → pre-commit (everyone acknowledges they *will* commit) → commit. A recovering participant can infer the outcome from whether pre-commit was reached, so it's **non-blocking under fail-stop crashes**.

```
Prepare  -> votes
Pre-commit -> "everyone agreed; get ready" (ack)
Commit   -> "do it"
```

**Why it's rarely used:** 3PC assumes a **synchronous network with bounded message delay and no partitions**. Real networks partition, and under a partition 3PC can produce split-brain (two sides reach different decisions) — it trades the blocking problem for an inconsistency problem. Plus it adds a third round trip (more latency). Modern systems instead make the *coordinator itself fault-tolerant* via consensus (A19).

---

### A19. The one change that makes 2PC production-viable

**Make the coordinator (and its decision log) fault-tolerant by replicating it with a consensus protocol** (Paxos/Raft). Then a coordinator crash no longer strands participants — a replica takes over, reads the replicated decision log, and completes the protocol.

```
Classic 2PC:  single coordinator  -> SPOF, blocking
Modern 2PC:   coordinator = a Paxos/Raft group; decision log is replicated
              -> coordinator failure is survivable; no indefinite block
```

**Google Spanner** does exactly this: cross-shard transactions use 2PC, but each participant *and* the coordinator is a **Paxos group**, so no individual machine failure blocks the transaction. This is the standard resolution: keep 2PC's atomicity, delete its single-point-of-failure by layering it over consensus.

---

## Level 5 — Saga Pattern

### A20. The Saga pattern

**Saga (Garcia-Molina & Salem, 1987, SIGMOD "Sagas"):** model a long-lived transaction as a sequence of local transactions `T1, T2, …, Tn`, each committing independently in its own service/DB. Each `Ti` has a **compensating transaction `Ci`** that semantically undoes it. If `Tk` fails, run `C(k-1), …, C1` in reverse to walk the system back.

```
Forward:   T1 charge -> T2 reserve stock -> T3 create order -> T4 notify
If T3 fails:
Compensate: C2 release stock -> C1 refund charge
```

What replaces rollback: **semantic compensation**, not a DB rollback. `T1` already committed and is visible to others; you can't roll it back — you issue a *new* transaction that offsets it (refund the charge, release the reservation). Compensation is business-level "undo," which is why some actions are hard to compensate (A23).

---

### A21. Orchestration vs choreography

| | Orchestration | Choreography |
|---|---|---|
| Control | Central orchestrator explicitly calls each step and its compensation | No central brain; each service reacts to events and emits the next event |
| Coupling | Services simple; orchestrator knows the whole flow | Services coupled through event contracts; flow is emergent |
| Visibility | Flow is in one place — easy to see/monitor | Flow is spread across services — hard to trace |
| Failure mode | Orchestrator is a bottleneck / must be made HA | **Cyclic dependencies & hard-to-debug event storms**; no single place shows saga state |

**Tradeoff: Central control/visibility vs decoupling.** Orchestration (e.g., a workflow engine like Temporal/Netflix Conductor style) gives you one place to see and recover saga state — best for complex flows. Choreography gives loosest coupling and no central bottleneck — best for simple, few-step flows. The unique risk of choreography is that adding a step means editing several services and the end-to-end flow exists in no single file.

---

### A22. Sagas have no isolation

Because each `Ti` commits independently and immediately, its results are visible to other transactions **before the overall saga finishes**. The classic anomaly is a **dirty read**: another transaction reads state that a later step will compensate away (and may make a decision on money that's about to be refunded). Related: **lost updates** and **non-repeatable reads** across steps.

```
T1 (charge, reserve) commits -> visible
Meanwhile another flow reads "stock reserved, order pending" and acts on it
T3 fails -> C1 refunds, C2 releases -> the other flow acted on state that no longer holds
```

| Countermeasure | How it works |
|---|---|
| **Semantic lock** | Mark the record with a pending status (`ORDER_PENDING`); other transactions see the flag and refuse/wait. A commit or compensation clears it |
| **Commutative updates** | Design steps so order doesn't matter (e.g., `balance += x` / `-= x` instead of `set balance`) so interleaving can't lose updates |
| **Reread value / version file** | Before compensating, re-read and verify the value hasn't changed; use a version to detect interference |
| **Pessimistic view** | Reorder saga steps so the hardest-to-compensate / most-visible step happens last |

(These countermeasures are catalogued in the microservices-saga literature, e.g., Chris Richardson's *Microservices Patterns*.)

---

### A23. Compensating a non-compensatable action (email)

You can't unsend an email, so you handle it two ways:

```
Strategy 1 — Order the saga so non-compensatable steps run LAST ("pivot transaction"):
  Steps before the pivot are compensatable (charge -> refundable).
  The pivot is the point of no return (commit-ish).
  Steps AFTER the pivot are retriable and must eventually succeed (send email),
  never compensated.

  [compensatable...] -> [PIVOT] -> [retriable, non-compensatable...]
```

```
Strategy 2 — Compensate with a NEW forward action, not an undo:
  Can't unsend "Order confirmed" -> send "Order cancelled, you were not charged".
  The apology email is itself a retriable step.
```

The concept of a **pivot transaction** (the go/no-go step) is the key: everything before it must be compensatable, everything after it must be retriable-until-success. Emails/SMS/webhooks belong after the pivot as retriable side effects, so they never need to be un-done.

---

### A24. Why saga steps and compensations must be idempotent

Message delivery is at-least-once, and retries after timeouts are unavoidable, so **every step may be delivered/executed more than once**.

```
Non-idempotent compensation = double refund:
  C1 = refund($50)
  C1 runs, succeeds, but the ack is lost -> orchestrator retries C1
  -> customer refunded $100. Real money lost.
```

Make forward steps idempotent (via an idempotency key or a "already applied?" check) and compensations idempotent (a refund keyed by `refund_id`; if it already exists, no-op and return success). The exact failure when a compensation isn't idempotent is a **duplicate side effect** — double refund, double stock release, double email — because the retry can't tell "first time" from "already did it."

---

## Level 6 — Reliable Messaging & Idempotency

### A25. Transactional outbox

Write the event into an **outbox table in the same local transaction** as the business change. Because it's one local ACID transaction, the business row and the outbox row commit or fail *together* — atomicity restored. A separate **relay** then reads the outbox and publishes to the broker (at-least-once), marking rows sent.

```sql
BEGIN;
  INSERT INTO orders (id, customer_id, status) VALUES ('o1', 'c1', 'PLACED');
  INSERT INTO outbox (id, topic, payload, created_at, sent)
    VALUES ('e1', 'OrderPlaced', '{"orderId":"o1"}', now(), false);
COMMIT;   -- both rows are now durable atomically, or neither is
```

```
Relay (separate process):
  loop:
    rows = SELECT * FROM outbox WHERE sent = false ORDER BY created_at LIMIT 100
    for row in rows:
      broker.publish(row.topic, row.payload)   # at-least-once
      UPDATE outbox SET sent = true WHERE id = row.id
```

**Why it beats naive dual-write:** the *only* dual-write left is relay→broker, and that's safe because publishing is retriable + idempotent on the consumer side (A27). The DB↔event divergence is eliminated because they share one commit. Downside: at-least-once publishing means duplicates → consumers must be idempotent.

---

### A26. CDC and log-tailing vs polling relay

**Change Data Capture (CDC):** instead of polling an outbox table, tail the database's **replication log** (Postgres WAL, MySQL binlog) and turn committed row changes into an event stream. Tools like **Debezium** read the log and publish to Kafka. This is the "transaction-log-tailing" variant of the outbox.

```
Polling relay:   SELECT ... FROM outbox  (adds query load, poll latency)
CDC / log tail:  read WAL/binlog stream  (no app query load, near-real-time)
```

| | Polling relay | CDC (log tailing) |
|---|---|---|
| Latency | Poll interval (e.g., 100ms–1s) | Near-real-time |
| DB load | Extra SELECT/UPDATE queries | Reads the log the DB already writes |
| Ordering | Per your query order | Exact commit order from the log |
| Ops cost | Simple app code | Run/operate a CDC connector, handle schema changes |

**Pick CDC when:** high throughput, you want low latency and no added query load, and you can operate the connector. **Pick polling when:** simplicity matters and volume is modest, or you can't get log access (managed DB without logical replication). You can even skip a dedicated outbox table with CDC by tailing the business tables directly — at the cost of coupling events to table schema.

---

### A27. Exactly-once delivery vs exactly-once processing

**Exactly-once *delivery* over an unreliable network is impossible** (the two-generals intuition: you can never be sure a message arrived without an ack, and the ack can be lost, forever). So the sender must retry → duplicates are inevitable → delivery is *at-least-once*.

**Exactly-once *processing* is achievable** by making the effect happen once even when the message arrives many times. The recipe:

```
Effectively once = at-least-once delivery  +  idempotent consumer

Consumer:
  on message m with dedup_key k:
    if seen(k): return   # already processed -> no-op
    process(m)
    mark_seen(k)         # ideally in the SAME transaction as process(m)
```

The phrase **"effectively once"** (used by Kafka/Flink communities) captures this: you accept duplicate *delivery* and neutralize it with **idempotent processing** and a **dedup store**. The critical detail is that `process` and `mark_seen` must be atomic (same DB transaction) or a crash between them re-processes.

---

### A28. Idempotency key for POST /payments

The client generates a unique **idempotency key** per logical attempt and sends it (e.g., HTTP `Idempotency-Key` header). The server stores the key with the result; a duplicate key returns the stored result instead of re-charging. This is the model **Stripe** exposes publicly.

```sql
-- Reserve the key BEFORE doing the charge, in one transaction:
BEGIN;
  INSERT INTO idempotency_keys (key, status, request_hash)
    VALUES ('idem-123', 'IN_PROGRESS', :hash)
  ON CONFLICT (key) DO NOTHING;   -- unique constraint on key
  -- if 0 rows inserted -> key already exists (duplicate)
COMMIT;
```

```
if inserted == 0:
    row = SELECT * FROM idempotency_keys WHERE key = 'idem-123'
    if row.status == 'DONE':      return row.stored_response   # replay result
    if row.status == 'IN_PROGRESS': return 409/retry-after      # concurrent duplicate
else:
    charge = payment_processor.charge(...)     # do the real work once
    UPDATE idempotency_keys SET status='DONE', stored_response=:resp WHERE key='idem-123'
    return resp
```

| Store | When | Return on duplicate |
|---|---|---|
| `{key, status, request_hash, stored_response}` | Insert `IN_PROGRESS` *before* the charge (so concurrent dupes collide on the unique key) | The **stored response** if `DONE`; retry-after if still `IN_PROGRESS` |

Details that matter: store a **hash of the request** so a reused key with a *different* body is rejected (not silently returning the wrong result); give keys a **TTL** (A-bonus B2). Put the key insert and the business write in the **same database** so they commit atomically — otherwise you reintroduce a dual-write (B2).

---

### A29. Kafka exactly-once semantics (EOS)

Kafka EOS (introduced in Kafka 0.11, 2017) combines two mechanisms:

```
1) Idempotent producer:
   Broker assigns each producer a Producer ID (PID) and tracks a per-partition
   sequence number. A retried duplicate (same PID + sequence) is dropped by the broker.
   -> no duplicates from producer retries on a single partition.

2) Transactions (transactional.id):
   producer.initTransactions()
   producer.beginTransaction()
     producer.send(topicA, ...)
     producer.send(topicB, ...)
     producer.sendOffsetsToTransaction(consumerOffsets, groupId)  # atomic read-process-write
   producer.commitTransaction()   # all sends + the consumer offset commit are atomic
```

`isolation.level=read_committed` on the **consumer** makes it skip records from aborted/in-flight transactions — it only reads committed messages. Together this gives atomic **read-process-write** across partitions: the consumed offsets and the produced results commit as one unit, so a crash doesn't reprocess or lose. Note: this is exactly-once *within Kafka's boundary*; an external side effect (charging a card) still needs its own idempotency.

---

## Level 7 — Isolation & Concurrency Control

### A30. The four ANSI isolation levels

| Level | Prevents (newly) | Still allows |
|---|---|---|
| **Read Uncommitted** | (nothing) | Dirty reads |
| **Read Committed** | Dirty read | Non-repeatable read, phantom |
| **Repeatable Read** | Non-repeatable read | Phantom (per ANSI) |
| **Serializable** | Phantom (and all others) | (nothing — behaves as if serial) |

```
Dirty read:          read a row another txn wrote but hasn't committed (may roll back)
Non-repeatable read: read a row twice in one txn, get different values (another txn updated+committed between)
Phantom read:        run the same range query twice, a new row appears (another txn inserted matching rows)
```

Each level up prevents one more anomaly at the cost of more locking/versioning (concurrency/throughput). Serializable is the gold standard — the result is equivalent to *some* serial execution — but it's the most expensive.

---

### A31. Snapshot isolation and write skew

**Snapshot isolation (SI):** each transaction reads from a **consistent snapshot** taken at its start; it never sees others' uncommitted or later-committed changes. On commit, write-write conflicts are rejected (**first-committer-wins**). SI prevents dirty reads, non-repeatable reads, and (in practice) phantoms — but it still permits **write skew**.

```
Write skew — the on-call doctors example:
  Invariant: at least ONE doctor must remain on call.
  Currently Alice and Bob are both on call.

  Txn A (Alice): reads "Bob is on call" (snapshot) -> OK to go off -> sets Alice = off
  Txn B (Bob):   reads "Alice is on call" (snapshot) -> OK to go off -> sets Bob = off

  Both read the OLD snapshot, both write DIFFERENT rows (no write-write conflict),
  both commit -> NOBODY is on call. Invariant violated.
```

Write skew slips past SI because the two transactions write **different** rows, so there's no write-write conflict to detect — but their reads overlapped a constraint. Fixes: `SELECT … FOR UPDATE` to materialize the conflict, an explicit constraint, or **Serializable Snapshot Isolation** (A34).

---

### A32. Optimistic vs pessimistic concurrency control

| | Optimistic (OCC) — CAS/version | Pessimistic — locking (2PL) |
|---|---|---|
| Assumes | Conflicts are rare | Conflicts are common |
| Mechanism | Read version, on write check version unchanged, else retry | Acquire locks up front, hold until commit |
| Wins on | Low-contention, read-heavy, short txns | High-contention hot rows, long txns |
| Cost | Wasted work on retry under contention | Lock waits, deadlocks, reduced concurrency |

```sql
-- Correct compare-and-swap (optimistic) update using a version column:
UPDATE accounts
   SET balance = balance - 50,
       version = version + 1
 WHERE id = 'a1'
   AND version = 7;         -- only succeeds if nobody changed it since we read version 7
-- rows_affected == 0  -> someone else won; re-read and retry
```

**Tradeoff: retry cost vs lock cost.** OCC avoids holding locks (great throughput when conflicts are rare) but degrades badly under high contention (constant retries — a "livelock" of aborts). Pessimistic locking guarantees progress on hot rows but serializes them and risks deadlock. Rule: OCC for low-contention/read-heavy; pessimistic (`SELECT … FOR UPDATE`) for known hot rows like inventory counts.

---

### A33. MVCC

**Multi-Version Concurrency Control (MVCC):** each write creates a **new version** of a row rather than overwriting it; each reader sees the version consistent with its snapshot. The problem it solves that lock-based readers can't: **readers never block writers and writers never block readers**, so a long analytical read doesn't freeze writes (and vice versa).

```
Row x versions:  (v1 @ t10, val=A)  (v2 @ t20, val=B)
Reader with snapshot @ t15 -> sees v1 (A)      # doesn't block the writer
Reader with snapshot @ t25 -> sees v2 (B)
Writer creating v3 -> doesn't block either reader
```

Databases using MVCC: **PostgreSQL, MySQL/InnoDB, Oracle** (and CockroachDB, SQL Server's snapshot mode). The cost is version storage and **garbage collection** of old versions (Postgres `VACUUM`, InnoDB purge) — dead tuples bloat storage if GC falls behind.

---

### A34. The naming trap: Postgres RR and Oracle "Serializable"

The ANSI names are misleading; what the engines actually implement differs:

| Vendor level | What it actually is |
|---|---|
| **PostgreSQL `REPEATABLE READ`** | **Snapshot isolation** — stronger than ANSI RR; it prevents phantoms too, but still allows write skew |
| **Oracle `SERIALIZABLE`** | **Snapshot isolation** — *not* truly serializable; write skew is possible |
| **PostgreSQL `SERIALIZABLE`** | **Serializable Snapshot Isolation (SSI)** — real serializability |

PostgreSQL's true `SERIALIZABLE` (since 9.1) uses **SSI** (Cahill/Fekete/Röhm line of work): it runs SI but **tracks read/write dependencies between concurrent transactions and aborts one** if a dangerous cycle (that could cause write skew) is detected. So it gives full serializability at roughly SI's read performance, paying with occasional serialization-failure aborts the app must retry. The interview trap: assuming "Repeatable Read" or Oracle "Serializable" stops write skew — they don't; only true serializable/SSI does.

---

## Level 8 — Architect-Level Tradeoffs

### A35. Redesign boundaries to avoid distributed transactions

The senior move: **draw the service/data boundary so that operations that must be atomic together live in the same transactional domain (one database), turning a cross-service transaction into a single local one.** The guiding principle is the **aggregate** (DDD): the unit of consistency = the unit of transaction. Things that must be strongly consistent belong in one aggregate/service; things that can be eventually consistent talk via events.

```
Before (cross-service txn needed):
  Order service  ->  Inventory service  (both must be atomic on "reserve + place")

After (redesigned boundary):
  "Reserve stock" and "create order line" put in ONE order-and-fulfillment aggregate
  -> single local ACID transaction; no 2PC, no saga for this part.
  Truly separate concerns (email, analytics) -> events (eventual consistency).
```

Questions that reveal the redesign: *Which invariants must hold synchronously?* Only those constrain the boundary. Everything else can be eventual. Most "we need a distributed transaction" requirements dissolve once you notice only a small core must be strongly consistent, and it can be co-located.

---

### A36. How Spanner does externally-consistent distributed transactions

Spanner (Google, OSDI 2012) provides **external consistency** (= linearizability for transactions) across shards using two building blocks:

```
1) TrueTime: a clock API that returns an INTERVAL [earliest, latest] with a bounded
   uncertainty ε (backed by GPS + atomic clocks in every datacenter).
   TT.now() -> [t - ε, t + ε]

2) 2PC over Paxos groups: data is sharded; each shard is replicated by a Paxos group.
   Cross-shard transactions run 2PC where each participant (and the coordinator) is a
   Paxos group -> no single-machine SPOF (this is A19 in the wild).
```

**Commit-wait** is the trick for external consistency: after picking a commit timestamp `s`, the coordinator **waits until `TT.now().earliest > s`** before releasing the commit — guaranteeing that when the commit is visible, real time has definitely passed `s`, so timestamps never contradict wall-clock order. The cost is a deliberate wait of ~2ε (a few ms) on every commit — Spanner is **PC/EC**: it pays latency for strong consistency.

---

### A37. How Percolator gets SI transactions on Bigtable

Percolator (Google, OSDI 2010) adds **cross-row, snapshot-isolation transactions on top of Bigtable**, which itself has only single-row atomicity. It uses a **client-driven 2PC** with a global **timestamp oracle** and extra Bigtable columns (a `lock` column and a `write` column) per data column.

```
The atomicity trick: designate ONE cell as the PRIMARY lock.
  Prewrite: lock all cells; one is primary, others point to it.
  Commit:   the transaction commits iff the PRIMARY lock is successfully replaced
            by a write record (a single-row Bigtable atomic op).
  -> The single-row atomic swap of the PRIMARY lock is the ONE atomic commit point
     for the whole multi-row transaction. Secondaries are cleaned up lazily.
```

Reads use a start timestamp from the oracle (snapshot); writes use a commit timestamp. A crashed client's locks are rolled forward/back by the next transaction that encounters them (lazy recovery via the primary). Percolator's cost is high latency per transaction (multiple Bigtable RPCs), which is fine for its use case: **incrementally updating Google's web search index**, not low-latency serving.

---

### A38. Choosing between 2PC, Saga, and eventual consistency

**Decision rule:**
- Need **atomic, isolated, strongly-consistent** cross-node commit *and* can pay latency/availability → **2PC (over consensus)**.
- Need cross-service **atomicity but can tolerate no isolation** and temporary inconsistency, want availability → **Saga**.
- Don't need atomicity at all, just convergence → **eventual consistency + idempotent events**.

| Approach | Atomicity | Isolation | Availability | Latency | Use when |
|---|---|---|---|---|---|
| **2PC (over Paxos/Raft)** | Yes | Yes (locks) | Lower (blocking risk) | Higher | Money-moving within one strongly-consistent DB/cluster (Spanner-style) |
| **Saga** | Eventual (compensations) | **None** | High | Low per step | Multi-service business flows (order, booking) |
| **Eventual consistency** | No | No | Highest | Lowest | Counters, feeds, search index, notifications |

```
Checkout example, split by sub-flow:
  Debit + credit within one ledger DB      -> local ACID (or 2PC if sharded)
  Order across payment/inventory/shipping  -> Saga with compensations
  Update search index / send email         -> eventual (outbox event)
```

---

### A39. 2PC across 5 microservices at 10k req/sec — impact and alternative

**Latency:** 2PC needs ≥2 round trips and holds locks the whole time; commit latency ≈ 2×RTT + slowest fsync. With 5 participants, the commit waits for the **slowest of 5** every time (tail-latency amplification). If any hop is cross-region (~30–80ms RTT), commit latency balloons and lock-hold time throttles hot rows.

**Availability:** any one of 5 participants (or the coordinator) being slow/down blocks the transaction; the system's availability is roughly the **product** of the participants' availabilities → worse than any single service. At 10k req/sec, blocked-and-locked transactions cause queueing collapse.

```
Rough intuition (illustrative, not a benchmark):
  If each service is 99.9% available, 5-way 2PC ≈ 0.999^5 ≈ 99.5% -> ~5x more downtime
  Plus lock-hold time bounds hot-row throughput to ~1 / lock_hold_seconds
```

**What to do instead:** redesign boundaries (A35) so the strongly-consistent core is one service; use a **Saga** for the cross-service business flow with idempotent steps + compensations; make side effects eventual via an **outbox**. Reserve true 2PC for a single strongly-consistent datastore (or a Spanner-class system) — not a chain of 5 independently-deployed services on the hot path.

---

## Bonus — Senior Questions

### AB1. Compensations can fail too

If step 3 fails and compensating step 1 (`refund`) also fails, the saga is in a **partially-compensated, inconsistent state** that must be driven to convergence — you never just give up.

```
Make the saga a durable state machine (workflow engine):
  - Persist saga state after every step/compensation (so recovery knows where it is)
  - Compensations are idempotent + RETRIED WITH BACKOFF until they succeed
  - After N retries -> route to a DEAD-LETTER / human-in-the-loop queue with an alert
  - Never drop it: "eventually consistent" means eventually, via retry, not "maybe"
```

The guarantees: compensations must be **retriable and idempotent**, saga state must be **durable** (a workflow engine like Temporal-style, or your own outbox-driven state), and there must be a **terminal escalation** (dead-letter + operator) for compensations that keep failing (e.g., the payment gateway is down for hours). Convergence is guaranteed by durability + infinite-with-backoff retry, not by hoping the first compensation works.

---

### AB2. Idempotency-key TTL and store placement

```
TTL too SHORT:
  Key expires before a slow client retry arrives -> retry treated as NEW -> double charge.
  Rule: TTL >= max client retry window + max processing time (often 24h+ for payments).

TTL too LONG:
  Store grows unbounded; higher storage cost. Mitigate with TTL/GC, not by shortening below safe window.
```

**Store placement is the subtle one:** if the idempotency key lives in a **different database** than the business write, you've recreated the **dual-write problem** — you might record the key but not the charge (or vice versa) if a crash lands between them.

```
WRONG: key in Redis, charge in Postgres  (two systems, no atomic commit)
        -> crash between them -> key says "done" but charge never happened, or reverse

RIGHT: key row + business write in the SAME database, SAME transaction
        BEGIN; insert idempotency_key; insert/charge business row; COMMIT;
```

If you must use a fast external store (Redis) for the key, treat it as a *lock/hint* and still make the business write itself idempotent (unique constraint), so correctness doesn't depend on the two staying in sync.

---

### AB3. "Both services must agree the customer is a fraud risk before shipping"

**Classification: this is a consistency-model problem, not an atomic-transaction problem.** Nothing needs to commit atomically across services; you need shipping to **read a value that is at least as fresh as the fraud decision** before it acts.

```
Not: 2PC to "agree" (no shared mutation to make atomic)
Yes: read-your-writes / causal consistency between fraud-decision and shipping

Mechanism:
  - Fraud service is the single source of truth for the fraud flag.
  - Shipping does a strongly-consistent (linearizable) READ of the flag before shipping,
    OR consumes the fraud event and only ships after processing it (causal ordering).
  - The invariant "don't ship flagged orders" is a READ freshness guarantee, not an atomic write.
```

The senior insight: not every "they must agree" is a distributed transaction. Here it's a **read consistency** requirement — make shipping's read of the fraud state linearizable (or gate shipping on having consumed the fraud decision event), which is far cheaper than 2PC.

---

### AB4. Counter to "strong consistency everywhere"

**PACELC argument:** "strong everywhere" means paying the **EL→C** cost (latency for consistency) on *every* operation even when there's no partition, and the **PC** cost (reduced availability) during partitions — for data that mostly doesn't need it (feeds, counts, search). That's a large, permanent latency/availability tax to solve problems most of your data doesn't have.

```
Right-size per data class:
  Counters/feeds/search  -> EL (eventual, low latency)
  User profile reads     -> read-your-writes (session guarantee, cheap)
  Money / inventory / unique-name / locks -> EC/PC (linearizable) — pay the cost HERE
```

**The one place to insist on linearizability:** operations that make an **irreversible decision on a shared invariant** — moving money, allocating the last unit of inventory, acquiring a distributed lock / electing a leader, claiming a unique identifier. There, a stale read causes real damage, so you accept the latency and availability cost. Everywhere else, weaker + a session guarantee is the senior default.

---

### AB5. Effectively-once with a consumer you can't change

If the downstream consumer isn't idempotent and is untouchable, insert an **idempotent de-duplication layer in front of it** so it only ever sees each message once.

```
[at-least-once source] -> [DEDUP GATEWAY] -> [non-idempotent consumer]

Dedup gateway:
  on message m with key k:
    if store.setnx(k, ttl):   # atomic "claim" — succeeds only first time
        forward(m) to consumer
    else:
        drop(m)               # duplicate — never reaches the fragile consumer
```

The gateway keeps a dedup store (keyed by message id / business key) and only forwards first-sightings. To be robust, the **claim + forward** should be as close to atomic as possible (e.g., claim, forward, mark-delivered; on crash mid-way, a careful re-forward is safe only if the consumer tolerates it — which it doesn't, so use a transactional queue or an exactly-once-capable broker segment for the gateway↔consumer hop). Alternative: put the non-idempotent consumer behind a message queue with broker-side dedup, or wrap it so its effect is guarded by a unique constraint you *can* add (e.g., a "processed_ids" table checked before the call).

---

## Decision Guide — Quick Reference

### Which atomicity/consistency tool?

| Situation | Best Choice | Reason |
|---|---|---|
| Atomic commit across shards of one strongly-consistent store | 2PC over Paxos/Raft (Spanner-style) | Keeps atomicity, removes SPOF |
| Atomicity across independent microservices | Saga + compensations | Available; no cross-service lock |
| DB write + event must not diverge | Transactional outbox / CDC | One local commit, then at-least-once publish |
| Client retry must not double-execute | Idempotency key (same DB as the write) | Dedup at the write boundary |
| Data only needs to converge | Eventual consistency + idempotent events | Cheapest, highest availability |
| Must read the latest of a shared invariant | Linearizable read (or gate on consumed event) | Correct decision on shared state |

### Which isolation level?

| Use case | Level | Tradeoff |
|---|---|---|
| Reporting/analytics reads | Read Committed | Fast; tolerate non-repeatable reads |
| Read-modify-write on a hot row | `SELECT … FOR UPDATE` (pessimistic) | Serializes hot row, avoids lost update |
| Low-contention updates | OCC / version CAS | No locks; retry on conflict |
| Invariant across multiple rows (write skew risk) | True Serializable / SSI | Correct; occasional retry on serialization failure |

### Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| ACID across DBs | Atomicity is what you lose first — no shared commit log across engines |
| Dual-write problem | DB write + queue publish can't be atomic naively; crash between = permanent divergence |
| CAP (correct) | During a partition choose C or A; P is not optional; NOT "pick 2 of 3" |
| CAP proof | Brewer conjectured 2000; Gilbert & Lynch proved 2002; C = linearizability |
| PACELC | If Partition: A vs C; Else: Latency vs C (Abadi, 2012) |
| CAP-C vs ACID-C | CAP-C = linearizability; ACID-C = invariants preserved |
| Consistency spectrum | Linearizable > sequential > causal > eventual |
| Session guarantees | Read-your-writes, monotonic reads, monotonic writes, consistent prefix |
| 2PC | Prepare/vote then commit/abort; locks held between; coordinator logs decision |
| 2PC blocking | Coordinator dies after YES votes → participants stuck holding locks |
| 3PC | Adds pre-commit for non-blocking; assumes no partitions → unused in practice |
| Fix 2PC | Replicate the coordinator via Paxos/Raft (Spanner does this) |
| Saga | Local txns + compensating txns; Garcia-Molina & Salem 1987; no rollback, only compensate |
| Orchestration vs choreography | Central control+visibility vs loose coupling+emergent flow |
| Saga isolation gap | Committed steps are visible early → dirty reads; use semantic locks / commutativity |
| Pivot transaction | Compensatable steps before it, retriable non-compensatable steps after |
| Outbox | Insert event in the SAME local txn as the business write; relay publishes |
| CDC | Tail WAL/binlog (Debezium) instead of polling; near-real-time, no app query load |
| Exactly-once | Impossible for delivery; achievable for processing = at-least-once + idempotent consumer |
| Idempotency key | Reserve key before work, in same DB; duplicate returns stored result; TTL + request hash |
| Kafka EOS | Idempotent producer (PID+seq) + transactions; consumer read_committed |
| ANSI levels | RU→RC→RR→Serializable prevent dirty→non-repeatable→phantom in turn |
| Snapshot isolation | Reads a consistent snapshot; still allows write skew |
| Write skew | Two txns read overlapping constraint, write different rows, both commit → invariant broken |
| OCC vs pessimistic | CAS/version (low contention) vs locks (hot rows) |
| MVCC | Versioned rows; readers don't block writers; Postgres/InnoDB/Oracle; needs GC/VACUUM |
| Naming trap | Postgres RR & Oracle "Serializable" = snapshot isolation; only SSI stops write skew |
| Avoid the problem | Redesign boundaries so atomic work is one local transaction (DDD aggregate) |
| Spanner | TrueTime + 2PC over Paxos groups; commit-wait for external consistency (PC/EC) |
| Percolator | Client 2PC on Bigtable; primary-lock single-row swap = the atomic commit point |
| Choose model | 2PC (atomic+isolated), Saga (atomic, no isolation), eventual (just converge) |
