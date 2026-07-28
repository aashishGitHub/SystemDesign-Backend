# System Design: E-Commerce Platform (Amazon / Shopify)

> **Target:** Senior / Staff engineers (Amazon, Meta, Google, Shopify, Stripe).
> **Style:** Interview-grill format — question first, then defended design choices.
> **Framing:** An **umbrella topic** organized around **THE CONSISTENCY GRADIENT**: browse → cart → checkout → fulfillment. Each stage sits at a different point on the CAP spectrum; the whole design falls out of putting each one on the right infrastructure.

---

## How to Use This Guide

1. Skim [simple-diagram.md](./simple-diagram.md) first — it names the **consistency gradient** (browse → cart → checkout → fulfillment) in one screen, with the six components to remember.
2. Attempt every question in [questions.md](./questions.md) cold before reading answers — 9 levels, worked in order (later levels assume earlier concepts).
3. Check [answers.md](./answers.md) — compare your reasoning; each answer has a code block or comparison table and ends with a **Key takeaway** you can say under pressure. It closes with a Quick Revision Cheatsheet.
4. Whiteboard from [diagrams.md](./diagrams.md) — start with Diagram 1 (the gradient), then layer in services and protocols.
5. Go deep with [deep-dive.md](./deep-dive.md) — 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, failure modes, and real-world case notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Requirements | See e-commerce as a **consistency gradient** (browse → cart → checkout → fulfill), not one system |
| 2 | Catalog & Product | Serve product data fast and globally — the ~90%+ read path (CDN → Redis → replicas) |
| 3 | The Cart | The availability-first (AP) subsystem that must never say no; Dynamo-style merge |
| 4 | Checkout, Orders & No-Oversell | The strong-consistency money path: guarded decrement + idempotency key |
| 5 | Order Orchestration | Saga + compensations + transactional outbox across service-owned DBs |
| 6 | Inventory & Fulfillment at Scale | Multi-warehouse stock, allocation, and the Prime-Day thundering herd |
| 7 | Consistency, Freshness & Data | Stale prices, read-your-writes, sharding, returns/refunds |
| 8 | Scale, Peak & Fault Tolerance | Black Friday capacity, graceful degradation, multi-region, funnel SLOs |
| 9 | Frontend Architecture (Architect) | Rendering strategy, optimistic cart, idempotent checkout, flaky networks |

---

## Files

| File | Purpose |
|---|---|
| [simple-diagram.md](./simple-diagram.md) | **Start here.** The four-stage consistency gradient + the six components to remember, then a detailed version with real services/protocols. |
| [questions.md](./questions.md) | 42 structured questions (9 levels) + 6 bonus. Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table; each ends with a **Key takeaway**; closes with a Quick Revision Cheatsheet. |
| [diagrams.md](./diagrams.md) | Mermaid diagrams (start with Diagram 1 — the consistency gradient). |
| [deep-dive.md](./deep-dive.md) | 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, real-world Amazon/Shopify notes, failure modes. |

---

## Problem Statement

> Design an Amazon-like e-commerce platform. Shoppers browse and search a massive catalog, add items to a cart across devices, check out and pay, then track an order to delivery and request returns. Sellers/admins manage catalog, price, and inventory. The four stages span a **consistency gradient** and cannot share one service, one database, or one consistency model.
>
> **GET  /products?q&filters** — search / list the catalog
> **GET  /products/{id}** — product detail (price + availability overlay)
> **POST /cart/items** — add/update cart item (must always succeed)
> **POST /orders** (Idempotency-Key) — place an order atomically, exactly once
> **GET  /orders/{id}** — order status + tracking
> **POST /orders/{id}/returns** — return / refund
>
> **Key Constraints** *(scale numbers are order-of-magnitude — verify against primary sources):*
> - **Reads dominate ~1000:1** over order-writes (~30–50 product views per order at ~2–3% conversion).
> - **Orders:** ~20M/day → ~230/s average, ~10⁴/s Prime-Day peak.
> - **Product views:** ~9K/s average, up to ~10⁶/s peak — this dominates traffic.
> - **Catalog:** ~10⁸–10⁹ SKUs (marketplace scale); ~10⁸ users.
> - **Hard guarantees:** no oversell · no double-charge / exactly-once order · cart never lost (availability-first) · product-page p99 < ~100–200ms globally · placed+paid orders durable · survive 10–50× peak spikes gracefully.

---

## How a Senior Engineer Thinks About This

The first move — and the single highest-signal thing a candidate does here — is to name the **consistency gradient** out loud and let the whole design fall out of it. An e-commerce platform is not one system; it is four stages with genuinely different requirements. *Browse* is read-heavy (~90%+ of traffic) and tolerates a slightly stale price or stock badge, so it lives on caches, CDNs, and read replicas (eventual consistency). *Cart* must never reject a write — a dropped add-to-cart is lost revenue — so it is availability-first (AP). *Checkout* moves real money and stock, so it must be strongly consistent: never oversell, never double-charge. *Fulfillment* must be reliable but not synchronous, so it is event-driven and async. As the shopper moves toward the money, **required consistency rises and tolerable staleness falls** — each stage is a different CAP point demanding different infrastructure, and conflating them is the classic mistake (a strongly-consistent cart that rejects writes during a partition loses sales; an eventually-consistent checkout oversells).

