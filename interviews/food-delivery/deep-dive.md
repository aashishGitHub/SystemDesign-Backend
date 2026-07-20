# Deep Dive: Food Delivery (DoorDash / Swiggy / Uber Eats)

> Each chapter has three depths: 🟢 **Beginner** (analogy + intuition), 🟡 **Senior** (implementation + tradeoffs), 🔴 **Architect** (scale, failure modes, production reality).
> Depth that belongs to a neighbouring topic is cross-linked, not repeated: [ride-sharing](../ride-sharing/), [seat-reservation](../seat-reservation/), [message-queues](../message-queues/), [distributed-transactions](../distributed-transactions/), [notification-system](../notification-system/).

## Table of Contents

1. The Three-Sided Marketplace & the Three Paths
2. Catalog, Menu & Real-Time Availability
3. Discovery: Serviceability, Search & Ranking
4. Cart & Order Placement — Consistency, Payments, Idempotency
5. Order Lifecycle & Event-Driven Orchestration
6. Courier Dispatch — Prep-Aware Just-in-Time Assignment
7. Real-Time Tracking & Composite ETA
8. Reviews, Scale & Fault Tolerance
9. Frontend Architecture
10. Real-World Case Notes
11. Quick Recall Cheat Sheet

---

## 1. The Three-Sided Marketplace & the Three Paths

### 🟢 Beginner — The dinner-party analogy

Imagine hosting a dinner where you don't cook and you don't drive. You (the *customer*) call a restaurant to order, the *restaurant* cooks it, and a *courier* fetches it to your door. Three independent people must cooperate, and the food is only good if the courier shows up right when it's plated — not an hour early (cold wait) and not an hour late (soggy fries). That timing problem, multiplied by millions of dinners at once, is the whole system.

Ride-sharing is a *two*-person version of this: you and a driver. Nobody has to cook, so there's no "wait for it to be ready" — the driver just comes now. That one missing person, the cook, is what makes food delivery genuinely harder.

### 🟡 Senior — Three paths, three sets of guarantees

The design's first cut is to split traffic by its guarantee needs:

```text
BROWSE  (90% of traffic)   read-heavy · eventual consistency OK · <100ms · cache/CDN/replicas
ORDER   (the money path)   write · STRONG consistency · idempotent · <2s · source of truth
TRACK   (the firehose)     streaming push · latest-wins · seconds · WebSocket/SSE + pub-sub
```

Each maps to different infrastructure. Browse is served from Redis/CDN and read replicas — being a second stale is fine. Order must hit the primary with transactions and idempotency keys — a double-charge is unacceptable. Track is an ephemeral fan-out where only the newest courier position matters and history is worthless.

### 🔴 Architect — Why conflation is the classic failure

Teams that store menus, orders, and locations in one database, or serve all three from one service, hit three walls at once: the browse read load (tens of thousands of QPS) starves the order write path; the order path's strong-consistency requirements slow browse; and the location firehose (∼125K writes/sec at peak — see the QPS math below) overwhelms any durable store. The correct architecture is three independently-scaled subsystems joined by events, not one monolith.

```text
Orders:      20M/day ≈ 230/s avg, ~1,200/s dinner-peak      → primary DB, idempotent
Browse:      ~15 views/order → 300M/day ≈ 3.5K/s, ~20K peak → cache + read replicas
Courier GPS: 500K couriers × 1/4s = 125K writes/s           → Redis hot store (ephemeral)
```

The three-sided nature adds two failure surfaces ride-sharing lacks: a restaurant that rejects *after* payment (→ authorize-then-capture, Ch. 4) and a prep delay the system can't observe (→ prep-aware dispatch, Ch. 6).

---

## 2. Catalog, Menu & Real-Time Availability

### 🟢 Beginner — A laminated menu with sticky notes

Think of the printed menu as something that changes rarely — you can photocopy it and hand it out cheaply. But "we're out of biryani tonight" is a sticky note slapped on top. You don't reprint the whole menu for a sticky note. The stable menu is the photocopy (cache it hard); the sold-out flags are sticky notes (keep them fresh, layer them on).

