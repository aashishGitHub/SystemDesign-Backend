# System Design: Seat Reservation System (Ticketmaster)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.

---

## How to Use This Guide

1. **First pass** — attempt every question yourself before reading the answer. Write your answer on paper or a whiteboard. Time yourself: 3–5 minutes per question.
2. **Second pass** — read the answers in `answers.md`, compare against your attempt, and note every gap. Pay special attention to Redis commands, SQL locking patterns, and capacity numbers you missed.
3. **Third pass** — whiteboard the full system from memory with no notes. Draw every service, queue, and database. Narrate the seat-selection and checkout flows end-to-end, then stress-test yourself with the Taylor Swift flash-sale scenario.

---

## Learning Path

| Level | Topic | You Will Learn |
|-------|-------|----------------|
| 1 | Fundamentals & Requirements | What "no overbooking" really means as a distributed systems constraint |
| 2 | Seat Hold Mechanics | Redis TTL-based hold, how to release on expiry, hold-vs-lock distinction |
| 3 | Concurrency & Locking | Optimistic vs pessimistic locking, when each breaks, MVCC seat reservation |
| 4 | Payment Flow | ACID transaction boundaries, two-phase commit vs saga, idempotency |
| 5 | Flash Sale Handling | Thundering herd at 10:00:00 AM, virtual queue, waiting room architecture |
| 6 | Database Design | Venue → Section → Row → Seat schema, read vs write path separation |
| 7 | Operations & Failure Modes | Partial payment failure, Redis crash during hold, double-charge prevention |
| 8 | Architect-Level Tradeoffs | Consistency models, global scale, Ticketmaster 2022 post-mortem lessons |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | 35+ questions across 8 levels. Attempt before reading answers. |
| [answers.md](./answers.md) | Full answers with TypeScript code, Redis commands, SQL, comparison tables. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations from beginner analogy to architect capacity math. |

---

## Problem Statement

> Design a ticket booking system like Ticketmaster. Users can browse events, view interactive seat maps, select specific seats, hold those seats for **10 minutes** while completing checkout, and confirm purchase via a payment provider.

**Key Constraints:**

| Constraint | Value |
|-----------|-------|
| Total users | 500 million registered |
| Total events | 10 million active events |
| Total seats (across all events) | 1 billion |
| Peak concurrent users (high-demand event) | **150,000** (Taylor Swift-scale) |
| Seat hold TTL | **10 minutes** |
| Overbooking tolerance | **Zero — hard constraint** |
| Seat selection latency | **< 500 ms** (p99) |
| Payment end-to-end SLA | **< 3 seconds** |
| Read/write ratio (browse vs book) | ~95% reads, 5% writes |

---

## How a Senior Engineer Thinks About This

The first thing a strong candidate does is **separate the availability problem from the inventory problem**. Browsing events and viewing seat maps is a read-heavy, highly cacheable workload — you can serve it from CDN edge caches and read replicas with slightly stale data and that's fine. The seat selection and checkout flow is an inventory management problem with zero-tolerance for overbooking: it requires strong consistency guarantees and cannot be served from a cache. Conflating these two paths is the single most common mistake in interviews. The correct answer segments the system immediately into a read path (events, venue maps, availability counts — cacheable) and a write path (hold, pay, confirm — must hit the source of truth).

The second insight is that a **seat hold is not a lock** — it is a time-bounded reservation with an explicit expiry contract. Pessimistic database locks held for 10 minutes across millions of concurrent users will destroy database connection pools and throughput. The right model is: write a hold record to Redis with a 10-minute TTL (atomic SETNX), return immediately to the user, and let Redis expire the hold if the user abandons checkout. The database seat state is only updated at the very end when payment succeeds — that update uses an optimistic lock (check hold_id still matches before writing CONFIRMED). This two-tier approach — Redis for fast, TTL-managed holds; DB for durable committed state — is the core architectural pattern that separates strong answers from weak ones.

The third and hardest challenge is **the thundering herd at sale open time**. When Taylor Swift tickets go on sale at 10:00:00 AM and 150,000 users simultaneously hit the buy button, a naive architecture routes all requests directly to the database, saturates the connection pool in milliseconds, and causes cascading failures — which is exactly what happened to Ticketmaster in November 2022. The correct answer is a **virtual queue (waiting room)**: every user who arrives in the pre-sale window gets a position token; the system admits users in controlled batches (e.g., 5,000/minute) and redirects them to a separate booking flow once admitted. The waiting room is itself stateless and served from a CDN or edge worker — the actual seat inventory service never sees the full 150K simultaneous connections.

---

## The Ticketmaster / Taylor Swift Incident (November 2022)

On November 15, 2022, Ticketmaster opened pre-sale for Taylor Swift's "The Eras Tour." The system experienced:
- **3.5 billion system requests** in a single day (normal peak: ~40 million/day)
- The virtual queue (waiting room) admitted bots and automated buyers at scale, exhausting real-user queue tokens
- Seat inventory service was hammered past capacity, causing widespread timeouts
- Users who held seats were kicked out mid-checkout when hold confirmation timed out
- Ticketmaster cancelled the public sale entirely on November 18

**Key lessons for the design:**
1. Bot mitigation must happen at the waiting room layer, before users enter the seat selection flow
2. Seat hold expiry during checkout is a user experience and trust problem, not just a technical one
3. The inventory service must be capacity-planned for the admitted user rate, not the total arrival rate
4. Queue depth monitoring with automatic admission throttling is non-negotiable for high-demand events

This incident is the reference benchmark for every architectural decision in this guide.
