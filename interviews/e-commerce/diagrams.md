# E-Commerce Platform (Amazon / Shopify) — Mermaid Diagrams

> Interview-ready diagrams. Start with Diagram 1 — the **consistency gradient** (browse → cart → checkout → fulfill) is the mental model everything hangs off. Then drill into the stage the interviewer probes.
>
> Reference: [answers.md](./answers.md) | [simple-diagram.md](./simple-diagram.md)
>
> Cross-links: [kv-store](../kv-store/) (cart/Dynamo) · [seat-reservation](../seat-reservation/) (no-oversell/flash-sale) · [distributed-transactions](../distributed-transactions/) (saga/idempotency) · [message-queues](../message-queues/) (outbox) · [distributed-caching](../distributed-caching/) / [cdn-edge](../cdn-edge/) (reads) · [search-autocomplete](../search-autocomplete/) / [recommendation-system](../recommendation-system/) (discovery) · [sharding-replication](../sharding-replication/) · [rate-limiting](../rate-limiting/) · [observability](../observability/)

---

## Diagram 1 — The Consistency Gradient (Start Here)

> **When to use:** The first thing to draw. Everything hangs off the gradient: as the shopper moves browse → cart → checkout → fulfill, required consistency rises and tolerable staleness falls. Use for Q1, Q2, Q4.

```mermaid
flowchart LR
    U(["Shopper"])

    subgraph B["1 BROWSE<br/>eventual · fast"]
        direction TB
        CAT["Catalog + Cache + CDN"]
    end
    subgraph C["2 CART<br/>available (AP)"]
        direction TB
        CART["Cart (Dynamo-style KV)"]
    end
    subgraph K["3 CHECKOUT<br/>STRONG · exactly-once"]
        direction TB
        ORD["Order + Inventory + Payment"]
    end
    subgraph F["4 FULFILL<br/>async · reliable"]
        direction TB
        SHIP["Warehouse + Shipping + Notify"]
    end

    U --> CAT
    U --> CART
    U --> ORD
    ORD -->|"OrderPlaced event"| SHIP

    NOTE["consistency ↑ · staleness ↓ · cost-of-error ↑ →"]
    B -.-> NOTE
    NOTE -.-> K

    style B fill:#dcfce7,stroke:#16a34a
    style C fill:#fef9c3,stroke:#ca8a04
    style K fill:#dbeafe,stroke:#1d4ed8
    style F fill:#fed7aa,stroke:#ea580c
    style NOTE fill:#e0e7ff,stroke:#4338ca
```

**What the interviewer is checking:**
- You split the platform by **guarantee**, not by feature — four stages, four points on the CAP spectrum.
- Browse tolerates staleness (cache/CDN); cart favors availability (AP); checkout demands strong consistency; fulfillment is async.
- You can name the cost of misapplying one stage's model to another (AP checkout oversells; CP cart loses sales).
- The `OrderPlaced` event is the seam between the synchronous buy and the async fulfillment.

---

## Diagram 2 — Catalog Read Path: Cache by Immutable Version + Availability Overlay

> **When to use:** Q6, Q7, Q9, Q29. ~90% of traffic; cache the heavy product body by version, overlay volatile price/stock, guard oversell only at checkout.

```mermaid
flowchart TD
    CATDB[("Catalog DB<br/>versioned product docs")] -->|"publish → bump version"| PCACHE[("product/{id}/v{n}<br/>immutable, long TTL")]
    PCACHE --> CDN["CDN edge"]
    CDN --> RENDER["Product page<br/>= cached body ⊕ overlay"]

    PRICE["Price / Inventory<br/>(volatile)"] --> OVERLAY[("Overlay<br/>Redis {price, in_stock}")]
    OVERLAY --> RENDER

    CHECK{"CHECKOUT<br/>re-read price + stock<br/>from source of truth"}
    RENDER -.->|"browse = eventual (UX hint)"| CHECK
    CHECK -->|"ok"| PROCEED["charge the authoritative price"]
    CHECK -->|"changed / sold out"| STOP["surface change / abort — the real guard"]

    style PCACHE fill:#dcfce7,stroke:#16a34a
    style OVERLAY fill:#fef9c3,stroke:#ca8a04
    style CHECK fill:#dbeafe,stroke:#1d4ed8
    style STOP fill:#fee2e2,stroke:#dc2626
```