### 🟡 Senior — Split the stable body from the volatile overlay

```text
menu body   → versioned, immutable per menu_version → cache long (Redis + CDN)
availability→ small map {item_id → bool}            → refreshed live, overlaid at read
browse render = cached body ⊕ live availability overlay
```

Menu model: `Restaurant → Category → MenuItem → ModifierGroup → Modifier`, price in integer cents, `available` flag on *both* items and modifiers (a restaurant can 86 a single topping). Cache by `menu/{restaurant_id}/v{version}.json` — a publish bumps the version (a new immutable key), so you never mutate a cached object. This is the [video-streaming](../video-streaming/) immutable-content-addressing pattern applied to menus.

### 🔴 Architect — Availability is a UX signal, not the oversell guard

The mistake is believing that pushing "sold out" fast enough prevents overselling. It doesn't — it only shrinks the window. Overselling is prevented at exactly **one** place: the authoritative re-check at checkout inside the order transaction (Ch. 4). Fast propagation (event → invalidate overlay → WebSocket push to active viewers) is purely to *hide the item sooner* and reduce disappointment.

```text
Consistency ladder:
  browse       eventual   (item may show available for ~1-2s after sellout)
  add-to-cart  soft check (cache)
  checkout     STRONG     (source of truth; the only real guard)
```

For genuinely counted inventory (daily specials, or the Gopuff dark-store model), the checkout guard is a `UPDATE ... SET remaining = remaining - qty WHERE remaining >= qty` — 0 rows ⇒ sold out. That's the [seat-reservation](../seat-reservation/) no-oversell concurrency problem exactly.

---

## 3. Discovery: Serviceability, Search & Ranking

### 🟢 Beginner — "Who can actually bring me food?"

Being close isn't enough. A restaurant a block away might be closed, might not deliver to your building, or might have no courier free. Serviceability answers "who can *actually* deliver to me right now," which is a series of yes/no gates, not just "who's nearby."

### 🟡 Senior — A filter pipeline over geo candidates

```text
geo candidates (geohash/S2/H3 cell + neighbors — reuse ride-sharing A6–A11)
  → open now? (hours + manual pause)
  → address ∈ delivery polygon? (often hand-drawn, not a circle)
  → courier supply in area?
  → estimated total time ≤ max?
  → RANK (features → model score) → feed
```

Search is backed by an inverted index (Elasticsearch) of restaurant+dish documents, fed asynchronously via CDC from the catalog, queried as `full-text ∩ geo ∩ facets` (cuisine, rating, free delivery, max time). Typeahead is its own topic: [search-autocomplete](../search-autocomplete/). Ranking sits *after* serviceability and *before* render; heavy personalization is precomputed offline and looked up — see [recommendation-system](../recommendation-system/) / [social-feed](../social-feed/).

### 🔴 Architect — Pre-order ETA is pure prediction

Before an order exists there is no courier and no kitchen ticket, so the "30–40 min" on the card is three *statistical* predictions summed:

```text
displayed_ETA = predict_prep(restaurant, hour-of-week)
              + predict_courier_to_restaurant(area supply)
              + predict_restaurant_to_customer(distance, traffic)
```

Shown as a conservative range (under-promise, over-deliver). The volatile inputs — `is_open`, live rating, current area supply — must be refreshed frequently or overlaid at read time, because an index that says "open" for a closed restaurant produces failed orders and eroded trust.

---

## 4. Cart & Order Placement — Consistency, Payments, Idempotency

### 🟢 Beginner — Putting a hold on your card

When you check into a hotel they don't charge you — they put a *hold* on your card. If you leave early or the room's unavailable, the hold vanishes and you were never really charged. Food orders work the same: we hold the money when you tap pay, and only actually take it once the restaurant says "yes, we'll make it."

### 🟡 Senior — The synchronous commit core

