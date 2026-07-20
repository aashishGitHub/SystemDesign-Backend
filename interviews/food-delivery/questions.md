# Interview Questions: Food Delivery (DoorDash / Swiggy / Uber Eats)

> Attempt each question cold before reading [answers.md](./answers.md).
> Work level-by-level; later levels assume earlier concepts.
> This is the **broad restaurant-marketplace** framing. For the narrower "dark-store inventory" model (Gopuff), see the contrast in Level 5 and [seat-reservation](../seat-reservation/).

---

## Level 1 — Fundamentals & Requirements
*Goal: understand why food delivery is harder than ride-sharing before designing anything.*

**Q1.** Food delivery is often pitched as "Uber for food." Name three ways it is fundamentally *harder* than ride-sharing, and why each matters architecturally.

**Q2.** A food-delivery platform has three distinct traffic paths. Identify them and explain why each has different consistency, latency, and scaling requirements.

**Q3.** It is a three-sided marketplace (customer, restaurant, courier). Why does adding the **restaurant as a first-class actor** complicate the order flow compared to a two-sided system like ride-sharing?

**Q4.** Back-of-the-envelope: 20M orders/day. Estimate QPS for menu browsing, order placement, and courier location updates. Which dominates, and what does that tell you about where to spend engineering effort?

**Q5.** List the core entities and the primary APIs. What is the minimal API set needed to browse, order, and track?

---

## Level 2 — Catalog, Menu & Real-Time Availability
*Goal: model a merchant-controlled catalog and keep availability accurate in real time.*

**Q6.** Design the menu data model. How do you represent a restaurant, categories, items, modifiers/customizations, and prices?

**Q7.** Menu browsing is ~90% of traffic and read-heavy. How do you serve menus with <100ms latency globally? Where does caching live, and what's the source of truth?

**Q8.** A restaurant runs out of an item mid-service ("sold out of biryani"). How do you propagate that to browsing users within seconds — and prevent someone from ordering it?

**Q9.** Menu data is cached at the edge, but the restaurant just changed a price. How do you avoid serving a stale price at checkout? What consistency model applies to browse vs to checkout?

**Q10.** A customer's cart references a menu item that changes (price up, or removed) between add-to-cart and checkout. How do you handle it fairly?

---

## Level 3 — Discovery: Nearby, Search & Ranking
*Goal: help a customer find something to order from.*

**Q11.** A customer opens the app. How do you find "restaurants that can deliver to my address"? Why is serviceability more than a simple radius query?

**Q12.** How do you implement search and filtering (cuisine, price, rating, delivery time, "free delivery")? What backs the search index?

**Q13.** Two customers at the same address see a different home feed. How does ranking/personalization work, and where does it sit in the request path?

**Q14.** How do you show an accurate "30–40 min" delivery estimate on the browse screen *before* an order even exists?

---

## Level 4 — Cart & Order Placement (Consistency & Payments)
*Goal: turn a cart into exactly one order and one charge, safely.*

**Q15.** Walk the order-placement flow from "tap Place Order" to "order confirmed." What must be atomic, and what can be eventually consistent?

**Q16.** How do you prevent charging a customer for an item that just went out of stock? Where do you re-validate availability?

**Q17.** The customer double-taps "Place Order" or the network retries the request. How do you guarantee exactly one order and one charge?

**Q18.** Explain the payment flow. Why authorize-then-capture rather than charging immediately, and *when* do you capture?

**Q19.** An order has 3 items; 1 is unavailable at checkout. What are the options, and how do you model the customer's choice without blocking the order?

---

## Level 5 — Order Lifecycle & Event-Driven Orchestration
*Goal: coordinate a multi-party workflow where any step can fail.*

**Q20.** Draw the order state machine from placement to delivery, including cancellation and failure branches.

**Q21.** Why model the order flow as **event-driven** (Kafka) rather than a synchronous call chain across services? What do you gain and what do you lose?

**Q22.** Placing an order touches payment, inventory, the restaurant, and dispatch. How do you keep these consistent when any step can fail? (saga / transactional outbox)

**Q23.** The restaurant must accept the order. How do you handle accept / reject / no-response (auto-accept or timeout)? What happens to the customer on a reject?

**Q24.** A customer cancels at different stages (before accept, during prep, after pickup). Who bears the cost, and what compensating actions fire at each stage?

---

## Level 6 — Courier Dispatch & Assignment
*Goal: get the right courier to the restaurant exactly when the food is ready.*

**Q25.** *When* should you assign a courier — at order placement, at restaurant-accept, or when food is nearly ready? Defend the tradeoff. (prep-aware dispatch)

**Q26.** How do you find and score candidate couriers for a pickup? What is the same as ride-sharing matching, and what is different?

**Q27.** What is order batching / stacked deliveries? When is it worth assigning two orders to one courier, and what is the risk?

**Q28.** A courier declines or doesn't respond to an offer. How do you reassign without delaying the food?

**Q29.** How do you estimate prep time, and why is an accurate prep-time estimate the linchpin of the entire dispatch system?

---

## Level 7 — Real-Time Tracking, ETA & Notifications
*Goal: keep the customer informed from confirmation to hand-off.*

**Q30.** How is live courier tracking implemented end-to-end (courier GPS → customer's map)?

**Q31.** The customer sees "arriving in 12 min." How do you compute and continuously update a **composite ETA** across the prep + pickup + delivery legs?

**Q32.** WebSocket, SSE, or polling for the tracking screen — which and why? How is this different from the courier app's own location upload?

**Q33.** How do you scale real-time tracking to millions of orders being tracked concurrently at peak?

**Q34.** Order status changes (confirmed, picked up, delivered) must reach the customer even when the app is closed. How?

---

## Level 8 — Reviews, Scale & Fault Tolerance
*Goal: trust, peak load, and surviving partial failure.*

**Q35.** Design the review/rating system. What can be reviewed, when, and how do you prevent review spam and fake reviews?

**Q36.** How do you display a restaurant's average rating and review count at scale without recomputing on every read?

**Q37.** Friday 7pm dinner rush: order volume spikes 5x in an hour. What breaks first, and how do you handle the peak?

**Q38.** The dispatch service goes down. How do you degrade gracefully so customers can still place orders?

**Q39.** A payment succeeded but the "order created" event was lost before dispatch saw it. How do you detect and recover? (reconciliation / outbox)

---

## Level 9 — Frontend Design (Architect)
*Goal: the client-side architecture — browsing, cart, and live tracking under real network conditions.*

**Q40.** Design the frontend for menu browsing with real-time availability indicators. How does the client get and refresh availability without hammering the server?

**Q41.** How do you manage cart state on the client? Handle optimistic add-to-cart, price re-sync, and a cart shared across devices.

**Q42.** Design the live-tracking screen. WebSocket vs polling on the client, map-update cadence, reconnection, and battery/data constraints.

**Q43.** The user is on a flaky mobile network. How does the frontend stay responsive and correct (optimistic UI, offline behavior, error/retry, stale data)?

**Q44.** How do you keep the client's menu/price view consistent with the server's source of truth so the customer never gets a "the price changed at checkout" surprise?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** Dynamic delivery pricing / surge — how does it differ from ride-sharing surge pricing?

**QB2.** Scheduled orders ("deliver at 7pm") — how does prep-aware dispatch change?

**QB3.** Ghost kitchens / virtual brands sharing one physical kitchen — what changes in the model?

**QB4.** Promo/coupon abuse and order fraud — how do you detect and prevent them?

**QB5.** Multi-region / multi-city deployment and data residency — what is local vs global?

**QB6.** Refunds, chargebacks, and disputes — how does order data support them?
