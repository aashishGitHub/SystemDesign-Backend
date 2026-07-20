# Answers: Food Delivery (DoorDash / Swiggy / Uber Eats)

> Keyed to [questions.md](./questions.md). Read questions first.
> Every answer includes a code block or comparison table so you can defend tradeoffs clearly.
> Depth that lives elsewhere is cross-linked, not duplicated: [ride-sharing](../ride-sharing/) (geospatial, tracking, dispatch, surge), [seat-reservation](../seat-reservation/) (atomic reservation, no-oversell, flash-sale), [message-queues](../message-queues/) (Kafka, saga, DLQ), [notification-system](../notification-system/) (push/SMS), [search-autocomplete](../search-autocomplete/) (search index), [api-design](../api-design/) (idempotency).

---

## Level 1 — Fundamentals & Requirements

### A1. Why food delivery is harder than ride-sharing

| Dimension | Ride-sharing | Food delivery | Why it's harder |
|---|---|---|---|
| Parties | 2-sided (rider, driver) | **3-sided** (customer, restaurant, courier) | Restaurant is an actor with its own accept/prep workflow |
| The "product" | A trip (starts on demand) | Perishable food with a **prep delay** | Courier must arrive *when food is ready*, not ASAP |
| Inventory | None (any driver serves any rider) | **Menus with real-time availability** | "Sold out" must propagate in seconds; oversell = angry customer |
| ETA | One leg (pickup → dropoff) | **Three legs** (prep + courier→restaurant + restaurant→customer) | Composite, and prep time is the noisy unknown |

The single biggest architectural consequence: **you cannot dispatch ASAP**. In ride-sharing the objective is "minimize time to pickup." In food delivery it is "land the courier at the restaurant the moment the food is ready" — a two-variable coordination problem (prep-time estimate × courier ETA) that has no analog in ride-sharing.

---

### A2. The three traffic paths

| Path | Workload | Consistency | Latency | Scale |
|---|---|---|---|---|
| **Discovery/browse** (nearby, menu, search) | Read-heavy (~90%) | Eventual (stale menu OK) | <100ms | Cache/CDN/read replicas |
| **Order/fulfillment** (cart, place, pay) | Write, transactional | **Strong** (no oversell, no double-charge) | <2s | Source of truth, idempotent |
| **Real-time tracking** (courier location, status) | Streaming push | Best-effort, latest-wins | Seconds | WebSocket/pub-sub fan-out |

Conflating these is the classic mistake. Browse is cacheable and tolerates staleness; ordering must hit the source of truth with strong guarantees; tracking is an ephemeral firehose. Each scales on completely different infrastructure — the same split ride-sharing and seat-reservation both make between read path and write path.

---

### A3. Why the restaurant as a first-class actor complicates everything

```text
Two-sided (ride-sharing):
  request → match driver → driver accepts → go
  (one accept, then the trip is deterministic)

Three-sided (food delivery):
  place order → PAYMENT auth
             → RESTAURANT must accept (can reject / not respond)
             → RESTAURANT prepares (variable, unobservable prep time)
             → COURIER must accept an offer (can decline)
             → hand-off synchronization (courier ↔ food-ready)
  (two independent "accept" gates + a prep delay you can't directly see)
```

The restaurant introduces (1) a **second acceptance gate** that can fail after payment, (2) an **unobservable, variable prep time** the whole dispatch depends on, and (3) a **physical synchronization point** (courier and food must converge at the same moment). None of these exist when any driver can serve any rider.

---

### A4. Back-of-the-envelope QPS

```text
Orders:      20M/day ÷ 86,400s ≈ 230 orders/sec avg
             Peak (dinner rush ~5x): ~1,200 orders/sec

Browse:      ~15 menu/screen views per order (funnel, ~7% conversion)
             20M × 15 = 300M views/day ≈ 3,500 QPS avg, ~20K QPS peak

Courier GPS: ~500K active couriers at peak × 1 update/4s
             = 125,000 writes/sec   ← DOMINATES by volume
```

**Browse QPS dominates reads; courier location updates dominate writes.** Conclusion: spend effort on (a) caching the read path aggressively, and (b) a Redis-style ephemeral hot store for courier location (see [ride-sharing A3/A13](../ride-sharing/answers.md)). Orders are comparatively low-volume but high-value — correctness matters more than throughput there.

---

### A5. Core entities and APIs

```text
Entities:
  Restaurant   { id, geo, hours, status(open/paused), prep_time_stats }
  MenuItem     { id, restaurant_id, name, price, category, modifiers[], available:bool }
  Cart         { id, customer_id, restaurant_id, line_items[] }
  Order        { id, customer_id, restaurant_id, courier_id?, state, items[], totals }
  Courier      { id, geo, status(offline/idle/on_delivery), vehicle }
  Review       { id, order_id, restaurant_rating, courier_rating, text }

APIs:
  GET  /restaurants?lat&lng&filters      → serviceable, ranked list
  GET  /restaurants/{id}/menu            → menu + availability
  POST /carts / PUT /carts/{id}/items    → build cart
  POST /orders   (Idempotency-Key)       → place order (atomic)
  GET  /orders/{id}                      → status + courier location
  WS   /orders/{id}/track                → live tracking stream
  POST /orders/{id}/review               → rate restaurant + courier
```

Minimal path to the product: **discover → menu → cart → order → track → review**. Everything else (payments, dispatch, notifications) hangs off `POST /orders`.

---

## Level 2 — Catalog, Menu & Real-Time Availability

### A6. Menu data model

```text
Restaurant 1───* Menu 1───* Category 1───* MenuItem *───* ModifierGroup 1───* Modifier

MenuItem   { id, name, base_price_cents, category_id, available: bool, tags[] }
ModifierGroup { id, name, min_select, max_select, required: bool }  // "Choose a size"
Modifier   { id, name, price_delta_cents, available: bool }          // "Large +$2"
```