**What the interviewer is checking:**
- Cache the heavy product body by **immutable version key** (publish creates a new key, never mutate a cached object).
- Split volatile **price/availability** into a small overlay so the body stays cacheable.
- The stock badge is a **UX hint**; the oversell/price guard is the **authoritative re-read at checkout** — not the cache.
- CDC-driven purge (by surrogate key) keeps the edge fresh ([cdn-edge](../cdn-edge/)).

---

## Diagram 3 — Discovery: Search Index (via CDC) + Precomputed Recommendations

> **When to use:** Q8, Q10. Search is a separate CDC-fed index; recommendations are precomputed and looked up.

```mermaid
flowchart LR
    CATDB[("Catalog / Price / Inventory DB")] -->|"CDC stream"| IDXR["Indexer"]
    IDXR --> ES[("Search index<br/>Elasticsearch")]
    U(["Shopper"]) -->|"query = text ∩ facets ∩ in-stock"| ES
    ES --> RANK["rank: relevance + popularity + margin"] --> RESULTS["results"]

    EVENTS[["clickstream / purchases"]] -->|"offline + streaming"| RECOJOB["Reco compute"]
    RECOJOB --> RECOKV[("reco:{user} → product_ids")]
    U -->|"home / product page"| RECOKV --> HYDRATE["hydrate from catalog cache"]

    style ES fill:#dcfce7,stroke:#16a34a
    style RECOKV fill:#dcfce7,stroke:#16a34a
    style RANK fill:#fef9c3,stroke:#ca8a04
```

**What the interviewer is checking:**
- Search runs on a **separate inverted index fed by CDC** — never the catalog DB directly; freshness is async.
- Query combines full-text, facets, and an in-stock filter, ranked by relevance + business signals.
- Recommendations are **precomputed offline and read on the hot path** ([recommendation-system](../recommendation-system/)) — ranking never runs in the page request.

---

## Diagram 4 — Cart: Availability-First (AP) + Conflict Merge

> **When to use:** Q11, Q12, Q14. Never reject an add-to-cart; merge concurrent versions.

```mermaid
flowchart TD
    PHONE(["phone: add book"]) --> CARTSVC["Cart Service"]
    LAPTOP(["laptop offline: add pen"]) --> CARTSVC
    CARTSVC --> KV[("DynamoDB / Cassandra<br/>cart:{user} + version vector")]

    KV --> READ{"read: 2 concurrent<br/>versions?"}
    READ -->|"no"| ONE["single version"]
    READ -->|"yes (vector clocks)"| MERGE["MERGE = union of items<br/>(add-wins)<br/>tombstone for removals"]
    MERGE --> RESULT["reconciled cart"]

    style CARTSVC fill:#fef9c3,stroke:#ca8a04
    style KV fill:#fef9c3,stroke:#ca8a04
    style MERGE fill:#dcfce7,stroke:#16a34a
    style READ fill:#dbeafe,stroke:#1d4ed8
```

**What the interviewer is checking:**
- Cart = **AP**: always writable, because a rejected add is lost revenue (the canonical Amazon/Dynamo example, [kv-store](../kv-store/)).
- Concurrent versions detected via **vector clocks**, merged by **union (add-wins)**.
- **Removals need tombstones** or a stale add resurrects a deleted item — the subtle bit.

---

## Diagram 5 — Checkout: Revalidate → Reserve → Authorize → Commit + Outbox (Idempotent)

> **When to use:** Q15, Q16, Q17, Q18, Q22. The synchronous commit core and two-phase payment, with idempotency replay.

