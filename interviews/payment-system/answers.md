# Answers: Payment System (Stripe / PayPal / Google Pay)

> Keyed to [questions.md](./questions.md). Read the question first, then compare.
> Every answer has a code block or comparison table, and ends with a **Key takeaway** you can say under pressure.
> This topic **owns** money-correctness depth; neighbours link in rather than duplicate: [distributed-transactions](../distributed-transactions/) (saga/2PC mechanics), [message-queues](../message-queues/) (outbox, at-least-once, DLQ), [e-commerce](../e-commerce/) (checkout leg), [seat-reservation](../seat-reservation/) (payment step in a booking saga), [api-design](../api-design/) (idempotency as an API contract), [observability](../observability/), [sharding-replication](../sharding-replication/), [storage-engines](../storage-engines/).
>
> **Accuracy note:** scale figures are order-of-magnitude planning numbers to verify. Provider behaviors (Stripe/Adyen/PayPal) are described generically — **verify against current provider docs**, never quote internal architectures as fact. Compliance/regulatory content is directional and marked **verify**; it is **not legal or accounting advice**. Double-entry bookkeeping itself is standard accounting practice and safe to assert.

---

## Level 1 — Fundamentals & Requirements

### A1. Why money is harder than CRUD

| Property of money | What it forces on the design | The bug you get without it |
|---|---|---|
| **Conserved** — it moves between accounts, it is never created or destroyed | A balanced, double-entry record where every movement sums to zero | Money silently appears/vanishes and nobody can prove it |
| **Effectively irreversible** — undoing is a *new* compensating movement, not an undo | Append-only history; refunds/reversals are new entries | You "fix" a bug with `UPDATE`/`DELETE` and destroy the audit trail |
| **Audited by outsiders** — regulators, auditors, and the customer's bank all check your work | Every cent traceable to an immutable entry with provenance | You cannot answer "why is this balance 4,312?" six months later |
| **Externally owned** — the authoritative outcome lives at a third party | Defensive boundary + reconciliation, an explicit unknown state | You treat a timeout as an answer and double-charge or ship free goods |

A CRUD service's worst failure is a stale read. A payment system's worst failure is a *wrong number that looks right* — silent, discovered weeks later by an auditor or an angry customer.

**Key takeaway:** Money is conserved, effectively irreversible, externally audited, and authoritatively owned by a third party — which is why a payment system needs a balanced append-only ledger and continuous reconciliation, not a `balances` row you update.

---

### A2. The two halves

| | **Inside your boundary** | **Outside your boundary** |
|---|---|---|
| Control | Total — your DB, your transactions | None — a third party you call |
| Consistency | **Strong** (one txn: idempotency + ledger) | **Eventual**, and only *probably* knowable |
| Failure model | Crash/rollback — clean, atomic | Timeout, duplicate, out-of-order, silent success |
| Design posture | Be maximally **strict** | Be maximally **defensive** |
| Truth mechanism | Invariants (debits == credits) | **Reconciliation** against settlement files |

```text
INSIDE   idempotency key (UNIQUE, in-txn) · explicit state machine · double-entry ledger
BOUNDARY never trust a timeout · verify + dedupe webhooks · retry with the SAME key
OUTSIDE  PSP → acquirer → network → issuer  (they move the money; you record it)
BRIDGE   reconciliation: your ledger ↔ PSP settlement ↔ bank statement
```

**Key takeaway:** Be exact inside your boundary, defensive at it, and continuously reconciled across it — the two halves have opposite failure models, so a single consistency strategy cannot serve both.

---

### A3. Actors and who actually moves the money

```text
Cardholder ──pays──▶ Merchant (uses your platform)
                         │
                    YOUR PLATFORM  ← orchestrates + RECORDS; does not move money
                         │ API call (token + idempotency key)
                    PSP / Gateway  ← abstracts the mess, holds the card vault
                         │
                     Acquirer (merchant's bank / acquiring processor)
                         │
                   Card Network (Visa/Mastercard rails)
                         │
                      Issuer (cardholder's bank)  ← DECIDES and MOVES the money
```

| Actor | Job |
|---|---|
| **Issuer** | The cardholder's bank. Approves/declines and is where the money actually leaves. |
| **Card network** | The rails + rules between issuer and acquirer. |
| **Acquirer** | The merchant side's bank/processor; receives funds, produces settlement. |
| **PSP / Gateway** | Your integration point: tokenization, routing, retries, webhooks, reporting. |
| **Your platform** | **Orchestrates** the attempt and **records** the truth. Decides *intent*, records *outcome*, reconciles, and pays out. |

Your real job is **bookkeeping and orchestration**, not funds transfer. Saying this out loud early signals you understand the domain rather than treating the PSP as a black box that "does payments."

**Key takeaway:** The issuer and the networks move the money; your platform's actual job is to orchestrate the attempt and keep the authoritative, auditable record of what happened — which is why the ledger, not the PSP call, is the heart of the design.

---

### A4. Requirements

```text
Functional
  - Charge a customer (authorize, then capture); void an uncaptured auth
  - Refund fully or partially, multiple times, bounded by what was captured
  - Record every movement in an auditable ledger; expose balances (pending vs available)
  - Ingest provider webhooks; reconcile daily against settlement files
  - Pay out to merchants/sellers; handle disputes/chargebacks
  - Support multiple providers, multiple currencies, stored payment methods

Non-functional (the hard guarantees)
  - NO DOUBLE-CHARGE: any retry of the same attempt moves money at most once
  - NO MONEY CREATED OR DESTROYED: every txn's debits == credits, always
  - FULL AUDITABILITY: every cent traceable to an immutable entry with provenance
  - NO LOST ACKNOWLEDGED PAYMENT: if we told the customer "paid", it is durable
  - EVENTUAL AGREEMENT with the provider's settled truth (reconciliation converges)
  - EXPLICIT UNKNOWNS: an indeterminate outcome is a first-class state, not a guess

Scale (order-of-magnitude — verify)
  - ~10M payments/day ≈ 115/s avg, ~1K/s peak
  - Ledger writes = several entries per payment (charge, fee, payable, FX) → a MULTIPLE of that
  - Ledger is append-only and never deleted → grows forever; partition/archive, don't purge
  - Authorization budget ~1–3s end-to-end, incl. a sync risk check (~tens–low-hundreds of ms)
```

**Key takeaway:** The non-functional list *is* the design — no double-charge, nothing created or destroyed, everything auditable, and unknowns made explicit — and every later decision defends one of those five.

---

### A5. Back-of-the-envelope — what actually constrains you

```text
Payments:      10M/day ÷ 86,400 ≈ 115/s avg;  peak ~1K/s
Ledger writes: ~4–8 entries per payment (debit+credit pairs for charge, fee, payable, FX)
               → ~500–900/s avg, ~4–8K/s peak
Storage:       ~10M payments/day × ~6 entries × ~200 bytes ≈ ~12 GB/day of ledger
               → ~4–5 TB/year, APPEND-ONLY, retained for years (audit) → partition by time
Reads:         balance/status reads dominate but are cacheable/materializable
```

**~1K payments/s is not a throughput problem** — a single well-indexed SQL primary handles that comfortably. The real constraint is **correctness**: exactly-once under retries, invariants that hold under concurrency, and agreement with an external system you don't control. This inverts the usual instinct: you are not optimizing QPS, you are buying certainty. Storage growth is the second-order concern (append-only, forever), and it's a partitioning problem, not a scaling wall.

**Key takeaway:** At ~1K payments/s throughput is the *easy* part — the binding constraint is correctness and external agreement, so spend your design budget on idempotency, invariants, and reconciliation rather than on scaling writes.

---

### A6. Core entities and minimal API

```text
Entities
  PaymentIntent { id, account_id, amount_minor, currency, state, idem_key, psp_ref, created_at }
  Charge        { id, intent_id, authorized_minor, captured_minor, psp_charge_id, state }
  LedgerTxn     { id, occurred_at, reason, source_ref }        // groups entries
  LedgerEntry   { id, txn_id, account, direction(DR|CR), amount_minor, currency }  // IMMUTABLE
  Account       { id, type(asset|liability|revenue|...), owner, currency }
  Refund        { id, charge_id, amount_minor, idem_key, state }
  Payout        { id, account_id, amount_minor, state, scheduled_for }
  Dispute       { id, charge_id, state, deadline_at, evidence_ref }
  WebhookEvent  { provider_event_id UNIQUE, type, payload, processed_at }

APIs
  POST /payment_intents            (Idempotency-Key)  → create intent (BEFORE any PSP call)
  POST /payment_intents/{id}/confirm                  → authorize (may need 3-DS)
  POST /payment_intents/{id}/capture                  → capture funds
  POST /payment_intents/{id}/cancel                   → void an uncaptured auth
  POST /refunds                    (Idempotency-Key)  → full/partial refund
  GET  /payments/{id}                                 → state incl. PROCESSING/INDETERMINATE
  GET  /accounts/{id}/balance                         → pending vs available
  POST /webhooks/psp                                  → signed, deduped provider callbacks
```

Note `LedgerEntry` has no `updated_at` and no update path by design — that absence *is* the audit guarantee.

**Key takeaway:** Model an intent created *before* the provider call, a charge that tracks authorized-vs-captured separately, and immutable ledger entries grouped into balanced transactions — and give both the charge and the refund endpoints idempotency keys.

---

## Level 2 — Core Payment Flow & PSP Integration

### A7. End-to-end flow of a successful card payment

```text
SYNCHRONOUS (customer is waiting):
  1. Client collects card in a PSP-owned iframe → PSP returns a TOKEN
     (card never touches your JS or your servers)
  2. POST /payment_intents with Idempotency-Key  → you write an intent row (state=CREATED)
                                                    ← DURABLE LOCAL RECORD EXISTS NOW
  3. Risk/fraud check (tight latency budget)
  4. You call PSP: authorize(token, amount, idem_key)   ← the boundary; may time out
  5. PSP → acquirer → network → issuer approves (funds HELD, not moved)
  6. You persist state=AUTHORIZED + ledger entries; return success to the customer

ASYNCHRONOUS (customer is gone):
  7. Capture (now, or later on ship — see A8) → state=CAPTURED, ledger entries
  8. PSP webhook confirms outcomes (verified, deduped) → may arrive before/after/never
  9. SETTLEMENT: funds actually transfer in a batch, T+1..T+3 (illustrative — verify)
 10. Daily settlement file → RECONCILIATION vs your ledger → adjusting entries if needed
 11. Payout to the merchant from *available* (not pending) balance
```

**Your responsibility begins** at step 2 (the durable intent) and **never ends** — steps 8–11 mean a payment is not "done" when the customer sees success; it is done when it is *settled and reconciled*.

**Key takeaway:** The customer-visible path ends at authorization, but the system's responsibility runs through capture, webhook confirmation, settlement, and reconciliation — treating "returned 200 to the customer" as completion is the classic beginner framing.

---

### A8. Authorize vs capture vs settle vs void vs refund

| Operation | When | What happens to the money | Reversal path |
|---|---|---|---|
| **Authorize** | At checkout | Funds are **held** on the card; nothing transfers. Holds expire (~7 days, varies — verify) | **Void** |
| **Capture** | At fulfillment (or immediately) | Commits the sale; money is now owed to you | **Refund** |
| **Settle** | Batch, T+1..T+3 | Funds **actually transfer** acquirer↔issuer; fees deducted | — (accounting fact) |
| **Void** | **Before** capture | Releases the hold; **no money ever moved**, usually no fee | n/a |
| **Refund** | **After** capture | A **new, opposite money movement** back to the customer | — (append another entry) |

```text
The distinction that matters:
  VOID   = "cancel the promise"        → pre-capture,  no money moved,  cheap, invisible on statement
  REFUND = "make an opposite payment"  → post-capture, money moved TWICE (out then back), costs fees,
                                          visible to the customer, and is NOT an undo
```

Authorize-then-capture exists so you never hold money for goods you haven't delivered — [e-commerce](../e-commerce/) captures on ship, and a pre-ship cancel is a **void**, not a refund.

**Key takeaway:** Void cancels an uncaptured hold so no money ever moved; a refund is a brand-new opposite movement after capture — conflating them means you either refund when you should void (paying fees, confusing the customer) or try to void a captured charge and fail.

---

### A9. The PSP abstraction layer

