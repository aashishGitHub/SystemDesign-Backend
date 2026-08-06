# Interview Questions: E-Commerce Platform (Amazon / Shopify)

> Attempt each question cold before reading [answers.md](./answers.md).
> Work level-by-level; later levels assume earlier concepts.
> This is an **umbrella topic** — it reuses depth from neighbours instead of duplicating it: [kv-store](../kv-store/) (cart/Dynamo), [seat-reservation](../seat-reservation/) (no-oversell, flash sale), [distributed-transactions](../distributed-transactions/) (order saga, idempotency, payments), [message-queues](../message-queues/) (outbox), [distributed-caching](../distributed-caching/) / [cdn-edge](../cdn-edge/) (catalog reads), [search-autocomplete](../search-autocomplete/) / [recommendation-system](../recommendation-system/) (discovery). A dedicated [payment-system](../payment-system/) topic owns the money-correctness depth (ledger, idempotency, reconciliation, chargebacks).

---

## Level 1 — Fundamentals & Requirements
*Goal: see e-commerce as a consistency gradient (browse → cart → checkout → fulfill) before designing anything.*

**Q1.** An e-commerce platform spans catalog, cart, checkout, and fulfillment. Why can you *not* serve all four from one service, one database, and one consistency model? What is the organizing insight?

**Q2.** Identify the distinct traffic paths and the guarantee each needs (consistency, availability, latency). Why does the required consistency *increase* as a user moves from browsing to buying?

**Q3.** State the functional and non-functional requirements. What are the hard guarantees (no oversell, no double-charge, cart never lost, product pages fast)? What scale do you design against (Amazon-scale)?

**Q4.** Back-of-the-envelope: estimate QPS for product-page views vs add-to-cart vs order placement. Which dominates, and what does that tell you about where to spend engineering effort?

**Q5.** List the core entities (Product/SKU, Inventory, Cart, Order, Payment, Shipment) and the minimal API set to browse, add to cart, check out, and track an order.

---

## Level 2 — Catalog & Product (the read path at massive scale)
*Goal: serve product data fast and globally — this is ~90%+ of traffic.*

**Q6.** Design the product catalog model: products, variants/SKUs, categories, attributes, media. Where is the source of truth and what store backs it?

**Q7.** Product pages are the bulk of traffic. How do you serve them in <100ms globally? Where does caching live, what's the invalidation story, and what's the source of truth?

**Q8.** Design product search and filtering (keyword, category, price, brand, rating, "in stock"). What backs the index and how does it stay fresh when the catalog changes?

**Q9.** The product page shows price and an inventory badge ("Only 2 left", "In stock"). How fresh must these be, and is that badge the thing that prevents overselling? (careful)

**Q10.** Two users see a different homepage / "recommended for you." Where does personalization/ranking sit in the request path, and how do you keep it off the hot path?

---

## Level 3 — The Cart (availability-first)
*Goal: the subsystem that must never say no.*

**Q11.** Why is the shopping cart the canonical "always available" subsystem, and why is a Dynamo-style AP store the classic choice? Model the cart.

**Q12.** A user adds items on their phone and their laptop concurrently (or while one device is offline). The cart diverges. How do you merge the two versions?

**Q13.** Does adding an item to the cart reserve inventory? Defend your answer. If not at add-to-cart, then *when and where* does stock get reserved?

**Q14.** Handle guest carts vs logged-in carts: persistence, TTL, and merging a guest cart into the user's account cart on sign-in.

---

## Level 4 — Checkout, Orders & No-Oversell (strong consistency)
*Goal: exactly one order, exactly one charge, never oversell — the money path.*

**Q15.** Walk the checkout flow from "tap Place Order" to "order confirmed." What must be atomic, and what can be eventually consistent?

**Q16.** Two customers race to buy the last unit in stock. How do you guarantee you never oversell? Optimistic vs pessimistic locking; where is the authoritative check? (reuse [seat-reservation](../seat-reservation/))

**Q17.** The customer double-clicks "Place Order" or the request is retried. How do you guarantee exactly one order and exactly one charge? (idempotency keys)

**Q18.** Explain the payment flow. Why authorize-then-capture rather than charging immediately, and *when* do you capture? How does the order service coordinate with payment?

**Q19.** A slow payment must not let two people buy the same last unit. How do you *hold* inventory during checkout with a TTL and release it on abandonment? (reuse [seat-reservation](../seat-reservation/) / [distributed-caching](../distributed-caching/))

---

## Level 5 — Order Orchestration (saga / event-driven)
*Goal: coordinate a multi-service workflow where any step can fail.*

**Q20.** Placing an order must charge payment, decrement inventory, create the order, and trigger shipping — each service owns its own database, no shared transaction. How do you keep them consistent? (saga — reuse [distributed-transactions](../distributed-transactions/))

**Q21.** Choreography vs orchestration saga for checkout — which do you choose and why? Give the compensating action for each step.