```text
tap Place Order:
  1. re-validate cart vs live menu + availability   ── STRONG
  2. compute authoritative total (items+fees+tax+tip) ── STRONG
  3. AUTHORIZE payment (hold, reversible)            ── STRONG
  4. create Order(PLACED) with idempotency key       ── STRONG ← commit point
  5. emit OrderPlaced event                          ── async (Ch. 5)
```

**Idempotency:** the client mints one UUID per checkout and resends it on every retry; the server records `key → result` and replays on repeat, and passes the same key to the payment provider so the charge dedupes too. **Authorize-then-capture:** hold at placement, capture at restaurant-accept, void on reject — so a post-payment rejection costs the customer nothing. Both are the [seat-reservation](../seat-reservation/) / [api-design](../api-design/) patterns.

### 🔴 Architect — The commit point and partial availability

The atomic commit is order creation; everything before is reversible (void the auth), everything after is eventually consistent (events). This is what lets the customer get a fast, definite answer while fulfillment happens asynchronously.

Partial availability (2 of 3 items in stock) is modeled as a *required customer decision* — a `409` that forces remove/substitute/cancel — never a silent auto-drop, because "why are my fries missing?" destroys trust. The authorization is taken only for the final confirmed item set.

```text
Availability checked 3×, authoritative only at checkout:
  browse (cache/UX)  add-to-cart (soft)  CHECKOUT (source of truth, in txn)
```

---

## 5. Order Lifecycle & Event-Driven Orchestration

### 🟢 Beginner — A relay race with batons

An order is a relay: payment passes the baton to the restaurant, which passes it to the kitchen, which passes it to the courier. If a runner drops the baton (a step fails), you don't restart the whole race — you have a rule for handing the baton back (a compensation): refund the money, tell the kitchen to stop, free the courier.

### 🟡 Senior — State machine + why events

```text
PLACED ─(reject)→ REJECTED(void)      PLACED ─(fail)→ FAILED
PLACED ─(accept)→ CONFIRMED(capture) → PREPARING → [dispatch in parallel]
     → PICKED_UP → EN_ROUTE → DELIVERED
     (CANCELLED reachable early, with compensations)
```

Event-driven (Kafka) instead of a synchronous call chain: the order **commits synchronously** (customer needs an answer) then **emits an event**; restaurant-notify, dispatch-plan, receipt, analytics all react independently. Gain: decoupling, resilience, fast response, easy new consumers. Cost: eventual consistency, harder tracing. See [message-queues](../message-queues/) and [communication-protocols](../communication-protocols/).

### 🔴 Architect — Saga + transactional outbox

There's no distributed transaction across payment + DB + Kafka, so:

```text
SAGA (forward + compensation):
  authorize → void       create order → fail      assign courier → release

OUTBOX: write OrderPlaced into an outbox table in the SAME txn as the order row;
        a relay publishes to Kafka → event exists iff order committed.
```

The outbox makes "order committed but nobody dispatched" structurally impossible (Ch. 8, A39). Restaurant accept/reject/timeout is a saga gate: reject-before-capture = free void + immediate alternatives to the customer. Cancellation cost follows "whoever incurred cost gets compensated." Depth: [distributed-transactions](../distributed-transactions/).

**Gopuff contrast:** the narrow dark-store model drops the restaurant-accept gate and the prep phase entirely — it's fixed physical inventory + atomic order (a single `SERIALIZABLE` Postgres transaction), which is nearly pure [seat-reservation](../seat-reservation/). The restaurant marketplace adds the second gate and the prep delay on top.

---

## 6. Courier Dispatch — Prep-Aware Just-in-Time Assignment

### 🟢 Beginner — Don't send the taxi before the bags are packed

If you call a taxi to the airport the moment you *start* packing, it idles at the curb while you fold shirts. If you call it too late, you miss the flight. You want it to arrive *as you zip the suitcase*. A courier is that taxi, and the food is the suitcase being packed in a kitchen you can't see into.

### 🟡 Senior — The assignment-timing equation