```text
Your domain owns the CONCEPTS; adapters own the PROVIDER DIALECT.

  ┌────────────── your domain (provider-agnostic) ──────────────┐
  │ PaymentIntent · Charge · Refund · Dispute · LedgerEntry      │
  │ authorize() capture() void() refund() — YOUR vocabulary      │
  └──────────────────────────┬───────────────────────────────────┘
                             │ PaymentProvider interface
              ┌──────────────┼──────────────┐
        StripeAdapter   AdyenAdapter   LocalAcquirerAdapter
              │              │              │
      maps provider status/error codes → YOUR canonical state + error taxonomy
      normalizes idempotency, webhook signature scheme, settlement file format
```

| Why more than one provider | Why it's harder than it looks |
|---|---|
| **Outage survival** — a PSP outage is a total revenue stop | **Tokens are usually NOT portable** between providers (each vaults its own) — verify |
| **Commercial leverage** on fees | Two providers = two sources of truth to reconcile separately |
| **Geographic coverage** / local methods | Failover must not double-charge (A30) |
| **Higher auth rates** via routing/retry | Feature and status-code semantics differ subtly |

The leak to avoid: letting a provider's status string (`"requires_source_action"`) become your state. Map to *your* canonical state machine (A11) at the adapter boundary, or the provider's model becomes your model forever.

**Key takeaway:** Keep provider vocabulary behind an adapter and let your own canonical state machine and error taxonomy be the domain — and run a second provider for outage survival while knowing the real cost is non-portable tokens and a second reconciliation stream.

---

### A10. Never touching a card number — tokenization and PCI scope

```text
The card must go from the CUSTOMER'S BROWSER straight to the PSP, bypassing you entirely:

  Browser ──card PAN──▶ PSP-hosted iframe / hosted field  ──▶ PSP vault
                                    │
                                    ▼ returns a TOKEN
  Your JS  ◀── token only ──────────┘
  Your API ◀── token only ── (you never see, log, or store a PAN)
```

| Token type | Lifetime | Use |
|---|---|---|
| **Single-use token** | One transaction, short TTL | A one-off checkout; useless if leaked afterwards |
| **Reusable / vaulted payment-method token** | Long-lived, stored | Saved cards, subscriptions, off-session charges (see QB1) |
| **Network token** | Provider/network-managed | Survives card reissue; improves auth rates (— verify current support) |

Because the PAN never enters your systems, most of your infrastructure falls **out of the cardholder-data environment**, which is what reduces PCI DSS scope (typically toward a self-assessment rather than full audit of your whole stack — **verify against current PCI DSS requirements; not legal advice**).

The commonly-missed leak: **analytics, session-replay, and error-reporting tools**. A session-replay script or an exception payload can capture a card field even though your own code never reads it — you must explicitly mask/exclude payment fields and audit third-party scripts on the checkout page (A46).

**Key takeaway:** Card data goes browser→PSP directly via hosted fields and you only ever hold a token, which is what shrinks PCI scope — and the leak that actually bites teams is a session-replay or error-reporting script silently capturing the field your own code never touched.

---

### A11. The payment state machine

```text
                    ┌───────────────────────────────────────────┐
   CREATED ─────────┤ (intent written BEFORE any PSP call)      │
      │             └───────────────────────────────────────────┘
      │ confirm
      ▼
 REQUIRES_ACTION ──(3-DS challenge)──▶ back to confirm
      │
      ├─ approved ──▶ AUTHORIZED ──capture──▶ CAPTURED ──settle──▶ SETTLED
      │                   │                      │                    │
      │                   │ cancel               │ refund             │ dispute
      │                   ▼                      ▼                    ▼
      │                VOIDED           REFUNDED / PARTIALLY_REFUNDED  DISPUTED
      │                                                                 │
      ├─ declined ──▶ FAILED (terminal)                        WON / LOST(charged back)
      │
      └─ timeout / unknown ──▶ ⚠ INDETERMINATE  ──resolved by──▶ AUTHORIZED | FAILED
                               (a FIRST-CLASS state, not an error)
```

| Why explicit, not implicit in code | Consequence of implicit |
|---|---|
| Every state is **queryable and auditable** | "What state is this payment in?" becomes "read the code and guess" |
| Illegal transitions are **rejected**, not accidentally possible | You capture a voided auth, or refund something never captured |
| An **INDETERMINATE** state can exist at all | Ambiguity gets forced into "failed" or "succeeded" — the double-charge bug |
| Recovery jobs can **query by state** | You cannot find the stuck payments to fix them |

**Key takeaway:** Make the state machine explicit and persisted — including a first-class `INDETERMINATE` state — because ambiguity that has nowhere to live gets silently coerced into "succeeded" or "failed", and that coercion is exactly how money goes wrong.

---

### A12. Why PaymentIntent beats fire-and-forget "charge this card"

| | Fire-and-forget `charge(card, amount)` | **PaymentIntent created first** |
|---|---|---|
| Local record if you crash mid-call | **None** — money may move with zero trace on your side | Intent row exists → orphan is detectable |
| Idempotency anchor | Nothing durable to attach the key to | The intent *is* the anchor |
| Multi-step flows (3-DS, async methods) | Doesn't fit — needs a resumable object | Natural: `REQUIRES_ACTION` → resume |
| Where the outcome lands | Nowhere — you must infer from a response | Attach outcome to a known row |
| Retry semantics | Ambiguous | Retry against the same intent + key |

```text
The decisive property:
  intent row committed  →  THEN call the PSP
  ⇒ every possible crash point leaves a local record you can reconcile against.

Without it, "crash after PSP charged, before we persisted" (A18) is UNRECOVERABLE by design —
you have money movement with no local reference to match it to.
```

**Key takeaway:** Creating the intent *before* touching the provider guarantees that every crash point still leaves a durable local record to reconcile against — it's what turns "money moved and we have no idea" into a detectable orphan, and it doubles as the idempotency anchor and the resume point for 3-DS.

---

## Level 3 — Idempotency & Exactly-Once Money Movement

### A13. The idempotency mechanism, end to end

```sql
-- The key is enforced by a UNIQUE CONSTRAINT, written IN THE SAME TRANSACTION
-- as the work it guards. Not a cache. Not check-then-insert.

CREATE TABLE idempotency_records (
  idem_key        text PRIMARY KEY,          -- client-supplied, per attempt
  account_id      text NOT NULL,
  endpoint        text NOT NULL,             -- scope: same key on /refunds ≠ /payment_intents
  request_hash    text NOT NULL,             -- fingerprint of the request body (A15)
  state           text NOT NULL,             -- IN_FLIGHT | COMPLETED
  response_code   int,                       -- stored so a replay returns the SAME result
  response_body   jsonb,
  payment_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

```text
Flow:
  1. BEGIN
  2. INSERT idempotency_records (key, request_hash, state=IN_FLIGHT) ...
       ON CONFLICT (idem_key) DO NOTHING
  3. If 0 rows inserted → a record already exists → NOT the first caller → go to A14
  4. Insert the PaymentIntent row (state=CREATED), linked to the key
  5. COMMIT                                   ← durable local record + key reserved together
  6. Call the PSP with the SAME idem_key       ← outside the txn (never hold a txn open on a network call)
  7. BEGIN; persist outcome + ledger entries; set state=COMPLETED, store response; COMMIT
```

Two details that carry the whole guarantee: the key is reserved **atomically with** the local record (so a duplicate can never slip between a check and an insert), and the **response is stored** so a replay returns a byte-identical result rather than re-doing work.

**Key takeaway:** Enforce the idempotency key with a `UNIQUE` constraint committed in the same transaction as the payment record, store the response for replay, and never hold that transaction open across the provider call.

---

### A14. Two concurrent requests, same key — the exact race

```text
T1 and T2 arrive in the same millisecond with idem_key = K.

T1: BEGIN
    INSERT (K, IN_FLIGHT) ON CONFLICT DO NOTHING   → 1 row  ← WINNER
    INSERT intent, link to K
    COMMIT
    → calls PSP once, then sets K.state=COMPLETED + stores response

T2: BEGIN
    INSERT (K, IN_FLIGHT) ON CONFLICT DO NOTHING   → 0 rows ← LOSER
    COMMIT (or rollback — it did nothing)
    SELECT * FROM idempotency_records WHERE idem_key = K
      ├─ state = COMPLETED → return the STORED response verbatim.       DONE.
      └─ state = IN_FLIGHT → the winner is mid-PSP-call. DO NOT call the PSP.
                             → return 409 "in progress, retry shortly"
                                (or bounded-wait/poll, then return the stored response)
```

| Detail | Why it matters |
|---|---|
| `ON CONFLICT DO NOTHING` (or catching the unique violation) | The DB, not application logic, arbitrates the race |
| The **IN_FLIGHT** state exists | The loser knows a PSP call is *already happening* and must not make a second one |
| Loser **never** calls the PSP | This is the actual double-charge prevention |
| Response is stored, not recomputed | The replay is identical, not merely "also successful" |

Returning `409` while `IN_FLIGHT` is the honest answer: you cannot yet know the outcome, and inventing one is exactly the failure mode this whole level exists to prevent.

**Key takeaway:** Let the `UNIQUE` constraint pick the winner, give the record an explicit `IN_FLIGHT` state so the loser knows a provider call is already in progress and refuses to make a second one, and have the loser replay the winner's *stored* response rather than recomputing anything.

---

### A15. Same key, different request body

```text
On a conflict, compare fingerprints BEFORE returning anything:

  incoming_hash = sha256(canonical_json(request_body))     // canonicalized: sorted keys, normalized numbers
  stored_hash   = record.request_hash

  if incoming_hash == stored_hash:
      → legitimate retry  → replay stored response (A14)
  else:
      → 422 Unprocessable Entity
        "This Idempotency-Key was already used with a different request."
      → DO NOT charge. DO NOT return the stored response.
```

| Behavior on mismatch | Outcome |
|---|---|
| **Reject with 422** ✅ | Client learns it has a key-reuse bug; no money moves |
| Silently return the stored response ❌ | Caller asked to charge **$500**, gets back a success for **$50** and believes $500 was charged — a silent, invisible correctness failure |
| Create a second charge ❌ | Defeats the entire purpose of the key |

Silently succeeding is the genuinely dangerous option because *nothing looks wrong*: the caller gets `200`, ships the goods, and the discrepancy only surfaces at reconciliation or in a customer complaint.

**Key takeaway:** Store a hash of the request body alongside the key and reject a mismatch with a client error — returning the stored response for a *different* request hands the caller a success for an amount they didn't ask for, which is worse than either charging twice or failing loudly.

---

### A16. Key retention and scope

| Retention | Consequence |
|---|---|
| **Too short** (e.g. hours) | A legitimate late retry — a client resuming after an outage, or a mobile app back online — creates a **second charge** |
| **Practical: ~24h–30 days** (verify against your client retry windows and provider's own key retention) | Covers realistic retry horizons at bounded storage cost |
| **Forever** | Unbounded growth on a hot-path table; the index degrades and you're storing response bodies indefinitely |

```text
SCOPE the key so collisions are impossible but retries still match:
  (account_id, endpoint, idem_key)
   │           │          └─ client-generated, unique per ATTEMPT (not per click)
   │           └─ a key used on /refunds must not match one on /payment_intents
   └─ tenant isolation: merchant A's key can never collide with merchant B's

After expiry: DELETE the idempotency record, never the payment or ledger entries.
  → the money history is permanent; only the dedupe window is bounded.
```

Pair the retention window with a client contract: the client must reuse the key for retries of *the same* attempt and mint a new one for a genuinely new attempt ([api-design](../api-design/)).

**Key takeaway:** Scope keys by `(account, endpoint, key)` and retain them for a window that comfortably exceeds your clients' retry horizon (~days, not hours) — expiring the *dedupe record* is fine, but the payment and ledger history it guarded is permanent.

---

### A17. The PSP call times out — the single most important answer

```text
A timeout is NOT an outcome. It is an UNKNOWN. Three possibilities, all live:
   (a) the request never arrived            → no charge
   (b) it arrived and succeeded             → CHARGED, response lost
   (c) it arrived and failed                → not charged
