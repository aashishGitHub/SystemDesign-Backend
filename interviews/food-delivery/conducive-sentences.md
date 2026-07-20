# Food Delivery (DoorDash / Swiggy / Uber Eats) — Answers in Plain English

> This file rewrites every answer from [answers.md](./answers.md) as complete, connected sentences.
> Read this when you want to *understand*, not just recall. Read answers.md when you want to *review*.
> Every section ends with a "So, the connection is..." sentence that links it to the next concept.

---

## Level 1 — Fundamentals & Requirements

### A1. Why food delivery is harder than ride-sharing

It is tempting to call food delivery "Uber for food," but that framing hides three differences that reshape the whole architecture. First, it is a *three-sided* marketplace — customer, restaurant, and courier — where ride-sharing has only two sides, and the restaurant is an active participant with its own accept-and-prepare workflow rather than an interchangeable resource. Second, the product is *perishable food produced on a delay*: unlike a trip that begins the moment a driver arrives, the food has to be cooked, so the courier must show up exactly when it is ready rather than as soon as possible. Third, restaurants have *menus with real-time availability*, so "sold out" must propagate in seconds and overselling an item means a genuinely angry customer — ride-sharing has no inventory at all.

The single biggest architectural consequence is that **you cannot dispatch a courier as soon as possible**. Ride-sharing's objective is to minimize time-to-pickup; food delivery's objective is to land the courier at the restaurant the instant the food is ready. That turns dispatch into a two-variable coordination problem — prep-time estimate multiplied against courier arrival time — that simply has no analog in ride-sharing.

*So, the connection is:* because ordering, browsing, and tracking behave so differently, the very first design move is to separate the traffic into distinct paths, each with its own guarantees.

---

### A2. The three traffic paths

A food-delivery platform is really three systems wearing one name, and a strong design separates them immediately. The *discovery* path — nearby restaurants, menus, search — is about ninety percent of all traffic, is read-heavy, and tolerates slightly stale data, so it lives on caches, CDNs, and read replicas and only needs to be fast, not perfectly fresh. The *ordering* path — cart, place, pay — is transactional and cannot tolerate overselling an item or double-charging a card, so it must reach the source of truth with strong consistency and idempotency, even though it is comparatively low volume. The *tracking* path — live courier location and status pushes — is an ephemeral streaming firehose served over WebSocket or SSE with a pub-sub backplane, where only the latest position matters.

Conflating these is the classic mistake, because each scales on completely different infrastructure: caches for browse, a strongly-consistent store for orders, and a connection-fan-out fleet for tracking. This is the same read-path/write-path split that both ride-sharing and seat-reservation make, just extended to a third, streaming path.

*So, the connection is:* the reason the ordering path is so much more delicate than ride-sharing's is the extra actor sitting in the middle of it — the restaurant.

---

### A3. Why the restaurant as a first-class actor complicates everything

In a two-sided system like ride-sharing, the flow is almost deterministic once a driver accepts: request, match, accept, go. Adding the restaurant as a first-class actor breaks that simplicity in three ways. It introduces a *second acceptance gate* — the restaurant can reject the order after the customer has already paid, which no rideshare driver's acceptance can do to a rider. It introduces an *unobservable, variable prep time* — you cannot directly see how long the kitchen will take, yet the entire dispatch plan depends on that number. And it introduces a *physical synchronization point* — the courier and the finished food must converge at the same place at the same moment, where ride-sharing only needs the driver to reach the rider.

None of these exist when any driver can serve any rider. Each one — the post-payment reject, the hidden prep delay, the convergence — becomes a design problem that food delivery must solve and ride-sharing never faces.

*So, the connection is:* before designing for these complications, you size them — a back-of-the-envelope tells you where the traffic, and therefore the engineering effort, actually goes.

---

### A4. Back-of-the-envelope QPS

Starting from twenty million orders a day and dividing by the roughly eighty-six thousand seconds in a day gives about two hundred and thirty orders per second on average, rising to perhaps twelve hundred per second in the dinner rush. But orders are the *end* of a funnel: customers view many menus and screens per order, so at fifteen views per order the browse traffic is around three hundred million views a day, or several thousand queries per second on average and tens of thousands at peak. Meanwhile roughly half a million couriers active at peak, each sending GPS every four seconds, generate on the order of a hundred and twenty-five thousand location writes per second.

Two things fall out of this. Browse dominates the *read* volume, so the read path deserves aggressive caching, and courier location updates dominate the *write* volume, so they belong in an ephemeral in-memory hot store rather than a durable database — exactly ride-sharing's conclusion about driver locations. Orders themselves are low-volume but high-value, so there the priority is correctness, not raw throughput.

*So, the connection is:* with the shape of the load understood, you can name the concrete entities and the small set of APIs that the whole product hangs off.

---

### A5. Core entities and APIs

The domain reduces to a handful of entities: a Restaurant (with its location, hours, open/paused status, and prep-time statistics); a MenuItem (belonging to a restaurant, with price, category, modifiers, and an availability flag); a Cart; an Order (carrying its state, items, totals, and eventually a courier); a Courier (with location and status); and a Review. The primary APIs mirror the customer's journey — get serviceable ranked restaurants for an address, get a restaurant's menu with availability, build a cart, place an order with an idempotency key, get order status with the live courier location, open a tracking stream, and post a review.

