# Deep Dive: Payment System (Stripe / PayPal / Google Pay)

> Each chapter has three depths: 🟢 **Beginner** (analogy + intuition), 🟡 **Senior** (implementation + tradeoffs), 🔴 **Architect** (scale, failure modes, production reality).
> This topic **owns** money-correctness depth; neighbours are cross-linked, not repeated: [distributed-transactions](../distributed-transactions/) (saga/2PC mechanics), [message-queues](../message-queues/) (outbox, at-least-once, DLQ), [e-commerce](../e-commerce/) (the checkout leg that calls this), [seat-reservation](../seat-reservation/) (payment inside a booking saga), [api-design](../api-design/) (idempotency as a contract), [observability](../observability/), [sharding-replication](../sharding-replication/), [storage-engines](../storage-engines/) (append-only + snapshot).
>
> **Accuracy note:** scale figures are order-of-magnitude planning numbers to **verify**. Provider behaviors (Stripe/Adyen/PayPal) are described generically — **verify against current provider docs**; never quote internal architectures as fact. Compliance, regulatory, and accounting content is directional and marked **verify** — it is **not legal or accounting advice**. Double-entry bookkeeping itself is standard, centuries-old accounting practice and is safe to assert. Accounting convention used throughout: **assets increase with a debit (DR); liabilities, equity, and revenue increase with a credit (CR)**.

## Table of Contents

1. Why Money Is Different — The Two Halves
2. The Payment Flow & The PSP Boundary
3. Idempotency & Exactly-Once
4. Never Trust A Timeout
5. The Double-Entry Ledger
6. Webhooks, Retries & Reconciliation
7. Money Flowing Backwards
8. Scale, Security & Compliance
9. Frontend Architecture
10. Failure Modes
11. Real-World Case Notes
12. Quick Recall Cheat Sheet

---

## 1. Why Money Is Different — The Two Halves

### 🟢 Beginner — Your own notebook vs the bank's word

Imagine you keep a notebook of every pound that moves through your shop. You control that notebook completely: you can rule it neatly, never cross anything out, and add every entry twice (once for where the money came from, once for where it went) so the two columns always match. That notebook is *yours* and you can make it perfect.

Now imagine the actual money is held by a bank across town that you can only reach by telephone. Sometimes the line drops mid-sentence and you don't know whether they heard you. Sometimes they call back twice about the same thing. Sometimes they call three hours late. You cannot make the bank reliable — so instead you keep your notebook perfect, you're careful on the phone, and once a day you compare your notebook against the bank's statement. That daily comparison is the only reason you can ever be *sure*.

### 🟡 Senior — Two halves, two failure models

| | **Inside your boundary** | **Outside your boundary** |
|---|---|---|
| Control | Total (your DB, your transactions) | None (a third party) |
| Consistency | **Strong** — one ACID transaction | **Eventual**, and only probabilistically knowable |
| Failure mode | Crash/rollback — clean and atomic | Timeout, duplicate, out-of-order, silent success |
| Posture | Maximally **strict** | Maximally **defensive** |
| Truth mechanism | Invariants (`Σ DR = Σ CR`) | **Reconciliation** |

Four properties of money drive all of it: it is **conserved** (so record balanced pairs), **effectively irreversible** (so append corrections rather than editing), **externally audited** (so every cent needs provenance), and **authoritatively owned by someone else** (so unknowns must be represented, not guessed).

### 🔴 Architect — The scaling shape is inverted

Most systems at this level are throughput problems. This one isn't. At ~10M payments/day you're at roughly **115/s average and ~1K/s peak** (order-of-magnitude — verify), which a single well-indexed SQL primary handles comfortably. The ledger multiplies that by ~4–8 entries per payment, so ~4–8K writes/s at peak — still not exotic.

The binding constraint is **correctness and external agreement**. You are not buying throughput; you are buying certainty. That inverts the usual instincts:

```text
Normal system:   optimize hot path, denormalize, cache aggressively, eventual consistency OK
Payment system:  serialize on the money path, normalize into immutable entries,
                 NEVER cache authorization decisions, strong consistency where money moves

Storage is the second-order concern: ~12 GB/day of entries → ~4–5 TB/yr, APPEND-ONLY,
retained for years. That's a partitioning + archival problem, not a scaling wall.
```

The failure that actually hurts is not an outage — it's a **wrong number that looks right**, discovered weeks later by an auditor or a customer. Outages are visible and recoverable; silent financial corruption is neither.

---

## 2. The Payment Flow & The PSP Boundary

### 🟢 Beginner — A hotel hold, then the actual charge

When you check into a hotel they don't take your money — they put a **hold** on your card proving the funds exist. If you leave early, the hold quietly disappears and you were never charged. If you stay, they convert the hold into a real charge when you check out.

Payments work the same way, and the vocabulary matters: *authorize* is the hold, *capture* is the real charge, and *settle* is when money genuinely lands in the bank days later. Cancelling before the charge (a **void**) is free and invisible. Giving money back after the charge (a **refund**) is a whole new payment running backwards, and it costs fees.

### 🟡 Senior — The boundary and the abstraction

