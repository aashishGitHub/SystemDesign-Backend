# Interview Questions: Payment System (Stripe / PayPal / Google Pay)

> Attempt each question cold before reading [answers.md](./answers.md).
> Work level-by-level; later levels assume earlier concepts.
> This topic owns the **money-correctness** depth that neighbours defer to it: [distributed-transactions](../distributed-transactions/) (saga mechanics, 2PC), [seat-reservation](../seat-reservation/) (payment step in the booking saga), [e-commerce](../e-commerce/) (checkout leg), [message-queues](../message-queues/) (outbox, at-least-once), [api-design](../api-design/) (idempotency keys as an API contract).

---

## Level 1 — Fundamentals & Requirements
*Goal: understand why money is not just another write before designing anything.*

**Q1.** What makes a payment system fundamentally harder than a typical CRUD service? Name three properties of money that change the engineering, and why each one matters architecturally.

**Q2.** A payment system has two halves with opposite characteristics. Identify them and explain why each needs a different consistency and failure model.

**Q3.** Define the actors and the money flow in a card payment: cardholder, merchant, your platform, PSP/gateway, acquirer, card network, issuer. Who actually moves the money, and what is your platform's real job?

**Q4.** State the functional and non-functional requirements. What are the hard guarantees (no double-charge, no lost money, every cent auditable, eventual settlement correctness) and what scale do you design against?

**Q5.** Back-of-the-envelope: estimate payment QPS, ledger write volume, and storage growth for a mid-size platform. Which resource is the real constraint — throughput, storage, or correctness — and what does that tell you?

**Q6.** List the core entities (PaymentIntent, Charge, Ledger Entry, Account, Refund, Payout, Dispute) and the minimal API set to take a payment, refund it, and read its status.

---

## Level 2 — Core Payment Flow & PSP Integration
*Goal: the happy path, and why you never touch a raw card number.*

**Q7.** Walk the end-to-end flow of a successful card payment from "customer taps Pay" to "money is settled." Which steps are synchronous, which are asynchronous, and where does your system's responsibility begin and end?

**Q8.** Explain **authorize vs capture vs settle vs void vs refund**. When does each happen, what does each do to the money, and what's the difference between a void and a refund?

**Q9.** Design the PSP abstraction layer. How do you support multiple providers (Stripe, Adyen, Braintree, a local acquirer) without leaking provider-specific concepts into your domain — and why would you want more than one?

**Q10.** How do you avoid ever storing or even touching a raw card number? Explain tokenization, the difference between a single-use and a reusable token, and how PCI DSS scope is minimized (hosted fields / iframe / client-side tokenization).

**Q11.** Design the payment state machine. Draw every state and transition including all the failure and terminal branches, and explain why the state machine must be explicit rather than implicit in code.

**Q12.** Why is a `PaymentIntent`-style object (created *before* you attempt the charge) better than a fire-and-forget "charge this card" call? What does creating intent up front buy you?

---

## Level 3 — Idempotency & Exactly-Once Money Movement
*Goal: the signature problem — a retry must never move money twice.*

**Q13.** The client double-taps Pay, or the network retries the request. How do you guarantee exactly one charge? Design the idempotency-key mechanism end to end, including the storage schema.

**Q14.** Two requests with the **same** idempotency key arrive concurrently (not sequentially) and race. Walk the exact database mechanics that make one win and the other return the first one's result rather than creating a second charge.

**Q15.** A request arrives with the same idempotency key but a *different* request body (e.g. a different amount). What do you do, and why is silently succeeding dangerous?

**Q16.** How long do you retain idempotency keys, and what breaks at each end of that choice (too short vs forever)? What's the scope of a key — global, per-merchant, per-endpoint?

**Q17.** You call the PSP and get a **timeout**. You don't know whether the charge went through. Walk your exact recovery procedure — and explain why "just retry" and "just fail" are both wrong.

**Q18.** *(Failure mode)* Your service crashes after the PSP successfully charged the card but before you persisted anything locally. The customer's money is gone and you have no record. How do you detect and recover this?

---

## Level 4 — The Ledger (Double-Entry Bookkeeping)
*Goal: the auditable source of truth for every cent.*

**Q19.** Why do payment systems use a **double-entry ledger** rather than a simple `balances` table with `UPDATE balance = balance + x`? What specific class of bug does double-entry make structurally impossible?

**Q20.** Design the ledger schema. Show the actual entries (debits and credits) for a single $100 card payment with a $3 platform fee, and prove the entries balance to zero.

**Q21.** Why must ledger entries be **immutable and append-only**? How do you then represent a correction, a reversal, and a refund?

**Q22.** How do you compute an account balance at scale when the ledger has billions of rows? Compare deriving-by-fold vs materialized balances, and explain how you keep a materialized balance correct.

**Q23.** How do you represent money in code and in the database? Cover integer minor units vs decimal vs float, multi-currency, and why rounding is a correctness issue rather than a display issue.

**Q24.** Write the invariants your ledger must satisfy at all times, and describe the job that continuously verifies them in production. What do you do when an invariant is violated?

---

## Level 5 — Async Reality: Webhooks, Retries & Reconciliation
*Goal: the external world is unreliable and only eventually knowable.*

**Q25.** The PSP notifies you of outcomes via **webhooks**. Design webhook ingestion: verifying authenticity, responding fast, handling duplicates, handling out-of-order delivery, and handling a webhook for something you have no record of.

