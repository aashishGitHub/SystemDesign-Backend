# Deep Dive: E-Commerce Platform (Amazon / Shopify)

> Each chapter has three depths: 🟢 **Beginner** (analogy + intuition), 🟡 **Senior** (implementation + tradeoffs), 🔴 **Architect** (scale, failure modes, production reality).
> This is an **umbrella topic** — depth that belongs to a neighbouring topic is cross-linked, not repeated: [kv-store](../kv-store/) (cart / Dynamo / vector clocks), [seat-reservation](../seat-reservation/) (no-oversell, TTL holds, flash sale), [distributed-transactions](../distributed-transactions/) (saga, idempotency, payment coordination), [message-queues](../message-queues/) (Kafka, outbox, DLQ), [distributed-caching](../distributed-caching/) / [cdn-edge](../cdn-edge/) (catalog reads), [search-autocomplete](../search-autocomplete/) / [recommendation-system](../recommendation-system/) (discovery), [sharding-replication](../sharding-replication/) (data), [rate-limiting](../rate-limiting/) (abuse), [observability](../observability/) (funnel SLOs). A dedicated **payment-system** deep-dive (ledger, PSP reconciliation, chargebacks) is ROADMAP Problem 16 — not yet built; payment coordination here delegates to [distributed-transactions](../distributed-transactions/).
>
> **Accuracy note:** Amazon-scale figures below are order-of-magnitude *planning* numbers to verify against primary sources, not published facts. Claims about *how a specific vendor implements* something are hedged ("verify") — informed illustration, not authoritative internals.

## Table of Contents

1. The Consistency Gradient — Why Four Stages
2. Catalog & Product — The Read Path at Scale
3. The Cart — Availability-First
4. Checkout, Orders & No-Oversell
5. Order Orchestration — Saga & Outbox
6. Inventory & Fulfillment at Scale
7. Consistency, Freshness & Data
8. Scale, Peak & Fault Tolerance
9. Frontend Architecture
10. Failure Modes
11. Real-World Case Notes
12. Quick Recall Cheat Sheet

---

## 1. The Consistency Gradient — Why Four Stages

### 🟢 Beginner — One shop, four rooms with different rules

Picture a shop with four rooms. In the **window** you display goods — a day-old price sign is a blemish, not a disaster. Then you carry a **basket** — it must never be yanked from your hands, even if the lights flicker. Then the **till**, where the exact price is rung, the card is charged once, and you can't walk out with the last item two people grabbed. Finally the **back room** packs and ships — it must happen, but not while you stand at the till tapping your foot. Four rooms, four different rules: run all four by the till's strict rules and browsing crawls; run the till by the window's loose rules and you charge the wrong price twice.

### 🟡 Senior — The gradient: consistency rises toward the money

The design's first cut is by *what has to be agreed and how much staleness is tolerable*. As the shopper moves browse → cart → checkout → fulfill, required consistency **rises** and tolerable staleness **falls** — and the cost of a mistake climbs with it.

| Stage | Read/write | Consistency it needs | Availability | Right infra |
|---|---|---|---|---|
| **Browse** | Read-heavy (~90%+) | Eventual (stale price/stock OK to *show*) | High | Cache + CDN + read replicas |
| **Cart** | Read/write, per-user | Convergent (merge OK) | **Highest** — never reject an add | AP KV store (Dynamo-style) |
| **Checkout** | Write, transactional | **Strong** — no oversell / double-charge | High but may reject | SQL source of truth + idempotency |
| **Fulfillment** | Write, async | Eventual, reliable | Decoupled | Event bus + saga |

Cost of being wrong tracks the gradient: a stale browse price is a UX blemish; a dropped add-to-cart is *lost revenue*; a bad checkout oversells or double-charges *real money*; fulfillment must happen but not synchronously in the buy request. Each stage sits at a different point on the CAP spectrum, so each needs different infrastructure — the same read-path/write-path split as [food-delivery](../food-delivery/) (browse · order · track). See [answers.md](./answers.md) A1–A2.

### 🔴 Architect — Reads dominate ~1000:1, so you spend effort in two very different places