**Q22.** How do you atomically commit the order *and* publish an `OrderPlaced` event without a dual-write that can lose one of them? (transactional outbox — reuse [message-queues](../message-queues/))

**Q23.** Draw the order state machine (created → paid → fulfilled → shipped → delivered → returned/refunded), including cancellation and failure branches.

**Q24.** *(Failure mode)* Payment succeeded but the `OrderPlaced` event was lost before fulfillment saw it. How do you detect and recover? (reconciliation / outbox)

---

## Level 6 — Inventory & Fulfillment at Scale
*Goal: stock accuracy across warehouses and under peak.*

**Q25.** Inventory lives across many warehouses / fulfillment centers. Where is the source of truth, and how do you allocate an order to a warehouse?

**Q26.** Prime Day: 100K people try to buy the same discounted item at 10:00:00. What breaks first, and how do you handle the thundering herd? (reuse [seat-reservation](../seat-reservation/), [rate-limiting](../rate-limiting/))

**Q27.** With inventory distributed across regions/warehouses, strict global counting is expensive. What's the tradeoff between reserving-then-reconciling and occasionally overselling-then-apologizing?

**Q28.** *(Failure mode)* The shipping service is down during peak. How do you degrade gracefully so customers can still place orders?

---

## Level 7 — Consistency, Freshness & Data
*Goal: correctness across services and keeping derived data fresh.*

**Q29.** A seller changes a price. How do you stop a stale price (cached at the edge / in search) from being honored at checkout? What consistency model applies to browse vs to checkout?

**Q30.** Read-your-writes: a user places an order then immediately opens "My Orders," or a seller edits a listing then views it — how do you avoid showing stale state served from a read replica? (reuse [sharding-replication](../sharding-replication/))

**Q31.** How do you shard the products and orders data? How do you handle a hot product (a viral item) or a hot customer? (reuse [sharding-replication](../sharding-replication/), [consistent-hashing](../consistent-hashing/))

**Q32.** Returns, refunds, and chargebacks: how must the order and payment data be modeled to support them cleanly? (reuse [distributed-transactions](../distributed-transactions/); deeper ledger design → [payment-system](../payment-system/))

---

## Level 8 — Scale, Peak & Fault Tolerance
*Goal: Black Friday and surviving partial failure.*

**Q33.** Black Friday: traffic is 10–50× normal for a few hours. What is your capacity and graceful-degradation plan (load shedding, static fallback, waiting room/queue)?

**Q34.** Multi-region / global deployment: what is global (catalog) vs regional (orders, inventory)? How do you handle data residency and region failover? (reuse [cdn-edge](../cdn-edge/), [sharding-replication](../sharding-replication/))

**Q35.** What do you monitor for the buy funnel, and what are the key SLOs (add-to-cart success, checkout success rate, oversell rate, p99 product-page latency)? (reuse [observability](../observability/))

**Q36.** Abuse and fraud: scalping/sneaker bots at drop time, payment fraud, coupon/promo abuse, fake reviews. Where do you detect and block each? (reuse [rate-limiting](../rate-limiting/))

**Q37.** *(Failure mode)* The catalog cache/DB tier degrades at peak. What do users see, and how do you keep browsing *and* buying alive?

---

## Level 9 — Frontend Architecture (Architect)
*Goal: the client-side of the buy funnel under real network and SEO constraints.*

**Q38.** Design the rendering strategy for product listing and product-detail pages. SSR vs SSG/ISR vs CSR — how do you balance SEO, first-paint speed, and personalization?

**Q39.** Manage cart state on the client: optimistic add-to-cart, cross-device/logged-in sync, offline behavior, and price/availability re-sync at checkout.

**Q40.** Design the checkout UX: multi-step form state, idempotent submit from the client, handling payment redirects / 3-D Secure, and preventing a double-submit.

**Q41.** The user is on a flaky mobile network across the funnel. How do you keep it responsive and correct — optimistic UI, ret/retry, not losing a cart, not double-placing an order?

**Q42.** Performance and conversion: Core Web Vitals for the funnel, code-splitting, image optimization, prefetching the next step. Why is checkout latency directly a revenue problem?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** Buy-Now / 1-Click ordering — how does it change the flow (stored payment + address, skipping the cart), and what are the risks?

**QB2.** Marketplace with third-party sellers: a single cart spans multiple sellers. How do you split it into orders/shipments and settle payments to each seller?

**QB3.** Pricing & promotions engine: dynamic pricing, coupons, cart-level discounts, tax. Where is the final price computed and why not at the edge?

**QB4.** "Frequently bought together" / recommendations in the funnel — where do they sit, and offline vs online computation? (reuse [recommendation-system](../recommendation-system/))

**QB5.** Inventory as an event-sourced ledger of stock movements — what does that buy you for auditability and reconciliation?

**QB6.** Digital goods (ebooks, game keys) vs physical goods — how does the fulfillment path and inventory model differ?