**Q26.** Webhooks can be lost, delayed for hours, or delivered out of order. Why can you never treat webhooks as your only source of truth, and what do you pair them with?

**Q27.** Design **reconciliation** against the PSP. You receive a daily settlement file/report; walk the process that compares it to your ledger, and enumerate the categories of mismatch you can find.

**Q28.** A reconciliation run finds a charge the PSP says succeeded that your system has no record of (and the reverse case). What is your remediation for each direction?

**Q29.** How do you handle **delayed and asynchronous payment methods** (bank debits/ACH/SEPA, vouchers, BNPL) where "success" can arrive days later and can be reversed after the fact?

**Q30.** *(Failure mode)* The PSP is completely down during your peak. What do you do — queue, fail, or fail over to a second PSP? Discuss the correctness risk of each option.

---

## Level 6 — Refunds, Payouts, Chargebacks & Disputes
*Goal: money flowing backwards and outwards.*

**Q31.** Design the refund flow, including partial refunds and multiple partial refunds. What invariants prevent refunding more than was captured, and how does the ledger record it?

**Q32.** What is a **chargeback** and how does it differ from a refund? Model the dispute lifecycle and explain what your system must do at each stage (including evidence submission and the money moving without your consent).

**Q33.** Design **payouts** to merchants/sellers: computing balance owed, scheduling, batching, holds/reserves, and what happens when a payout fails or is returned.

**Q34.** For a marketplace: one buyer payment splits across multiple sellers plus a platform fee. Model this in the ledger, and explain how a partial refund later is attributed correctly.

**Q35.** *(Failure mode)* A refund is issued twice for the same charge because of a retry, and the customer receives more money than they paid. How was that possible, and what prevents it structurally?

---

## Level 7 — Consistency, Correctness & Failure Modes
*Goal: the guarantees, stated precisely, and where they break.*

**Q36.** Payment, ledger, and order live in different services with different databases. How do you keep them consistent without a distributed transaction? (saga + outbox — reuse [distributed-transactions](../distributed-transactions/) and [message-queues](../message-queues/))

**Q37.** State your consistency model precisely. What is strongly consistent, what is eventually consistent, and when exactly is a payment "final" from the customer's perspective vs the accounting perspective?

**Q38.** How do you make every consumer of payment events safe under at-least-once delivery? Show how an event consumer that updates a balance is made idempotent.

**Q39.** *(Failure mode)* A deploy introduces a bug that double-writes ledger entries for four hours. Money now appears to be created out of nothing. What is your incident response, and how do you repair the ledger without destroying the audit trail?

**Q40.** How do you test a payment system? Cover unit/property tests for ledger invariants, PSP sandboxes, deterministic simulation of timeouts and duplicate webhooks, and what you can never safely test in production.

---

## Level 8 — Scale, Security & Compliance
*Goal: the constraints that are not negotiable.*

**Q41.** How do you shard payment and ledger data? What is the shard key, what query pattern breaks, and why is an append-only ledger easier to shard than a mutable balances table?

**Q42.** Explain the compliance surface at a design level: PCI DSS scope reduction, encryption at rest and in transit, key management, tokenization, data residency, and what you must be able to prove to an auditor.

**Q43.** Design fraud and risk checks in the payment path: where they sit, the latency budget, velocity rules vs ML scoring, and how you handle a false decline vs a false accept.

**Q44.** How do you handle **multi-currency** payments: FX rate capture, which rate applies, the difference between presentment and settlement currency, and where FX gain/loss lands in the ledger.

**Q45.** What do you monitor and alert on in a payment system? Give the specific business and correctness SLIs, and name the one metric that should always be zero. (reuse [observability](../observability/))

---

## Level 9 — Frontend Architecture (Architect)
*Goal: the client side of the money path — safe, compliant, and honest under bad networks.*

**Q46.** Design the checkout/payment UI architecture. Where does the card data go, why must it never touch your own JavaScript state or your server, and how do hosted fields / iframes keep you out of PCI scope?

**Q47.** Design an idempotent submit from the client: when to mint the idempotency key, how to prevent double-submit, and how to resume correctly after a refresh, a back-button, or a closed tab.

**Q48.** Handle **3-D Secure / SCA redirects and challenge flows**: persisting state before leaving the page, resuming on return, and handling the case where the customer never comes back.

**Q49.** The network drops right after the user hits Pay and you get no response. What does the client show, what does it do next, and how does it avoid both double-charging and falsely telling the user it failed?

**Q50.** How do you display payment state honestly when the truth is asynchronous (pending bank debits, processing, delayed failures)? What are the UX and correctness rules for optimistic UI on a money path?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** Stored payment methods and off-session/recurring charges (subscriptions) — how does the flow and the consent model differ from an on-session payment?

**QB2.** Why would you build an internal double-entry ledger rather than trusting the PSP's dashboard as your source of truth?

**QB3.** Money-transmission and regulatory posture: what changes architecturally if you hold customer funds rather than passing them straight through?

**QB4.** How do you migrate PSPs (or add a second one) without downtime, and how do you migrate stored payment tokens you don't own?

**QB5.** Idempotency at the *edge* vs in the *service*: what breaks if you dedupe at the API gateway instead of transactionally in the database?

**QB6.** What is the "pending balance vs available balance" distinction, and why does a naive single-balance model cause real financial loss?