Back-of-the-envelope (order-of-magnitude — verify):

```text
Assume 20M orders/day, ~2–3% conversion → ~30–50 product-page views per order.

Orders:        20M/day ÷ 86,400 ≈ 230/s avg;  Prime-Day peak (~50×) ~10^4/s
Product views: 20M × 40 = 800M/day ≈ 9K/s avg; peak ~10^6/s     ← DOMINATES
Add-to-cart:   ~2–3× orders (abandonment) ≈ 500–700/s avg
Catalog:       ~10^8–10^9 SKUs (marketplace)

Reads outnumber order-writes by ~1000:1.
```

The consequence is a split of engineering attention: on the **read path** cache aggressively so a product page never touches the DB; on the small, high-value **write path** optimize for **correctness**, not QPS — no oversell, no double-charge, durable orders. One database or one consistency model for the whole platform (ignoring the gradient) is the classic mistake: browse read load starves the order write path, and the order path's strong-consistency needs slow browse. The correct shape is independently-scaled subsystems joined by events.

---

## 2. Catalog & Product — The Read Path at Scale

### 🟢 Beginner — A laminated menu with sticky notes

The product page is mostly a laminated menu — title, photos, description, specs — stable, cheap to photocopy and hand out. But "£19.99 today" and "only 2 left" are sticky notes slapped on top; you don't reprint the whole menu for a sticky note. So you cache the heavy stable body hard, and layer the volatile price/stock on top at read time.

### 🟡 Senior — CDN → Redis → DB replicas, cache the body by an immutable version key

```text
CDN (edge)  ── product JSON + images cached by (product_id, version); most reads end here
   │ miss
Redis cache ── hot products; ~90% of origin reads absorbed here   ([distributed-caching])
   │ miss
Catalog DB (+ read replicas)  ── source of truth (document store)

Render = cached product body  ⊕  live price/availability overlay (fetched separately)
```

Model **Product (the listing) vs SKU (the buyable variant)** — you browse a product, you buy a SKU (a specific size/color):

```text
Product { id, title, brand, category_id, attributes{}, media[], description }   // document
SKU     { id, product_id, options{size:"M", color:"red"}, price_cents, barcode }
Price / Inventory = SEPARATE volatile records — NOT baked into the cached product doc
```

Keeping price/inventory separate is the whole trick: they change often, and if they were embedded, every price tick would force a re-cache of the heavy doc. **Search is a separate concern** — a full-text ∩ facets ∩ in-stock query against an inverted index (Elasticsearch/OpenSearch), *never* the catalog DB, kept fresh asynchronously by a CDC stream. **Recommendations** are precomputed offline (batch + streaming) and merely *looked up* by `user_id` on the hot path, then hydrated from the catalog cache — heavy ranking never runs synchronously in a page load. Depth: [search-autocomplete](../search-autocomplete/), [recommendation-system](../recommendation-system/). See A6–A10.

### 🔴 Architect — Publish, don't mutate; the badge is a hint, not the guard

Invalidation is **version bumping**, not in-place mutation: a catalog edit bumps the product version → a *new immutable cache key* → the old object ages out, and you purge the CDN by surrogate key ([cdn-edge](../cdn-edge/)) — the immutable content-addressing pattern shared with [food-delivery](../food-delivery/) menus. Two things architects must nail:

- **The inventory badge ("Only 2 left") is an eventually-consistent UX hint, not the oversell guard.** Served from cache/overlay, allowed to be stale. Overselling is prevented at exactly *one* place — the guarded decrement at checkout (Ch. 4). Fast badge propagation only shrinks the disappointment window.
- **A viral product is a hot key.** You don't shard your way out of it; you cache it hard (CDN + Redis) and **request-coalesce** origin misses so a herd of misses collapses into one DB read (Ch. 7).

---

## 3. The Cart — Availability-First

### 🟢 Beginner — A basket nobody is allowed to snatch

The cart is the basket the shopper carries. The one unforgivable sin is snatching it away — a failed add-to-cart is a shopper who was ready to spend and got a door slammed in their face. So the cart *always* accepts an add, even if part of the system is having a bad day. If two of your devices disagree about the basket, you sort that out *later* by combining them — you never refuse the item in the moment.