```text
SYNCHRONOUS (customer waiting):
  card → PSP iframe → TOKEN  (card never touches you)
  POST /payment_intents (Idempotency-Key) → intent row COMMITTED  ← local record exists
  risk check → PSP authorize(token, idem_key) → issuer approves → AUTHORIZED + ledger

ASYNCHRONOUS (customer gone):
  capture → webhook confirmations → SETTLEMENT (T+1..T+3) → RECONCILIATION → payout
```

Your job is **orchestration and bookkeeping**; the issuer and networks move the money. The PSP abstraction keeps their vocabulary out of your domain:

| Keep in your domain | Keep behind the adapter |
|---|---|
| `PaymentIntent`, `Charge`, `Refund`, `Dispute`, `LedgerEntry` | Provider status strings, error codes, webhook signature schemes, settlement file formats |
| Your canonical state machine (Ch. 3 of [answers.md](./answers.md) A11) | The mapping from their statuses to yours |

Run a second provider for outage survival — but know the real costs: **vaulted tokens are generally not portable** between providers (verify), and each provider is a separate reconciliation stream.

### 🔴 Architect — Why the intent must exist before the call

The single most consequential ordering decision in the whole system:

```text
   intent row COMMITTED   →   THEN call the provider

Every possible crash point now leaves a local record to reconcile against.
Without it, "crash after the card was charged, before we persisted" is UNRECOVERABLE
by construction — money moved with no local reference to match it to, leaving only a
manual forensic match on amount and timestamp.
```

This is also why `PaymentIntent` beats a fire-and-forget `charge(card, amount)`: it's the durable idempotency anchor, the resume point for a 3-DS challenge, and the row the eventual outcome attaches to. Tokenization is the other structural decision — the card goes browser→PSP directly, so most of your infrastructure never enters the cardholder-data environment, which is what reduces PCI DSS scope (**verify current PCI DSS requirements; not legal advice**).

---

## 3. Idempotency & Exactly-Once

### 🟢 Beginner — A cloakroom ticket

You hand your coat to a cloakroom and get ticket #42. If you hand over the ticket twice, you don't get two coats — you get *the same coat*, because the ticket identifies one specific act of handing over a coat, not a request to store a coat.

An idempotency key is that ticket. The client makes one up per payment attempt and sends it with every retry. The server promises: *for this ticket, at most one charge exists, and asking again returns the same answer.*

### 🟡 Senior — The constraint must be in the transaction

```sql
CREATE TABLE idempotency_records (
  idem_key      text PRIMARY KEY,   -- the guarantee lives HERE
  request_hash  text NOT NULL,      -- fingerprint of the body
  state         text NOT NULL,      -- IN_FLIGHT | COMPLETED
  response_code int,
  response_body jsonb,              -- stored so a replay is IDENTICAL
  ...
);
```

```text
BEGIN
  INSERT (K, IN_FLIGHT) ON CONFLICT (idem_key) DO NOTHING
  → 1 row = winner; 0 rows = loser (see below)
  INSERT intent row, linked to K
COMMIT                            ← key reserved ATOMICALLY with the local record
  call the provider with the SAME K   ← outside the txn; never hold a txn on a network call
BEGIN; outcome + ledger entries; state=COMPLETED + store response; COMMIT
```

The loser's behavior is the actual double-charge guard: it reads the record, and if `state = IN_FLIGHT` it **does not call the provider** — it returns `409 "in progress"`. If `COMPLETED`, it replays the **stored response**. Three details carry the guarantee: the DB arbitrates the race, `IN_FLIGHT` prevents a second provider call, and the response is stored rather than recomputed.

On a **body mismatch** (same key, different amount), return `422`. Silently returning the stored response is the dangerous option because nothing looks wrong — the caller gets a success for an amount they didn't request.

### 🔴 Architect — Why the edge can't do this

| Gateway/cache dedupe | Database dedupe |
|---|---|
| Not atomic with the money write | Same transaction as the effect |
| TTL eviction → a late retry double-charges | Durable |
| Two concurrent requests can both miss | `UNIQUE` serializes them |
| Cache says "seen" but the service crashed pre-commit → payment **silently lost** | State is truthful |

Use the gateway as a cheap first filter, never as the guarantee. Scope keys as `(account_id, endpoint, idem_key)` so a key on `/refunds` can't collide with one on `/payment_intents` and tenants can't collide at all. Retain for a window comfortably exceeding your clients' retry horizon (~days, not hours); expiring the *dedupe record* is fine, but the payment and ledger history it guarded is permanent.

---

## 4. Never Trust A Timeout

### 🟢 Beginner — The letter you're not sure you posted

You post a cheque and hear nothing. Did it arrive? You genuinely don't know. Writing a second cheque risks paying twice. Assuming it never arrived risks the recipient having been paid while you treat them as unpaid. The only sane move is to **ask** — check whether the first cheque cleared — and until you know, treat it as *unresolved* rather than pretending you know.

### 🟡 Senior — Three live possibilities

