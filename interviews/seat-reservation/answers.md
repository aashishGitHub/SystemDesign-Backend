# Answers: Seat Reservation System (Ticketmaster)

> Keyed to [questions.md](./questions.md). Read the questions first — attempt each before coming here.
> Every answer contains code (pseudocode / TS / SQL / Redis) or a comparison table, plus named tradeoffs on decisions that matter.
> Illustrative numbers are labeled "illustrative" — verify against your own load tests before quoting them as fact.

---

## Level 1 — Fundamentals & Requirements

### A1. The single hardest constraint

The hardest constraint is **zero overbooking under high concurrency** — a single seat must be sold to exactly one buyer, even when thousands of users fight for it in the same millisecond. This is a *uniqueness-under-contention* problem, which makes it fundamentally different from a shopping cart.

| Property | Shopping cart | Seat reservation |
|---|---|---|
| Inventory model | Fungible (100 identical widgets) | Non-fungible (seat A14 is unique) |
| Overselling | Tolerable — backorder, apologize, refund | **Never** — you cannot seat two people in one chair |
| Concurrency conflict | Rare, and resolvable after the fact | The *default case* during a hot sale |
| Correctness boundary | Eventual (reconcile stock later) | Strong, at write time (before you say "confirmed") |

**Named tradeoff — consistency vs availability (CAP):** a cart can lean toward availability (add the item, reconcile stock asynchronously). Seat booking must lean toward **consistency at the moment of confirmation** — you would rather reject a valid buyer (they retry) than double-sell a seat (a trust-destroying, refund-generating incident). Amazon's cart famously chose availability (the Dynamo paper); Ticketmaster's seat map cannot.

---

### A2. Three questions before caching an availability count

Before deciding cache vs primary DB for "number of available seats," ask:

```
1. "How stale is acceptable?" (freshness SLA)
   → Marketing badge "1,200 left"  → cache, seconds/minutes of staleness fine.
   → The number the user acts on to buy → must reflect true inventory at write time.

2. "Is this a display count or a decision count?"
   → Display  → read replica or Redis counter, eventually consistent.
   → Decision (the actual hold/purchase) → source of truth, strong consistency.

3. "What is the read rate vs the write rate for this event?"
   → 95% reads on a normal event → cache aggressively.
   → Hot on-sale event → the count changes every millisecond; a cached number
     is wrong before it renders. Show an approximate count and revalidate on click.
```

| Use of the number | Where to read it | Consistency |
|---|---|---|
| "Seats remaining" badge on listing | CDN / Redis counter | Eventual (stale OK) |
| Section heatmap on seat map | Read replica, short TTL | Eventual (stale OK) |
| The hold/purchase attempt itself | Primary + atomic hold | Strong (must be exact) |

**Rule, not "it depends":** cache the *display* count; never let a cached count *authorize* a hold. The hold is always validated against the source of truth.

---

### A3. Hold vs booking

A **hold** is a *temporary, time-bounded reservation* (soft state, TTL-managed, cheap to create and discard). A **booking** is a *durable, paid, committed assignment* (hard state, in the ACID database).

```
Trigger for HOLD:    user clicks "Select Seat" → SET NX in Redis with 10-min TTL
Trigger for BOOKING: payment succeeds → UPDATE seat status to BOOKED in the DB

If the hold expires before booking:
  - Redis TTL fires → hold key disappears
  - Seat returns to AVAILABLE (source of truth was never changed to BOOKED)
  - Any partial checkout state is abandoned; user must re-select
```

| Aspect | Hold | Booking |
|---|---|---|
| Store | Redis (fast, TTL) | Relational DB (durable) |
| Lifetime | 10 min TTL, auto-expires | Permanent until refunded/cancelled |
| On crash | Auto-released by TTL | Survives (durable, D in ACID) |
| Cost of creating | Microseconds, in-memory | A committed transaction |

**Named tradeoff — latency vs durability:** the hold is optimized for latency and self-healing (TTL releases abandoned carts with no cleanup job). The booking is optimized for durability and correctness. Splitting them is the core pattern.

---

### A4. What "overbooking prevention" requires at the systems level

Strip away the business language: overbooking prevention is a **mutual-exclusion (mutex) guarantee over a unique resource key**, enforced by an *atomic compare-and-set* on the transition `AVAILABLE → HELD` and again on `HELD → BOOKED`.

```
Required primitives (any ONE atomic CAS per transition is sufficient):
  Redis:  SET seat NX          → atomic "set if not exists" (test-and-set)
  SQL:    UPDATE ... WHERE status='AVAILABLE'  → conditional update, check rowcount
  SQL:    SELECT ... FOR UPDATE → row-level pessimistic lock
  Version: UPDATE ... WHERE version=?          → optimistic compare-and-swap

The invariant: for a given seat, at most ONE writer can win the transition.
Everyone else observes rowcount=0 (SQL) or nil (Redis) and is rejected.
```

Overbooking is *not* prevented by "checking then setting" as two steps — that check-then-act is the race. It is prevented by making check-and-act a **single atomic operation**. Business rules (refund policy, resale) sit *on top of* this primitive; they never replace it.

---

### A5. Read-heavy vs write-heavy split

```
READ-HEAVY (≈95%, cacheable, eventual consistency OK):
  - Event search / browse (by artist, city, date)
  - Event detail page, venue map rendering
  - Section-level availability counts / heatmap
  - "Seats remaining" badges

WRITE-HEAVY (≈5%, must hit source of truth, strong consistency):
  - Hold a seat (AVAILABLE → HELD)
  - Release a seat (HELD → AVAILABLE)
  - Confirm a booking (HELD → BOOKED)
  - Payment record writes
```

| Path | Store | Scaling lever | Consistency |
|---|---|---|---|
| Read (browse) | CDN + read replicas + Redis | Add caches/replicas freely | Eventual |
| Write (book) | Primary DB + Redis holds | Shard by event; atomic CAS | Strong |

**Why the split matters:** the read path scales *horizontally and cheaply* (caches absorb load, staleness is fine). The write path is the *scarce, correctness-critical* resource — you protect it with holds, queues, and sharding. Conflating them (serving availability from the write path, or authorizing holds from a cache) is the #1 interview mistake. This is CQRS applied to ticketing.

---

## Level 2 — Seat Hold Mechanics

### A6. Click "Select Seat" → checkout timer: step by step

```
1. Client sends: POST /events/123/seats/A14/hold  { userId: 456, idemKey: uuid }
2. API gateway routes to the inventory service shard owning event 123.
3. Inventory service issues the atomic hold in Redis:
      SET event:123:seat:A14  hold:{userId:456,holdId:h789}  NX  PX 600000
4a. Returns OK  → hold acquired:
       - write a hold record (holdId, userId, seat, expiresAt) for audit/recovery
       - return 200 { holdId, expiresAt } to client
       - client starts the 10:00 countdown from expiresAt (server-authoritative)
4b. Returns nil → seat already held:
       - return 409 Conflict "seat unavailable" → client greys out A14, refresh map
5. Client shows the checkout page with the running timer bound to server expiresAt.
```

**Key design point:** the countdown the user sees is derived from the **server's `expiresAt`**, never a client-side clock. The client timer is cosmetic; the Redis TTL is the truth. If the client and server disagree, the server wins (the seat is released exactly when Redis expires the key).

---

### A7. Why Redis for holds, not the primary DB

| Property Redis gives you | Why it matters for holds |
|---|---|
| Native per-key TTL | Auto-release on abandonment/crash — no cleanup cron needed |
| Atomic `SET NX` | Test-and-set in one round trip (the mutex primitive) |
| In-memory latency | Sub-millisecond holds; can absorb flash-sale write rate |
| No long-lived DB locks | Holds don't consume DB connections/row locks for 10 minutes |

If you held seats with `SELECT ... FOR UPDATE` in the primary DB for the full 10 minutes, **every open checkout would pin a DB connection and a row lock**. At 150K concurrent holds you would exhaust the connection pool (typically hundreds, not hundreds of thousands) and stall the whole database. Redis holds are *soft state you can afford to lose* — if Redis drops a hold, the seat just becomes available again (the DB never lied about it being BOOKED).

**Named tradeoff — latency vs durability:** Redis trades durability (a hold can be lost on a crash) for latency and TTL semantics. That trade is acceptable *because* the hold is not the source of truth — the DB `BOOKED` state is. You never trade durability for the booking itself.

---

### A8. Redis commands to hold A14 for 10 minutes

```redis
# Acquire (atomic test-and-set with TTL). Value = unique hold token so we can
# safely release only our own hold later.
SET event:123:seat:A14 "user:456:hold:h789" NX PX 600000
# → "OK"  if the key did not exist (hold acquired)
# → (nil) if the key already exists (seat already held by someone else)

# Safe release (compare-and-delete via Lua — only delete if WE own the hold):
EVAL "if redis.call('GET', KEYS[1]) == ARGV[1]
        then return redis.call('DEL', KEYS[1])
        else return 0 end" 1 event:123:seat:A14 "user:456:hold:h789"
```

- `NX` = set only if the key does **not** exist → this is the mutex.
- `PX 600000` = expire after 600,000 ms = 10 minutes.
- **If already held:** `SET NX` returns `nil`, the second user is rejected with 409.

**Why the Lua compare-and-delete for release?** A naive `DEL` could delete a *different* user's hold if the original TTL already expired and the seat was re-held between your check and your delete. Comparing the token before deleting closes that race. This is the same fencing concern as distributed locks.

---

### A9. Every side effect of a 10-minute hold expiring

"Release the seat" is only step one. A correct expiry produces:

```
1. Seat inventory:      hold key gone in Redis → seat is AVAILABLE again.
2. Availability count:  decrement "held" / increment "available" counter (cache + DB).
3. Seat-map cache:      invalidate/refresh so other users see A14 free.
4. Waiting-room / queue: if demand-gated, signal that inventory freed up.
5. User session:        mark the checkout session EXPIRED; the timer UI shows "hold lost."
6. In-flight payment:   if a payment is mid-flight for this hold, it must be
                        blocked/compensated (see A23) — do NOT let a late payment
                        confirm a seat whose hold already expired.
7. Analytics/metrics:   emit hold_expired event → feeds conversion & abandonment dashboards.
8. Idempotency cleanup: expire the checkout idempotency key so a fresh attempt is clean.
```

**Named tradeoff — precision vs cost:** Redis expiry is *lazy* (a key is removed on access or by a background sampler ~10×/sec over ~20 random keys), so the expired-key notification can lag the nominal TTL by a moment. If you need exact-instant release, don't rely solely on keyspace notifications — also validate the hold's `expiresAt` at confirmation time. Precision costs you an extra check; skipping it costs you a race window.

---

### A10. Adding a second seat to the same order

```
State: user 456 holds A14 (2 min remain, holdId=h789, orderId=o42).

User adds B22 to order o42:
1. Attempt atomic hold on B22:
      SET event:123:seat:B22 "user:456:hold:h790:order:o42" NX PX 600000
2a. OK  → B22 is now held under the SAME order o42.
2b. nil → B22 already held by someone else → reject B22, keep A14.

3. Timer policy decision — two valid choices, pick explicitly:
   (a) Independent TTLs: A14 expires in 2 min, B22 in 10 min. Simple, but the
       order can partially expire (user loses A14 mid-checkout). Confusing UX.
   (b) Unified order TTL: bind both seats to the order and RESET both to a shared
       expiry (e.g., 10 min) on each add. Cleaner UX; the order is atomic in time.
```

| Policy | Pro | Con | Use when |
|---|---|---|---|
| Independent per-seat TTL | Simplest; each hold self-heals | Partial expiry mid-order | Single-seat flows |
| Unified order TTL (recommended) | Order expires as a unit; clean UX | Slightly more state to track | Multi-seat orders |

**Recommendation:** use a **unified order TTL** — model the *order* as the hold unit, extend all member seats to a common `expiresAt`, and enforce a max total hold window (e.g., cap at 15 min) so a user can't extend forever by adding/removing seats.

---

### A11. Redis node crashes with 50,000 held seats

| Topology | What happens on crash | Consequence |
|---|---|---|
| **Single Redis** | All 50K hold keys are lost (unless AOF/RDB replay) | Every held seat becomes AVAILABLE. No double-booking (DB never said BOOKED), but 50K users lose their holds → mass re-contention, angry users. |
| **Redis Sentinel** (1 primary + replicas) | Sentinel promotes a replica; holds written before the last sync survive; holds in the replication gap are lost | Failover in seconds; *some* recent holds lost due to async replication lag. Availability restored, minor hold loss. |
| **Redis Cluster** | Only the slots on the failed shard are affected; other shards keep serving | Blast radius limited to that shard's key range (e.g., some events), not all holds. |
| **RedLock** (N independent masters, acquire on majority) | A single master failing does not lose the lock if a majority still hold it | Higher correctness bar, higher latency and complexity. |

**Named tradeoff — durability vs latency of holds:** holds are *soft state*. Losing a hold is annoying (re-select) but not a correctness violation — the seat simply returns to AVAILABLE, which the DB always agreed with. Because of that, most production systems accept Sentinel/Cluster with async replication rather than paying RedLock's latency for every hold. **RedLock is controversial** (Martin Kleppmann's 2016 critique vs antirez's rebuttal): under GC pauses and clock skew it does not give a hard mutual-exclusion guarantee, so you must still fence at the DB. The final overbooking guarantee lives in the **DB confirmation CAS**, never in Redis alone — treat Redis holds as an optimization, not the correctness layer.

---

## Level 3 — Concurrency & Locking

