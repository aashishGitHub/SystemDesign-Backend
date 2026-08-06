# System Design: Payment System (Stripe / PayPal / Google Pay)

> **Target:** Senior / Staff engineers (Stripe, PayPal, Amazon, Uber, Adyen, and any team that touches money).
> **Style:** Interview-grill format — question first, then defended design choices.
> **Framing:** This topic **owns the money-correctness depth** that [e-commerce](../e-commerce/) and [seat-reservation](../seat-reservation/) deliberately defer to it. They cover *when* to charge; this covers *how to be certain what happened to the money*.

---

## How to Use This Guide

1. Skim [simple-diagram.md](./simple-diagram.md) first — it names the **central split** (internal ledger truth vs external PSP reality) in one screen, plus the six components to remember.
2. Attempt every question in [questions.md](./questions.md) cold before reading answers — 9 levels, worked in order.
3. Check [answers.md](./answers.md) — each answer has a table or code block and ends with a **Key takeaway** you can say under pressure. It closes with a Quick Revision Cheatsheet.
4. Whiteboard from [diagrams.md](./diagrams.md) — start with Diagram 1 (the central split), then drill into whichever layer the interviewer probes.
5. Go deep with [deep-dive.md](./deep-dive.md) — 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, failure modes, and real-world case notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Requirements | Why money is not just another write; the two halves of the system |
| 2 | Core Payment Flow & PSP Integration | Authorize/capture/settle/void/refund; tokenization; never touching a card number |
| 3 | Idempotency & Exactly-Once | The signature problem — a retry must never move money twice |
| 4 | The Ledger (Double-Entry) | Append-only balanced entries; why a `balances` table is a bug waiting to happen |
| 5 | Async Reality: Webhooks & Reconciliation | The external world is unreliable and only *eventually* knowable |
| 6 | Refunds, Payouts, Chargebacks | Money flowing backwards and outwards, sometimes without your consent |
| 7 | Consistency, Correctness & Failure Modes | Saga + outbox; repairing a corrupted ledger without destroying the audit trail |
| 8 | Scale, Security & Compliance | Sharding an append-only ledger; PCI scope reduction; fraud; multi-currency |
| 9 | Frontend Architecture (Architect) | PCI-safe checkout, idempotent submit, 3-DS resume, honest async UI |

---

## Files

| File | Purpose |
|---|---|
| [simple-diagram.md](./simple-diagram.md) | **Start here.** The central split + six components, then a detailed version with real services and protocols. |
| [questions.md](./questions.md) | 50 structured questions (9 levels) + 6 bonus. Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or a comparison table; each ends with a **Key takeaway**; closes with a Quick Revision Cheatsheet. |
| [diagrams.md](./diagrams.md) | Interview-ready Mermaid diagrams (start with Diagram 1 — the central split). |
| [deep-dive.md](./deep-dive.md) | 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, failure modes, real-world case notes. |

---

## Problem Statement

> Design a payment system that lets a platform charge customers, record every movement of money auditably, refund and dispute those charges, and pay out to merchants — while integrating with third-party payment providers you do not control and cannot fully trust.
>
> **POST /payment_intents** (Idempotency-Key) — create intent, then confirm/authorize
> **POST /payment_intents/{id}/capture** — capture an authorized payment
> **POST /refunds** (Idempotency-Key) — full or partial refund
> **GET  /payments/{id}** — current state, including indeterminate/processing
> **POST /webhooks/psp** — signed provider callbacks (verified, deduped)
> **GET  /accounts/{id}/balance** — pending vs available balance
>
> **Key Constraints** *(scale numbers are order-of-magnitude planning figures — verify against your own load):*
> - **Volume:** ~10M payments/day → ~115/s average, with peaks around ~1K/s. Each payment writes **several** ledger entries (charge, fee, payable, FX), so ledger write volume is a multiple of payment volume.
> - **Storage:** the ledger is **append-only and never deleted** — it grows monotonically forever and needs an archival/partitioning strategy, not a retention policy.
> - **Hard guarantees:** **no double-charge** · **no money created or destroyed** · **every cent traceable to a balanced pair of entries** · **no acknowledged payment lost** · eventual agreement with the provider's settled truth.
> - **The metric that must always be zero:** unreconciled money (ledger imbalance / money unaccounted for).
> - **Latency:** authorization in ~1–3s end-to-end including a synchronous risk check with a tight budget (~tens to low-hundreds of ms).
> - **Compliance:** card data must never enter your systems (PCI DSS scope reduction via tokenization) — *verify current PCI DSS requirements; nothing here is legal advice.*

---

## How a Senior Engineer Thinks About This

