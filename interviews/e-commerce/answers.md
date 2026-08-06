# Answers: E-Commerce Platform (Amazon / Shopify)

> Keyed to [questions.md](./questions.md). Read the question first, then compare.
> Every answer has a code block or comparison table so you can defend the tradeoff out loud, and ends with a **Key takeaway**.
> This is an **umbrella topic** — depth that lives elsewhere is cross-linked, not duplicated: [kv-store](../kv-store/) (cart/Dynamo/vector clocks), [seat-reservation](../seat-reservation/) (no-oversell, TTL holds, flash sale), [distributed-transactions](../distributed-transactions/) (saga, idempotency, payment coordination), [message-queues](../message-queues/) (Kafka, outbox, DLQ), [distributed-caching](../distributed-caching/) / [cdn-edge](../cdn-edge/) (catalog reads), [search-autocomplete](../search-autocomplete/) / [recommendation-system](../recommendation-system/) (discovery), [sharding-replication](../sharding-replication/) (data), [rate-limiting](../rate-limiting/) (abuse), [observability](../observability/). A dedicated [payment-system](../payment-system/) topic owns that depth (double-entry ledger, idempotency, PSP reconciliation, chargebacks); saga mechanics stay in [distributed-transactions](../distributed-transactions/).
>
> **Accuracy note:** Amazon-scale figures are order-of-magnitude *planning* numbers to verify against primary sources, not published facts.

---

## Level 1 — Fundamentals & Requirements

### A1. Why one service/DB/consistency-model can't serve all four stages

| Stage | Read/write | Consistency it needs | Availability it needs | Right infra |
|---|---|---|---|---|
| **Browse** | Read-heavy (~90%+) | Eventual (stale price/stock OK to *show*) | High | Cache + CDN + read replicas |
| **Cart** | Read/write, per-user | Convergent (merge OK) | **Highest** — never reject add-to-cart | AP KV store (Dynamo-style) |
| **Checkout** | Write, transactional | **Strong** — no oversell, no double-charge | High but may reject | SQL source of truth + idempotency |
| **Fulfillment** | Write, async | Eventual, reliable | Decoupled | Event bus + saga |

The organizing insight is a **consistency gradient**: as the shopper moves browse → cart → checkout, required consistency rises and tolerable staleness falls. Each stage sits at a different point on the CAP spectrum, so each needs different infrastructure.

**Key takeaway:** E-commerce is a **consistency gradient** — you split it into stages precisely because browse (eventual), cart (available), checkout (strong), and fulfillment (async) demand different guarantees; one DB/model can't be optimal for all four.

---

### A2. The traffic paths and why consistency increases toward "buy"

```text
BROWSE   read-heavy, eventual   — showing a slightly stale price is a UX blemish, not a bug
CART     available, convergent  — a dropped "add to cart" is LOST REVENUE → never say no
CHECKOUT strong, exactly-once   — overselling or double-charging is a real-money integrity bug
FULFILL  async, reliable        — must happen, but not synchronously in the buy request
```

Cost of being wrong rises with the gradient: a stale product page annoys; a lost cart loses a sale; a bad checkout loses money and trust. Infrastructure follows cost.

**Key takeaway:** Required consistency **increases toward the money** — you can be loose where a mistake is cosmetic (browse) and must be exact where a mistake moves real money or stock (checkout).

---

### A3. Requirements

```text
Functional
  - Browse/search a huge catalog; view product detail with price + availability
  - Add to cart (cross-device), check out, pay, place an order
  - Track order → shipped → delivered; returns/refunds
  - Seller/admin: manage catalog, price, inventory

Non-functional (hard guarantees)
  - NO OVERSELL: never sell more units than exist
  - NO DOUBLE-CHARGE / EXACTLY-ONCE ORDER: a retry/double-click = one order, one charge
  - CART NEVER LOST: add-to-cart always succeeds (availability-first)
  - FAST BROWSE: product page p99 < ~100–200ms globally
  - DURABLE ORDERS: an placed+paid order is never lost
  - PEAK SURVIVAL: 10–50× spikes (Prime Day / Black Friday) degrade gracefully, don't collapse

Scale (order-of-magnitude — verify)
  - ~10^8 users; catalog ~10^8–10^9 SKUs (marketplace); reads ≫ writes (~30–50 views/order)
  - Peak orders ~10^4/s (planning estimate); product-page reads ~10^6/s at peak
```

**Key takeaway:** The non-functional list *is* the design — **no oversell, no double-charge, cart-never-lost, fast browse, durable orders, peak survival** — each maps directly to a later decision.

---

### A4. Back-of-the-envelope QPS

```text
Assume 20M orders/day, ~2–3% conversion → ~30–50 product-page views per order.

Orders:        20M/day ÷ 86,400 ≈ 230/s avg; peak (Prime Day ~50×) ~10^4/s
Product views: 20M × 40 = 800M/day ≈ 9,000/s avg; peak ~10^6/s   ← DOMINATES
Add-to-cart:   ~2–3× orders (abandonment) ≈ 500–700/s avg

Reads outnumber order-writes by ~1000:1.
```