```mermaid
sequenceDiagram
    participant C as Client
    participant O as Order Service
    participant I as Inventory
    participant P as Payment
    participant DB as Orders DB (+outbox)

    C->>O: POST /orders (Idempotency-Key K)
    O->>DB: INSERT order (K unique)
    alt K already exists
        DB-->>O: conflict
        O-->>C: return existing order (no 2nd charge)
    else first time
        O->>I: guarded decrement (WHERE available ≥ qty)
        alt sold out
            I-->>O: 0 rows
            O-->>C: sold out
        else reserved
            O->>P: AUTHORIZE (hold funds, key K)
            O->>DB: order=PAID + outbox(OrderPlaced) [one txn]
            O-->>C: order confirmed
        end
    end
    Note over DB: capture happens later, on SHIP
```

**What the interviewer is checking:**
- **Idempotency key** unique on the order row → a retry returns the same order, never a second charge.
- Oversell guarded by a **conditional decrement** (0 rows ⇒ sold out) — the single real guard.
- **Authorize now, capture on ship**; order + `OrderPlaced` written in **one txn via the outbox** (no dual-write loss).
- Only this core is synchronous; fulfillment is downstream.

---

## Diagram 6 — Inventory: Guarded Decrement + TTL Hold

> **When to use:** Q16, Q19. Reserve during checkout with a TTL so a slow payment can't oversell.

```mermaid
flowchart TD
    START["begin checkout"] --> HOLD["Redis hold:{sku}:{order}=qty<br/>EXPIRE 10 min<br/>available-to-promise −= qty"]
    HOLD --> PAY{"payment completes<br/>in time?"}
    PAY -->|"yes"| COMMIT["convert hold → decrement<br/>UPDATE ... WHERE available ≥ qty"]
    PAY -->|"no / abandon"| EXPIRE["TTL expires → hold released<br/>stock returns to available"]
    COMMIT --> DONE["order PAID"]

    HOT["hot SKU (flash sale)"] -.->|"front with"| GATE["Redis atomic DECR / token bucket<br/>DB sees only N writes"]

    style HOLD fill:#fef9c3,stroke:#ca8a04
    style COMMIT fill:#dbeafe,stroke:#1d4ed8
    style EXPIRE fill:#dcfce7,stroke:#16a34a
    style GATE fill:#fee2e2,stroke:#dc2626
```

**What the interviewer is checking:**
- A **TTL hold** at checkout start prevents a slow payment from overselling and **auto-releases** on abandon.
- The authoritative decrement is a **guarded conditional update** (the [seat-reservation](../seat-reservation/) pattern).
- A hot SKU is fronted by a **Redis atomic counter/token bucket** so the DB row isn't the bottleneck.

---

## Diagram 7 — Order Saga (Orchestration + Compensations)

> **When to use:** Q20, Q21, Q23. Multi-service consistency without 2PC; compensations on failure.

```mermaid
sequenceDiagram
    participant S as Saga Orchestrator
    participant I as Inventory
    participant P as Payment
    participant O as Order
    participant H as Shipping

    S->>I: reserve stock
    I-->>S: ok
    S->>P: authorize payment
    alt payment fails
        P-->>S: fail
        S->>I: COMPENSATE release stock
        S->>O: mark FAILED
    else ok
        P-->>S: ok
        S->>O: create order (PAID)
        S->>H: request fulfillment (async)
        Note over S,H: later step fails → compensate backward:<br/>cancel order · void auth · release stock
    end
```

**What the interviewer is checking:**
- **Saga, not 2PC**: local txn per service + a compensating action each; backward recovery on failure.
- Compensations are concrete: release stock, void authorization, cancel order.
- **Orchestration** (a coordinator owns state) suits money-critical checkout; choreography suits loose fan-out ([distributed-transactions](../distributed-transactions/)).

---

## Diagram 8 — Transactional Outbox + Event Fan-out

> **When to use:** Q22, Q24, Q28. Atomic order+event, then async fulfillment that survives a downstream outage.