You cannot distinguish these locally. Ever.
```

| Naive handling | What breaks |
|---|---|
| **Retry blindly (new key)** | Case (b) → customer charged **twice** → dispute, refund, trust damage |
| **Mark FAILED** | Case (b) → customer charged, you ship nothing / cancel their order → "you took my money" |
| **Hang the request** | Customer waits, then retries themselves — now you have an uncontrolled duplicate |

```text
CORRECT procedure:
  1. Retry the SAME provider request with the SAME idempotency key.
     Providers honor idempotency keys, so a retry is SAFE: if (b) happened, the provider
     returns the ORIGINAL result rather than charging again. (Verify per provider.)
     → bounded retries with backoff + jitter.
  2. Still unknown? QUERY the provider by your idempotency key / your reference
     ("did you ever process this?") rather than issuing a new charge.
  3. Still unknown? Set state = INDETERMINATE (A11) and STOP guessing.
     - Tell the customer honestly: "we're confirming your payment" (A49) — never
       "it failed" and never "it succeeded".
     - Let the WEBHOOK (A25) or the daily RECONCILIATION (A27) resolve it.
  4. Alert if a payment sits INDETERMINATE beyond an SLA — it needs human eyes.
```

The rule to say out loud: **never trust a timeout.** It's the corollary of the central split — the authoritative answer lives outside your boundary, so an unknown must be *represented*, not resolved by assumption.

**Key takeaway:** A timeout is an unknown, not a failure — retry with the *same* idempotency key (which providers honor, so it cannot double-charge), then query by that key, and if still unresolved park the payment in an explicit `INDETERMINATE` state for webhooks and reconciliation to settle, because guessing either way loses money or trust.

---

### A18. (Failure mode) Crash after the PSP charged, before you persisted

```text
Timeline of the disaster:
  t0  intent row committed (state=CREATED)          ← A12: THIS is what saves you
  t1  PSP called, card CHARGED successfully
  t2  ☠ your process dies before persisting the outcome
      → customer's money is gone; you have an intent in CREATED and no outcome
```

| Detection layer | How it catches this |
|---|---|
| **Stale-state sweeper** | Query intents in `CREATED`/`IN_FLIGHT` older than N minutes → for each, **query the provider by idempotency key** → discover the charge → persist outcome + ledger entries idempotently |
| **Provider webhook** | A `charge.succeeded` webhook arrives referencing your intent → you have a local row to attach it to → resolve (A25) |
| **Daily reconciliation** | Settlement file contains a charge your ledger lacks → flagged as *present-at-PSP-missing-locally* (A27/A28) |
| **Alerting** | Any intent stuck in a non-terminal state beyond SLA pages a human |

```text
Why recovery is possible AT ALL:
  because the intent row was committed BEFORE the PSP call (A12), the orphaned charge
  has a local anchor to be matched against. Without it, you'd have money movement with
  no reference and only a manual, amount-and-timestamp forensic match to fall back on.

The repair is idempotent: persisting the discovered outcome is keyed by intent/charge id,
so the sweeper, the webhook, and reconciliation can all "fix" it and only one takes effect.
```

**Key takeaway:** This failure is survivable only because the intent was committed before the provider call — three independent layers (a stale-state sweeper querying the provider by key, the webhook, and daily reconciliation) then converge on the orphan, and because the repair is idempotent it doesn't matter which one finds it first.

---

## Level 4 — The Ledger (Double-Entry Bookkeeping)

> **Accounting convention used throughout this level** (stated so every example is checkable): **assets increase with a debit (DR)**; **liabilities, equity, and revenue increase with a credit (CR)**. Every transaction must satisfy `Σ debits = Σ credits`. This is standard double-entry practice; validate any real-world chart of accounts with an accountant.

### A19. Why double-entry, not `UPDATE balance = balance + x`

| | Mutable `balances` table | **Double-entry ledger** |
|---|---|---|
| History | **Destroyed** on every write | Preserved — every movement is a row, forever |
| A lost or duplicated write | Balance is silently wrong, **undetectable** | Breaks `Σ DR = Σ CR` → **detectable invariant violation** |
| "Why is this balance 4,312?" | Unanswerable | Replay the entries |
| Concurrency | Hot-row contention; lost updates | Append-only; no contention on a shared row |
| Repair | Guess a corrective `UPDATE`, destroying evidence | Append a reversing entry, evidence intact |

```text
The specific class of bug double-entry makes IMPOSSIBLE TO HIDE:
  money created or destroyed out of nothing.

  balances table:   UPDATE ... balance + 100   (credit the merchant)
                    ☠ crash — the matching debit never happens
                    → $100 now exists that came from nowhere. Sums still "look fine".
                      Nothing in the schema can tell you this happened.

  double-entry:     both legs are in ONE transaction, and the invariant Σ DR = Σ CR
                    is continuously checked (A24)
                    → the same crash rolls back BOTH legs, and if a bug ever did
                      write one leg, the imbalance is DETECTED, not silent.
```

Note the precise claim: double-entry doesn't make bugs impossible — it makes this class of bug **detectable**, which is what turns a silent financial corruption into an alert.

**Key takeaway:** A mutable balance destroys history and makes a lost or duplicated write silently wrong, whereas double-entry forces every movement into a balanced pair so money appearing from nowhere violates a checkable invariant — it converts silent corruption into a detectable alarm.

---

### A20. The entries for a $100 payment with a $3 platform fee

Scenario: a customer pays **$100.00**; your platform keeps a **$3.00** fee and owes the merchant **$97.00**. Amounts in minor units (cents).

**Transaction 1 — capture the payment** (`reason: charge_captured`, `source_ref: charge_abc`)

| Account | Type | DR | CR |
|---|---|---:|---:|
| `psp_receivable` (money the PSP owes us) | Asset | **10000** | |
| `merchant_payable:m_42` (money we owe the merchant) | Liability | | **9700** |
| `platform_fee_revenue` | Revenue | | **300** |
| **Totals** | | **10000** | **10000** |

`Σ DR (10000) = Σ CR (10000)` → balances to zero. ✅

Reading it: our asset rises by the full $100 (we are owed it by the PSP); of that, $97 is a liability we owe the merchant and $3 is our revenue. The customer's own money movement lives on the issuer's books, not ours.

**Transaction 2 — settlement arrives, PSP deducts a $2.90 processing fee** (`reason: settlement`)

| Account | Type | DR | CR |
|---|---|---:|---:|
| `cash:bank_main` | Asset | **9710** | |
| `psp_processing_fee_expense` | Expense | **290** | |
| `psp_receivable` | Asset | | **10000** |
| **Totals** | | **10000** | **10000** |

Balances. ✅ The receivable is cleared, real cash arrives net of the provider's fee, and the fee is recognized as an expense rather than quietly shrinking the receivable.

```text
Why fees get their OWN accounts rather than being netted silently:
  - you can report "what did payment processing cost us this month?"
  - reconciliation can compare YOUR expected fee to the PSP's ACTUAL fee (A27:
    fee discrepancy is a real mismatch category)
  - a netted number is unauditable — the information is gone
```

**Key takeaway:** Model each movement as a balanced set of entries across named accounts — receivable in, merchant liability and platform revenue out, then settlement clearing the receivable into cash net of an explicit fee expense — and check `Σ DR = Σ CR` on every transaction as your proof of correctness.

---

### A21. Immutability — and how you then represent corrections

```sql
-- Enforce append-only at the database level, not by convention:
REVOKE UPDATE, DELETE ON ledger_entries FROM app_role;   -- app can only INSERT
-- plus (belt and braces) a trigger that raises on UPDATE/DELETE,
-- and no updated_at column exists at all (A6) — there is nothing to update.
```

| Situation | ❌ Never | ✅ Instead |
|---|---|---|
| Wrong amount posted | `UPDATE entry SET amount = ...` | Append a **reversing** txn (same accounts, opposite directions), then append the correct txn |
| Entry posted in error | `DELETE FROM ledger_entries ...` | Append a reversal referencing the original `txn_id` |
| Customer refund | Mutate the original charge entries | Append a **new** opposite-direction txn (A31) — a refund is a *new movement*, not an undo |
| Bug wrote duplicates | Delete the duplicates | Append reversals netting them out, referencing the incident (A39) |

```text
Reversal of Transaction 1 from A20 (a full $100 refund):

  merchant_payable:m_42     DR  9700     (liability decreases)
  platform_fee_revenue      DR   300     (revenue reversed — or credit a contra-revenue account)
  psp_receivable                 CR 10000 (asset decreases)
                            ─────────────
                            10000 = 10000  ✅

The original entries REMAIN. The net effect is zero. The history shows BOTH
what happened and that it was undone — which is exactly what an auditor needs.
```

The mental shift: the ledger is an **event log of money**, not a mutable record of current truth. Current truth is *derived* (A22).

**Key takeaway:** Enforce append-only in the database itself and express every correction, reversal, and refund as new opposite-direction entries referencing the original — the net effect is the same but the history survives, and preserving that history is the entire point of a ledger.

---

### A22. Computing balances at scale

| Approach | Cost | Correctness |
|---|---|---|
| **Fold all entries** (`SUM` over the account's history) | O(n) — unusable at billions of rows | Always exactly right (it *is* the definition) |
| **Materialized running balance** | O(1) read | Right only if every write updated it correctly — a bug or missed write drifts silently |
| **Snapshot + delta** (checkpoint balance at time T, fold only entries after T) | O(entries since last checkpoint) | Exact, and bounded — the pragmatic answer |

```text
Snapshot + delta (the same checkpoint idea as a WAL — see ../storage-engines/):

  balance(account, now) = snapshot(account, T)  +  fold(entries WHERE ts > T)

  - write a snapshot per account periodically (e.g. daily, or every N entries)
  - reads stay cheap because the delta window is bounded
  - the snapshot is DERIVED data — it can always be rebuilt from the entries,
    which are the only source of truth
```

```text
The drift checker (non-negotiable if you materialize anything):
  nightly, for each account:
      recomputed = fold(ALL entries)          -- the definitional answer
      if recomputed != materialized_balance:
          ALERT + quarantine the account      -- do NOT silently overwrite (A24)
  Also assert the global invariant: SUM(all DR) - SUM(all CR) == 0
```

Materializing without a checker is the worst of both worlds — you've reintroduced the silent-wrongness of a `balances` table while believing you have a ledger.

**Key takeaway:** Treat the entries as the only source of truth and balances as derived — use snapshot-plus-delta so reads are cheap and bounded, and always run a job that re-folds from scratch and alerts on any drift, because a materialized balance without a checker is just a `balances` table wearing a costume.

---

### A23. Representing money

```text
❌ float / double:  0.1 + 0.2 != 0.3   in IEEE-754 binary floating point.
                    Sum a million transactions and the error is REAL MONEY.
                    Never use float/double for money. Ever.

✅ INTEGER MINOR UNITS + explicit currency:
     { amount_minor: 10000, currency: "USD" }   → $100.00
     { amount_minor: 10000, currency: "JPY" }   → ¥10000   (JPY has 0 decimals!)

   - exact integer arithmetic, no representation error
   - the number of decimal places is a property of the CURRENCY, not a global constant
     (USD/EUR = 2, JPY = 0, some currencies = 3) — never hardcode 2
   - DECIMAL/NUMERIC is also acceptable (exact base-10); the sin is binary floating point
```

| Rule | Why |
|---|---|
| Currency travels **with** every amount | `100` is meaningless alone; a bare integer invites cross-currency arithmetic |
| **Never** add amounts of different currencies | It is a type error, and should be one in code |
| Rounding is an **explicit, recorded decision** | See below — it changes who gets a cent |

```text
Rounding as a CORRECTNESS issue — splitting $100.00 three ways:
   naive: round(10000/3) = 3333 each  → 3333*3 = 9999  → ☠ 1 cent VANISHED
   correct: allocate the remainder deterministically
            3334, 3333, 3333  → sums to EXACTLY 10000
   The allocation rule must be deterministic and documented (largest-remainder,
   first-party-absorbs, etc.) so the same split always produces the same answer.
```

That vanished cent is not cosmetic — it's an unbalanced ledger, an invariant violation, and (multiplied across millions of splits) a real reconciliation gap.

**Key takeaway:** Store integer minor units with an explicit currency and never binary floats, treat decimal places as a per-currency property rather than always two, and make rounding a deterministic recorded allocation so the parts always sum exactly to the whole.

---

### A24. Ledger invariants and the job that verifies them

```text
INVARIANTS that must hold at all times:

  I1  Per transaction:  Σ debits == Σ credits                    (nothing created/destroyed)
  I2  Globally:         Σ all debits − Σ all credits == 0
  I3  Append-only:      no UPDATE or DELETE ever occurred on ledger_entries
  I4  Per account:      materialized_balance == fold(entries)     (no drift — A22)
  I5  Sign constraints: accounts that must not go negative, don't
                        (e.g. a merchant's available balance, a customer wallet)
  I6  Currency purity:  every transaction's entries share a currency (or an explicit
                        FX transaction records both legs + the rate — A44)
  I7  Bounded reversal: Σ refunds(charge) <= captured(charge)      (A31)