The minimal path to the product is discover, menu, cart, order, track, review, and everything else — payments, dispatch, notifications — hangs off the single act of placing an order.

*So, the connection is:* the journey begins with browsing, and browsing rests on a merchant-controlled catalog whose availability has to stay accurate in real time — which is the menu problem.

---

## Level 2 — Catalog, Menu & Real-Time Availability

### A6. Menu data model

A menu is a small hierarchy: a restaurant has a menu, which has categories, which contain items, and each item can have modifier groups ("choose a size") containing modifiers ("large, plus two dollars"). Modeling modifiers as their own entities matters because "no onions," "large," and "extra cheese" each carry their own price and their own availability — a restaurant can run out of a single topping without disabling the whole item. Prices are always stored as integer cents, never floats, because money must be exact.

The subtle but important field is versioning: the menu carries a `menu_version`, so a cart can pin the version it was built against and a mid-service edit by the restaurant doesn't silently corrupt an in-flight cart. Because menus are document-shaped and read far more than written, they suit a document store keyed by restaurant, or a Postgres row with a JSONB blob; the restaurant's editing path is low-traffic while the customer's reading path is enormous and cached.

*So, the connection is:* since that reading path is enormous, the next problem is serving menus to millions of customers with very low latency, which is a caching problem.

---

### A7. Serving menus at low latency

The menu's source of truth is a per-restaurant, versioned database, but almost no read should reach it. Instead a write-through populates a Redis cache that absorbs most reads, and the menu JSON is cacheable at the CDN or edge as well. The trick that makes this clean is caching *by menu version*: a key like `menu/{restaurant_id}/v{version}.json` is effectively immutable, so it can carry a long time-to-live, and publishing a new menu simply bumps the version — a brand-new immutable key — rather than mutating an existing one. This is the same content-addressing idea that makes video segments cacheable forever.

Because the version-keyed body never changes, the volatile part — availability — is layered on top separately rather than baked into the cached body, which keeps the heavy menu static and cacheable while the small availability delta stays fresh.

*So, the connection is:* that separation of the stable menu from the volatile availability is exactly what lets you propagate a "sold out" in seconds without throwing away the cache.

---

### A8. Real-time "sold out" propagation

When a restaurant marks an item sold out, the availability service records the item as unavailable in both Redis and the database and publishes an availability-changed event. That event fans out two ways: it updates the availability overlay for the restaurant, and it pushes to any customer currently viewing that menu over a WebSocket or SSE connection. A browse response is then assembled as the cached menu body combined with the live availability overlay, so the customer sees the item disappear quickly.

The crucial honesty here is that fast propagation does not *prevent* overselling — it only shrinks the window and improves the experience. Browse is eventually consistent and might show an item as available for a second or two, and add-to-cart is only a soft check. Overselling is actually prevented at exactly one place: the authoritative availability re-check performed at checkout against the source of truth.

*So, the connection is:* if availability must be re-checked authoritatively at checkout, then price must be handled the same way, because a cached menu can just as easily show a stale price.

---

### A9. Stale price at the edge

The browse price can be stale because it is served from a cache, and that is fine as long as it is treated as informational. The checkout price, by contrast, is recomputed server-side from the source of truth and is authoritative. The rule that makes this safe is that *the client never gets to name the price*: the client sends the item and modifier identifiers along with the menu version it saw, and the server computes the total from the current menu at order time.

If the price has changed since the customer looked, a small increase within a tolerance can simply proceed with the final price shown on the confirmation screen, while a material change returns a "price changed" response that shows the difference and requires the customer to re-confirm. This is the same discipline as content-addressed systems elsewhere — the client asserts *what* it wants, and the server decides *how much* it costs.

*So, the connection is:* the same drift that changes a price can also change or remove an item entirely while it sits in a customer's cart, which is the cart-reconciliation problem.

---

### A10. Cart references a changed item

A cart stores a price snapshot and menu version per line so it can be displayed quickly, but checkout re-resolves every line against the live menu. If an item has been removed or marked unavailable, that line is flagged as removed; if its price has changed, the line is flagged as changed with the new price. The result is a list of issues — empty means proceed, non-empty means surface a re-confirmation screen to the customer.

The point is to keep the browsing experience fast by trusting the snapshot for display, while keeping the money correct by re-resolving against the source of truth at the moment it matters. Divergence is always surfaced to the customer, never silently applied.

*So, the connection is:* browsing a menu presupposes the customer has already found a restaurant that can actually deliver to them, which is the discovery problem.

---

## Level 3 — Discovery: Nearby, Search & Ranking

### A11. Serviceable restaurants

The naive version of discovery is "restaurants within some radius," and the geospatial machinery for that — dividing the map into geohash, S2, or H3 cells and querying the customer's cell plus its neighbors — is borrowed directly from ride-sharing's driver search. But real serviceability is more than distance. The restaurant must actually be open, accounting for both its hours and any manual pause. The customer's address must fall inside the restaurant's delivery zone, which is often a hand-drawn polygon rather than a circle. There must be courier supply in the area right now, or the restaurant is effectively unreachable. And the estimated total time must be under some maximum.

So serviceability is a *filter pipeline*, not a distance sort: start with geospatial candidates, then keep only those that are open, then only those whose delivery polygon contains the address, then only those with courier supply, then only those with an acceptable ETA.