```text
assign so courier arrives at food_ready:
  offer_time    = food_ready_time − predict(courier_to_restaurant)
  food_ready    = accept_time + predict_prep(restaurant, items, kitchen_load)

Finding/scoring couriers = reuse ride-sharing (nearby query + offer system + timeout),
BUT objective = fit-to-ready + batching potential + multi-leg cost + food-suitability,
NOT "soonest pickup."
```

Dispatch runs **in parallel** with PREPARING and recomputes continuously as prep and supply shift. On decline/timeout, re-evaluate against the *remaining* clock — widen radius, add incentive, or tell the restaurant to hold.

### 🔴 Architect — Batching and the prep-time linchpin

```text
Batch 2 orders on 1 courier IFF: restaurants close, drops on-the-way,
  AND added detour keeps BOTH within lateness cap (stricter than a rideshare detour —
  cold food = failed delivery). It's UberPool constrained by perishability.
```

Everything hinges on **prep-time estimation** — an ML regression over historical prep, kitchen load, time-of-day, item complexity, corrected in real time by a merchant "food's ready" signal. Estimate low → idle couriers + food not ready; estimate high → cold food. A perfect matching algorithm on a wrong prep estimate still produces bad outcomes, which is why this number gets outsized investment. The matching machinery itself: [ride-sharing](../ride-sharing/) A18–A24.

---

## 7. Real-Time Tracking & Composite ETA

### 🟢 Beginner — The pizza tracker, but the dot moves

You've seen the Domino's "your pizza is being prepared / baked / out for delivery" bar. Live tracking adds a moving dot: the courier's phone whispers its location every few seconds, and your app draws it creeping toward you.

### 🟡 Senior — Reuse ride-sharing tracking wholesale

```text
courier app --GPS/4s--> Location Service --> Redis(hot) + geo-index
                              │ publish (order:{id}:location)
                              ▼   Redis Pub/Sub → Tracking Service (SSE/WS) → customer map
```

Transport asymmetry: the **customer** screen is receive-only → **SSE** (simpler; WebSocket only if courier chat exists); the **courier** upload is periodic HTTPS **POST**, not a socket. Stale detection, GPS-drift filtering, payload reduction all transfer from [ride-sharing](../ride-sharing/) A31–A35. Full transport comparison: [communication-protocols](../communication-protocols/) A40, [sse](../sse/).

### 🔴 Architect — Composite ETA and tracking scale

```text
ETA (state ≤ PREPARING) = remaining_prep + courier_to_restaurant + restaurant_to_customer
ETA (state = EN_ROUTE)  = courier_to_customer (live GPS + routing/traffic)
→ shift live-vs-predicted as order progresses; SMOOTH (no bouncing numbers).

Scale: N trackers ÷ 50K conn/server = fleet; sticky-by-order LB; lazy subscribe
(only orders with a viewer); throttle hard pre-pickup (courier isn't moving);
binary deltas (Protobuf).
```

Milestones (confirmed / picked up / delivered) go through push/SMS ([notification-system](../notification-system/)) because live sockets only work while the app is open — idempotent + deduped so a retried event doesn't double-notify.

---

## 8. Reviews, Scale & Fault Tolerance

### 🟢 Beginner — Only diners can review

The most trustworthy reviews are from people who actually ate there. Tie every review to a real, completed order, and fake reviews mostly evaporate — you can't review a meal you never bought.

### 🟡 Senior — Verified-order reviews + incremental aggregates

```text
Review { order_id UNIQUE, restaurant_rating, courier_rating, text }
  one per DELIVERED order · separate restaurant vs courier · time-boxed

avg rating: keep {sum, count} per restaurant, atomic increment on write, avg = sum/count (O(1))
  — never scan reviews on the read path (same as video-streaming completion counts)
```

Anti-spam beyond verified-purchase: rate limits, duplicate-text detection, velocity checks, ML for review-bombing, human moderation queue.

### 🔴 Architect — Peak, degradation, lost events