| Decision | Reason |
|---|---|
| Modifiers as their own entities | "No onions", "Large", "Extra cheese" each carry price/availability |
| `available` flag per item *and* per modifier | A restaurant can 86 a single topping, not just whole items |
| Price in integer cents | Never float money |
| Menu versioned (`menu_version`) | Carts pin a version so mid-edit changes don't corrupt an in-flight cart (see A10) |

Storage: menus are document-shaped and read-mostly → a document store (MongoDB/DynamoDB) keyed by `restaurant_id`, or Postgres with a JSONB menu blob. The restaurant-facing edit path is low-QPS; the customer read path is huge and cached.

---

### A7. Serving menus at <100ms

```text
Source of truth:  Menu DB (per restaurant, versioned)
        │  write-through / event on publish
        ▼
Menu Cache (Redis)  ── most reads hit here
        │
        ▼
CDN / edge  ── menu JSON is cacheable per (restaurant_id, menu_version)
```

The key trick: **cache by `menu_version`**, so the URL/key is effectively immutable — `menu/{restaurant_id}/v{version}.json` can have a long TTL, and a publish bumps the version (a new immutable key) rather than mutating an existing one. This is the same content-addressing idea as immutable video segments (see [video-streaming](../video-streaming/)). Availability (the volatile bit) is layered *on top* separately — see A8 — so the heavy menu body stays cacheable while the small availability delta stays fresh. General caching patterns: [distributed-caching](../distributed-caching/).

---

### A8. Real-time "sold out" propagation

Split the **stable menu** (cacheable) from the **volatile availability** (fresh):

```text
1. Restaurant taps "86 biryani" in the merchant app
2. Availability Service writes item_id → unavailable (Redis + DB)
3. Publishes availability-changed event → fan-out:
     a. invalidate/overlay the availability map for that restaurant
     b. push to any client currently viewing this menu (WebSocket/SSE)
4. Browse response = cached menu body  ⊕  live availability overlay
5. Checkout re-checks availability against source of truth (A16)
```

| Layer | Guarantee |
|---|---|
| Browse | Eventually consistent — item may show available for a second or two |
| Add-to-cart | Soft check against availability cache |
| **Checkout** | **Strong** — authoritative re-validation; the only place oversell is actually prevented |

Oversell isn't prevented by fast propagation (that only reduces the window) — it's prevented by the **authoritative check at checkout**. Propagation just improves UX by hiding the item sooner.

---

### A9. Stale price at the edge

```text
Browse price   → may be stale (cached). Shown for information.
Checkout price → recomputed server-side from source of truth. Authoritative.
```

Rule: **the client never gets to name the price.** The client sends *item + modifier IDs* (and the `menu_version` it saw); the server computes the total from the current menu at order time. If the price changed since the customer viewed it:

- Small increase within tolerance → proceed, show the final price on the confirm screen.
- Material change → return `409 Price Changed`, show the diff, require re-confirm.

This is exactly the "identity in the request, price computed server-side" pattern from [video-streaming A22 dedup / api-design](../api-design/): the client asserts *what*, the server decides *how much*.

---

### A10. Cart references a changed item

```python
def validate_cart_at_checkout(cart, current_menu):
    issues = []
    for line in cart.line_items:
        item = current_menu.get(line.item_id)
        if item is None or not item.available:
            issues.append(("removed", line))
        elif item.base_price_cents != line.price_snapshot_cents:
            issues.append(("price_changed", line, item.base_price_cents))
    return issues  # empty ⇒ proceed; else surface a re-confirm screen
```

The cart stores a **price snapshot + menu_version** per line at add-time (for display), but checkout **re-resolves against the live menu**. Divergence is surfaced, never silently applied. This keeps the browse experience fast (snapshot) while keeping money correct (re-resolve).

---

## Level 3 — Discovery: Nearby, Search & Ranking

### A11. Serviceable restaurants (not just a radius)

```text
Naive:  restaurants within R km of customer  (geospatial — geohash/S2/H3)
Real serviceability also requires:
  ✓ restaurant is OPEN now (hours + manual pause)
  ✓ customer address ∈ restaurant's delivery zone (often a polygon, not a circle)
  ✓ courier supply exists in the area right now (else "too far / unavailable")
  ✓ estimated total time under a max (prep + travel)
```

The geospatial "nearby" query is identical to ride-sharing's driver search — geohash/S2/H3 cells, query cell + neighbors (see [ride-sharing A6–A11](../ride-sharing/answers.md)). What's *added* is that serviceability is a **filter pipeline**, not a distance sort: geo-candidates → open? → in delivery polygon? → courier supply? → ETA acceptable?

---

### A12. Search & filtering

```text
Search index (Elasticsearch / OpenSearch), documents = restaurants + dishes:
  { restaurant_id, name, cuisines[], dishes[], price_band, rating, avg_prep,
    geo, delivery_zones, is_open, badges[] }

Query = full-text (dish/restaurant name)  ∩  geo filter  ∩  facet filters
        (cuisine, rating≥4, "free delivery", max delivery time)
      → ranked (A13)
```

The index is fed asynchronously from the menu/restaurant DB via CDC/events, so search is eventually consistent with the catalog. Typeahead/autocomplete on the search box is its own concern — see [search-autocomplete](../search-autocomplete/). Volatile fields (`is_open`, live rating) are refreshed frequently or overlaid at read time.

---

### A13. Ranking / personalization

```text
Request path:
  serviceable candidates (A11)
    → feature fetch (distance, ETA, rating, past orders, price fit, promos)
    → ranking model score
    → feed (with cached/precomputed components where possible)
```

