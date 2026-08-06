# Pattern: Multi-Step Processes

> **Interviewer signal:** "place an order", "onboard a user", "process a payment then ship it", "if step 3 fails, what happens to steps 1 and 2?", "a workflow", "the trip lifecycle".

A business operation that touches several services, each with its own database, and must end in a *consistent* state even though any step can fail, time out ambiguously, or be retried. There is no distributed rollback available to you, so the entire pattern is about **making forward progress durable and making failure recoverable** rather than pretending the operation is atomic.

📖 Source outline: [hellointerview.com — Multi-step Processes](https://www.hellointerview.com/learn/system-design/patterns/multi-step-processes) (prose paywalled; depth below is this repo's own). The source cites Jimmy Bogard's talk *"Six Little Lines of Fail"* — worth watching, as it walks the exact decomposition below.

---

## Table of Contents

1. [The Problem: Six Lines, Nine Failure Modes](#1-the-problem-six-lines-nine-failure-modes)
2. [Rung 0: Keep It in One Transaction](#2-rung-0-keep-it-in-one-transaction)
3. [Why Not 2PC](#3-why-not-2pc)
4. [The Saga Pattern](#4-the-saga-pattern)
5. [Choreography vs Orchestration](#5-choreography-vs-orchestration)
6. [The Persisted State Machine (the workhorse answer)](#6-the-persisted-state-machine-the-workhorse-answer)
7. [Durable Execution Engines](#7-durable-execution-engines)
8. [The Dual-Write Problem and the Outbox](#8-the-dual-write-problem-and-the-outbox)
9. [Idempotency: Why "Exactly Once" Is a Lie](#9-idempotency-why-exactly-once-is-a-lie)
10. [Compensation Is Not Rollback](#10-compensation-is-not-rollback)
11. [Saga Isolation: The Anomaly Nobody Mentions](#11-saga-isolation-the-anomaly-nobody-mentions)
12. [External Events, Timers, and Human Steps](#12-external-events-timers-and-human-steps)
13. [Versioning In-Flight Workflows](#13-versioning-in-flight-workflows)
14. [Decision Framework](#14-decision-framework)
15. [Where This Shows Up in This Repo](#15-where-this-shows-up-in-this-repo)
16. [Real-World Cases](#16-real-world-cases)
17. [Interview Questions](#17-interview-questions)
18. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Problem: Six Lines, Nine Failure Modes

Innocent-looking order fulfilment:

```python
def place_order(cart, card):
    order   = orders.create(cart)              # 1. our DB
    charge  = stripe.charge(card, cart.total)  # 2. external, non-idempotent by default
    inventory.reserve(cart.items)              # 3. another service
    warehouse.create_shipment(order.id)        # 4. another service
    email.send_confirmation(order)             # 5. external, irreversible
    orders.mark_confirmed(order.id)            # 6. our DB
```

Now enumerate reality:

| What happens | Consequence |
|---|---|
| Process crashes after line 2 | Customer charged, no order confirmed, no shipment. **Worst case in the list** |
| Line 3 fails (out of stock) | Charged for something that will never ship |
| Line 4 times out — did the shipment get created? | Retrying may create **two** shipments |
| Line 5 succeeds, line 6 crashes | Customer has a confirmation email for an order your DB thinks is pending |
| Whole function is retried by an impatient client / a load balancer | Two orders, two charges |
| Line 2 returns a network timeout | You genuinely do not know if the money moved. **You cannot resolve this locally** |
| Inventory reserved, then order is abandoned | Stock leaked, invisible to everyone |
| Line 4 succeeds slowly, after your timeout fired and you compensated | Shipment exists for a cancelled order |
| Two of these run concurrently for the same cart | See [Dealing with Contention](./dealing-with-contention.md) |

Three root causes worth naming explicitly, because each has a distinct fix:

1. **No shared transaction boundary.** Each service commits independently, so there is no rollback that spans them. → *Saga + compensation.*
2. **The state of the process lives in a stack frame.** A crash erases which steps completed. → *Persist the process state, don't hold it in memory.*
3. **Ambiguous failure.** A timeout is not a "no". → *Idempotency keys + reconciliation.*

→ [`distributed-transactions §1`](../interviews/distributed-transactions/deep-dive.md#1-the-problem-why-local-acid-doesnt-cross-boundaries)

---

## 2. Rung 0: Keep It in One Transaction

Before designing a workflow engine, ask whether you need one.

If every step touches **one** database, a single ACID transaction solves the entire problem for free, and no amount of saga sophistication will beat it. A meaningful number of "distributed transaction" interview problems are really "you drew your service boundaries in a place that made this hard" problems.

```
Order + inventory + payment record in one Postgres instance?
  → BEGIN; …all of it…; COMMIT;   Done. Move on.
```

The escalation triggers are: a genuinely external system (a payment processor — you will never have a transaction with Stripe), a step that takes longer than a transaction should be held open (see [contention rung 3](./dealing-with-contention.md#6-rung-3-pessimistic-locking)), an irreversible side effect (email, SMS, push), or independently-scaled services with separate stores.

**In an interview, say this out loud before escalating.** "First — can these live in one transaction? Payment can't, because Stripe is external. So the boundary is between our order write and the charge, and *that's* the seam that needs a saga." That single sentence demonstrates you're not cargo-culting complexity. Redesigning the boundary is a legitimate solution — [`distributed-transactions §15`](../interviews/distributed-transactions/deep-dive.md#15-spanner-percolator-and-redesigning-boundaries) covers it alongside Spanner and Percolator.

---

## 3. Why Not 2PC

Two-phase commit gives real atomicity across participants: a coordinator asks everyone to `PREPARE`, and only if all vote yes does it send `COMMIT`.

```
Coordinator ──PREPARE──► A ✓   B ✓   C ✓
Coordinator ──COMMIT───► A     B     C
```

It works, it's used inside databases and across XA-capable resource managers — and it's the wrong tool for internet-scale service orchestration:

| Problem | Detail |
|---|---|
| **Blocking on coordinator failure** | If the coordinator dies after participants voted "prepared", they hold locks and cannot unilaterally decide. Resources stay locked until it recovers — an availability sink |
| **Availability multiplies down** | Every participant must be up *simultaneously*. Five services at 99.9% ≈ 99.5% for the transaction |
| **Locks held for a network round trip** | Throughput on contended rows collapses |
| **External services don't support it** | Stripe has no `PREPARE`. This alone rules it out for most real workflows |
| **3PC doesn't rescue it** | It reduces blocking but assumes bounded delays it can't guarantee, and adds a round trip |

→ [`distributed-transactions §7`](../interviews/distributed-transactions/deep-dive.md#7-two-phase-commit-2pc) · [`§8 The Blocking Problem and 3PC`](../interviews/distributed-transactions/deep-dive.md#8-the-blocking-problem-and-3pc)

So we trade atomicity for availability and accept that the system will be **temporarily inconsistent** — visibly so — and design for eventual convergence instead. That trade *is* the saga pattern.

---

## 4. The Saga Pattern

A saga is a sequence of local transactions, each with a **compensating action** that semantically undoes it. Run forward; on failure, run the compensations for the steps that already succeeded, in reverse.

```
Forward path:
  T1 create order ──► T2 charge card ──► T3 reserve stock ──► T4 ship
                                              ✗ FAILS

Compensation path (reverse order):
  C2 refund card ◄── C1 cancel order
     (T3 never committed, so nothing to compensate for it)
```

Two properties every step needs:

- **Retryable** (idempotent), because the saga will re-drive steps after crashes.
- **Compensatable**, or else *pivot-ordered*: put irreversible steps as late as possible. Once you've sent the email or handed a package to a courier, compensation is a customer-service process, not code. The step after which you can no longer cleanly abort is the **pivot transaction** — everything before it must be compensatable, everything after it must be retried until it succeeds.

That ordering insight is a strong interview point: **sequence your steps so the cheap-to-undo ones happen first and the irreversible one happens last.** Charge the card *before* dispatching the courier, reserve stock *before* charging when stock is the scarcer resource.

→ [`distributed-transactions §9`](../interviews/distributed-transactions/deep-dive.md#9-the-saga-pattern)

---

## 5. Choreography vs Orchestration

Two ways to drive a saga, and interviewers very often ask you to compare them.

### Choreography — services react to events

```
OrderService ──"OrderCreated"──► [bus]
                                   ├─► PaymentService  → "PaymentCaptured" ──► [bus]
                                   │                                            ├─► InventoryService → "StockReserved"
                                   │                                            └─► …
                                   └─► AnalyticsService (nobody had to know it exists)
```

| Wins | Loses |
|---|---|
| Loose coupling — no service knows the flow | **Nobody knows the flow.** It exists only as tribal knowledge across N repos |
| New subscribers added with zero changes upstream | Debugging requires distributed tracing to reconstruct what happened |
| No central component to scale or own | Cyclic dependencies creep in silently |
| Naturally parallel | "Where is order 1234 stuck?" has no single place to look |
| | Compensation logic is scattered — each service must know how to undo itself *and* when |

### Orchestration — a coordinator owns the flow

```
             ┌────────────────────┐
             │  OrderOrchestrator │  ← owns the state machine, persists progress
             └─┬────┬────┬────┬───┘
   command─────┘    │    │    └──────► WarehouseService
   PaymentService ◄─┘    └───► InventoryService
```

| Wins | Loses |
|---|---|
| The flow is **one readable artifact** | A component to build, own, and scale |
| Trivial to answer "where is order 1234?" | Risk of a god-service accumulating business logic |
| Compensation lives next to the forward path | Services become more coupled to the orchestrator's commands |
| Timeouts, retries, and state are one concern | A single (logical) point of failure — needs its own HA story |

**The recommendation to give:** orchestration for the core money/state-critical path where you must be able to answer "what happened to this order", choreography for peripheral reactions (analytics, notifications, search indexing, recommendations) where new consumers should be free to appear. Nearly every real e-commerce system is exactly this hybrid — and saying so is a better answer than picking one.

→ [`e-commerce §5 Order Orchestration — Saga & Outbox`](../interviews/e-commerce/deep-dive.md#5-order-orchestration--saga--outbox) · [`food-delivery §5 Order Lifecycle & Event-Driven Orchestration`](../interviews/food-delivery/deep-dive.md#5-order-lifecycle--event-driven-orchestration)

---

## 6. The Persisted State Machine (the workhorse answer)

You can implement a perfectly good orchestrator without any framework, and this is what most production systems actually are. It's the highest-value thing to be able to sketch.

```sql
CREATE TABLE order_saga (
  order_id        uuid PRIMARY KEY,
  state           text NOT NULL,     -- CREATED│CHARGING│CHARGED│RESERVING│…│DONE│COMPENSATING│FAILED
  idempotency_key text NOT NULL,     -- passed to external calls
  attempt         int  DEFAULT 0,
  next_retry_at   timestamptz,       -- backoff schedule
  updated_at      timestamptz,       -- for stuck-state detection
  payload         jsonb
);
```

Three components, and each maps to a failure mode from §1:

1. **State transitions are committed *before* the side effect is attempted.** Write `CHARGING`, commit, *then* call Stripe. On recovery, `CHARGING` means "a charge may or may not have happened" — which is exactly the truth, and you resolve it with the idempotency key rather than guessing.
2. **A driver** picks up rows whose `next_retry_at` has passed and advances them. This is what makes progress durable: the process state lives in the database, not in a stack frame, so a crash loses nothing.
3. **A reconciler / sweeper** finds rows stuck in a non-terminal state past a threshold and either re-drives, compensates, or alerts a human.

> **That third component is the one candidates forget, and interviewers specifically look for it.** Every multi-step process needs an answer to "what finds the orders stuck in `CHARGING` for two hours?" Without a sweeper, your happy path is fine and your failures are silent and permanent.

Add an **audit/event log** of every transition (`order_id, from, to, at, actor, reason`) and you get debuggability, a customer-support timeline, and the raw material for reconciliation against the payment provider's records. Cheap to build, enormously valuable — [`payment-system §6 Webhooks, Retries & Reconciliation`](../interviews/payment-system/deep-dive.md#6-webhooks-retries--reconciliation).

The state-machine-as-API-design view is in [`api-design §3`](../interviews/api-design/deep-dive.md#3-state-transitions-and-business-operations); a fully worked lifecycle is [`ride-sharing §4 Trip Lifecycle & State Machine`](../interviews/ride-sharing/deep-dive.md#4-trip-lifecycle--state-machine).

---

## 7. Durable Execution Engines

The framework version of §6: write the workflow as ordinary sequential code, and let the engine make it crash-proof.

```python
@workflow
def place_order(cart, card):
    order  = yield activity(create_order, cart)          # each result is
    charge = yield activity(charge_card, card, cart.total) # durably recorded
    yield activity(reserve_stock, cart.items)
    yield activity(create_shipment, order.id)
    yield activity(send_email, order)
```

**How it works** — this is the part to be able to explain:

1. Workflow code runs and each `activity` call's **input and result are appended to a durable event history**.
2. If the worker crashes, the engine schedules the workflow on another worker and **replays the history from the beginning** — but instead of re-executing activities, it feeds each call the recorded result. Execution fast-forwards to exactly where it stopped, with local variables reconstructed.
3. Past that point, execution continues live.

It's event sourcing applied to a call stack. The consequences:

| Requirement | Why |
|---|---|
| **Workflow code must be deterministic** | Replay must take the same branches. No `now()`, no `random()`, no direct I/O, no unguarded iteration over a map with nondeterministic order — the engine provides deterministic substitutes |
| **All side effects go in activities** | Only activities are recorded and skipped on replay. An HTTP call in workflow code fires again on every replay |
| **Activities are at-least-once** | The engine retries them per policy, so they must be idempotent. Durable execution does not eliminate idempotency work — it eliminates *state-tracking* work |
| **Versioning is a real problem** | Changing the code changes the replay path for in-flight executions — see [§13](#13-versioning-in-flight-workflows) |

**Implementations** (verify current APIs against their docs before relying on specifics): Temporal and its predecessor Cadence; AWS Step Functions (state machine defined as JSON/ASL rather than code — a managed orchestrator, not a replay engine in the same sense); Azure Durable Functions; Restate; DBOS; Airflow and friends for scheduled data pipelines rather than per-request workflows.

**When to reach for one in an interview:** long-lived processes (days/weeks — subscription lifecycles, KYC, multi-day fulfilment), many steps with complex retry/timeout policies, human-in-the-loop approvals, or when you'd otherwise hand-roll the same driver+sweeper for the fifth time. **When not to:** a three-step process inside one service with one external call — a state column and a retry worker is less machinery, and reaching for Temporal there reads as over-engineering. Also be honest that it's an operational commitment: a cluster (or vendor), workers, and a new failure domain.

---

## 8. The Dual-Write Problem and the Outbox

The bug that quietly breaks every event-driven workflow:

```python
db.commit(order)                 # ✅ committed
bus.publish("OrderCreated", …)   # ❌ crashes here
# → order exists, nobody downstream knows. Forever.
```

Reversing the order just moves the bug (event published for an order that doesn't exist). You cannot atomically write to two systems without a transaction spanning both — which is the very thing you rejected in §3.

**The transactional outbox** makes it one write:

```sql
BEGIN;
  INSERT INTO orders …;
  INSERT INTO outbox (id, topic, payload) VALUES (…, 'OrderCreated', …);
COMMIT;                       -- one atomic commit, one database
-- A relay process tails the outbox and publishes, marking rows sent.
-- Crash before publish → row still there → published on next pass.
```

The relay reads either by polling the table or by tailing the DB's replication log (**CDC** — Debezium et al.), which avoids polling load and captures ordering naturally.

Because the relay can crash *after* publishing but *before* marking the row sent, delivery is **at-least-once** — which brings us to idempotency, again. The inverse pattern, **inbox**, dedupes on the consumer side by recording processed message IDs in the same transaction as the business write.

→ [`distributed-transactions §2 The Dual-Write Problem`](../interviews/distributed-transactions/deep-dive.md#2-the-dual-write-problem) · [`§11 Transactional Outbox and CDC`](../interviews/distributed-transactions/deep-dive.md#11-transactional-outbox-and-cdc) · the chat-system deep dive shows an outbox processor in code at [`§2`](../interviews/chat-system/deep-dive.md#2-message-delivery--ordering)

---

## 9. Idempotency: Why "Exactly Once" Is a Lie

You cannot have exactly-once *delivery*: the sender can't distinguish "receiver never got it" from "receiver got it and the ack was lost", so it must either risk losing it (at-most-once) or risk duplicating it (at-least-once). What you *can* have is **exactly-once effect** = at-least-once delivery + idempotent handling.

The mechanism, end to end:

```
1. Caller generates a stable key            Idempotency-Key: 7f3c…  (per business
                                            operation — NOT per retry attempt)
2. Server, in ONE transaction:
     INSERT INTO idempotency (key, status) VALUES (…, 'in_progress')
       ON CONFLICT DO NOTHING;
     -- 0 rows → someone else is doing it or already did:
     --     completed  → return the STORED RESPONSE (same body, same status)
     --     in_progress→ return 409 / tell client to retry later
3. Do the work, then store the response body against the key, same transaction
4. Retries with the same key replay the stored response and cause no new effects
```

Details that get probed:

- **Key stability**: generated by the *client*, tied to the business intent, and reused across retries — otherwise every retry looks like a new operation. A key derived from the request body hash also works, and defends against a buggy client.
- **Store the response, not just a flag.** A retry needs to receive the original result (the order ID, the charge ID), not merely "already done".
- **Scope and TTL**: keys are per-endpoint and per-tenant; retain long enough to cover the retry horizon plus reconciliation (days, not minutes, for money).
- **Naturally idempotent operations** need none of this: setting an absolute value (`status = SHIPPED`), or a conditional write guarded by current state. `balance = balance - 10` is *not* naturally idempotent; `INSERT … ON CONFLICT DO NOTHING` is.
- **Ambiguous timeouts** are why this exists at all: when the charge call times out, the correct move is to retry *with the same key* — the provider dedupes and tells you the real outcome. Never assume a timeout means failure. [`payment-system §4 Never Trust A Timeout`](../interviews/payment-system/deep-dive.md#4-never-trust-a-timeout)

→ [`distributed-transactions §12`](../interviews/distributed-transactions/deep-dive.md#12-idempotency-and-exactly-once) · [`api-design §4`](../interviews/api-design/deep-dive.md#4-idempotency-and-safe-retries) · [`payment-system §3`](../interviews/payment-system/deep-dive.md#3-idempotency--exactly-once)

---

## 10. Compensation Is Not Rollback

A rollback erases history; a compensation writes new history that offsets the old. The differences all bite in practice:

| | Rollback | Compensation |
|---|---|---|
| Visibility | Nobody ever saw the change | The change **was visible**, and may have been acted on |
| Trace | None | A refund line, a cancellation record — permanent and auditable |
| Can it fail? | No | **Yes** — and then what? |
| Always possible? | Yes | No. Emails sent, packages shipped, SMS delivered |

So a compensation is itself a step that needs retries, idempotency, and an escalation path. `refund()` failing because the payment provider is down cannot be allowed to silently drop the customer's money — it retries with backoff, then lands in a dead-letter queue with an alert and a manual runbook. **"What if the compensation fails?" is a favourite follow-up; the answer is retry → DLQ → human, never "it won't".**

Design guidance that follows:
- Prefer **semantic** compensation: a refund rather than an attempted un-charge; a cancellation record rather than deleting the order (support needs to see it existed).
- **Order steps by reversibility**, irreversible last (the pivot).
- For truly irreversible steps, switch from compensation to **retry-until-success** with alerting — the saga must go forward, not back, past the pivot.
- Money-moving flows use double-entry bookkeeping, so a reversal is a new pair of entries and the ledger stays append-only and auditable: [`payment-system §5`](../interviews/payment-system/deep-dive.md#5-the-double-entry-ledger) · [`§7 Money Flowing Backwards`](../interviews/payment-system/deep-dive.md#7-money-flowing-backwards)

---

## 11. Saga Isolation: The Anomaly Nobody Mentions

Sagas give you A, C(eventually), and D — but **no I**. There is no isolation, so intermediate states are *visible to everyone*, and other transactions can act on them.

Two named anomalies:

- **Dirty read**: another process reads `order.status = CHARGED` before the saga later compensates and cancels it. It made a decision on state that got un-made.
- **Lost update**: a concurrent process modifies a record the saga is midway through, and the compensation overwrites it.

Countermeasures (each is a legitimate interview answer):

| Countermeasure | How |
|---|---|
| **Semantic lock** | An explicit in-flight marker (`status = PENDING_APPROVAL`) that other actors are required to respect. Cheap and the most common |
| **Commutative updates** | Design steps so order doesn't matter (`increment(-10)` rather than `set(90)`), so overlap is harmless |
| **Pessimistic view** | Reorder steps so the risky-to-expose state happens as late as possible |
| **Re-read value** | Re-read and re-verify immediately before writing, aborting if it changed (OCC inside the saga) |
| **Version file / by value** | Record the operations applied so out-of-order arrivals can be reordered or rejected; route high-risk transactions through a stricter path |

→ [`distributed-transactions §10 Saga Isolation and Countermeasures`](../interviews/distributed-transactions/deep-dive.md#10-saga-isolation-and-countermeasures)

The user-facing corollary: because intermediate state is visible, your **UI must model it**. "Payment processing", "order pending" — exposing the honest intermediate state is far better than a spinner that lies, and it's a design decision worth mentioning.

---

## 12. External Events, Timers, and Human Steps

Real workflows wait on things that aren't API calls: a webhook from a payment provider, a manager's approval, a KYC review, "cancel free within 24 hours", "if the restaurant doesn't accept in 5 minutes, reassign".

The primitives:

- **Durable timers.** "Sleep 24 hours" must survive restarts, so it cannot be `sleep()` in a process — it's a persisted `wake_at` row plus a scheduler, or the engine's timer API. A cancellation window is a timer that races the cancel path.
- **Signals / correlation.** An inbound webhook must be matched to the waiting workflow by a **correlation ID** carried through the whole flow. Webhooks arrive **at-least-once and out of order**, sometimes before your own synchronous response has landed — so handlers must be idempotent and must tolerate arriving early. That last case is a classic bug: the webhook for a charge arrives before your code has finished recording that it initiated the charge.
- **Timeouts as first-class transitions.** Every wait state needs an expiry edge in the state machine. A workflow that can wait forever *will*.
- **Human tasks** are just long waits with an assignee and an escalation timer.
- **Reconciliation** is the safety net for all of it: periodically compare your state against the external system's authoritative records and repair drift, because some webhook, somewhere, will be lost. For money, this isn't optional. [`payment-system §6`](../interviews/payment-system/deep-dive.md#6-webhooks-retries--reconciliation)

---

## 13. Versioning In-Flight Workflows

The problem unique to durable execution, and a great senior-level question.

A workflow started last Tuesday is mid-flight. You deploy new code that inserts a step between 2 and 3. On the next replay, the engine's recorded history says step 3 was `reserve_stock`, but the new code asks for `check_fraud` — a **non-determinism error**, and the workflow is stuck.

Strategies:

| Strategy | Detail |
|---|---|
| **Version gates / patching** | Branch on a version marker so old executions replay the old path and new ones take the new one. Explicit and safe; accumulates dead branches you must eventually prune |
| **Pin workers by version** | Run old and new worker pools side by side; route each execution to workers matching its version. Clean, but you operate N pools until the old ones drain |
| **Drain and cut over** | Stop starting old-version workflows, let in-flight ones finish, then deploy. Only viable when workflows are short |
| **Externalize the volatile part** | Keep the workflow skeleton stable and put frequently-changing logic inside activities, which aren't replay-constrained |

The general principle: **a durable workflow's code is a schema.** Changing it is a migration, with the same compatibility discipline you'd apply to a database column or a public API — which is also the answer to why the hand-rolled state machine in §6 is sometimes preferable: a `state` column is far easier to migrate than a replay history.

---

## 14. Decision Framework

```
Can all steps commit in ONE database transaction?
├─ YES ──────────────────────────────► Just use a transaction. Stop.
└─ NO
   │
   ├─ Do I need to publish an event about a state change?
   │     ─────────────────────────────► TRANSACTIONAL OUTBOX (+ CDC).
   │                                    Never write-then-publish.
   │
   ├─ How many steps, and how long-lived?
   │  ├─ 2–4 steps, seconds, one owning service
   │  │      ─────────────────────────► PERSISTED STATE MACHINE
   │  │                                 (state column + retry driver + sweeper)
   │  ├─ Many steps, complex retries/timeouts, days-to-weeks,
   │  │  human approvals
   │  │      ─────────────────────────► DURABLE EXECUTION ENGINE
   │  └─ Peripheral reactions (analytics, search index, notifications)
   │         ─────────────────────────► EVENT CHOREOGRAPHY
   │
   ├─ Who should own the flow?
   │  ├─ Money / core state, must answer "where is order 1234?"
   │  │      ─────────────────────────► ORCHESTRATION
   │  └─ Consumers should be addable without upstream changes
   │         ─────────────────────────► CHOREOGRAPHY
   │       (real systems: orchestrate the core, choreograph the edges)
   │
   └─ Always, regardless of choice:
        • idempotency key on every mutating step
        • compensations ordered in reverse, irreversible step LAST (pivot)
        • timeout transition on every wait state
        • a SWEEPER for stuck non-terminal states
        • correlation ID + distributed tracing
        • reconciliation against external systems of record
```

---

## 15. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **Distributed transactions** | The theory home: sagas, 2PC/3PC, outbox+CDC, idempotency, saga isolation, anti-patterns | [`§7 2PC`](../interviews/distributed-transactions/deep-dive.md#7-two-phase-commit-2pc) · [`§9 Saga`](../interviews/distributed-transactions/deep-dive.md#9-the-saga-pattern) · [`§10 Isolation`](../interviews/distributed-transactions/deep-dive.md#10-saga-isolation-and-countermeasures) · [`§11 Outbox`](../interviews/distributed-transactions/deep-dive.md#11-transactional-outbox-and-cdc) · [`§12 Idempotency`](../interviews/distributed-transactions/deep-dive.md#12-idempotency-and-exactly-once) · [`§17 Anti-patterns`](../interviews/distributed-transactions/deep-dive.md#17-anti-patterns-to-name-and-avoid) |
| **E-commerce** | Order orchestration with saga + outbox, and the four-stage consistency gradient across browse→cart→checkout→fulfil | [`§5`](../interviews/e-commerce/deep-dive.md#5-order-orchestration--saga--outbox) · [`§1`](../interviews/e-commerce/deep-dive.md#1-the-consistency-gradient--why-four-stages) · [`§10 Failure Modes`](../interviews/e-commerce/deep-dive.md#10-failure-modes) |
| **Payment system** | The hardest real instance: PSP boundary, idempotency, ambiguous timeouts, webhooks, reconciliation, refunds | [`§2`](../interviews/payment-system/deep-dive.md#2-the-payment-flow--the-psp-boundary) · [`§3`](../interviews/payment-system/deep-dive.md#3-idempotency--exactly-once) · [`§4`](../interviews/payment-system/deep-dive.md#4-never-trust-a-timeout) · [`§6`](../interviews/payment-system/deep-dive.md#6-webhooks-retries--reconciliation) · [`§7`](../interviews/payment-system/deep-dive.md#7-money-flowing-backwards) |
| **Food delivery** | Event-driven orchestration across a 3-sided marketplace, with prep-aware dispatch as a timed step | [`§5`](../interviews/food-delivery/deep-dive.md#5-order-lifecycle--event-driven-orchestration) · [`§6`](../interviews/food-delivery/deep-dive.md#6-courier-dispatch--prep-aware-just-in-time-assignment) |
| **Ride sharing** | A fully worked persisted state machine for the trip lifecycle | [`§4`](../interviews/ride-sharing/deep-dive.md#4-trip-lifecycle--state-machine) · [`§3 Matching`](../interviews/ride-sharing/deep-dive.md#3-matching-algorithm) |
| **Seat reservation** | Where contention hands off to a saga: hold → payment → booking, with the ACID boundary drawn explicitly | [`§6`](../interviews/seat-reservation/deep-dive.md#6-payment-acid-boundary-idempotency-and-the-saga) |
| **Video streaming** | A pipeline-shaped workflow: upload → transcode ladder → package → publish, all restartable | [`§2 Upload`](../interviews/video-streaming/deep-dive.md#2-the-upload-pipeline) · [`§3 Transcoding`](../interviews/video-streaming/deep-dive.md#3-transcoding-architecture) |
| **Notification system** | Ingestion→dispatch pipeline with at-least-once delivery and idempotent send | [`§3`](../interviews/notification-system/deep-dive.md#3-the-core-pipeline-ingestion-to-dispatch) · [`§5`](../interviews/notification-system/deep-dive.md#5-delivery-guarantees-and-idempotency) |
| **API design** | Modelling state transitions and business operations as resources; idempotent endpoints | [`§3`](../interviews/api-design/deep-dive.md#3-state-transitions-and-business-operations) · [`§4`](../interviews/api-design/deep-dive.md#4-idempotency-and-safe-retries) |
| **Message queues** | The transport every choreographed saga rides on: DLQs, consumer groups, delivery semantics | [`message-queues/deep-dive.md`](../interviews/message-queues/deep-dive.md) |
| **Observability** | How you actually debug a distributed workflow: spans and context propagation | [`§6`](../interviews/observability/deep-dive.md#6-distributed-tracing-spans-and-context-propagation) |

---

## 16. Real-World Cases

| Case | What's done | Lesson |
|---|---|---|
| **Uber (Cadence → Temporal)** | Uber built Cadence for exactly this problem; Temporal is its lineage | Durable execution came out of a company drowning in hand-rolled state machines — the pattern is a response to real repeated pain |
| **Amazon order pipeline** | Long-running orchestrated fulfilment; "your order is being prepared" states are exposed to users | Intermediate saga state becomes *product surface*. Model it honestly instead of hiding it |
| **Stripe** | Idempotency keys on every mutating endpoint; webhooks with at-least-once delivery and signature verification | The industry-standard interface for making an external step safe to retry. Copy it |
| **Netflix Conductor** | An orchestration engine for media pipelines | Media encoding is the classic many-step, expensive-to-redo workflow; checkpoint per step |
| **Airbnb / booking flows** | Reservation hold → payment → confirmation, with cancellation windows as durable timers | The contention pattern and this pattern meet at the hold-then-pay seam |
| **AWS Step Functions** | Workflow as an explicit state machine definition, visualized | Sometimes the deliverable is the *diagram* — a flow the whole org can see beats clever code |
| **Bank ACH / settlement** | Multi-day workflows with reconciliation files and manual exception queues | At the far end, "handle the failure" means a human queue with an SLA. Design for that instead of pretending |

---

## 17. Interview Questions

**Q1. Six lines that create an order, charge a card, reserve stock, ship, and email. What breaks?**
Every boundary between two lines is a crash point, and each leaves a different inconsistency. The worst is crashing after the charge: the customer is out of money with no order. Timeouts are worse than failures, because a timed-out shipment call leaves you unable to tell whether a shipment exists, so retrying may create two. And the email is irreversible — once sent, no compensation exists. The three root causes are: no transaction spans the services, the process state lives in a stack frame that a crash erases, and a timeout is not a "no".

**Q2. Why not 2PC?**
Because it trades exactly the property I need most. If the coordinator dies between the prepare and commit phases, participants sit holding locks unable to decide unilaterally, so a coordinator failure becomes a multi-service availability outage. Every participant must also be simultaneously available, so composed availability degrades multiplicatively. And decisively: external providers like Stripe expose no `PREPARE` phase, so 2PC isn't even available for the step that most needs atomicity. 3PC reduces blocking but assumes bounded message delay it can't guarantee. So I give up atomicity, accept visible temporary inconsistency, and design for convergence — that's a saga.

**Q3. Explain a saga, and what each step must guarantee.**
A saga is a sequence of local transactions, each paired with a compensating action that semantically undoes it. Run forward; on failure, run compensations for completed steps in reverse. Every step must be idempotent, because crashes cause re-drives, and either compensatable or positioned after the pivot — the point past which you can no longer cleanly abort. That's why step ordering is a design decision: cheap-to-undo steps first, irreversible ones last. After the pivot, failure handling flips from "compensate backward" to "retry forward until it succeeds", because there's no way back.

**Q4. Choreography or orchestration?**
Both, in different places. Choreography — services reacting to events — gives loose coupling and lets new consumers appear without upstream changes, but the flow exists nowhere as an artifact, so "where is order 1234 stuck?" requires reconstructing it from traces across N services, and compensation logic scatters. Orchestration puts the flow in one readable place with one owner for state, retries, and timeouts, at the cost of a component to run and the risk of a god-service. My default: orchestrate the core money/state path where I must be able to answer questions about a specific order, and choreograph the periphery — analytics, search indexing, notifications — where I want new subscribers to be free. Most real e-commerce systems are precisely that hybrid.

**Q5 (depth). No framework allowed. Design a reliable order workflow.**
A state column on the order plus three moving parts. First, transitions commit *before* the side effect: write `CHARGING`, commit, then call the provider — so on recovery `CHARGING` honestly means "a charge may have happened", which I resolve by retrying with the same idempotency key rather than guessing. Second, a driver process that picks up rows whose `next_retry_at` has passed and advances them with exponential backoff, so progress lives in the database rather than a stack frame. Third — and this is the one people forget — a sweeper that finds rows stuck in non-terminal states past a threshold and re-drives, compensates, or pages a human. I'd also append every transition to an audit log, which gives me support timelines and the input to reconciliation. That's maybe 200 lines and it covers the failure modes that matter.

**Q6 (depth). How does durable execution survive a crash mid-workflow?**
The engine records every activity's input and result in a durable event history. When a worker dies, the workflow is rescheduled elsewhere and the engine **replays the workflow function from the top** — but instead of re-executing activities, it returns the recorded results, so local variables and control flow are reconstructed deterministically until execution reaches the point where history runs out, and then it continues live. It's event sourcing applied to a call stack. The consequences are the real content: workflow code must be deterministic — no wall-clock time, randomness, or I/O outside activities, or replay diverges — and activities are still at-least-once, so they must be idempotent. Durable execution removes the *state-tracking* burden, not the idempotency burden.

**Q7 (depth). You commit the order then publish `OrderCreated` and crash in between. Fix it.**
That's the dual-write problem, and reordering just changes which side is wrong. The fix is the transactional outbox: insert the order and an outbox row in the *same* transaction against the *same* database, so the write is atomic, then have a relay publish outbox rows and mark them sent — either by polling the table or by tailing the replication log via CDC. If the relay crashes after publishing but before marking, the message is published twice, so delivery is at-least-once and consumers need to dedupe, typically with an inbox table recording processed message IDs in the same transaction as the business write.

**Q8 (senior). Your charge call times out. What do you do?**
Nothing irreversible, because a timeout is genuinely ambiguous — the money may have moved. I retry the same call with the same idempotency key, which lets the provider either replay the original outcome or process it once, and that resolves the ambiguity authoritatively instead of by guessing. I never assume failure and re-charge with a fresh key, and I never assume success and ship. If retries keep failing, the saga parks the order in an explicit `PAYMENT_UNKNOWN` state that a reconciliation job resolves by comparing against the provider's records — which is why reconciliation is mandatory for money flows rather than optional. The customer-facing state stays honestly "processing" throughout.

**Q9 (senior). What if a compensation fails?**
Then I'm in the genuinely hard case, and the answer is a chain, not a guarantee. Compensations are themselves steps: idempotent, retried with exponential backoff, and if they exhaust retries they land in a dead-letter queue with an alert and a documented runbook, because a failed refund is a customer's money in limbo and must reach a human with an SLA. Two design moves reduce how often this happens: prefer semantic compensations that are ordinary forward operations the downstream system already supports well — a refund rather than an un-charge — and order steps so anything irreversible is last, so most failures need no compensation at all. What I won't say is "compensation always succeeds", because for shipped packages and sent emails it definitionally can't.

**Q10 (senior). Sagas have no isolation. What breaks, and what do you do about it?**
Intermediate states are visible, so other actors can read and act on state that later gets compensated — a dirty read, like a fulfilment process seeing `CHARGED` on an order that's about to be cancelled — or concurrently modify a record mid-saga, so the compensation clobbers their update. The countermeasures I'd name: a semantic lock, meaning an explicit in-flight marker like `PENDING_APPROVAL` that other actors must respect, which is the cheapest and most common; commutative updates so ordering doesn't matter (`increment(-10)` rather than `set(90)`); a pessimistic view that reorders steps so risky state is exposed as late as possible; and re-reading and re-verifying immediately before writing. There's also a product consequence: since intermediate state is visible, the UI should model it honestly — "payment processing" — rather than showing a spinner that implies atomicity.

**Q11 (staff). You deploy a new version of a workflow while thousands are in flight. What happens?**
With a replay-based engine, potentially a mass non-determinism failure: an in-flight execution's recorded history says step 3 was `reserve_stock`, the new code asks for `check_fraud`, replay diverges, and the workflow wedges. So workflow code has to be treated as a schema, and changing it as a migration. Options: version gates that branch on a marker so old executions replay the old path — safe, but accumulates branches you must prune; running versioned worker pools side by side and routing executions by version until the old ones drain; draining and cutting over, which only works for short workflows; or keeping the workflow skeleton stable and pushing volatile logic into activities, which aren't replay-constrained. This is also a fair argument for the hand-rolled state machine in some shops: a `state` column is a much easier migration than a replay history.

**Q12 (staff). How do you make a multi-step process observable enough to run at 3am?**
Four things. A correlation ID minted at the entry point and propagated through every service, queue message, and external call, so one identifier reconstructs the whole flow — that's distributed tracing, and without context propagation through the *queues* you get a broken trace exactly where it matters. An append-only transition log per instance, which gives support a timeline and me a debugging record. Metrics on the *shape* of the workflow, not just errors: instances per state, age of the oldest instance in each non-terminal state, and compensation rate — because the alert I actually want is "orders stuck in CHARGING older than 15 minutes is rising", which catches silent stalls that error-rate alerts miss entirely. And reconciliation as a scheduled job comparing my state against external systems of record, with a queue for the discrepancies. The failure mode I'm designing against is the one where the happy path works, the error rate is zero, and orders quietly stop moving.

**Q13 (staff). When would you *not* use Temporal or Step Functions?**
When the process is short, owned by one service, and has one external call — a three-step flow with a state column, a retry worker, and a sweeper is less machinery, easier to migrate, and doesn't add a cluster and a new failure domain to operate. I'd also avoid it where the "workflow" is really a high-throughput stream, since per-execution history and replay cost is meaningful and a partitioned log with an ordered consumer fits better. And I'd hesitate if the team has no operational appetite for either running a cluster or accepting the vendor coupling, since a durable execution engine is now on the critical path of every order. The trigger to adopt one is when I notice we've hand-rolled the same driver-plus-sweeper for the fourth time, or when workflows start spanning days with human approvals and complex timeout policies — that's where the framework earns its cost.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **The core problem** | No transaction spans services; process state in a stack frame; a timeout is not a "no" |
| **Rung 0** | If all steps hit one DB, use one transaction. Say this before escalating |
| **Pivot transaction** | The step past which you can't abort. Before it: compensatable. After it: retry-forward |
| **2PC** | Real atomicity, but coordinator failure blocks with locks held, availability multiplies down, and Stripe has no `PREPARE` |
| **Saga** | Local transactions + compensating actions, compensated in reverse order |
| **Choreography** | Services react to events. Loose coupling; flow exists nowhere; hard to debug |
| **Orchestration** | A coordinator owns the state machine. Visible and debuggable; a component to own |
| **The real answer** | Orchestrate the core path, choreograph the periphery |
| **Persisted state machine** | State column + retry driver + **sweeper**. The workhorse; ~200 lines |
| **Commit before side effect** | Write `CHARGING`, commit, *then* call. Recovery then knows the truth is "maybe" |
| **The forgotten component** | The **sweeper** for stuck non-terminal states. Interviewers look for it |
| **Durable execution** | Activity results appended to a history; crash → replay history to rebuild state → continue live |
| **Determinism rule** | No `now()`, `random()`, or I/O in workflow code — all side effects go in activities |
| **Durable execution ≠ no idempotency** | Activities are still at-least-once |
| **Dual write** | `db.commit()` then `bus.publish()` — crash between = lost event, forever |
| **Outbox** | Business row + outbox row in one transaction; a relay publishes and marks sent |
| **CDC** | Relay by tailing the replication log (Debezium) instead of polling the outbox |
| **Inbox** | Consumer-side dedupe: record processed message IDs in the business transaction |
| **Exactly-once delivery** | Doesn't exist. At-least-once + idempotent handling = exactly-once **effect** |
| **Idempotency key** | Client-generated, per business operation, stable across retries. **Store the response**, not a flag |
| **Naturally idempotent** | Absolute set (`status = SHIPPED`), `ON CONFLICT DO NOTHING`. *Not* `balance = balance - 10` |
| **Ambiguous timeout** | Retry with the same key; never assume failure. Reconcile if unresolved |
| **Compensation ≠ rollback** | The state was visible and may have been acted on; the compensation can itself fail |
| **Compensation failure path** | Retry → DLQ → alert → human runbook. Never "it won't fail" |
| **Sagas have no I** | No isolation — intermediate state is publicly visible |
| **Semantic lock** | Explicit in-flight marker others must respect. Cheapest isolation countermeasure |
| **Commutative updates** | `increment(-10)` not `set(90)` — order stops mattering |
| **Durable timer** | Persisted `wake_at` + scheduler, never `sleep()`. Every wait state needs a timeout edge |
| **Webhook reality** | At-least-once, out of order, sometimes *before* your own write lands. Idempotent + correlation ID |
| **Reconciliation** | Scheduled comparison against the external system of record. Mandatory for money |
| **Workflow versioning** | In-flight replay breaks when code changes → version gates, pinned worker pools, or drain-and-cut-over |
| **Workflow code is a schema** | Changing it is a migration |
| **Observability that matters** | Alert on *age of oldest instance per state*, not just error rate. Silent stalls beat loud errors |

---

## Related

- **Patterns:** [Dealing with Contention](./dealing-with-contention.md) (the hold that precedes the saga) · [Long-Running Tasks](./long-running-tasks.md) (single async step vs a multi-step flow) · [Real-Time Updates](./realtime-updates.md) (telling the user where their order is) · [ZooKeeper](./zookeeper.md) (coordinating the coordinator)
- **Fundamentals:** [write-ahead-log](../fundamentals/write-ahead-log.md) (durability, the same idea one layer down) · [quorum](../fundamentals/quorum.md) · [cap-theorem](../fundamentals/cap-theorem.md) · [pacelc-theorem](../fundamentals/pacelc-theorem.md)
- **Topics:** [`distributed-transactions`](../interviews/distributed-transactions/README.md) · [`payment-system`](../interviews/payment-system/README.md) · [`e-commerce`](../interviews/e-commerce/README.md) · [`food-delivery`](../interviews/food-delivery/README.md) · [`ride-sharing`](../interviews/ride-sharing/README.md) · [`message-queues`](../interviews/message-queues/README.md)