*So, the connection is:* once you have the set of serviceable restaurants, the customer needs to search and filter within it, which is a search-index problem.

---

### A12. Search and filtering

Search is backed by a dedicated search index such as Elasticsearch, where each document represents a restaurant along with its dishes, cuisines, price band, rating, average prep time, geography, delivery zones, and badges. A query combines full-text matching on dish or restaurant names with a geographic filter and facet filters like cuisine, minimum rating, "free delivery," or maximum delivery time, and the surviving results are ranked.

The index is fed asynchronously from the menu and restaurant databases through change-data-capture or events, so search is eventually consistent with the catalog, and the most volatile fields — whether a restaurant is open, its live rating — are either refreshed frequently or overlaid at read time. The typeahead on the search box is a separate concern with its own dedicated topic.

*So, the connection is:* search narrows the candidates, but the order in which they are shown is decided by ranking, which is where personalization enters the request path.

---

### A13. Ranking and personalization

Ranking sits after the serviceability filter and before the results are rendered. The pipeline takes the serviceable candidates, fetches features for each — distance, ETA, rating, the customer's past orders, price fit, active promotions — scores them with a ranking model, and produces the feed. To keep latency low, the heavy personalization signals (embeddings, "you ordered pizza last week") are precomputed offline and simply looked up, while only light features are computed per request.

Because two customers at the same address have different order histories and preferences, they see different feeds even though their serviceable set is identical. This is fundamentally a recommendation-and-feed problem, and the depth of ranking and feed assembly lives in the recommendation-system and social-feed topics.

*So, the connection is:* the feed shows a delivery-time estimate next to each restaurant, and producing that number before any order exists is its own prediction problem.

---

### A14. Pre-order delivery estimate

The "thirty to forty minutes" shown on the browse screen is composed of three predicted pieces — the predicted prep time for this restaurant at this time of day, the predicted time for a courier to reach the restaurant given local supply, and the predicted time from the restaurant to the customer given distance and traffic. All three are statistical predictions drawn from historical data, because at browse time there is no order and no assigned courier to measure.

It is deliberately shown as a range and deliberately conservative, because under-promising and over-delivering beats the reverse. Once an actual order exists, this statistical estimate is replaced by the live, order-specific composite ETA computed during tracking.

*So, the connection is:* the estimate assumes an order will be placed, so the next step is turning a cart into exactly one order and one charge, safely — which is the ordering path.

---

## Level 4 — Cart & Order Placement (Consistency & Payments)

### A15. Order placement flow

When the customer taps "place order," a strongly-consistent core executes in sequence: the cart is re-validated against the live menu and availability, the authoritative total is computed from items plus fees, tax, and tip, the payment is *authorized* (funds held, not yet captured), and finally the order is created in the PLACED state with an idempotency key. That order creation is the atomic commit point — either all of these succeed or no order exists. Only after the commit does the system emit an OrderPlaced event, which asynchronously notifies the restaurant, kicks off dispatch planning, sends a receipt, and feeds analytics, before returning confirmation to the customer.

The division is deliberate: the first four steps are synchronous and strongly consistent because they involve money and correctness, while everything after the event is eventually consistent. Authorizing rather than capturing the payment keeps it reversible, so a later failure can be cleanly unwound.

*So, the connection is:* the first of those synchronous steps is re-validating availability, and getting that right is what prevents charging a customer for something that just sold out.

---

### A16. Preventing charge-for-out-of-stock

Availability is checked three times, but only the last check is authoritative. Browse uses a cache overlay purely for the display, add-to-cart does a soft cache check, and checkout does a source-of-truth read *inside* the order transaction. For genuinely limited-quantity items — a daily special with a fixed count, or Gopuff-style physical inventory — that authoritative check is a guarded decrement: an update that subtracts the quantity only if enough remains, where zero rows affected means it sold out and the order aborts. This is exactly seat-reservation's no-oversell pattern.

Most restaurant items, though, are simply boolean-available — unlimited until the restaurant marks them sold out — so the guard is just checking that the item is still available. Either way, the guarantee comes from the transactional check at checkout, not from how fast the "sold out" signal propagated.

*So, the connection is:* the checkout that performs this authoritative check can be retried by a flaky network, so it must also guarantee that a retry does not create a second order or a second charge — which is idempotency.

---

### A17. Exactly one order, one charge

The customer's client generates a single UUID for a checkout attempt and resends that same idempotency key on every retry. On the server, the order endpoint first looks up the key: if it has seen it before, it returns the stored result without creating anything new; otherwise it validates, authorizes payment, creates the order, records the key together with the result, and returns. Because the same key is also passed to the payment provider, the charge is deduplicated too.

So a double-tap or an automatic network retry produces exactly one order and one charge — the first request does the work, every repeat replays the stored outcome. This is the standard payments idempotency pattern, developed in depth in the api-design and seat-reservation topics.

*So, the connection is:* idempotency protects the *create* step, but the payment itself is handled with a two-phase authorize-then-capture precisely because the order can still fail after the customer pays.

---

### A18. Authorize-then-capture

Payment happens in two phases. At placement, the system *authorizes* — it holds the funds and verifies the card, but no money actually moves and the hold is reversible. When the restaurant accepts (or at pickup), it *captures* — actually charging the held amount. If the restaurant rejects before capture, it simply *voids* the hold and the customer is never charged.