### A12. Two users grab A14 at the same microsecond

The race: both read `A14 = AVAILABLE`, both decide "it's free," both write `HELD`. Without atomicity, both win → double-booking. Each strategy serializes the two writers:

**(a) Pessimistic `SELECT FOR UPDATE`**
```sql
BEGIN;
SELECT status FROM event_seats
  WHERE event_id=123 AND seat='A14' FOR UPDATE;   -- U1 gets the row lock
-- U2's identical SELECT FOR UPDATE BLOCKS here until U1 commits.
UPDATE event_seats SET status='HELD', hold_id='h789'
  WHERE event_id=123 AND seat='A14';
COMMIT;                                            -- lock released
-- U2 unblocks, now sees status='HELD' → its logic rejects the hold.
```
U1 wins by holding the lock; U2 waits, then loses on re-check.

**(b) Optimistic version column**
```sql
-- Both read version=7.
-- U1:
UPDATE event_seats SET status='HELD', version=8
  WHERE event_id=123 AND seat='A14' AND version=7;   -- rows affected = 1 (wins)
-- U2:
UPDATE event_seats SET status='HELD', version=8
  WHERE event_id=123 AND seat='A14' AND version=7;   -- rows affected = 0 (version moved) → loses
```
No lock held during "think time"; the loser detects the conflict via `rowcount=0` and retries/refreshes.

**(c) Redis `SET NX`**
```redis
# U1:
SET event:123:seat:A14 "hold:U1" NX PX 600000   → OK   (wins)
# U2 (microseconds later):
SET event:123:seat:A14 "hold:U2" NX PX 600000   → nil  (loses; key exists)
```
Redis serializes commands single-threaded per key; exactly one `NX` succeeds.

| Strategy | Winner decided by | Loser learns via | Holds a lock during think time? |
|---|---|---|---|
| Pessimistic | Row lock ownership | Blocked, then re-read | Yes (dangerous for long holds) |
| Optimistic | First to bump version | `rowcount = 0` | No |
| Redis NX | First `NX` to land | `nil` reply | No (TTL, not a DB lock) |

---

### A13. Pessimistic vs optimistic — a concrete rule

**Rule:** use **optimistic** (or Redis `NX`) for the *hold* step, and **pessimistic (`SELECT FOR UPDATE`)** only for a *short, high-contention critical section that must not fail-and-retry* — e.g., the final `HELD → BOOKED` commit for a specific seat, or allocating from a small shared pool (last few GA tickets).

```
Decision by CONTENTION on the specific row:
  Low/medium contention (most seats, most of the time)  → OPTIMISTIC / Redis NX
      cheap, no lock held, loser just retries.
  Very high contention on ONE row (the last seat, a pooled counter) → PESSIMISTIC
      optimistic would livelock (everyone retries, everyone fails again).
```

| Signal | Choose |
|---|---|
| Conflict is rare; retry is cheap | Optimistic (version) / Redis NX |
| Conflict is the norm on one hot row | Pessimistic (`FOR UPDATE`) — serialize, don't retry-storm |
| Hold spans user "think time" (minutes) | **Neither DB lock** — use Redis TTL hold |
| Final atomic commit of a decided seat | Optimistic CAS on `hold_id`+`version` |

**Named tradeoff — throughput vs retry cost:** optimistic maximizes throughput when conflicts are rare (no blocking) but degrades into a retry storm when they're common. Pessimistic serializes cleanly under heavy contention but limits throughput to one writer at a time and risks lock-wait timeouts.

---

### A14. The lost-update problem

The lost update: two transactions read the same value, both compute from the stale read, and the second write silently clobbers the first — so two users "book" the same seat.

**Reproduce it (read-modify-write with no guard):**
```sql
-- T1                                   -- T2
SELECT status FROM event_seats          SELECT status FROM event_seats
  WHERE seat_id=42;  -- 'AVAILABLE'       WHERE seat_id=42;  -- 'AVAILABLE'
UPDATE event_seats                       -- (T2 also thinks it's free)
  SET status='BOOKED', user_id=1
  WHERE seat_id=42;  -- succeeds
COMMIT;                                  UPDATE event_seats
                                           SET status='BOOKED', user_id=2
                                           WHERE seat_id=42;  -- OVERWRITES → user 1 lost
                                         COMMIT;
```

**Prevent it (conditional update — the CAS guard):**
```sql
-- T2's write now checks the precondition it assumed:
UPDATE event_seats
  SET status='BOOKED', user_id=2
  WHERE seat_id=42 AND status='AVAILABLE';   -- rows affected = 0 for the loser
-- application checks rowcount: 0 → "seat no longer available", do NOT confirm.
```

Equivalent guards: a `version=?` predicate (optimistic), `SELECT ... FOR UPDATE` (pessimistic), or serializable isolation (DB aborts one txn). The essential fix is that the write's `WHERE` clause **re-asserts the state the read observed**.

---

### A15. When optimistic degrades worse than pessimistic

Optimistic locking degrades worse than pessimistic under **high contention on the same row** — many concurrent writers to one hot seat/counter. Each attempt reads, tries to CAS, fails (`rowcount=0`), and retries; the collective throughput collapses into a *retry storm* (livelock-like), while pessimistic would have quietly queued them one at a time.

```
Contention regime:
  Low conflict:  optimistic wins (no locks, high concurrency).
  High conflict: optimistic pays N reads + N failed writes + N retries per success.
                 Pessimistic pays 1 lock-wait queue → linear, predictable.
```

**Metric to watch:** the **CAS/optimistic-retry rate** (or "update conflict rate" = writes with `rowcount=0` ÷ total write attempts). Related: transaction abort rate under serializable isolation.

```promql
# Alert when optimistic retries dominate:
rate(seat_update_conflicts_total[1m]) / rate(seat_update_attempts_total[1m]) > 0.2
# > 20% of writes conflicting → switch that hot row/pool to pessimistic or a queue.
```

**Named tradeoff — throughput vs predictability:** optimistic favors throughput at low contention; pessimistic favors predictable latency at high contention. When the conflict rate crosses ~10–20% (illustrative threshold — tune per workload), route that specific hot resource through a pessimistic lock or a serialized queue.

---

### A16. Redis says HELD, a read replica says AVAILABLE — what prevents double-booking?

The stale replica can *mislead the display*, but it can never *authorize the second hold*, because the hold is granted by an **atomic write to the source of truth (Redis / primary), not by the stale read**.

```
Sequence:
1. User A holds A14 → Redis: SET A14 NX → OK. (Redis = HELD)
2. DB primary not yet updated (or async replica lags) → replica shows AVAILABLE.
3. User B's browse hits the replica → UI shows A14 as free (stale, cosmetic).
4. User B clicks "Select A14" → server does NOT trust the replica.
   It issues the ATOMIC hold: SET event:...:A14 NX PX 600000
5. Redis already has the key → returns nil → User B is rejected (409).
   → No double-booking. The stale read only cost User B a wasted click.
```

**The principle:** *reads can be stale; the write is always validated against the authority.* You never let a read (cached or replicated) be the gate for a state transition. Display uses eventual consistency; the transition uses strong consistency (atomic CAS). This is exactly why you segment read path from write path (A5).

---

### A17. (Failure mode) Seat-hold service loses Redis for 30 seconds — fail-open vs fail-closed

| Strategy | Behavior when Redis is unreachable | Business consequence |
|---|---|---|
| **Fail-open** | Grant holds anyway (skip the Redis check) | Sale keeps running, but you lose the mutex → risk of **double-holds / overbooking**. Never fail-open on the correctness primitive. |
| **Fail-closed** | Reject new holds ("please retry in a moment") | No overbooking, but **lost sales & bad UX** for 30s during peak demand. |

**Recommendation:** for the *hold* primitive, **fail closed** — a brief "try again" beats an overbooking incident that costs refunds, chargebacks, and trust. Soften it with:
```
- A fast, bounded circuit breaker: after N Redis errors, trip open, show
  "high demand, retrying…" and back off; probe Redis; close when healthy.
- A secondary correctness net: even a fail-open path must still pass the
  DB confirmation CAS (A18) before BOOKED — so a Redis outage can at worst
  double-HOLD, never double-BOOK.
- Redis Sentinel/Cluster so a 30s single-node loss becomes a sub-10s failover.
```
**Named tradeoff — availability vs correctness:** fail-open buys availability at the cost of the no-overbooking invariant; fail-closed protects the invariant at the cost of availability. For a *zero-overbooking* system, correctness wins — but you engineer the outage window down (failover, circuit breaker) so the availability cost is small.

---

## Level 4 — Payment Flow & ACID Transactions

### A18. ACID boundary for confirming a booking

You **cannot put the external payment charge inside the DB transaction** — payment is a remote call to Stripe/Braintree that can take seconds and can't be rolled back by `ROLLBACK`. So the correct boundary is: keep the *local, related writes* in one ACID transaction, and treat the *payment* as an external step coordinated by a saga (A21) with idempotency.

```sql
-- ACID transaction (all-or-nothing) at CONFIRMATION time, AFTER payment authorized:
BEGIN;
  UPDATE event_seats
     SET status='BOOKED', booking_id=:bid, hold_id=NULL, version=version+1
   WHERE event_id=:eid AND seat IN (:seats)
     AND status='HELD' AND hold_id=:holdId;      -- CAS: hold still valid?
  -- assert affected rows == number of seats; else ROLLBACK (hold expired/stolen)
  INSERT INTO bookings (booking_id, user_id, event_id, amount, payment_ref, status)
       VALUES (:bid, :uid, :eid, :amt, :paymentRef, 'CONFIRMED');
  INSERT INTO payments (payment_ref, booking_id, status) VALUES (:paymentRef,:bid,'CAPTURED');
COMMIT;
```

**What must be inside the same transaction:** seat status flip + booking row + local payment record — because they must all commit or all abort together.

**If payment succeeds but the DB write fails:** you have a charged card with no booking. Recovery: the payment step wrote an idempotent record *before* charging (A20/A22), so a retry/reconciler either (a) completes the booking using the existing charge, or (b) issues a **compensating refund**. Never leave money captured with no seat.

**Named tradeoff — atomicity vs latency (2PC vs saga):** a true 2PC spanning DB + payment provider would give atomicity but the coordinator blocks and payment providers don't offer XA — so you accept a saga with compensation. You trade strict atomicity for availability and use idempotency + reconciliation to reach eventual correctness.

---

### A19. Double-click "Pay Now" → prevent double charge

Two identical requests must map to **one** charge. Use an **idempotency key** that is stable across retries for the *same logical payment*, and enforce uniqueness before charging.

```typescript
// Idempotency key is deterministic per checkout attempt (not per HTTP request):
function idempotencyKey(userId: string, orderId: string, holdId: string): string {
  // Stable across double-clicks/retries of the SAME order+hold.
  return sha256(`${userId}:${orderId}:${holdId}`);
}

async function pay(order: Order): Promise<PaymentResult> {
  const key = idempotencyKey(order.userId, order.id, order.holdId);

  // Insert-first: a UNIQUE constraint on idempotency_key is the real guard.
  const inserted = await db.query(
    `INSERT INTO payment_attempts (idempotency_key, order_id, status)
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [key, order.id]);

  if (inserted.rowCount === 0) {
    // Someone (the first click) already owns this key → return its result, do NOT charge again.
    return await getExistingResult(key);
  }

  // We won the race → charge exactly once, passing the SAME key to Stripe:
  return await stripe.charges.create({ amount: order.total, ... },
                                     { idempotencyKey: key });
}
```

Two layers of protection: your **DB unique constraint** (`ON CONFLICT DO NOTHING`) and the **payment provider's own idempotency key** (Stripe/Braintree dedupe on their side too). Belt and suspenders — the provider protects you even if your app double-fires.

---

### A20. Payment captured, booking service crashes before writing CONFIRMED

The card is charged, the seat is not yet BOOKED. Recovery must be **idempotent and self-healing**, never a manual scramble.

```
Preconditions that make recovery possible:
  - Before charging, you persisted intent: an OUTBOX / payment_attempts row
    keyed by idempotencyKey with status PENDING (so you know a charge may exist).
  - The charge carried that idempotencyKey → the provider can tell you its status.

Recovery flow (reconciler / saga resume, runs on restart + on a timer):
  1. Find payment_attempts stuck in PENDING past a threshold.
  2. Ask the provider: GET charge by idempotencyKey.
     - CAPTURED and no booking → COMPLETE the booking now (idempotent UPDATE seat→BOOKED
       WHERE hold_id still valid). Mark attempt CAPTURED.
     - CAPTURED but hold expired / seat taken → COMPENSATE: auto-refund + notify user.
     - NOT captured → safe to cancel the attempt; release nothing extra.
  3. Emit an event either way (ticket issued OR refund issued) so the user is made whole.
```

**Named tradeoff — consistency vs availability (saga eventual consistency):** you can't make "charge + book" atomic, so you accept a brief window of inconsistency and *guarantee eventual correctness* via a durable outbox + reconciler. The invariant you never violate: **money captured ⇒ eventually either a valid booking or a refund.**

---

### A21. Saga for hold → charge → confirm → issue ticket

Model the booking as a **saga** (a sequence of local transactions, each with a compensating action). Prefer **orchestration** (a central saga coordinator) over choreography here, because the flow is linear and you want one place to drive compensation.

| Step | Forward action | Compensating action |
|---|---|---|
| 1. Hold | `SET NX` seat in Redis (10-min TTL) | `DEL` hold (compare-and-delete) |
| 2. Charge | Capture payment via provider (idempotent) | Refund the charge |
| 3. Confirm | `UPDATE seat → BOOKED` (CAS on hold_id) | `UPDATE seat → AVAILABLE` + cancel booking |
| 4. Issue ticket | Generate/deliver e-ticket (barcode) | Void/revoke the ticket |

```
Orchestrator pseudocode (each step idempotent; state persisted after each):
  try:
    hold   = acquireHold(seat)              # comp: releaseHold
    charge = capture(payment, idemKey)      # comp: refund(charge)
    booking= confirm(seat, hold, charge)    # comp: unconfirm(booking)
    ticket = issue(booking)                 # comp: void(ticket)
    return success(ticket)
  except StepFailure as f:
    for step in reverse(completed_steps):   # run compensations in reverse order
        step.compensate()
    return failure(f)