### 🟡 Senior — Dynamo-style AP store, conflicts merged at read

A rejected add-to-cart is directly lost revenue, so the cart must accept writes even during a partition — that is the definition of an **AP** system. This is the canonical Amazon Dynamo example ([kv-store](../kv-store/)).

```text
Cart model (AP KV):
  key   = cart:{user_id}
  value = { items:[{sku_id, qty, added_at}], version / vector_clock }
  store = DynamoDB / Cassandra (always writable, reconcile later)
```

When a phone (online) and a laptop (was offline) both edit `cart:{user}`, the two versions **diverge**:

```text
- vector clocks / version vectors detect the two versions are CONCURRENT
  (neither descends the other)
- MERGE by UNION of items (add-wins); for the same SKU take max qty or sum per policy
- a REMOVE is trickier — a naive union RESURRECTS a deleted item → use a TOMBSTONE
  ("removed" marker) so a delete on one device isn't undone by a stale add on the other
```

This is exactly the [kv-store](../kv-store/) conflict-resolution pattern applied to carts. See A11–A14.

### 🔴 Architect — Add-to-cart does NOT reserve stock; guest carts merge on login

The single most-tested cart decision: **adding to the cart does not reserve inventory.** Carts are abandoned ~70%+ (order-of-magnitude — verify), so reserving at add would lock stock for browsers and produce false "out of stock" for real buyers. Reservation happens later — a short **TTL hold at checkout start**, and the authoritative decrement at order commit (Ch. 4).

Guest vs account carts:

```text
Guest cart:     keyed by an anonymous device/session id, TTL (days–weeks)
Logged-in cart: keyed by user_id, durable

On sign-in: MERGE guest cart into the user cart (same union/tombstone rules as above),
            de-dupe SKUs (sum or max qty per policy), then discard the guest copy.
```

The recurring mistake is a *strongly-consistent* cart that rejects writes during a partition — correct for the till, catastrophic for the basket.

---

## 4. Checkout, Orders & No-Oversell

### 🟢 Beginner — A hold on your card, and the one real gate for the last item

When you check into a hotel they don't charge you — they put a *hold* on your card; leave early and the hold vanishes. Checkout works the same: we hold the money when you tap Place Order and only take it once the goods ship. And when two people grab the last unit at the same instant, exactly **one** gate decides who gets it — a single check at the till. Everything else (the "in stock" badge, the cart) is a hint; only that gate is the truth.

### 🟡 Senior — The synchronous commit core, and the ONE oversell guard

```text
SYNCHRONOUS core (user waits for this answer):
  1. Re-validate cart vs source of truth (price, availability)
  2. Reserve / decrement inventory (guarded — see below)
  3. AUTHORIZE payment (a hold, not a capture)
  4. Create Order row (state=CREATED/PAID) + write OUTBOX event   ← ONE DB txn
  5. Return "order confirmed"

ASYNC (fired via the OrderPlaced event):
  warehouse allocation · shipping label · confirmation email · analytics · loyalty
```

Only steps 1–4 block the shopper; everything downstream is async so a spike can't melt checkout. The **only real oversell guard** is a guarded conditional decrement:

```text
UPDATE inventory
   SET reserved = reserved + :qty
 WHERE sku_id = :sku AND (on_hand - reserved) >= :qty;
-- 0 rows updated ⇒ SOLD OUT ⇒ reject this checkout
```

This is the [seat-reservation](../seat-reservation/) no-oversell concurrency problem exactly. **Idempotency** guarantees exactly one order and one charge:

```text
Client mints an Idempotency-Key (UUID) per checkout; retries reuse it.
  INSERT order (idempotency_key UNIQUE) ...
    success  → first time → proceed
    conflict → key exists → RETURN the existing order (no 2nd order)
The same key is passed to the PSP so the CHARGE dedupes too.
```

And a **Redis TTL hold** protects the window between "begin checkout" and "commit":