```

```sql
-- I1, run continuously over recent transactions (and nightly over all):
SELECT txn_id,
       SUM(CASE WHEN direction='DR' THEN amount_minor ELSE -amount_minor END) AS imbalance
FROM ledger_entries
GROUP BY txn_id
HAVING SUM(CASE WHEN direction='DR' THEN amount_minor ELSE -amount_minor END) <> 0;
-- ANY row returned is a P0 incident.
```

| On violation | Action |
|---|---|
| **Alert immediately** (page, don't email) | An imbalance means money is wrong *right now* |
| **Quarantine** the affected account/flow; stop the offending write path | Prevent the bug from producing more bad entries |
| **Investigate + reconcile** against the provider to establish ground truth (A27) | The PSP is the external check on what really happened |
| **Append adjusting entries** referencing the incident | Fix forward; never rewrite history |
| ❌ **Never** auto-correct blindly | An automated "fix" that guesses wrong corrupts the ledger *and* erases the evidence of the original bug |

The last row is the one candidates miss: the instinct to self-heal is exactly wrong here. A wrong auto-correction is worse than a loud outage, because it launders the error into the permanent record.

**Key takeaway:** Continuously assert that every transaction balances, the global sum is zero, nothing was ever updated or deleted, and materialized balances match a fresh fold — and on violation alert, quarantine, and fix forward with adjusting entries rather than letting an automated correction guess and destroy the evidence.

---

## Level 5 — Async Reality: Webhooks, Retries & Reconciliation

### A25. Webhook ingestion

```text
Receive handler — do the MINIMUM, then get out:

  1. READ THE RAW BODY FIRST (bytes, not parsed JSON)
  2. VERIFY SIGNATURE: HMAC over (timestamp + raw body) with the shared secret,
     compared in CONSTANT TIME. Verify BEFORE parsing — never trust unverified input
     enough to deserialize it into your domain.
  3. CHECK TIMESTAMP FRESHNESS (e.g. within ~5 min) → rejects replay of a captured
     valid webhook. A signature alone does not stop replay.
  4. DEDUPE: INSERT provider_event_id INTO webhook_events ON CONFLICT DO NOTHING
       → 0 rows = already seen = return 200 and stop. (UNIQUE constraint, not a cache.)
  5. ENQUEUE for async processing.
  6. RETURN 200 IMMEDIATELY.   ← providers time out and retry aggressively;
                                  slow handlers cause duplicate deliveries
```

| Hazard | Handling |
|---|---|
| **Duplicates** | `UNIQUE(provider_event_id)` — the dedupe is transactional, not best-effort |
| **Out-of-order** (`captured` arrives before `authorized`) | Drive state from **the event's own state/version**, not arrival order; reject illegal transitions (A11) and re-query the provider if an event implies a state you haven't reached |
| **Unknown object** (webhook for something you have no record of) | **Never silently drop.** Persist it as unmatched + alert + let reconciliation match it — this is exactly the A18 orphan signature |
| **Slow processing** | Always async behind the 200; the handler is an ingest, not a workflow |
| **Poison event** | Retry with backoff, then DLQ + alert ([message-queues](../message-queues/)) |

**Key takeaway:** Verify the HMAC over the raw body before parsing, reject stale timestamps to stop replay, dedupe transactionally on the provider's event id, return `200` fast and process asynchronously — and treat a webhook for an unknown object as a signal to reconcile rather than something to drop.

---

### A26. Why webhooks can never be your only source of truth

| Failure mode | Consequence if webhooks are your only truth |
|---|---|
| **Lost** (your endpoint was down past the provider's retry budget) | Payment stuck forever in a non-terminal state; customer paid, nothing shipped |
| **Delayed** hours | Your state is wrong for hours; downstream decisions made on stale truth |
| **Out-of-order** | You apply a later state then an earlier one and corrupt the record |
| **Duplicated** | Double-applied balance change (unless deduped — A25/A38) |
| **Your bug** drops one | Silent, permanent divergence with no detection mechanism |

```text
Webhooks are a LATENCY OPTIMIZATION, not a source of truth.
They tell you sooner what you could always have discovered by asking.

So pair them with two independent, PULL-based mechanisms:
  1. ACTIVE POLLING / query-by-key — a sweeper reconciles non-terminal payments by
     ASKING the provider (also the A17/A18 recovery path)
  2. DAILY RECONCILIATION vs the settlement file — the authoritative batch truth (A27)

Design rule: the system must reach the correct state EVEN IF EVERY WEBHOOK IS LOST.
Webhooks make it fast; polling and reconciliation make it correct.
```

**Key takeaway:** Webhooks are a push-based latency optimization that can be lost, delayed, reordered, or duplicated — so the system must be able to reach the correct state with every webhook discarded, using provider polling plus daily settlement reconciliation as the mechanisms that actually guarantee correctness.

---

### A27. Reconciliation against the PSP

```text
Ideally THREE-WAY, because two sources can agree and both be wrong about cash:

   YOUR LEDGER   ←→   PSP SETTLEMENT FILE   ←→   BANK STATEMENT
   (what we think)     (what the provider says)   (what actually landed)

Daily process:
  1. Ingest the settlement file (SFTP/S3, CSV/JSON) into a staging table, immutably.
  2. Normalize: currency, minor units, the provider's txn id ↔ your reference.
  3. MATCH on (provider_charge_id) primarily; fall back to (amount, currency, date,
     last4/reference) for fuzzy candidates.
  4. Classify every unmatched or mismatched row (below).
  5. Auto-resolve only the mechanically safe classes; QUEUE THE REST FOR HUMAN REVIEW.
  6. Emit adjusting entries (never edits) for confirmed differences (A28).
  7. Report: total matched, total unmatched, ABSOLUTE VALUE of unreconciled money.
```

| Mismatch category | Meaning | Typical cause |
|---|---|---|
| **In PSP, not in ledger** | They charged; we have no record | The A18 crash; a lost webhook; an integration bug |
| **In ledger, not in PSP** | We recorded a charge they don't have | We recorded optimistically before confirmation; a failed charge marked succeeded |
| **Amount mismatch** | Same charge, different amount | Partial capture, currency conversion, a tip/adjustment applied later |
| **Fee discrepancy** | Their fee ≠ our expected fee | Pricing tier change, cross-border/interchange surcharge, our fee model is stale |
| **Currency / FX mismatch** | Settlement currency differs | FX applied at a different rate/time than we recorded (A44) |
| **Duplicate** | Same charge twice | Our retry logic double-charged (an idempotency failure — A13) |
| **Status mismatch** | We say captured, they say refunded/disputed | We missed a webhook, or a dispute landed |
| **Timing / cut-off** ⚠️ | Appears missing today, present tomorrow | A payment near the settlement cut-off falls in the *next* window — **the most common false positive**; always compare across an overlapping window before declaring a discrepancy |

That last row is the practical one: a reconciliation system that doesn't model cut-off windows will page you every night about payments that are perfectly fine.

**Key takeaway:** Reconcile three-way across your ledger, the provider's settlement file, and the bank statement, classify every difference into an explicit taxonomy, auto-resolve only the mechanically safe classes and queue the rest for humans — and handle settlement cut-off timing explicitly, because it's the biggest source of false alarms.

---

### A28. Remediating a reconciliation mismatch, both directions

| Direction | Meaning | Remediation |
|---|---|---|
| **PSP has it, we don't** | Real money moved; we're blind to it | 1. Query the provider for full detail. 2. Find our intent by idempotency key/reference (A12). 3. **Append** the missing ledger entries dated to the real event (with a `reconciliation` reason + file reference). 4. Resolve the customer-facing state — if we told them it failed but they were charged, **refund or fulfil**, then notify. 5. Root-cause the miss (crash? lost webhook? bug?). |
| **We have it, PSP doesn't** | We recorded money that never moved | 1. Confirm with the provider (it may be a cut-off timing artifact — recheck the next window **before** acting). 2. If genuinely never processed, **append a reversing transaction** for the entries we wrongly created. 3. Fix the code path that recorded success without confirmation — this is usually optimistic recording, the root bug. 4. If goods shipped, that's a business loss to book explicitly, not to hide. |

```text
Non-negotiable rules for BOTH directions:
  - ADJUSTING ENTRIES ONLY. Never UPDATE or DELETE the original entries (A21).
  - Every adjustment carries provenance: reason='reconciliation',
    source_ref=<settlement file + row>, and links to the incident.
  - Real discrepancies REQUIRE HUMAN REVIEW before adjustment. Auto-adjusting on a
    guess is how you turn a detection into a permanent falsification (A24).
  - Track "days-to-resolve" per discrepancy; an aging unreconciled item is a P1.
```

**Key takeaway:** In both directions you establish ground truth with the provider first, then fix forward with provenance-carrying adjusting entries and never edits — and because either direction can mean real customer impact, confirmed discrepancies get human review rather than an automated guess.

---

### A29. Delayed and reversible payment methods (ACH / SEPA / BNPL / vouchers)

| | Card | **Bank debit (ACH/SEPA) & similar** |
|---|---|---|
| Outcome latency | Seconds | **Days** |
| Initial "success" | Authorization = funds held | **Provisional** — merely "submitted" |
| Can reverse *after* success | Via dispute (weeks) | **Yes, routinely** — insufficient funds, unauthorized, revoked mandate (ACH returns can land days later — verify current windows) |
| Safe to ship goods on success? | Generally yes | **No** — not without a risk decision |

```text
What this forces in the model:

1. A PROVISIONAL state that is NOT success:
     SUBMITTED → (days) → SETTLED  |  RETURNED/FAILED
   Never map "submitted" to CAPTURED.

2. PENDING vs AVAILABLE balance (see QB6) — the single most important consequence:
     pending_balance   = provisional funds (may still reverse)
     available_balance = funds safe to pay out / withdraw
   Payouts and withdrawals draw ONLY from available.

3. A CLAWBACK path: a return arriving after you credited a merchant must
     - append reversing entries,
     - debit the merchant's balance (which may push it negative → a debt to collect),
     - and, if the balance can't cover it, book a loss and start recovery.

4. RISK-BASED early release: you may choose to advance funds before settlement —
   but that is an explicit, priced credit decision, not an accident of the data model.