```text
A timeout means ALL THREE are still possible:
  (a) never arrived           → no charge
  (b) arrived and SUCCEEDED   → CHARGED, response lost
  (c) arrived and failed      → not charged
You cannot distinguish these locally. Ever.

❌ retry with a NEW key  → case (b) double-charges
❌ mark FAILED           → case (b) means charged-and-nothing-delivered
❌ hang                  → the user retries by hand; now you have an uncontrolled duplicate

✅ 1. Retry with the SAME idempotency key.
      Providers honor idempotency keys, so if (b) happened the provider returns the
      ORIGINAL result rather than charging again. Bounded retries, backoff + jitter.
✅ 2. Still unknown? QUERY the provider by your key/reference.
✅ 3. Still unknown? state = INDETERMINATE. Tell the customer "we're confirming your
      payment" — never "failed", never "succeeded". Webhooks or reconciliation resolve it.
✅ 4. Alert if it ages past SLA.
```

### 🔴 Architect — Ambiguity needs somewhere to live

The reason teams get this wrong isn't ignorance of retries — it's that their **schema has no state for "unknown."** When the only options are `SUCCEEDED` and `FAILED`, ambiguity gets coerced into one of them, and the coercion is the bug. Making `INDETERMINATE` a first-class persisted state is what lets the correct behavior exist at all.

It also demands three independent resolution paths, because any one of them can fail:

```text
1. SWEEPER   — query the provider for every non-terminal payment older than N minutes
2. WEBHOOK   — the provider tells you (fast, unreliable)
3. RECONCILE — the settlement file tells you (slow, authoritative)

All three converge on the same repair, and the repair is IDEMPOTENT (keyed by
intent/charge id), so it doesn't matter which one wins — a property you must design for
deliberately, or the three paths fight each other and double-apply.
```

The same rule applies on the client (Ch. 9): a dropped connection after "Pay" is evidence about the *network*, not about the money. **Only the server may declare failure.**

---

## 5. The Double-Entry Ledger

### 🟢 Beginner — Every pound comes from somewhere

Double-entry is a 500-year-old idea: you never write down that money *appeared*. You write down where it came **from** and where it went **to**, as two matching halves. If the two halves don't match, you know immediately you've made a mistake — you don't have to hunt for it, the arithmetic tells you.

That's the whole trick. A single running total can be silently wrong forever. A pair that must balance **announces** its own errors.

### 🟡 Senior — Balanced pairs, append-only, integers

A $100 capture with a $3 platform fee:

| Account | Type | DR | CR |
|---|---|---:|---:|
| `psp_receivable` | Asset | **10000** | |
| `merchant_payable:m_42` | Liability | | **9700** |
| `platform_fee_revenue` | Revenue | | **300** |
| **Totals** | | **10000** | **10000** |

Balances ✅. Fees get their own account so you can report on them and reconcile the provider's *actual* fee against your *expected* fee (a real mismatch class, Ch. 6).

```text
IMMUTABILITY, enforced by permissions not convention:
  REVOKE UPDATE, DELETE ON ledger_entries FROM app_role;   -- INSERT only
  (and no updated_at column exists at all — there is nothing to update)

⇒ a correction, a reversal, and a refund are all NEW appended transactions in the
  opposite direction. The originals remain; the net effect is correct; the history
  shows BOTH what happened and that it was undone. That is what an auditor needs.

MONEY REPRESENTATION:
  integer MINOR UNITS + explicit currency. Never binary floats (0.1 + 0.2 != 0.3).
  Decimal places are a property of the CURRENCY (USD 2, JPY 0) — never hardcode 2.
  Splitting $100 three ways: 3334 + 3333 + 3333 = 10000 exactly.
  Naive rounding gives 9999 → a vanished cent → an unbalanced ledger.
```

### 🔴 Architect — Balances are derived, and drift must be checked

```text
balance(account, now) = snapshot(account, T) + fold(entries WHERE ts > T)
                        ▲
                        └─ the same checkpoint+log idea as ../storage-engines/

The entries are the ONLY source of truth. Snapshots and materialized balances are
derived data that can always be rebuilt.
```

The non-negotiable companion is a **drift checker** that re-folds from scratch and compares. Materializing without one reintroduces exactly the silent wrongness of a `balances` table while giving you the false comfort of having "a ledger."

```text
INVARIANTS asserted continuously:
  I1 per txn: Σ DR = Σ CR          I4 materialized balance = fold(entries)
  I2 globally: Σ DR − Σ CR = 0     I5 accounts that must not go negative, don't
  I3 no UPDATE/DELETE ever         I6 currency purity   I7 Σ refunds ≤ captured

ON VIOLATION: alert (page) → quarantine the account/flow → reconcile against the
provider for ground truth → append adjusting entries.
❌ NEVER auto-correct blindly. A wrong automated "fix" launders the bug into the
   permanent record and destroys the evidence of the original error.
```

Note the precise claim about I1: if a bug duplicates **both** legs, `Σ DR = Σ CR` still passes. The detection for that case is **I4 (drift)** and **reconciliation**, not I1 — which is why you need all of them rather than one favourite.

---

## 6. Webhooks, Retries & Reconciliation