**Conclusion:** spend effort on (a) caching/CDN the catalog read path so it never touches the DB, and (b) correctness — not raw throughput — on the low-volume-but-high-value order path. This is the same read-path/write-path split as [video-streaming](../video-streaming/) and [food-delivery](../food-delivery/).

**Key takeaway:** **Reads dominate ~1000:1** — over-provision and cache the browse path aggressively; the order path is comparatively tiny, so there you optimize for *correctness*, not QPS.

---

### A5. Core entities & minimal APIs

```text
Entities
  Product  { id, title, brand, category, attrs, media[], variants[] }
  SKU      { id, product_id, options{size,color}, price_cents, weight }
  Inventory{ sku_id, warehouse_id, on_hand, reserved }
  Cart     { user_id, items[{sku_id, qty}], version }        // AP
  Order    { id, user_id, lines[], totals, state, idem_key } // SQL
  Payment  { id, order_id, auth_id, capture_id, state }
  Shipment { id, order_id, warehouse_id, carrier, tracking, state }

APIs
  GET  /products?q&filters               → search/list
  GET  /products/{id}                    → detail (price + availability)
  POST /cart/items  (user)               → add/update (always succeeds)
  GET  /cart
  POST /orders  (Idempotency-Key)        → place order (atomic, once)
  GET  /orders/{id}                      → status + tracking
  POST /orders/{id}/returns              → return/refund
```

**Key takeaway:** The funnel is **discover → product → cart → order → track → return**; everything else (payment, inventory, shipping, notifications) hangs off `POST /orders`, which carries an **Idempotency-Key**.

---

## Level 2 — Catalog & Product

### A6. Product catalog data model

```text
Product 1───* SKU (variant)          Product = the listing; SKU = the buyable unit
Product { id, title, brand, category_id, attributes{}, media[], description }
SKU     { id, product_id, options{size:"M", color:"red"}, price_cents, barcode }
Category (tree), Attributes (facetable: brand, material, rating)

Source of truth: Catalog DB (document store — a product is a self-contained document).
Price/inventory are SEPARATE, more-volatile records (not baked into the cached product doc).
```

| Decision | Reason |
|---|---|
| Product vs SKU split | You browse a *product*, buy a *SKU* (specific size/color) |
| Document store | Products are document-shaped, read-mostly, keyed by id |
| Price/inventory separate | Volatile — must not force a re-cache of the whole product doc |
| Attributes as facets | Powers search filters without schema churn |

**Key takeaway:** Model **Product (the listing) vs SKU (the buyable variant)**, store products as documents keyed by id, and keep **price and inventory as separate volatile records** so the heavy product doc stays cacheable.

---

### A7. Serving product pages <100ms globally

```text
CDN (edge)  ── product JSON + images cached by (product_id, version); most reads end here
   │ miss
Redis cache ── hot products; ~90% of origin reads absorbed here   ([distributed-caching])
   │ miss
Catalog DB (+ read replicas)  ── source of truth

Invalidation: catalog edit → bump product version → new immutable cache key
              (publish, don't mutate) + purge CDN by surrogate key ([cdn-edge]).
```