```

**Key takeaway:** For bank debits and BNPL, "success" is provisional and reversible for days, so you model a submitted-but-not-captured state, split pending from available balance so payouts only ever draw on settled funds, and build an explicit clawback path — releasing funds early is a deliberate credit decision, never a default.

---

### A30. The PSP is down at peak

| Option | Upside | Correctness risk |
|---|---|---|
| **Fail fast** (decline, ask to retry) | Simple and always correct; no ambiguity | Lost revenue; bad customer experience |
| **Queue authorizations** for later | Captures intent; retry when healthy | Auth may fail later (card state changed, funds gone); customer told "success" for something not yet authorized; **do not confirm an order on a queued auth** |
| **Fail over to PSP B** | Preserves revenue | **Highest risk** — see below |
| **Degrade selectively** | Keep high-value/known-good flows on PSP B, fail the rest | Complexity; partial availability |

```text
Failover to a second PSP — the real constraints:

  ⚠️ DOUBLE-CHARGE ACROSS PROVIDERS. Your idempotency key is honored by PSP A, not by
     PSP B. If PSP A actually processed the charge (you just didn't hear back — A17),
     retrying on PSP B charges the customer AGAIN, and no single provider's idempotency
     can save you. Mitigation: only fail over on errors that are DEFINITIVELY
     "not processed" (connection refused, DNS failure, explicit 5xx pre-processing) —
     NEVER on a timeout, which is an unknown.

  ⚠️ TOKENS ARE USUALLY NOT PORTABLE. A card vaulted with PSP A is generally not
     chargeable via PSP B (each vaults its own) — verify per provider. So failover often
     only works for fresh card entry, not for saved cards / off-session charges.

  ⚠️ TWO RECONCILIATION STREAMS, and the ledger must attribute each charge to its provider.
```

The senior answer names the timeout distinction explicitly: **failover is safe only on a definitive not-processed signal**, and the moment you're in "unknown" territory (A17) failing over is how you double-charge.

**Key takeaway:** Fail fast is always correct and queuing is acceptable only if you don't confirm the order, while failover to a second provider is safe *only* on a definitively-not-processed error — never on a timeout — because your idempotency key doesn't cross providers and vaulted tokens usually aren't portable.

---

## Level 6 — Refunds, Payouts, Chargebacks & Disputes

### A31. Refunds, including multiple partials

```sql
-- The invariant: Σ refunds(charge) <= captured(charge)
-- Enforced ATOMICALLY, or two concurrent partial refunds each pass a stale check
-- and together over-refund.

BEGIN;
  -- Serialize on the charge row so concurrent refunds cannot interleave:
  SELECT captured_minor, refunded_minor
    FROM charges
   WHERE id = :charge_id
     FOR UPDATE;                              -- pessimistic; contention here is tiny

  -- Guarded conditional update (the same shape as the no-oversell guard in
  -- ../seat-reservation/): 0 rows updated ⇒ would exceed captured ⇒ reject.
  UPDATE charges
     SET refunded_minor = refunded_minor + :amount
   WHERE id = :charge_id
     AND refunded_minor + :amount <= captured_minor;
  -- if 0 rows: ROLLBACK and return 422 "refund exceeds captured amount"

  INSERT INTO refunds (id, charge_id, amount_minor, idem_key, state) VALUES (...);
  -- ledger entries appended in the SAME txn
COMMIT;
```

| Case | Handling |
|---|---|
| Full refund | `amount = captured − already_refunded` |
| Multiple partials | Each passes the guard; the sum can never exceed captured |
| Refund > captured | Rejected by the guard (never "just clamp it" silently) |
| Refund of an **uncaptured** auth | Not a refund — **void** it (A8) |
| **Idempotency** | Refunds carry their own `Idempotency-Key` (A35) — the most-forgotten one |

Ledger effect is a new opposite-direction transaction (A21), never an edit of the original charge entries.

**Key takeaway:** Guard refunds with an atomic conditional update asserting `Σ refunds <= captured` while holding the charge row, so concurrent partial refunds can't each pass a stale check — and record the refund as new opposite-direction ledger entries rather than mutating the original charge.

---

### A32. Chargebacks vs refunds, and the dispute lifecycle

| | **Refund** | **Chargeback** |
|---|---|---|
| Initiated by | **You** (voluntarily) | The **cardholder's issuer** (forcibly) |
| Your consent | Required — you chose it | **Not required** — money is taken from you |
| Timing | When you decide | Weeks/months later, on the issuer's schedule |
| Cost | Processing fees | **Dispute fee** + the amount + potential penalty-program exposure |
| Deadlines | None | **Hard deadlines** to submit evidence — miss it and you lose automatically |
| Reputation | None | Excessive rates can trigger monitoring/penalties (— verify current network rules) |

```text
Dispute lifecycle:

  INQUIRY / RETRIEVAL (optional, informational)
        │
        ▼
  DISPUTE_OPENED ── funds DEBITED FROM YOU IMMEDIATELY (often provisionally)
        │            + a dispute fee; a deadline_at is set
        │
        ├─ accept ──▶ LOST (you concede; money stays with the cardholder)
        │
        └─ submit evidence (receipts, delivery proof, ToS, device/IP, AVS/CVV results)
                 │
                 ▼
             UNDER_REVIEW  ──▶ WON  (funds returned to you; the fee usually is NOT)
                           └─▶ LOST (funds stay gone; may escalate to arbitration)
```

| Your system must | Why |
|---|---|
| Debit the ledger **when the dispute opens**, not when it resolves | The money is genuinely gone now; a balance that ignores it is wrong |
| Track `deadline_at` and **alert well before it** | A missed deadline is an automatic, unappealable loss |
| Store evidence artifacts immutably, linked to the charge | You must produce them months later |
| Reverse on WON with **new** entries | Append-only (A21) |
| Feed outcomes into risk scoring (A43) | Disputes are your best fraud-label source |
| Expose dispute rate as an SLI | It's both a financial and a compliance signal |

**Key takeaway:** A refund is a voluntary new payment you initiate, whereas a chargeback is the issuer forcibly reversing money without your consent on a hard evidence deadline — so you debit the ledger the moment a dispute opens, alarm on the deadline, and keep evidence immutably linked to the charge.

---

### A33. Payouts to merchants

```text
Payout amount comes from the LEDGER, and only from AVAILABLE funds:

  available = Σ settled credits − Σ debits − holds/reserves − pending_reversals
              ▲
              └─ NOT pending (A29) — never pay out provisional money

Pipeline:
  1. Compute owed per merchant on a schedule (daily/weekly), from the ledger.
  2. Apply HOLDS/RESERVES: a % rolling reserve or a fixed hold for risk exposure
     (new merchants, high-dispute merchants) — a deliberate credit decision.
  3. Threshold + batch (don't wire $0.30; batch to reduce fees).
  4. Create a Payout row (idempotency key!) → state machine below.
  5. Submit to the bank/provider; record entries.
```

```text
Payout state machine:
  PENDING → SUBMITTED → PAID
                │
                ├─▶ FAILED   (invalid bank details, rejected)
                └─▶ RETURNED (bank sent it back, possibly DAYS later)

On FAILED/RETURNED:
  - append REVERSING entries (money never left / came back)
  - RESTORE the merchant's available balance (they are owed it again)
  - flag the merchant for details correction; do not silently retry into the same void
  - if we already treated it as paid downstream, that projection must be corrected too
```

The trap: treating a submitted payout as `PAID`. A returned payout days later must restore the balance, and if you closed the books on it you now have a merchant who is owed money your system thinks it already sent.

**Key takeaway:** Compute payouts from *available* (never pending) ledger balance minus holds and reserves, batch them, and give payouts their own state machine where `FAILED`/`RETURNED` appends reversing entries and restores the merchant's balance — because a returned payout arriving days later must not leave money silently lost.

---

### A34. Marketplace split with a later partial refund

Buyer pays **$100.00**: Seller A's items **$60.00**, Seller B's items **$40.00**; platform fee **3% per seller** (A: $1.80, B: $1.20).

**Transaction 1 — capture and split**

| Account | Type | DR | CR |
|---|---|---:|---:|
| `psp_receivable` | Asset | **10000** | |
| `merchant_payable:seller_A` | Liability | | **5820** |
| `merchant_payable:seller_B` | Liability | | **3880** |
| `platform_fee_revenue` | Revenue | | **300** |
| **Totals** | | **10000** | **10000** |

Balances ✅. Note each seller's payable is *net of their own fee* — attribution is recorded at capture time, which is what makes a later refund attributable at all.

**Transaction 2 — buyer refunds Seller A's $60 item in full** (policy: platform refunds its fee too)

| Account | Type | DR | CR |
|---|---|---:|---:|
| `merchant_payable:seller_A` | Liability | **5820** | |
| `platform_fee_revenue` | Revenue | **180** | |
| `psp_receivable` | Asset | | **6000** |
| **Totals** | | **6000** | **6000** |

Balances ✅. The buyer gets back the full **$60.00**; Seller A gives up the **$58.20** they were owed; the platform gives back the **$1.80** fee it earned on that item. **Seller B is untouched** — which is the whole point of per-seller attribution.

| Fee-refund policy | Entries change how | Note |
|---|---|---|
| **Platform refunds its fee** (above) | `platform_fee_revenue` is debited $1.80 | Merchant-friendly; the common default |
| **Platform keeps its fee** | Seller A is debited the full $6000; no fee reversal | Then `merchant_payable:A DR 6000` / `psp_receivable CR 6000` — still balances |

This is a **stated business policy**, not an accounting accident — and it must be explicit, because it decides who absorbs the loss.

**Key takeaway:** Attribute each seller's share and fee at capture time so a later refund can be charged back to exactly the right seller without touching the others — and make the fee-refund policy (platform gives its fee back or keeps it) an explicit decision, since it determines who absorbs the loss.

---

### A35. (Failure mode) A refund issued twice

```text
How it happened — refunds were treated as "less critical" than charges:

  POST /refunds  (no Idempotency-Key)
     → client times out / user double-clicks / job retries
     → TWO refund rows created, TWO refunds sent to the PSP
     → customer receives $200 back on a $100 purchase.  Direct, unrecoverable loss.

The asymmetry that causes it: engineers instinctively protect the CHARGE path
(charging twice is a visible, complained-about bug) and forget the REFUND path
(refunding twice makes the customer happy and silent — you find out at reconciliation).
```

| Guard | What it stops |
|---|---|
| **Idempotency key on `/refunds`** (same mechanism as A13/A14, `UNIQUE` in-txn) | A retry of the *same* refund request creating a second refund |
| **`Σ refunds <= captured` conditional update** (A31) | Two *distinct* refund requests together exceeding the captured amount |
| Both, together | The two are orthogonal — the key stops duplicate *requests*, the invariant stops over-refund from *any* source |
| Reconciliation (A27) `duplicate` class | Detects it if both guards were missing |

```text
Why the invariant is the stronger of the two:
  an idempotency key only protects against a REPLAY of the same request.
  The Σ-refunds invariant protects against over-refund from ANY path — a retry, a
  buggy job, a manual admin action, two different operators, a support tool.
  Defense in depth: enforce BOTH, and let the DB enforce the invariant, not the caller.
```

**Key takeaway:** Refunds need their own idempotency keys — the most commonly forgotten one, because refunding twice produces a happy silent customer instead of a complaint — but the stronger guard is the in-transaction `Σ refunds <= captured` invariant, since it holds against buggy jobs and manual admin actions too.

---

## Level 7 — Consistency, Correctness & Failure Modes

### A36. Consistency across payment, ledger, and order services

```text
No distributed transaction. Two mechanisms, each doing a different job:

1) WITHIN the payment boundary — ONE local ACID transaction:
      BEGIN
        idempotency record (UNIQUE)      -- A13
        payment/charge state change
        ledger entries (balanced)        -- A20
        outbox row (PaymentCaptured)     -- A22 of ../message-queues/
      COMMIT
   ⇒ the money record and the notification-of-it commit together or not at all.
      Keep the LEDGER IN THE SAME DATABASE as the payment state if you can — it is
      the one boundary where you most want a real transaction rather than a saga.

2) ACROSS services — SAGA with compensations (no 2PC):
      reserve inventory  ↔ release inventory
      authorize payment  ↔ void authorization
      capture payment    ↔ refund
      create order       ↔ cancel order
   ⇒ a later failure runs earlier compensations backward (../distributed-transactions/).
```

| Why not 2PC | Why the outbox is essential |
|---|---|
| Blocking; a coordinator failure holds locks across services | Otherwise "commit payment" + "publish event" is a **dual write** — a crash between them either loses the event (money captured, nothing fulfils) or orphans it |
| Poor availability exactly when you need it | The outbox makes the event durable **iff** the payment is durable |
| Providers don't participate in your 2PC anyway | A relay publishes at-least-once; consumers dedupe (A38) |

**Key takeaway:** Use one local ACID transaction for the idempotency record, state change, ledger entries, and outbox row together — keeping the ledger in the payment database — and a compensating saga across services, because the provider can never participate in a distributed transaction anyway.

---

### A37. The consistency model, stated precisely

| Concern | Guarantee |
|---|---|
| Idempotency check + payment state + ledger entries | **Strongly consistent** — one ACID transaction, serialized on the key |
| `Σ debits = Σ credits` | **Strongly consistent** — invariant holds at every commit |
| Materialized balances | **Eventually consistent** (derived), with a drift checker (A22) |
| Downstream projections (order status, emails, analytics) | **Eventually consistent** via at-least-once events |
| Agreement with the provider's settled truth | **Eventually consistent** — converges via webhooks + reconciliation |

```text
Two DIFFERENT meanings of "final" — conflating them causes real loss:

  FINAL FOR THE CUSTOMER    at AUTHORIZED/CAPTURED
                            they saw success, they expect the goods.
                            (may be minutes after they started)

  FINAL FOR ACCOUNTING      at SETTLED **and** RECONCILED
                            money actually moved and both sides agree.
                            (T+1..T+3 for cards; DAYS and still reversible for ACH — A29)

  ⇒ A payment can be customer-final and accounting-provisional at the same time.
    Pay out on customer-final and you are lending money you may never receive (QB6).
```

**Key takeaway:** The idempotency check, state change, and ledger entries are strongly consistent in one transaction while balances, projections, and provider agreement are eventually consistent — and you must never conflate customer-final (authorized/captured) with accounting-final (settled *and* reconciled).

---

### A38. Making event consumers idempotent under at-least-once

```sql
-- The consumer's dedupe and its EFFECT must be in the SAME transaction,
-- or a crash between them either double-applies or silently drops.

