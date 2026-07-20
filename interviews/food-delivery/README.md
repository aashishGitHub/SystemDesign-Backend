# System Design: Food Delivery (DoorDash / Swiggy / Uber Eats)

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Uber, DoorDash, Swiggy).
> **Style:** Interview-grill format — question first, then defended design choices.
> **Framing:** Broad restaurant marketplace. For the narrower "dark-store inventory" model (Gopuff), see the contrast in Level 5 and [seat-reservation](../seat-reservation/).

---

## How to Use This Guide

1. Attempt every question in [questions.md](./questions.md) cold before reading answers.
2. Check [answers.md](./answers.md) — compare your reasoning, note what you missed.
3. **New to the topic?** Read [conducive-sentences.md](./conducive-sentences.md) — every answer as plain-English prose, each ending with a "So, the connection is…" bridge to the next concept.
4. Use [deep-dive.md](./deep-dive.md) for 🟢 Beginner → 🟡 Senior → 🔴 Architect depth and failure modes.
5. Whiteboard from [diagrams.md](./diagrams.md) — start with Diagram 1 (the three-path architecture).

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Requirements | Why food delivery is a 3-sided marketplace and harder than ride-sharing |
| 2 | Catalog, Menu & Availability | Menu modelling and propagating "sold out" in real time |
| 3 | Discovery | Serviceability, search, ranking, pre-order ETA |
| 4 | Cart & Order Placement | Atomic orders, no-oversell, idempotency, authorize-then-capture |
| 5 | Order Lifecycle & Orchestration | State machine, event-driven saga, transactional outbox |
| 6 | Courier Dispatch | Prep-aware just-in-time assignment, batching |
| 7 | Real-Time Tracking & ETA | Live courier tracking, composite ETA, notifications |
| 8 | Reviews, Scale & Fault Tolerance | Ratings at scale, peak load, graceful degradation |
| 9 | Frontend Design (Architect) | Menu UI with live availability, cart state, tracking screen, flaky networks |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 44 structured questions (9 levels) + 6 bonus. Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table; ends with a Quick Recall Cheat Sheet. |
| [conducive-sentences.md](./conducive-sentences.md) | Plain-English prose version of every answer; "So, the connection is…" bridges. |
| [deep-dive.md](./deep-dive.md) | 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, real-world DoorDash/Swiggy notes, failure modes. |
| [diagrams.md](./diagrams.md) | Mermaid diagrams (start with Diagram 1 — the three-path architecture). |

---

## Problem Statement

> Design a food-delivery platform like DoorDash, Swiggy, or Uber Eats. Customers browse nearby restaurants, place multi-item orders, track delivery in real time, and leave reviews. Restaurants receive and prepare orders; couriers pick up and deliver.
>
> **GET  /restaurants?lat&lng&filters** — serviceable, ranked restaurants for an address
> **GET  /restaurants/{id}/menu** — menu with real-time availability
> **POST /orders** (Idempotency-Key) — place an order atomically
> **GET  /orders/{id}** — order status + live courier location
> **WS   /orders/{id}/track** — live tracking stream
> **POST /orders/{id}/review** — rate restaurant + courier
>
> **Key Constraints:**
> - 20M orders/day (peak dinner rush ~5×, ~1,200 orders/sec)
> - ~500K active couriers sending GPS every 4s at peak (~125K location writes/sec)
> - Browse latency < 100ms; order placement < 2s; **zero oversell, zero double-charge**
> - Delivery ETA accuracy matters (perishable output — cold food = failed delivery)
> - Global: many cities, fulfillment data local per metro

---

## How a Senior Engineer Thinks About This

The first move is to **separate the three traffic paths**, because they have nothing in common as engineering problems. *Browsing* (nearby restaurants, menus, search) is ~90% of traffic, read-heavy, and tolerant of slightly stale data — it belongs on caches, CDNs, and read replicas. *Ordering* (cart → place → pay) is transactional with a zero-tolerance for overselling an item or double-charging a card — it must hit the source of truth with strong guarantees and idempotency. *Tracking* (live courier location, status pushes) is an ephemeral streaming firehose served over WebSocket/SSE with a pub-sub backplane. Conflating them is the single most common mistake; the correct design routes each to entirely different infrastructure.

The second insight is that this is a **three-sided marketplace**, and the restaurant is a first-class actor, not a passive resource. Compared to ride-sharing's two-sided "match a rider to any driver," food delivery adds a *second acceptance gate* (the restaurant can reject after the customer has paid — which is exactly why you **authorize payment first and capture only on accept**), an *unobservable, variable prep time* that the whole system depends on, and a *physical synchronization point* where courier and food must converge at the same moment.

That synchronization is the third and hardest idea: **prep-aware, just-in-time dispatch**. In ride-sharing you dispatch a driver as soon as possible. In food delivery, dispatching ASAP is *wrong* — the courier would arrive and wait twenty minutes for the food, or arrive late and let it go cold. The dispatcher must assign the courier to arrive at the restaurant *the moment the food is ready*, which means the accuracy of the prep-time estimate is the linchpin the entire fulfillment system hangs on.

Finally, a senior candidate models the order flow as **event-driven** with a saga and a transactional outbox. The order commit (validate → authorize → create) stays synchronous because the customer needs an answer, but everything after — notify restaurant, plan dispatch, send receipt, feed analytics — is fired as events so a dinner-rush spike becomes a *backlog in Kafka* rather than a database meltdown, and a failure in any downstream step is unwound by compensating actions rather than corrupting the order.

---

## Related Topics

This is an **umbrella topic** — it reuses depth from its neighbours instead of duplicating it:

- **[ride-sharing](../ride-sharing/)** — geospatial indexing (geohash/S2/H3), courier location at scale, matching/offer system, live WebSocket tracking, surge pricing. *The "dynamic supply + real-time" half.*
- **[seat-reservation](../seat-reservation/)** — atomic no-oversell reservation, Redis TTL holds, read/write path split, payment saga, flash-sale thundering herd. *The "fixed supply + strong consistency" half (closest to the Gopuff model).*
- **[message-queues](../message-queues/)** — Kafka, consumer groups, saga, transactional outbox, DLQ.
- **[distributed-transactions](../distributed-transactions/)** — saga vs 2PC, compensating actions, idempotency.
- **[notification-system](../notification-system/)** — multi-channel push/SMS/email for order status.
- **[search-autocomplete](../search-autocomplete/)** & **[recommendation-system](../recommendation-system/)** — restaurant/dish search and home-feed ranking.
- **[api-design](../api-design/)** — idempotency keys, pagination, versioning.
- **[communication-protocols](../communication-protocols/)** — sync vs async, WebSocket vs SSE, at-least-once + idempotency.
- **[video-streaming](../video-streaming/)** — the same immutable-content-addressing (menu_version) and outbox-recovery patterns, in a different domain.