You authorize first because the order can still fail after the customer taps pay: the restaurant might reject it, or no courier may be available. Capturing immediately would then force a refund on every such failure — slow, costly in fees, and a bad experience — whereas capturing only on accept means a rejected order is a clean, instant void. This mirrors seat-reservation's hold-then-charge model and rests on the same at-least-once-plus-idempotency reliability spine.

*So, the connection is:* the same two-phase model gracefully handles the awkward case where only some of the items in an order are available at checkout.

---

### A19. Partial availability at checkout

When an order has three items and one is unavailable at checkout, the system must not silently drop the item or block the whole order. Instead it offers the customer a choice: remove the unavailable item and proceed with the other two (recomputing the total), substitute it with something the restaurant or customer picks, or cancel the whole order. This is modeled as a required decision — a "price changed / item unavailable" response that forces a re-confirmation — rather than an automatic action.

The order is held in a pre-commit state until the customer resolves the conflict, and the payment authorization is only taken for the final, confirmed set of items. Auto-removing items erodes trust ("why are my fries missing?"), so forcing the decision is the correct default.

*So, the connection is:* once the order is committed, it enters a multi-party lifecycle where any of several steps can fail, which is the orchestration problem.

---

## Level 5 — Order Lifecycle & Event-Driven Orchestration

### A20. Order state machine

The order moves through a state machine richer than ride-sharing's trip. From PLACED it can fail outright (payment or validation) or move to REJECTED (restaurant declines, hold voided) or CONFIRMED (restaurant accepts, payment captured). From CONFIRMED it enters PREPARING as the kitchen starts, and — importantly — courier dispatch runs *in parallel* with preparation, so the courier is being assigned while the food cooks. When the food is ready and the courier is present, the order becomes PICKED_UP, then EN_ROUTE, then DELIVERED. Cancellation is reachable from the early states, each with its own compensations.

The parallelism between preparing and dispatching is the structural heart of the machine, converging at the moment "food ready and courier present." The extra states relative to a rideshare trip — the restaurant accept gate and the prep phase — are exactly the complications the restaurant-as-actor introduced.

*So, the connection is:* coordinating a machine whose steps span payment, the restaurant, and dispatch is why the flow is built on events rather than a synchronous chain of calls.

---

### A21. Why event-driven

If the order service called payment, then the restaurant, then dispatch inline, a single slow or down service would stall the whole placement, the customer would wait for the sum of everything downstream, and adding a new consumer like fraud detection would mean editing the order service. Modeling the flow as event-driven over Kafka inverts all of that: the order commits and emits an event, downstream services react independently, the customer gets a fast answer, and new consumers just subscribe to the topic.

What you gain is decoupling, resilience, and a fast customer response; what you pay is eventual consistency and harder end-to-end tracing. The order commit itself stays synchronous because the customer needs a definite answer, but fulfillment — notifying the restaurant, planning dispatch, sending the receipt — is fired as events.

*So, the connection is:* firing events across payment, inventory, restaurant, and dispatch raises the question of what happens when one of those steps fails after others have succeeded — which is where the saga and outbox come in.

---

### A22. Keeping multi-service steps consistent

Because there is no distributed transaction spanning payment, the database, and Kafka, order placement is modeled as a *saga*: a sequence of local transactions each with a compensating action. Authorizing payment is compensated by voiding the hold; creating the order is compensated by marking it failed; assigning a courier is compensated by releasing them. If a later step fails, the compensations for the earlier steps run in reverse, unwinding the order cleanly.

The companion pattern is the *transactional outbox*: the OrderPlaced event is written into an outbox table in the same database transaction as the order row, and a relay later publishes it to Kafka. This guarantees the event exists if and only if the order committed, so you never get the disaster of an order that was created but that nobody was ever told to dispatch. Both patterns are developed in the message-queues and distributed-transactions topics.

*So, the connection is:* one of the saga's steps is the restaurant's own accept-or-reject decision, which is the second acceptance gate that authorize-then-capture was designed for.

---

### A23. Restaurant accept / reject / no-response

After placement the system waits for the restaurant's decision within a timeout. On accept, it captures the payment and moves the order to CONFIRMED. On reject, it voids the authorization so the customer is never charged, tells the customer plainly that the restaurant couldn't take the order, and immediately suggests alternatives so they aren't stranded. On no response, policy decides: a high-trust restaurant may auto-accept, while others are escalated with a reminder and then rejected if still silent.

The rule that ties it together is that a reject *before capture* costs the customer nothing — it is just a voided hold — which is precisely why payment is authorized rather than captured up front. This second acceptance gate, absent in ride-sharing, is what makes the two-phase payment model necessary rather than optional.

*So, the connection is:* rejection is one way an order ends early, and cancellation is the other, with the cost of an early exit depending entirely on how far the order had progressed.

---

### A24. Cancellation cost by stage

Who pays for a cancellation depends on how much cost has already been incurred. Cancelling while still PLACED, before the restaurant accepts, is free — the hold is simply voided. Cancelling once CONFIRMED but before cooking starts is usually free or a small fee. Cancelling during PREPARING means the restaurant has already committed ingredients and labor, so the customer bears a full or partial charge and the restaurant is paid. Cancelling after pickup means the full charge stands and the courier is still paid.

