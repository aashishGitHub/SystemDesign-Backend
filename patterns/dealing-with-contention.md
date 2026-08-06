# Pattern: Dealing with Contention

> **Interviewer signal:** "the last ticket", "don't oversell", "two users click at the same time", "limited inventory", "flash sale", "one winner", "exactly one driver gets the ride".

Contention is what happens when concurrent actors race for a resource that can only be given to a bounded number of them. The answer is never "use a lock" — it's a **ladder**, and the correct rung depends on how much contention there actually is, whether the resource lives in one database, and how long the critical section has to be held.

📖 Source outline: [hellointerview.com — Dealing with Contention](https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention) (prose paywalled; depth below is this repo's own).

---

## Table of Contents

1. [The Problem: Read-Modify-Write Is Not Atomic](#1-the-problem-read-modify-write-is-not-atomic)
2. [The Ladder — Cheapest Correct Answer First](#2-the-ladder--cheapest-correct-answer-first)
3. [Rung 0: Design the Contention Away](#3-rung-0-design-the-contention-away)
4. [Rung 1: Conditional / Atomic Writes](#4-rung-1-conditional--atomic-writes)
5. [Rung 2: Optimistic Concurrency Control](#5-rung-2-optimistic-concurrency-control)
6. [Rung 3: Pessimistic Locking](#6-rung-3-pessimistic-locking)
7. [Rung 4: Isolation Levels — What the DB Already Gives You](#7-rung-4-isolation-levels--what-the-db-already-gives-you)
8. [Rung 5: Distributed Locks (and Why They're Last)](#8-rung-5-distributed-locks-and-why-theyre-last)
9. [The Hold/Reservation Pattern](#9-the-holdreservation-pattern)
10. [Deadlock: Causes, Prevention, Detection](#10-deadlock-causes-prevention-detection)
11. [The ABA Problem](#11-the-aba-problem)
12. [Performance Under Contention](#12-performance-under-contention)
13. [Decision Framework](#13-decision-framework)
14. [Where This Shows Up in This Repo](#14-where-this-shows-up-in-this-repo)
15. [Real-World Cases](#15-real-world-cases)
16. [Interview Questions](#16-interview-questions)
17. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Problem: Read-Modify-Write Is Not Atomic

One seat left. Alice and Bob both click Buy at the same millisecond.

```sql
-- Alice's request (server A)              -- Bob's request (server B)
SELECT available FROM concerts             SELECT available FROM concerts
 WHERE id='weeknd';    -- → 1               WHERE id='weeknd';    -- → 1
-- "there's one left, proceed"             -- "there's one left, proceed"
UPDATE concerts SET available = 0          UPDATE concerts SET available = 0
 WHERE id='weeknd';                         WHERE id='weeknd';
INSERT INTO tickets …(alice)               INSERT INTO tickets …(bob)
```

Two tickets sold, one seat exists. This is the **lost update** anomaly, and note what caused it: the *decision* was made from a value that was already stale by the time the write landed. The gap between read and write is the entire problem.

The naive-but-wrong fix is `available = available - 1`, which prevents the count from being wrong but happily drives it to `-1`. Correctness needs the **condition** to be evaluated atomically with the write, not before it.

Wrapping both statements in a transaction is *also* not automatically sufficient — at the default isolation level of most databases (Read Committed), two transactions can each read `1` and each write, because Read Committed makes no promise that a value you read is still valid when you write. This is the single most common misconception in this whole area.

---

## 2. The Ladder — Cheapest Correct Answer First

| Rung | Mechanism | Reach for it when | Cost |
|---|---|---|---|
| **0** | Eliminate the shared resource | You can partition by key, or serialize through one owner | Design effort — but zero runtime cost. **Always consider first** |
| **1** | Conditional / atomic write | The contended state is one row or one key | Nearly free, one round trip |
| **2** | Optimistic concurrency (versions) | Conflicts are **rare**; multi-field updates | Retry logic; degrades badly under high contention |
| **3** | Pessimistic locking (`FOR UPDATE`, 2PL) | Conflicts are **common**; critical section is short and inside one DB | Serializes throughput, deadlock risk, connection hogging |
| **4** | Raise isolation level | You need protection against write skew/phantoms across multiple rows | Abort rate, throughput loss |
| **5** | Distributed lock | The resource spans systems and no single DB can arbitrate | Correctness is genuinely hard — needs TTL **and** fencing |

The interview skill being tested is **starting at the bottom of that list and justifying each escalation** — not jumping straight to Redis locks.

---

## 3. Rung 0: Design the Contention Away

The strongest answers often make the race impossible rather than managing it.

**Partition so one owner exists per key.** Route all operations on `seat_42` to a single partition consumed by a single thread. Concurrency control becomes *ordering*, which a log gives you for free:

```
Kafka topic "seat-ops", partition key = seat_id
   ├─ partition 0 → consumer C0 (single-threaded)  ← all ops on seat_42 land here, in order
   └─ partition 1 → consumer C1

Two requests for seat_42 → same partition → processed sequentially.
The second one simply sees seat_42 already SOLD. No lock anywhere.
```

The cost is latency (async) and that a slow consumer becomes a queue backlog rather than user-visible contention. But there's no lock, no deadlock, no retry storm — and it's how high-volume matching engines and ledgers are actually built.

**Split the contended counter.** If 10,000 writers fight over one `inventory` row, give each of 100 shards its own row and have writers pick one at random; read the total as a `SUM`. Contention drops by 100×. The tradeoff: "is there any left?" now requires reading all shards, and reserving the *last* item needs a fallback scan across shards.

**Pre-allocate.** Instead of contending on "give me a number", hand each server a block of 1,000 IDs up front. This is why ID generation uses Snowflake/block allocation rather than a shared counter — see [`url-shortener §3`](../interviews/url-shortener/deep-dive.md#3-id-generation-counters-snowflake-and-the-hash-truncate-trap).

**Use a data type that doesn't conflict.** If the semantics allow convergence rather than exclusion — collaborative text, shopping-cart contents, a set of likes — a CRDT removes the need for mutual exclusion entirely. Contention only exists because you demanded a single serial answer; sometimes you don't need one. See [`collaborative-editing §3`](../interviews/collaborative-editing/deep-dive.md#3-convergence-ot-vs-crdt).

---

## 4. Rung 1: Conditional / Atomic Writes

Push the check into the write so the database evaluates it under its own row lock. **This is the default correct answer for single-row contention** and the one candidates skip past too fast.

```sql
-- Correct: condition and mutation are one atomic statement
UPDATE concerts
   SET available = available - 1
 WHERE id = 'weeknd'
   AND available > 0;          -- ← the guard

-- Then CHECK THE ROW COUNT. 0 rows affected = you did not get it.
```

That `rows_affected` check is the whole pattern. The statement is safe under any isolation level because the database takes a row lock for the duration of the `UPDATE` and re-evaluates the `WHERE` against the committed value.

Equivalents across stores:

| Store | Mechanism |
|---|---|
| PostgreSQL/MySQL | `UPDATE … WHERE cond` + row count; or `INSERT … ON CONFLICT DO NOTHING` |
| DynamoDB | `ConditionExpression` — `attribute_not_exists(pk)` or `available > :zero`; fails with `ConditionalCheckFailedException` |
| Redis | `SET key val NX` (set if absent), `INCR`/`DECRBY` (atomic), or a Lua script for multi-key atomicity |
| Cassandra | Lightweight transactions `IF NOT EXISTS` — but they cost a Paxos round trip, so use sparingly |
| MongoDB | `findAndModify` with a query predicate |

**Uniqueness is a special case with a free answer**: a `UNIQUE` constraint. Two concurrent `INSERT`s of the same username — one succeeds, one gets a constraint violation. No locking code, and the guarantee is enforced by the storage engine rather than your application. Reach for this before anything cleverer.

Redis single-key atomicity deserves a mention because it's so often the right tool: Redis executes commands one at a time on a single thread, so `SET NX` and `INCR` are atomic without any transaction machinery. Multi-key atomicity needs Lua (`EVAL` runs the whole script atomically) — this is exactly how distributed rate limiters are built, see [`rate-limiting §4`](../interviews/rate-limiting/deep-dive.md#4-distributed-limiting-with-redis).

---

## 5. Rung 2: Optimistic Concurrency Control

Assume you'll win, verify at write time, retry if you didn't. The mechanism is a **version column**:

```sql
SELECT id, seats_left, version FROM concerts WHERE id='weeknd';
-- → seats_left=5, version=17
--    …application does arbitrary work with those values…

UPDATE concerts
   SET seats_left = 4, version = 18
 WHERE id = 'weeknd' AND version = 17;      -- ← compare-and-swap

-- 1 row  → success
-- 0 rows → somebody else wrote first; re-read and retry the whole operation
```

**Why versions and not values:** comparing the value you read (`seats_left = 5`) is unsafe because the value may have changed and changed back — the [ABA problem](#11-the-aba-problem). A monotonically increasing version can't be forged by coincidence.

| OCC wins | OCC loses |
|---|---|
| No locks held → no deadlocks, no blocked readers | Wasted work on every conflict — the whole operation replays |
| Nothing held across the user's think-time | Under high contention, retries collide with retries → livelock |
| Works across stateless servers and even across services | Caller must handle a failure that isn't an error, which leaks into API design (HTTP `409 Conflict`, `If-Match`/ETag) |
| Naturally maps to REST: ETag + `If-Match` | No fairness — an unlucky client can starve |

Rule of thumb: OCC is correct when the **expected conflict rate is low**. "Last seat of a Taylor Swift show" is the exact opposite of low. "User edits their own profile" is ideal.

→ [`api-design §4`](../interviews/api-design/deep-dive.md#4-idempotency-and-safe-retries) covers the HTTP surface (ETag/`If-Match`); [`distributed-transactions §14`](../interviews/distributed-transactions/deep-dive.md#14-concurrency-control-mvcc-occ-and-2pl) has the theory side by side with MVCC and 2PL.

---

## 6. Rung 3: Pessimistic Locking

Take the lock first, do the work, release on commit. In SQL that's `SELECT … FOR UPDATE`:

```sql
BEGIN;
  SELECT seats_left FROM concerts WHERE id='weeknd' FOR UPDATE;  -- blocks others
  -- only one transaction is here at a time
  UPDATE concerts SET seats_left = seats_left - 1 WHERE id='weeknd';
  INSERT INTO tickets (concert_id, user_id) VALUES ('weeknd', 'alice');
COMMIT;                                                          -- lock released
```

Variants worth knowing: `FOR UPDATE NOWAIT` (fail instantly instead of blocking) and `FOR UPDATE SKIP LOCKED` — the latter is the standard trick for **queue-in-a-database**, letting N workers each grab different unlocked rows without fighting.

The three ways this goes wrong in production:

1. **Holding a lock across a network call.** `SELECT FOR UPDATE`, then call the payment gateway, then commit. The gateway takes 3 seconds (or 30, or times out) and you've serialized your entire checkout flow behind one row lock while holding a DB connection hostage. **This is the mistake to name in interviews** — it's why the [hold/reservation pattern](#9-the-holdreservation-pattern) exists.
2. **Deadlock** from inconsistent acquisition order — see [§10](#10-deadlock-causes-prevention-detection).
3. **Connection pool exhaustion.** Blocked transactions still occupy connections. 100 requests waiting on one row = 100 connections gone = an outage in a *different*, unrelated part of the system. Contention failures love to present as pool exhaustion.

Pessimistic locking is right when conflicts are frequent (so OCC would thrash), the critical section is **short**, purely inside one database, and involves **no external calls**.

---

## 7. Rung 4: Isolation Levels — What the DB Already Gives You

Concurrency control isn't only something you add; it's something you *configure*. Knowing which anomalies your isolation level still permits is what separates a real answer from a guess.

| Level | Prevents | Still allows |
|---|---|---|
| **Read Uncommitted** | — | Dirty reads and everything below |
| **Read Committed** (Postgres/Oracle default) | Dirty reads | Non-repeatable reads, phantoms, **lost updates across statements**, write skew |
| **Repeatable Read** (MySQL default) / **Snapshot Isolation** | Dirty + non-repeatable reads | Phantoms (in the standard; InnoDB largely blocks them via gap locks), **write skew** |
| **Serializable** | Everything | Nothing — but you pay in aborts (Postgres SSI) or blocking (2PL) |

The anomalies, in interview language:

- **Lost update** — two read-modify-writes, second overwrites first. *This is the ticket-selling bug.*
- **Write skew** — two transactions each read an overlapping set, each check a condition that holds, each write a *different* row, and jointly they break an invariant. Classic case: two doctors both drop off on-call because each sees the other still on call. Snapshot isolation does **not** prevent it, which surprises people.
- **Phantom read** — re-running a range query returns new rows that a concurrent insert added.

**The practical takeaway:** if the invariant spans multiple rows (total inventory across shards, "at least one on-call doctor", double-entry balance), Snapshot Isolation is not enough. You need Serializable, or you need to materialize the conflict into a single row that the concurrent transactions both have to touch — which converts write skew back into a plain lost-update problem you already know how to solve with rung 1.

→ Full treatment: [`distributed-transactions §13`](../interviews/distributed-transactions/deep-dive.md#13-isolation-levels-and-anomalies) · MVCC internals: [`storage-engines §11`](../interviews/storage-engines/deep-dive.md#11-mvcc-and-snapshot-isolation)

---

## 8. Rung 5: Distributed Locks (and Why They're Last)

Needed when the contended resource **isn't inside a single database** — "only one worker may process this file", "only one cron instance may run", "only one node may be the writer".

The naive Redis version, and what's wrong with it:

```
SET lock:job42 <random-uuid> NX PX 30000     ← atomic acquire with TTL
  … do the work …
  release: Lua script that DELs only if value == my-uuid
```

Two non-negotiables:
- **TTL**, or a crashed holder deadlocks the resource forever.
- **Release only if you still own it** (compare the UUID, atomically in Lua) — otherwise a slow holder whose TTL expired deletes the *next* holder's lock.

But even done perfectly, this is **not safe**, and articulating why is a strong senior signal:

```
t=0    Worker A acquires lock, TTL 30s
t=5    Worker A stops the world — GC pause / VM freeze / network partition
t=30   Lock expires. Worker B acquires it legitimately. B starts writing.
t=32   Worker A wakes up, still believing it holds the lock, and writes.
       → Two writers. The lock provided no protection at all.
```

No amount of clock tuning fixes this, because A cannot detect that time passed. The fix is a **fencing token**: the lock service issues a monotonically increasing number with each grant, the client passes it to the *resource*, and the resource rejects any token lower than the highest it has seen. A's stale token 41 is refused because the resource has already seen B's 42. **The resource must participate** — a lock alone can never be safe against a paused holder.

This is the core of the **RedLock debate** (Kleppmann's critique vs. antirez's response): RedLock's multi-node majority acquisition addresses single-Redis-node failure, but the pause/expiry problem is orthogonal to it and remains. The practical conclusion: for efficiency ("don't do duplicate work, and it's fine if we occasionally do") a Redis lock is fine; for correctness ("two writers would corrupt data") you need fencing tokens plus a store that checks them, or a consensus-backed lock service.

**ZooKeeper/etcd locks** are the correctness-grade option: an ephemeral node tied to a session dies automatically when the client's session lapses, sequential nodes give you fair FIFO queueing *and* a natural monotonic fencing token (`zxid`/revision), and the whole thing sits on a real consensus protocol. See [`zookeeper.md`](./zookeeper.md) in this folder and [`consensus §12`](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases).

→ Primers: [`fundamentals/lease.md`](../fundamentals/lease.md) · [`fundamentals/fencing.md`](../fundamentals/fencing.md) · [`fundamentals/split-brain.md`](../fundamentals/split-brain.md)
→ The debate in repo form: [`seat-reservation §4`](../interviews/seat-reservation/deep-dive.md#4-distributed-locks-and-the-redlock-debate)

---

## 9. The Hold/Reservation Pattern

The single most useful applied trick in this whole pattern, because it dissolves the "don't hold a lock across a slow call" problem.

Human checkout takes minutes. You cannot hold a lock that long. So split the operation into a **short, contended claim** and a **long, uncontended completion**:

```
1. CLAIM (milliseconds, contended)
      SET hold:seat42 alice NX EX 600      ← atomic, TTL 10 minutes
      won?  → proceed        lost? → "seat just taken, pick another"

2. COMPLETE (minutes, NOT contended — Alice already owns the claim)
      … Alice enters card details, payment gateway round trip …

3. CONVERT (short transaction)
      verify hold still belongs to Alice, write the booking durably, drop the hold

4. OR EXPIRE
      TTL lapses → seat silently returns to the pool, no cleanup job needed
```

The TTL is doing something subtle and important: it makes **abandonment self-healing**. Alice closing her laptop mid-checkout is indistinguishable from Alice crashing, and both resolve correctly with no compensating action. That's why TTL holds beat "lock rows in a `pending` state and clean up with a cron job" — the cron job is another thing to get wrong.

Three details interviewers push on:
- **The hold is not the booking.** The durable booking still needs its own uniqueness guard at conversion time, because the hold lives in a cache that can lose data. Redis is the *optimizer* for contention; the database remains the source of truth. Two-state model: [`seat-reservation §2`](../interviews/seat-reservation/deep-dive.md#2-hold-vs-booking-the-two-state-model-and-redis-ttl-holds) and [`§5`](../interviews/seat-reservation/deep-dive.md#5-the-seat-state-machine-and-overbooking-prevention).
- **Payment happens outside the lock**, which means payment is now a distributed transaction across your DB and the PSP — that's the [Multi-Step Processes](./multi-step-processes.md) pattern taking over, with a saga and idempotency keys. [`seat-reservation §6`](../interviews/seat-reservation/deep-dive.md#6-payment-acid-boundary-idempotency-and-the-saga)
- **What if payment succeeds after the hold expired?** You must decide the policy explicitly (refund, or honour and overbook) — and you need idempotency so a retried payment doesn't charge twice. [`payment-system §3`](../interviews/payment-system/deep-dive.md#3-idempotency--exactly-once) · [`§4 Never Trust A Timeout`](../interviews/payment-system/deep-dive.md#4-never-trust-a-timeout)

---

## 10. Deadlock: Causes, Prevention, Detection

Deadlock needs four conditions simultaneously — mutual exclusion, hold-and-wait, no preemption, and circular wait. Break any one and it can't happen.

```
Txn 1: LOCK account_A  →  wants account_B
Txn 2: LOCK account_B  →  wants account_A
Both wait forever.
```

**Prevention (do this):**

| Technique | How |
|---|---|
| **Canonical lock ordering** | Always acquire in a deterministic order — e.g. sort by primary key: `LOCK min(A,B)` then `LOCK max(A,B)`. Kills circular wait outright. This is the answer for transfer-between-accounts questions |
| **Single lock / coarser granularity** | Lock the whole account pair as one entity. Less concurrency, no cycles |
| **`NOWAIT` / lock timeouts** | Break hold-and-wait by failing fast, then retry with backoff |
| **Take all locks at once** | Acquire everything up front or nothing at all |
| **Don't lock — serialize** | Rung 0: one owner per key means no second lock holder exists |

**Detection:** databases maintain a wait-for graph, find cycles, and kill a victim transaction (Postgres/InnoDB both do this and return a serialization/deadlock error). So in application code, **deadlock is a retryable error**, not a crash — but a rising deadlock rate is a design smell pointing at inconsistent lock ordering, not something to paper over with retries.

Related but distinct failure: **livelock** — nobody blocks, but nobody makes progress either, because OCC retries keep invalidating each other. Deadlock detection won't help. The cure is backoff with jitter, or moving off OCC to a rung that serializes.

---

## 11. The ABA Problem

You read value `A`, someone changes it to `B` and back to `A`, then you compare-and-swap against `A` and succeed — even though the world changed underneath you.

```
Read balance = 100
   … another txn: withdraw 50 (→50), deposit 50 (→100) …
CAS: "if balance == 100, set to 90"   → SUCCEEDS
But the intervening transactions' invariants (e.g. an overdraft check,
an audit trail, a limit counter) were computed against a state you never saw.
```

The fix is to compare something that **can only move forward**: a version number, a monotonic sequence, or a timestamp — never the payload value. This is why [OCC](#5-rung-2-optimistic-concurrency-control) uses `WHERE version = 17` and not `WHERE seats_left = 5`, and it's the same reason [fencing tokens](#8-rung-5-distributed-locks-and-why-theyre-last) must be monotonic. Same underlying idea as vector clocks needing counters rather than value equality — [`fundamentals/vector-clocks.md`](../fundamentals/vector-clocks.md).

---

## 12. Performance Under Contention

The rung you pick changes *shape* of behaviour as concurrency rises, and this is a great whiteboard moment.

```
Throughput on ONE hot key as concurrent writers N grows:

  Conditional write   ── flat-ish; bounded by row-lock hold time (microseconds)
                          The winner is decided by the DB, cheaply.

  Pessimistic lock    ── ≈ 1 / hold_time, independent of N.
                          Predictable. N-1 clients simply wait (and hold
                          connections — watch the pool).

  OCC                 ── rises, peaks, then COLLAPSES.
                          Each retry re-does work and re-collides;
                          useful work ∝ 1/N while total work ∝ N.

  Queue / single owner ── flat and high; latency grows with backlog,
                          but throughput never collapses.
```

The senior insight: **when one key is hot, no concurrency-control mechanism saves you — the fix is to stop having one hot key.** Shard the counter, partition by key, or serialize through a log. Concurrency control decides *who wins a race*; it cannot manufacture throughput on a single serialization point.

→ Hot-key handling generally: [`sharding-replication §6`](../interviews/sharding-replication/deep-dive.md#6-hot-shards-and-load-imbalance) · [`kv-store §12`](../interviews/kv-store/deep-dive.md#12-capacity-planning-and-hot-partitions) · and the write-side version of this problem in [`scaling-writes.md`](./scaling-writes.md)

Also worth naming: **the thundering herd on a drop.** 500k people hitting the same event at 10:00:00 isn't a concurrency-control problem, it's an admission-control problem. Virtual waiting rooms, queue tokens, and rate limits keep the contended path from being hit by everyone at once — [`seat-reservation §7`](../interviews/seat-reservation/deep-dive.md#7-thundering-herd-and-the-virtual-waiting-room).

---

## 13. Decision Framework

```
Can I avoid a shared mutable resource altogether?
│  (partition by key · single-owner consumer · sharded counters ·
│   pre-allocated blocks · CRDT)
├─ YES ──────────────────────────────────► DO THAT. Rung 0.
│
└─ NO
   │
   ├─ Is the contended state a single row/key in one store?
   │  │
   │  ├─ YES → is uniqueness the whole requirement?
   │  │        ├─ YES ─────────────────► UNIQUE CONSTRAINT
   │  │        └─ NO ──────────────────► CONDITIONAL WRITE
   │  │                                   (+ check rows_affected)
   │  └─ NO (multi-row invariant)
   │           ├─ conflicts rare ──────► OCC (version column)
   │           ├─ conflicts common ────► SELECT … FOR UPDATE
   │           └─ write skew possible ─► SERIALIZABLE, or materialize
   │                                      the conflict into one row
   │
   ├─ Does the critical section include a slow/external call?
   │     ──────────────────────────────► HOLD + TTL, then convert.
   │                                      Never lock across a network call.
   │
   └─ Does the resource span systems (files, jobs, whole-cluster roles)?
         ├─ efficiency only ───────────► Redis lock (NX + TTL + owner check)
         └─ correctness required ──────► ZooKeeper/etcd + FENCING TOKENS
                                          checked by the resource
```

---

## 14. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **Seat reservation (Ticketmaster)** | The canonical contention topic: uniqueness under load, TTL holds, OCC vs pessimistic vs Redis NX, RedLock debate, overbooking prevention | [`§1`](../interviews/seat-reservation/deep-dive.md#1-the-core-problem-uniqueness-under-contention) · [`§2`](../interviews/seat-reservation/deep-dive.md#2-hold-vs-booking-the-two-state-model-and-redis-ttl-holds) · [`§3`](../interviews/seat-reservation/deep-dive.md#3-concurrency-control-optimistic-vs-pessimistic-vs-redis-nx) · [`§4`](../interviews/seat-reservation/deep-dive.md#4-distributed-locks-and-the-redlock-debate) · [`§5`](../interviews/seat-reservation/deep-dive.md#5-the-seat-state-machine-and-overbooking-prevention) |
| **E-commerce** | No-oversell at checkout, and why the cart is deliberately availability-first while checkout is not | [`§4 Checkout & No-Oversell`](../interviews/e-commerce/deep-dive.md#4-checkout-orders--no-oversell) · [`§3 Cart`](../interviews/e-commerce/deep-dive.md#3-the-cart--availability-first) · [`§6 Inventory`](../interviews/e-commerce/deep-dive.md#6-inventory--fulfillment-at-scale) |
| **Distributed transactions** | Isolation levels and anomalies; MVCC vs OCC vs 2PL as a formal comparison | [`§13`](../interviews/distributed-transactions/deep-dive.md#13-isolation-levels-and-anomalies) · [`§14`](../interviews/distributed-transactions/deep-dive.md#14-concurrency-control-mvcc-occ-and-2pl) |
| **Payment system** | Idempotency keys, ambiguous timeouts, double-entry invariants under concurrency | [`§3`](../interviews/payment-system/deep-dive.md#3-idempotency--exactly-once) · [`§4`](../interviews/payment-system/deep-dive.md#4-never-trust-a-timeout) · [`§5 Ledger`](../interviews/payment-system/deep-dive.md#5-the-double-entry-ledger) |
| **Consensus** | Lock/lease/leader-election recipes done correctly; coordination services compared | [`§12`](../interviews/consensus/deep-dive.md#12-recipe-leader-election-locks-and-leases) · [`§11`](../interviews/consensus/deep-dive.md#11-coordination-services-zookeeper-etcd-consul) |
| **Rate limiting** | Redis atomicity and Lua scripts — the same primitive as conditional writes | [`§4`](../interviews/rate-limiting/deep-dive.md#4-distributed-limiting-with-redis) |
| **Storage engines** | MVCC and snapshot isolation from the engine's side | [`§11`](../interviews/storage-engines/deep-dive.md#11-mvcc-and-snapshot-isolation) |
| **Collaborative editing** | The contention you *don't* resolve by locking — convergence instead | [`§3 OT vs CRDT`](../interviews/collaborative-editing/deep-dive.md#3-convergence-ot-vs-crdt) |
| **Ride sharing** | Exactly one driver accepts a ride — contention with a hard latency budget | [`§3 Matching`](../interviews/ride-sharing/deep-dive.md#3-matching-algorithm) · [`§4 Trip Lifecycle`](../interviews/ride-sharing/deep-dive.md#4-trip-lifecycle--state-machine) |
| **Food delivery** | Order placement consistency and idempotency across a 3-sided marketplace | [`§4`](../interviews/food-delivery/deep-dive.md#4-cart--order-placement--consistency-payments-idempotency) |
| **URL shortener** | Contention on ID generation, avoided by pre-allocation instead of a shared counter | [`§3`](../interviews/url-shortener/deep-dive.md#3-id-generation-counters-snowflake-and-the-hash-truncate-trap) |
| **Fundamentals** | The primitives underneath | [lease](../fundamentals/lease.md) · [fencing](../fundamentals/fencing.md) · [split-brain](../fundamentals/split-brain.md) · [quorum](../fundamentals/quorum.md) |

---

## 15. Real-World Cases

| Case | What's actually done | Lesson |
|---|---|---|
| **Airline overbooking** | Deliberately sells more seats than exist, then compensates bumped passengers | "Never oversell" is a *business* requirement, not a physical law. Ask whether overselling is cheaper than the coordination — sometimes the correct engineering answer is a compensation workflow |
| **Ticketmaster / Taylor Swift drops** | Virtual waiting room + queue tokens gate admission before contention is reached | The best contention answer is often admission control upstream of the contended resource |
| **Amazon "only 3 left"** | Reads are from a stale, cached, replicated view; the authoritative decrement happens only at checkout | Read paths and the contended write path have *completely different* consistency requirements. Don't make browsing strongly consistent |
| **Stripe idempotency keys** | Client supplies a key; the server stores the outcome and replays it on retry | Under contention, retries are inevitable, so every mutating endpoint needs a dedupe identity. Contention and idempotency are the same conversation |
| **Bank transfers** | Locks acquired in sorted account-ID order | The textbook deadlock prevention, used verbatim in production |
| **Kafka-based ledgers / matching engines** | Single partition per account/instrument, single-threaded consumer | At the extreme end of correctness *and* throughput, the industry answer is serialization, not locking |
| **DNS/CDN cache stampede** | Request collapsing at the edge so N misses become one origin fetch | Contention isn't only about writes — concurrent *readers* of a missing key contend too. See [`cdn-edge §6`](../interviews/cdn-edge/deep-dive.md#6-origin-shield-request-collapsing-and-cache-stampede) |

---

## 16. Interview Questions

**Q1. Alice and Bob both buy the last seat. Show me the bug, then fix it in one line.**
The bug is a read-modify-write race: both `SELECT` sees `available = 1`, both decide it's safe, both `UPDATE`. The decision was made from a value that was stale by write time. The one-line fix is to make the condition part of the write — `UPDATE concerts SET available = available - 1 WHERE id = ? AND available > 0` — and then check `rows_affected`; zero means you lost and must tell the user. The database takes a row lock for the duration of that statement and re-evaluates the predicate against committed data, so exactly one of the two succeeds.

**Q2. "Just wrap it in a transaction" — is that enough?**
No, and this is the most common misconception here. At Read Committed — the default in Postgres and many others — a transaction guarantees you won't read *uncommitted* data, but it makes no promise that a value you read is still valid when you later write. Both transactions can read `1`, both write, both commit. You need the conditional write, or `SELECT … FOR UPDATE` to actually block the other reader, or Serializable isolation. Transactions give atomicity and durability; preventing lost updates is specifically an *isolation* question.

**Q3. OCC or pessimistic locking — how do you choose?**
By expected conflict rate. OCC holds nothing, so under low contention it's strictly better: no deadlocks, no blocked readers, nothing held across think-time, and it maps cleanly onto HTTP with ETag/`If-Match`. But every conflict discards completed work, so as contention rises retries start colliding with retries and useful throughput collapses. Pessimistic locking makes each waiter block instead of retry, giving predictable throughput of roughly one operation per lock-hold-time regardless of concurrency. So: user edits their own profile → OCC. Last seat of a hyped show → pessimistic, or better, restructure so there's no single hot row.

**Q4 (depth). Why must OCC compare a version number rather than the value you read?**
Because of ABA: the value can change to something else and back before your write, so a value comparison succeeds while the state you reasoned about was genuinely violated in between — any invariant those intervening transactions checked, or counters they touched, happened without your knowledge. A version column can only move forward, so it detects *that a write occurred*, which is what you actually care about. The same monotonicity requirement is why fencing tokens must increment rather than being, say, a random nonce.

**Q5 (depth). You hold `SELECT FOR UPDATE` and then call the payment gateway. What goes wrong?**
Everything. The gateway call is hundreds of milliseconds to tens of seconds, and for that entire window you hold a row lock and a database connection. Every other buyer for that seat blocks; the blocked requests occupy connections; the pool drains; and unrelated parts of the application start failing because they can't get a connection. Contention bugs very often surface as connection-pool exhaustion somewhere else entirely. The fix is the hold/reservation pattern: take a short atomic claim with a TTL, release the lock, let the user pay while holding only the *claim*, then convert with a second short transaction. The TTL makes abandonment self-healing, which a `pending` row plus a cleanup cron does not.

**Q6 (depth). Write skew — what is it, and why doesn't Snapshot Isolation stop it?**
Write skew is two transactions each reading an overlapping set, each verifying a condition that currently holds, then each writing a *different* row — jointly breaking an invariant that neither broke alone. The on-call example: two doctors each check "is someone else on call?", both see yes, both drop off, and now nobody is. Snapshot Isolation doesn't prevent it because SI only guarantees each transaction sees a consistent snapshot and detects *write-write* conflicts on the same row — and here there is no write-write conflict, since the two transactions touch different rows. You need Serializable (Postgres SSI will abort one), or you materialize the conflict by forcing both transactions to write a shared row — a `shift` or `constraint` row — which turns it back into a lost-update problem that a conditional write handles.

**Q7 (senior). Design a distributed lock with Redis. Then tell me why it's not safe.**
Acquire with `SET key <uuid> NX PX 30000` — atomic, and the TTL means a crashed holder doesn't deadlock the resource forever. Release via a Lua script that deletes only if the stored value equals my UUID, so a holder whose lease already expired can't delete its successor's lock. That's the correct implementation, and it's still unsafe: if the holder pauses — GC, VM suspension, partition — for longer than the TTL, the lock expires, a second worker legitimately acquires it, and then the first worker resumes still believing it holds the lock. Two writers, no error anywhere. No clock tuning fixes it, because a paused process cannot detect that it was paused. The fix is a fencing token: the lock grant carries a monotonic number, the client passes it to the resource, and the resource rejects tokens below the highest it has seen. The critical point is that **the resource must participate** — a lock service alone cannot provide mutual exclusion against a paused client.

**Q8 (senior). So is RedLock wrong?**
RedLock solves a different problem than the one people reach for it to solve. Its multi-node majority acquisition removes the single-Redis-node failure mode, which is real. But the pause/expiry hazard is orthogonal and survives RedLock entirely — that's the heart of Kleppmann's critique, and antirez's response mostly disputes the practical severity and the timing assumptions, not that mechanism. My working rule: if the lock is for *efficiency* — avoid duplicate work, and occasional duplication is merely wasteful — a single-node Redis lock is fine and RedLock is over-engineering. If it's for *correctness* — two writers corrupt data or double-spend — I don't rely on any TTL-based lock without fencing, and I'd prefer a consensus-backed service like ZooKeeper or etcd, where a session-tied ephemeral node plus a monotonic revision gives me both automatic release and a natural fencing token.

**Q9 (senior). Two transactions transfer money between the same two accounts and deadlock. Fix it.**
Break circular wait by imposing a canonical acquisition order — sort the account IDs and always lock the lower one first, so `A→B` and `B→A` transfers both lock `min` then `max` and one simply waits. That's the standard production answer. Secondary measures: a lock timeout or `NOWAIT` so a cycle fails fast rather than hanging, and treating the database's deadlock error as retryable in application code, since Postgres and InnoDB both detect cycles and kill a victim. But I'd treat a rising deadlock rate as a design signal about inconsistent lock ordering rather than something to absorb with retries.

**Q10 (senior). 500,000 people hit one event the instant tickets drop. Walk me through the whole stack.**
Contention control alone won't save this, because the problem is arrival rate, not just the race. Upstream I add admission control — a virtual waiting room that issues queue tokens and admits a controlled trickle to the purchase path, so the contended resource never sees 500k concurrent attempts. The browse path is served entirely from cache and read replicas and is allowed to be stale, including the seat map, because showing a seat that was just taken is acceptable while selling it twice is not. The claim itself is a single atomic Redis operation per seat with a TTL hold, so the hot path is one round trip and the loser gets an immediate, cheap rejection rather than a blocked connection. Payment happens outside any lock, as a saga with idempotency keys, and conversion to a durable booking re-verifies the hold under a uniqueness constraint in the authoritative store. I'd also expect to shard seat state so different sections are different keys rather than one contended row, and I'd load-test the *rejection* path, since at these ratios most requests are losers and the failure path is the hot path.

**Q11 (staff). One counter, 10,000 writes/sec, all contending. Nothing you do to the lock helps. Why, and what do you do?**
Because every concurrency-control mechanism only decides *who wins*; none of them create parallelism at a single serialization point. Throughput is capped at roughly one operation per critical-section duration no matter which rung you pick, and OCC is actively worse here because retries multiply work. So the fix has to change the data model, not the locking. Options in order of preference: shard the counter into N rows and have writers pick one at random, reading the total as a `SUM` — contention drops by N, at the cost of exact-remaining checks needing a cross-shard read; or make the write path append-only and aggregate asynchronously, so writers never touch shared mutable state at all; or serialize through a single-owner consumer keyed by the counter, which keeps throughput flat and high while converting contention into queue latency. Which one depends on whether the *exact* current value must gate the write — if it does (last item in inventory), I keep a small authoritative row for the endgame and use sharded counters only while the count is comfortably above zero.

**Q12 (staff). When is overselling the right answer?**
Whenever the expected cost of coordination exceeds the expected cost of compensation. Airlines oversell deliberately and pay bumped passengers, because idle seats cost more than occasional compensation. Applied to design: if the item is fungible and back-orderable, taking the order optimistically and reconciling asynchronously gives far better availability and latency than strong coordination on every write — you accept a small oversell rate and handle it with a refund or a delayed-shipment flow. If the item is unique and non-substitutable — a specific seat, a specific domain name — compensation isn't possible and you must pay for coordination. The senior move in an interview is to *ask which one it is* rather than assuming zero-oversell is a hard requirement, then design a compensation path explicitly instead of pretending failures won't happen.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **Contention** | Concurrent actors racing for a resource with bounded availability |
| **Lost update** | Two read-modify-writes; the second silently overwrites the first. The ticket bug |
| **Why transactions aren't enough** | Read Committed permits lost updates — this is an *isolation* problem, not an atomicity one |
| **Rung 0** | Remove the shared resource: partition by key, single-owner consumer, sharded counters, pre-allocated blocks, CRDTs |
| **Conditional write** | `UPDATE … WHERE guard` + check `rows_affected`. Default answer for one-row contention |
| **Unique constraint** | Free correctness for uniqueness requirements. Try this before any lock |
| **DynamoDB equivalent** | `ConditionExpression` → `ConditionalCheckFailedException` |
| **Redis atomicity** | Single-threaded command execution; `SET NX`, `INCR` atomic; Lua for multi-key |
| **OCC** | Read version → `WHERE version = N` → retry on 0 rows. Great when conflicts are rare |
| **Why version, not value** | ABA — the value can change and change back; a version only moves forward |
| **OCC failure mode** | Livelock — retries collide with retries; useful work ∝ 1/N |
| **Pessimistic** | `SELECT … FOR UPDATE`. Predictable ≈ 1/hold_time throughput; deadlocks; hogs connections |
| **`SKIP LOCKED`** | Queue-in-a-database: N workers grab different rows without fighting |
| **Cardinal sin** | Holding a DB lock across a network/payment call → pool exhaustion elsewhere |
| **Read Committed allows** | Non-repeatable reads, phantoms, lost updates, write skew |
| **Snapshot Isolation allows** | **Write skew** — different rows, jointly broken invariant |
| **Write skew fix** | Serializable, or materialize the conflict into one shared row |
| **Hold/reservation** | Short atomic claim + TTL → user takes their time → convert in a second short txn |
| **Why TTL beats a cleanup cron** | Abandonment and crash resolve identically, with no compensating action |
| **Hold ≠ booking** | Redis optimizes contention; the DB still enforces the durable invariant |
| **Distributed lock musts** | TTL (crash safety) + release-only-if-owner (Lua compare-UUID) |
| **Why locks are still unsafe** | A paused holder can't know its lease expired → two writers, no error |
| **Fencing token** | Monotonic number checked *by the resource*; rejects stale holders. The only real fix |
| **RedLock verdict** | Fine for efficiency locks; insufficient for correctness without fencing |
| **ZooKeeper lock** | Ephemeral+sequential znode = auto-release on session loss, FIFO fairness, built-in monotonic token |
| **Deadlock's 4 conditions** | Mutual exclusion, hold-and-wait, no preemption, circular wait — break any one |
| **Deadlock prevention** | Canonical lock ordering (sort by ID). Deadlock errors are *retryable* |
| **Livelock vs deadlock** | Livelock: nobody blocks, nobody progresses. Detection won't help; backoff or change rung |
| **Hot key truth** | No lock creates throughput at a single serialization point — change the data model |
| **Thundering herd** | Admission control (waiting room, queue tokens) *upstream* of the contended resource |
| **Overselling** | Sometimes correct — compare coordination cost vs compensation cost. Ask, don't assume |
| **Contention ⇒ idempotency** | Retries are inevitable under contention, so mutating endpoints need dedupe keys |

---

## Related

- **Patterns:** [Multi-Step Processes](./multi-step-processes.md) (what happens after you release the lock) · [Scaling Writes](./scaling-writes.md) (hot keys and sharded counters) · [ZooKeeper](./zookeeper.md) (correctness-grade locks) · [Long-Running Tasks](./long-running-tasks.md) (single-consumer serialization)
- **Fundamentals:** [lease](../fundamentals/lease.md) · [fencing](../fundamentals/fencing.md) · [split-brain](../fundamentals/split-brain.md) · [quorum](../fundamentals/quorum.md) · [vector-clocks](../fundamentals/vector-clocks.md)
- **Topics:** [`seat-reservation`](../interviews/seat-reservation/README.md) · [`distributed-transactions`](../interviews/distributed-transactions/README.md) · [`payment-system`](../interviews/payment-system/README.md) · [`e-commerce`](../interviews/e-commerce/README.md) · [`consensus`](../interviews/consensus/README.md)