```text
begin checkout → hold:{sku}:{order} = qty, EXPIRE 10 min; decrement available-to-promise
commit         → convert hold into the real guarded decrement
abandon/timeout→ TTL expires → hold auto-released → stock returns
```

See A15–A19.

### 🔴 Architect — Authorize-then-capture, and taming a hot SKU

**Authorize at checkout, capture on ship.** Authorize places a reversible hold confirming the card is good and funds exist; capture moves money at the last responsible moment — when the item ships. A pre-ship cancel just voids the hold, so the customer is never charged for goods that didn't ship. Deep ledger/PSP/chargeback design is the planned payment-system topic; the order-side coordination is a saga step (Ch. 5).

Concurrency-wise, an **optimistic / CAS** decrement scales better than pessimistic row locks under normal contention. Under *extreme* contention on one SKU (a flash-sale row 100K people hit at once), even the optimistic path makes that SQL row a hot lock — so you front it with a Redis atomic counter or a queue (Ch. 6). Capturing at checkout instead of authorize-then-capture, and dual-writing the order without an outbox, are the two classic money-path mistakes.

---

## 5. Order Orchestration — Saga & Outbox

### 🟢 Beginner — A relay race with a hand-back rule

An order is a relay race: payment passes the baton to inventory, then to the order record, then to shipping. Each runner owns their own leg (their own database) — there's no single referee holding the whole race in one grip. So if a runner drops the baton (a step fails), you can't rewind time; you have a rule for handing the baton *back*: refund the hold, put the stock back, cancel the order. That hand-back rule is a **compensation**.

### 🟡 Senior — Saga (not 2PC), orchestrated, with explicit compensations

Order placement spans Payment, Inventory, Order, Shipping — each owns its DB. A 2PC across them is slow, blocking, and hurts availability, so you use a **saga**: a sequence of local transactions, each with a compensating action.

```text
FORWARD                COMPENSATION (run backward on later failure)
  reserve inventory  ↔  release inventory
  authorize payment  ↔  void authorization
  create order       ↔  cancel order
```

| | Choreography (events only) | Orchestration (a coordinator) |
|---|---|---|
| Control | Each service reacts to events | A central saga orchestrator drives steps |
| Coupling | Loose; no central brain | Explicit workflow in one place |
| Visibility | Harder to see the whole flow | Easy to see / track state |
| Best for | Simple downstream fan-out (email, analytics) | Money-critical flows w/ many compensations (checkout) |

For the money path, prefer an **orchestrated saga** (one place owns state + compensations, easy to debug); use choreography for loose downstream fan-out. The order is an explicit state machine:

```text
CREATED ─auth ok→ PAID ─allocated→ FULFILLING → SHIPPED → DELIVERED
   │ auth fail       │ cancel(pre-ship)→void   │ FC fail→reallocate/DLQ    ▼
   ▼                 ▼                          ▼                    RETURN_REQUESTED
 FAILED           CANCELLED                                                │→ REFUNDED
```

Each transition is event-driven and idempotent; capture happens on SHIPPED, refund on REFUNDED. Depth: [distributed-transactions](../distributed-transactions/). See A20–A24.

### 🔴 Architect — The transactional outbox + a reconciliation backstop

"Write Order to DB" + "publish OrderPlaced to Kafka" is a **dual write** — a crash between them either loses the event (order exists, nobody fulfills) or orphans it. The fix is the **transactional outbox**:

```text
ONE local DB txn: write the Order row AND an outbox row.
A relay (CDC / poller) reads the outbox, publishes to Kafka at-least-once, marks sent.
  → the event is durable IFF the order is durable (same txn) — no lost / orphan event.
```

The outbox makes "order committed but nobody dispatched" structurally impossible. As belt-and-suspenders, a **reconciliation sweep** periodically scans `PAID` orders with no fulfillment progress after *T* minutes and re-emits `OrderPlaced`; idempotent consumers dedupe by `order_id`, so no paid order is ever stranded. Depth: [message-queues](../message-queues/). This is the same structural-outbox + reconciliation pair used in [food-delivery](../food-delivery/).

---

## 6. Inventory & Fulfillment at Scale

### 🟢 Beginner — Many pantries, ship from the nearest that has it