Each cancellation fans out the saga's compensating actions — refund or void the payment, tell the restaurant to stop cooking if it still can, release or redirect the courier, and emit a cancellation event for analytics and fraud. The governing principle is simple: whoever has already incurred cost gets compensated, so early cancels are free and late ones are not.

*So, the connection is:* one of those compensations is releasing the courier, which raises the central dispatch question the whole system is organized around — when to assign the courier in the first place.

---

## Level 6 — Courier Dispatch & Assignment

### A25. When to assign the courier

The timing of courier assignment is the defining decision of food delivery. Assigning at order placement means the courier arrives and waits twenty minutes for food — wasted courier time and a cold hand-off. Assigning at restaurant-accept is better but still ignores how much prep times vary by dish and kitchen load. The right answer is *prep-aware*: assign the courier so they arrive at the restaurant roughly when the food is ready, which means firing the offer at a time equal to the predicted food-ready time minus the predicted courier-to-restaurant travel time.

The dispatcher recomputes this continuously as prep-time estimates update and courier supply shifts, timing the offer so the courier's arrival lands on food-ready. This just-in-time convergence — minimizing both courier idle time and how long the food sits — is exactly what ride-sharing never has to do, because there you always dispatch immediately.

*So, the connection is:* deciding *when* to assign still leaves *whom* to assign, and that scoring reuses most of ride-sharing's matching machinery with a food-specific objective.

---

### A26. Finding and scoring couriers

The mechanics of finding candidate couriers are identical to ride-sharing: a geospatial nearby query over geohash, S2, or H3 cells, scoring by ETA, distance, direction, rating, and acceptance rate, and offering the ride to one courier at a time with a timeout. All of that — the offer system, batch matching, acceptance-rate handling, fair dispatch — is reused wholesale.

What changes is the objective function. Instead of "minimize pickup time," food delivery scores couriers on how well their arrival fits the food-ready time, on their potential to batch with a nearby order, on the multi-leg cost that includes the restaurant-to-customer trip, and on food suitability like having an insulated bag. The machinery is ride-sharing's; the thing being optimized is different.

*So, the connection is:* one of those new scoring factors is batching potential, which is a distinct optimization worth understanding on its own.

---

### A27. Batching / stacked deliveries

Batching means assigning two or more orders to one courier, and it is worth doing when the restaurants are close (or the same), the drop-offs are roughly on the way, and the added detour still keeps both orders within an acceptable lateness. The risk is that the first order's food sits and cools while the courier handles the second order's pickup and drop-off, so the guardrail is a cap on the added delay per order and a hard rule never to batch if it would push either order past its promised ETA.

Batching raises courier efficiency — more deliveries per hour, lower cost, better courier earnings — but trades against food quality and per-order latency. It is the food-delivery cousin of UberPool, but constrained by perishability: a cold delivery is a failed delivery, so the lateness cap is stricter than a rideshare detour would be.

*So, the connection is:* whether an order is solo or batched, the courier might decline the offer, and reassigning without letting the food go cold is its own challenge.

---

### A28. Courier declines or doesn't respond

Reassignment reuses ride-sharing's offer loop — try the best-fit courier first, and on a decline or timeout, penalize their acceptance rate and move to the next candidate. The food-specific twist is that the food-ready clock keeps ticking, so on each decline the dispatcher re-evaluates against the *time remaining* rather than the original plan. It may widen the search radius, attach a courier incentive to make the offer more attractive, and in the worst case tell the restaurant to hold or delay cooking.

The whole point of this loop is to avoid the failure where the food is ready and sitting on the counter with no courier present. Every reassignment is racing the clock the kitchen started.

*So, the connection is:* every one of these timing decisions — when to assign, how to reassign, whether to batch — depends on one estimated number, which is why prep-time estimation is the linchpin of the system.

---

### A29. Prep-time estimation — the linchpin

The predicted prep time is a function of the restaurant's historical prep for these specific items, the current kitchen load, the time of day and day of week, and item complexity — typically an ML regression updated continuously. Its accuracy governs everything: estimate too low and the courier arrives early, waits, and idles while the food isn't ready; estimate too high and the courier arrives late and the food sits and cools; get it right and the courier and food converge just in time.

Because all of dispatch is downstream of this one number, platforms invest heavily both in prep-time ML and in merchant signals — a "food is ready now" button — that correct the estimate in real time. A wrong prep estimate makes even a flawless courier-matching algorithm produce either cold food or idle couriers.

*So, the connection is:* once a courier is assigned and moving, the customer wants to watch it happen, which is the real-time tracking problem.

---

## Level 7 — Real-Time Tracking, ETA & Notifications

### A30. Live tracking end-to-end

The courier app sends GPS every few seconds to a location service, which writes the position to a hot store and a geo-index and publishes it on a per-order pub-sub channel. A tracking service subscribed to that channel fans the updates out over WebSocket or SSE to the customer's app, where the map marker moves. This is identical to ride-sharing's tracking architecture, so it is reused wholesale — the location upload, stale detection, GPS-drift filtering, and payload reduction all transfer directly.

There is nothing food-specific about moving a dot on a map; the value is in reusing a proven design rather than reinventing it.

*So, the connection is:* the map shows not just where the courier is but when the food will arrive, and computing that number spans more than one leg of the journey.

---

### A31. Composite ETA