BEGIN;
  INSERT INTO processed_events (event_id, consumer_name, processed_at)
  VALUES (:event_id, 'balance_projector', now())
  ON CONFLICT (event_id, consumer_name) DO NOTHING;
  -- 0 rows inserted ⇒ already processed ⇒ ROLLBACK and ack. Do NOT apply again.

  -- The effect, in the same transaction as the dedupe marker:
  UPDATE merchant_balances
     SET available_minor = available_minor + :amount
   WHERE merchant_id = :merchant_id;
COMMIT;
-- ack the message only after COMMIT
```

| Detail | Consequence if wrong |
|---|---|
| Dedupe key is `(event_id, consumer_name)` | A single global key means the *second* consumer never sees the event |
| Marker + effect in **one** transaction | Separate transactions → crash between them → double-apply or lost update |
| Ack **after** commit | Ack-before-commit loses the event on a crash |
| Prefer **naturally idempotent** effects where possible (set-to-value, or append a ledger entry keyed by event) | Additive updates are only safe *because* of the dedupe marker |

Note the alternative that avoids the problem entirely: because ledger entries are append-only and can be keyed by the source event, `INSERT … ON CONFLICT DO NOTHING` on the entry itself is inherently idempotent — no separate marker needed.

**Key takeaway:** Commit the dedupe marker and the effect in a single transaction keyed by `(event_id, consumer)` and ack only after commit — or better, make the effect an append keyed by the source event so idempotency is structural rather than bolted on.

---

### A39. (Failure mode) Four hours of double-written ledger entries

```text
Symptom: a deploy double-writes entries. Money appears created from nothing.
  Invariant I1 (Σ DR = Σ CR per txn) may still pass if BOTH legs were duplicated —
  balances are inflated, and the global sum can still be zero. So the detection is
  I4 (materialized ≠ fold) and/or reconciliation against the PSP (A27), not I1 alone.
```

```text
INCIDENT RESPONSE — in order:

1. STOP THE BLEEDING
   Roll back / feature-flag off the offending write path. Freeze payouts and
   withdrawals for affected accounts (do NOT let inflated balances be withdrawn —
   that converts a fixable ledger bug into unrecoverable cash loss).

2. QUANTIFY (do not fix yet)
   - Query the exact duplicate set: entries in the window matching on
     (source_ref, account, amount, direction) with count &gt; 1.
   - Re-fold every affected account (A22) and diff vs materialized.
   - RECONCILE against the PSP (A27) — the provider's record is the external
     ground truth for what money actually moved.

3. FIX FORWARD — APPEND, NEVER DELETE
   For each duplicate, append a REVERSING transaction:
     reason = 'incident_correction', source_ref = &lt;INC-1234&gt; + original txn_id
   The bad entries REMAIN in the ledger. Net effect becomes correct.
   ❌ Never DELETE the duplicates. ❌ Never UPDATE amounts.
      Deleting destroys the evidence auditors require and makes the incident
      unprovable — it launders a bug into a falsified record (A21/A24).

4. RECONCILE AGAIN + verify all invariants pass; unfreeze payouts per account only
   after that account re-folds clean.

5. POSTMORTEM
   - Add the I4 drift check to CI (would it have caught this pre-deploy?)
   - Alert on rate-of-change of ledger entries per payment (a doubling is detectable
     within minutes, not hours — 4 hours of exposure is itself the bigger finding)
   - Property-test the write path (A40)
```

**Key takeaway:** Freeze withdrawals first so inflated balances can't be cashed out, quantify against a fresh fold plus provider reconciliation, then fix forward with appended reversing entries that reference the incident — deleting the bad entries would destroy the audit trail and turn a fixable bug into a falsified record.

---

### A40. Testing a payment system

| Layer | What it catches | Notes |
|---|---|---|
| **Property-based tests on ledger invariants** ⭐ | Money created/destroyed, unbalanced txns, rounding drift | Highest value per line. Generate random operation sequences (charge/partial-refund/dispute/payout), then assert `Σ DR = Σ CR`, `Σ refunds <= captured`, and that splits sum exactly to the whole |
| **Unit tests on the state machine** | Illegal transitions (capture a voided auth, refund an uncaptured charge) | Assert rejected transitions are *rejected*, not just that happy paths work |
| **Provider sandbox / test mode** | Integration shape, declines, 3-DS challenge flows | Providers offer magic test cards for specific decline codes — verify current docs |
| **Deterministic fault injection** ⭐ | The A17/A18 class — timeouts, duplicate webhooks, out-of-order webhooks, crash-between-steps | Inject at the adapter boundary: force timeout, replay a webhook twice, deliver `captured` before `authorized`, kill the process between PSP call and persist |
| **Reconciliation tests** | Feed a synthetic settlement file with each mismatch class (A27) and assert correct classification | Including the cut-off-timing false positive |
| **Load tests** | Contention on the charge row under concurrent partial refunds | Verify the guard actually holds under parallelism |

```text
What you CANNOT safely test in production:
  real money movement at scale. So:
    - sandboxes for behavior, and a SEPARATE test provider account
    - canary with tiny real amounts on a small traffic slice, closely watched
    - SHADOW the new path: compute what it *would* have done, diff against the live
      path, ship only when the diff is zero (the QB5-adjacent discipline)
    - and treat RECONCILIATION as the production backstop — it is the test that
      never stops running
```

**Key takeaway:** Property-based tests over random operation sequences asserting the ledger invariants plus deterministic fault injection for timeouts and duplicate/out-of-order webhooks catch the bugs that matter — and because you can't safely test real money at scale, shadow-diff new paths and treat reconciliation as the test that runs forever in production.

---

## Level 8 — Scale, Security & Compliance

### A41. Sharding payments and the ledger

| Data | Shard key | Breaks | Fix |
|---|---|---|---|
| Payments / charges | `account_id` (merchant/tenant) | Cross-merchant reporting | Feed an OLAP store |
| Ledger entries | `account_id`, partitioned by **time** within it | Global `Σ DR = Σ CR` across shards | Verify per-shard continuously; global check as a batch job over the OLAP copy |
| Idempotency records | Same shard as the payment it guards | — | The `UNIQUE` must be *within* the shard that does the write |

```text
Why an APPEND-ONLY ledger shards more easily than a mutable balances table:

  balances table:   every payment for merchant M contends on THE SAME ROW.
                    → hot-row lock contention; a big merchant is a hotspot you
                      cannot shard away (one row cannot be split)

  ledger entries:   every payment INSERTS NEW ROWS.
                    → no contention on shared state; appends distribute naturally;
                      time-partitioning keeps indexes healthy and makes archival
                      a partition-drop instead of a mass DELETE
                    → the cost moves to READS (balance = fold), solved by
                      snapshot+delta (A22), which is itself per-account and shardable
```

| Constraint that shapes everything | Implication |
|---|---|
| The idempotency `UNIQUE` must live in the **same shard** as the write it guards | Cross-shard uniqueness is not a thing you want on the money path — so route by a key present in the request |
| Ledger grows forever (A4) | Partition by time; archive cold partitions to cheap storage; **never delete** |
| A transaction's entries must be **co-located** | Otherwise `Σ DR = Σ CR` needs a distributed transaction — so keep both legs in one shard by construction |

**Key takeaway:** Shard by account with time-partitioning inside, and note that an append-only ledger shards far better than a mutable balances table because appends never contend on a shared hot row — but keep both legs of a transaction and the idempotency constraint co-located so balance checking never needs a distributed transaction.

---

### A42. The compliance surface (directional — verify; not legal advice)

| Control | What it does | Design consequence |
|---|---|---|
| **Tokenization + hosted fields** | Card data never enters your systems | The single biggest **PCI DSS scope reduction** lever (A10) |
| **Network segmentation** | Isolates anything that *could* touch cardholder data | Keeps the audit boundary small |
| **Encryption in transit** | TLS everywhere, including service-to-service | mTLS internally is common |
| **Encryption at rest** | Databases, backups, logs, exports | Backups and log exports are the commonly-missed copies |
| **Key management** | KMS/HSM, rotation, split duty, no keys in code/env-vars-in-git | Rotation must be possible without re-encrypting the world (envelope encryption) |
| **Audit logging** | Immutable, append-only, tamper-evident | Same append-only discipline as the ledger |
| **Least privilege** | App role can `INSERT` ledger entries, not `UPDATE`/`DELETE` (A21) | Enforce invariants with *permissions*, not just code |
| **Data residency** | Some jurisdictions require in-region storage/processing | May force regional deployments and regional ledgers |
| **PII minimization** | Don't store what you don't need; mask in logs | Reduces breach blast radius |

```text
What you must be able to PROVE to an auditor:
  - a complete, immutable, ordered history of every money movement (the ledger)
  - who did what, when, and under what authority (audit log + least privilege)
  - that card data never entered scope (architecture + evidence of tokenization)
  - that controls were CONTINUOUSLY effective, not effective on audit day

⚠️ Specific PCI DSS levels, SAQ types, and requirement numbers change over time.
   VERIFY against the current PCI DSS standard and your acquirer's requirements.
   This is directional engineering guidance, NOT legal or compliance advice.
```

**Key takeaway:** Tokenization is the dominant compliance lever because it keeps cardholder data out of scope entirely, and the rest is segmentation, encryption, key management, immutable audit logging, and least privilege — with database permissions (insert-only on the ledger) enforcing invariants that code alone could violate.

---

### A43. Fraud and risk in the payment path

```text
Where it sits — synchronously, BEFORE the provider call, on a tight budget:

  request → [ rules engine (~1–5 ms) ] → [ ML score (~10–50 ms) ] → decision
                                                                      │
                              ┌───────────────────┬───────────────────┤
                           ALLOW            STEP-UP (3-DS)          BLOCK
                                            ← the middle path that
                                              saves good customers
  Total risk budget ~tens to low-hundreds of ms inside a ~1–3s auth (illustrative — verify).
  FAIL-OPEN vs FAIL-CLOSED on a risk-service outage is an explicit business decision:
  fail-open keeps revenue but accepts fraud exposure; fail-closed is safe but stops sales.
```

| Layer | Character |
|---|---|
| **Velocity / rules** | Deterministic, explainable, instant — "N cards per device per hour", "amount &gt; X to a new payee", geo-velocity impossibilities. Cheap and auditable |
| **ML scoring** | Trained offline on labeled outcomes (disputes are your labels — A32), served synchronously. Catches patterns rules miss; harder to explain |
| **Step-up (3-DS)** | Shifts liability and adds friction only where warranted; often moves liability to the issuer (— verify) |
| **Post-auth review** | Async queue for medium-risk accepts; can still void/refund before shipping |

```text
THE ASYMMETRY (the senior point):

  FALSE DECLINE  — you blocked a good customer.
     Cost: the lost sale + the customer's lifetime value + they may never return.
     INVISIBLE in your metrics (no fraud loss shows up — it looks like success!)
     Usually the LARGER total cost at scale.

  FALSE ACCEPT   — you approved fraud.
     Cost: the amount + dispute fee + dispute-rate exposure.
     HIGHLY VISIBLE (it shows up as a chargeback).

  ⇒ Optimizing purely on "fraud loss" systematically over-blocks, because one side of
    the ledger is measured and the other isn't. Track decline rate and
    false-decline proxies (e.g. retry-elsewhere success) alongside fraud loss.
```

**Key takeaway:** Run cheap deterministic velocity rules then an ML score synchronously inside a tight budget with 3-DS step-up as the middle path — and explicitly track false declines, because fraud loss is visible while a blocked good customer is invisible, so optimizing on fraud loss alone silently over-blocks.

---

### A44. Multi-currency

| Concept | Meaning |
|---|---|
| **Presentment currency** | What the customer sees and is charged in (e.g. EUR) |
| **Settlement currency** | What you actually receive in your bank account (e.g. USD) |
| **Accounting/base currency** | What you report in |

```text
THE RULE: capture and STORE the FX rate at the moment you QUOTE it.
          Never re-derive a historical rate later.

  quote:  { amount_minor: 10000, currency: "EUR",
            fx_rate: 1.0850, rate_source: "provider|internal",
            rate_captured_at: "2026-07-29T10:00:00Z", rate_id: "fx_abc" }