```mermaid
flowchart LR
    ORD["Order Service"] -->|"one DB txn"| DB[("Orders DB<br/>order row + outbox row")]
    DB -->|"CDC / poller relay"| BUS[["Kafka<br/>OrderPlaced, Paid, Shipped"]]
    BUS --> WMS["Warehouse"]
    BUS --> SHIP["Shipping"]
    BUS --> NOTIF["Notifications"]
    BUS --> ANALYTICS["Analytics"]

    DOWN["shipping DOWN?"] -.->|"events buffer in Kafka<br/>(durable backlog)"| BUS
    RECON["reconciliation sweep<br/>PAID but not progressing → re-emit"] -.-> BUS

    style DB fill:#dbeafe,stroke:#1d4ed8
    style BUS fill:#fed7aa,stroke:#ea580c
    style DOWN fill:#fee2e2,stroke:#dc2626
    style RECON fill:#e0e7ff,stroke:#4338ca
```

**What the interviewer is checking:**
- **Outbox**: order row + event row in one txn → the event is durable iff the order is (no lost/orphan event).
- A relay publishes at-least-once; consumers are idempotent.
- A downstream outage becomes a **durable Kafka backlog**, not a checkout failure; a **reconciliation sweep** re-emits stranded orders.

---

## Diagram 9 — Order State Machine

> **When to use:** Q23, Q32. The order lifecycle including cancel, failure, and returns.

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> PAID: authorize ok
    CREATED --> FAILED: authorize fail
    PAID --> FULFILLING: allocated to warehouse
    PAID --> CANCELLED: cancel pre-ship (void auth)
    FULFILLING --> SHIPPED: capture payment
    SHIPPED --> DELIVERED: carrier confirms
    DELIVERED --> RETURN_REQUESTED: customer returns
    RETURN_REQUESTED --> REFUNDED: item received (restock + compensating ledger entry)
    FAILED --> [*]
    CANCELLED --> [*]
    REFUNDED --> [*]
    DELIVERED --> [*]
```

**What the interviewer is checking:**
- Explicit states + transitions, each **event-driven and idempotent**.
- **Capture on SHIPPED**, void on pre-ship cancel, refund as a **compensating ledger entry** on return.
- Failure/return branches are modeled, not hand-waved.

---

## Diagram 10 — Flash Sale: Gate the Herd Before the DB

> **When to use:** Q26, Q33. 100K buyers on one SKU at 10:00:00 without melting the inventory row.

```mermaid
flowchart TD
    HERD(["100K buyers @ 10:00:00"]) --> RL{"rate limit + bot check<br/>per user / IP"}
    RL -->|"blocked"| DROP["429 / captcha"]
    RL -->|"pass"| ROOM["Waiting room / queue<br/>admit at controlled rate"]
    ROOM --> GATE{"Redis atomic DECR<br/>token bucket = N units"}
    GATE -->|"no token"| SOLD["'sold out' — fail fast"]
    GATE -->|"got token"| CO["proceed to checkout<br/>guarded SQL decrement"]
    CO --> DBROW[("inventory row<br/>sees ≤ N writes, not 100K")]

    style RL fill:#fef9c3,stroke:#ca8a04
    style ROOM fill:#e0e7ff,stroke:#4338ca
    style GATE fill:#fef9c3,stroke:#ca8a04
    style SOLD fill:#fee2e2,stroke:#dc2626
    style DBROW fill:#dbeafe,stroke:#1d4ed8