Render = **cached product body ⊕ live price/availability overlay** (the volatile bits fetched/overlaid separately, like [food-delivery](../food-delivery/)'s menu+availability split).

**Key takeaway:** Layer **CDN → Redis → DB read-replicas**, cache the product body by an **immutable version key** (publish bumps the version; never mutate a cached object), and overlay the volatile price/availability separately.

---

### A8. Search & filtering

```text
Query = full-text ∩ facets ∩ availability, e.g.:
  q="running shoes" ∩ brand∈{...} ∩ price∈[50,120] ∩ rating≥4 ∩ in_stock=true

Backed by an INVERTED INDEX (Elasticsearch/OpenSearch), NOT the catalog DB.
Freshness: catalog/price/inventory changes → CDC stream → async index update.
Ranking: relevance + business signals (popularity, margin, availability).
```

Typeahead is its own topic: [search-autocomplete](../search-autocomplete/).

**Key takeaway:** Search is a **separate inverted index fed asynchronously by CDC** from the catalog — never query the catalog DB directly for search — combining full-text, facets, and an in-stock filter, ranked by relevance + business signals.

---

### A9. The inventory badge is NOT the oversell guard

```text
"Only 2 left" / "In stock" on the product page is a UX HINT, served from cache/overlay,
and is allowed to be slightly stale.

It does NOT prevent overselling. Overselling is prevented at exactly ONE place:
the authoritative guarded decrement at CHECKOUT, inside the order transaction (A16).
Fast badge updates only shrink the disappointment window.
```

**Key takeaway:** The stock badge is an **eventually-consistent UX hint**, not the guard — overselling is prevented *only* by the authoritative inventory check at checkout; conflating the two is a classic mistake (same lesson as [food-delivery](../food-delivery/) "sold out" propagation).

---

### A10. Personalization off the hot path

```text
Homepage/"recommended for you":
  offline/near-line: compute per-user recommendation lists (batch + streaming)
  hot path: look up the precomputed list by user_id (a cache read), then hydrate
            product cards from the catalog cache.

Ranking never runs synchronously in the page request — it's precomputed and read.
```

Depth: [recommendation-system](../recommendation-system/); the "precompute offline, read on hot path" pattern is shared with [social-feed](../social-feed/).

**Key takeaway:** **Precompute recommendations offline and just *look them up*** on the request path — heavy ranking never runs synchronously in a page load (see [recommendation-system](../recommendation-system/)).

---

## Level 3 — The Cart

### A11. Why the cart is availability-first (AP)

```text
A failed "add to cart" is directly lost revenue → the cart must accept writes even during
a partition. That's the definition of an AP system.

Cart model (AP KV):
  key   = cart:{user_id}
  value = { items: [{sku_id, qty, added_at}], version/vector_clock }
  store = DynamoDB / Cassandra (AP, always writable, reconcile later)
```

This is the **canonical Amazon Dynamo example**: the cart must never reject an add, so occasional conflicting versions are acceptable and resolved at read time ([kv-store](../kv-store/)).

**Key takeaway:** The cart is the textbook **AP subsystem** — a rejected add-to-cart is lost money, so you choose an always-writable Dynamo-style store and resolve conflicts later (the classic [kv-store](../kv-store/) example).

---

### A12. Merging a diverged cart

```text
Phone adds "book" while laptop (offline) adds "pen" → two versions of cart:{user}.

Dynamo-style resolution:
  - vector clocks / version vectors detect the two are CONCURRENT (neither descends the other)
  - MERGE by UNION of items (add-wins); for the same SKU, take max qty or sum per policy
  - a REMOVE is trickier — a naive union resurrects deleted items → use a tombstone or
    "removed" marker so a delete on one device isn't undone by a stale add on the other.
```

**Key takeaway:** Concurrent cart versions are detected with **vector clocks** and merged by **union (add-wins)**, with **tombstones for removals** so a delete isn't resurrected — the [kv-store](../kv-store/) conflict-resolution pattern applied to carts.

---

### A13. Does add-to-cart reserve inventory?

| Option | Verdict |
|---|---|
| Reserve stock at add-to-cart | ❌ Usually **no** — carts are abandoned ~70%+; reserving would lock inventory for browsers and cause false "out of stock" |
| Reserve at checkout start (TTL hold) | ✅ Reserve when the user *begins checkout*, with a short TTL, released on abandon (A19) |
| Deduct only at order commit | ✅ The authoritative decrement happens in the order transaction (A16) |

**Key takeaway:** **Add-to-cart does not reserve stock** (carts are abandoned too often) — you place a short **TTL hold at checkout start** and do the authoritative decrement at order commit.

---

### A14. Guest vs logged-in carts + merge on login

```text
Guest cart:     keyed by an anonymous device/session id, TTL (e.g. days–weeks).
Logged-in cart: keyed by user_id, durable.

On sign-in: MERGE guest cart into the user cart (union of items, same conflict rules as A12),
then discard the guest cart. De-dupe SKUs (sum or max qty per policy).
```

**Key takeaway:** Guest carts are session-keyed with a TTL; on sign-in you **merge the guest cart into the account cart** using the same union/tombstone rules, then drop the guest copy.

---

## Level 4 — Checkout, Orders & No-Oversell

### A15. Checkout flow — atomic vs eventual

```text
SYNCHRONOUS core (must be atomic-ish, user waits for an answer):
  1. Re-validate cart against source of truth (price, availability)
  2. Reserve/decrement inventory (guarded — A16)
  3. AUTHORIZE payment (not capture — A18)
  4. Create Order row (state=CREATED/PAID) + write OUTBOX event   ← one DB txn
  5. Return "order confirmed" to the user

ASYNC (eventually consistent, fired via OrderPlaced event):
  warehouse allocation, shipping label, confirmation email, analytics, loyalty points
```

Only steps 1–4 block the user; everything downstream is async so a spike can't melt checkout.

**Key takeaway:** Make the **order-commit core synchronous** (revalidate → reserve stock → authorize payment → write order+outbox in one txn) and fire **everything after as events** — the customer waits only for the money-and-stock decision.

---

### A16. Never oversell the last unit

```text
Guarded conditional decrement (the ONLY real oversell guard):

  UPDATE inventory
     SET reserved = reserved + :qty
   WHERE sku_id = :sku AND (on_hand - reserved) >= :qty;
  -- 0 rows updated ⇒ SOLD OUT ⇒ reject this checkout

Optimistic (version/CAS) scales better than pessimistic row locks under contention;
under EXTREME contention on one SKU (flash sale), front it with a Redis atomic
decrement / a queue so the SQL row isn't the bottleneck (A26).
```

This is exactly the [seat-reservation](../seat-reservation/) no-oversell concurrency problem.

**Key takeaway:** Prevent oversell with a **single conditional decrement** (`WHERE available >= qty`; 0 rows ⇒ sold out) — optimistic/CAS by default, fronted by a Redis atomic counter or queue for a hot SKU (the [seat-reservation](../seat-reservation/) pattern).

---

### A17. Exactly one order, one charge

```text
Client generates an Idempotency-Key (UUID) per checkout attempt; retries reuse it.

Server:
  INSERT order (idempotency_key UNIQUE) ...
    - success  → first time → proceed
    - conflict → key already exists → RETURN the existing order (don't create a 2nd)

Payment call also carries the key so the PSP dedupes the charge.
```

**Key takeaway:** An **idempotency key** (unique on the order row + passed to payment) makes `POST /orders` safe to retry — a double-click or network retry returns the *same* order and never creates a second charge ([api-design](../api-design/), [distributed-transactions](../distributed-transactions/)).

---

### A18. Authorize-then-capture

```text
AUTHORIZE at checkout:  reserve funds on the card (hold), don't move money yet.
CAPTURE at fulfillment: actually charge when the item SHIPS.
VOID/expire:            if the order is cancelled before ship → release the auth, no charge.

Why: you shouldn't take money for goods you haven't shipped; auth confirms the card is good
and funds exist, capture commits the sale at the last responsible moment.
```

Payment coordination is a saga step (A20); deeper ledger/PSP/chargeback design → [payment-system](../payment-system/).

**Key takeaway:** **Authorize at checkout, capture on ship** — you confirm funds up front but only move money when you actually fulfill, and a pre-ship cancel just voids the hold (no charge).

---

### A19. TTL inventory hold during checkout

```text
On "begin checkout":  place a hold in Redis:  hold:{sku}:{order} = qty, EXPIRE 10 min
                      decrement available-to-promise by held qty.
On order commit:      convert hold → real reservation/decrement (A16).
On abandon/timeout:   TTL expires → hold auto-released → stock returns to available.
```

So a slow payment can't let two people buy the same last unit, and abandoned checkouts don't leak stock. Same TTL-hold pattern as [seat-reservation](../seat-reservation/).

**Key takeaway:** Hold stock with a **Redis TTL reservation at checkout start** — a slow payment can't oversell, and an abandoned checkout **auto-releases** the hold when the TTL expires ([seat-reservation](../seat-reservation/)).

---

## Level 5 — Order Orchestration

### A20. Consistency across services with no shared transaction

```text
Order placement spans Payment, Inventory, Order, Shipping — each owns its DB.
No 2PC across them (slow, blocking, poor availability). Use a SAGA:

  a sequence of local transactions, each with a COMPENSATING action:
    reserve inventory     ↔ release inventory
    authorize payment     ↔ void authorization
    create order          ↔ cancel order
  if a later step fails, run the compensations for the earlier ones (backward recovery).
```

Depth: [distributed-transactions](../distributed-transactions/) (saga vs 2PC).

**Key takeaway:** Use a **saga** (local txn per service + a compensating action each) rather than 2PC across service-owned databases — on failure you run compensations backward, trading atomicity for availability ([distributed-transactions](../distributed-transactions/)).

---

### A21. Choreography vs orchestration

| | Choreography (events only) | Orchestration (a coordinator) |
|---|---|---|
| Control | Each service reacts to events | A central saga orchestrator drives steps |
| Coupling | Loose; no central brain | Explicit workflow in one place |
| Visibility | Harder to see the whole flow | Easy to see/track state |
| Best for | Simple, few steps | Complex flows with many branches/compensations (checkout) |

For checkout with real money + compensations, **orchestration** (an Order/Saga orchestrator) is usually clearer and easier to debug; choreography suits simple downstream fan-out (email, analytics).

**Key takeaway:** Prefer an **orchestrated saga** for the money-critical checkout flow (one place owns state + compensations) and **choreography** for loose downstream fan-out; the compensations are release-stock, void-auth, cancel-order.

---

### A22. Transactional outbox (no dual-write loss)

```text
Problem: "write Order to DB" + "publish OrderPlaced to Kafka" is a DUAL WRITE — a crash
between them loses the event (order exists, nobody fulfills) or vice versa.

Fix — OUTBOX: in ONE local DB transaction, write the Order row AND an outbox row.
A relay (CDC/poller) reads the outbox and publishes to Kafka at-least-once, marking sent.
  → the event is durable iff the order is durable (same txn) — no lost/orphan event.
```

Depth: [message-queues](../message-queues/).

**Key takeaway:** Use the **transactional outbox** — commit the order and an outbox row in one DB txn, then a relay publishes the event — so the `OrderPlaced` event can never be lost or orphaned relative to the order ([message-queues](../message-queues/)).

---

### A23. Order state machine

```text
CREATED ──auth ok──▶ PAID ──allocated──▶ FULFILLING ──▶ SHIPPED ──▶ DELIVERED
   │                   │                     │                          │
   │ auth fail         │ cancel (pre-ship)   │ warehouse fail            ▼
   ▼                   ▼  → void auth         ▼  → reallocate         RETURN_REQUESTED
 FAILED             CANCELLED             (retry / DLQ)                   │
                                                                          ▼
                                                                    REFUNDED
```

Each transition is event-driven and idempotent; capture happens on SHIPPED, refund on REFUNDED.

**Key takeaway:** Model the order as an explicit **state machine** (`CREATED→PAID→FULFILLING→SHIPPED→DELIVERED`, plus `CANCELLED/FAILED/RETURNED/REFUNDED`) with idempotent, event-driven transitions — capture on ship, refund on return.

---

### A24. Payment succeeded but OrderPlaced event lost

```text
Detection & recovery:
  - Outbox (A22) makes this nearly impossible — the event is committed with the order.
  - Belt-and-suspenders RECONCILIATION job: periodically scan PAID orders with no
    fulfillment progress after T minutes → re-emit OrderPlaced (idempotent consumers
    dedupe by order_id) → fulfillment proceeds.
  - Payments captured with no matching order (or reverse) are flagged for ops.
```

**Key takeaway:** The **outbox** prevents the lost event by construction; add a **reconciliation sweep** for `PAID`-but-not-progressing orders that re-emits the event (idempotent consumers dedupe), so no paid order is ever stranded.

---

## Level 6 — Inventory & Fulfillment at Scale

### A25. Multi-warehouse inventory & allocation

```text
Inventory is per (sku, warehouse). "Available to promise" is summed across warehouses
(with holds subtracted). Order allocation chooses a warehouse by:
  - proximity to the shipping address (fewer/faster/cheaper legs)
  - stock availability + balancing load across FCs
  - split shipment if no single FC has all items

Source of truth: per-FC inventory records; a rollup view for "available to promise."
```

**Key takeaway:** Track inventory **per (SKU, warehouse)**, compute a summed *available-to-promise*, and **allocate an order to the nearest FC with stock** (splitting shipments when needed) — allocation is an optimization over proximity, stock, and load.

---

### A26. Prime Day thundering herd on one SKU

```text
100K buyers hit one discounted SKU at 10:00:00 → the SQL inventory row is a hot lock.

Mitigations (layered):
  - Front the counter with a Redis ATOMIC DECR (or a per-SKU token bucket of N units);
    only winners proceed to the SQL decrement → the DB sees N writes, not 100K.
  - WAITING ROOM / queue: admit buyers at a controlled rate (fairness + backpressure).
  - Rate-limit per user/IP to blunt bots ([rate-limiting]).
  - Shard/partition the counter for a single ultra-hot SKU if even Redis is hot.
  - Fail fast + clearly ("sold out") rather than queueing everyone behind a lock.
```

Same flash-sale problem as [seat-reservation](../seat-reservation/).

**Key takeaway:** For a hot-SKU herd, **gate demand before the DB** — a Redis atomic counter / token bucket of the available units (+ a waiting room + rate limits) means the SQL row sees only as many writes as there is stock, not 100K ([seat-reservation](../seat-reservation/)).

---

### A27. Distributed inventory: reserve-and-reconcile vs oversell-and-apologize

| Approach | Upside | Downside |
|---|---|---|
| **Strict global count** (reserve across all FCs synchronously) | Never oversells | Slow, contention, hurts availability at scale |
| **Per-region reserve + async reconcile** | Fast, available | Rare oversell at boundaries → reconcile |
| **Oversell-then-apologize** | Max availability/throughput | Occasional cancel + apology/refund (acceptable for cheap, deep-stock items) |

Real systems tune by item: scarce/expensive → strict; deep-stock commodity → looser with reconciliation. Amazon-style AP thinking: availability often wins, reconcile the rare conflict.

**Key takeaway:** Global strict counting doesn't scale, so you **reserve regionally and reconcile** — accepting a rare oversell-then-apologize for deep-stock items while reserving strictly for scarce ones; it's a per-item availability-vs-correctness dial.

---

### A28. Shipping service down during peak — degrade gracefully

```text
Checkout does NOT call shipping synchronously → shipping is a downstream CONSUMER of
OrderPlaced. So if shipping is down:
  - orders still commit (payment auth + inventory reserve + order row) and confirm to users
  - OrderPlaced events pile up in Kafka (durable backlog), not lost
  - when shipping recovers, it drains the backlog; SLAs slip but no order is lost
Set consumer lag alerts; DLQ poison messages ([message-queues], [observability]).
```

**Key takeaway:** Because fulfillment is an **async consumer**, a shipping outage just **backs up as a durable Kafka backlog** — orders keep placing and confirm to customers, and shipping catches up on recovery (the whole point of the event-driven split).

---

## Level 7 — Consistency, Freshness & Data

### A29. Stale price must not be honored at checkout

```text
Browse (eventual): the edge/cache/search may show an old price for seconds — acceptable UX.
Checkout (strong): RE-READ price from the source of truth at order commit and charge THAT.
  - if it changed vs what the user saw → surface it ("price updated") before charging,
    or honor the shown price within a small grace per policy.
Propagation: price change → CDC → purge CDN by surrogate key + invalidate Redis + update index.
```

Same immutable-version + authoritative-recheck pattern as [food-delivery](../food-delivery/) menus.

**Key takeaway:** Browse prices are **eventually consistent**, but checkout **re-reads price from the source of truth** and charges that (surfacing changes) — CDC-driven purge keeps caches/search fresh, but the *guard* is the authoritative re-read at commit.

---

### A30. Read-your-writes after an order / listing edit

```text
Problem: user places an order (write to primary) then opens "My Orders" (served by a
read replica with replication lag) → order missing.

Fixes:
  - Route read-your-writes to the PRIMARY for a short window after a write, or
  - Sticky/"read from primary until replica caught up to my write LSN", or
  - Serve the just-written entity from a write-through cache the user's session reads.
```

Depth: [sharding-replication](../sharding-replication/).

**Key takeaway:** Give the editing user **read-your-writes** by routing their reads to the primary (or a session cache) for a short window after their write, so replication lag never shows them stale "my orders" / "my listing" ([sharding-replication](../sharding-replication/)).

---

### A31. Sharding products & orders; hot keys

```text
Products:  shard by product_id (hash) — reads dominate → lean on cache + replicas,
           so the DB shard rarely the bottleneck. A viral product = a HOT KEY →
           cache it hard (CDN + Redis), request-coalesce origin misses.
Orders:    shard by user_id (a user reads their own orders) or order_id; keep a user's
           orders co-located. Hot customer (a huge seller) → dedicated shard / further split.
Inventory: shard by sku/warehouse; hot SKU handled by A26.
```

Depth: [sharding-replication](../sharding-replication/), [consistent-hashing](../consistent-hashing/).

**Key takeaway:** Shard **products by product_id, orders by user_id, inventory by SKU/warehouse**; handle a hot product with **caching + request coalescing** (not more DB shards) and a hot seller/SKU with a dedicated split.

---

### A32. Returns, refunds, chargebacks

```text
Model returns as first-class order sub-states + a payment ledger:
  Order → RETURN_REQUESTED → RETURN_RECEIVED → REFUNDED
  Payment ledger: authorize / capture / refund / chargeback are append-only ledger entries
                  tied to order_id (never mutate a charge — append a compensating entry).
Refund = a compensating financial transaction; restock inventory on receipt.
Chargeback = bank-initiated reversal → record, reconcile, dispute workflow.
```

Deeper double-entry ledger + PSP reconciliation → [payment-system](../payment-system/); order-side saga → [distributed-transactions](../distributed-transactions/).

**Key takeaway:** Treat refunds/chargebacks as **append-only ledger entries + explicit order sub-states** (never mutate the original charge — append a compensating entry), with inventory restocked on receipt; deep ledger design belongs in [payment-system](../payment-system/).

---

## Level 8 — Scale, Peak & Fault Tolerance

### A33. Black Friday capacity + degradation

```text
Plan:
  - Pre-scale (capacity reservation) + autoscale the stateless tiers ahead of the event.
  - CACHE EVERYTHING browseable; serve static/edge fallbacks if origin is stressed.
  - LOAD SHED by priority: protect checkout/payment; degrade recommendations, reviews,
    "customers also bought" first.
  - WAITING ROOM / queue for hot drops to bound concurrency (A26).
  - Async everything post-commit so spikes become Kafka backlog, not checkout failures.
  - Graceful "try again" over hard errors; idempotency makes retries safe.
```

**Key takeaway:** Survive peak by **caching browse to the edge, shedding low-value features first to protect checkout, queueing hot drops, and pushing all post-commit work async** — degrade the periphery, never the buy button.

---

### A34. Multi-region / global

```text
GLOBAL:   catalog + product content + search (read-mostly) → replicate/CDN everywhere.
REGIONAL: orders, inventory, payments → pinned to a region (data residency, latency,
          and a clear write authority). Route users to their region.
Failover: catalog reads fail over easily (replicated); order writes fail over to a
          standby region with defined RPO/RTO. Cross-region order = rare, handled explicitly.
```

Depth: [cdn-edge](../cdn-edge/), [sharding-replication](../sharding-replication/).

**Key takeaway:** Make **catalog global (replicated/CDN)** and **orders/inventory/payments regional** (residency + a single write authority per region), with easy read failover and a defined RPO/RTO for order-write failover.

---

### A35. Observability for the buy funnel

```text
Business SLOs (the ones that matter):
  - add-to-cart success rate         (cart availability)
  - checkout/order success rate      (the money funnel)
  - oversell rate / negative stock   (correctness alarm — should be ~0)
  - payment auth success rate
Tech SLIs: product-page p99 latency, cache hit ratio, Kafka consumer lag, error budgets.
Trace the funnel end-to-end (distributed tracing) to localize drop-off.
```

Depth: [observability](../observability/).

**Key takeaway:** Monitor the **business funnel** (add-to-cart, checkout success, oversell rate, payment success) alongside tech SLIs (p99, cache hit, consumer lag) — the oversell rate is a correctness alarm that should sit at ~0 ([observability](../observability/)).

---

### A36. Abuse & fraud

| Threat | Where to detect / block |
|---|---|
| Scalping/sneaker bots at drop | Rate limit + CAPTCHA + waiting room + per-user purchase caps ([rate-limiting](../rate-limiting/)) |
| Payment fraud | Risk scoring at authorize; velocity checks; 3-D Secure |
| Coupon/promo abuse | One-use codes, per-account limits, server-side validation |
| Fake reviews | Verified-purchase gate, anomaly detection |
| Inventory hoarding | Cart/hold TTLs + purchase caps |

**Key takeaway:** Push abuse defense to **the earliest choke point** — rate-limit + purchase caps + waiting room for bots, risk-scoring at payment auth, server-side one-use coupon validation, and verified-purchase gating for reviews.

---

### A37. Catalog cache/DB degrades at peak — keep browsing + buying alive

```text
Browsing:  serve STALE from CDN/edge (stale-while-revalidate); a slightly old product page
           beats an error. Degrade to a cached "static" catalog if origin is down.
Buying:    checkout re-reads price/stock from the SOURCE OF TRUTH — if that tier is
           degraded, protect it via load shedding of browse traffic so checkout gets capacity;
           circuit-break non-essential enrichments; keep the order+inventory+payment core up.
Never couple browse failures to checkout — they're different tiers on purpose.
```

**Key takeaway:** On a catalog outage, **serve stale browse from the edge (stale-while-revalidate)** and **shed browse load to protect the checkout core** — the browse/checkout tier split exists precisely so one can degrade without taking down the other.

---

## Level 9 — Frontend Architecture (Architect)

### A38. Rendering strategy for listing & product pages

| Page | Strategy | Why |
|---|---|---|
| Product detail (SEO-critical) | **SSR or SSG/ISR** | Crawlable HTML + fast first paint; ISR revalidates on a TTL so content stays fresh without rebuilds |
| Category/listing | **SSG/ISR + client hydration** | Mostly static + facet filtering client-side |
| Personalized blocks (reco, "for you") | **Client-side / streamed after shell** | Personalization can't be statically cached — load it after the cacheable shell |
| Cart/checkout | **CSR (authenticated, dynamic)** | User-specific, not cacheable, no SEO need |

Serve the **cacheable shell fast (SSR/edge)**, then hydrate the personalized, non-cacheable parts.

**Key takeaway:** **SSR/SSG/ISR the SEO-critical, cacheable shell** (product/listing pages) for crawlability + fast first paint, and **stream personalized blocks client-side** afterward — never block first paint on per-user data.

---

### A39. Client cart state

```text
- OPTIMISTIC add-to-cart: update local cart UI instantly, sync to server in background.
- Server cart is the durable truth (AP store); client reconciles on load/login.
- Cross-device: cart keyed by user_id server-side; client refetches on focus/login (A14 merge).
- Offline: queue cart mutations locally, flush on reconnect (idempotent by client op id).
- CHECKOUT re-sync: re-fetch authoritative price + availability before showing the pay step
  so the user never gets a "price changed" surprise at the last moment.
```

**Key takeaway:** Cart UI is **optimistic + locally cached**, backed by the durable server cart, synced across devices by `user_id`, queued offline, and **re-synced against the source of truth right before payment** so the total is never a surprise.

---

### A40. Checkout UX — idempotent, no double-submit

```text
- Multi-step form state kept client-side (address → shipping → payment → review); resumable.
- Generate ONE Idempotency-Key when the user enters checkout; reuse it for every submit/retry
  → server dedupes (A17). Disable the button on submit + show a spinner.
- Payment redirects / 3-D Secure: persist checkout state before redirect; on return, resume
  by idempotency key (the order may already exist → show confirmation, don't re-place).
- Handle back-button / refresh mid-payment safely via that same key.
```

**Key takeaway:** Mint **one idempotency key at checkout start** and reuse it across submits, retries, and payment redirects/3-DS returns — combined with disabling the submit button, this makes a double-submit or back-button impossible to turn into two orders.

---

### A41. Flaky network across the funnel

```text
- Optimistic UI for cart; queue + retry with backoff for mutations; idempotency keeps retries safe.
- Never lose a cart: local persistence + server sync; reconcile on reconnect.
- Never double-place an order: idempotency key + disabled submit + "order already placed" resume.
- Show honest state ("saving…", "offline — will retry") instead of silent failure or fake success.
- Distinguish "request maybe succeeded" (timeout) → re-query by idempotency key, don't blindly resend.
```

**Key takeaway:** Across a flaky funnel, lean on **optimistic UI + local persistence + idempotent retries**: a cart is never lost, an order is never double-placed (re-query by key on ambiguous timeouts), and the UI always shows honest sync state.

---

### A42. Performance & conversion

```text
- Core Web Vitals (LCP/INP/CLS) directly correlate with conversion — a slow product page
  or janky checkout loses sales measurably.
- Code-split by route (product / cart / checkout); ship minimal JS on the SEO pages.
- Optimize images (responsive, modern formats, CDN) — images are most of a product page's bytes.
- Prefetch the likely next step (hover product → prefetch detail; enter cart → prefetch checkout).
- Keep checkout lean: fewer third-party scripts, defer analytics, inline critical CSS.
```

**Key takeaway:** Treat **funnel latency as a revenue metric** — optimize Core Web Vitals, code-split by route, CDN-optimize images, and prefetch the next step, because a faster product page and checkout convert measurably better.

---

## Bonus — Senior-Unprompted

### QB1. Buy-Now / 1-Click
```text
Stored default payment method + shipping address → skip cart & multi-step checkout, place
directly. Same order pipeline (idempotency, inventory guard, saga) — just a pre-filled fast
path. Risk: accidental orders → a short cancel window; and it raises the bar on stored-payment
security. (Amazon famously patented 1-Click — verify.)
```
**Key takeaway:** 1-Click is a **pre-filled fast path over the same order pipeline** (stored payment+address, skip the cart) — you still run idempotency, the inventory guard, and the saga; add a short cancel window for accidental taps.

---

### QB2. Marketplace / multi-seller cart
```text
One cart, items from many sellers → split at checkout into per-seller ORDERS/SHIPMENTS
(each fulfilled + shipped independently). One customer payment, then SPLIT SETTLEMENT to
each seller (minus platform fee), tracked in a ledger. Partial cancel/refund is per sub-order.
```
**Key takeaway:** A multi-seller cart **splits into per-seller orders/shipments** with **one charge and split settlement** (platform fee retained), so fulfillment, cancellation, and refunds are handled per sub-order.

---

### QB3. Pricing & promotions engine
```text
Final price = base − promotions ± tax ± shipping, computed AUTHORITATIVELY server-side at
checkout (never trust an edge-cached price). A rules/promo engine evaluates coupons,
cart-level discounts, tiered deals; caches only stable inputs. Tax via a tax service by
jurisdiction. Show an estimate on browse; commit the real total at checkout (A29).
```
**Key takeaway:** Compute the **final price authoritatively server-side at checkout** (base − promos ± tax ± shipping) via a rules engine — the edge shows an estimate, but the charged total is always the server's re-computation.

---

### QB4. Recommendations in the funnel
```text
"Frequently bought together" / "customers also bought" = precomputed co-purchase /
embedding-based lists, looked up on the hot path and hydrated from the catalog cache.
Placed at product page, cart ("add these"), and post-purchase. Offline compute, online read
([recommendation-system]).
```
**Key takeaway:** Funnel recommendations are **precomputed offline (co-purchase/embeddings) and read on the hot path**, placed at product/cart/post-purchase — the [recommendation-system](../recommendation-system/) "compute offline, look up online" pattern.

---

### QB5. Inventory as an event-sourced ledger
```text
Instead of a single mutable count, record every stock MOVEMENT as an append-only event
(received +N, reserved −q, released +q, shipped −q). Current stock = fold over events.
Buys: full auditability ("why is this SKU at 3?"), easy reconciliation, time-travel, and
natural idempotency (dedupe events). Snapshot the fold for fast reads.
```
**Key takeaway:** An **event-sourced inventory ledger** (append every movement, stock = fold) gives auditability, reconciliation, and idempotency for free — snapshot the running total for fast reads (same WAL/snapshot idea as [storage-engines](../storage-engines/)).

---

### QB6. Digital vs physical goods
```text
Digital (ebooks, keys, subscriptions): "inventory" is often unlimited or license-pool bound;
no warehouse/shipping — fulfillment = grant entitlement / deliver a download link + license.
Capture can be immediate (nothing to ship). Physical: finite stock, warehouse allocation,
carrier, delivery tracking, returns/restock.
```
**Key takeaway:** Digital goods **skip warehouse/shipping** — fulfillment is granting an entitlement and capture can be immediate — while physical goods carry the full stock/allocation/carrier/return path; the order pipeline is shared, the fulfillment leg differs.

---

## ⚡ Quick Revision Cheatsheet

### Scale numbers (order-of-magnitude — verify)

```text
Orders:        20M/day ≈ 230/s avg; Prime-Day peak (~50×) ~10^4/s
Product views: ~40/order → ~9K/s avg; peak ~10^6/s   ← reads dominate ~1000:1
Catalog:       ~10^8–10^9 SKUs (marketplace)
Conversion:    ~2–3% → most traffic is browsing, not buying
Guarantee bar: oversell rate ≈ 0; double-charge ≈ 0; cart-availability ≈ 100%
```

### Key technology choices

| Component | Choice | Why |
|---|---|---|
| Product reads | CDN → Redis → DB replicas | ~90%+ of traffic; cache by immutable version |
| Search | Elasticsearch fed by CDC | full-text ∩ facets ∩ in-stock, kept fresh async |
| Cart | DynamoDB/Cassandra (AP) | never reject add-to-cart; merge conflicts |
| Orders | SQL + transactional outbox | transactional, idempotent, durable money record |
| Inventory | SQL guarded decrement + Redis TTL hold | the only real oversell guard; hot-SKU gate |
| Payment | authorize→capture, idempotency key | no charge before ship; retry-safe |
| Orchestration | Kafka + saga + outbox | async fulfillment; compensations on failure |

### Canonical tradeoffs to memorize

- **Consistency gradient:** browse (eventual) · cart (available/AP) · checkout (strong) · fulfill (async) — different CAP points, different infra.
- **Cart AP vs checkout CP:** never reject an add (availability) vs never oversell/double-charge (consistency).
- **Saga vs 2PC:** compensations + availability vs blocking atomicity across service DBs.
- **Reserve-and-reconcile vs oversell-and-apologize:** correctness vs availability, tuned per item.
- **Authorize vs capture:** confirm funds at checkout, move money on ship.
- **Read path vs write path:** cache/replicate the huge read path; optimize correctness on the small write path.

### Common interview mistakes to avoid

- One database / one consistency model for the whole platform (ignoring the gradient).
- Treating the stock **badge** as the oversell guard instead of the **checkout decrement**.
- A strongly-consistent cart that rejects writes during a partition (lost revenue).
- Charging (capturing) at checkout instead of **authorize-then-capture-on-ship**.
- Dual-writing order + event without an **outbox** (lost/orphan events).
- Synchronous call chain for fulfillment → a spike melts checkout instead of queueing.
- No **idempotency key** → double-click = double order/charge.
- Serving search from the catalog DB instead of a **CDC-fed index**.
- Forgetting **read-your-writes** → "my order" missing right after placing it.