The first move is to see that a payment system is **two halves with opposite characters**, and to design each to its own rules. *Inside* your boundary you get to be strict, and you should be maximally strict: one idempotency key per attempt enforced by a database constraint, an explicit state machine rather than states implied by control flow, and an append-only double-entry ledger where every movement is a balanced pair of debits and credits that must sum to zero. *Outside* your boundary you get none of that: the provider call times out without telling you whether it charged the card, webhooks arrive twice or out of order or hours late or never, and a response that said "failed" sometimes turns out to have succeeded. So the architecture is **exact inside, defensive at the boundary, and continuously reconciled** — and the reconciliation job is not a nice-to-have back-office batch, it is the only thing that ever proves your system and the provider still agree.

The second insight — and the one that most cleanly separates people who have run payments from people who have only called a payment API — is that **"charge this card" is not a function that returns success or failure. It returns success, failure, or *unknown*, and at scale the unknown case is routine.** A naive design treats a timeout as a failure, which is how you double-charge a customer who then disputes it; or treats it as a success, which is how you ship goods you were never paid for. The correct handling is that a timeout is an *unresolved state*, not an outcome: you retry with the **same** idempotency key (which providers honor, so the retry returns the original result rather than charging again), or you query the provider by that key, and if it is still unknown you park the payment in an explicit `INDETERMINATE`/`PROCESSING` state and let webhooks and reconciliation resolve it. This is also why you write the intent row to your own database *before* you ever call the provider — so that a crash mid-call always leaves a local record to reconcile against, rather than money that moved with no trace on your side.

The third idea is the **double-entry, append-only ledger**, and reaching for it unprompted is the strongest single signal in this interview. The tempting design is a `balances` table updated with `UPDATE balance = balance + amount`. That design is unauditable (history is destroyed on every write), unverifiable (a lost or duplicated update silently corrupts the balance with no way to notice), and unfixable (you cannot reconstruct what happened). Double-entry instead makes accidental money creation **structurally impossible to hide**: because every transaction must balance to zero, an imbalance is a *detectable* invariant violation rather than a silent wrong number, and a continuous checker can prove correctness in production. It also dictates how you repair things — you never `UPDATE` or `DELETE` a ledger entry, even to fix a bug. A correction, a reversal, and a refund are all **new entries appended in the opposite direction**, which is what preserves the audit trail an auditor (and your future self during an incident) actually needs.

Finally, a senior candidate is careful about **representation and finality**, because both are common sources of real financial loss. Money is stored as integer minor units with an explicit currency, never as a float — binary floating point cannot represent `0.10` exactly, so sums drift, and rounding is therefore a correctness decision that must be made explicitly and recorded, not a display concern. And "final" means two different things that must not be conflated: a payment can be **final for the customer** (authorized/captured — they have seen success and received the goods) while still being **provisional for accounting** (not yet settled, not yet reconciled, and for bank debits like ACH/SEPA still reversible days later). Paying out against funds that are merely provisional is exactly how platforms lose money — which is why a single-balance model is wrong and the pending-versus-available distinction is a design requirement, not a UI nicety.

---

## Related Topics

This topic **owns** payment depth; neighbours link *into* it rather than duplicating it:

- **[distributed-transactions](../distributed-transactions/)** — saga vs 2PC, compensating actions, the mechanics this topic applies to money. *The "how do multiple services agree" half.*
- **[message-queues](../message-queues/)** — Kafka, the **transactional outbox**, at-least-once delivery and DLQs; how a captured payment reliably notifies everything downstream.
- **[e-commerce](../e-commerce/)** — the checkout leg that *calls* this system: authorize-then-capture-on-ship, the order saga, cart→order. It defers ledger/PSP/chargeback depth here.
- **[seat-reservation](../seat-reservation/)** — payment as one step inside a booking saga, with the hold-expiry-during-payment race. Also defers payment depth here.
- **[api-design](../api-design/)** — idempotency keys as an API contract, status codes, versioning.
- **[observability](../observability/)** — the funnel and correctness SLIs, and the alert on the one metric that must stay zero.
- **[sharding-replication](../sharding-replication/)** — sharding payments and an append-only ledger; why appends shard more easily than a hot mutable row.
- **[storage-engines](../storage-engines/)** — the append-only-log + periodic-snapshot pattern that materialized balances reuse.

> **Accuracy note:** provider behaviors (Stripe/Adyen/PayPal specifics) are described generically and marked **verify against current provider docs** — do not quote internal architectures as fact. Compliance and regulatory content (PCI DSS, money transmission, safeguarding) is directional only and marked **verify**; it is **not legal or accounting advice**. Double-entry bookkeeping itself is standard, centuries-old accounting practice and is safe to assert.