### 🟢 Beginner — A phone call vs the monthly statement

The bank phoning to say "that payment went through" is fast and useful — but calls get dropped, come twice, or arrive hours late. The monthly statement is slow but authoritative. You'd never run a business on phone calls alone, and you'd never wait a month to know anything. You use both: the call for speed, the statement for truth.

### 🟡 Senior — Verify, dedupe, 200 fast, process async

```text
1. READ THE RAW BODY (bytes, unparsed)
2. VERIFY HMAC(timestamp + raw body), constant-time — BEFORE parsing.
   Never deserialize untrusted input into your domain before authenticating it.
3. CHECK TIMESTAMP FRESHNESS (~5 min) — a signature alone does NOT stop replay.
4. DEDUPE: INSERT provider_event_id ON CONFLICT DO NOTHING (UNIQUE, not a cache)
5. ENQUEUE; 6. RETURN 200 IMMEDIATELY
   (providers time out and retry aggressively — slow handlers CAUSE duplicates)
```

| Hazard | Handling |
|---|---|
| Duplicates | `UNIQUE(provider_event_id)`, transactional |
| Out-of-order (`captured` before `authorized`) | Drive state from the event's own **state/version**, not arrival order; reject illegal transitions |
| Webhook for an **unknown object** | Never silently drop — persist as unmatched, alert, reconcile. This is the orphan signature from Ch. 4 |
| Poison event | Retry with backoff → DLQ + alert ([message-queues](../message-queues/)) |

**Webhooks are a latency optimization, not a source of truth.** The design rule: *the system must reach the correct state even if every webhook is lost.* Pair them with provider polling and daily reconciliation.

### 🔴 Architect — Three-way reconciliation and the false-positive trap

```text
YOUR LEDGER  ↔  PSP SETTLEMENT FILE  ↔  BANK STATEMENT
(what we think)  (what they say)        (what actually landed)

Two records can agree and both be wrong about cash. Three-way catches that.
```

| Mismatch class | Cause |
|---|---|
| In PSP, not in ledger | The Ch. 4 crash; lost webhook; integration bug |
| In ledger, not in PSP | Recorded optimistically before confirmation |
| Amount / fee / FX mismatch | Partial capture; stale fee model; rate applied differently |
| Duplicate | An idempotency failure |
| **Timing / cut-off** ⚠️ | **The most common false positive** — a payment near the settlement cut-off lands in the *next* window. Always recheck across an overlapping window before declaring a discrepancy |

Remediation in both directions is an **adjusting entry with provenance** (`reason='reconciliation'`, settlement file + row reference), never an edit — and confirmed discrepancies require **human review**, because auto-adjusting on a guess converts a detection into a permanent falsification.

Two operational details that separate a real system from a diagram: **alert on the reconciliation job failing to run** (a dead checker looks exactly like "no problems"), and track **days-to-resolve** per discrepancy so aging items escalate.

For delayed methods (ACH/SEPA/BNPL), success is **provisional and reversible for days** — which forces a `SUBMITTED` state that is not `CAPTURED`, a **pending vs available** balance split, and an explicit clawback path.

---

## 7. Money Flowing Backwards

### 🟢 Beginner — Giving money back, willingly or not

There are two ways money goes back to a customer. You can **choose** to return it (a refund) — your decision, your timing. Or the customer's bank can **take it back** without asking you (a chargeback) — their timing, their decision, and you have a deadline to argue your case or you automatically lose.

The second one is worse in every dimension, which is why keeping customers happy enough to ask *you* first is a genuine engineering concern, not just a business one.

### 🟡 Senior — The invariant and the lifecycle

```sql
-- Σ refunds(charge) ≤ captured(charge), enforced ATOMICALLY
BEGIN;
  SELECT captured_minor, refunded_minor FROM charges WHERE id=:c FOR UPDATE;
  UPDATE charges SET refunded_minor = refunded_minor + :amt
   WHERE id=:c AND refunded_minor + :amt <= captured_minor;   -- 0 rows ⇒ reject 422
  INSERT INTO refunds (...);  -- + ledger entries, same txn
COMMIT;
```

Without `FOR UPDATE` (or an equivalent guard), two concurrent partial refunds each read a stale `refunded_minor`, both pass, and together over-refund. **Refunds also need their own idempotency keys** — the most commonly forgotten guard, because refunding twice produces a *happy, silent* customer, so you find out at reconciliation rather than from a complaint.

| | Refund | Chargeback |
|---|---|---|
| Initiated by | You, voluntarily | The **issuer**, forcibly |
| Your consent | Required | **Not required** |
| Deadline | None | **Hard** — miss it and lose automatically |
| Cost | Processing fees | Amount + dispute fee + rate exposure |

Debit the ledger **when the dispute opens** (the money is genuinely gone now), track `deadline_at` with alerting, store evidence immutably, and reverse on WON with new entries.

### 🔴 Architect — Payouts, attribution, and provisional funds

