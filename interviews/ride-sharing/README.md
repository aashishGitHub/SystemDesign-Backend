# System Design: Ride Sharing (Uber / Lyft)

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended implementation choices.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note what you missed.
3. Use `deep-dive.md` for senior/architect depth, real-world Uber/Lyft implementations, and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Core Problem | Why matching riders to nearby drivers is deceptively hard at scale |
| 2 | Geospatial Indexing | Geohash, S2, H3 — how to query "drivers within 2km" in milliseconds |
| 3 | Location Updates | Handling 1M drivers sending GPS every 4 seconds |
| 4 | Matching Algorithm | How to find the best driver, not just the closest |
| 5 | Trip State Machine | From request → match → pickup → dropoff → payment |
| 6 | Real-Time Tracking | WebSockets for live driver position on rider's map |
| 7 | Surge Pricing | Dynamic pricing based on supply/demand zones |
| 8 | Production Operations | Capacity planning, failure modes, global scaling |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 44 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, company references. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-world Uber implementations, failure modes, cheat sheet. |

---

## Problem Statement

> Design a ride-sharing service like Uber. Riders request rides, the system matches them with nearby available drivers, and both parties can track each other's location in real-time during the trip.
>
> **POST /ride/request** — rider requests a ride from point A to point B
> **GET /ride/{rideId}/status** — get current ride status and driver location
> **POST /driver/location** — driver sends GPS coordinates every 4 seconds
> **POST /ride/{rideId}/accept** — driver accepts a ride request
>
> **Key Constraints:**
> - 1 million active drivers sending location updates every 4 seconds
> - 10 million ride requests per day (peak: 1000 requests/sec)
> - Match rider to driver in < 1 second
> - Driver location accuracy within 4 seconds
> - 99.9% availability (downtime = stranded riders)
> - Global deployment across 50+ cities

---

## How a Senior Engineer Thinks About This

The naive approach — "store all driver locations in a database and query nearby drivers" — fails immediately. At 1M drivers updating every 4 seconds, that's 250K writes/sec, and spatial queries on 1M rows are slow. Traditional databases weren't built for this.

The first key insight is **geospatial indexing**: divide the world into cells (geohash, S2, H3), store drivers by cell, and query only nearby cells. This transforms "find drivers within 2km" from a full table scan into O(1) cell lookups. The choice of cell size matters — too small means checking many cells; too large means filtering too many false positives.

The second insight is **separation of hot and cold paths**: driver locations are ephemeral (stale in 4 seconds) and live in-memory (Redis), while trip data is durable and lives in persistent storage (PostgreSQL/Cassandra). Mixing them in the same datastore causes problems.

A senior candidate immediately discusses the matching algorithm tradeoffs: nearest driver isn't always best (driver heading away, low ratings, wrong vehicle type). Real matching considers ETA, driver direction, acceptance rates, and business rules (surge multipliers, subscription tiers). The interview wants to see you model this as a scoring function, not a simple distance sort.