```text
Dinner rush 5×: breaks in order → order write path → dispatch → notifications → tracking
  Kafka absorbs the burst (backlog, not meltdown); autoscale stateless; read replicas for browse;
  courier SUPPLY is the true bottleneck (can't autoscale humans) → surge + batching.

Dispatch down → degrade, never block orders:
  normal → nearest-only → accept+queue ("confirming courier") → restaurant self-delivery/pause.
  Works because dispatch is AFTER the commit (event-driven).

Lost "order created" event → OUTBOX (structural) + reconciliation sweep (backstop) + idempotent consumers.
  Same failure/fix as video-streaming A31 (wrote output, crashed before notifying).
```

Depth: [distributed-transactions](../distributed-transactions/), [message-queues](../message-queues/) (DLQ, backpressure).

---

## 9. Frontend Architecture

### 🟢 Beginner — Show fast, confirm true

The app should feel instant (show the cached menu, animate the courier smoothly) but never lie about money. Anything that costs the customer — the final price, whether an item is really available — is confirmed with the server before they pay.

### 🟡 Senior — Client patterns

```text
Menu: cache immutable body (by menu_version); subscribe to availability deltas ONLY while
  viewing this restaurant; snapshot-on-focus otherwise; grey-out sold-out (no layout jump).

Cart: optimistic local ⇄ canonical server (keyed by customer); version to detect multi-device;
  client shows price diffs; never computes the final total.

Tracking: SSE + marker interpolation (make 3–5s cadence look continuous);
  snapshot-on-reconnect then stream; throttle/stop when backgrounded/delivered; binary deltas.
```

### 🔴 Architect — Correctness on a flaky network

```text
Two rules that keep a mobile client correct:
  1. every mutating action carries an idempotency key → retries can't double-order
  2. the client NEVER owns money/availability truth → server re-validates at checkout

Ambiguous send (request sent, response lost): QUERY order status, don't blindly resubmit.
Offline writes: queue + replay on reconnect (safe because of idempotency keys).

Price consistency: menu_version handshake → server detects staleness → proceed / show-final /
  409 re-confirm. Guarantee is "customer confirms the authoritative price before paying,"
  not "client is always fresh" (impossible on mobile).
```

This is the [communication-protocols](../communication-protocols/) at-least-once + idempotency reliability spine, applied client-side.

---

## 10. Real-World Case Notes

- **DoorDash — dispatch as the core IP.** The assignment engine (which courier, when, batched or not) is the hardest and most valuable system; prep-time prediction and just-in-time offer timing are where most engineering goes. Order flow is event-driven; dispatch is downstream so an order never fails because dispatch is busy.
- **Swiggy / Zomato — dense-city batching.** In dense metros, batching (multiple orders per courier from clustered restaurants) is a major efficiency lever, bounded hard by food-cooling limits.
- **Uber Eats — reuse of the rides stack.** Geospatial (H3), courier location, matching, and live tracking are shared with the ride-sharing platform; the food-specific additions are catalog/availability, the restaurant accept gate, and prep-aware timing.
- **Gopuff — the fixed-inventory variant.** No restaurant gate, no prep phase; the whole problem collapses to nearby-DC availability queries (<100ms, cached) + atomic no-oversell orders (a single `SERIALIZABLE` transaction, read replicas for availability, leader for orders, inventory partitioned by region). It's effectively [seat-reservation](../seat-reservation/) + a geospatial "nearby DC" service — which is why the broad marketplace design *contains* the Gopuff design as a special case.

---

## Quick Recall Cheat Sheet {#cheat-sheet}