```

**What the interviewer is checking:**
- Demand is **gated before the DB**: rate limit → waiting room → Redis token bucket of the actual stock.
- The SQL row sees only **as many writes as there is stock** — the herd never reaches it.
- **Fail fast + clearly** ("sold out") beats queueing everyone behind a lock ([seat-reservation](../seat-reservation/), [rate-limiting](../rate-limiting/)).

---

## Diagram 11 — Multi-Region: Global Catalog vs Regional Orders

> **When to use:** Q34, Q37. What replicates everywhere vs what pins to a region.

```mermaid
flowchart TB
    U(["Shopper"]) --> GEO["GeoDNS / Anycast → nearest region"]

    subgraph GLOBAL["GLOBAL — replicated / CDN everywhere (read-mostly)"]
        direction TB
        CATALOG[("Catalog + product content")]
        SEARCHG[("Search index")]
        CDNG["CDN edge"]
    end

    subgraph R1["REGION A — write authority for its users"]
        direction TB
        ORD1[("Orders + Inventory + Payments")]
    end
    subgraph R2["REGION B — write authority for its users"]
        direction TB
        ORD2[("Orders + Inventory + Payments")]
    end

    GEO --> CDNG --> CATALOG
    GEO --> SEARCHG
    GEO -->|"US users"| ORD1
    GEO -->|"EU users (residency)"| ORD2
    ORD1 -.->|"failover w/ RPO/RTO"| ORD2

    style GLOBAL fill:#dcfce7,stroke:#16a34a
    style R1 fill:#dbeafe,stroke:#1d4ed8
    style R2 fill:#dbeafe,stroke:#1d4ed8
```

**What the interviewer is checking:**
- **Catalog global** (replicated/CDN, easy read failover); **orders/inventory/payments regional** (residency + single write authority).
- Users routed to their region; cross-region orders are the rare, explicitly-handled case.
- Order-write failover has a defined **RPO/RTO** ([cdn-edge](../cdn-edge/), [sharding-replication](../sharding-replication/)).

---

## Quick Interview Reference

### Scale numbers (order-of-magnitude — verify)

| Metric | Value | Note |
|---|---|---|
| Orders | ~230/s avg, ~10⁴/s Prime-Day peak | Low-volume, high-value |
| Product views | ~9K/s avg, ~10⁶/s peak | Reads dominate ~1000:1 |
| Catalog | ~10⁸–10⁹ SKUs | Marketplace scale |
| Conversion | ~2–3% | Most traffic is browsing |
| Correctness bar | oversell ≈ 0, double-charge ≈ 0 | Money/stock integrity |

### Domain quick-ref

| Stage | Guarantee | Store |
|---|---|---|
| Browse | Eventual, fast | CDN + Redis + DB replicas |
| Cart | Available (AP) | DynamoDB/Cassandra |
| Checkout | Strong, exactly-once | SQL + idempotency + outbox |
| Fulfillment | Async, reliable | Kafka + saga |

### Canonical tradeoffs

- **Consistency gradient** — browse eventual · cart AP · checkout strong · fulfill async.
- **Cart AP vs checkout CP** — never reject an add vs never oversell/double-charge.
- **Saga vs 2PC** — compensations + availability vs blocking atomicity.
- **Reserve-and-reconcile vs oversell-and-apologize** — correctness vs availability, per item.
- **Authorize vs capture** — confirm funds at checkout, move money on ship.

### Common mistakes

- One DB / one consistency model for all four stages.
- Stock **badge** treated as the oversell guard (it's the checkout **decrement**).
- Strongly-consistent cart that rejects writes (lost revenue).
- Capturing at checkout instead of **authorize → capture on ship**.
- Dual-write order+event without an **outbox**.
- Synchronous fulfillment chain that melts checkout on a spike.
- No **idempotency key** → double order/charge.

---

## THE ONE TO DRAW IN THE INTERVIEW (final consolidated design)

> **When to use:** the single whiteboard diagram to reproduce from memory. It folds the **consistency gradient** — browse → cart → checkout → fulfillment — into one picture with every datastore **labeled by type**, plus the outbox + Kafka async backbone. Draw left→right (consistency rising) and narrate each stage. Pairs with [radio-walkthrough.md](./radio-walkthrough.md).

```mermaid
flowchart TD
    SHOP["Shopper (web / app)"]
    EDGE["② CDN → API Gateway + L7 LB\nedge cache · auth · rate-limit · bot defense"]
    SHOP --> EDGE

    subgraph BROWSE["③ BROWSE — EVENTUAL · reads ~1000:1 · p99 sub-200ms"]
        direction TB
        SR["Search"]
        ES[("Elasticsearch\n🔎 inverted index (CDC-fed)")]
        CAT["Catalog Service"]
        CACHE[("CDN + Redis\n⚡ cache — body by immutable version")]
        REPL[("Read replicas\n🗄️ Postgres (RDBMS)")]
        SR --> ES
        CAT --> CACHE --> REPL
    end

    subgraph CART["④ CART — AVAILABILITY-FIRST (AP) · never reject"]
        direction TB
        CS["Cart Service"]
        KV[("DynamoDB / Cassandra\n🧩 AP KV — vector clocks · add-wins")]
        CS --> KV
    end

    subgraph CHECK["⑤ CHECKOUT — STRONG / CP · ~231 ops/s (Prime Day ~10⁴/s)"]
        direction TB
        CO["Checkout / Inventory"]
        INV[("Inventory\n🗄️ Postgres — guarded conditional decrement")]
        PAY["Payment — authorize now"]
        CO --> INV
        CO --> PAY
    end

    subgraph FULFILL["⑦ FULFILLMENT — ASYNC · spike → backlog"]
        direction TB
        ORD["Order Service"]
        ODB[("Orders + OUTBOX\n🗄️ Postgres (ACID) — UNIQUE idem key")]
        FUL["Fulfillment consumer\nwarehouse · ship · capture on ship"]
        ORD --> ODB
    end

    KAFKA{{"⑥ Kafka event bus — OrderPlaced ..."}}

    EDGE --> SR
    EDGE --> CAT
    EDGE --> CS
    EDGE --> CO
    CO -->|"place order"| ORD
    ODB -.->|"outbox relay / CDC"| KAFKA
    KAFKA -.->|"drain at own pace"| FUL

    style BROWSE fill:#dbeafe,stroke:#1d4ed8
    style CART fill:#e9d5ff,stroke:#7c3aed
    style CHECK fill:#dcfce7,stroke:#16a34a
    style FULFILL fill:#fed7aa,stroke:#ea580c
    style KAFKA fill:#fef9c3,stroke:#ca8a04