Ranking sits *after* the serviceability filter and *before* rendering. Heavy personalization (embeddings, "you ordered pizza last week") is precomputed offline and looked up; only light features are computed per-request to keep latency low. This is a recommendation/feed problem — cross-link [recommendation-system](../recommendation-system/) and [social-feed](../social-feed/) for ranking and feed-assembly depth.

---

### A14. Pre-order delivery estimate on browse

```text
Displayed ETA (no order yet) = predicted_prep_time(restaurant, time_of_day)
                             + predicted_courier_to_restaurant(area supply)
                             + predicted_restaurant_to_customer(distance, traffic)
```

All three are **statistical predictions** from historical data (per restaurant, per hour-of-week, per area), not live values — there's no order or courier yet. Shown as a range ("30–40 min") to set expectations. It's deliberately conservative: under-promising and over-delivering beats the reverse. The live, order-specific ETA (A31) replaces it once the order exists.

---

## Level 4 — Cart & Order Placement (Consistency & Payments)

### A15. Order placement flow

```text
tap Place Order
  1. Re-validate cart vs live menu + availability   (A10, A16)  ── strong
  2. Compute authoritative total (items + fees + tax + tip)      ── strong
  3. Authorize payment (hold funds, not capture)     (A18)       ── strong
  4. Create Order (state = PLACED) with idempotency key (A17)    ── strong  ← atomic commit point
  5. Emit OrderPlaced event                                       ── async
       → restaurant notified, dispatch planning, receipt, analytics
  6. Return confirmation to customer
```

Steps 1–4 are the **synchronous, strongly-consistent core** — they either all succeed or the order isn't created. Everything after step 5 is **event-driven and eventually consistent** (A21). The commit point is order creation; the payment is *authorized* (reversible) not captured, so a later failure can be cleanly unwound.

---

### A16. Preventing charge-for-out-of-stock

```text
Availability is checked THREE times, but only the last one is authoritative:
  browse      → cache overlay        (UX only)
  add-to-cart → cache check          (UX only)
  CHECKOUT    → source-of-truth read + reserve, INSIDE the order transaction
```

At checkout, availability is re-read from the source of truth *within the same transaction* that creates the order (or via a reservation). For genuinely limited-quantity items (a daily-special count, or Gopuff-style physical inventory), this is a **decrement-with-guard**, identical to seat-reservation's no-oversell:

```sql
UPDATE menu_items SET remaining = remaining - :qty
WHERE id = :item_id AND remaining >= :qty;   -- 0 rows updated ⇒ out of stock ⇒ abort order
```