Stock is spread across warehouses like pantries in different cities. "How many can I sell?" is the sum across pantries minus what's already promised. When an order comes in you ship from the closest pantry that has the items (faster and cheaper) — and if no single pantry has everything, you split the order into two parcels.

### 🟡 Senior — Per-(SKU, warehouse) truth, available-to-promise, hot-SKU gating

```text
Inventory is per (sku, warehouse). "Available to promise" (ATP) = Σ on_hand − reserved − holds
Allocation chooses a warehouse by:
  - proximity to the shipping address (fewer / faster / cheaper legs)
  - stock availability + balancing load across FCs
  - split shipment when no single FC has all items
```

The signature scaling event is a **flash sale**: 100K buyers hit one discounted SKU at 10:00:00 and the SQL inventory row becomes a hot lock. Gate demand *before* the DB:

```text
- Front the counter with a Redis ATOMIC DECR (or a per-SKU token bucket of N units);
  only winners proceed to the SQL decrement → DB sees N writes, not 100K.
- WAITING ROOM / queue: admit buyers at a controlled rate (fairness + backpressure).
- Rate-limit per user / IP to blunt bots ([rate-limiting]).
- Shard/partition the counter if even Redis is hot for one ultra-hot SKU.
- Fail fast + clearly ("sold out") rather than queueing everyone behind a lock.
```

Same flash-sale problem as [seat-reservation](../seat-reservation/). See A25–A26.

### 🔴 Architect — Reserve-and-reconcile vs oversell-and-apologize, per item

Strict global counting doesn't scale, so distributed inventory is a per-item availability-vs-correctness dial:

| Approach | Upside | Downside |
|---|---|---|
| **Strict global count** (synchronous reserve across all FCs) | Never oversells | Slow, contention, hurts availability at scale |
| **Per-region reserve + async reconcile** | Fast, available | Rare oversell at boundaries → reconcile |
| **Oversell-then-apologize** | Max availability / throughput | Occasional cancel + apology/refund (OK for cheap, deep-stock items) |

Real systems tune by item: scarce/expensive → strict; deep-stock commodity → looser with reconciliation. The Amazon-style AP instinct — availability often wins, reconcile the rare conflict — is the same "reconcile later" reasoning as the cart, applied to stock. (An event-sourced inventory ledger — append every movement, stock = fold — buys auditability and idempotency; QB5.) See A27.

---

## 7. Consistency, Freshness & Data

### 🟢 Beginner — The window sign can be stale; the till rings the real price

The window sign might show yesterday's price — fine, it's just to draw you in. But the register always rings the *real, current* price. So when a seller changes a price, we don't panic about every cached copy being instantly correct; we just make sure the till re-checks the true price before charging you.

### 🟡 Senior — Authoritative re-read at checkout; read-your-writes; sharding

```text
Browse (eventual): edge/cache/search may show an old price for seconds — acceptable UX.
Checkout (strong): RE-READ price from the source of truth at commit and charge THAT.
  - if it changed vs what the user saw → surface it ("price updated") or honor within a
    small grace per policy — never silently charge a surprise total.
Propagation: price change → CDC → purge CDN by surrogate key + invalidate Redis + reindex.
```

The guard is the authoritative re-read at commit — CDC-driven purge only keeps caches fresh, it is not what protects the charge. **Read-your-writes** covers the "I just placed an order, why isn't it in My Orders?" gap caused by replica lag:

```text
Route the editing user's reads to the PRIMARY for a short window after their write, OR
"read from primary until the replica catches up to my write LSN," OR
serve the just-written entity from a write-through session cache.
```

Sharding follows the access pattern:

```text
Products:  shard by product_id (hash); reads dominate → lean on cache + replicas
Orders:    shard by user_id (a user reads their own orders) — keep a user's orders co-located
Inventory: shard by sku / warehouse; hot SKU handled by Ch. 6
```

Depth: [sharding-replication](../sharding-replication/), [consistent-hashing](../consistent-hashing/). See A29–A32.

### 🔴 Architect — A hot key is cache + coalesce, not more shards