```

**Store-type legend (say the type, not the brand):**

| Component | Store **type** | Defensible pick | Why this type |
|---|---|---|---|
| Product body / price overlay | **Distributed cache + CDN** | Redis + CloudFront | Reads dominate ~1000:1; immutable version key → >99% hit ratio |
| Product / order / inventory truth | **RDBMS (ACID, B-tree)** | Postgres | Transactions + `UNIQUE` idempotency + guarded decrement |
| **Cart** | **AP key-value** | DynamoDB / Cassandra | Must never reject a write; merge concurrent versions |
| Product search | **Inverted index** | Elasticsearch | Faceted/fuzzy; CDC-fed, not the source of truth |
| Event backbone / outbox relay | **Log / stream** | Kafka | Replayable; turns a Prime-Day spike into a backlog |

**Draw it in this order (and what to say):**
1. **Shopper + edge** — "CDN and gateway first; most traffic dies at the edge."
2. **Browse (blue)** — "eventual consistency; a stale price is a UX blemish, so cache/CDN + replicas + search."
3. **Cart (purple)** — "availability-first: a rejected add-to-cart is lost money → AP KV, merge later."
4. **Checkout (green)** — "strong consistency: guarded decrement = no oversell, idempotency key = no double-charge; authorize the card here."
5. **Kafka** — "order + event committed in one txn via outbox; async from here."
6. **Fulfillment (orange)** — "consumer allocates warehouse and ships; capture on ship. A spike is a backlog, not a checkout meltdown."
7. Arrow the gradient across the top: **eventual → AP → strong → async**.

**One-line thesis to close:** *"E-commerce is a consistency gradient: cache the browse path, keep the cart always-writable, make checkout strongly consistent, and run fulfillment async — four CAP points, four store types, one event bus."*