Unlike ride-sharing's single-leg ETA, the delivery ETA is a sum of three legs whose composition shifts as the order progresses. While the order is still preparing, the ETA is the remaining prep time plus the courier-to-restaurant time plus the restaurant-to-customer time — mostly prediction. Once the courier is en route with the food, it collapses to a single live leg: courier-to-customer, computed from GPS and routing with traffic. The ETA is recomputed as prep progresses, as the courier moves, and as traffic changes.

Crucially, the number is smoothed so the customer doesn't see it jump around — the same anti-oscillation instinct as ride-sharing's surge smoothing. Early on the ETA is dominated by a prediction; by the end it is pure live routing.

*So, the connection is:* delivering these updates to the customer's screen raises the transport question of WebSocket versus SSE versus polling, which has a different answer than the courier's own uploads.

---

### A32. Transport for tracking

For the customer's tracking screen, the data flows in one direction — the customer only receives location updates — so SSE is sufficient and simpler than a full WebSocket; a WebSocket is only warranted if there is also in-app chat with the courier. The courier's location *upload* is a different thing entirely: it is not a tracking socket at all but periodic HTTPS POSTs to the location service, because the courier app only needs to send, not maintain a live receive channel.

Distinguishing the two directions is what keeps the design efficient — you don't pay for a bidirectional socket where a one-way stream or a plain POST will do. The full comparison of these transports lives in the communication-protocols and sse topics.

*So, the connection is:* whichever transport the customer uses, holding millions of these connections open at once is a scaling problem in its own right.

---

### A33. Scaling tracking

The number of orders being tracked concurrently, divided by the roughly fifty thousand connections a single server can hold, gives the size of the tracking fleet — a couple of million trackers means around forty servers. A load balancer routes connections stickily by order, each tracking server subscribes to the relevant pub-sub channels, and the system only fans out to orders that actually have a viewer watching. Payloads are reduced to deltas, throttled to an update every few seconds, and sent in a binary format like Protobuf.

This is the same architecture and the same knobs as ride-sharing's tracking scale-out, with one food-specific optimization: most of an order's life is spent preparing, when the courier isn't moving, so high-frequency updates are only needed once the courier is en route — before pickup, you throttle hard.

*So, the connection is:* live tracking only works while the app is open, so discrete status milestones need a different delivery mechanism that reaches the customer anywhere.

---

### A34. Status notifications when the app is closed

Order milestones — confirmed, picked up, delivered — flow to a notification service that pushes them via APNs or FCM if the app is installed, falls back to SMS if push fails, and sends an email receipt on completion. These notifications are idempotent and deduplicated so a retried event doesn't double-notify the customer.

The division of labor is that live tracking over WebSocket or SSE only works while the app is open, whereas these discrete milestones must reach the customer even when it is closed, which is why they go through the push and SMS pipeline. That pipeline is a substantial concern of its own — multi-channel delivery, idempotent dispatch, quiet hours, failover — developed fully in the notification-system topic.

*So, the connection is:* after the order is delivered, the customer's last action is to rate the experience, which introduces the reviews system.

---

## Level 8 — Reviews, Scale & Fault Tolerance

### A35. Reviews and anti-spam

A review is tied to an order, with separate ratings for the restaurant and the courier plus optional text, and the schema enforces one review per delivered order by making the order ID unique. That single constraint is the strongest anti-fake-review lever there is: you cannot review what you didn't order, which kills the bulk of fabricated reviews outright. Separating the restaurant rating from the courier rating means a great restaurant isn't punished for a slow courier, and reviews are time-boxed to a window after delivery.

Beyond the verified-purchase requirement, anti-spam adds rate limiting, duplicate-text detection, burst and velocity checks, and ML heuristics for review bombing, with a human moderation queue for anything flagged. But the foundation is the verified order.

*So, the connection is:* collecting reviews is one thing; showing an aggregate rating on every restaurant card without melting the database is another.

---

### A36. Average rating at scale

Computing an average by scanning all of a restaurant's reviews on every read is a full scan and far too slow, so the aggregate is maintained incrementally: a per-restaurant row holds the running sum of ratings and the count, each new review atomically increments both, and the displayed average is simply the sum divided by the count — an O(1) read. Alternatives include stream aggregation through Kafka and Flink when you need to handle edits and deletes cleanly, or caching the computed average in Redis for the fastest possible read.

The principle is never to scan the reviews on the read path — maintain the answer as reviews arrive. This is the identical pattern to counting video completions or maintaining social-feed counters.

*So, the connection is:* maintaining counters cheaply matters most when traffic surges, which is the dinner-rush scaling problem.

---

### A37. The dinner-rush spike

When order volume jumps fivefold in an hour, things break in a predictable order: first the order-placement write path as contention builds on popular restaurants, then dispatch as courier demand outstrips supply, then notification fan-out, then the tracking connection count. The handling leans on the event-driven backbone — Kafka absorbs the write burst and consumers drain it at a sustainable rate — while stateless services autoscale and read replicas carry the browse load. Non-critical work is queued, dispatch degrades gracefully, surge pricing balances demand against courier supply, and caches for popular restaurants are pre-warmed.

The event-driven design is what makes the spike survivable, because the burst becomes a backlog in Kafka rather than a meltdown at the database — the classic load-leveling argument for a broker. The real bottleneck is courier *supply*, which you cannot autoscale because they are people, so surge and batching are the levers that matter most.