A viral product read-storm is not a sharding problem — adding shards doesn't help a *single* key. You cache it hard (CDN + Redis) and **request-coalesce** origin misses so a stampede of concurrent misses becomes one DB read fanned back to all waiters. A hot *seller* or hot *SKU* is different — genuine write/ownership skew, handled with a dedicated shard / further split. Returns and refunds ride an **append-only payment ledger** (authorize / capture / refund / chargeback are ledger entries tied to `order_id` — never mutate a charge, append a compensating entry) plus explicit order sub-states (`RETURN_REQUESTED → RETURN_RECEIVED → REFUNDED`), stock restocked on receipt; deep ledger design is the planned payment-system topic.

---

## 8. Scale, Peak & Fault Tolerance

### 🟢 Beginner — Black Friday: protect the tills, dim the mood lighting

Black Friday is the shop on its busiest day. You plan ahead — extra staff, more registers — before the doors open. If the crowd still overwhelms you, you choose what to sacrifice: dim the fancy "you might also like" displays and review widgets, but *never* close the tills. The buy button is the last thing you'd let fail.

### 🟡 Senior — Pre-scale, cache browse, shed low-value features to protect checkout

```text
- Pre-scale (capacity reservation) + autoscale the stateless tiers ahead of the event.
- CACHE EVERYTHING browseable; serve static/edge fallbacks if origin is stressed.
- LOAD SHED by priority: protect checkout/payment; degrade recommendations, reviews,
  "customers also bought" FIRST.
- WAITING ROOM / queue for hot drops to bound concurrency (Ch. 6).
- Async everything post-commit → spikes become Kafka backlog, not checkout failures.
- Graceful "try again" over hard errors; idempotency makes retries safe.
```

The organizing idea: **degrade the periphery, never the buy button.** Because fulfillment is an async consumer of `OrderPlaced`, a spike (or a downstream outage) turns into a durable Kafka backlog rather than a synchronous meltdown. See A33, A35–A37.

### 🔴 Architect — Global catalog vs regional orders, and the RPO/RTO you must state

```text
GLOBAL:   catalog + product content + search (read-mostly) → replicate / CDN everywhere.
REGIONAL: orders, inventory, payments → pinned to a region (data residency, latency,
          and a single clear write authority). Route users to their region.
Failover: catalog reads fail over trivially (replicated); order writes fail over to a
          standby region with a DEFINED RPO/RTO. Cross-region order = rare, explicit.
```

The architect answer names the tradeoff *and* the numbers: catalog reads have near-zero RPO/RTO (replicated read-only); order-write failover has a real RPO (in-flight order data you can lose) and RTO (how fast you promote the standby) that you commit to and test. Depth: [cdn-edge](../cdn-edge/), [sharding-replication](../sharding-replication/). See A34.

---

## 9. Frontend Architecture

### 🟢 Beginner — Show it now, confirm it later

The app should feel instant — the cached product page paints immediately, "add to cart" updates the basket right away — but it must never *lie about money*. Anything that costs the customer (the final total, whether the last item is really available) is confirmed with the server before they pay. Fast for the eyes, exact at the wallet.

### 🟡 Senior — SEO shell server-rendered, personalization streamed, cart optimistic

```text
Product / listing (SEO-critical)  → SSR or SSG/ISR : crawlable HTML + fast first paint;
                                    ISR revalidates on a TTL so it stays fresh w/o rebuilds
Personalized blocks (reco, "for you") → CLIENT-side / streamed AFTER the cacheable shell
Cart / checkout                   → CSR (authenticated, dynamic, no SEO need)
```

Serve the **cacheable shell fast** (SSR/edge), then hydrate the personalized, non-cacheable parts — never block first paint on per-user data. Cart UI is **optimistic + locally cached**, backed by the durable AP server cart, synced across devices by `user_id`, and — critically — **re-synced against the source of truth right before the pay step** so the total is never a last-moment surprise. See A38–A39.

### 🔴 Architect — Idempotent checkout, 3-DS resume, and Core Web Vitals as revenue