Why: rates move continuously. If you re-derive later you get a DIFFERENT number than
you charged, so the payment becomes unreproducible and unauditable — and the diff
silently becomes an unexplained reconciliation gap (A27 currency/FX mismatch class).
```

```text
FX gain/loss gets its OWN ledger account:

  You quoted EUR 100 at 1.0850 → expected USD 108.50 (10850 minor)
  Settlement actually delivers    USD 108.20 (10820 minor)

    cash:bank_main            DR 10820
    fx_loss                   DR    30      ← the difference is RECOGNIZED, not hidden
    psp_receivable                 CR 10850
                              ─────────────
                              10850 = 10850  ✅
```

| Rule | Why |
|---|---|
| Never mix currencies in one arithmetic operation | It's a type error (A23) |
| An FX transaction records **both legs plus the rate** | Invariant I6 (A24) |
| FX gain/loss is an explicit account | A hidden difference is an unexplained gap |
| Rounding on conversion is deterministic and recorded | Same as A23 |

**Key takeaway:** Distinguish presentment from settlement currency, capture and store the FX rate (with source and timestamp) at quote time so the charge is always reproducible, and recognize the settlement difference in an explicit FX gain/loss account rather than letting it become an unexplained reconciliation gap.

---

### A45. Monitoring and the metric that must be zero

| SLI | Why it matters | Alert shape |
|---|---|---|
| **Unreconciled money (count + absolute amount)** ⭐ | Money unaccounted for | **Must be ZERO.** Page on any non-zero that ages past one cycle |
| **Ledger imbalance** (I1/I2 violations) ⭐ | Money created/destroyed | **Must be ZERO.** Page immediately (A24) |
| **Balance drift** (I4: materialized ≠ fold) | Silent corruption | Must be zero; nightly + alert |
| Authorization success rate | Revenue + provider health | Page on a sharp drop (segment by provider/BIN/country — a global average hides a broken corridor) |
| Payments stuck in `INDETERMINATE`/non-terminal | The A17/A18 class | Alert past SLA — each is potential customer harm |
| Webhook processing lag + DLQ depth | Async health | Alert on growth |
| Duplicate-charge rate | Idempotency failure | Must be ~zero |
| Refund/dispute rate | Financial + compliance exposure | Trend + threshold |
| p99 authorization latency | Checkout conversion | Standard latency SLO |
| Reconciliation job completion | If it silently stops, you lose your safety net | **Alert on absence** — a job that didn't run looks identical to "no problems" |

```text
The one that is ALWAYS ZERO: unreconciled money / ledger imbalance.
Everything else is a rate you tune. This is a boolean: either every cent is accounted
for, or you have an incident. Alert on it like a paging failure, not a dashboard metric.

And alert on the ABSENCE of the reconciliation run — a monitoring system that only
watches for bad results will happily report "all clear" when the checker is dead.
```

Depth on SLIs, error budgets, and alerting philosophy: [observability](../observability/).

**Key takeaway:** Track authorization/refund/dispute rates and latency as tunable SLIs, but treat unreconciled money and ledger imbalance as booleans that must always be zero and page on them — and alert on the *absence* of the reconciliation run, because a dead safety net is indistinguishable from a healthy system.

---

## Level 9 — Frontend Architecture (Architect)

### A46. Checkout UI architecture and why card data must never reach your code

```text
The card's path — note it NEVER crosses your boundary:

  ┌─ your page ────────────────────────────────────────────┐
  │  your React/Vue app                                    │
  │  ┌──────────────────────────────────┐                  │
  │  │ PSP-OWNED IFRAME (hosted field)  │  ← different ORIGIN
  │  │  <input> card number             │     your JS CANNOT read into it
  │  └──────────────┬───────────────────┘     (same-origin policy is the
  │                 │ card PAN                 actual security boundary)
  └─────────────────┼──────────────────────────────────────┘
                    ▼  direct HTTPS, browser → PSP
              PSP tokenization endpoint
                    │
                    ▼ returns TOKEN
        your JS receives ONLY the token → POST to your API
```

| Must never happen | Why it's a breach, not a bug |
|---|---|
| Card number in your JS variable / component state | It's now in memory, in devtools, and in any state snapshot |
| Card number in Redux/Vuex store | State-persistence middleware may write it to `localStorage` |
| Card number in a network request to *your* server | Your entire backend enters PCI scope |
| Card number in logs / error messages | Logs are replicated, shipped, and long-lived |

```text
⚠️ THE LEAK EVERYONE MISSES — third-party scripts on the checkout page:
   - SESSION REPLAY (record everything the user sees/types) can capture a card field
     even though YOUR code never reads it
   - ERROR REPORTING can serialize DOM state or form contents into a bug report
   - ANALYTICS with auto-capture of form inputs
   ⇒ Mitigate: explicitly mask/block payment fields in every such tool, audit the
     script inventory on the checkout route, apply a strict CSP, and prefer loading
     NO third-party scripts on the payment step at all.
   (Hosted fields help enormously here: the PAN lives in a cross-origin iframe, so a
    replay script in YOUR page cannot reach it — this is the strongest structural guard.)