*So, the connection is:* a spike can also simply knock a service over, so the design must degrade gracefully when, for example, dispatch goes down.

---

### A38. Degrading gracefully when dispatch is down

Dispatch degrades through levels: normally it runs prep-aware, optimized, batched assignment; under load it falls back to simple nearest-available-courier with no batching; if it is fully down, orders are still accepted and queued for dispatch with the customer told "confirming your courier"; in a prolonged outage, restaurants can use their own couriers or new orders are paused in the affected area. The non-negotiable rule is that order placement is *never* blocked on dispatch.

This works precisely because dispatch is event-driven and happens *after* the order commits, so its outage degrades the experience — a courier assigned later — rather than dropping orders. The restaurant can even start cooking while dispatch is down. It is the same graceful-degradation ladder as ride-sharing's matching-service failover.

*So, the connection is:* the outbox and event backbone that make this decoupling possible also create a subtle failure mode — an event that gets lost between a committed order and the service meant to act on it.

---

### A39. Recovering a lost order event

The dangerous scenario is that payment succeeded and the order committed, but the "order created" event was lost before dispatch saw it, so the food is never cooked even though the money moved. The primary defense is the transactional outbox: because the order row and the outbox event are committed in one database transaction, the event exists if and only if the order does, and the relay retries publishing until it is acknowledged. As a backstop, a reconciliation job scans for orders stuck in an early state with no downstream progress and re-emits the event or alerts, and because consumers are idempotent, a re-emitted event is safe to process.

This is the same failure and fix as a transcoding worker that wrote its output but crashed before notifying the metadata service — make a committed record, not a fire-and-forget notification, the source of truth. The depth lives in the distributed-transactions topic.

*So, the connection is:* all of this backend correctness ultimately serves a client, and designing that client well — under real network conditions — is a distinct architectural problem of its own.

---

## Level 9 — Frontend Design (Architect)

### A40. Menu browsing with real-time availability on the client

The frontend mirrors the backend's split: the heavy menu body is fetched once and cached, immutable per menu version, while the small availability layer is refreshed live and merged into the render. To refresh availability without hammering the server, the client fetches an availability snapshot when the screen opens, subscribes over SSE or WebSocket to availability deltas for *that one restaurant* only while it is being viewed, and re-fetches a cheap snapshot on foregrounding rather than keeping a socket open in the background. Unavailable items are greyed out with a "sold out" label rather than removed, which avoids a jarring layout jump.

Opening a socket per browsing user would be ruinously expensive at scale, so the client subscribes only while actively viewing a restaurant. And it never trusts its cached availability at checkout — the server re-validates, exactly as on the backend.

*So, the connection is:* the same client that displays the menu also holds the cart, and cart state on the client has its own consistency challenges.

---

### A41. Client cart state

The cart is optimistic on the client for responsiveness but canonical on the server for correctness. Adding an item updates the UI immediately, then posts to the server and reconciles; the server returns authoritative line prices and the client shows any differences; and because the server cart is the source of truth keyed to the customer, opening the app on another device fetches and merges the server cart. A version number or timestamp on the server cart lets the client detect that another device changed it and re-sync rather than clobbering it.

The consistent thread with the backend is that the client can be optimistic about the UI but must defer to the server for anything authoritative — it never computes the final total itself, only displays snapshots and re-resolves at checkout.

*So, the connection is:* after ordering, the client's main job is the live-tracking screen, which is the receive side of the tracking system under real device constraints.

---

### A42. The live-tracking screen

The tracking screen uses SSE — receive-only, simpler than WebSocket, with automatic reconnection built in — reserving WebSocket for the case where in-app courier chat is needed. To make a three-to-five-second update cadence look continuous, the client interpolates and animates the courier marker between updates and coalesces redraws to animation frames rather than redrawing on every packet. On reconnect, the EventSource reconnects automatically and the client fetches a fresh snapshot of order state and last location before resuming the stream. For battery and data, it reduces update frequency when backgrounded, stops the stream entirely once delivered, and uses binary delta payloads rather than verbose JSON.

The client's real job here is perceptual — making a coarse update cadence *feel* smooth through animation — while minimizing socket time and redraws. The reconnect-then-snapshot pattern, getting current state on reconnect before streaming deltas, mirrors ride-sharing's tracking client.

*So, the connection is:* all of this client behavior has to hold up not on a perfect connection but on a flaky mobile network, which is the real test of the frontend.

---

### A43. Surviving a flaky network

Responsiveness on a bad connection comes from optimistic UI for actions like add-to-cart and tip changes, reconciled when the server acknowledges, and from rendering cached menus instantly with a background refresh behind skeleton loaders. Correctness comes from two rules: every mutating action carries an idempotency key so a retry cannot double-order, and the client never finalizes price or availability itself because the server is the source of truth. Writes made offline are queued and replayed on reconnect, safely, because of those idempotency keys.

The subtlest case is the ambiguous one where the request was sent but the response was lost, so the client doesn't know whether the order went through. The correct move is to *query order status* rather than blindly resubmit — the at-least-once-plus-idempotency reliability spine, applied on the client side.

*So, the connection is:* the deepest of those correctness rules — that the client never owns the price — is worth stating on its own, because it is what prevents the single most damaging trust failure.