| # | Concept | One-line recall |
|---|---|---|
| 1 | Uber-for-food fallacy | Prep delay + perishable output + real inventory = genuinely harder |
| 2 | Three parties | Customer + restaurant + courier; two accept gates, one prep delay |
| 3 | Three paths | Browse (cache/eventual) · Order (strong) · Track (streaming) |
| 4 | QPS shape | Browse dominates reads; courier GPS dominates writes (~125K/s) |
| 5 | Path separation | Never let browse load starve the order write path |
| 6 | Menu model | Restaurant→Category→Item→ModifierGroup→Modifier; cents, not floats |
| 7 | Menu caching | Cache heavy body by immutable menu_version; overlay volatile availability |
| 8 | Availability propagation | Fast push = UX only; oversell guarded only at checkout |
| 9 | Consistency ladder | browse eventual → add-to-cart soft → checkout strong |
| 10 | Counted inventory | Guarded decrement (seat-reservation no-oversell) |
| 11 | Price authority | Client sends IDs + menu_version; server computes price |
| 12 | Cart drift | Snapshot for display, re-resolve at checkout, surface diffs |
| 13 | Serviceability | Filter pipeline: geo → open → polygon → supply → ETA cap |
| 14 | Search | Inverted index (ES) fed by CDC; full-text ∩ geo ∩ facets |
| 15 | Ranking | After serviceability, before render; personalization precomputed |
| 16 | Pre-order ETA | 3 statistical predictions summed; conservative range |
| 17 | Placement core | validate→total→authorize→create(idempotent)→emit |
| 18 | Commit point | Order creation; before = reversible, after = eventual |
| 19 | Idempotency | Client UUID reused on retry; passed to payment provider |
| 20 | Authorize-then-capture | Hold at placement, capture at accept, void on reject |
| 21 | Partial availability | Force remove/substitute/cancel; never silent auto-drop |
| 22 | State machine | PLACED→CONFIRMED→PREPARING→PICKED_UP→EN_ROUTE→DELIVERED |
| 23 | Dispatch parallel | Courier assigned WHILE food cooks; converge at ready |
| 24 | Event-driven | Commit sync, fulfill async — decoupling vs eventual consistency |
| 25 | Saga | Forward steps + compensations for cross-service consistency |
| 26 | Transactional outbox | Event in same txn as order row → event iff committed |
| 27 | Restaurant gate | Accept/reject/timeout; reject-before-capture = free void |
| 28 | Cancel cost | Whoever incurred cost gets compensated; early = free |
| 29 | Gopuff contrast | No gate/prep; fixed inventory + atomic order = seat-reservation |
| 30 | Prep-aware dispatch | Assign to arrive at food_ready, not ASAP |
| 31 | Assignment equation | offer = food_ready − courier_to_restaurant |
| 32 | Courier matching | Reuse ride-sharing offer/score; objective = JIT + batch + multi-leg |
| 33 | Batching | Stack if detour keeps both within (strict) lateness cap |
| 34 | Reassignment | Re-evaluate against remaining clock; widen/incentivize/hold |
| 35 | Prep-time estimate | The linchpin; ML + merchant "ready" signal |
| 36 | Live tracking | courier GPS→Redis→pub/sub→SSE/WS→customer (reuse ride-sharing) |
| 37 | Transport asymmetry | SSE for customer (receive); POST for courier upload |
| 38 | Composite ETA | Sum 3 legs; shift live-vs-predicted; smooth |
| 39 | Tracking scale | 50K conn/server; sticky LB; lazy subscribe; throttle pre-pickup |
| 40 | Milestone notifications | Push/SMS for closed-app; idempotent/deduped |
| 41 | Reviews | One per delivered order (UNIQUE) = verified purchase |
| 42 | Ratings at scale | Incremental sum/count; O(1) read; never scan |
| 43 | Peak 5× | Kafka absorbs burst; courier supply is the real bottleneck |
| 44 | Degrade dispatch | Never block orders; queue and assign late |
| 45 | Lost event | Outbox (structural) + reconciliation (backstop) + idempotent consumers |
| 46 | Frontend menu | Cache body, subscribe availability deltas only while viewing |
| 47 | Frontend cart | Optimistic local, canonical server, version for multi-device |
| 48 | Frontend tracking | SSE + interpolation; snapshot-on-reconnect; throttle backgrounded |
| 49 | Flaky network | Idempotency key + client never owns money/availability truth |
| 50 | Price consistency | menu_version handshake; confirm authoritative total before pay |