```text
- Mint ONE Idempotency-Key when the user enters checkout; reuse it across every
  submit / retry → server dedupes (Ch. 4). Disable the submit button + show a spinner.
- Payment redirects / 3-D Secure: PERSIST checkout state before redirect; on return,
  resume by idempotency key (the order may already exist → show confirmation, don't re-place).
- Ambiguous send (request sent, response lost): RE-QUERY by key, don't blindly resend.
- Offline: queue cart/order mutations locally; flush on reconnect (safe via idempotency).
- Core Web Vitals (LCP/INP/CLS) correlate directly with conversion — a slow product page
  or janky checkout loses sales measurably. Code-split by route, CDN-optimize images,
  prefetch the likely next step, keep checkout lean (defer analytics, inline critical CSS).
```

Two rules keep a flaky-network client correct: every mutating action carries an idempotency key (retries can't double-order), and the client **never owns money/availability truth** (the server re-validates at checkout). Treat funnel latency as a revenue metric, not a vanity one. See A40–A42.

---

## 10. Failure Modes

### 🔴 Catalog cache / DB tier degrades at peak
- **Symptom:** product pages slow or error as the cache/DB tier saturates.
- **Guard:** serve **stale from CDN/edge** (stale-while-revalidate) — a slightly old product page beats an error; degrade to a cached "static" catalog if origin is down. **Shed browse load to protect the checkout core**, which re-reads price/stock from the source of truth. Never couple browse failures to checkout — they are separate tiers on purpose.

### 🔴 Shipping / fulfillment service down during peak
- **Symptom:** warehouse or carrier integration is unavailable while orders keep coming.
- **Guard:** checkout does **not** call shipping synchronously — shipping is a downstream *consumer* of `OrderPlaced`. Orders still commit and confirm to customers; events pile up as a **durable Kafka backlog** (not lost); shipping drains it on recovery. SLAs slip, no order is lost. Set consumer-lag alerts; DLQ poison messages ([message-queues](../message-queues/), [observability](../observability/)).

### 🔴 Payment succeeded but the OrderPlaced event was lost
- **Symptom:** money authorized/captured, but fulfillment never saw the order.
- **Guard:** the **transactional outbox** makes this nearly impossible (event committed in the same txn as the order). Backstop with a **reconciliation sweep**: scan `PAID` orders with no progress after *T* minutes → re-emit `OrderPlaced`; idempotent consumers dedupe by `order_id`. Flag captures with no matching order (or the reverse) for ops.

### 🔴 Oversell under a flash sale
- **Symptom:** the hot SKU's SQL row is a contention hotspot; naive optimistic retries let counts drift, or the row simply can't keep up.
- **Guard:** gate demand **before** the DB — a Redis atomic counter / token bucket sized to the available units, plus a waiting room and per-user rate limits, so the SQL row sees only as many writes as there is stock. The guarded conditional decrement remains the final authority ([seat-reservation](../seat-reservation/)).

### 🔴 Double-charge on retry
- **Symptom:** a double-click, network retry, or back-button turns one checkout into two orders / two charges.
- **Guard:** one **idempotency key** per checkout attempt, `UNIQUE` on the order row and passed to the PSP; a repeat returns the existing order and never a second charge. Combined with a disabled submit button and 3-DS resume-by-key on the client (Ch. 9).

### 🔴 Replication lag → stale "My Orders"
- **Symptom:** user places an order (write to primary) then opens My Orders (served by a lagging read replica) and the order is missing.
- **Guard:** **read-your-writes** — route that user's reads to the primary (or a session write-through cache) for a short window after their write, or read from primary until the replica catches up to their write LSN ([sharding-replication](../sharding-replication/)).

---

## 11. Real-World Case Notes

> Public/observable where possible; internal specifics marked **verify**.

- **Amazon Dynamo shopping cart — the canonical AP example.** The original Dynamo work is widely cited for choosing availability over strong consistency precisely so the cart *never rejects an add*, resolving concurrent versions with vector clocks and application-side merge (add-wins union + tombstones). Treat it as the textbook illustration of the cart's AP choice; exact modern internals — **verify**. Depth: [kv-store](../kv-store/).
- **Authorize-then-capture is standard PSP practice.** Holding funds at checkout and capturing on ship (voiding on pre-ship cancel) is the normal integration pattern across major payment processors — not a vendor-specific trick.
- **Event-driven order pipelines + transactional outbox are common.** Committing the order and an outbox row in one txn, with a relay publishing to a log like Kafka, is a widely-used way to avoid dual-write loss. Broker and topology vary by company; keep the claim generic and **verify** any named vendor's internals.
- **Keep vendor claims generic and hedged.** It's stronger to say "the Dynamo-style AP cart" or "an outbox-plus-saga pipeline" than to assert a named company implements X exactly — you defend the *pattern* and its tradeoffs, which is the point.
- **Payment-system is a dedicated topic (planned).** Ledger, PSP reconciliation, and chargebacks live in ROADMAP Problem 16 — **not yet built**. Until then, payment coordination delegates to [distributed-transactions](../distributed-transactions/) (saga + idempotency).

---

## 12. Quick Recall Cheat Sheet

```text
GRADIENT     browse eventual · cart AP · checkout strong · fulfill async
             consistency + cost-of-error RISE toward the money; infra follows cost
             reads dominate ~1000:1 → cache read path, optimize CORRECTNESS on writes
             QPS (order-of-mag — verify): views ~10^6/s peak · orders ~10^4/s peak

CATALOG      CDN → Redis → DB replicas; cache the BODY by an IMMUTABLE version key
             publish bumps version (never mutate); CDC purge CDN by surrogate key
             render = cached body ⊕ live price/availability OVERLAY (volatile kept separate)
             Product (listing) vs SKU (variant); search = separate CDC-fed Elasticsearch
             reco precomputed offline, LOOKED UP on hot path; stock badge ≠ oversell guard

CART (AP)    never reject an add (lost add = lost revenue); DynamoDB/Cassandra, reconcile later
             concurrent versions: vector clocks detect → MERGE union add-wins + TOMBSTONES
             add-to-cart does NOT reserve stock (~70% abandon); guest cart merges on login

CHECKOUT     sync core: revalidate → reserve → AUTHORIZE → order+OUTBOX (one txn) → confirm
             oversell guard = ONE guarded decrement: WHERE avail >= qty; 0 rows ⇒ sold out
             idempotency key UNIQUE on order + passed to PSP → double-click = one order/charge
             authorize at checkout, CAPTURE on ship, void on pre-ship cancel
             Redis TTL hold at begin-checkout auto-releases on abandon; optimistic/CAS, front hot SKU

ORCHESTRATE  saga (local txn + compensation), NOT 2PC; compensations = release↔void↔cancel
             orchestration for the money path; choreography for loose fan-out
             OUTBOX: order + event in ONE txn → event iff committed; + reconciliation sweep

INVENTORY    per (sku, warehouse); ATP = Σ on_hand − reserved − holds; allocate by proximity+stock
             flash sale: Redis counter/token-bucket + waiting room + rate limits BEFORE the DB
             reserve-and-reconcile vs oversell-and-apologize = per-item availability dial

CONSISTENCY  browse stale OK; checkout RE-READS price from source of truth and charges THAT
             read-your-writes (route to primary briefly) for My-Orders / seller-edit
             shard products by product_id, orders by user_id, inventory by sku/warehouse
             hot key (viral product) = cache hard + request-coalesce, NOT more shards

FAILURES     catalog degrades → serve stale from edge + shed browse to protect checkout
             shipping down → async consumer → durable Kafka backlog, orders still commit
             lost OrderPlaced → outbox (structural) + reconciliation + idempotent consumers
             flash-sale oversell → gate before DB (Redis); guarded decrement is final authority
             double-charge → idempotency key + disabled submit + 3-DS resume-by-key
             stale My-Orders → read-your-writes until replica catches up

FRONTEND     SSR/SSG/ISR the SEO shell; stream personalization client-side after
             optimistic cart, RE-SYNC vs source of truth right before pay
             one idempotency key at checkout, reused across submits/retries/3-DS returns
             client NEVER owns money/availability truth; ambiguous send → re-query by key
             Core Web Vitals = conversion; code-split, CDN images, prefetch next step
```