---

### A44. Keeping the client's price consistent with the server

The failure to avoid is showing the customer twelve dollars and charging thirteen because the cached price was stale — that breaks trust instantly. The defenses are layered: cache the menu by version so the server can tell the client its version is stale and force a refetch; have the client send item and modifier IDs plus the menu version it saw, and let the server compute the price; on checkout, compare the client's version to the current one and either proceed, proceed-with-final-price-shown for a small change, or return a "price changed" response requiring re-confirmation for a material change; and always show the authoritative total on the confirm screen before the customer commits.

The guarantee is not "the client is always perfectly fresh," which is impossible on mobile, but "the customer always sees and confirms the authoritative price before paying." The menu-version handshake is what lets the server detect staleness and force a re-confirm instead of silently charging a surprise.

*So, the connection is:* these core answers cover the system end to end, and a senior engineer rounds them out by volunteering the adjacent concerns — pricing, scheduling, fraud, and more — which are the bonus questions.

---

## Bonus — Senior Questions

### QB1. Dynamic delivery pricing versus ride-sharing surge

The core surge mechanism is the same as ride-sharing — a demand-versus-supply imbalance produces a multiplier, computed per zone on a periodic cycle — so the whole surge engine, including smoothing, anti-oscillation, and fraud handling, is reused. The food-specific differences are that supply is couriers while demand is split across the restaurant and the delivery, that the platform leans more on "busy area" fees and longer promised ETAs than on raw price surge, that it can promote under-ordered restaurants rather than only raising prices, and that the three-leg journey means a distance-based delivery fee rather than a single multiplier. Customers abandon carts more readily than they abandon an urgently-needed ride, so food delivery leans on ETA adjustment and courier incentives more than on price.

*So, the connection is:* one special case of demand that the system can see coming is a scheduled order, which changes how dispatch is triggered.

---

### QB2. Scheduled orders

A "deliver at seven" order is handled by working backwards: the courier offer time is the target delivery time minus the delivery leg, the pickup leg, and the prep time, and the restaurant's start-cooking time is computed the same way. Scheduled orders are stored, and a scheduler injects them into the normal prep-aware dispatch pipeline at the right lead time. It is the purest form of prep-aware dispatch — the target time is explicit, so you literally compute backwards from it — and the hard part is capacity planning, because many seven o'clock orders create a synchronized spike.

*So, the connection is:* scheduling assumes a clean mapping from restaurant to kitchen, which breaks down for ghost kitchens.

---

### QB3. Ghost kitchens and virtual brands

A single physical kitchen can back many virtual brands — "Tony's Pizza" and "Wing Central" cooked at the same location — which share a location, a courier pool, and a prep queue, but have separate menus, branding, and reviews. The modeling insight is to decouple the customer-facing storefront or brand from the physical fulfillment location, because they are no longer one-to-one. Prep-time estimation then has to account for the shared kitchen queue across all brands, and a courier might pick up two "different restaurants" from a single door, which is natural batching.

*So, the connection is:* multiple brands and promotions across them open the door to abuse, which is the fraud problem.

---

### QB4. Promo abuse and order fraud

Promo abuse — farming new-user codes with throwaway accounts — is caught by deduplicating the real-world identity behind the accounts through device fingerprinting, payment-instrument dedupe, and per-household limits. Fake "never arrived" claims are countered with delivery photos, courier GPS at the drop point, and limits on refund-claim velocity. Courier fraud like marking an order delivered without being there is caught by geofenced completion. Collusion between a customer and courier shows up as repeated pairings and refund patterns in the order graph. Much of this overlaps ride-sharing fraud — GPS proof, velocity checks, device fingerprinting — with promo abuse as the food-specific addition.

*So, the connection is:* fraud detection runs across a system that spans many cities, which raises the question of what is local and what is global.

---

### QB5. Multi-region and multi-city

Because an order's three parties — customer, restaurant, courier — are all in the same metro, the fulfillment data is inherently local: restaurants, menus, orders, couriers, dispatch, and tracking all shard by geography and stay in-region on the hot path. Only customer accounts, payment methods, and aggregate reviews are global, and data-residency rules keep order and personal data in-region for compliance. This is the same conclusion ride-sharing reaches — the hot path is local, only identity and cross-region analytics are global.

*So, the connection is:* keeping order data in-region also serves the last cross-cutting concern, which is adjudicating refunds and disputes.

---

### QB6. Refunds, chargebacks, and disputes

The order stores a full evidentiary trail — itemized totals, price snapshots, the availability decisions made, timestamps for each state, courier GPS breadcrumbs, the delivery photo, and chat logs — and that trail is what every refund or dispute is adjudicated against. A refund is cheap when the payment was only authorized (a free void) and costly when it was already captured (a refund that loses fees), which is another reason the authorize-then-capture model matters. A dispute is resolved by replaying the stored trail against the claim, auto-refunding small amounts and sending large or anomalous ones to human review.

*So, the connection is:* this closes the loop back to A1 — every hard part of food delivery, from prep-aware dispatch to authorize-then-capture to the evidentiary order trail, traces back to the same root facts: three parties, perishable food on a delay, and real inventory — the things that make it genuinely harder than "Uber for food."

---

*End of conducive-sentences.md — all 44 answers plus 6 bonus answers from answers.md rendered as complete, connected prose.*