```text
available = Σ settled credits − debits − holds/reserves − pending reversals
            ▲
            └─ NOT pending. Paying out provisional funds is an unsecured loan
               you never decided to make.

Payout state machine: PENDING → SUBMITTED → PAID
                                    ├─▶ FAILED
                                    └─▶ RETURNED (possibly DAYS later)
On FAILED/RETURNED: append reversing entries, RESTORE the merchant's available balance,
flag for correction. Treating SUBMITTED as PAID is the trap.
```

For a marketplace, attribute each seller's share **and their fee at capture time** — that's what makes a later partial refund chargeable to exactly the right seller without touching the others. And make the fee-refund policy explicit (does the platform give its fee back, or keep it?), because it decides who absorbs the loss; it must be a stated business decision, not an accounting accident.

---

## 8. Scale, Security & Compliance

### 🟢 Beginner — A ledger you only ever add to

Because you never cross anything out, the notebook only grows. That sounds like a problem, but it's actually easier to manage than a single tally you're constantly erasing and rewriting: many people can add pages at once without fighting over the same line, and old volumes go into the archive without being destroyed.

### 🟡 Senior — Why append-only shards better

| | Mutable `balances` table | Append-only ledger |
|---|---|---|
| Concurrency | Every payment for merchant M contends on **the same row** | Every payment **inserts new rows** — no shared-state contention |
| Big merchant | A hotspot you cannot shard away (one row can't be split) | Distributes naturally |
| Archival | Mass `DELETE` | **Partition drop** |
| Cost moves to | — | **Reads** (balance = fold) → solved by snapshot+delta (Ch. 5) |

Shard by `account_id` with time-partitioning inside. Two hard constraints shape everything: the idempotency `UNIQUE` must live in the **same shard** as the write it guards, and **both legs of a transaction must be co-located** or `Σ DR = Σ CR` needs a distributed transaction. Cross-account reporting goes to a separate OLAP copy.

**Compliance** (directional — **verify**; not legal advice): tokenization is the dominant lever because it keeps cardholder data out of scope entirely; the rest is segmentation, TLS + encryption at rest (including **backups and log exports** — the commonly-missed copies), KMS/HSM key management with rotation, immutable audit logging, least privilege (insert-only on the ledger), data residency, and PII minimization.

### 🔴 Architect — The fraud asymmetry and FX

Risk runs **synchronously before the provider call** on a tight budget (~tens to low-hundreds of ms inside a ~1–3s auth — illustrative, verify): cheap deterministic velocity rules first, then an ML score, with **3-DS step-up** as the middle path that saves good customers. Fail-open vs fail-closed on a risk-service outage is an explicit business decision.

```text
THE ASYMMETRY that mis-tunes most systems:

  FALSE DECLINE  — blocked a good customer.
     Cost: lost sale + lifetime value. INVISIBLE in your metrics (looks like success!)
     Usually the LARGER total cost at scale.
  FALSE ACCEPT   — approved fraud.
     Cost: amount + dispute fee + rate exposure. HIGHLY VISIBLE (a chargeback).

⇒ Optimizing on "fraud loss" alone systematically OVER-BLOCKS, because one side is
  measured and the other isn't. Track decline rate and false-decline proxies too.
```

For **multi-currency**, capture and store the FX rate (with source and timestamp) **at quote time** — never re-derive a historical rate, or the charge becomes unreproducible and the difference silently becomes a reconciliation gap. Recognize the settlement difference in an explicit **FX gain/loss** account rather than hiding it in the receivable.

The SLI that matters most: **unreconciled money / ledger imbalance must be zero.** Everything else is a rate you tune; this is a boolean, and it pages.

---

## 9. Frontend Architecture

### 🟢 Beginner — Let someone else hold the card

The safest way to handle a card number is to never touch it. The payment provider supplies a small window (an iframe) that sits inside your page but belongs to *them*. The customer types into their window, the number goes straight to them, and you get back a harmless token. Your code never sees the card — not because you're careful, but because the browser physically won't let you reach into someone else's window.

### 🟡 Senior — The boundary is the browser's, not yours

```text
  ┌─ your page ─────────────────────────────────┐
  │  your JS                                     │
  │  ┌─────────────────────────────┐             │
  │  │ PSP IFRAME (different ORIGIN)│ ← same-origin policy is the
  │  │  <input> card number         │   SECURITY BOUNDARY
  │  └──────────┬──────────────────┘             │
  └─────────────┼────────────────────────────────┘
                ▼ direct browser → PSP
          tokenization → token → your JS → your API
```

Never let a PAN reach your JS variables, your state store (persistence middleware may write it to `localStorage`), your server, or your logs.

```text
⚠️ THE LEAK EVERYONE MISSES: third-party scripts on the checkout page.
   SESSION REPLAY, ERROR REPORTING, and auto-capture ANALYTICS can record a card field
   even though YOUR code never reads it.
   ⇒ mask/block payment fields in every such tool, audit the script inventory on the
     checkout route, apply a strict CSP, and ideally load NO third-party scripts on the
     payment step. Hosted fields help structurally: a replay script in YOUR page cannot
     reach into a cross-origin iframe.
```

Mint **one idempotency key per checkout attempt**, persisted in `sessionStorage` so refresh and back-button reuse it. The disabled submit button is UX; the guarantee is the server's `UNIQUE`.

### 🔴 Architect — Redirects, unknowns, and honest UI

For **3-DS/SCA**, persist the resume context (`intent_id`, idempotency key, cart snapshot) **server-side** before redirecting — the customer may return in a different tab, session, or device where `sessionStorage` is gone. On return you **look the intent up**, never start a new payment, and treat "already resolved by webhook" as the normal case. If they never return, the payment is an **unknown** resolved by webhook + reconciliation, not a failure.

```text
THE RULE for optimistic UI on a money path:
  ✅ You MAY optimistically render INTENT.      "Submitting payment…"  (reversible)
  ❌ You MUST NOT optimistically render SETTLEMENT.  "Payment successful"

  Elsewhere, a wrong optimistic update costs a flicker. Here it costs trust: the user
  closes the tab, expects goods, and tells their bank they paid. Rolling that back is
  not a UI correction — it is a broken promise, and sometimes a chargeback.
```

A dropped connection after Pay shows **"confirming your payment"** and re-queries by key with backoff — never a resubmit, never a failure message. And expose **pending vs available** balance to merchants explicitly; a single number invites them to spend money that can still reverse.

---

## 10. Failure Modes

### 🔴 Provider call times out
- **Symptom:** no response; charged-or-not is genuinely unknown.
- **Guard:** retry with the **same** idempotency key (providers honor it, so it can't double-charge) → query by key → park in `INDETERMINATE` → resolve via webhook/reconciliation → alert past SLA. Never coerce to success or failure.

### 🔴 Crash after the provider charged, before you persisted
- **Symptom:** customer's money gone; you have an intent in `CREATED` and no outcome.
- **Guard:** survivable **only** because the intent was committed before the call. Three converging paths find it — a stale-state sweeper querying by key, the webhook, and reconciliation — and the repair is idempotent so it doesn't matter which wins.

### 🔴 Duplicate webhook double-applies a balance change
- **Symptom:** a merchant balance increments twice for one payment.
- **Guard:** `UNIQUE(provider_event_id)`; and in the consumer, the dedupe marker `(event_id, consumer_name)` committed **in the same transaction as the effect**, acked only after commit. Better: make the effect an append keyed by the source event so idempotency is structural.

### 🔴 Lost webhook leaves a payment stuck
- **Symptom:** customer paid; nothing was fulfilled; state never advanced.
- **Guard:** never depend on webhooks alone — a sweeper polls non-terminal payments and reconciliation catches the rest. Design target: **correct even if every webhook is lost.**

### 🔴 Double-write bug creates phantom ledger money
- **Symptom:** balances inflated. Note `Σ DR = Σ CR` can still pass if **both** legs duplicated — detection comes from **drift (I4)** and reconciliation.
- **Guard:** **freeze payouts/withdrawals first** (don't let inflated balances be cashed out — that converts a fixable ledger bug into unrecoverable cash loss), quantify via re-fold + provider reconciliation, then **append reversing entries** referencing the incident. Never delete or edit; that destroys the audit trail and makes the incident unprovable.

### 🔴 Over-refund via concurrent partial refunds
- **Symptom:** total refunded exceeds captured.
- **Guard:** row-locked guarded update asserting `Σ refunds + amount ≤ captured` **in-transaction**, plus idempotency keys on the refund endpoint. The invariant is the stronger guard because it also holds against buggy jobs and manual admin actions.

### 🔴 Payout against provisional funds that later reverse
- **Symptom:** an ACH return lands days after you paid the merchant; the money is gone.
- **Guard:** **pending vs available** balance split; payouts draw only on settled funds; holds/reserves for risk; an explicit clawback path (which may drive a balance negative into a collections problem). Early release must be a priced credit decision, not a data-model accident.

### 🔴 Provider outage and the failover double-charge
- **Symptom:** you fail over to PSP B and the customer is charged twice.
- **Guard:** your idempotency key is **not honored across providers**, and vaulted tokens are generally **not portable** (verify). Fail over **only** on a definitively not-processed error (connection refused, DNS failure, explicit pre-processing 5xx) — **never on a timeout**, which is an unknown.

---

## 11. Real-World Case Notes

> Public/standard practice where possible; anything provider-specific is marked **verify**. Do **not** quote internal architectures of Stripe/PayPal/Adyen as fact.

- **Double-entry bookkeeping** — genuinely safe to assert: standard accounting practice for centuries, and the reason financial systems can prove correctness rather than assert it. Its adoption in software ledgers is conventional, not novel.
- **Idempotency keys are a standard PSP API feature.** Major providers expose an idempotency mechanism on mutating requests, which is precisely what makes "retry with the same key" the correct timeout handling. **Verify the exact header name, semantics, and retention window per provider** — do not fabricate parameter names.
- **Signed webhooks are standard practice.** HMAC over the raw body with a timestamp to prevent replay is the common pattern across providers. Exact header formats and tolerances differ — **verify**.
- **Settlement-file reconciliation is standard industry practice.** Daily settlement reports over SFTP/S3 are how platforms verify their books against the provider. Formats are provider-specific — **verify**.
- **Authorize-then-capture** is the normal integration pattern for physical goods (capture on ship), and **void vs refund** is a real, universally-supported distinction — not a vendor quirk.
- **Tokenization / hosted fields for PCI scope reduction** is the standard architecture. The specific PCI DSS level, SAQ type, and requirement numbers **change over time — verify against the current standard and your acquirer**. Nothing here is legal or compliance advice.
- **Regulatory posture when holding funds** (money transmission, e-money, safeguarding, KYC/AML) is jurisdiction-specific, changes, and is a **legal** design constraint — involve counsel before designing. Not legal advice.
- **This topic owns the payment depth** that [e-commerce](../e-commerce/) (checkout leg) and [seat-reservation](../seat-reservation/) (payment inside a booking saga) explicitly defer here, and it applies the saga/outbox mechanics from [distributed-transactions](../distributed-transactions/) and [message-queues](../message-queues/) to money.

---

## 12. Quick Recall Cheat Sheet

```text
CENTRAL SPLIT
  INSIDE  exact · auditable · strongly consistent  (you control it)
  OUTSIDE unreliable · async · only eventually knowable (a third party)
  ⇒ exact inside, defensive at the boundary, continuously reconciled
  ⇒ COROLLARY: NEVER TRUST A TIMEOUT — a timeout is an UNKNOWN, not a failure
  Money is: conserved · effectively irreversible · externally audited · externally owned
  Scale is INVERTED: ~1K payments/s is easy; CORRECTNESS is the binding constraint

FLOW
  authorize = funds HELD (nothing moved)    capture = sale committed
  settle    = funds actually transfer T+1..T+3, net of fees
  VOID   = pre-capture, no money ever moved, free, invisible
  REFUND = post-capture, a NEW opposite movement, costs fees, visible — NOT an undo
  Issuer + networks MOVE the money; you ORCHESTRATE and RECORD
  Intent row COMMITTED BEFORE the provider call ⇒ every crash leaves a local record

IDEMPOTENCY
  UNIQUE(idem_key) committed IN THE SAME TXN as the payment record + STORE the response
  IN_FLIGHT state ⇒ the loser NEVER calls the provider (the real double-charge guard)
  same key + different body ⇒ 422 (never silently return the stored response)
  scope (account, endpoint, key); retain > client retry horizon (~days)
  ❌ gateway/cache dedupe: not transactional — eviction, concurrent miss, crash-after-cache

TIMEOUT
  3 live possibilities: never arrived · SUCCEEDED · failed
  ✅ retry SAME key (provider returns original) → query by key → INDETERMINATE → webhook/recon
  ❌ new-key retry = double charge   ❌ mark FAILED = charged-and-nothing-delivered
  Only the SERVER may declare failure (client too — Ch. 9)

LEDGER (assets ↑ = DR; liabilities/revenue ↑ = CR)
  every txn: Σ DR = Σ CR    globally: Σ DR − Σ CR = 0
  APPEND-ONLY enforced by DB permissions (REVOKE UPDATE, DELETE)
  corrections/refunds = NEW reversing entries; originals REMAIN
  integer MINOR UNITS + explicit currency; never floats; decimals are per-currency
  splits must sum EXACTLY (3334+3333+3333); a vanished cent = an unbalanced ledger
  balance = snapshot + fold(since); materialized ⇒ MUST have a drift checker
  both legs duplicated? I1 still passes → detected by I4 drift + reconciliation
  ON VIOLATION: alert → quarantine → reconcile → append adjustment. NEVER auto-correct

WEBHOOKS + RECONCILIATION
  verify HMAC(timestamp + RAW body) BEFORE parsing; freshness check stops replay
  dedupe UNIQUE(provider_event_id); 200 FAST then async (slow handlers CAUSE duplicates)
  out-of-order ⇒ drive from the EVENT's state/version, not arrival order
  unknown object ⇒ never drop; persist + alert + reconcile
  webhooks = LATENCY OPTIMIZATION, not truth. Correct even if ALL webhooks are lost
  3-WAY reconcile: ledger ↔ settlement file ↔ bank
  mismatch classes: missing-either-side · amount · fee · FX · duplicate · TIMING CUT-OFF
    (cut-off = the most common FALSE POSITIVE — recheck the next window first)
  remediation = adjusting entry WITH PROVENANCE + human review. Alert if the job DIDN'T RUN
  ACH/SEPA/BNPL: success is PROVISIONAL and reversible for days ⇒ pending vs available

BACKWARDS
  Σ refunds ≤ captured, row-locked guarded UPDATE (concurrent partials over-refund otherwise)
  REFUNDS NEED THEIR OWN IDEMPOTENCY KEYS (most-forgotten — a double refund is SILENT)
  chargeback = issuer-initiated, forcible, no consent, HARD deadline (miss = auto-loss)
    ⇒ debit the ledger when the dispute OPENS; alert on deadline_at; evidence immutable
  payouts from AVAILABLE only; SUBMITTED ≠ PAID; RETURNED ⇒ reverse + restore balance
  marketplace: attribute seller share + fee AT CAPTURE ⇒ later refund hits the right seller
    fee-refund policy (give back vs keep) is an EXPLICIT business decision

SCALE / SECURITY
  append-only shards better than a mutable balances row (no shared-row contention)
  idempotency UNIQUE must be in the SAME SHARD; both txn legs CO-LOCATED
  tokenization = the dominant PCI scope-reduction lever (verify current PCI DSS)
  encrypt at rest INCLUDING backups + log exports; KMS/HSM + rotation; insert-only role
  risk: velocity rules → ML score → 3-DS step-up; fail-open vs fail-closed is a decision
  ASYMMETRY: false DECLINE is invisible and usually costlier than visible fraud loss
  FX: capture + STORE the rate AT QUOTE TIME; FX gain/loss gets its OWN account
  SLI that must be ZERO: unreconciled money / ledger imbalance (page on it)

FRONTEND
  card: browser → PSP iframe (CROSS-ORIGIN = the real boundary) → token only
  ⚠ session-replay / error-reporting / auto-capture analytics can grab the field
    your code never touched → mask, audit scripts, strict CSP
  ONE idempotency key per checkout attempt, in sessionStorage (survives refresh/back)
  3-DS: persist resume context SERVER-SIDE before redirect (different tab/device!)
        on return, LOOK UP — never re-charge; "already resolved" is NORMAL
        never returns ⇒ UNKNOWN, resolved by webhook/recon — not a failure
  network drop after Pay ⇒ "confirming your payment…" + re-query by key. NEVER resubmit
  ✅ optimistically render INTENT   ❌ NEVER optimistically render SETTLEMENT
  expose PENDING vs AVAILABLE to merchants explicitly
```

---

## 🔁 Redundancy & Replication — how *this* system does it

> Expands this system's row in the [Redundancy & Replication use-case matrix](../../fundamentals/Use_Cases_for_Redundancy_and_Replication.md) · concept depth: [key-technologies-notes.md §12](../../key-technologies-notes.md) + [sharding-replication](../sharding-replication/). ⚠️ Tech names are illustrative — verify against primary sources.

- **Pattern:** single-leader with **synchronous or semi-synchronous commit** for the double-entry ledger (§5). Because the ledger is **append-only and immutable**, replicas can be verified against the leader cheaply (compare running balances or a hash chain) — divergence is detectable rather than silent.
- **Mode:** **synchronous. RPO = 0, non-negotiable.** `acks` from at least one replica before the client is told the payment succeeded.
- **Why here:** *"if you can afford to lose it, it isn't money."* The counterintuitive part — and the strongest thing to say in an interview — is that **RTO is deliberately looser than RPO**. In most systems you promote a replica fast to minimize downtime; in a payment system, **promoting a lagging replica is worse than staying down**, because it silently loses committed transactions and creates an unreconcilable ledger. So failover here is careful, often gated on a durability check or a human, and the business accepts minutes of declined payments to avoid a single unaccounted cent. The other consequence worth naming: the **idempotency store must be as durable as the ledger** (§3) — replicating the ledger while leaving retry-protection state on an evictable single node just moves the double-charge risk rather than removing it.

---

## 🗄️ Caching Strategy — how *this* system does it

> Expands this system's row in the [Caching use-case matrix](../../fundamentals/Use_Cases_for_Caching.md) (§2b, idempotency-key store) · concept depth: [key-technologies-notes.md §22](../../key-technologies-notes.md) + [distributed-caching](../distributed-caching/). ⚠️ Tech names are illustrative — verify against primary sources.

- **Layers:** deliberately minimal — and the point of this section is to say **what is excluded**. Redis holds the **idempotency-key store** (§3) and velocity/fraud counters; read-only caches hold merchant configuration, BIN/card-metadata, and FX rates. That's the entire list.
- **Strategy:** **the ledger is never cached and never read from a replica to make a write decision** (§5). Balance is derived from the append-only entries under the authoritative read path, because a stale balance authorizes a payment that shouldn't exist. Merchant config and BIN data are cache-aside with a long TTL (they change rarely and staleness is harmless). FX rates are short-TTL, and the rate actually used is **stamped onto the transaction** so the price stays auditable after the cache moves on.
- **Invalidation:** idempotency keys carry a TTL of **at least the client's full retry window** (commonly ~24 h) and must be **durable, not evictable**. Merchant config is explicitly purged on change. FX rates expire on a short TTL, but the *recorded* rate on a completed transaction is immutable forever.
- **Why here:** the shortest version is *"if you can cache it, it isn't money."* Naming a cache in a payment design earns points for what you refuse to cache, not for what you do. The critical trap: the idempotency store is **shaped** like a cache and usually lives in the same Redis, which invites someone to set an eviction policy on it — and **an evicted idempotency key is a double charge** (§3, §4). Under `maxmemory` pressure with `allkeys-lru`, Redis will happily evict it to make room for a BIN lookup. That's a one-line config mistake with a financial-loss blast radius, which is exactly the sort of failure mode §10 exists to enumerate. Keep correctness state in a separate instance or namespace with `noeviction`, and treat it as a durable store that happens to be fast.