```

**Named tradeoff — atomicity vs availability:** a saga gives you *no global rollback* (unlike 2PC) — instead it reaches a consistent state via compensations. You accept temporary inconsistency and design every step to be idempotent and every compensation to be safe to run more than once. This is the standard pattern in microservice payments (widely described in Chris Richardson's microservices patterns and used across e-commerce/travel).

---

### A22. Payment provider returns HTTP 408 (timeout) — did the charge go through?

A timeout is **ambiguous**: the charge may have succeeded, failed, or be in-flight. You must **never blindly retry a raw charge** (that risks a double charge). Resolve the ambiguity with idempotency + a status query.

```
On 408 / network timeout:
  1. Do NOT create a new charge blindly.
  2. Retry using the SAME idempotencyKey:
       - The provider dedupes: if the first charge landed, you get that same result
         back (no second charge). If it didn't, this creates exactly one.
  3. OR query status by idempotencyKey / your reference:
       result = provider.retrieveByIdempotencyKey(key)
       switch(result.status):
         SUCCEEDED → proceed to confirm booking
         FAILED    → surface error, keep hold if TTL remains, let user retry
         PENDING/UNKNOWN → backoff + poll; do not confirm yet
  4. Bound the ambiguity window: if unresolved before hold TTL, either extend the
     hold (mark seat PENDING_PAYMENT so TTL doesn't release it) or compensate.
```

**The rule:** the idempotency key turns an unsafe retry into a safe one. Timeouts become a *query* problem, not a *re-charge* problem. Both Stripe and Braintree explicitly support idempotency keys for exactly this "unknown outcome" case.

---

### A23. (Failure mode) Hold expires at the same millisecond payment completes — both users think they own A14

This is the nastiest race. The fix is that **Redis expiry does NOT decide ownership — the DB confirmation CAS does**, and that CAS re-checks the hold.

```
Prevention layers:
1. Don't let a seat mid-payment be freely re-held. When payment starts, transition
   the seat to a PENDING_PAYMENT state (or renew/lengthen the hold) so a naive TTL
   expiry can't hand it to user B during the charge.
2. Fence the confirmation with a conditional write (the ultimate arbiter):
     UPDATE event_seats
        SET status='BOOKED', booking_id=:b1
      WHERE seat='A14' AND status='HELD' AND hold_id=:holdA;   -- U1's hold id
     -- rows affected:
     --   1 → U1's hold was still valid → U1 booked. U2 will fail its own confirm.
     --   0 → hold already gone/re-held by U2 → U1 did NOT book → REFUND U1 (compensate).
3. If U1's confirm returns 0 rows: the charge already happened → auto-refund U1
   and apologize (comp transaction), OR try to place U1 on a comparable seat.
4. Use a fencing token: the hold carries a monotonic token; the DB rejects a
   confirmation carrying a stale token (guards against clock-skew / GC-pause holds).
```

Only **one** of U1/U2 can win the DB CAS on A14 (`rows affected = 1`); the other gets `0` and is compensated. Two users can never both hold a *confirmed* row, because `status='HELD' AND hold_id=?` can match for exactly one writer. Redis is an optimization; the DB row is the truth.

**Named tradeoff — consistency vs UX:** protecting the invariant means occasionally refunding a user whose payment landed a hair too late. That's a worse UX than "you got the seat," but far better than double-selling it. You buy correctness with an apology + refund path.

---

## Level 5 — Flash Sale Handling & Thundering Herd

### A24. 10:00:00 AM, 150K users, naive architecture — what happens

```
At 10:00:00.000, ~150,000 clients fire "Buy" within the same second:
  - Each triggers seat-map load + availability read + hold attempt → ~3–5 requests each
    → ~500K–750K requests hit the origin in the first second (illustrative fan-out).
  - The DB connection pool (say 500 connections) saturates in milliseconds.
  - Hold/confirm queries queue behind locks on the hottest seats (front row).
  - Latency spikes → clients time out → clients RETRY → load multiplies (retry storm).
  - Health checks fail → autoscaler thrashes / instances get killed → cascading failure.
  - Net result: the whole service falls over; even users who "got in" get errors mid-checkout.
```

This is precisely the **thundering herd**, and it is what publicly took down Ticketmaster's Eras Tour presale in November 2022 (Ticketmaster's own statement cited ~3.5 billion total system requests that day — roughly 4× their prior peak, per their public post; treat the exact figure as their reported number). The naive design routes *arrival rate*, not *admitted rate*, at the database.

---

### A25. Virtual queue (waiting room) — what it is and the architecture

A **virtual queue / waiting room** is a stateless front gate that admits users into the buying flow at a *controlled rate* instead of letting the full arrival burst hit inventory. It converts a spike into a steady stream.

```
        150K users hit the sale URL at 10:00:00
                        │
             ┌──────────▼───────────┐
             │  WAITING ROOM (edge)  │  stateless, served from CDN/edge worker
             │  - assigns queue pos  │  (Cloudflare Waiting Room / Queue-it style)
             │  - shows "you are #N"  │
             └──────────┬───────────┘
                        │  admits in batches (e.g., 5K/min, rate = f(inventory capacity))
             ┌──────────▼───────────┐
             │   ADMISSION TOKEN     │  signed token (JWT) → grants entry for a window
             └──────────┬───────────┘
                        │  only admitted users pass
             ┌──────────▼───────────┐
             │ SEAT INVENTORY SVC    │  sees ~5K/min, never 150K at once
             │ (holds, confirm)      │  strong-consistency write path, sharded by event
             └──────────┬───────────┘
                        ▼
                   DB (primary) + Redis holds
```

The inventory service is **capacity-planned for the admitted rate, not the arrival rate** — that decoupling is the entire point. The waiting room absorbs the burst; the DB only ever sees the drip.

---

### A26. Fair, tamper-proof queue positions for 150K arrivals in one second

Two properties needed: **fairness** (ordering by true arrival) and **tamper-proofness** (a user can't forge a better position).

```
Assign position atomically:
  Option A — Redis atomic counter (simple, single hot key):
     pos = INCR queue:event:123:counter        # monotonic, atomic
  Option B — Redis Sorted Set (supports fairness + fast rank queries):
     ZADD queue:event:123 <arrivalTimestampMicros> <userId>
     rank = ZRANK queue:event:123 <userId>     # ordered by arrival time

Make it tamper-proof:
  - Return a SIGNED token (JWT/HMAC) carrying {userId, eventId, position, issuedAt}.
    The user cannot alter position without breaking the signature.
  - Bind the token to the user/session so it can't be traded or replayed.
  - Server is the sole authority for position; the client only displays it.
```

| Structure | Gives you | Cost |
|---|---|---|
| `INCR` counter | O(1) atomic position; dead simple | Single hot key; ties by call order only |
| Sorted set (`ZADD`/`ZRANK`) | Ordering by true arrival time; rank lookups | More memory; O(log N) ops |

**Named tradeoff — fairness precision vs hot-key throughput:** a single `INCR` is the cheapest but funnels all 150K writes through one key (shard it or use a token-bucket per edge node if that key gets hot). A sorted set gives richer fairness (true timestamps, position queries) at higher memory/CPU. For most sales, a signed token + `INCR` (optionally per-shard counters merged) is enough.

---

### A27. User closes the tab and returns 20 minutes late (would've been admitted 15 min ago)

Policy decision — pick one and state it explicitly (all are defensible; the middle is best):

| Policy | Behavior | Tradeoff |
|---|---|---|
| Strict expiry | Position forfeited; user re-queues at the back | Simple; harsh UX; punishes flaky networks |
| **Grace window (recommended)** | Admission token valid for a bounded window (e.g., 5–10 min); within it they re-enter at their spot; past it they re-queue | Balances fairness vs UX; reclaims abandoned slots |
| Persistent position | Position held indefinitely until used | Fairest to the user; lets no-shows block real buyers; gameable |

```
On return with a queue token:
  if token.admittedAt exists AND now - token.admittedAt <= graceWindow:
      → let them into the buying flow (their admitted slot is still valid)
  elif token still WAITING and valid:
      → restore their current live position (they never lost their place)
  else (admitted slot expired / token stale):
      → re-issue a new position at the current tail; explain clearly in UI
```

**Recommendation:** admission grants a **bounded entry window** (e.g., 10 minutes). If they miss it, the slot is reclaimed for the next real user — otherwise no-shows starve genuine buyers, which is both unfair and wasteful of scarce inventory.

---

### A28. Setting and dynamically adjusting the admission rate

The admission rate is a **closed-loop control problem**: admit as fast as the inventory/DB tier can safely absorb, and back off when it strains.

```
Base rate (open-loop start):
  admit_rate = safe_inventory_throughput × conversion_headroom
  e.g., inventory can sustain 5,000 holds/sec at p99<500ms → start near that.

Dynamic signals (close the loop — throttle down / speed up):
  ↓ throttle admission when:
     - inventory service p99 latency > SLA (e.g., >500ms)         [latency]
     - DB connection-pool utilization > 80%                       [saturation]
     - hold→book conversion dropping (users failing to complete)  [downstream stress]
     - error/timeout rate on holds rising                         [errors]
  ↑ increase admission when:
     - p99 well under SLA AND pool utilization < 60% AND error rate low
     - queue depth is large (drain faster while headroom exists)
```

| Signal | Threshold (illustrative) | Action |
|---|---|---|
| Inventory p99 latency | > 500 ms | Reduce admission rate |
| DB pool utilization | > 80% | Reduce admission rate |
| Hold error/timeout rate | > 1% | Reduce admission rate |
| p99 latency | < 250 ms and pool < 60% | Increase admission rate |

**Named tradeoff — throughput vs stability:** admit too fast and you recreate the thundering herd; admit too slow and the sale drags and users abandon. A PID-style / AIMD controller (additively increase, multiplicatively back off on stress) keeps the DB near a safe utilization target (e.g., 60–70%) — the same headroom logic used for capacity planning.

---

### A29. (Failure mode) Bots exhaust the queue token pool — mitigation at the waiting-room layer, and Ticketmaster 2022

Bots are fast, parallel, and patient — they'll claim positions and holds faster than humans. Mitigation must happen **at the waiting room, before the seat-selection layer** (once bots reach inventory, it's too late).

```
Bot mitigation stack at the gate:
  1. Identity/verification friction: account age, verified email/phone,
     "Verified Fan"-style pre-registration (raises cost of mass accounts).
  2. Bot detection: device fingerprinting, behavioral signals (mouse/timing),
     CAPTCHA / proof-of-work challenge on suspicious sessions.
  3. Rate limits per identity/IP/ASN + anomaly detection (thousands of positions
     from one ASN in one second → block/deprioritize).
  4. Signed, non-enumerable tokens: no guessable sequential IDs to script against.
  5. WAF + managed bot rules (Cloudflare/Akamai bot management) at the edge.
  6. Reserve/prioritize verified-human lanes; deprioritize unverified traffic.
```

**What Ticketmaster got wrong in 2022 (per public reporting and the January 2023 U.S. Senate hearing):** bot and non-verified traffic overwhelmed the presale, bots consumed queue capacity, and that automated load reached the seat-selection layer — combined with under-provisioning the queue for the true demand. The lessons codified here: **verify humans and filter bots at the gate, capacity-plan the queue for real demand, and never let unverified automated traffic touch inventory.** (Some specifics are drawn from public statements/testimony; treat exact internal details as reported rather than confirmed engineering facts.)

---

### A30. Scaling inventory to 5,000 holds/sec while keeping no-overbooking

Scale **horizontally by partitioning on `event_id`** so each seat has exactly one authoritative owner, then keep the per-seat mutex intact.

```
Sharding: partition inventory by event_id (all seats of one event on one shard).
  → Requests for event 123 route to the shard/Redis owning event 123.
  → Different events scale independently across shards → linear horizontal scale.

No-overbooking preserved because:
  - The mutex is per-SEAT (SET NX / row CAS). Sharding doesn't weaken it; each seat
    still has a single owner that serializes writes to it.
  - Stateless inventory service instances → add pods behind the shard; the atomic
    op (Redis NX / DB CAS) is the serialization point, not the app instance.

The catch — a single mega-event is a HOT SHARD:
  One Taylor Swift event can exceed one shard's capacity.
  Mitigation: sub-shard within the event by SECTION (event:123:sectionA on shard1,
  sectionB on shard2). Seats never cross sections, so the per-seat mutex is intact
  and load spreads. Fall back to the virtual queue to cap the admitted rate.
```

| Scaling axis | What it buys | Limit |
|---|---|---|
| Add stateless inventory pods | More request handling | Bounded by the shard/Redis/DB behind them |
| Shard by event_id | Independent events scale linearly | One hot event still lands on one shard |
| Sub-shard by section | Spreads a single hot event | More routing complexity |
| Virtual queue in front | Caps admitted rate to safe throughput | Adds latency (queue wait) |

**Named tradeoff — throughput vs coordination:** finer sharding raises throughput but adds routing/coordination complexity; the virtual queue caps demand so you don't have to over-shard. Combine both: shard for baseline scale, queue for the burst.

---

## Level 6 — Database Design

### A31. Schema for venue → section → row → seat, and the seat-selection index

Two layers: **static physical layout** (venue-owned, reused across events) and **per-event seat state** (the `event_seats` instance table — see B1 for why they must be separate).

```sql
CREATE TABLE venues (
  venue_id     BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,
  city         TEXT NOT NULL
);

CREATE TABLE sections (
  section_id   BIGINT PRIMARY KEY,
  venue_id     BIGINT NOT NULL REFERENCES venues(venue_id),
  name         TEXT NOT NULL              -- 'Section B', 'Floor', 'Balcony'
);

CREATE TABLE rows (
  row_id       BIGINT PRIMARY KEY,
  section_id   BIGINT NOT NULL REFERENCES sections(section_id),
  row_label    TEXT NOT NULL              -- 'Row 3'
);

CREATE TABLE seats (                      -- PHYSICAL seat, venue-time, reused per event
  seat_id      BIGINT PRIMARY KEY,
  row_id       BIGINT NOT NULL REFERENCES rows(row_id),
  seat_label   TEXT NOT NULL,             -- 'A14'
  x_coord      INT, y_coord INT           -- for interactive map rendering
);

CREATE TABLE events (
  event_id     BIGINT PRIMARY KEY,
  venue_id     BIGINT NOT NULL REFERENCES venues(venue_id),
  artist       TEXT, starts_at TIMESTAMPTZ
);

CREATE TABLE event_seats (                -- PER-EVENT state (the write-path table)
  event_id     BIGINT NOT NULL REFERENCES events(event_id),
  seat_id      BIGINT NOT NULL REFERENCES seats(seat_id),
  status       SMALLINT NOT NULL,         -- 0=AVAILABLE 1=HELD 2=BOOKED
  hold_id      TEXT,                      -- current hold token (NULL if not held)
  booking_id   BIGINT,
  price_cents  INT NOT NULL,
  version      INT NOT NULL DEFAULT 0,    -- optimistic-lock column
  PRIMARY KEY (event_id, seat_id)
);
```

**Indexes required for the seat-selection query:**
```sql
-- The seat map query filters by event and (often) section/status:
CREATE INDEX idx_event_seats_map ON event_seats (event_id, status);
CREATE INDEX idx_event_seats_section
   ON event_seats (event_id, seat_id) INCLUDE (status, price_cents);  -- covering
-- Composite PK (event_id, seat_id) already covers point lookups for a hold.
```
The composite PK `(event_id, seat_id)` co-locates an event's seats and makes both the map scan and the single-seat hold efficient.

---

### A32. Seat-map query for 80,000 seats under 200 ms

```sql
-- The query (all seats for an event with status):
SELECT seat_id, status, price_cents
  FROM event_seats
 WHERE event_id = 123;            -- uses idx_event_seats_map / covering index
```

At 80,000 rows this is a range scan, not 80K point lookups. To keep it under 200 ms and cheap at scale, **cache and serve deltas**, don't re-query the DB per viewer:

```
Layered read strategy:
  1. Covering index (above) so the DB scan is index-only (no heap fetches).
  2. Cache the rendered seat map in Redis per event; TTL short (seconds).
       key: seatmap:event:123  → compact payload of seat→status.
  3. Serve MOST viewers from cache; on a status change, publish a DELTA
     (seat X → HELD) over WebSocket/SSE instead of re-sending 80K rows.
  4. Compact representation: a BITMAP/packed array (2 bits/seat) → 80K seats
     ≈ 20 KB (2 bits × 80,000 / 8), vs multi-MB of JSON rows. Cheap to ship & diff.
```

| Technique | Effect |
|---|---|
| Covering index | Index-only scan, no random heap I/O |
| Redis seat-map cache | Most viewers never touch the DB |
| Delta push (WebSocket/SSE) | Send only changed seats, not the full map |
| Bitmap encoding (2 bits/seat) | ~20 KB payload; fast transfer and diff |

**Named tradeoff — freshness vs load:** a cached map may be a second stale, but the *hold* still validates against the source of truth (A16), so staleness is cosmetic. You trade a moment of display staleness for orders-of-magnitude less DB load.

---

### A33. Sharding the seat inventory DB — shard key and what breaks

**Shard key: `event_id`.** All seats for one event live on one shard, so seat-map reads and holds for an event hit a single shard (no cross-shard transaction to hold N seats in one order).

```
Shard by event_id (hash or range):
  shard = hash(event_id) % num_shards
  → event 123's 80K seats all on shard 5.
  → A multi-seat hold within event 123 = single-shard transaction. 

What BREAKS with this shard key:
  1. HOT SHARD: a single mega-event (Taylor Swift) overloads its one shard while
     others idle. Fix: sub-shard that event by section; front with the virtual queue.
  2. CROSS-EVENT queries ("all events at venue X tonight", "user's bookings across
     events") now fan out across shards → scatter-gather, slower. Serve those from
     a separate read model / search index (A34), not the sharded inventory DB.
```

| Shard key | Pro | Con |
|---|---|---|
| **event_id (recommended)** | Multi-seat order = single-shard txn; natural isolation | Hot shard for a mega-event |
| seat_id / hash(seat) | Even spread | Multi-seat order spans shards → distributed txn (avoid) |
| venue_id | Co-locates a venue's events | Popular venues become hot; uneven |

**Named tradeoff — locality vs balance:** sharding by `event_id` optimizes *transaction locality* (the thing you must keep atomic) at the cost of *load balance* (one event can be hot). You accept the hot-shard risk and handle it with section sub-sharding + the queue, because keeping a multi-seat order on one shard is worth far more than perfectly even load.

---

### A34. Separate stores for browsing vs booking, and the consistency tradeoff

Browsing (search by artist/city/date) and booking (point read/write on seat rows) have opposite access patterns — serve them from **different, purpose-built stores** and sync one-way.

```
BROWSE / SEARCH store:                       BOOK / INVENTORY store:
  - Elasticsearch / OpenSearch (or a         - Relational DB (Postgres/MySQL/Spanner)
    read-optimized replica)                    sharded by event_id
  - Full-text, faceted, geo search           - Strong consistency, atomic CAS, ACID
  - Denormalized, eventually consistent      - Source of truth for seat state

Sync path (one-way):  Inventory DB  --CDC / event stream (e.g., Debezium/Kafka)-->  Search index
```

| Store | Optimized for | Consistency |
|---|---|---|
| Search/browse (Elasticsearch) | Read throughput, faceted/geo/full-text | Eventual (lags inventory) |
| Inventory (sharded RDBMS) | Correct writes, atomic seat CAS | Strong |

**Named tradeoff — consistency vs query flexibility (CQRS):** the search index is *eventually consistent* — an event may appear "available" in search a few seconds after it sold out. That's acceptable because the **hold always re-validates against the inventory source of truth** (A16), so the worst case is a wasted click, never an overbooking. You accept search staleness to get rich, cheap, scalable browse.

---

## Level 7 — Operations & Failure Modes

### A35. Bad deploy marks seats CONFIRMED without charging — incident response

2,000 seats confirmed without payment, discovered 4 hours later. Response = **stop the bleeding, quantify, remediate, prevent**.

```
1. STOP THE BLEEDING (minutes):
   - Roll back / disable the bad deploy immediately (feature flag or previous image).
   - Halt ticket delivery/entry-scan validation for the affected window if possible.

2. QUANTIFY (identify the blast radius):
   - Query bookings where status=CONFIRMED AND no matching CAPTURED payment
     in the 4-hour window → the exact 2,000 (this is why bookings↔payments are
     reconcilable by payment_ref).

3. REMEDIATE (make state correct):
   - For each affected booking, attempt to collect payment (re-charge with consent)
     OR cancel + notify. Decide by policy: if the seat can be re-collected, do so;
     if the event is imminent, honor and eat the cost (brand > revenue).
   - Reconcile inventory: seats that must be cancelled → return to AVAILABLE.

4. COMMUNICATE: proactive user comms (don't let them find out at the gate).

5. PREVENT (post-mortem actions):
   - Invariant check in code AND a continuous reconciler: a booking can be CONFIRMED
     only if a CAPTURED payment exists (enforce in the transaction; alert if violated).
   - Add a canary + integration test that a confirm without capture FAILS.
```

**The systemic fix:** a **continuous reconciliation job** that flags any `CONFIRMED` booking lacking a `CAPTURED` payment within minutes — so the next occurrence is caught in minutes, not 4 hours. This is the same money⇒seat-or-refund invariant from A20, enforced as monitoring.

---

### A36. Zero-downtime schema migration on a 1-billion-row `event_seats`

Use the **expand → migrate → contract** pattern with an online schema-change tool; never `ALTER TABLE` a billion rows in one blocking lock.

```
Phase 1 — EXPAND (add, don't change):
  - Add the new column as NULLABLE with a default that requires no table rewrite.
  - New code writes BOTH old and new columns; reads tolerate NULL new column.

Phase 2 — BACKFILL (in batches, throttled):
  - Backfill new column in chunks (e.g., 10K rows/batch) with sleeps between
    batches to protect replication lag and live traffic.
  - For MySQL: gh-ost (GitHub) or pt-online-schema-change (Percona) — copy to a
    shadow table + triggers/binlog, swap atomically. For Postgres: batched UPDATEs
    (+ CREATE INDEX CONCURRENTLY for new indexes).

Phase 3 — FLIP: once backfill is verified complete, switch reads to the new column.

Phase 4 — CONTRACT: stop writing the old column; drop it in a later deploy.
```

| Anti-pattern | Why it fails | Correct approach |
|---|---|---|
| `ALTER TABLE ... ADD` with rewrite | Long exclusive lock → sale outage | Nullable add, no rewrite; online tool |
| Backfill in one `UPDATE` | Huge txn, replication lag, lock bloat | Batched, throttled backfill |
| Add index inline | Blocks writes | `CREATE INDEX CONCURRENTLY` / gh-ost |

**Named tradeoff — migration speed vs production safety:** faster backfill (bigger batches, no sleeps) stresses replication and live latency; slower backfill is safe but takes longer. Throttle to keep replica lag and p99 within SLA — a slow safe migration beats a fast one that pages you mid-sale. (gh-ost was built by GitHub precisely to do this safely at scale.)

---

### A37. (Failure mode) Primary inventory DB goes down mid-sale — failover; in-flight holds and payments

```
Failover procedure:
  1. Detect: replication/health monitor declares primary down (bounded timeout).
  2. Promote: a synchronous (or lowest-lag) replica becomes the new primary
     (managed HA: Patroni/Aurora/Cloud SQL/etc. automate this in seconds-to-tens-of-seconds).
  3. Redirect: connection string / service discovery points writes to the new primary.
  4. Fence the old primary (STONITH) so it can't accept writes → prevents split-brain.

In-flight state:
  - HOLDS live in Redis, not the failing DB → they SURVIVE (auto-expire on TTL as usual).
    This is a second reason to keep holds off the primary DB.
  - Committed BOOKINGS: durable; present on the promoted replica up to its replication point.
  - Writes in the async-replication gap at the moment of crash may be LOST → the
    reconciler + payment idempotency recover them (money⇒seat-or-refund, A20).
  - PAYMENTS in-flight: idempotency keys mean a retry after failover doesn't double
    charge; the reconciler resolves any confirm that didn't durably land.
```

**Named tradeoff — RPO vs latency (sync vs async replication):** synchronous replication gives RPO≈0 (no lost writes on failover) but adds write latency; asynchronous replication is fast but risks losing the last few writes. For a payments-adjacent path, use **synchronous replication for the commit of bookings/payments** (accept the latency) and lean on idempotency + reconciliation to close any residual gap.

---

### A38. Monitoring hold-expiration rate, conversion, and overbooking attempts

```
Key SLIs and how to compute them:
  hold_expiration_rate = holds_expired / holds_created         (abandonment health)
  conversion_rate      = bookings_confirmed / holds_created    (funnel health)
  overbooking_attempts = count of confirm CAS with rowcount=0 that would double-book
  hold_latency_p99, confirm_latency_p99                        (write-path SLA)
  db_pool_utilization, redis_hit_rate                          (saturation)
```

```promql
# Overbooking attempts should be ~expected loser count; a SPIKE = a real bug/attack:
rate(seat_double_book_prevented_total[1m]) > 50     # investigate

# Conversion collapse during a sale = checkout is failing downstream:
rate(bookings_confirmed_total[5m]) / rate(holds_created_total[5m]) < 0.3

# Hold expiration surge = users can't complete (payment/inventory stress):
rate(holds_expired_total[5m]) / rate(holds_created_total[5m]) > 0.6
```

| Dashboard panel | Healthy | Alert when |
|---|---|---|
| Hold expiration rate | Steady baseline | Sudden surge (checkout is failing) |
| Hold→book conversion | High during sale | Collapses (payment/inventory problem) |
| Overbooking prevented (CAS=0) | ~ loser count | Spikes (bug/attack) |
| Write-path p99 | < 500 ms | > SLA (feeds queue throttle, A28) |
| DB pool / Redis hit rate | < 70% / high | Saturating |

These metrics also feed the **virtual-queue admission controller** (A28) — the same latency/saturation signals that throttle admission are the ones you alert on.

---

## Level 8 — Architect-Level Questions

### A39. Zookeeper distributed lock instead of the Redis hold layer — argue it

**Position: reject Zookeeper as the *hold* layer; it's a mismatch for millions of short, TTL-based, high-churn holds. It *can* be justified for a small set of coarse-grained coordination locks.**

| Dimension | Redis hold (SET NX PX) | Zookeeper (ephemeral znode lock) |
|---|---|---|
| Model fit | TTL-based soft reservation | Strong, session-based mutual exclusion |
| Throughput | Very high (in-memory, ~single-key atomic) | Lower; every lock = a write through consensus (ZAB) |
| Latency | Sub-ms | Higher (quorum write per lock op) |
| Scale of locks | Millions of ephemeral holds | Hundreds/thousands of coordination locks, not millions |
| Auto-expiry | Native per-key TTL | Ephemeral znode dies with the *session*, not a per-hold TTL |
| Correctness | Not a hard mutex (fence at DB) | Strong (linearizable via consensus) + fencing zxid |

```
Why NOT Zookeeper for holds:
  - ZK is a coordination service (CP, consensus-backed). Every lock acquire/release
    is a quorum write → it cannot match Redis's throughput for millions of holds.
  - Holds need a 10-MIN TTL. ZK ephemeral nodes expire on SESSION loss, not on a
    per-hold timer → you'd bolt TTL logic on top anyway.
  - The overbooking guarantee already lives in the DB confirmation CAS. You don't
    need ZK's linearizable lock for a soft, discardable hold.

When ZK (or etcd) IS justified:
  - A FEW coarse locks: leader election for the reconciler, "who owns admission
    control for event X", schema-migration coordination. Low volume, needs strong
    guarantees and fencing tokens (zxid). That's ZK's sweet spot.
```

**Named tradeoff — consistency strength vs throughput:** Zookeeper buys linearizable correctness at the cost of throughput and operational weight (a quorum you must run and tune). For a soft, high-churn hold you don't need that strength (the DB CAS is your real guarantee), so Redis's throughput wins. Reserve ZK/etcd for the handful of low-volume locks that genuinely need consensus.

---

### A40. 6 weeks to redesign the sale flow after the 2022 incident — top 3 changes

```
Change 1 — Bot filtering + human verification AT THE GATE (highest leverage).
  - Verified-fan pre-registration; device fingerprinting; challenge suspicious
    sessions; managed bot rules at the edge (Cloudflare/Akamai).
  - Rationale: 2022 failed because automated traffic reached seat selection. Keep
    bots out of inventory entirely — filter before the waiting room admits them.

Change 2 — Capacity-plan the virtual queue for REAL demand + closed-loop admission.
  - Size the queue and admission rate to the true arrival (millions), not hopeful
    estimates. Admission rate = f(inventory p99, DB utilization) with AIMD throttle.
  - Rationale: the queue was under-provisioned and admitted faster than inventory
    could absorb. Decouple arrival rate from admitted rate rigorously.

Change 3 — Harden the write path: shard by event, sub-shard hot events by section,
  and make holds Redis-TTL soft state with DB-CAS as the sole overbooking guarantee.
  - Rationale: even correctly gated traffic (5K/s) must not overbook or fall over;
    the inventory tier must scale horizontally with the mutex intact.

(Plus: load-test at 2–3× projected peak with a game-day/chaos drill before on-sale.)
```

| Change | Attacks which 2022 failure | Payoff |
|---|---|---|
| Bot filtering at gate | Bots reached seat selection | Real users get inventory |
| Queue capacity + closed-loop admission | Under-scaled queue, over-admission | No thundering herd downstream |
| Sharded, Redis-hold + DB-CAS write path | Inventory hammered past capacity | Scales horizontally, no overbooking |

**Named tradeoff — user friction vs bot resistance:** verification (verified-fan, CAPTCHA) adds friction that annoys some real users, but without it bots win. The design accepts modest friction for legitimate users to protect fairness — the explicit lesson of 2022.

---

### A41. Global events — seat inventory consistency across regions (NY and London booking a London show)

The core problem: a seat is a **single global resource**, but users hit **different regional data centers**. You need a single authority per seat despite geographic distribution.

| Approach | How it works | Consistency | Cost |
|---|---|---|---|
| **Single home region per event (recommended)** | Each event has an authoritative region (London show → EU region owns its inventory). All *writes* (holds/bookings) route there; other regions get read replicas for browse. | Strong for writes (single writer) | Cross-region write latency for far users (NY→EU ~tens of ms) |
| Region-partitioned allocation | Pre-allocate seat blocks to regions (e.g., 30% of seats to US pool). Each region writes its own block locally. | Strong within a block; no global contention | Wasteful: one region sells out while another has unsold blocks; rebalancing is hard |
| Globally-distributed strong DB | Spanner/CockroachDB with synchronous cross-region consensus (Paxos/Raft) | Strong globally | Highest write latency (cross-region quorum on every write) |
| Multi-master + async | Each region writes locally, replicate async | Eventual → **risks double-booking** | Unacceptable for zero-overbooking |

```
Recommended: HOME-REGION authority.
  - Event's inventory has ONE authoritative region (co-located with the venue/demand).
  - Browse/seat-map: served from local read replicas everywhere (eventual, fine).
  - Hold/confirm: routed to the home region → the per-seat mutex stays single-owner.
  - A NY user booking a London show pays a cross-region round trip on the WRITE only;
    all their reads are local and fast.
```

**Named tradeoff — latency vs consistency (and the CAP reality):** you can have low-latency local writes (multi-master, but eventual → double-booking risk) OR globally-consistent writes (single home region / Spanner, but cross-region latency). For zero-overbooking you **must** choose consistency; you minimize the latency cost by placing the authority near the demand and serving all reads locally. Multi-master async is off the table because it can double-sell a seat.

---

### A42. Dynamic pricing — what changes and what new consistency problems appear

Dynamic pricing (airline-style, demand-driven) touches the **pricing service, the hold, the seat-map read, and payment**, and it introduces a **price-consistency** problem (the price can move between display, hold, and pay).

```
Architecture changes:
  1. Pricing service: computes price = f(demand, remaining inventory, time, tier).
     Publishes price updates; must be low-latency and cache-friendly.
  2. Seat-map read path: prices now change → shorter cache TTLs / push price deltas
     alongside status deltas over the same WebSocket/SSE channel.
  3. Hold step: must LOCK THE PRICE at hold time — snapshot price_cents into the hold
     record so the user pays what they were quoted, not a price that moved mid-checkout.
  4. Payment: charges the locked (held) price; the ACID confirm validates the locked
     price is still the authorized amount.
  5. Audit: every price change is logged (regulatory/consumer-trust; disputes).
```

**New consistency problems:**
```
- Read-after-price-change staleness: a user sees $200, price jumps to $250 before
  they hold. Fix: lock price AT HOLD; honor the quote for the hold window.
- Two users, same seat, different displayed prices (mid-update): whoever HOLDS first
  locks their price; the mutex (A12) still guarantees one owner — pricing rides on top.
- Payment amount mismatch: the charge must equal the locked price. Fix: pass the
  locked amount + idempotency key; reject if it diverges from the held snapshot.
- Fairness/trust & regulation: rapid price swings can be a consumer-protection issue;
  bound the rate of change and log everything.
```

| Concern | Without dynamic pricing | With dynamic pricing |
|---|---|---|
| Price on seat map | Static | Changing → push deltas, short TTL |
| Hold record | seat + user | seat + user + **locked price snapshot** |
| Payment | charge fixed price | charge **held** price, validate no drift |
| New failure mode | — | price changes mid-checkout → must honor quote |

**Named tradeoff — revenue optimization vs price consistency/trust:** dynamic pricing captures more revenue but breaks the assumption of a stable price, introducing quote-vs-charge consistency work and consumer-trust risk. You resolve it by **locking the price at hold time** (the same instant you lock the seat) so the user's quote is honored for the checkout window.

---

## Level 9 — Digital Tickets, QR Codes & Notifications

### A43. Issuing the ticket — what goes inside the QR

Ticket issuance is a **separate, downstream step from `CONFIRMED`, not part of the payment transaction**. The moment the booking commits, we emit an event and let a ticket service mint the credential. Crucially, the QR carries a *self-verifying signed token*, not a raw identifier.

```
On BookingConfirmed (emitted in the SAME tx as the CONFIRMED write — outbox pattern):
  1. Ticket service consumes the event (at-least-once, idempotent by booking_id).
  2. Allocate an OPAQUE ticket_id — random UUID. NOT sequential, NOT the seat id.
  3. Build a token binding: ticket_id, booking_id, event, seat, holder, nonce,
     generation, valid window, key id.
  4. Sign it (asymmetric private key, or per-event HMAC key). Persist canonical ticket row.
  5. Render QR from the signed token; deliver to wallet / email / app (see A45).
```

The payload inside the QR is a compact signed token. A QR holds only a few KB (approximately ~2–3 KB binary at high versions; illustrative — verify), and dense high-version QRs scan poorly off a phone screen, so keep the payload to a **few hundred bytes**: prefer a compact binary encoding (CBOR/COSE- or CWT-style — verify against current specs) over a verbose JSON/JWT, whose base64url text is bulkier for the same fields:

```ts
type TicketToken = {
  v: 1;                     // schema version — lets a gate reject unknown formats
  tid: string;              // opaque RANDOM ticket id — never the booking/seat id
  bid: string;              // booking id this credential is bound to (audit + revoke scope)
  eid: string;              // event id — gate checks it matches this gate
  seat: string;             // section/row/seat, for display + audit only
  sub: string;              // holder ref (hashed account id, not raw PII)
  jti: string;              // random nonce — prevents replay of an identical signed blob
  gen: number;              // credential generation — bumped on re-issue (see A45)
  nbf: number; exp: number; // valid-from / valid-until — the entry window
  kid: string;              // signing key id — enables key rotation
  sig: string;              // signature computed over all fields above
};
```

Why it must NOT be a *raw, unsigned* booking id or seat id (binding the booking id **inside** a signed token, as `bid` above, is fine and useful — the failure is shipping a bare id as the *entire, unsigned* payload):

| If the QR contains… | Forgeable? | Enumerable? | Tamper-evident? | Revocable / rotatable? |
|---|---|---|---|---|
| Raw booking id / seat id (unsigned) | Yes — anyone can fabricate the string | Yes — sequential ids are guessable by a bot | No integrity at all | No — nothing to verify against |
| Signed token (above) | No — needs the private/HMAC key to mint | Opaque random `tid`/`jti`, nothing to guess | Signature breaks if a single bit changes | Yes — `kid` rotation + `gen`-scoped revocation |

Three concrete failures of a raw, unsigned id: (1) it is **enumerable** — guess valid ids and print your own; (2) it carries **no integrity** — the gate has no way to know the string is authentic; (3) it has **no binding** — you cannot tie it to a signing key, a validity window, or a revocation generation. The id is data; the QR must carry *proof*. The event emission itself rides the outbox — see [distributed-transactions](../distributed-transactions/) and [message-queues](../message-queues/).

**Key takeaway: the QR carries a signed, opaque, time-bounded token — binding the booking id, not exposing it raw — that the gate can verify without trusting the string itself; ticket issuance is a downstream, idempotent projection of the CONFIRMED booking, never part of the payment transaction.**

---

### A44. (Anti-fraud) Un-forgeable, un-shareable QR + offline gate validation

Three distinct attacks need three distinct defenses — do not conflate them:

- **Forgery** (fabricate a ticket from scratch) → a cryptographic signature. Prefer **asymmetric** signing: the gate holds only the public key, so a compromised gate device still cannot *mint* tickets. HMAC is simpler but every gate holds the minting secret.
- **Screenshot-and-reuse by two people** → a signature alone does not help; a screenshot is a *valid copy*. You need single-use (first scan wins, recorded) and/or a rotating code that makes a screenshot stale within seconds.
- **Sharing to defeat entry** → a rotating code lives in the app (the seed is delivered securely and never leaves the device), so a forwarded screenshot expires.

| Dimension | Signed static token | Rotating time-based code (TOTP-style, RFC 6238) |
|---|---|---|
| Stops forgery | Yes (signature) | Yes (signature + seed) |
| Stops screenshot reuse | No on its own — needs online single-use dedupe | Yes — code changes every ~15s (illustrative — verify) |
| Works offline at gate | Yes — verify signature with cached public key | Yes, but gate must pre-download per-ticket seeds |
| Needs the live app | No (PDF / wallet is fine) | Yes (seed + clock live in the app) |
| Revocation | Ship a revocation-list delta | Rotate the seed / generation |
| Complexity | Low | Higher (seed distribution, clock-skew handling) |

Real-world: Ticketmaster's SafeTix is publicly described as a rotating/refreshing barcode — treat the exact mechanism as verify before quoting it.

Offline validation — the gate does **zero network calls at the turnstile**, and the signature is checked *before* trusting any other field in the token (validating an unverified field first would let a forged token influence the decision path):

```
# BEFORE doors (over any network, once): each gate device downloads
#   - event public key (or per-event HMAC key)
#   - revocation list for the event, keyed by (ticket_id, generation)
#   - [rotating mode only] the encrypted per-ticket seed bundle
# AT the turnstile the gate is OFFLINE:

validate(qr, now):
  t = parse(qr)
  if not verify_sig(t, gate.pubkey):        return REJECT("forged")   # FIRST — local, no network
  if t.eid != gate.event_id:                return REJECT("wrong event")
  if now < t.nbf or now > t.exp:            return REJECT("outside window")
  if (t.tid, t.gen) in gate.revoked:        return REJECT("revoked")  # scoped by generation
  if rotating:
     expected = totp(gate.seed[t.tid], now, period=15, skew=±1)       # illustrative — verify
     if t.code not in expected:             return REJECT("stale / replayed")
  if t.tid in gate.local_scanned:           return REJECT("already used")   # this lane
  gate.local_scanned.add(t.tid, now)   # queue for peer/central sync on reconnect
  return ACCEPT
```

Note the two keys serve different scopes on purpose: the **used-set** (`local_scanned`) is keyed by `tid` alone — a physical seat is scanned once, full stop — while the **revocation list** is keyed by `(tid, gen)`, because a re-issue (A45) bumps the generation and must invalidate only the *old* generation, not the ticket id forever. The rotating code itself is validated as a *separate* check (against the seed) — it is not covered by the outer token's signature, so a compromised seed and a compromised signing key are independent failure modes.

Double-entry across *different* lanes while offline: each lane keeps a local scanned-set, lanes gossip scans peer-to-peer over the venue LAN, and all reconcile to the central log on reconnect. A determined double-scan across two truly-partitioned lanes in the same second is the residual risk — shrunk to seconds by rotating codes (the copy at lane 2 is already stale) and covered by staff. The gate-sync transport choice belongs to [communication-protocols](../communication-protocols/).

Named tradeoff — offline availability vs perfect single-use: strict global single-use needs a consistent online check; offline gates trade that for availability and accept a tiny reconciliation window, which rotating codes compress to seconds. A second, orthogonal tradeoff sits in seed distribution: pushing every per-ticket rotating-code seed to every gate device in advance is exactly what makes offline validation possible — but it also means a single **stolen gate device carries every seed for the event** and could mint valid-looking rotating codes. Asymmetric signing on the outer token bounds this (a stolen gate still can't *forge the signature*), while seed exposure is scoped to reduce blast radius (e.g. per-gate seed subsets, if venue layout allows) and always covered by short-lived, revocable rotation.

**Key takeaway: verify the signature first, before trusting any other field; sign to stop forgery, rotate (or enforce online single-use) to stop screenshot reuse, and validate offline by shipping the public key plus a (ticket_id, generation)-scoped revocation list to each gate so every check is local — the network is a sync channel, never on the turnstile's critical path.**

---

### A45. Storing, delivering, and re-issuing the ticket

Core principle: the **canonical ticket lives server-side**; every channel below is a *rendering or a pointer*, never the source of truth. That is exactly what makes safe re-issue possible.

| Channel | Offline access | Rotating code | Forwardable risk | Push-update to fix / re-issue |
|---|---|---|---|---|
| App + account deep link | Yes (cached) | Yes (app holds the seed) | Low (tied to login) | Yes — app refetches live ticket |
| Apple Wallet pass (.pkpass, PassKit) | Yes, for the static barcode | No live rotation — a pass has no code execution; a "refresh" is a server push, not a local rotation | Medium | Yes, via APNs + the pass web service pushing an updated pass (verify) |
| Google Wallet pass (Google Wallet API) | Yes, for the static barcode | Same limitation as above (verify) | Medium | Yes, via a server-initiated object update (verify) |
| Email + PDF (embedded QR) | Yes | No (static) | High — just forward the file | No — must re-send |

A wallet pass has **no code execution environment** — it cannot run a TOTP loop on its own. A pass showing a barcode that appears to "rotate" is being *refreshed by a server push* (Apple: APNs wakes the app which calls the pass web service; Google: a server-side object update) — treat both as verify-before-quoting, and note that a *truly offline*, self-rotating code still requires the live app with the seed on-device (A51), not the wallet pass alone.

Re-issue a lost ticket without a second valid entry — the invariant is **seat → exactly one active ticket_id → exactly one active credential generation**, and the check must land on the same `(tid, gen)` scoping the gate already enforces (A44):

```
reissue(ticket_id):
  tx:
    g    = current_generation(ticket_id)
    revoke(ticket_id, g)                # (ticket_id, g) added to the revocation list —
                                         # old QR / screenshot now FAILS validation
    g2   = g + 1
    seed2 = rng()                       # new rotating seed (if rotating codes used)
    persist(ticket_id, generation=g2, seed=seed2)
  push_wallet_update(ticket_id)         # refresh the pass IN PLACE — no duplicate pass
  enqueue revocation_delta(ticket_id, g) -> all gates   # offline gates learn at next sync
  # Seat still maps to ONE ticket_id; only (ticket_id, g2) validates.
  # The old credential is NOT "a second ticket" — it is a REVOKED prior generation.
```

Why this beats "just email another QR": a naive re-send leaves two scannable credentials for one seat → double entry. Binding validity to a **generation counter** (plus the revocation delta pushed to offline gates, scoped exactly as A44's gate check expects) means minting a new credential *atomically invalidates the old one*, and wallet push-update refreshes the existing pass rather than adding a second. The re-issue endpoint and its idempotency key belong to [api-design](../api-design/); the wallet push refresh rides [notification-system](../notification-system/).

**Key takeaway: keep one server-side canonical ticket and treat wallet, email, and app as disposable renderings; re-issue by bumping the generation and pushing a (ticket_id, generation)-scoped revocation delta so there is always exactly one valid credential per seat — old copies fail verification instead of becoming a second door.**

---

### A46. Notification flow: confirmation, reminders, day-of updates

Two trigger classes: **event-driven** (immediate) and **time-scheduled** (reminders). Both run through the shared [notification-system](../notification-system/) over a durable queue — see [message-queues](../message-queues/).

| Notification | Trigger | Timing | Channel ladder | Idempotency key |
|---|---|---|---|---|
| Booking confirmation | `BookingConfirmed` event | Immediate | push → email (always email a receipt) | (user, booking, "confirm") |
| Reminder T-24h | scheduled at booking time | event_start − 24h | push → SMS fallback | (user, event, "rem_24h") |
| Reminder T-1h | scheduled at booking time | event_start − 1h | push → SMS fallback | (user, event, "rem_1h") |
| Day-of entry update (gate/time change) | ops event | on change | push + SMS (urgent) | (user, event, "dayof", change_hash) |

Reliable scheduling — persist the schedule durably, **never rely on in-process timers** (they die with the pod), and only schedule reminders that are still in the future (a booking made 10 minutes before doors needs no T-24h row):

```
on BookingConfirmed(b):
  # durable rows — survive restarts and redeploys; skip any reminder already in the past
  if b.event_start - 24h > now(): schedule(user=b.user, event=b.event, type="rem_24h", send_at=b.event_start - 24h)
  if b.event_start - 1h  > now(): schedule(user=b.user, event=b.event, type="rem_1h",  send_at=b.event_start - 1h)

# dispatcher — runs every ~60s (illustrative — verify), at-least-once
for row in due(now):                          # send_at <= now AND status = PENDING
  if not lease(row, ttl=120s): continue       # lease TTL > dispatch interval, so one
                                               # worker holds the row for the whole send,
                                               # not just until the next tick claims it too
  key = (row.user, row.event, row.type)       # stable idempotency key (channel-independent)
  if not ledger.insert_if_absent(key):        # UNIQUE(key) IS the dedupe guarantee
      row.status = SKIPPED_DUP                # a duplicate attempt is a silent no-op
      continue
  send(row, channel = pick(row), idempotency_key = key)  # SEND FIRST, using `key` as
                                               # the provider's own idempotency key too
  row.status = SENT                           # mark AFTER a successful send call
```

- **Idempotent (never double-send):** the send-ledger has a UNIQUE constraint on the idempotency key, and that same key is passed to the provider as *its* idempotency key. The order matters: **send before marking SENT** (with the provider-level idempotency key already carrying the dedupe guarantee), so a crash between "send" and "mark SENT" causes a harmless retry that the *provider* collapses — the reverse order (mark-then-send) would let a crash after the mark silently drop a notification that was never actually sent.
- **Dedupe across push/email/SMS:** the key deliberately excludes channel — it is per (user, event, type). Send the *preferred* channel first and only escalate to the next rung if the first is not delivered within a window. One logical notification = at most one delivery, not one per channel (the confirmation is the intentional exception — always keep an emailed receipt).

Named tradeoff — at-least-once + idempotency vs exactly-once: queues give at-least-once cheaply; true exactly-once delivery is expensive and fragile. Take at-least-once delivery and make the *effect* exactly-once with the UNIQUE-key ledger, sending before marking so a crash never causes a silent loss — see [message-queues](../message-queues/).

**Key takeaway: schedule only future-dated reminders as durable rows (never in-process timers), send before marking SENT so a crash retries instead of silently dropping, and dispatch at-least-once while making the effect exactly-once with a UNIQUE idempotency-key ledger keyed by (user, event, type).**

---

### A47. (Failure mode) CONFIRMED but ticket issuance fails

The framing that saves you: **`CONFIRMED` is the source of truth; the QR is a downstream projection.** The user's money and seat are already safe — issuance is a *retryable render*, so this is never surfaced as a payment error.

| Layer | State after the failure | What we do |
|---|---|---|
| Payment | Captured | Leave it — the charge is valid, the seat is theirs |
| Booking | CONFIRMED (durable) | Source of truth — unchanged |
| Ticket / QR | Missing | Retry issuance idempotently until it succeeds |
| User sees | "Booking confirmed — your ticket is being prepared" + booking reference | Never "payment failed"; the ticket appears via push/poll when ready |

Guaranteeing *exactly one* valid ticket **that is actually delivered** — outbox + idempotent consumer, with minting and delivery treated as two separately-retriable steps:

```
# 1) Emit the issuance request ATOMICALLY with the CONFIRMED write (outbox pattern)
tx:
  booking.status = CONFIRMED
  outbox.insert(TicketIssuanceRequested{ booking_id })    # same tx -> event cannot be lost

# 2) A relay publishes outbox rows to the ticket queue, retrying until acked (at-least-once)

# 3) Ticket worker: MINT is idempotent (guarded once), DELIVER always runs on retry —
#    otherwise a crash between mint and deliver leaves a ticket that exists but was
#    never sent, and a naive "if issued: return" would skip delivery forever.
on TicketIssuanceRequested(booking_id):
  ticket = tickets.get_or_create(booking_id)   # UNIQUE(booking_id) -> at most ONE row
  if not ticket.issued:
      ticket.credential = sign(build_token(booking_id))
      ticket.issued = true                     # mint happens exactly once
  deliver(ticket)                              # ALWAYS attempt delivery — itself idempotent
                                                # (wallet push / resend email is safe to repeat)
  ack
# UNIQUE(booking_id) is the mint guarantee: N deliveries of the event -> exactly ONE credential.
# deliver() being unconditional is the delivery guarantee: a retry after a partial
# failure still reaches the user instead of silently stalling on an already-issued ticket.
```

- **If issuance keeps failing:** after N retries the message parks in a dead-letter queue and an alert fires — but the seat is still validly booked. Fallback path: the box office looks the booking up by reference and admits or issues at the gate, because the CONFIRMED booking — not the QR — is the entitlement.
- **Why not issue the ticket inside the payment transaction?** That couples a durable money/seat commit to a fragile render step: a QR failure would either roll back a real payment or block the response. Decoupling via the outbox lets payment commit instantly and issuance heal asynchronously. See [distributed-transactions](../distributed-transactions/) (outbox / saga) and [message-queues](../message-queues/) (at-least-once + DLQ); the "ticket is ready" nudge rides [notification-system](../notification-system/).

**Key takeaway: treat the ticket as an idempotent projection of the CONFIRMED booking — mint once under a UNIQUE(booking_id) guard but re-run delivery unconditionally on every retry — so the user sees "confirmed, ticket on its way," retries converge to exactly one delivered credential, and the booking record (not the QR) remains the real entitlement if issuance never fully recovers.**

---

## Level 10 — Frontend Architecture (Architect)

### A48. Rendering 80k seats — SVG vs Canvas vs WebGL, virtualization, hit-testing

A seat map is a **spatial dataset, not a document**. At up to ~80,000 seats (illustrative venue ceiling — verify against your largest venue) the renderer choice is dominated by how many primitives you can paint at 60 fps and how cheaply you can find the seat under a tap.

| Renderer | Sweet spot | Behavior at 80k | Hit-testing |
|---|---|---|---|
| **SVG** (one DOM node/seat) | Small venues, ~≤ a few thousand seats (illustrative — verify) | 80k DOM nodes blow up layout/style-recalc, memory, GC → pan/zoom janks | Free (DOM events) — but that convenience is exactly what collapses at scale |
| **Canvas 2D** (immediate mode) | Pragmatic default, up to tens of thousands (illustrative — verify) | One `<canvas>`, no per-seat DOM; draw only visible seats. CPU-bound on huge redraws | Manual — spatial index or color-picking (below) |
| **WebGL** (GPU, instanced) | 80k+ with buttery zoom, or animated maps | GPU instancing draws all seats as instances of one quad → 60 fps even at full venue | Manual — same spatial index, or GPU color-id picking |

Default to **Canvas 2D + viewport virtualization**; reach for **WebGL instanced rendering** only when profiling shows Canvas can't hold 60 fps on your target low-end device (A53). Keep a few **SVG/DOM nodes as an overlay** for interactive chrome (selection ring, tooltip, held-seat highlight) layered above the raster base — a hybrid.

```
Level-of-detail by zoom:
  zoomed OUT  → draw SECTION polygons + heatmap color (from section counts), NOT seats.
  mid zoom    → draw seat dots (no labels).
  zoomed IN   → draw seat rects + row/seat labels, viewport only.

Viewport cull each frame (requestAnimationFrame):
  visible = spatialIndex.query(viewportRectInWorldCoords)   # quadtree / uniform grid
  for seat in visible: draw(seat, statusColor[seat.id])
  # 80k seats total, but only ~hundreds–low-thousands are ever on screen.
```

| Hit-test technique | How | Cost |
|---|---|---|
| **Spatial index** (quadtree / uniform grid) | tap (x,y) → world coords → query the index for the seat at that point | O(log n)/O(1); reuse the same index built for culling |
| **Color-id picking** | render an offscreen "hit canvas", each seat a unique RGB id; read the pixel under the tap via `getImageData`, decode the id | one extra buffer; robust for irregular seat shapes |

For smooth zoom/pan, keep a world→screen **transform matrix**; on pan, translate the matrix and repaint culled seats in `requestAnimationFrame` (optionally a cheap CSS `transform` on the canvas during the gesture, then re-raster crisp on settle). Handle `window.devicePixelRatio` so retina stays sharp. Seat coordinates are immutable per venue configuration → precompute and serve them from the edge, see [cdn-edge](../cdn-edge/); only the *status* layer is dynamic (A49).

**Named tradeoff — fidelity vs frame rate:** SVG gives free hit-testing and crisp DOM styling but collapses at venue scale; Canvas/WebGL give 60 fps at 80k but you own hit-testing and text yourself. At ~80k the frame rate must win — you buy back the convenience with a spatial index and an SVG overlay for chrome only.

**Key takeaway: Canvas/WebGL over SVG at venue scale; virtualize to the viewport with a spatial index that doubles as your hit-test; and treat static geometry (edge-cached) as a separate problem from dynamic status.**

---

### A49. Real-time availability and lock status — transport, granularity, fan-out

A seat must flip to **held the instant another user grabs it**, yet you must never push 80k seat states to every client. Two levers do the work: the right **transport**, and **viewport/section-scoped subscriptions carrying deltas**.

| Transport | Direction | Fit for status | Notes |
|---|---|---|---|
| **WebSocket** | Bidirectional | **Recommended** — the client must send subscribe/unsubscribe intent (as it pans/zooms across sections) on the same channel the server pushes status deltas over; one duplex connection covers both | More infra (sticky sessions/gateway) than SSE. See [communication-protocols](../communication-protocols/) |
| **SSE** (EventSource) | Server → client only | Fallback — fine if subscription changes are rare, but forces "which sections am I watching" onto a separate side-channel POST | Simpler, native auto-reconnect + `Last-Event-ID`. See [sse](../sse/) |
| **Long-poll / poll** | Client pull | Last-resort fallback | Wastes requests, higher latency; use when WS/SSE are blocked (A53) |

Recommend **WebSocket** as the primary transport for the status stream: seat browsing is genuinely bidirectional — the client's viewport moves (pan/zoom/section-switch) constantly re-scope *which* deltas it wants, and a duplex channel carries that upstream "subscribe to section C" traffic natively instead of routing it through a side HTTP call. Fall back to SSE (receive-only, resync via `Last-Event-ID`) where WebSocket is blocked, and to polling as a last resort (A53). The fan-out/pub-sub shape is the same one behind a chat room — see [chat-system](../chat-system/).

```
Initial:  one SNAPSHOT of ONLY the section(s) currently in the client's viewport, as a
          packed bitmap (~2 bits/seat — a few hundred bytes for a section of a few
          thousand seats; the "~20 KB for 80k" figure is the whole-venue encoding
          density, illustrative — verify per A32 — NOT what you actually send).
Steady:   DELTAS only →  { ev:123, seat:"B-R3-A14", status:"HELD", v:42 }
          a version/seq per seat so the client drops out-of-order/duplicate updates.
```

Avoiding the 80k-to-everyone push is the crux:

```
1. SCOPE to what the user sees. The client subscribes to the SECTION(s) in its
   viewport (a topic/room per section) over the WebSocket; the server fans a seat
   delta out only to that section's subscribers — not to every connection.
   channel: seatmap:event:123:section:B
2. COALESCE. During a hot sale, batch deltas per section and flush every ~100 ms
   (illustrative — tune) so a burst becomes one framed message, not thousands.
3. RESYNC on (re)connect: pull a fresh section snapshot (cheap bitmap) from cache,
   then resume deltas from your last seq/version — never replay full history.
```

Server-side, status changes publish to a pub/sub layer keyed by section, and edge nodes fan out to subscribers; the snapshot/bitmap lives in the cache tier, see [distributed-caching](../distributed-caching/). Crucially the pushed status is **display only** — a client acting on a stale "available" is still rejected by the atomic hold at the source of truth (A16), so a dropped delta is a cosmetic bug, never an overbooking.

**Key takeaway: WebSocket is the primary transport because the client's own section subscriptions are upstream traffic, not just downstream status — scope subscriptions to the sections a client can actually see, push versioned deltas (not the full map, and not a whole-venue-sized snapshot), and remember the stream only paints pixels; the source-of-truth CAS, not the stream, prevents overbooking.**

---

### A50. Checkout UX — countdown timer, mid-hold edits, offers, honest timer

The hold TTL is **server-authoritative** (A3); the client timer is a *projection* of it, never the source. The UX job is to keep that projection honest under clock skew, tab-sleep, and reconnects — and to handle the case where the server ends the hold **early** — so the user is never surprised by an unannounced expiry.

```ts
// Server returns absolute expiry on ITS clock, plus its "now", so we can de-skew.
type HoldResp = { expiresAtServerMs: number; serverNowMs: number };

function makeCountdown(r: HoldResp) {
  const skew = r.serverNowMs - Date.now();       // captured ONCE at hold time; this
                                                  // estimate goes stale by ~half the
                                                  // request's round-trip time, which
                                                  // SAFETY_MS below exists to absorb
  const correctedExpiry = r.expiresAtServerMs;   // measured on the server timeline
  return () => {
    const nowServer = Date.now() + skew;
    const SAFETY_MS = 5_000;                      // expire UI early — illustrative, tune
    return Math.max(0, correctedExpiry - nowServer - SAFETY_MS);
  };
}
// Re-fetch authoritative TTL on: reconnect, tab re-focus (visibilitychange / Page
// Visibility API), and periodically — background tabs throttle timers, so a resync
// on focus stops a "frozen" countdown from lying to the user.
```

The client timer hitting zero **must not release the seat** — only the server TTL does that (A3). Client expiry just disables "Pay" and forces a re-check. The reverse case matters just as much: **a positive client countdown never proves the hold is still alive**, because the server can end a hold early — a shorter real TTL than advertised, a fraud/admin action, or a forced release. Handle it on two paths, not one:

- **Real-time path:** the same section delta stream (A49) carries a `HELD → AVAILABLE` transition for the user's *own* held seat if the server released it; on receipt, immediately move focus off the dead hold, disable "Pay," and surface a re-select prompt — don't wait for the countdown to catch up.
- **Payment-time path (the actual guarantee):** whether or not the real-time delta arrives in time, the payment call itself **re-validates the hold server-side** before charging (A16's atomic guard) — so even a fully stale client countdown can never charge a card for a seat that's no longer held.

| Action | Client does | Server authority |
|---|---|---|
| Add seat B22 mid-order | POST a new atomic hold for B22 (per A10) | Grants only if free; order TTL = min of member holds (or one order-level TTL) |
| Remove a seat | Release that hold | Seat → AVAILABLE at once; order total recomputed server-side |
| Apply offer/promo | Show optimistic price, then reconcile | Server validates the code, recomputes, **locks the price into the hold** (A42) |
| Timer during edits | Re-render from the authoritative `expiresAt` | Adding a seat does **not** silently extend the TTL unless the server says so |
| Server ends hold early | Real-time delta moves focus + disables Pay | Payment re-check is the actual backstop regardless of client state |

Optimistic UI is fine for snappiness, but the **price paid and the seats owned are decided server-side** — the discount is validated and the amount snapshotted into the hold, so payment charges the quoted price, not one that moved mid-checkout (A42).

**Named tradeoff — responsiveness vs authority:** optimistic timer/price updates feel instant but can diverge from the server; you resolve it by rendering only from server-provided absolutes, resyncing on focus/reconnect, and — critically — never trusting the countdown as proof of a live hold, since only the server's re-check at payment time is authoritative.

**Key takeaway: the server TTL is the only real clock and can end a hold early at any time; the client timer is a skew-corrected, safety-buffered projection that resyncs on focus/reconnect and reacts to early-release deltas, but the actual guarantee against a stale hold is the server re-validating at the moment of payment — never the countdown.**

---

### A51. Client ticket storage and QR — offline at the gate, rotating codes, wallet

The gate is the worst network environment in the whole system (a metal-and-concrete hall with tens of thousands of phones), so the ticket must render with **zero signal** — everything the scanner needs is already on the device.

| Channel | Offline? | Re-issue safety | Notes |
|---|---|---|---|
| **PWA app cache** (IndexedDB + Service Worker Cache API) | Yes — token pre-cached at issuance | Server revokes the old (ticket_id, generation) on re-issue (A45) | Renders the QR from the locally stored signed token |
| **Wallet pass** (Apple Wallet / Google Wallet) | Yes — wallet stores the pass natively | Push an updated pass; invalidate the old one server-side | Vendor pass formats — mark **verify** (below); no local rotation (A45) |
| **Email / PDF** | Yes once downloaded | Weakest — screenshots proliferate | Backup channel; still validated at the gate (A44) |

```
At issuance (online) persist into IndexedDB:
  - the signed static token (A44), AND
  - for rotating codes: the per-ticket TOTP seed (RFC 6238-style time-based OTP).

At the gate (offline) render:
  if static:   QR = encode(signedToken)                        # client-side QR library
  if rotating: otp = HMAC(seed, floor(deviceClock / step))     # step ~30s, illustrative
               QR = encode(otp) ; re-render every `step` seconds
  # HMAC via Web Crypto (crypto.subtle) — real API. QR encoding via a JS QR library —
  # there is NO native browser QR-GENERATION API, so verify the library choice.
Gate scanner validates OFFLINE against the same seed / public key (A44), accepting a
small clock window to tolerate device drift.
```

Rotating codes raise the bar against screenshot-sharing but do **not eliminate it**: a *static* screenshot shows a code that expires in ~30s (illustrative — verify), so a casually forwarded photo goes stale fast. They do **not** stop a live screen-relay/video call to a second person at the gate in real time, nor extraction of the TOTP seed itself from a rooted/compromised device (the seed sits at rest in IndexedDB). The actual guard against reuse is **gate-side single-use redemption** (first scan wins, A44) plus **revoke-on-reissue** (A45) — rotation narrows the exploitable window, it isn't a standalone defense.

Wallet integration (hedged): Apple Wallet uses PassKit passes (`.pkpass`); Google Wallet uses passes added via an "Add to Google Wallet" flow / Google Wallet API. Both can show a barcode offline, and updates to that barcode arrive via a **server-initiated push** (A45) rather than on-device rotation — exact current capabilities **change over time; verify against current Apple/Google developer docs before committing**. Wallets are a convenience/backup layer *on top of* your own signed token, not a replacement. Delivery, reminders, and re-issue notices ride the flow in A46 and [notification-system](../notification-system/); re-issuing a lost ticket mints a new generation and revokes the old `(ticket_id, generation)`, so there is never a second valid entry (A45).

**Key takeaway: pre-cache a signed token (and a TOTP seed for rotating codes) on the device so the QR both renders and validates offline at the gate; rotation raises the cost of screenshot-sharing but doesn't stop live relay or seed extraction, so gate-side single-use plus revoke-on-reissue is the real guarantee; treat wallets as a verify-first convenience layer.**

---

### A52. Accessibility for a large seat map

You cannot make 80k seats individually tabbable, and a screen reader cannot narrate a pixel canvas. The answer is a **section-scoped semantic grid with roving focus** plus a **non-visual booking path**, so the visual map is an enhancement, not the only door in.

```html
<!-- The ARIA grid is SCOPED TO ONE SECTION at a time (not all 80k seats in one grid) —
     matching the same viewport/section scoping used for rendering (A48) and real-time
     updates (A49), so the accessibility tree never has to represent the whole venue. -->
<!-- ONE tab stop for the grid (roving tabindex); arrow keys move focus cell→cell. -->
<div role="grid" aria-label="Section B seat map" aria-rowcount="40" aria-colcount="30">
  <div role="row" aria-rowindex="3">
    <!-- tabindex=0 on the ONE focused cell, -1 on all others (roving tabindex) -->
    <div role="gridcell" tabindex="0" aria-colindex="14" aria-selected="false"
         aria-label="Section B, Row 3, Seat A14, available, $120">A14</div>
  </div>
</div>
<!-- Arrows move focus; Home/End = row ends; PageUp/Down = jump rows; type-ahead jumps
     to a row/section. aria-rowindex/colindex stay honest even when the grid is
     virtualized (A48), so the SR announces the right position. Note the seat's STATUS
     ("available", "held", "sold") is spoken because it's part of the accessible name
     (aria-label) — a screen reader user gets the same information a sighted user gets
     from color, satisfying WCAG 1.4.1 without a separate announcement mechanism. -->
```

Offer a **text alternative as a first-class path**: a "find seats" form (section, row preference, quantity, accessibility needs) that returns seats without touching the visual grid — often the *primary* flow for keyboard/SR users and a graceful degrade target on low-end devices (A53).

| Seat state | Color (one signal only) | Non-color signal | ARIA |
|---|---|---|---|
| Available | green | outline + selectable shape | `aria-disabled="false"` |
| Held (others) | amber | hatch/pattern fill + lock glyph | `aria-disabled="true"`, label "held" |
| Sold | grey | solid fill / × glyph | `aria-disabled="true"`, label "sold" |
| Your selection | blue | ring + checkmark | `aria-selected="true"` |

Encoding state with a second, non-color signal satisfies WCAG 1.4.1 (use of color) — never red/green alone; putting that same state word into the accessible name (as above) is what makes it reach a screen-reader user in the first place, not just a low-vision sighted user.

```
Focus management in countdown/checkout:
  - Countdown: an aria-live="polite" region, but THROTTLE it — announce at thresholds
    (5 min, 1 min, 30 s), never every second, or the screen reader is unusable.
  - On expiry, OR on a server-side early release (A50): move focus to the relevant
    message ("hold expired" / "seat released"); announce assertively either way.
  - Modals (offer, payment): focus-trap on open, return focus to the trigger on close.
  - Respect prefers-reduced-motion → disable zoom/pan animation for those who ask.
```

**Key takeaway: scope the ARIA grid to one section at a time, encode every state with both a non-color signal and words in the accessible name (satisfying WCAG 1.4.1 for sighted and screen-reader users alike), throttle the countdown's live region, move focus on server-side early release exactly like on expiry, and always ship a text-based "find seats" path as a first-class alternative.**

---

### A53. Performance — load, jank, real-time cost, graceful degradation

Four separate budgets — **load, interaction, network, and floor** (the worst device/network you still support) — and one framing rule: treat the static venue geometry and the dynamic status as two different problems.

| Concern | Target (illustrative — verify on target devices/networks) | Lever |
|---|---|---|
| Initial interactive map | ~≤ 2–3 s on a mid device | Edge-served geometry + compact status, LOD-first |
| Zoom/pan frame | 60 fps (~16 ms/frame) | Canvas/WebGL + viewport cull, work off-main-thread |
| Real-time update cost | Only visible sections repaint | Scoped subscriptions + batched deltas (A49) |
| Low-end floor | Still bookable | Feature-detect → fallback tiers |

```
Initial load of 80k:
  - Venue GEOMETRY is immutable per configuration → precompute once, cache hard at the
    edge (see ../cdn-edge/), version by layout id. Never emit 80k nodes per request.
  - STATUS is dynamic → fetch a compact bitmap for the section(s) in view (a few
    hundred bytes; the whole-venue figure is illustrative-only, per A32/A49) from
    cache (see ../distributed-caching/), not 80k JSON rows.
  - Progressive/LOD: paint the section overview first (A48), lazy-load seat detail on zoom.

Avoid jank on zoom/pan:
  - requestAnimationFrame loop; draw only culled, visible seats (A48).
  - Offload heavy geometry/tessellation to a Web Worker; render via OffscreenCanvas
    where available (verify support; fall back to main-thread Canvas).
  - Cheap CSS transform during the gesture, re-raster crisp on settle; handle
    devicePixelRatio. No per-seat DOM → no layout thrash.
```

Real-time cost reuses the scoped-subscription + batched-delta design from A49 (WebSocket primary, see [communication-protocols](../communication-protocols/)): only the visible status layer repaints on a delta, and out-of-order/duplicate deltas are dropped by seat version.

```
Degrade gracefully (decision ladder):
  Renderer:  WebGL? → WebGL ; else Canvas2D? → Canvas ;
             else → section list + heatmap + the "find seats" form (A52)
  Network:   WebSocket ok? → live deltas over WS (A49)
             WS blocked?   → SSE fallback: resync via snapshot + Last-Event-ID
                             (Last-Event-ID is an SSE-specific resume mechanism —
                             the WS path resyncs via its own seq/version cursor instead)
             both blocked? → periodic poll, with a "updated Xs ago" staleness badge
  Device/prefs: low memory / reduced-motion → disable animation, raise LOD threshold,
                shrink the viewport delta batch.
```

On every network path the display can be stale *safely*: a hold is authorized only by the atomic write at the source of truth (A16), so degradation costs a wasted click, never an overbooking.

**Named tradeoff — richness vs reach:** the WebGL live map is the best experience but not one every device can run; the tiered fallback trades visual richness for guaranteed reach (a low-end phone still books via the section list + find-seats form). You never let the fanciest tier be the only tier.

**Key takeaway: split static geometry (edge-cached) from dynamic status (compact, section-scoped bitmap + scoped deltas), keep heavy work off the main thread, and feature-detect down a renderer/network/device ladder — WebSocket first, SSE with Last-Event-ID as its fallback, poll last — so a low-end phone on flaky Wi-Fi still books safely, because display staleness never authorizes a hold.**

---

## Bonus — Unprompted Senior Questions

### AB1. Variable venue configurations — event-time vs venue-time schema

A venue that converts (theater ↔ concert hall) has **different seat counts and section layouts per configuration**, so seat state cannot live on the physical seat — it must live on a **per-event instance of the layout**.

```
The problem: seat A14 exists physically, but whether A14 EXISTS/where it sits/what it
costs depends on the EVENT's configuration. Storing status on the physical seat row
would mean two events sharing a venue clobber each other's inventory.

The fix — separate venue-time from event-time (exactly the split in A31):
  seats            = VENUE-TIME: physical seats + coordinates (may exist in some configs).
  venue_config     = a named layout (e.g., 'theater-mode', 'concert-mode') selecting
                     which sections/seats are active and their coordinates.
  event_seats      = EVENT-TIME: for THIS event, the concrete set of active seats with
                     status/price/version. Generated from (venue_config) at event creation.
```

| Layer | Scope | Example |
|---|---|---|
| `seats` / `venue_config` | Venue-time (physical, reusable) | A14 exists at (x,y) in concert-mode; not used in theater-mode |
| `event_seats` | Event-time (per show) | For event 123: A14 = HELD, $250, version 4 |

**Why this matters:** it makes the same physical venue reusable across arbitrary configurations without inventory collisions, and it's the *same* separation that lets seat *state* be per-event (A31). The instance table (`event_seats`) is generated at event-creation from the chosen config — a snapshot of the layout for that show.

---

### AB2. Predictable hold IDs → bots enumerate and hold every seat

If hold targets or hold IDs are guessable/sequential, a bot can script holds across all seats (denial-of-inventory / scalping disruption). Defenses:

```
1. Non-enumerable identifiers:
   - Hold tokens = random UUIDs / signed opaque tokens, NOT sequential ints.
   - Don't expose internal sequential seat_ids in a way that lets "hold seat_id+1"
     scripting; require the seat to come from a signed seat-map the server issued.

2. Rate limit + quota the HOLD action per identity/IP/session:
   - A human holds a handful of seats; a bot tries hundreds. Cap holds per user per
     event (e.g., ≤ order max) and per-IP/ASN hold rate.

3. Gate behind verification (A29): verified-fan, CAPTCHA/proof-of-work on suspicion,
   bot management at the edge — so mass automated holding is expensive.

4. Detect hold-then-release-before-expiry patterns (the disruption attack) and
   penalize: shrink TTL for suspicious sessions, require re-verification.

5. Bind holds to verified accounts; enforce per-account concurrent-hold limits.
```

| Attack surface | Fix |
|---|---|
| Guessable hold/seat IDs | Random UUID / signed opaque tokens; server-issued seat map |
| Unlimited holds per actor | Per-identity/IP hold quota + rate limit |
| Cheap mass accounts/bots | Verification + edge bot management |
| Hold-then-release griefing | Anomaly detection; penalize; shorten TTL for suspects |

**Named tradeoff — openness vs abuse resistance:** frictionless holds (no login, no limits) are best UX but trivially abusable; quotas + verification add friction but stop enumeration/scalping. For scarce inventory you deliberately add friction — the same call as A29/A40.

---

### AB3. Atomic seat upgrade — cancel 4 seats and book 4 new ones without ending up with none

The user must **never** end up with zero seats due to a partial failure mid-swap. Make the swap **acquire-before-release**, wrapped so it's all-or-nothing.

```
WRONG order (release then acquire) — the dangerous version:
   release old 4  →  [crash]  →  user has NOTHING, and old seats may be gone.

RIGHT order — ACQUIRE new BEFORE releasing old, in one atomic unit:
  1. HOLD the 4 new seats (SET NX). If any fails → abort, keep old seats. No loss.
  2. In ONE DB transaction (or saga with compensation):
       BEGIN;
         -- book the 4 NEW seats (CAS on their holds)
         UPDATE event_seats SET status='BOOKED', booking_id=:newB
           WHERE seat IN (:new4) AND status='HELD' AND hold_id IN (:newHolds);
         -- assert 4 rows; else ROLLBACK (someone took a new seat) → keep old
         -- release the 4 OLD seats
         UPDATE event_seats SET status='AVAILABLE', booking_id=NULL
           WHERE seat IN (:old4) AND booking_id=:oldB;
       COMMIT;
  3. Payment delta (if price differs) via idempotent charge/refund, saga-compensated.
```

If new seats are on a **different shard** than old seats (A33), you can't use one DB transaction — use a **saga**: acquire+book new (forward), then release old; if release fails, the user still has valid seats (the safe failure direction), and a reconciler cleans up. The invariant: **at every intermediate state the user holds at least one valid set of seats.**

| Order of operations | Failure outcome |
|---|---|
| Release old → acquire new | User can end with **zero** seats (unsafe) |
| **Acquire new → release old** | Worst case: user keeps **old** seats (safe) |

**Named tradeoff — atomicity vs cross-shard reality:** a single ACID transaction is cleanest but only works when old and new seats share a shard; across shards you drop to a saga and accept eventual consistency, choosing the *safe* failure direction (keep old seats) so the user is never left with nothing.

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Hardest constraint | Zero overbooking under contention → uniqueness-under-concurrency, unlike a fungible cart |
| Hold vs booking | Hold = Redis TTL soft state; booking = durable DB row; split for latency vs durability |
| Overbooking primitive | Atomic CAS per transition (SET NX / UPDATE ... WHERE status / version) — check-and-act in one op |
| Read/write split | Browse = cacheable eventual; hold/book = source-of-truth strong (CQRS) |
| Redis hold command | `SET event:..:seat NX PX 600000`; nil = already held; Lua compare-and-delete to release |
| Why Redis not DB for holds | TTL auto-release + no 10-min DB locks; holds are soft state you can lose |
| Redis crash | Holds lost → seats revert to AVAILABLE (no double-book); Sentinel/Cluster limit blast radius |
| RedLock caveat | Not a hard mutex under GC/clock skew (Kleppmann); DB CAS is the real guarantee |
| Two-users-one-seat | Pessimistic (FOR UPDATE) / optimistic (version CAS) / Redis NX — exactly one writer wins |
| Optimistic vs pessimistic | Optimistic for low-contention holds; pessimistic for one hot row; watch conflict rate |
| Lost update fix | Write's WHERE must re-assert the read: `... WHERE status='AVAILABLE'`, check rowcount |
| Stale replica double-book | Prevented because the hold validates against source of truth, not the stale read |
| Fail-open vs fail-closed | Fail CLOSED on the hold primitive; correctness > availability; shrink outage via failover |
| ACID boundary | Seat flip + booking + payment record in one txn; payment charge is external → saga |
| Idempotency key | Deterministic per order+hold; DB unique constraint + provider idempotency key |
| Charge-then-crash | Outbox + reconciler: money captured ⇒ eventually valid booking OR refund |
| Saga | hold/charge/confirm/issue each with a compensation; orchestrated; idempotent steps |
| 408 timeout | Never blind-retry; re-send with same idempotency key or query status |
| Expiry-vs-payment race | DB CAS on `status='HELD' AND hold_id=?` is arbiter; loser refunded; fence with token |
| Thundering herd | 150K arrivals saturate DB pool → retry storm → cascade (Ticketmaster 2022) |
| Virtual queue | Stateless edge gate; admits at inventory's safe rate; DB sees admitted, not arrival |
| Fair queue position | Atomic INCR or sorted-set by arrival; signed token so position can't be forged |
| Admission control | Closed loop on p99/pool/error rate; AIMD; keep DB ~60–70% utilization |
| Bot mitigation | Verify humans + bot detection at the GATE, before inventory (2022 lesson) |
| Scale inventory | Shard by event_id; sub-shard hot event by section; queue caps admitted rate |
| Schema (venue vs event) | Physical seats (venue-time) + event_seats status (event-time); composite PK (event,seat) |
| Seat-map <200ms | Covering index + Redis cache + WebSocket delta push + 2-bit bitmap (~20KB/80K seats) |
| Shard key = event_id | Multi-seat order = single-shard txn; breaks cross-event queries + hot mega-event |
| Browse vs book stores | Elasticsearch (eventual) via CDC from inventory RDBMS (strong) — CQRS staleness OK |
| Confirmed-without-pay incident | Rollback, quantify via reconcile, remediate, add money⇒seat invariant monitor |
| 1B-row migration | Expand→backfill(batched)→flip→contract; gh-ost / pt-osc / CREATE INDEX CONCURRENTLY |
| DB failover | Promote replica, fence old (STONITH); holds survive in Redis; sync-repl for RPO≈0 |
| Zookeeper for holds | Reject — consensus per lock can't do millions of TTL holds; use ZK for few coarse locks |
| Global events | Home-region authority for writes; local read replicas; consistency over latency (no multi-master) |
| Dynamic pricing | Lock price AT HOLD; charge held price; push price deltas; revenue vs price-consistency |
| Atomic upgrade | Acquire-new-before-release-old; single txn or saga; safe failure = keep old seats |
