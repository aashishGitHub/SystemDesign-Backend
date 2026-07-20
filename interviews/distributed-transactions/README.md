# System Design: Distributed Transactions & Consistency

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended design choices.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note what you missed.
3. Use `deep-dive.md` for senior/architect depth, real-world system implementations, and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | The Problem | Why local ACID doesn't span services/shards; the dual-write trap |
| 2 | CAP & PACELC | CAP stated correctly (not "pick 2 of 3"); latency vs consistency when healthy |
| 3 | Consistency Models | Linearizable → causal → eventual; client-centric session guarantees |
| 4 | Two-Phase Commit | Prepare/commit, the blocking problem, why 3PC is rarely used |
| 5 | Saga Pattern | Compensations, orchestration vs choreography, the isolation gap |
| 6 | Reliable Messaging & Idempotency | Outbox, CDC, idempotency keys, "effectively once" |
| 7 | Isolation & Concurrency Control | Anomalies, snapshot isolation, serializable, MVCC, OCC vs 2PL |
| 8 | Architect Tradeoffs | Redesign boundaries first; Spanner/Percolator; choosing the model |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 34 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, real-system references. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-world implementations, production stories, anti-patterns, cheat sheet. |

---

## Problem Statement

> You are designing order placement for an e-commerce platform. Placing an order must: charge the customer (Payment service), reserve stock (Inventory service), and create the order (Order service). Each service owns its own database — there is no shared database to wrap in a single `BEGIN…COMMIT`. The system must also publish an `OrderPlaced` event so downstream systems (search index, email, analytics) react.
>
> **POST /orders** — atomically-enough place an order across three services and emit one event
>
> **Key Constraints:**
> - Never double-charge a customer, even if the client retries or a network call times out
> - Never oversell inventory (two orders must not both claim the last unit)
> - The DB write and the published event must not diverge (the dual-write problem)
> - No global lock that blocks all orders while one shard/coordinator is down
> - Peak: 10k order attempts/sec; payment calls have p99 ≈ 800 ms; some services live in different regions

---

## How a Senior Engineer Thinks About This

A strong answer starts by refusing the framing. There is no cross-service `BEGIN…COMMIT`: local ACID guarantees stop at one database's boundary. The senior move is to name the real failure — the **dual-write problem** (a DB commit and a message publish cannot be made atomic by ordering them naively) — and to state that "just wrap it in a distributed transaction" trades availability for atomicity in a way most product flows should not accept.

Next they separate the two hard sub-problems: **atomicity across services** (do all steps happen or none?) and **consistency of what readers see** (linearizable, causal, or eventual?). These map to different tools. Atomicity across nodes is 2PC (blocking, strong) vs Saga (available, eventually consistent, no isolation). Reader-facing consistency is the CAP/PACELC axis and the isolation-level axis. Conflating them is the most common way candidates lose the thread.

Finally, a staff-level candidate reframes the whole thing: the best distributed transaction is the one you deleted by drawing service boundaries around a single consistency domain. When you genuinely need cross-shard atomicity, you cite how the systems that do it well pay for it — Spanner's TrueTime + 2PC layered over Paxos groups, Percolator's client-driven 2PC on Bigtable — and you make the latency, availability, and operational costs explicit rather than hand-waving "we'll use a transaction."