Most restaurant items are boolean-available (unlimited until 86'd), so the guard is just `available = true`. See [seat-reservation](../seat-reservation/) for the limited-quantity concurrency depth.

---

### A17. Exactly one order, one charge (idempotency)

```python
# Client generates a UUID per logical checkout, resends it on every retry
@app.post("/orders")
def place_order(body, idempotency_key: str = Header(...)):
    existing = store.get(idempotency_key)
    if existing:
        return existing.response          # replay stored result — no new order/charge
    # ... validate, authorize payment (also keyed by idempotency_key), create order ...
    store.put(idempotency_key, order.response, ttl="24h")
    return order.response
```

The idempotency key is generated **once on the client** for a checkout attempt and reused across every retry. The server records key → result; a repeat returns the stored result instead of acting again. The *same key* is passed to the payment provider so the charge is deduped too. This is the standard payments pattern — deep treatment in [api-design](../api-design/) and [seat-reservation](../seat-reservation/).

---

### A18. Authorize-then-capture

| Phase | When | Effect |
|---|---|---|
| **Authorize** | At placement | Holds funds, verifies card — reversible, no money moves |
| **Capture** | At restaurant-accept (or pickup) | Actually charges the held amount |
| **Void** | If restaurant rejects before capture | Releases the hold — customer never charged |

You authorize first because the order can still fail *after* the customer taps pay — the restaurant might reject it, or no courier is available. Capturing immediately would force a refund (slow, costs fees, looks bad) on every such failure. Capturing at accept means a rejected order just **voids the hold** — clean, instant, no refund. This mirrors seat-reservation's hold-then-charge and the [communication-protocols](../communication-protocols/) at-least-once + idempotency reliability spine.

---

### A19. Partial availability at checkout

```text
3 items, 1 unavailable at checkout → don't silently drop or block. Offer:
  (a) Remove unavailable item, proceed with 2   (recompute total)
  (b) Substitute (restaurant-suggested or customer-picked)
  (c) Cancel the whole order
Model as a REQUIRED customer decision (409 → re-confirm), not an automatic choice.
```

The order is held in a pre-commit state until the customer resolves the conflict; the payment authorization is only taken for the final, confirmed set of items. Auto-removing items erodes trust ("why am I missing my fries?"); forcing a decision is the correct default.

---

## Level 5 — Order Lifecycle & Event-Driven Orchestration

### A20. Order state machine

```text
                 ┌──────────┐  payment/validate fail
   place order → │  PLACED  │ ───────────────► FAILED
                 └────┬─────┘
     restaurant reject│ restaurant accept
        ┌─────────────┤
        ▼             ▼
   REJECTED     ┌───────────┐
   (void hold)  │ CONFIRMED │  (capture payment)
                └────┬──────┘
                     │ kitchen starts
                     ▼
                ┌───────────┐
                │ PREPARING │────► courier assigned (parallel, prep-aware)
                └────┬──────┘
                     │ food ready + courier present
                     ▼
                ┌───────────┐   ┌────────────┐   ┌───────────┐
                │ PICKED_UP │──►│  EN_ROUTE  │──►│ DELIVERED │
                └───────────┘   └────────────┘   └───────────┘

   CANCELLED reachable from PLACED/CONFIRMED/PREPARING (A24, with compensations)
```

Note dispatch runs **in parallel** with PREPARING — the courier is being assigned while the food cooks, converging at "food ready + courier present." The state machine is richer than ride-sharing's trip (A25 there) because of the restaurant accept gate and the prep phase.

---

### A21. Why event-driven

| | Synchronous call chain | Event-driven (Kafka) |
|---|---|---|
| Coupling | Order service calls payment→restaurant→dispatch inline | Services react to events independently |
| Failure blast radius | One slow/down service stalls the whole placement | Order commits; downstream catches up |
| Latency to customer | Sum of all downstream | Fast: commit + emit, return |
| New consumers (analytics, fraud) | Code change to order service | Just subscribe to the topic |
| Cost | Simpler to trace | Harder debugging, eventual consistency |

You gain **decoupling, resilience, and fast customer response**; you pay with **eventual consistency and harder end-to-end tracing**. The order commit stays synchronous (customer needs an answer), but fulfillment (notify restaurant, plan dispatch, send receipt) is fired as events. Kafka depth: [message-queues](../message-queues/); the sync-vs-async reasoning: [communication-protocols](../communication-protocols/).

---

### A22. Keeping multi-service steps consistent (saga + outbox)

```text
Order placement = a SAGA of local transactions with compensating actions:

  Step               Forward                     Compensation (on later failure)
  ─────────────────  ──────────────────────────  ──────────────────────────────
  1 payment          authorize hold              void hold
  2 order            create (PLACED)             mark FAILED
  3 restaurant       send + await accept         (n/a — gate)
  4 dispatch         plan/assign courier         release courier

Transactional OUTBOX: the OrderPlaced event is written to an `outbox` table
in the SAME DB transaction as the order row. A relay publishes it to Kafka.
⇒ no lost events, no "order created but nobody dispatched" (A39).
```

Because there's no distributed transaction across payment + DB + Kafka, you use a **saga** (forward steps + compensations) for cross-service consistency and a **transactional outbox** to guarantee the event is published exactly if-and-only-if the order committed. Both patterns are developed in [message-queues](../message-queues/) and [distributed-transactions](../distributed-transactions/).

---

### A23. Restaurant accept / reject / no-response

```python
async def await_restaurant(order, timeout_s=120):
    decision = await restaurant_response(order.id, timeout=timeout_s)
    if decision == "accept":
        capture_payment(order); order.state = "CONFIRMED"
    elif decision == "reject":
        void_authorization(order); order.state = "REJECTED"
        notify_customer(order, "Restaurant can't take this order — you weren't charged")
        suggest_alternatives(order.customer_id, order.restaurant_id)
    else:  # no response
        if restaurant.auto_accept: capture_payment(order); order.state = "CONFIRMED"
        else: escalate_or_reject(order)   # ping restaurant, then reject if still silent
```

The key rule: a reject **before capture** means the customer is never charged (just void the hold, A18), and you immediately offer alternatives so the customer isn't stranded. No-response is handled by policy — high-trust restaurants auto-accept; others get escalated then rejected. This second acceptance gate (absent in ride-sharing) is exactly why authorize-then-capture matters.

---

### A24. Cancellation cost by stage

| Cancel at stage | Food state | Customer charge | Compensations |
|---|---|---|---|
| PLACED (pre-accept) | not started | $0 (void hold) | none |
| CONFIRMED (accepted, not cooking) | not started | small fee or $0 | void/partial refund |
| PREPARING | being cooked | full or partial (restaurant paid) | pay restaurant, release courier |
| PICKED_UP / EN_ROUTE | made + collected | full | courier still paid |

```text
Compensation fan-out on cancel:
  refund/void payment  →  notify restaurant (stop cooking if possible)
  →  release/redirect courier  →  emit OrderCancelled (analytics, fraud, metrics)
```

The principle: **whoever has already incurred cost gets compensated.** Early cancels are free; once the restaurant commits ingredients/labor, someone pays. Each cancel triggers the saga's compensating actions (A22) in reverse.

---

## Level 6 — Courier Dispatch & Assignment

### A25. When to assign the courier (prep-aware dispatch)

| Strategy | Result |
|---|---|
| At order placement | Courier arrives, waits 20 min for food — wasted courier time, cold hand-off |
| At restaurant-accept | Better, but prep time varies wildly by dish/kitchen load |
| **When food is ~ready** (prep-aware) | Courier arrives just-in-time — minimizes both courier idle time *and* food wait |

```text
assign_at = food_ready_time − predicted_courier_to_restaurant_time
food_ready_time = accept_time + predicted_prep_time(restaurant, items, kitchen_load)
```

The dispatcher continuously recomputes: as prep-time estimates update and courier supply shifts, it fires the offer at the moment that makes the courier's ETA to the restaurant land on `food_ready_time`. This just-in-time coordination is the defining difference from ride-sharing, where you always dispatch immediately.

---

### A26. Finding and scoring couriers

```text
SAME as ride-sharing:  geospatial nearby query (geohash/S2/H3),
                       score by ETA/distance/direction/rating/acceptance,
                       offer one at a time with a timeout (see ride-sharing A18–A24)

DIFFERENT for food:
  + score on ETA-to-food-ready fit (arrive near ready time, not just "soonest")
  + batching potential (A27) — is this courier already near another pickup?
  + multi-leg cost (restaurant→customer, not just courier→pickup)
  + food-suitability (insulated bag, vehicle for the distance)
```

The matching *machinery* is reused wholesale from [ride-sharing](../ride-sharing/) (offer system, batch matching, acceptance-rate handling, fair dispatch). What changes is the **objective function**: not "minimize pickup time" but "minimize total lateness + courier idle + delivery cost," with prep-readiness baked in.

---

### A27. Batching / stacked deliveries

```text
Assign 2+ orders to one courier when:
  ✓ restaurants are close (or same restaurant)
  ✓ drop-offs are roughly on the way
  ✓ added detour keeps BOTH orders within acceptable lateness

Risk: order A's food sits/cools while courier handles order B's pickup/drop.
Guardrail: cap added delay per order (e.g. ≤ 8 min), never batch if it pushes
either order past its promised ETA.
```

Batching raises courier efficiency (more deliveries/hour → lower cost, better courier earnings) but trades against food quality and per-order latency. It's the food-delivery analog of UberPool ([ride-sharing QB1](../ride-sharing/answers.md)), but constrained by *perishability* — a cold delivery is a failed delivery, so the lateness cap is stricter than a rideshare detour.

---

### A28. Courier declines / no-response

```python
async def dispatch(order, candidates):
    for courier in ranked(candidates):           # best-fit first (A26)
        if await offer(courier, order, timeout=20):   # accepted
            return assign(order, courier)
        penalize_acceptance_rate(courier)          # decline/timeout
        # loop continues — but re-rank against the CLOCK, not the original ready time
    # exhausted nearby couriers:
    widen_radius(order) or reoffer_with_incentive(order) or delay_and_retry(order)
```

Reassignment reuses the ride-sharing offer/timeout loop, but with a food-specific twist: the **food-ready clock keeps ticking**, so on each decline the dispatcher re-evaluates against *time remaining*, may widen the radius or add a courier incentive, and in the worst case tells the restaurant to hold/delay cooking. The goal is to avoid the food being ready with no courier present.

---

### A29. Prep-time estimation — the linchpin

```text
predicted_prep = f( restaurant historical prep for these items,
                    current kitchen load / open orders,
                    time of day / day of week,
                    item complexity )   ── ML regression, updated continuously
```

| If prep estimate is… | Consequence |
|---|---|
| Too low | Courier arrives early, waits, idle cost, food not ready |
| Too high | Courier arrives late, food sits and cools, bad rating |
| Accurate | Just-in-time convergence — the whole system's efficiency hinges here |

Everything in dispatch (A25) is downstream of this number. That's why platforms invest heavily in prep-time ML and in **merchant signals** ("food is ready now" button) to correct the estimate in real time. A wrong prep estimate makes even a perfect courier-matching algorithm produce cold food or idle couriers.

---

## Level 7 — Real-Time Tracking, ETA & Notifications

### A30. Live tracking end-to-end

```text
Courier app --GPS every 4s--> Location Service --> Redis (hot) + geo-index
                                     │ publish
                                     ▼
                              Redis Pub/Sub  (channel: order:{id}:location)
                                     │
                       Tracking Service (WebSocket/SSE fan-out)
                                     │
                              Customer app map
```

This is **identical to ride-sharing's tracking** (see [ride-sharing A31–A35](../ride-sharing/answers.md)): courier location goes to a hot store, is published on a per-order pub/sub channel, and the tracking service pushes it to the subscribed customer. Reuse it wholesale — location upload, stale detection, GPS-drift filtering, payload reduction all transfer directly.

---

### A31. Composite ETA

```text
ETA_to_customer =
   (state ≤ PREPARING)  remaining_prep + courier_to_restaurant + restaurant_to_customer
   (state = EN_ROUTE)   courier_to_customer   (live, from GPS + routing/traffic)

Recompute on: prep progress updates, courier location updates, traffic changes.
Smooth it (don't let the number jump around) — like ride-sharing surge smoothing.
```

Unlike ride-sharing's single-leg ETA, this sums the **three legs** and shifts which legs are live vs predicted as the order progresses. Early on it's mostly prediction (prep dominates); once EN_ROUTE it's pure live routing. Updates are smoothed so the customer doesn't see the ETA bounce. Routing/traffic estimation is shared with [ride-sharing QB2](../ride-sharing/answers.md).

---

### A32. WebSocket vs SSE vs polling (tracking screen)

| | Customer tracking screen | Courier location upload |
|---|---|---|
| Direction | Server → client (receive location) | Client → server (send GPS) |
| Best fit | **SSE** (one-way) or WebSocket | Batched HTTPS POST (not a socket) |
| Why | Customer only *receives* updates | Courier only *sends*; no need for a persistent socket |

For the customer's screen, **SSE is sufficient** (they only receive) and simpler than WebSocket; WebSocket is used if there's also in-app chat with the courier. The courier's *upload* is not a tracking socket at all — it's periodic POSTs to the Location Service. Full comparison: [communication-protocols A40](../communication-protocols/answers.md) and [sse](../sse/).

---

### A33. Scaling tracking to millions of orders

```text
N active orders being tracked ÷ ~50K connections/server = tracking server fleet
  (e.g. 2M concurrent trackers ÷ 50K = 40 servers)

Load balancer (sticky by order_id) → Tracking servers → subscribe Redis Pub/Sub
Only fan out to orders that actually have a viewer open (lazy subscription).
Reduce payload: send deltas, throttle to ~1 update/3–5s, binary (Protobuf).
```

Same architecture and knobs as [ride-sharing A33/A35](../ride-sharing/answers.md): horizontal WebSocket/SSE fleet, sticky routing, Redis pub/sub backplane, payload reduction. The one food-specific optimization: most of an order's life is PREPARING (no courier movement yet), so you only need high-frequency updates during EN_ROUTE — throttle hard before pickup.

---

### A34. Status notifications when the app is closed

```text
Order events (CONFIRMED, PICKED_UP, DELIVERED)
  → Notification Service
    → push (APNs/FCM) if app installed
    → SMS fallback (Twilio) if push fails / not delivered
    → email receipt on completion
Idempotent + deduped so a retried event doesn't double-notify.
```

Live tracking (WebSocket/SSE) only works while the app is open; **discrete status milestones** go through the push/SMS pipeline so the customer is reached anywhere. This is a separate concern with its own reliability needs — full design in [notification-system](../notification-system/) (multi-channel, idempotent dispatch, quiet hours, failover).

---

## Level 8 — Reviews, Scale & Fault Tolerance

### A35. Review/rating system + anti-spam

```text
Review { id, order_id (UNIQUE), customer_id, restaurant_rating 1-5,
         courier_rating 1-5, text, created_at }

Rules:
  ✓ one review per DELIVERED order (order_id UNIQUE) ⇒ must have actually ordered
  ✓ separate restaurant vs courier rating (a great restaurant + late courier)
  ✓ time-boxed (e.g. reviewable up to 14 days post-delivery)

Anti-spam:
  - verified-order requirement kills most fake reviews (can't review without ordering)
  - rate limiting, duplicate-text detection, velocity/burst checks
  - ML/heuristics for review bombing; human moderation queue for flagged
```

The **verified-purchase constraint (`order_id UNIQUE`)** is the single strongest anti-fake-review lever — you cannot review what you didn't order. Separating restaurant and courier ratings prevents a slow courier from tanking a good restaurant. Moderation/fraud patterns overlap [notification-system](../notification-system/) idempotency and general fraud detection.

---

### A36. Average rating at scale (no recompute on read)

```text
Naive: AVG(rating) over all reviews per read  ⇒ full scan, slow.

Maintain a rolling aggregate incrementally:
  restaurant_ratings { restaurant_id, sum_ratings, count, avg (derived) }
  on new review: sum += rating; count += 1     (atomic increment)
  read avg = sum / count                         (O(1))
```

| Approach | Tradeoff |
|---|---|
| Pre-aggregated counter (above) | O(1) read, one extra write per review |
| Stream aggregation (Kafka→Flink→store) | Handles edits/deletes, slight delay |
| Cache the computed avg in Redis | Fastest read; recompute on write |

Never scan reviews on the read path — maintain the answer as reviews arrive. This is the identical pattern to [video-streaming A28](../video-streaming/answers.md) (completion counts) and [social-feed](../social-feed/) counters.

---

### A37. Dinner-rush 5x spike

```text
What breaks first (in order):
  1. Order-placement DB write path (contention on hot restaurants)
  2. Dispatch (courier supply < demand → long assign times)
  3. Notification fan-out
  4. Tracking connection count

Handling:
  - Kafka absorbs the write burst; consumers drain at a sustainable rate (A21)
  - autoscale stateless services; read replicas for browse
  - shed load gracefully: queue non-critical work, degrade dispatch (A38)
  - surge pricing / "busy area" to balance demand vs courier supply (QB1)
  - pre-warm caches for popular restaurants
```

The event-driven backbone (A21) is what makes the spike survivable — the burst becomes a **backlog in Kafka**, not a meltdown at the database, exactly the load-leveling argument from [communication-protocols A2](../communication-protocols/answers.md). Courier *supply* is the real bottleneck (you can't autoscale humans), so surge and batching (A27) are the levers.

---

### A38. Dispatch service down — degrade gracefully

| Level | Trigger | Behavior |
|---|---|---|
| Normal | healthy | Prep-aware, optimized batched dispatch |
| Degraded | dispatch slow | Simple nearest-available-courier, no batching |
| Emergency | dispatch down | Accept orders, queue for dispatch, tell customer "confirming courier" |
| Fallback | prolonged outage | Let restaurants use their own couriers / pause new orders in affected area |

```text
Key: NEVER block order placement on dispatch. Order commits (payment + restaurant),
dispatch is downstream (A21). If dispatch is down, orders queue and the restaurant
can still start cooking — the courier is assigned late rather than the order failing.
```

Because dispatch is event-driven and *after* the order commit, its outage degrades experience (later courier) rather than dropping orders. This is the same graceful-degradation ladder as [ride-sharing A42](../ride-sharing/answers.md).

---

### A39. Payment succeeded but order event lost

```text
Symptom: money authorized/captured, but dispatch never saw the order → food never cooked.

Prevention (primary): transactional OUTBOX (A22)
  order row + outbox event committed in ONE DB transaction
  ⇒ event exists iff order exists; relay retries publish until acked

Detection/recovery (belt-and-suspenders):
  - reconciliation job: orders in PLACED/CONFIRMED with no downstream progress > N min
    → re-emit event / alert
  - idempotent consumers: re-emitted event is safe (dedupe by order_id)
```

The outbox pattern makes "committed order with no event" structurally impossible; the reconciliation sweep catches anything that still slips through (e.g., a stuck relay). This is the same failure and fix as [video-streaming A31](../video-streaming/answers.md) (worker wrote output but crashed before notifying) — make a committed record, not a fire-and-forget notification, the source of truth. Depth: [distributed-transactions](../distributed-transactions/).

---

## Level 9 — Frontend Design (Architect)

### A40. Menu browsing with real-time availability

```text
Client rendering:
  menu body      ← fetched once, cached (immutable per menu_version) — big, static
  availability   ← small overlay, refreshed live — merged into render

Refresh without hammering the server:
  - on screen open: fetch availability snapshot
  - while open: subscribe (SSE/WebSocket) to availability deltas for THIS restaurant
  - on background/foreground: re-fetch snapshot (cheap) rather than keep socket open
  - greyed-out + "Sold out" label for unavailable items (don't remove — avoids layout jump)
```

The frontend split mirrors the backend split (A7/A8): **cache the heavy immutable menu, subscribe only to the small volatile availability layer.** Opening a socket per browsing user is expensive at scale, so the client subscribes only while actively viewing one restaurant and falls back to snapshot-on-focus otherwise. Never let the client trust its cached availability at checkout — the server re-validates (A16).

---

### A41. Client cart state

```text
State model:
  local (optimistic) cart  ⇄  server cart (source of truth, keyed by customer)

Add-to-cart: update UI immediately (optimistic) → POST to server → reconcile
Price re-sync: server returns authoritative line prices; client shows diffs (A9/A10)
Multi-device: server cart is canonical; on app open, GET server cart and merge/replace
Conflict: last-write-wins per line, or server-versioned cart (reject stale writes)
```

The cart is **optimistic on the client for responsiveness, canonical on the server for correctness.** A version number (or updated_at) on the server cart lets the client detect it changed on another device and re-sync, rather than clobbering. The client never computes the final total — it displays snapshots and defers to the server at checkout (A9).

---

### A42. Live-tracking screen (client)

```text
Transport: SSE (receive-only) — simpler than WebSocket, auto-reconnect built in.
  Use WebSocket only if in-app courier chat is needed.

Map cadence:
  - interpolate/animate courier marker between updates (updates every 3–5s, animate smoothly)
  - throttle: don't redraw on every packet; coalesce to animation frames
Reconnection:
  - EventSource auto-reconnects; on reconnect, fetch a fresh snapshot (order state + last location)
Battery/data:
  - reduce update frequency when app backgrounded / screen off
  - stop the stream entirely once DELIVERED
  - binary/delta payloads (Protobuf), not verbose JSON
```

The client's job is to make a 3–5s update cadence *look* continuous via **interpolation/animation**, while minimizing socket time and redraws for battery. This is the receive side of A30–A33; the reconnection-then-snapshot pattern (get current state on reconnect, then stream deltas) mirrors [ride-sharing A34](../ride-sharing/answers.md).

---

### A43. Flaky mobile network

```text
Responsiveness:
  - optimistic UI for add-to-cart, tip changes (reconcile on ack)
  - skeleton loaders; render cached menu instantly, refresh in background

Correctness:
  - idempotency key on Place Order (A17) so a retry can't double-order
  - never finalize price/availability on the client — server is source of truth
  - queue writes offline; replay on reconnect (with idempotency)

Errors:
  - explicit retry with backoff; clear "no connection" states
  - distinguish "request maybe succeeded" (network dropped after send) → check order status,
    don't blindly resubmit
```

The two rules that keep a flaky client correct: **(1) every mutating action carries an idempotency key** so retries are safe, and **(2) the client never owns money or availability truth** — it can be optimistic about UI but must defer to the server for anything that costs money. The "did my order go through?" ambiguity (send succeeded, response lost) is resolved by *querying order status*, not resubmitting — the at-least-once + idempotency spine from [communication-protocols A42](../communication-protocols/answers.md), applied client-side.

---

### A44. Keeping client price/menu consistent with server

```text
Problem: client shows $12, server charges $13 (price changed since cache) → trust broken.

Defenses (layered):
  1. cache menu by menu_version; server tells client its version is stale → refetch
  2. client sends {item_ids, modifier_ids, menu_version}; server computes price
  3. server compares client's menu_version to current:
       same        → proceed
       changed, ≤ tolerance → proceed, show final on confirm
       changed, material    → 409, show diff, require re-confirm (A9)
  4. show the authoritative total on the confirm screen BEFORE the customer commits
```

The guarantee isn't "the client is always fresh" (impossible on mobile) — it's **"the customer always sees and confirms the authoritative price before paying."** The `menu_version` handshake lets the server detect staleness and force a re-confirm rather than silently charging a surprise amount. Identity-in-request, price-server-side (A9) is what makes this safe.

---

## Bonus — Senior Answers

### QB1. Dynamic delivery pricing vs ride-sharing surge

```text
Same core: demand/supply imbalance → multiplier, zone-based, computed periodically
           (reuse ride-sharing A36–A40 wholesale)

Food-specific differences:
  - supply = couriers, but demand is split across restaurant + delivery
  - "busy area" fees + longer promised ETAs (rather than pure price surge)
  - restaurant-side levers: promote under-ordered restaurants, not just raise price
  - three-leg cost means distance-based delivery fee, not just surge multiplier
```

Reuse the surge engine from [ride-sharing](../ride-sharing/) (zones, smoothing, anti-oscillation, fraud), but the food version leans more on **ETA adjustment and courier incentives** than on raw price surge, because customers abandon carts more readily than they abandon a ride they urgently need.

---

### QB2. Scheduled orders

```text
"Deliver at 7:00 PM" → work backwards:
  courier_offer_time = 19:00 − delivery_leg − pickup_leg − prep_time
  restaurant_start_cooking = 19:00 − delivery_leg − pickup_leg − prep_time

Store scheduled orders; a scheduler enqueues them into the normal prep-aware
dispatch pipeline at the right lead time. Same JIT coordination (A25), just
triggered by a clock instead of an immediate placement.
```

Scheduled orders are the *purest* form of prep-aware dispatch — the target time is explicit, so you literally compute backwards from it. The hard part is capacity planning: many 7pm orders create a synchronized spike (A37).

---

### QB3. Ghost kitchens / virtual brands

```text
Physical kitchen 1 ──* Virtual Brand ("Tony's Pizza", "Wing Central" — same kitchen)
                    └──* shares: location, couriers, prep queue
                       separate: menus, branding, reviews

Model: decouple "brand/storefront" (what the customer browses) from
       "fulfillment location" (where food is made + courier picks up).
```

The insight: the customer-facing **storefront is not 1:1 with the physical pickup location.** One kitchen backs many brands, so prep-time estimation must account for the *shared* kitchen queue across all brands, and a courier might pick up two "different restaurants" from one door (natural batching, A27).

---

### QB4. Promo abuse & order fraud

| Fraud | Detection | Prevention |
|---|---|---|
| Promo abuse (new-user codes) | Same device/payment/address across "new" accounts | Device fingerprint, payment-instrument dedupe, limit per household |
| Fake delivery ("never arrived") | Customer velocity of refund claims, courier GPS at drop | Photo-on-delivery, GPS proof, claim rate limits |
| Courier fraud (fake completion) | Marked delivered but no GPS at customer location | Geofenced completion, customer confirmation |
| Collusion (customer + courier) | Repeated pairings, refund patterns | Pattern detection across order graph |

Overlaps ride-sharing fraud ([QB3 there](../ride-sharing/answers.md)) — GPS-proof, velocity checks, device fingerprinting. Promo abuse is the food-specific addition, defended primarily by **deduping the real-world identity** (device + payment + address) behind "new" accounts.

---

### QB5. Multi-region / multi-city

```text
Local per city/region:   restaurants, menus, orders, couriers, dispatch, tracking
                         (an order's three parties are all in one metro)
Global:                  customer accounts, payment methods, reviews aggregate
Data residency:          keep order/PII in-region for compliance (GDPR etc.)
```

Like [ride-sharing A44](../ride-sharing/answers.md), the fulfillment data is inherently **local** — customer, restaurant, and courier are in the same city — so shard by geography and keep the hot path in-region. Only identity and cross-region analytics are global.

---

### QB6. Refunds, chargebacks, disputes

```text
Order stores the full evidentiary trail:
  itemized totals, price snapshots, availability decisions, timestamps per state,
  courier GPS breadcrumbs, delivery photo, chat logs

Refund flow: authorized-not-captured → void (free); captured → refund (fees lost)
Dispute ("charged wrong / never arrived"): replay stored trail, compare to claim,
  auto-refund small amounts, human review for large/anomalous.
```

Same as ride-sharing fare disputes ([A30 there](../ride-sharing/answers.md)): the order is the **immutable record** you adjudicate against. The authorize-then-capture model (A18) makes most pre-delivery refunds free voids rather than costly captured-then-refunded charges.

---

## ⚡ Quick Recall Cheat Sheet

| Concept | One-line recall |
|---|---|
| 3-sided marketplace | Customer + restaurant + courier — two accept gates, one prep delay |
| Three traffic paths | Browse (cache/eventual), Order (strong), Track (streaming) |
| Why harder than Uber | Prep time + perishable output + real-time inventory |
| QPS shape | Browse dominates reads; courier GPS dominates writes (~125K/s) |
| Menu model | Restaurant→Category→Item→ModifierGroup→Modifier; price in cents |
| Menu caching | Cache heavy body by `menu_version` (immutable); overlay volatile availability |
| Sold-out propagation | Fast push = UX; oversell prevented only by authoritative checkout re-check |
| Price authority | Client sends IDs + version; **server computes price** |
| Cart/menu drift | Snapshot for display, re-resolve at checkout, surface diffs |
| Serviceability | Not a radius: open + delivery polygon + courier supply + ETA cap |
| Discovery | Geo candidates → filter pipeline → ranking model |
| Pre-order ETA | Statistical prediction (prep + pickup + delivery), shown as a range |
| Order placement | Validate→total→**authorize**→create(idempotent)→emit event |
| No oversell | Authoritative availability check inside order txn (guarded decrement) |
| Idempotency | Client UUID key, reused on retry, passed to payment provider |
| Authorize-then-capture | Hold at placement, capture at accept, void on reject |
| Partial availability | Force customer choice (remove/substitute/cancel), don't auto-drop |
| Order state machine | PLACED→CONFIRMED→PREPARING→PICKED_UP→EN_ROUTE→DELIVERED |
| Event-driven | Commit sync, fulfill async (Kafka) — decoupling vs eventual consistency |
| Saga + outbox | Compensating actions for cross-service; outbox = event iff committed |
| Restaurant gate | Accept/reject/timeout; reject before capture = free void |
| Cancel cost | Whoever incurred cost gets compensated; early cancel free |
| Prep-aware dispatch | Assign courier to arrive at `food_ready_time`, not ASAP |
| Courier matching | Reuse ride-sharing offer/score; objective = JIT + batching + multi-leg |
| Batching | Stack orders if detour keeps both within lateness cap |
| Prep-time estimate | The linchpin — ML + merchant "ready" signal |
| Live tracking | Courier GPS→Redis→pub/sub→SSE/WS→customer (reuse ride-sharing) |
| Composite ETA | Sum 3 legs; shift live-vs-predicted as order progresses; smooth |
| Tracking transport | SSE for customer (receive-only); POST for courier upload |
| Status notifications | Push/SMS for milestones (app closed); WS/SSE only while open |
| Reviews | One per delivered order (UNIQUE) — verified purchase kills fakes |
| Ratings at scale | Incremental sum/count aggregate, O(1) read |
| Peak (5x rush) | Kafka absorbs burst; courier supply is the real bottleneck → surge |
| Degrade dispatch | Never block order on dispatch; queue and assign late |
| Lost event recovery | Outbox (structural) + reconciliation sweep (backstop) |
| Frontend menu | Cache immutable body, subscribe to availability deltas only while viewing |
| Frontend cart | Optimistic local, canonical server, version to detect multi-device |
| Frontend tracking | SSE + marker interpolation; snapshot-on-reconnect; throttle when backgrounded |
| Flaky network | Idempotency key + client never owns money/availability truth |
| Price consistency | `menu_version` handshake; confirm authoritative total before pay |
| Scheduled orders | Work backwards from deliver-at time into prep-aware pipeline |
| Ghost kitchens | Decouple storefront/brand from physical fulfillment location |
| Multi-region | Fulfillment local (one metro); identity/analytics global |