The two poles of that gradient are the cart and the checkout, and they are studied opposites. The **cart is the canonical AP / Dynamo subsystem** — the textbook Amazon example — because a rejected add-to-cart is directly lost money, so you choose an always-writable store (DynamoDB / Cassandra) and resolve concurrent versions later with vector clocks and add-wins union merges (tombstones for deletes). The **checkout is CP**: the *only* real oversell guard is a **guarded conditional inventory decrement** (`UPDATE inventory SET reserved = reserved + qty WHERE (on_hand - reserved) >= qty`; zero rows updated means sold out), and the *only* exactly-once mechanism is an **idempotency key** — unique on the order row and passed to the payment provider so a double-click or retry returns the *same* order and never a second charge. The stock badge on the product page ("Only 2 left") is a cache-served **UX hint**, not the guard — believing otherwise is a classic error.

The third idea is how order placement stays consistent across services that each own their own database. There is no shared transaction, so this is a **saga with compensating actions** (release-stock ↔ reserve, void-auth ↔ authorize, cancel-order ↔ create) rather than a blocking 2PC — orchestrated for the money-critical flow so one place owns state and compensations. Crucially, the order row and its `OrderPlaced` event are committed **atomically via a transactional outbox** (both in one local DB transaction; a relay publishes the event), so the event can never be lost or orphaned relative to the order. Because fulfillment then runs as an **async consumer** of that event, a Prime-Day spike becomes a durable Kafka **backlog rather than a checkout meltdown** — orders keep committing and confirming while shipping catches up. Money follows the same last-responsible-moment logic: **authorize at checkout, capture on ship**, void on pre-ship cancel.

Finally, a senior candidate spends engineering effort where it pays. Because reads outnumber order-writes ~1000:1, you **cache and replicate the browse path hard** — CDN → Redis → DB read-replicas, product bodies keyed by an immutable version, with volatile price/availability overlaid separately — so the vast majority of traffic never touches the source of truth. You then spend your *correctness* budget (idempotency, the guarded decrement, TTL holds, reconciliation sweeps) on the comparatively tiny but high-value write path, where a mistake moves real money. And you know the boundary of the problem: payment **depth** — a double-entry ledger, PSP reconciliation, chargeback and dispute workflows — is deliberately delegated to a dedicated payment-system topic (ROADMAP Problem 16, not yet built) and to [distributed-transactions](../distributed-transactions/); here, payment is one authorize-then-capture saga step.

---

## Related Topics

This is an **umbrella topic** — each e-commerce subsystem reuses the depth of a neighbouring topic that owns it, rather than duplicating it:

- **[kv-store](../kv-store/)** — the cart as a Dynamo-style **AP** store: always-writable, vector clocks, add-wins conflict resolution. *The "never reject a write" half.*
- **[seat-reservation](../seat-reservation/)** — **no-oversell** concurrency, Redis **TTL holds** at checkout start, and the flash-sale / drop **thundering herd** on one hot SKU.
- **[distributed-transactions](../distributed-transactions/)** — the order **saga** vs 2PC, compensating actions, **idempotency**, and payment coordination.
- **[message-queues](../message-queues/)** — Kafka, the **transactional outbox**, consumer groups, and DLQ for the async fulfillment path.
- **[distributed-caching](../distributed-caching/)** + **[cdn-edge](../cdn-edge/)** — the catalog **read path**: Redis in front of the DB, edge caching by immutable version, surrogate-key purge.
- **[search-autocomplete](../search-autocomplete/)** + **[recommendation-system](../recommendation-system/)** — **discovery and ranking**: a CDC-fed inverted index and precomputed reco lists read on the hot path.
- **[sharding-replication](../sharding-replication/)** — **data sharding** (products by id, orders by user_id, inventory by SKU/warehouse) and **read-your-writes** under replication lag.
- **[rate-limiting](../rate-limiting/)** — bots, scalpers at drop time, coupon abuse, and per-user purchase caps at the earliest choke point.
- **[observability](../observability/)** — the buy-funnel **SLOs**: add-to-cart success, checkout success rate, oversell rate (a correctness alarm ≈ 0), p99 product-page latency.
- **[food-delivery](../food-delivery/)** — the same **read / write / track split** and the menu-availability overlay pattern, in a different domain.

> **Note:** Payment *depth* — double-entry ledger, PSP reconciliation, chargebacks — is a planned separate topic (ROADMAP Problem 16, not yet built). Here it is treated as one authorize-then-capture saga step; deeper coordination delegates to [distributed-transactions](../distributed-transactions/).