```

**Key takeaway:** Card data goes browser→PSP inside a cross-origin iframe so the same-origin policy — not your discipline — is the security boundary, and you only ever hold a token; the leak that actually bites teams is a session-replay or error-reporting script on the checkout page capturing the field your own code never touched.

---

### A47. Idempotent submit from the client

```ts
// Mint ONE key per checkout ATTEMPT — not per click, not per render.
function getIdempotencyKey(checkoutId: string): string {
  const storageKey = `idem:${checkoutId}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();          // real Web Crypto API
    sessionStorage.setItem(storageKey, key);   // survives refresh + back-button
  }
  return key;
}

async function pay(checkoutId: string, body: PayBody) {
  const key = getIdempotencyKey(checkoutId);
  setSubmitting(true);                  // disable the button (necessary, not sufficient)
  try {
    return await api.post('/payment_intents', body, {
      headers: { 'Idempotency-Key': key },
    });
  } finally {
    // NOTE: do NOT clear the key here — a retry of THIS attempt must reuse it.
    // Clear it only on a terminal outcome, when starting a genuinely NEW attempt.
    setSubmitting(false);
  }
}
```

| Scenario | Behavior with this design |
|---|---|
| Double-click | Button disabled **and** both requests carry the same key → server dedupes (A14) |
| **Refresh mid-payment** | Key survives in `sessionStorage` → resubmit is recognized as a retry, not a new charge |
| **Back-button then re-submit** | Same key → replayed stored response |
| Two tabs on the same checkout | Same `sessionStorage` per tab? **No** — `sessionStorage` is per-tab, so use the server-issued `checkoutId`/intent as the anchor and let the server's key/intent dedupe. This is why the *server* must be authoritative and the client key is only a hint. |
| Genuinely new purchase | New `checkoutId` → new key |

The important framing: a disabled button is a UX nicety, not a guarantee. The guarantee is the server-side `UNIQUE` (A13); the client's job is only to *reuse the same key* so the server can recognize the retry.

**Key takeaway:** Mint one idempotency key per checkout attempt and persist it (`sessionStorage`) so refresh and back-button reuse it rather than starting a new charge — and treat the disabled button as UX only, since the actual guarantee is the server's unique constraint.

---

### A48. 3-D Secure / SCA redirects and challenge flows

```text
The problem: the customer LEAVES YOUR PAGE (redirect or full-page challenge) and your
JS state dies. Anything only in memory is gone.

BEFORE redirecting — persist DURABLY (server-side, not just sessionStorage):
  { checkout_id, intent_id, idempotency_key, cart_snapshot, return_url }
  ⇒ server-side is essential: the customer may return in a DIFFERENT tab, a different
    browser session, or on a different device (email link), where sessionStorage is gone.

  intent state → REQUIRES_ACTION   (A11)

ON RETURN (return_url hit):
  1. Look up the intent by id/key — DO NOT start a new payment.
  2. Re-query the current state (the webhook may have already resolved it!).
  3. Branch:
       AUTHORIZED/CAPTURED → show confirmation (treat "already done" as NORMAL)
       FAILED              → show failure + offer a NEW attempt (new key)
       still REQUIRES_ACTION / PROCESSING → show "confirming…" and poll (A49)
```

| Case | Handling |
|---|---|
| Customer completes the challenge | Return → resume by key → confirm |
| **Customer never comes back** (closes the tab) | The payment is **not** failed — it may have succeeded. Resolve via **webhook + reconciliation** (A25/A27), then notify the customer by email. Never assume failure. |
| Customer returns twice / refreshes the return URL | Idempotent lookup by key → same confirmation, no second charge |
| Challenge succeeded but your return handler 500s | Webhook still resolves the payment; the customer sees it via email/order page |

**Key takeaway:** Persist the intent id and idempotency key **server-side** before the redirect (the customer may return in a different tab or device), resume by looking the intent up rather than starting a new payment, and if they never return let webhooks and reconciliation resolve it — an abandoned challenge is an unknown, not a failure.

---

### A49. The network drops right after Pay

```text
This is A17 from the CLIENT'S side — and the same rule applies: it is an UNKNOWN.

❌ WRONG                                  ✅ RIGHT
   "Payment failed, try again"               "We're confirming your payment…"
   → user pays again → DOUBLE CHARGE         → then resolve by asking

  async function payWithRecovery(checkoutId, body) {
    const key = getIdempotencyKey(checkoutId);          // A47 — stable across retries
    try {
      return await api.post('/payment_intents', body, { headers: {'Idempotency-Key': key} });
    } catch (e) {
      if (isNetworkOrTimeout(e)) {
        // DO NOT resubmit blindly. RE-QUERY by the key/intent.
        showStatus('confirming');                        // honest, non-committal
        return await pollUntilTerminal(key, {
          backoff: 'exponential', jitter: true, maxWait: '90s',
        });
        // Retrying the POST with the SAME key is also safe (server dedupes),
        // but a GET/status poll is cleaner: it cannot create anything.
      }
      throw e;                                           // a real 4xx IS an answer
    }
  }
```

| UI state | Shown when | User action offered |
|---|---|---|
| "Confirming your payment…" | Network/timeout, outcome unknown | Wait; explicitly **do not** offer "pay again" |
| "Payment confirmed" | Server says AUTHORIZED/CAPTURED | Continue |
| "Payment failed — try again" | Server **definitively** says FAILED | New attempt (new key) |
| "Still processing — we'll email you" | Poll exhausted, still indeterminate | Leave; resolved async (A25/A27) |

The rule: **only the server may declare failure.** A client-side network error is evidence about the *network*, not about the money.

**Key takeaway:** A dropped connection after Pay is the client-side mirror of never-trust-a-timeout — show "confirming", re-query by the idempotency key with backoff rather than resubmitting, and never render failure on network evidence alone, because only the server can declare that money didn't move.

---

### A50. Displaying honest state when the truth is asynchronous

| Payment reality | ❌ Dishonest UI | ✅ Honest UI |
|---|---|---|
| Authorized, not captured | "Payment complete" | "Payment confirmed" / "Order placed" (accurate — funds are secured) |
| ACH/SEPA submitted (days to settle, reversible — A29) | "Paid ✓" | "Payment pending — usually 1–3 business days" |
| INDETERMINATE (A17) | "Failed" or "Succeeded" | "Confirming your payment…" |
| Captured but not settled | (fine to show as paid to the *customer*) | but internally **pending**, not payable out (A37) |
| Dispute opened | (silence) | Surface it to the merchant immediately — their balance changed |

```text
THE RULE for optimistic UI on a money path:

  ✅ You MAY optimistically render INTENT.
       "Submitting payment…", "Placing your order…" — reversible, no false claim.

  ❌ You MUST NOT optimistically render SETTLEMENT.
       "Payment successful" before the server confirms is a LIE that the user acts on:
       they close the tab, they expect goods, they tell their bank they paid.
       Rolling that back is not a UI correction — it is a broken promise.

  Asymmetry: optimistic UI elsewhere costs a flicker. On a money path it costs trust,
  support cost, and sometimes a chargeback (the user "knows" they paid).
```

Corollary for the merchant-facing side: expose **pending vs available** balance explicitly (QB6). A single "balance" number that includes provisional funds invites a merchant to spend money that may reverse.

**Key takeaway:** You may optimistically render *intent* ("submitting…") but never *settlement* ("payment successful") — on a money path a premature success message is a promise the user acts on, so show real intermediate states including pending bank debits and let only the server confirm.

---

## Bonus — Senior-Unprompted

### QB1. Stored payment methods and off-session / recurring charges

| | **On-session** (customer present) | **Off-session** (recurring/subscription) |
|---|---|---|
| Customer available to authenticate | Yes — can complete 3-DS | **No** — nobody to challenge |
| Consent | Implicit in the act of paying | Must be **captured in advance** (a mandate/agreement) and referenced on each charge |
| Auth success rate | Higher | Lower — issuers scrutinize unattended charges |
| Failure handling | Show an error, retry now | **Dunning**: scheduled retries, notify the customer, then downgrade/suspend |
| Regulatory (SCA) | Challenge available | Often relies on an exemption tied to the stored mandate — **verify current SCA/PSD2 rules** |

```text
What you must store (beyond the token):
  { payment_method_token, mandate_id, consent_captured_at, consent_text_version,
    agreement_type: 'recurring'|'unscheduled'|'installment' }
  ⇒ the CONSENT RECORD is as important as the token: on a dispute you must prove the
    customer agreed to be charged off-session.
Also: cards expire and get reissued → network tokens / account-updater services reduce
involuntary churn (— verify provider support).
```
**Key takeaway:** An off-session charge has nobody to authenticate, so it depends on a stored mandate plus a durable consent record you can produce in a dispute — and it needs dunning rather than an error message, because the customer isn't there to retry.

---

### QB2. Why build your own ledger instead of trusting the PSP dashboard

| | PSP dashboard as truth | **Your own ledger** |
|---|---|---|
| Multiple providers | Each has a partial view; no unified truth | **One** truth spanning all providers |
| Your own business concepts (platform fees, seller splits, holds, wallet balances) | Not modeled — they're your domain, not theirs | Modeled natively |
| Vendor migration | Your history is trapped in a system you're leaving | History is yours, provider-independent |
| Independent verification | You'd be checking their work against… their work | You can **detect their errors** (fee discrepancies, missing payouts — A27) |
| Auditability on your terms | Their retention, their schema, their API limits | Your retention, immutable, queryable |
| Outage | Dashboard down = you're blind to your own finances | You still know your position |

```text
The decisive argument: RECONCILIATION REQUIRES TWO INDEPENDENT RECORDS.
If the PSP is your only record, there is nothing to reconcile against — you have
no way to ever detect that they (or your integration) got something wrong.
A single source of truth you don't control is not a source of truth; it's a dependency.
```
**Key takeaway:** Reconciliation only works if you hold an independent record, so a provider dashboard can never be your source of truth — your own ledger is what lets you span multiple providers, model your own fees and splits, survive a migration, and detect the provider's errors.

---

### QB3. Holding customer funds vs passing them through

```text
⚠️ NOT LEGAL ADVICE. Regulatory posture is jurisdiction-specific and changes.
   Involve counsel and compliance early — this is a LEGAL design constraint that
   dictates architecture, not an engineering preference. VERIFY everything here.

PASS-THROUGH (funds flow customer → PSP → merchant; you never hold a balance):
  - lightest regulatory posture; you are a technology provider
  - architecture: no stored-value accounts; payouts are provider-orchestrated

HOLDING FUNDS (customers/merchants have a balance with YOU; wallets, stored value):
  - may constitute money transmission / e-money activity → licensing, registration
  - SAFEGUARDING: customer funds typically must be segregated from operating funds
    (separate accounts, not commingled) and reconciled to the penny, continuously
  - KYC/AML obligations: identity verification, sanctions screening, suspicious-activity
    monitoring and reporting
  - stricter audit, capital, and reporting requirements
```

| Architectural consequence of holding funds | Why |
|---|---|
| A **customer-funds** account tree segregated from operating accounts in the ledger | Safeguarding must be *provable*, so it must be modeled |
| Continuous reconciliation of customer-funds ledger ↔ segregated bank balance | An imbalance here is a regulatory issue, not just a bug |
| KYC/AML as a first-class pipeline (screening, case management, reporting) | Not optional |
| Stricter negative-balance handling | You cannot lend customer funds |

**Key takeaway:** Passing funds through keeps you a technology provider, while holding customer balances may make you a regulated money transmitter with safeguarding, segregation, and KYC/AML obligations — which forces a segregated account tree and continuous reconciliation into the architecture, so this decision must involve counsel before design.

---

### QB4. Migrating providers and stored tokens

```text
Adding/migrating a PSP — the hard part is TOKENS, not code.

CODE: the adapter layer (A9) makes the integration swap mechanical.

TOKENS: a card vaulted with PSP A is generally NOT chargeable via PSP B — each vaults
its own and the raw PAN is the thing you deliberately never had (A10).
Options (all require provider cooperation — VERIFY current programs/terms):
  1. PROVIDER-ASSISTED MIGRATION: PSPs commonly support a PCI-compliant vault export/
     import between certified processors, coordinated by both parties. This is the
     standard path and does NOT route the PAN through you.
  2. RE-TOKENIZE ON NEXT USE: dual-run. Charge existing customers on PSP A; when a
     customer next enters a card (or on their next on-session payment), tokenize with
     PSP B. Long tail, zero migration risk, but you run both for a while.
  3. NETWORK TOKENS, where supported, can reduce provider lock-in (— verify).
  ❌ NEVER "export the PANs and re-tokenize yourself" — that pulls cardholder data into
     your scope and destroys the compliance posture you built.

ROLLOUT: route a small % of NEW payments to PSP B → compare auth rates, latency, fee
accuracy, webhook fidelity, and settlement-file parsing → ramp. Keep BOTH
reconciliation streams running throughout, and attribute every ledger entry to its provider.
```
**Key takeaway:** The adapter layer makes the code swap mechanical, but vaulted tokens generally aren't portable — so you use a provider-assisted PCI-compliant vault transfer or dual-run and re-tokenize on next use, and never pull PANs through your own systems to do it.

---

### QB5. Idempotency at the edge vs in the service

| | **API gateway / cache dedupe** | **Database transaction dedupe** |
|---|---|---|
| Atomic with the money write | ❌ No — separate systems | ✅ Yes — same transaction |
| Survives cache eviction / restart | ❌ Key evicted → duplicate passes through | ✅ Durable |
| Handles the concurrent race (A14) | ❌ Two requests can both miss the cache | ✅ `UNIQUE` arbitrates |
| Multi-region / multi-instance | ❌ Needs its own consensus to be correct | ✅ The DB already provides it |
| Can return the *original response* | Sometimes (if cached) | ✅ Stored deliberately |
| Useful at all? | ✅ **Yes — as a cheap first filter** | ✅ The actual guarantee |

```text
What breaks with gateway-only dedupe:
  1. TTL eviction under memory pressure → a late retry becomes a second charge.
  2. Two concurrent requests both miss the cache (nothing serializes them) → 2 charges.
  3. The cache says "seen" but the service CRASHED before committing → the retry is
     rejected as a duplicate and the payment is LOST (worse: a silent no-op).
  4. Cache/DB split-brain: the dedupe record and the payment record can disagree.

⇒ Use the gateway as an optimization (shed obvious floods), NEVER as the guarantee.
  The guarantee must be transactional with the effect it protects.
```
**Key takeaway:** A gateway cache is not transactional, so eviction, concurrent misses, and a crash-after-cache-write can each turn into a double-charge or a silently lost payment — keep it as a cheap first filter but put the real guarantee in the same database transaction as the money write.

---

### QB6. Pending vs available balance

```text
naive single balance:  balance = Σ credits − Σ debits          ← WRONG, and expensive

correct:
  pending_minor   = provisional funds (authorized-not-settled; ACH submitted; under review)
  available_minor = settled − debits − holds − reserves        ← the ONLY payout source
```

| Scenario | Single balance | Split balance |
|---|---|---|
| ACH submitted, then **returned** 4 days later (A29) | Merchant already withdrew it → **you funded it; real loss**, now chase a debt | Never was available → nothing to claw back |
| Card authorized, capture later fails | Balance overstated | Pending only; no exposure |
| Dispute opened (A32) | Silently overstated until resolved | Moves out of available immediately |
| Risk hold on a new merchant | Nowhere to express it | A `holds` component of available |

```text
Why a single balance causes REAL financial loss (not just wrong UI):
  it invites you to pay out money that has not settled and can still reverse.
  When it reverses, the funds are already gone to the merchant — you have made an
  unsecured loan you never decided to make, and recovery is a collections problem.

Releasing pending funds early is a legitimate product (instant payouts) — but it must be
an EXPLICIT, PRICED CREDIT DECISION, not an accident of the data model.
```
**Key takeaway:** Split pending from available and pay out only from available, because a single balance silently invites you to disburse provisional funds that can still reverse — turning a modeling shortcut into an unsecured loan you never chose to make.

---

## ⚡ Quick Revision Cheatsheet

### Scale numbers (order-of-magnitude — verify)

```text
Payments:      ~10M/day ≈ 115/s avg, ~1K/s peak    ← throughput is the EASY part
Ledger writes: ~4–8 entries/payment → ~500–900/s avg, ~4–8K/s peak
Storage:       ~12 GB/day of entries → ~4–5 TB/yr, APPEND-ONLY, retained for years
Auth latency:  ~1–3s end-to-end, incl. sync risk check (~tens–low-hundreds of ms)
Settlement:    T+1..T+3 for cards; DAYS and still reversible for ACH/SEPA
Binding constraint: CORRECTNESS + external agreement, not QPS
```

### Key technology choices

| Component | Choice | Why |
|---|---|---|
| Exactly-once charge | `UNIQUE(idem_key)` + stored response, **in the money transaction** | The only non-racy guarantee; a cache can't do it |
| Payment lifecycle | Explicit persisted state machine incl. `INDETERMINATE` | Ambiguity must have somewhere to live |
| Source of truth | **Append-only double-entry ledger** (SQL) | Balanced pairs make lost money *detectable* |
| Money type | Integer minor units + explicit currency | Floats drift; decimals are per-currency |
| Balances | Snapshot + delta, plus a drift checker | O(1) reads without reintroducing silent wrongness |
| Event emission | Transactional outbox → Kafka | No dual-write loss |
| Provider outcomes | Signed webhooks, deduped by event id, `200` fast | Latency optimization, never the only truth |
| Ground truth | Daily 3-way reconciliation | The only thing that detects divergence |
| Card data | PSP hosted fields / iframe → token | Cross-origin boundary keeps you out of PCI scope |
| Providers | Adapter layer + a second PSP | Outage survival; but tokens aren't portable |

### Canonical tradeoffs to memorize

- **Exact inside vs defensive outside** — strict transactions and invariants within your boundary; assume duplication, reordering, and unknowns beyond it.
- **Authorize vs capture** — secure funds early, move money at fulfillment; pre-capture cancel is a **void** (free), post-capture is a **refund** (a new movement, with fees).
- **Void vs refund** — cancel a promise vs make an opposite payment.
- **Fold vs materialize balances** — always-correct but O(n) vs O(1) but needs a drift checker.
- **Webhooks vs polling/reconciliation** — fast but unreliable vs slow but authoritative; you need both.
- **Fail fast vs queue vs PSP failover** — correct-but-lost-revenue vs deferred-risk vs highest-risk (only on a *definitive* not-processed error).
- **False decline vs false accept** — invisible lost revenue vs visible fraud loss; optimizing on fraud loss alone over-blocks.
- **Pending vs available balance** — paying out pending funds is an unsecured loan.
- **Customer-final vs accounting-final** — authorized/captured vs settled *and* reconciled.

### Common interview mistakes to avoid

- **Treating a timeout as a failure** (or a success) instead of an explicit **unknown** — the single biggest one.
- Using a mutable `balances` table with `UPDATE balance = balance + x` instead of **double-entry**.
- **Floats for money** — and hardcoding 2 decimal places for every currency.
- Trusting **webhooks as the only source of truth** (no polling, no reconciliation).
- Forgetting **refunds need their own idempotency keys** — and no `Σ refunds <= captured` invariant.
- Deduping at the **API gateway** instead of transactionally in the database.
- **Editing or deleting ledger entries** to "fix" a bug instead of appending reversing entries.
- **Capturing at authorization time** for physical goods you haven't shipped.
- **No reconciliation at all** — and no alert on the reconciliation job *failing to run*.
- Calling the PSP **before** persisting a local intent, making an orphaned charge unrecoverable.
- Letting the provider's status strings become your **domain state machine**.
- Paying out from a **single balance** that includes provisional funds.
- Optimistically rendering **"payment successful"** on the client before the server confirms.
- Forgetting **session-replay / error-reporting scripts** can capture the card field your code never touched.

