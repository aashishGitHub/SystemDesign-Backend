# Deep Dive: API Design (REST vs GraphQL vs gRPC)

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions


Http Status https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/409

---

## Table of Contents

1. [Why API Design Matters](#1-why-api-design-matters)
2. [REST: Resource Modeling and HTTP Semantics](#2-rest-resource-modeling-and-http-semantics)
3. [State Transitions and Business Operations](#3-state-transitions-and-business-operations)
4. [Idempotency and Safe Retries](#4-idempotency-and-safe-retries)
5. [Versioning and Evolution](#5-versioning-and-evolution)
6. [Pagination at Scale](#6-pagination-at-scale)
7. [GraphQL: Flexible Queries and Their Cost](#7-graphql-flexible-queries-and-their-cost)
8. [gRPC: High-Performance Service Communication](#8-grpc-high-performance-service-communication)
9. [API Gateway Architecture](#9-api-gateway-architecture)
10. [Error Contracts and Client Experience](#10-error-contracts-and-client-experience)
11. [Multi-Protocol Architecture](#11-multi-protocol-architecture)
12. [Real-World Company API Patterns](#12-real-world-company-api-patterns)
13. [Pattern Recognition — How to Identify API Design Decisions in Interviews](#13-pattern-recognition--how-to-identify-api-design-decisions-in-interviews)
14. [Advanced Topics for Architect-Level Design](#14-advanced-topics-for-architect-level-design)
15. [Complex Interview Questions & Answers (Architect Level)](#15-complex-interview-questions--answers-architect-level)
16. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why API Design Matters

### 🟢 Beginner — The Restaurant Menu Analogy

A restaurant menu is the API. The kitchen is the backend. You don't walk into the kitchen and cook — you read the menu, order by name, and get a predictable meal. If the menu changes every day without notice, customers leave.

APIs work the same way: they're the stable contract between your system and every client that depends on it. A bad API is a confusing menu — nobody knows what to order, and every change breaks someone's meal.

---

### 🟡 Senior — The Cost of Bad API Design

```text
Client → API Contract → Service Implementation
          ^                ^
          stable surface    changes freely
```

| Cost of Bad API | How It Manifests |
|---|---|
| Breaking changes | Mobile app crashes in production (can't hotfix shipped binaries) |
| Over-fetching | Mobile users on 3G download 10x more data than needed |
| Under-fetching | Web app makes 15 sequential calls to render one page |
| Inconsistent errors | Client team writes custom parsing for every endpoint |
| No pagination | DB query returns 1M rows, gateway OOMs |

**Gateway OOM — Why It Happens and How It Kills:**

When an endpoint returns an unbounded result set, the gateway (or reverse proxy like Nginx/Envoy) must buffer the entire response body before forwarding it to the client. A query returning 1M rows as JSON can easily produce a 500MB–2GB response payload. The gateway allocates this in memory, and under concurrent load (say 10 clients hit the same endpoint), memory usage spikes to 5–20GB — exceeding the container's memory limit. The OS kills the process (OOM kill), dropping **all** in-flight requests, not just the offending ones.

```text
OOM cascade:
  1. Client requests GET /products (no limit, no pagination)
  2. Service queries DB: SELECT * FROM products → 1M rows
  3. Service serializes to JSON → ~800MB response
  4. Gateway buffers full response before streaming to client
  5. 10 concurrent requests × 800MB = 8GB → OOM kill
  6. Gateway process dies → ALL requests fail (healthy ones too)
  7. Load balancer health check fails → node removed
  8. Traffic shifts to remaining nodes → they OOM too → cascading failure

Defenses:
  - Mandatory pagination: reject requests without limit param (return 400)
  - Max page size cap: limit=1000 max, even if client asks for more
  - Response size limit at gateway: Nginx proxy_buffer_size / client_max_body_size
  - Streaming responses: chunked transfer encoding avoids full buffering
  - Circuit breaker: trip if response size exceeds threshold
  - DB-level LIMIT: always add LIMIT N+1 in queries, even if API doesn't require it
```

The API surface is the **hardest thing to change** in a system. Database schemas, service implementations, infra — all can be migrated. But breaking API clients requires coordinating with teams you don't control.

---

### 🔴 Architect — API as Product Boundary

At review time, evaluate API design as a product decision:
- Who are the consumers? (mobile, web, third-party, internal service)
- What is the compatibility SLA? (how long before breaking changes are allowed?)
- What is the security boundary? (what must the gateway enforce vs the service?)

Real incident pattern: A mobile team shipped a release depending on a response field. Backend renamed the field in a "minor refactor." The app crashed for 3 million users. No rollback was possible — the binary was already on devices.

Architect-level rule: **treat every API response field as a published contract that cannot be removed or renamed without a versioned migration.**

---

## 2. REST: Resource Modeling and HTTP Semantics

### 🟢 Beginner — The Filing Cabinet Analogy

Think of your API as a filing cabinet. Each drawer is a resource collection (`/users`, `/orders`). Each folder inside is a specific resource (`/users/123`). You can CRUD the folders:
- **POST** a new folder into the drawer (create)
- **GET** a folder to read it
- **PUT/PATCH** to update what's inside
- **DELETE** to remove a folder

The verbs come from HTTP, the nouns come from your data model.

---

### 🟡 Senior — Resource Design Decisions

```ts
// Resource hierarchy — consistent URL structure
GET    /users/:id                     // read user
GET    /users/:id/orders              // user's orders (sub-resource)
POST   /users/:id/orders              // create order for user
GET    /users/:id/orders/:orderId     // specific order
POST   /orders/:id/cancellation       // state transition as sub-resource

// Anti-patterns:
// POST /cancelOrder          ← verb in URL
// GET  /getUserOrders        ← action, not resource
// POST /api/v1/doSomething   ← RPC disguised as REST
```

| Design Decision | Good Practice | Anti-Pattern |
|---|---|---|
| URL structure | `/resources/:id/sub-resources` | `/doAction` (verb in URL) |
| Plural vs singular | Always plural (`/users`, not `/user`) | Inconsistent mixing |
| Nesting depth | Max 2 levels (`/users/:id/orders`) | `/a/:id/b/:id/c/:id/d` (too deep) |
| Query params | Filtering, sorting, pagination | Passing IDs in query strings |
| Request body IDs | Never — extract from JWT/path | `{"user_id": "123"}` in POST body |

HTTP methods carry semantics:

| Method | Semantics | Body? | Idempotent? |
|---|---|---|---|
| GET | Read resource | No | Yes |
| POST | Create resource / trigger action | Yes | No |
| PUT | Full replace | Yes | Yes |
| PATCH | Partial update | Yes | No* |
| DELETE | Remove resource | Optional | Yes |

*PATCH can be idempotent if it's a set operation (`{"status": "active"}`), not idempotent if it's a delta operation (`{"views": "+1"}`).

---

### 🔴 Architect — The Hidden Complexity of PUT vs PATCH

PUT requires the client to send the **complete** resource. If a field is missing, it's set to null/default. This catches junior engineers off guard:

```text
Current state:   {"name": "Alice", "email": "alice@co.com", "phone": "+1234"}
PUT request:     {"name": "Alice", "email": "alice@new.com"}
Result:          {"name": "Alice", "email": "alice@new.com", "phone": null}  ← phone erased!
```

PATCH is safer for updates but has its own complexity — there's no single PATCH standard. Options:
- **JSON Merge Patch** (RFC 7386): simple key-value merge, can't set values to null explicitly
- **JSON Patch** (RFC 6902): list of operations (`add`, `remove`, `replace`), more powerful but verbose

Production choice: most teams use PATCH with merge semantics and document null-handling explicitly.

---

## 3. State Transitions and Business Operations

### Intent of This Section

State transitions are where API design meets system complexity. A payment can't be charged twice. An order can't be shipped before being confirmed. Transitions need rules.

This section bridges basic REST (read/write individual resources) and distributed systems (coordinating between multiple services). **Most API design failures happen here** — architects underestimate how many edge cases two concurrent requests create.

Understanding this section is the difference between:
- Junior engineer: "Let me add a PATCH endpoint to change status" (race conditions!)
- Senior engineer: "PATCH with ETag prevents double-charging" (optimistic locking)
- Architect: "ETag works for low-contention, but for high-contention auctions, we need distributed locks. For payment failures, we need sagas. For audit compliance, we need event sourcing." (chooses per-scenario)

---

### 🟢 Beginner — The Light Switch Analogy

A light switch has states: OFF and ON. You can't go directly from OFF to ON while someone else is switching it simultaneously. State transitions need rules about valid paths and who can trigger them.

In APIs, states are like a traffic light: RED → GREEN → YELLOW → RED. Not every transition is allowed. An order goes PENDING → CONFIRMED → SHIPPED → DELIVERED, but never SHIPPED → PENDING.

---

### 🟡 Senior — Modeling State Transitions as API Endpoints

The core question: should state changes be a verb (action) or a noun (resource)?

**Wrong way — Verb in URL:**
```
POST /orders/123/cancel
POST /orders/123/confirm
POST /orders/123/refund
```

This violates REST principles but is tempting because "cancel" feels like an action.

**Right way — Noun as sub-resource with state:**
```
POST /orders/123/cancellation       ← create a cancellation
POST /orders/123/confirmation       ← create a confirmation
POST /orders/123/refund             ← create a refund

GET  /orders/123/cancellation       ← get cancellation details
DELETE /orders/123/cancellation     ← undo a cancellation (rare, dangerous)
```

**Better way — Explicit state resource:**
```
PATCH /orders/123
{
  "status": "cancelled",
  "reason": "customer_requested"
}
```

The key difference:
- Sub-resource pattern (POST) = each transition is a **creation event** (idempotent key stores which transitions happened)
- PATCH pattern = **direct state mutation** (requires checking current state first, prone to race conditions)

| Pattern | When to Use | Risk |
|---|---|---|
| Sub-resource POST | Each transition is auditable, may have different fields per transition | URL can get long (POST /orders/:id/state-transitions) |
| PATCH status field | Simple state machine, few transitions | Race condition: PATCH assumes old state, may collide with concurrent PATCH |
| State machine validation | Transitions only allowed from valid states | Server must enforce state rules, reject invalid transitions (409 Conflict) |

**Real example from Stripe:**
```text
Stripe doesn't let you PATCH a charge status. Instead, charges auto-transition:
  1. POST /v1/charges → PENDING
  2. Async processing → CHARGED or FAILED
  3. GET /v1/charges/:id → read final status only

For refunds:
  POST /v1/charges/:id/refunds → creates a refund (separate resource, separate state machine)
  POST /v1/charges/:id/refunds → can call twice (idempotence key) → same refund
```

Why Stripe does this: Charges are immutable once charged. Refunds are separate auditable entities. This eliminates race conditions entirely.

---

### 🔴 Architect — Distributed State Transitions (The Hard Part)

This is where architects fail in interviews. Simple state transitions are easy. Real-world transitions are not.

**Challenge 1: Concurrent Requests Racing**

```text
User clicks "confirm" button → times out → clicks again
Request A: GET /orders/123 → status=PENDING
Request B: GET /orders/123 → status=PENDING
Request A: PATCH /orders/123 {status: CONFIRMED} → succeeds
Request B: PATCH /orders/123 {status: CONFIRMED} → succeeds

Now the order was "confirmed" twice.
If confirming means charging a card, they're charged twice.
```

**Defense — Version/ETag Pattern:**
```ts
// Client holds ETag for order
GET /orders/123 → returns ETag: "v123abc", body: {status: PENDING, ...}

// Client attempts state change
PATCH /orders/123
If-Match: v123abc
{status: CONFIRMED}

// Server response:
// ✅ ETag matches → proceed
// ❌ ETag mismatch → 412 Precondition Failed
//    (another request changed it first)
```

This is **optimistic locking** — best for low-contention scenarios.

**Challenge 2: Long-Running Transitions**

Some transitions take time. A payment doesn't confirm instantly:

```text
Client: POST /payments (card charge)
Server: 202 Accepted → returns Location: /payments/123/status

Client: polls GET /payments/123/status every 2s
        → PENDING, PENDING, PENDING, CONFIRMED
```

**The async pattern:**
1. POST (accepts, returns 202 + Location header)
2. GET Location (poll to check status)
3. Webhook callback (optional, for when polling is inefficient)

**Production pattern from AWS/GCP (long-running operations):**
```json
POST /v1/projects/p123/jobs/create
→ 200 OK
{
  "name": "projects/p123/jobs/job456",
  "done": false,
  "metadata": {
    "status": "RUNNING",
    "progress_percent": 45
  }
}

GET /v1/projects/p123/jobs/job456
→ 200 OK
{
  "name": "projects/p123/jobs/job456",
  "done": true,
  "result": { ... }
}
```

**Challenge 3: Distributed Consensus on State**

In a microservices world, who owns the state?

```text
Order Service owns orders (status)
Payment Service owns payments (status)
Inventory Service owns stock levels

Request: POST /orders/ with items
Flow:
  1. Order Service creates order, status=PENDING
  2. Inventory Service reserves stock
  3. Payment Service charges card
  4. If any step fails → Order Service marks status=FAILED
  5. Compensating transactions rollback partial changes

The question: what is the single source of truth for order status?
```

**Saga Pattern (most common):**
```text
Order Service orchestrates:
  1. Lock Order (status=PENDING)
  2. Call Inventory → reserve
  3. If fail → mark order CANCELLED, release locks
  4. Call Payment → charge
  5. If fail → call Inventory.release(), mark order FAILED
  6. Mark order CONFIRMED

Each service is eventually consistent with the others.
No 2-phase commit (blocks too long at scale).
```

**Event Sourcing Pattern (audit trail is authoritative):**
```text
Instead of storing: {order_id: 123, status: CONFIRMED}
Store immutable events:
  - OrderCreated { id: 123, items: [...], user_id: 456 }
  - PaymentCharged { order_id: 123, amount: 100, tx_id: abc }
  - OrderConfirmed { order_id: 123, timestamp: ... }
  - OrderShipped { order_id: 123, tracking: ... }

Current state = replay all events for that order
State is always deterministic (audit trail is source of truth)
```

Pro: perfect audit trail, can recompute state, can debug by replaying events
Con: eventual consistency between services, query models need rebuilding

---

### Architect's Decision Matrix — When to Use Which Pattern

| Scenario | Pattern | Example |
|---|---|---|
| Simple 2-3 state transitions, high consistency | PATCH with version/ETag | Order: PENDING → SHIPPED → DELIVERED |
| Transitions have side effects (payment, email) | Sub-resource POST (create event) | Charge → Refund, Invoice → Mark-Paid |
| Long-running (>10s) | Async 202 + polling | Cloud storage upload, video encoding |
| Many services involved, eventual consistency ok | Saga pattern | Food delivery: order → restaurant confirms → driver picks up → delivers |
| Perfect audit trail required, temporal queries needed | Event sourcing | Financial transactions, compliance-critical operations |
| Very high contention (thousands of transitions/sec) | Database-level locks with deadlock detection | Trading system, auction bidding |

---

### Real-World Incident Patterns

**Incident 1 — Double Confirmation Race Condition**

An e-commerce site let users click "confirm order" multiple times. Due to network lag, two requests raced:
- Request A confirmed, charged card, status=CONFIRMED
- Request B (in-flight) also confirmed, charged card again

Root cause: no PATCH etag checking, no idempotence on state transitions.
Fix: add If-Match header validation or switch to sub-resource POST with idempotency key.

**Incident 2 — State Timeout Loop**

A payment status endpoint was:
```
POST /charges → 202 Accepted
GET /charges/123/status → PENDING (querying cache)
```

Cache TTL was 30s but payment took 5s to confirm. Client polling got stuck in loop seeing PENDING for 2 minutes because cache wasn't invalidated.

Root cause: cache TTL was too long, not invalidated on state change.
Fix: webhook callback or event stream; polling with short TTL (1-2s if polling at all).

**Incident 3 — Saga Compensation Failure**

A payment completed but inventory.release() failed silently. Order was marked CONFIRMED but items weren't restored to inventory. Oversold by 50 units.

Root cause: no circuit breaker / retry logic on compensating transactions.
Fix: compensating transactions must have same reliability as primary transactions (retry policy, deadletter queue, manual remediation alerts).

---

## 4. Idempotency and Safe Retries

### 🟢 Beginner — The ATM Analogy

You withdraw $100 at an ATM. The screen freezes. Did the money come out? You press the button again. A good ATM doesn't withdraw $200 — it recognizes the duplicate and gives you the same result.

Idempotency means "pressing the same button twice gives the same result." In APIs, this prevents duplicate payments, duplicate orders, and duplicate actions when networks are unreliable.

---

### 🟡 Senior — Implementing Idempotency Keys

```ts
// Client sends: Idempotency-Key: ik_abc123
// Server flow:
async function processWithIdempotency(key: string, handler: () => Promise<Response>) {
  // 1. Check if key exists
  const cached = await redis.get(`idemp:${key}`);
  if (cached) return JSON.parse(cached); // return stored response

  // 2. Acquire processing lock (prevent concurrent duplicates)
  const acquired = await redis.set(`idemp:lock:${key}`, '1', { NX: true, PX: 30000 });
  if (!acquired) throw new ConflictError('Request already in progress');

  // 3. Process and store result
  try {
    const result = await handler();
    await redis.setex(`idemp:${key}`, 86400, JSON.stringify(result));
    return result;
  } finally {
    await redis.del(`idemp:lock:${key}`);
  }
}
```

| Design Decision | Recommendation |
|---|---|
| Key format | Client-generated UUID or deterministic hash |
| Key TTL | 24-48 hours (Stripe: 24h) |
| Scope | POST and PATCH only (GET/PUT/DELETE already idempotent) |
| Lock timeout | 30s (prevents stuck locks on crash) |
| Conflict response | `409 Conflict` if same key is being processed |

---

### 🔴 Architect — Idempotency at Scale (Stripe's Pattern)

Stripe processes millions of payment requests and their idempotency system handles:
- **Request fingerprinting**: same key + different body = error (prevent misuse)
- **Response replay**: returns exact same response including status code and headers
- **Concurrent protection**: distributed lock prevents double-processing during network retries
- **Partial failure recovery**: if processing fails mid-way, key is marked "failed" and client can retry

Production incident pattern: A client library bug sent the same idempotency key for different orders. Without body fingerprinting, this would have silently returned the old order instead of creating the new one.

```text
Idempotency store schema:
  key:           VARCHAR(255) PRIMARY KEY
  request_hash:  CHAR(64)      ← SHA-256 of normalized request body
  response_code: INT
  response_body: JSONB
  created_at:    TIMESTAMP
  expires_at:    TIMESTAMP      ← TTL index

On receive:
  1. Lookup key
  2. If found + request_hash matches → return cached response
  3. If found + request_hash differs → return 422 (misuse)
  4. If not found → acquire lock, process, store, return
```

---

## 5. Versioning and Evolution

### 🟢 Beginner — The Phone Charger Analogy

When Apple changed from the 30-pin connector to Lightning, every accessory became useless overnight. But when USB added USB-C, they kept backward compatibility — old cables still worked in old ports.

API versioning is the same: you need to add new features (new charger) without breaking existing clients (old accessories). The best approach is to make changes backward-compatible so you rarely need a new "connector."

---

### 🟡 Senior — Versioning Strategies Compared

```text
URL path:    GET /v1/users/123    → GET /v2/users/123
Header:      Accept: application/vnd.myapi.v2+json
Query:       GET /users/123?version=2
Content negotiation: Accept: application/json; version=2
```

| Strategy | Public API | Internal API | Cacheability |
|---|---|---|---|
| URL path (`/v1/`) | ✅ Best — obvious, debuggable | ⚠️ URL proliferation | ✅ Easy (different URL = different cache) |
| Header | ⚠️ Hidden from browser | ✅ Clean URLs | ❌ Harder (Vary header needed) |
| Query param | ❌ Pollutes URL, caching issues | ❌ Fragile | ❌ Every version is separate cache entry |

**What the big companies actually use:**

| Company | Strategy | Example |
|---|---|---|
| Stripe | URL path | `api.stripe.com/v1/charges` |
| GitHub | Header + URL hybrid | `Accept: application/vnd.github.v3+json` |
| Twilio | Date-based URL | `api.twilio.com/2010-04-01/Accounts` |
| Google Cloud | URL path | `googleapis.com/v1/projects/...` |

---

### 🔴 Architect — The Real Strategy: Avoid Versioning

The best version is no version. Design APIs so that most changes are backward-compatible:

| Change Type | Version Needed? | Strategy |
|---|---|---|
| Add new response field | No | Clients must ignore unknown fields |
| Add new optional parameter | No | Existing requests unchanged |
| Add new endpoint | No | Existing endpoints unchanged |
| Remove response field | **Yes** | Dual-write → deprecate → remove |
| Rename field | **Yes** | Alias both names → migrate → remove old |
| Change field type | **Yes** | New field name + deprecate old |

```text
Stripe's approach:
  - One URL version (/v1/) since 2011
  - API changelog tracks additive changes
  - Breaking changes are gated behind API version headers
  - Each Stripe account is pinned to an API version at signup
  - Account can opt-in to newer version when ready
```

This means Stripe runs ~20+ API versions simultaneously behind `/v1/`, differentiated by account-level configuration. This is the gold standard for API evolution.

---

## 6. Pagination at Scale

### Intent of This Section

Pagination isn't just "split results into pages." It's an **architectural decision with capacity implications.**
- Wrong pagination choice = database scans full table on every request = massive load
- Right pagination choice = index seek = constant performance regardless of dataset size

The difference between offset and cursor pagination matters at 100M rows. Below that, most engineers don't think about it. Good architects think about it from day 1.

---

### 🟢 Beginner — The Book Index Analogy

Imagine a book with 10,000 pages. You can't read them all at once. You need page numbers. But if someone rips out page 50 while you're reading, every page number after 50 shifts. That's the problem with offset pagination.

Cursor pagination is like a bookmark — you save your exact place, and no matter what changes around it, you can always continue from where you left off.

---

### 🟡 Senior — Three Pagination Strategies

```sql
-- 1. Offset pagination (simple but breaks at scale)
SELECT * FROM orders ORDER BY created_at DESC
LIMIT 20 OFFSET 100000;
-- Problem: DB scans and discards 100,000 rows

-- 2. Keyset/cursor pagination (fast at any depth)
SELECT * FROM orders
WHERE (created_at, id) < ('2026-03-15T10:00:00Z', 'ord_999')
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- Problem: no random page access

-- 3. Seek-based with composite cursor (production-grade)
SELECT * FROM orders
WHERE created_at < $cursor_ts
   OR (created_at = $cursor_ts AND id < $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT 21;  -- fetch one extra to determine has_more
```

| Strategy | Performance at Page 1 | Performance at Page 500 | Random Access | Mutation-Safe |
|---|---|---|---|---|
| Offset | ✅ Fast | ❌ Slow (`OFFSET N` scans) | ✅ Yes | ❌ No |
| Keyset/cursor | ✅ Fast | ✅ Fast (index seek) | ❌ No | ✅ Yes |
| Seek + count query | ✅ Fast | ✅ Fast | ⚠️ With extra query | ✅ Yes |

Response contract:
```json
{
  "data": [...],
  "pagination": {
    "next_cursor": "eyJjcmVhdGVkX2F0IjoiLi4uIiwiaWQiOiIuLi4ifQ==",
    "has_more": true,
    "total_count": 15420   // optional — expensive, only if needed
  }
}
```

---

### 🔴 Architect — Pagination Failure Modes

**Failure 1: Offset + real-time inserts = skipped items**
```text
Client reads page 1 (items 1-20).
New item inserted at position 1.
Client reads page 2 (items 21-40).
But item 20 shifted to position 21 — client never sees it.
```

**Failure 2: Cursor with deleted sort key**
```text
Cursor points to order_id=500 with created_at=T1.
Order 500 is deleted.
Next page query: WHERE created_at < T1 → works fine (cursor value still valid).
But: if cursor encodes only the ID and you do WHERE id < 500 → may miss items with same timestamp.
Fix: always use composite cursor (sort_key + tie_breaker).
```

**Failure 3: Total count is O(n) at scale**
```text
SELECT COUNT(*) FROM orders WHERE tenant_id = 'abc';
At 100M rows: this query takes 2-5 seconds on PostgreSQL.
Fix: cache count with TTL, or return approximate count, or omit total.
```

Production pattern from Slack: Slack's message history API returns `has_more: true/false` but never returns a total count. This eliminates the expensive COUNT query entirely.

---

## 7. GraphQL: Flexible Queries and Their Cost

### Intent of This Section

GraphQL seems like a silver bullet: "The client requests exactly what it needs, no over/under-fetching!" But architects need to understand the **operational costs hidden inside GraphQL.**

Every flexibility comes with a cost:
- Flexible queries = harder to optimize caching
- Per-query cost varies = rate limiting gets complicated
- Deep nested queries = N+1 problem = can exhaust databases

Junior engineers see GraphQL as "better REST." Architects see it as "different tradeoffs." This section teaches you to identify when GraphQL wins (web frontends with multiple data shapes) and when it creates problems (at massive scale, at start-ups with limited ops resources).

---

### 🟢 Beginner — The Grocery List Analogy

With REST, you go to a store and buy a pre-packaged meal kit — you get everything in the box whether you need it or not. With GraphQL, you bring a grocery list — you get exactly the items you wrote down. No more, no less.

This is great when different people need different items from the same store. But it means the store needs a more complex ordering system.

---

### 🟡 Senior — Schema Design and Resolver Architecture

```graphql
# Schema definition
type Query {
  user(id: ID!): User
  orders(userId: ID!, first: Int, after: String): OrderConnection
}

type User {
  id: ID!
  name: String!
  email: String!
  orders(first: Int, after: String): OrderConnection  # nested pagination
}

type OrderConnection {
  edges: [OrderEdge!]!
  pageInfo: PageInfo!
}

type OrderEdge {
  node: Order!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}
```

**The N+1 Problem:**
```text
Query: { users(first: 50) { name, orders { title } } }

Without DataLoader:
  1 query to fetch 50 users
  50 queries to fetch orders for each user  ← N+1 = 51 queries

With DataLoader:
  1 query to fetch 50 users
  1 batched query to fetch orders for all 50 users  ← 2 queries total
```

```ts
// DataLoader batches by event loop tick
const orderLoader = new DataLoader<string, Order[]>(async (userIds) => {
  const orders = await db.query(
    'SELECT * FROM orders WHERE user_id = ANY($1)', [userIds]
  );
  const grouped = new Map<string, Order[]>();
  for (const order of orders) {
    const list = grouped.get(order.user_id) || [];
    list.push(order);
    grouped.set(order.user_id, list);
  }
  return userIds.map(id => grouped.get(id) || []);
});
```

| GraphQL Concern | Mitigation |
|---|---|
| N+1 queries | DataLoader per request context |
| Query depth attack | Max depth = 7-10, reject deeper |
| Query cost explosion | Cost analysis: sum field costs, reject if > budget |
| No HTTP caching | CDN: use persisted query hashes as cache keys |
| Schema complexity | Modular schemas with federation (Apollo Federation) |

---

### 🔴 Architect — When GraphQL Becomes a Liability

**Scale problem at Netflix:**
Netflix originally used GraphQL heavily, then partially pulled back because:
- Schema became a god object coupling all domain teams
- Performance debugging was harder (one URL, varying query shapes)
- Caching required per-query-hash strategies instead of per-URL

Their solution: **GraphQL Federation** — each domain team owns its schema slice, a gateway composes them.

**Security problem at production:**
Without persisted queries, clients can send arbitrary queries. A malicious query requesting deeply nested relations can exhaust server memory.

```text
Attack:  { users { friends { friends { friends { friends { posts { comments { author { friends ... }}}}}}}}}
Defense: 
  1. Depth limit (reject > N levels)
  2. Cost budget (each field has a cost, total must be < max)
  3. Persisted queries (only allow pre-registered query hashes)
  4. Timeout per resolver (kill slow resolvers)
```

**Capacity math:**
```text
GraphQL gateway at 50k req/s:
  Avg query touches 3 resolvers
  Each resolver calls 1 downstream service (with DataLoader)
  Internal RPC: 150k calls/s
  Without DataLoader: 50k × avg_list_size(20) = 1M calls/s  ← DataLoader is mandatory
```

---

## 8. gRPC: High-Performance Service Communication

### 🟢 Beginner — The Walkie-Talkie Analogy

REST is like sending letters — you write a message (JSON), put it in an envelope (HTTP), and wait for a reply. gRPC is like a walkie-talkie — you speak directly (binary), the connection stays open, and both sides can talk simultaneously. It's faster but requires both sides to have compatible radios.

---

### 🟡 Senior — Why gRPC Wins Internally

```protobuf
// Contract: .proto file — compiled to code in any language
syntax = "proto3";

service OrderService {
  rpc CreateOrder (CreateOrderRequest) returns (Order);
  rpc StreamUpdates (OrderFilter) returns (stream OrderUpdate);
}

message CreateOrderRequest {
  string product_id = 1;
  int32 quantity = 2;
}

message Order {
  string id = 1;
  string product_id = 2;
  int32 quantity = 3;
  OrderStatus status = 4;
}

enum OrderStatus {
  PENDING = 0;
  CONFIRMED = 1;
  SHIPPED = 2;
}
```

| Why gRPC Beats REST Internally | Detail |
|---|---|
| Binary serialization | Protobuf is 3-10x smaller than JSON, faster to parse |
| HTTP/2 multiplexing | Multiple RPCs over one connection, no head-of-line blocking |
| Mandatory contract | `.proto` generates client + server stubs — no interpretation errors |
| Streaming | Native support for long-lived bidirectional streams |
| Deadlines | Built-in deadline propagation across service chain |

```text
Performance comparison for internal calls:
  REST + JSON: ~500μs per call (serialize + HTTP/1.1 overhead)
  gRPC + Protobuf: ~50-100μs per call (binary + HTTP/2)
  At 1M internal calls/sec: 500s vs 50-100s of CPU time saved
```

---

### 🔴 Architect — gRPC Deadline Propagation

gRPC has a killer feature REST lacks: **deadline propagation**. When Service A calls Service B with a 500ms deadline, and B calls C, C automatically knows it has (500ms - time_already_elapsed) left. If time expires, the entire chain cancels.

```text
Client → Service A (deadline: 500ms)
  A elapse: 50ms
  A → Service B (deadline: 450ms, auto-propagated)
    B elapse: 100ms
    B → Service C (deadline: 350ms, auto-propagated)
      C takes 400ms → DEADLINE_EXCEEDED
      B gets cancellation → stops processing
      A gets cancellation → returns error to client
```

Without this (REST): Service C happily processes for 2 seconds while the client already timed out. The work is wasted but server resources are consumed.

Real incident: A company without deadline propagation had a slow downstream DB. REST services queued requests for 30 seconds each. Thread pools exhausted, cascading failure across 12 services. gRPC deadlines would have failed fast at the boundary.

---

## 9. API Gateway Architecture

### 🟢 Beginner — The Hotel Concierge Analogy

A hotel concierge sits at the front desk. Every guest (client) talks to the concierge first. The concierge checks your reservation (authentication), directs you to the right room (routing), and makes sure no one enters without a key (authorization). The rooms (services) don't need their own front desk.

An API gateway does the same: it's the single entry point that handles security, routing, and traffic management before requests reach your services.

---

### 🟡 Senior — Gateway Responsibilities and Architecture

```text
Client → API Gateway → Service A
                    → Service B
                    → Service C

Gateway handles (cross-cutting):
  ├── TLS termination
  ├── Authentication (JWT validation)
  ├── Rate limiting
  ├── Request ID injection
  ├── Request/response logging
  ├── Circuit breaking
  ├── Load balancing
  └── Protocol translation (REST ↔ gRPC)

Service handles (domain-specific):
  ├── Authorization (business rules)
  ├── Business logic
  ├── Data validation (domain rules)
  └── Database operations
```

| Gateway Pattern | When to Use |
|---|---|
| Single gateway | Small system, one team |
| BFF (Backend-for-Frontend) | Multiple client types with different needs |
| Federated gateway | Microservices: each team owns their gateway routes |
| Sidecar proxy (Envoy/Istio) | Service mesh: every service has its own tiny gateway |

```ts
// Gateway middleware chain example
app.use(requestIdMiddleware);      // inject X-Request-Id
app.use(authMiddleware);           // validate JWT, extract claims
app.use(rateLimitMiddleware);      // check rate limits
app.use(requestLogMiddleware);     // log method, path, user
app.use(circuitBreakerMiddleware); // protect against downstream failures
app.use(routingMiddleware);        // forward to correct service
```

---

### 🔴 Architect — Gateway as Single Point of Failure

The gateway sees all traffic. If it goes down, everything goes down. Mitigation:

| Risk | Mitigation |
|---|---|
| Gateway crash / OOM | Stateless gateway + auto-scaling group |
| Config push breaks routing | Canary config deployment (1% → 10% → 100%) |
| Slow downstream blocks gateway threads | Async I/O + timeout + circuit breaker per upstream |
| TLS certificate expiry | Automated cert rotation (Let's Encrypt / ACM) |
| Single region failure | Multi-region deployment + DNS failover |

```text
Production gateway sizing:
  Traffic: 500k req/s
  Gateway instance: handles ~10k req/s (Nginx/Envoy)
  Instances needed: 50 + 50% headroom = 75 instances
  Spread across 3 AZs: 25 per AZ
  If one AZ fails: remaining 50 handle 500k at ~10k each → capacity ok
```

Real incident: A company pushed a bad regex to their API gateway's WAF rules. The regex caused catastrophic backtracking on 5% of requests. Gateway CPU spiked to 100%, all traffic dropped. Fix: WAF rules must be tested with fuzzing before production push, and regex timeout must be enforced (Cloudflare had this exact incident in 2019).

---

## 10. Error Contracts and Client Experience

### 🟢 Beginner — The Doctor's Diagnosis Analogy

When you go to a doctor, a good doctor doesn't just say "you're sick." They tell you: what's wrong (diagnosis), what to do about it (treatment), and what to watch for (next steps). A bad doctor just says "error."

API errors should be the same: a machine-readable code (what went wrong), a human message (what it means), and a path forward (how to fix it).

---

### 🟡 Senior — Error Response Standards

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Account balance is below the required amount for this transaction.",
    "details": [
      {"field": "amount", "issue": "exceeds_balance", "value": 500.00}
    ],
    "request_id": "req_7f3a2b1c",
    "doc_url": "https://docs.example.com/errors/INSUFFICIENT_FUNDS",
    "retry_after": null
  }
}
```

| HTTP Status | When to Use | Error Code Examples |
|---|---|---|
| 400 | Client sent bad data | `VALIDATION_FAILED`, `INVALID_FORMAT` |
| 401 | Missing or invalid auth | `UNAUTHORIZED`, `TOKEN_EXPIRED` |
| 403 | Authenticated but not authorized | `FORBIDDEN`, `INSUFFICIENT_PERMISSIONS` |
| 404 | Resource not found | `NOT_FOUND`, `USER_NOT_FOUND` |
| 409 | Conflict with current state | `DUPLICATE_RESOURCE`, `VERSION_CONFLICT` |
| 422 | Semantically invalid | `INSUFFICIENT_FUNDS`, `EXPIRED_COUPON` |
| 429 | Rate limited | `RATE_LIMITED` (include `Retry-After`) |
| 500 | Server error | `INTERNAL_ERROR` (never expose internals) |
| 502/503 | Upstream failure | `SERVICE_UNAVAILABLE` (include `Retry-After`) |

```ts
// Error factory — ensures consistent format across all services
class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    public userMessage: string,
    public details?: Array<{ field: string; issue: string; value?: unknown }>,
  ) {
    super(userMessage);
  }

  toResponse(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.userMessage,
        details: this.details,
        request_id: requestId,
      },
    };
  }
}
```

---

### 🔴 Architect — Error Observability and Debugging

At scale, error codes become your primary debugging signal. Design your error taxonomy deliberately:

```text
Error code hierarchy:
  VALIDATION_*      → client-fixable errors
  AUTH_*            → authentication/authorization failures
  RESOURCE_*        → state/existence problems (NOT_FOUND, CONFLICT)
  RATE_*            → rate limiting and quota
  UPSTREAM_*        → dependency failures
  INTERNAL_*        → bugs (should trigger pager)
```

| Observability Rule | Why |
|---|---|
| Never expose stack traces externally | Security — reveals internals to attackers |
| Always log stack traces internally | Debuggability — map `request_id` to full trace |
| Track error codes as metrics | `rate(api_errors_total{code="VALIDATION_FAILED"}[5m])` |
| Alert on new error codes | Unexpected codes = potential bug |
| Distinguish client vs server errors | 4xx spike = client issue; 5xx spike = your bug |

Real pattern from Stripe: Stripe's error codes are so well-designed that client libraries can programmatically handle every error type. The error `code` is machine-actionable, the `message` is for human support engineers, and `doc_url` links to a fix. This reduces support tickets by enabling self-service debugging.

---

## 11. Multi-Protocol Architecture

### Intent of This Section

No single protocol works for everything. Running multiple protocols is an operational burden that companies with >100 engineers accept as "necessary taxation."

**The reality:**
- Use REST externally (universal, cacheable, browser-friendly)
- Use GraphQL for web teams (reduces request waterfall)
- Use gRPC internally (binary, fast, deadline propagation)

The question architects face isn't "which protocol?" but "how much operational complexity can we afford?" Stripe chose REST-only (simpler). Google chose proto-first (generates REST + gRPC automatically). Netflix chose GraphQL federation (complex but pays off at their scale).

---

### 🟢 Beginner — The Language Analogy

A multinational company might use English for external meetings, Japanese in the Tokyo office, and Mandarin in the Shanghai office. They use interpreters at the boundaries. It's not chaos — it's efficiency. Each language works best in its context.

APIs work the same way: REST for external clients (universally understood), GraphQL for web teams (flexible data fetching), and gRPC for internal services (maximum speed). The API gateway translates between them.

---

### 🟡 Senior — Protocol Selection Matrix

```text
                    ┌─────────────┐
  Mobile/Web ──REST──►             │
                    │  API Gateway │──gRPC──► Internal Services
  Web SPA ──GraphQL──►             │
                    │             │──gRPC──► Internal Services
  Partners ──REST──►              │
                    └─────────────┘
```

| Consumer | Protocol | Why |
|---|---|---|
| Public / third-party | REST | Universal, cacheable, no special client needed |
| Web frontend (SPA) | GraphQL | Flexible queries, avoids over-fetching |
| Mobile | REST or GraphQL | REST if views are fixed, GraphQL if views vary |
| Internal service-to-service | gRPC | Binary, fast, streaming, typed contracts |
| Background workers | gRPC or message queues | Throughput > latency flexibility |

---

### 🔴 Architect — Operational Cost Analysis

| Cost | REST-only | Multi-protocol | Mitigation |
|---|---|---|---|
| Serialization libraries | 1 (JSON) | 3 (JSON + protobuf + GraphQL) | Shared domain models as source of truth |
| Documentation | 1 tool (Swagger) | 3 tools (Swagger + GraphiQL + gRPC reflection) | Auto-generate from contracts |
| Monitoring | URL-based dashboards | GraphQL: per-operation-name dashboards | Normalize metrics by operation name |
| Testing | Standard HTTP tests | Protocol-specific test frameworks | Contract testing (Pact) |
| Team training | Low | Medium-high | Specialize by protocol boundary |

The cost is manageable but real. Companies that succeed with this:
- **Google**: gRPC internally, REST externally (auto-generated from proto)
- **Netflix**: GraphQL federation for web, gRPC for internal
- **Uber**: gRPC between services, REST for rider/driver apps

Companies that fail: those that let individual teams pick protocols without a platform standard.

---

## 12. Real-World Company API Patterns

### Intent of This Section

Stop guessing what "good API design" looks like. Great companies have already solved these problems. Reading their public documentation reveals:
1. **Which patterns actually work in production** (not which ones sound good in theory)
2. **The tradeoffs they chose** (and why they chose them)
3. **How they avoid common mistakes** (learning from their production incidents)

This section is your cheat sheet for "what would Stripe do?" or "how does Google solve this?" The answers often become interview questions.

Key insight: Almost all successful APIs use one of three patterns:
- **Stripe model**: REST-only, single URL version (/v1/), account-level opt-in for new versions
- **Google model**: Proto-first, auto-generate REST + gRPC, resource-oriented design
- **Netflix model**: Federated microservices, each team owns their API, composed by gateway

Your system's size and complexity determines which model fits best.

---

### 🟢 Beginner — Same Challenge, Different Scale

Every company with a public API faces the same problems: versioning, rate limiting, pagination, and error handling. The difference is how they solve them. Reading their public documentation reveals production-tested patterns.

---

### 🟡 Senior — How Major Companies Design APIs

**Stripe — The Gold Standard for REST API Design**

Stripe's API is considered the best-designed public API in the industry. Key patterns:

```text
Stripe API design principles:
  1. URL versioning (/v1/) — stable since 2011
  2. Idempotency keys — built into every mutating endpoint
  3. Expandable fields — ?expand[]=customer to inline related objects
  4. Consistent error format — code + message + param + type
  5. Cursor pagination — starting_after/ending_before pattern
  6. Event-driven webhooks — every state change fires an event

Example request:
  POST /v1/charges
  Idempotency-Key: ik_charge_abc123
  
  amount=2000&currency=usd&source=tok_visa

Example error:
  {
    "error": {
      "type": "card_error",
      "code": "card_declined",
      "message": "Your card was declined.",
      "param": "source",
      "charge": "ch_1234"
    }
  }
```

Why it matters for interviews: If you're asked to design a payment API, Stripe's patterns are the benchmark. Idempotency keys + cursor pagination + expandable fields + webhook events.

---

**GitHub — REST + GraphQL Hybrid**

GitHub runs both REST (v3) and GraphQL (v4) APIs simultaneously:

| Aspect | REST API (v3) | GraphQL API (v4) |
|---|---|---|
| Use case | Simple CRUD, CI/CD integrations | Complex UI queries (PR page needs 12 entities) |
| Pagination | Link header (cursor-based) | Relay connection pattern |
| Rate limit | 5,000 req/hour per token | 5,000 points/hour (query cost-weighted) |
| Caching | HTTP caching (ETag, Last-Modified) | Client-side normalized cache (Apollo) |

```text
GitHub's GraphQL rate limiting innovation:
  REST: each request costs 1 point (simple)
  GraphQL: each query is scored by complexity
    - Each field: 1 point
    - Each connection(first: 100): 100 points
    - Nested: multiplicative
  
  query { repository(owner:"fb", name:"react") {
    issues(first:100) {    ← 100 points
      nodes {
        comments(first:50) {  ← 100 × 50 = 5000 points
          nodes { body }
        }
      }
    }
  }}
  Total: 5,101 points → may exceed hourly budget in one query
```

Interview takeaway: GraphQL rate limiting must be cost-weighted, not per-request.

---

**Google Cloud — Proto-First API Design**

Google mandates protobuf-first API design. All external REST APIs are auto-generated from `.proto` files using gRPC-Gateway annotations:

```protobuf
service LibraryService {
  rpc GetBook(GetBookRequest) returns (Book) {
    option (google.api.http) = {
      get: "/v1/{name=shelves/*/books/*}"
    };
  }
}
```

This generates both gRPC and REST endpoints from one source of truth. Google's API Design Guide (AIP — API Improvement Proposals) is publicly available and covers:
- Resource-oriented design
- Standard methods (Get, List, Create, Update, Delete)
- Long-running operations
- Filtering and ordering
- Field masks for partial updates

---

**Netflix — GraphQL Federation at Scale**

Netflix migrated from a monolithic GraphQL schema to **Apollo Federation**, where each domain team owns their schema slice:

```text
Before (monolith):
  One schema, one team, one deployment → bottleneck

After (federated):
  User service → User schema slice → 
  Content service → Content schema slice → Federation Gateway
  Payment service → Payment schema slice →

Each team deploys independently.
Gateway composes schemas at runtime.
```

Problem they solved: at 200+ engineers, one team's schema change could break another team's resolvers. Federation isolates ownership.

Problem federation introduced: query planning across services adds latency. Netflix mitigated with aggressive caching of query plans.

---

**Uber — Multi-Protocol with Thrift/gRPC Migration**

Uber historically used Apache Thrift internally, then migrated to gRPC. Their API architecture:

```text
Rider/Driver apps → REST → API Gateway (Uber Edge)
                                ↓
                    Internal services (gRPC, migrated from Thrift)
                                ↓
                    Data plane (Kafka, Redis, Cassandra)
```

Key design decisions:
- REST externally (mobile apps need universal HTTP support)
- gRPC internally (binary efficiency at Uber's scale: millions of trips/day)
- API Gateway handles auth, rate limiting, and protocol translation
- Idempotency built into every ride-creation endpoint (prevents duplicate ride requests)

---

### 🔴 Architect — Production Incidents From API Design Failures

**Incident 1 — The Breaking Change That Crashed Mobile (common pattern)**

A backend team renamed `user_name` to `username` in a response. No version bump. The mobile app had a hardcoded JSON decoder that expected `user_name`. The app crashed for all 2M users. Binary already shipped — no server-side fix possible for the crash.

```text
Root cause: response field rename without versioning
Fix: 
  - Dual-write both names during transition
  - CI check: openapi-diff blocks field removal/rename
  - Mobile: use lenient JSON parsing (ignore unknown, handle missing)
  - Canary: deploy API changes behind feature flag, verify mobile clients first
```

**Incident 2 — Offset Pagination OOM at Scale**

An e-commerce platform used offset pagination for their product catalog API. A partner scraped all products using `?page=1&limit=100` through `?page=50000&limit=100`. At page 50,000, the DB was executing `OFFSET 5000000` — scanning 5M rows per request. The DB CPU hit 100%, taking down the entire catalog service.

```text
Root cause: offset pagination allows unbounded page depth
Fix:
  - Switch to cursor pagination for list endpoints
  - Cap max offset (e.g., offset > 10000 returns 400)
  - Rate limit per-client list requests
  - Add monitoring: alert when offset > threshold
```

**Incident 3 — GraphQL Query of Death**

A social platform launched a GraphQL API. A developer's automated tool sent a query requesting `users → friends → friends → friends → posts → comments → author → friends` (8 levels deep). One query generated 50,000 DB queries (no DataLoader, no depth limit). The GraphQL server crashed, taking the entire site offline.

```text
Root cause: no query depth limit, no cost analysis, no DataLoader
Fix:
  - Max query depth: 7
  - Query cost budget: max 10,000 points
  - DataLoader: mandatory for all list resolvers
  - Persisted queries: only allowed query hashes in production
  - Per-query timeout: kill any resolver taking > 5s
```

**Incident 4 — Gateway Regex Catastrophe (Cloudflare, 2019)**

Cloudflare pushed a WAF rule update containing a regular expression that caused catastrophic backtracking. The regex was evaluated on every request at the API gateway layer. CPU on all edge nodes spiked to 100%. Global outage for 27 minutes.

```text
Root cause: untested regex in gateway hot path
Fix:
  - Regex timeout / bounded execution (RE2 engine — no backtracking)
  - WAF rule changes go through same canary process as code deploys
  - Dry-run mode for new rules (log, don't enforce)
  - Kill switch to disable latest rule instantly
```

---

## 13. Pattern Recognition — How to Identify API Design Decisions in Interviews

### Intent of This Section

This section teaches you to **think like an architect during interviews.** You won't see the question "use gRPC or REST?" directly. Instead, you'll hear:
- "We have 50 internal microservices. The latency budget is 100μs per hop. What protocol?"
- "Mobile users are on 3G networks. API responses are 2MB average. What do we do?"
- "We have 100M products to list. Offset pagination is killing the database. What's the fix?"

Great architects recognize the **hidden requirement** in each signal and match it to an API pattern. This section trains that pattern recognition.

---

### 🟢 Beginner — The Interview Signal Checklist

When you hear these phrases in an interview, API design choices should appear in your answer:

| Interview Signal | API Design Response |
|---|---|
| "public API" | REST, URL versioning, idempotency keys, rate limiting headers |
| "mobile clients" | REST, cursor pagination, field selection, compact responses |
| "web dashboard with complex views" | GraphQL or BFF pattern |
| "internal microservices" | gRPC with protobuf contracts |
| "payment/financial system" | Idempotency keys, strict error codes, 422 for business errors |
| "third-party integrations" | REST, webhook events, API key auth, deprecation policy |
| "real-time updates" | WebSockets, SSE, gRPC server streaming |
| "millions of items to list" | Cursor pagination (never offset at scale) |

---

### 🟡 Senior — Protocol Selection Pattern Matching

| Requirement Signal | Protocol Choice | Why |
|---|---|---|
| "browser client, universal" | REST | No special client library needed |
| "multiple frontends, different data needs" | GraphQL | Avoids N+1 REST calls per view |
| "10μs internal latency budget" | gRPC | Binary, multiplexed, streaming |
| "file upload/download" | REST (multipart/presigned URL) | Native HTTP support |
| "event streaming between services" | gRPC server streaming or Kafka | Purpose-built for streams |
| "must work offline / weak network" | REST + local cache | HTTP caching is mature |
| "complex query with 15 filters" | POST /search with JSON body | Query params get unwieldy |

**Spotting the pagination strategy:**

```text
Scenario → what pagination to use

"User scrolling infinite feed"
  → cursor pagination (mutation-safe, fast at any depth)

"Admin dashboard with page numbers"
  → offset pagination (random access needed, small data set)

"Exporting all records for data pipeline"
  → cursor pagination + bulk endpoint (POST /exports)

"Search results with relevance ranking"
  → cursor pagination keyed on (score, id)

"Time-series events (logs, metrics)"
  → keyset pagination on timestamp
```

---

### 🔴 Architect — Reading System Design Signals Like a Senior

**Signal: "Design an API for a payment system"**

Automatic checklist:
```text
1. REST for external (universally understood, cacheable)
2. Idempotency keys on all mutating endpoints
3. Strict error taxonomy (card_error, api_error, etc.)
4. Webhook events for async state changes
5. API versioning (URL path) with long deprecation cycles
6. Rate limiting (per-API-key + per-endpoint weighted)
7. Audit logging (every request, every response, every error)
```

**Signal: "The system has mobile, web, and partner consumers"**

This demands multi-protocol or BFF:
```text
Option A: BFF per client type
  Mobile BFF → compact REST responses
  Web BFF → GraphQL for flexible queries
  Partner API → stable REST with strict versioning

Option B: Single API with content negotiation
  Accept: application/json → full REST response
  fields=id,name → sparse response for mobile
  GraphQL endpoint alongside REST for web
```

**Signal: "We need to handle backward compatibility"**

Senior response:
```text
1. Contract-first development (OpenAPI spec checked in CI)
2. Additive changes only (new fields, new endpoints)
3. Breaking changes gated behind version flag
4. Dual-write deprecated fields during migration
5. Sunset headers + brownout schedule for deprecation
6. Client usage analytics to know who uses what
```

**Signal: "How do internal services communicate?"**

```text
Synchronous: gRPC (binary, typed, deadline propagation)
Asynchronous: Kafka/SQS (decoupled, durable, replay)
Never: REST between internal services at high QPS
  (HTTP/1.1 + JSON serialization overhead is wasteful internally)
```

---

## 14. Advanced Topics for Architect-Level Design

### Intent of This Section

Sections 1-13 covered core API patterns. This section dives into **operational and scaling decisions** that separate junior architects from experienced ones. These aren't theoretical — they're decision points that appear constantly at scale:
- **Caching**: How do you reduce origin load by 99%?
- **Rate limiting**: How do you protect your system AND stay fair to customers?
- **Observability**: How do you debug a distributed system problem in minutes, not hours?
- **Backward compatibility**: How do you ship changes without breaking 50+ dependent teams?

Each topic below directly impacts systems with millions of requests per second. Masters engineers get asked: "Our DB is at 80% capacity and traffic is growing 20% monthly. What do you change first?" The answer is in this section.

---

### HTTP Caching & CDN Strategy (🔴 Architect Only)

Most architects skip caching during interviews — this is a mistake. Caching is how APIs scale.

**Why this matters for architects:**
HTTP caching is **the most underutilized optimization path** in production systems. A single `Cache-Control: max-age=3600` header can reduce origin request volume by 95%+ with zero code changes. Understanding cache headers is the difference between "API works" and "API scales to 10M users."

**HTTP Cache Headers — The Invisible Load Balancer:**

```text
Response: GET /products/123
  Cache-Control: public, max-age=3600
  ETag: "abc123def"
  Last-Modified: Wed, 05 Apr 2026 10:00:00 GMT
  Vary: Accept-Encoding, X-User-Tier

Intent: Tell clients how long this response stays valid.
  Client stores response for 3600s.
  Client sends: GET /products/123 (after 100s)
    If-None-Match: "abc123def"
  Browser cache responds 304 Not Modified → 0 bytes downloaded (save bandwidth!)
```

| Header | Purpose | Architect Decision |
|---|---|---|
| `Cache-Control: public` | Cacheable by CDN + browser | External APIs (more caching = more scale) |
| `Cache-Control: private` | Only browser caches, not CDN | User-specific data (don't share across users) |
| `Cache-Control: max-age=3600` | Cache for 1 hour | **Key decision:** How confident are you in staleness? 1h = might serve old data for 60min |
| `Cache-Control: s-maxage=7200` | Override for shared caches (CDN) | CDN can cache longer than browser (edge stays fresher) |
| `Cache-Control: no-cache` | Always revalidate with server | Critical data: always check freshness (expensive, for sensitive paths) |
| `Cache-Control: immutable` | Never revalidate, cache forever | Versioned URLs: `/v1/products/123.v456` (version in URL = always safe to cache) |
| `ETag: "abc123"` | Fingerprint of content | Browser compares ETag before downloading (revalidation without full body) |
| `Vary: Accept-Encoding,X-User-Tier` | Cache key includes headers | Tier-specific prices = different response (Vary ensures cache per tier) |

**Capacity math at scale — Why this is an architect conversation:**

```text
Scenario: SaaS product with 1M active users

API: GET /products/123
  Without caching:
    • 1M req/s hitting origin (all requests load from database)
    • Each request: 50ms latency (DB round trip), 500 bytes (product data)
    • Origin capacity needed: 50 database nodes running 24/7
    • Cost: $500k/month in infrastructure

  With CDN (1h cache, 99% hit rate):
    • First request from region: hits origin (cached at edge for 1hr)
    • 99% of subsequent requests: CDN responds <10ms (no DB load!)
    • Origin load: 1M req/s × 1% = 10k req/s (only cache misses)
    • Origin capacity needed: 1 database node
    • Cost: $5k/month (100x cheaper!)

The math: Adding two headers (`Cache-Control`, `ETag`) = save 99% of database cost.
```

**Architect trap: Cache invalidation — Why this is hard**

Phil Karlton said: "There are only two hard things in Computer Science: cache invalidation and naming things."

```text
Real scenario:
  1. Product price updated in DB at 10:00:05
  2. Cache entry still has old price (max-age=3600, expires at 11:00:05)
  3. Clients see stale price for up to 60 minutes
  4. Customer complains: "I was charged $50 but saw $35 on your website!"

  Fix options (architect chooses based on data freshness requirements):
    a) Purge CDN on update (one API call to Cloudflare/Akamai when price changes)
       → Cost: operational complexity (must coordinate DB update + purge)
    b) High-frequency updates = lower max-age (1-5min, not 1hr)
       → Cost: more cache misses, less scalable
    c) Use versioning: /products/123.v456 (version in URL = immutable cache)
       → Cost: need to generate new URLs on change
```

Real pattern from Twitter: Twitter uses versioned URLs for immutable assets (`/v1/products/id.version`). When price changes, they create a new version number, old caches stay intact for stale traffic, new requests get fresh version. **No purge needed because cache key changed.**

---

### Rate Limiting Strategies (🔴 Architect)
Flow:
  1. Product price updated in DB
  2. Cache entry still has old price (max-age not expired)
  3. Clients see stale price for hours
  Fix options:
    a) Purge CDN on update (API call to Cloudflare/Akamai)
    b) High-frequency updates = lower max-age (1-5min, not 1hr)
    c) Use versioning: /products/123.v456 (immutable cache)
```

Real pattern from Twitter: Twitter uses versioned URLs for immutable assets (`/v1/products/id.version`). When price changes, they create a new version number, old caches stay intact, new requests get new version. No purge needed.

---

### Rate Limiting Strategies (🔴 Architect)

**Why this matters for architects:**
An API without rate limiting is like a restaurant with unlimited seating—once it gets popular, chaos. At 10M requests/day, you **must** have rate limiting or your infrastructure costs explode. The question isn't "do we rate limit?" but "how do we rate limit fairly?"

#### Three strategies compared:

```text
1. FIXED WINDOW
   │ Window: 10:00-10:01 (60s)
   │ │ Requests: user can send unlimited until 60s limit
   │ │ │ 10:00:59 → send 1000 reqs = ✅ allowed
   │ │ │ 10:01:00 → new window reset
   │ │ │ Pro: simple, low overhead
   │ │ Con: bursty traffic at window boundaries
   │ │ │ Request flood at 10:00:59 → 1000 reqs in 1s
   │ │ │ Request flood at 10:01:00 → another 1000 reqs
   │ │ │ Total: 2000 reqs in 2s at boundary

2. SLIDING WINDOW (better)
   │ Current time: 10:05:23
   │ Limit: 100 reqs per 60 seconds
   │ Track: all requests in [10:04:23 - 10:05:23]
   │ Pro: smooth rate limiting, no boundary bursts
   │ Con: requires tracking all request timestamps (memory overhead)

3. TOKEN BUCKET (production standard at scale)
   │ Tokens: 100 per minute (replenished continuously)
   │ Each request: costs 1 token
   │ When empty: return 429 Too Soon
   │ Pro: allows bursts (token accumulation), smooth over time
   │ Con: setup is complex, need to track per-client
   │ Example:
   │   Tier A: 100 tokens/min (burst up to 500 if unused)
   │   Tier B: 1000 tokens/min (burst up to 5000)
```

**Layered rate limiting (Architect pattern):**

```text
Global rate limit (per datacenter):
  └─ 1M req/s total capacity

  By customer (fairness):
    └─ Per-API-key rate limit
      └─ Tier A: 100 req/s
      └─ Tier B: 1000 req/s

  By endpoint (cost-weighted):
    └─ GET  /products → 1 point
    └─ POST /search  → 5 points (expensive)
    └─ GET  /reports → 50 points (very expensive)

Response:
  HTTP 429 Too Many Requests
  X-RateLimit-Limit: 1000
  X-RateLimit-Remaining: 234
  X-RateLimit-Reset: 1712339400
  Retry-After: 45  ← retry in 45s
```

Real pattern from Stripe: Stripe rate-limits by:
- Global capacity (never exceed 100k API calls/s across all customers)
- Per-API-key limits (tiers: 25/100/1000/10000 req/s)
- Cost-weighted (heavy operations cost more)
- Burst allowance (token bucket permits brief spikes)

---

### Request/Response Optimization (🔴 Architect)

**Why this matters for architects:**
Every kilobyte of response matters when your clients are on mobile networks or you're paying for egress bandwidth. An architect who doesn't think about response size optimization is leaving millions of dollars on the table.

#### Field Selection / Sparse Fields (like Google APIs):

```
GET /products/123?fields=name,price,description

Instead of:
  {
    "id": 123,
    "name": "Widget",
    "price": 99.99,
    "description": "...",
    "internal_cost": 45,      ← not requested
    "warehouse_id": 567,       ← not requested
    "sku": "WIDG-001",        ← not requested
    "supplier_id": 890         ← not requested
  }

Return only requested fields:
  {
    "name": "Widget",
    "price": 99.99,
    "description": "..."
  }

Benefit: if client only needs 3 fields, bandwidth -80%, deserialize time -80%
```

At what scale does this matter?
```
Mobile client, 3G network (1 Mbps):
  Full response: 50KB → 50s to download
  Sparse response (3 fields): 5KB → 5s to download
  → 10x faster! Battery saves, user happier
```

**Compression trade-off:**

```
Response size: 1MB JSON
  gzip: 100KB (10% of original)
  brotli: 80KB (8% of original)

CPU cost on gateway: 5ms (gzip) vs 50ms (brotli)
Latency: +5ms encoding vs -20ms transmission (net saving: 15ms for 1Mbps connection)

Architects often miss: at high concurrency (50k req/s), 50ms × 50k = 2500 server-seconds/sec
That's 2500 CPU cores doing just compression. Brotli might break the bank.
→ Use gzip for high-traffic, brotli for low-traffic internal APIs
```

---

### Webhook Design & Reliability (🔴 Architect)

**Why this matters for architects:**
Webhooks are where APIs connect to the real world. Your API works perfectly, but the webhook to notify payment processors fails silently? Your revenue disappears. Most architects (and senior engineers) underestimate how critical webhook reliability is.

#### Webhook reliability pattern:

```text
Event: Order.Confirmed
Server posts to client: https://client.com/webhook

Scenario 1: Client responds 2xx
  ✅ Success, move on

Scenario 2: Client timeout / 5xx
  Retry logic:
    Attempt 1: 0s (immediate)
    Attempt 2: 5s (exponential backoff)
    Attempt 3: 25s
    Attempt 4: 125s (after 2+ minutes)
    After N failures: dead letter queue, manual review

Scenario 3: Client responds 4xx (client error, won't fix)
  ❌ Stop retrying (don't spam broken endpoint)
  → Manual review queue

Scenario 4: Webhook database down
  Queue webhook in persistent queue (Redis → PostgreSQL failover)
  Process async, retry on restart
```

**Webhook signature verification (security):**

```ts
// Client receives POST
X-Webhook-Signature: sha256=abc123...
Body: {event: "order.confirmed", order_id: 123}

Client verifies:
  const signature = HMAC-SHA256(body, webhook_secret);
  if (signature !== X-Webhook-Signature) {
    // Reject — not from us (replay attack, man-in-middle)
  }
```

**Idempotency in webhooks:**

```text
Event: Order.Confirmed fires
Webhook POST to client:
  {
    "event_id": "evt_abc123",    ← unique, use as idempotency key
    "order_id": "ord_456",
    "timestamp": "2026-04-05T10:00:00Z"
  }

If network duplicates, client gets same event_id twice.
Client stores event_id in DB, rejects duplicate.
```

Production incident: A payment processor sent webhooks without event IDs. Network retry duplicate = client recorded two payments for one order. Cost: thousands of refunds, customer churn.

---

### API Monitoring & Observability (🔴 Architect)

**Why this matters for architects:**
An API running well is invisible. The moment something breaks, observability is what separates "fixed in 5 minutes" from "cascading failure, on pager duty at 3 AM for 6 hours." Great architects design observability from day 1, not after things break.

**Key principle:** If you can't measure it in seconds, you can't fix it.

#### The difference between "the API works" and "the API is meeting SLOs":

```text
Metrics that matter:

1. Latency (p50, p99, p99.9)
   Threshold: p99 < 500ms
   Alert: p99 > 1s for 5 minutes

2. Availability (% of successful requests)
   SLO: 99.9% (9 hours down per year)
   Alert: error rate > 0.2% for 2 minutes

3. Error budget (how much failure is acceptable)
   Monthly SLO: 99.9%
   Error budget: 0.1% of requests
   → if you hit error rate 1% for 1 hour, you've exhausted monthly budget
   → now on pager duty, halt new deployments, fix

4. Request volume (traffic growth signal)
   Baseline: 100k req/s
   Alert: +30% spike → investigate (viral feature or attack?)

5. Dependency health (upstream services)
   Payment service latency: 50ms
   Alert: > 200ms (something broke downstream)

6. Cache hit ratio
   Healthy: 95%+ cache hit rate
   Alert: < 80% (cache misconfiguration)
```

**Request tracing (X-Trace-Id / request ID propagation):**

```
Client request:
  GET /orders/123
  X-Request-ID: req_7f3a2b1c

Server 1 (API Gateway) receives:
  logs: "request=req_7f3a2b1c method=GET path=/orders/123"
  calls Server 2 with same X-Request-ID

Server 2 (Order Service):
  logs: "request=req_7f3a2b1c service=order_service"
  calls Server 3 with same X-Request-ID

Server 3 (Payment Service):
  logs: "request=req_7f3a2b1c service=payment_service latency=45ms"

When client reports "order took 5 seconds", you grep logs for req_7f3a2b1c:
  req_7f3a2b1c gateway: 100ms
  req_7f3a2b1c order_service: 2000ms ← slow here
  req_7f3a2b1c payment_service: 45ms

You found the bottleneck in seconds, not hours.
```

---

### Batch Operations & Bulk APIs (🔴 Architect)

**Why this matters for architects:**
Clients that need to create 10,000 items shouldn't make 10,000 API calls. That's 10,000x more overhead than necessary. Batch endpoints are a **non-negotiable feature** for any public API at scale.

#### For clients that need to create/update thousands of items:

```
Option 1: Loop and POST individually
  for item in items:
    POST /items → latency 100ms × 1000 = 100 seconds total

Option 2: Batch endpoint
  POST /items/batch
  [
    { name: "item1" },
    { name: "item2" },
    ...
    { name: "item1000" }
  ]
  → latency 500ms total (99% faster)

Response format (important):
  {
    "results": [
      { success: true, id: "item_1" },
      { success: false, id: null, error: "validation_failed", details: [...] },
      ...
    ],
    "failed_count": 3,
    "succeeded_count": 997
  }
```

Why this matters: mobile client batching 100 items should complete in <1s, not 10s.

---

### Search/Filter API Design (🔴 Architect)

**Why this matters for architects:**
Many junior architects design search endpoints as GET with 20 query parameters. That approach breaks around 10+ filters and becomes unmaintainable. Knowing when to switch from GET to POST, and how to structure search payloads, is a mark of experience.

#### Simple query params (works for few filters):
  GET /products?category=electronics&price_min=100&price_max=500

Breaks when you have:
  - 20+ optional filters
  - Complex range queries
  - Nested filters
  - Full-text search

Better approach — POST with JSON body:
  POST /products/search
  {
    "q": "wireless headphones",      ← full-text
    "filters": {
      "category": ["electronics", "audio"],
      "price": { "min": 100, "max": 500 },
      "rating": { "min": 4 },
      "in_stock": true,
      "seller": { "excludes": ["seller_123"] }
    },
    "sort": { "field": "relevance", "order": "desc" },
    "pagination": { "limit": 20, "offset": 0 }
  }

Response:
  {
    "results": [...],
    "total_count": 12345,
    "facets": {
      "category": { "electronics": 10000, "audio": 5000 },
      "seller": { "top_sellers": [...] }
    }
  }
```

Why POST instead of GET?
- GET with complex query string looks like: `GET /products?filters=...&q=...` (ugly)
- POST body is structured, readable, typed (OpenAPI validates it)
- Easier to cache with query hashing vs per-URL caching

---

### Field Masking (Google APIs Pattern) (🔴 Architect)

**Why this matters for architects:**
This pattern solves an ambiguous problem that trips up junior engineers: "Did the client send this field to update it, or did they forget to send it?" Field masking removes all ambiguity—the client explicitly says **which fields to update**, the server ignores everything else.

**Real-world impact:** Without field masking, a client accidentally omitting `is_active` would set it to false instead of leaving it unchanged. With field masking, omitted fields are never touched.

#### Google Cloud example:
service LibraryService {
  rpc UpdateBook(UpdateBookRequest) returns (Book) {
    option (google.api.http) = {
      patch: "/v1/{book.name=shelves/*/books/*}"
      body: "book"
    };
  }
}

message UpdateBookRequest {
  Book book = 1;
  google.protobuf.FieldMask update_mask = 2;
}

// Field mask: specify WHICH fields to update
PATCH /v1/shelves/1/books/2
{
  "book": {
    "title": "New Title",
    "description": "New Description"
  },
  "update_mask": {
    "paths": ["title", "description"]
  }
}

Benefit: server knows EXACTLY which fields to update, ignores others
(no: "did client send this field or not?" guessing)
```

---

## 15. Complex Interview Questions & Answers (Architect Level)

### Intent of Q&A Section

The following five scenarios are **actual questions you'll encounter at FAANG companies** during architect interviews. Each tests:
1. Does the architect understand when to use which protocol?
2. Can they balance consistency vs. scalability?
3. Do they think about observability and operational concerns from day 1?
4. Can they explain tradeoffs clearly to non-technical stakeholders?

These aren't theoretical exercises. Each scenario reflects real systems running in production:
- **Q1**: Every large e-commerce company has to solve search at scale (Shopify, Amazon, eBay all face this)
- **Q2**: Every company with internal APIs has a "versioning hell" problem (Google, Uber, Stripe all solved this)
- **Q3**: High-contention state transitions matter for ride-sharing, trading, auctions (Uber, Robinhood, eBay)
- **Q4**: Tiered rate limiting is how SaaS protects its infrastructure (Stripe, Twilio, GitHub all do this)
- **Q5**: Adding fields without breaking 50+ clients is the real skill of a platform architect (Amazon, Google do this daily)

---

### Q1: Design a Search API for E-Commerce (50M Products)

**Question:**
"Design a search API for an e-commerce platform with 50 million products. Millions of users search simultaneously. Searches must return in <500ms with relevance ranking. What protocol, pagination, caching, and rate limiting would you use?"

**Architect Answer (What This Tests):**
This question tests whether you know to:
- Choose REST externally (universal), gRPC internally (performant) [protocol knowledge]
- Use POST for complex queries instead of GET [API design]
- Use cursor pagination not offset [understanding at-scale tradeoffs]
- Cache popular searches separately from uncommon ones [cost awareness]
- Design layered rate limiting [fairness under load]

```text
I'd use a multi-layered approach:

PROTOCOL: REST (external clients need universal HTTP) + gRPC (internal, for speed)
Rationale:
  - Mobile/web clients need HTTP (universal)
  - Internal search service can use gRPC to index service
  - API Gateway translates REST → gRPC

ENDPOINT DESIGN:
  POST /v1/search
  {
    "q": "wireless headphones",
    "filters": {
      "category": ["audio", "electronics"],
      "price": {"min": 50, "max": 500},
      "rating": {"gte": 4}
    },
    "sort": "relevance",
    "pagination": {"limit": 20, "cursor": null}
  }

Why POST?
  - Complex query structure (20+ possible filters)
  - GET query string becomes unreadable
  - Body is typed, validated by OpenAPI

PAGINATION: Keyset (cursor-based)
  Response:
  {
    "results": [...],
    "pagination": {
      "next_cursor": "eyJzY29yZSI6IDE5LjUsICJpZCI6ICJwcm9kXzk4N..."}
    }
  }

Why cursor?
  - 50M products: offset pagination (OFFSET 10M) scans too long
  - Cursor: index seek, always fast
  - Mutation-safe: inserts during pagination don't cause skips

SEARCH BACKEND (Elasticsearch pattern):
  Users query: [REST API Gateway] → [Search Service via gRPC]
   Search Service queries Elasticsearch
  Elasticsearch indexes: (score, product_id) composite key
   Query: WHERE category IN (...) AND price BETWEEN (...) AND rating >= 4
   ORDER BY relevance DESC LIMIT 21

CACHING:
  Popular queries → Redis (1-hour cache)
    GET /v1/search?q=iphone
    → query is very common, cache at gateway
    → cache key: HASH(q, filters, sort)
    → hit rate: 60-70% (long tail of unique searches not cached)
    
  Uncommon queries → no cache (build once)

Cache-Control: public, max-age=300 (5 minutes)
ETag: based on query result hash

RATE LIMITING (per API key):
  Tier 1: 100 req/min
  Tier 2: 1000 req/min
  Tier 3: 10000 req/min

Why per-minute? Searches are bursty (user types, "searches again", refines filters)
Burst allowance (token bucket): store 500 tokens max, refill at 100/min

OBSERVABILITY:
  Metrics:
    - search_latency_p99 (alert if > 500ms)
    - cache_hit_ratio
    - slow_query_counter (queries > 1s)
  
  X-Request-ID propagates: Gateway → Search → Elasticsearch
  Can trace any slow search in seconds

FAILURE HANDLING:
  If Elasticsearch restarts → 503 Service Unavailable (honest)
  If search times out (>5s) → return cached result or generic "try again"
  Circuit breaker: if error rate > 5%, fail-open (cache only, no fresh queries)

CAPACITY MATH:
  Traffic: 100k req/s
  Cache hit: 70% → 30k fresh searches/s
  Per-Elasticsearch-node: 10k searches/s
  Nodes needed: 3-4 with replication
  If one node fails: remaining nodes handle load (no outage)
```

---

### Q2: Version an API for 50 Internal Teams

**Question:**
"You're an architect at a large company. 50 internal teams depend on your API. Backend changes weekly. How do you version? How do you handle breaking changes? How do you prevent the "API versioning hell" where v1, v2, v3, v4, v5 all exist and you're supporting them for years?"

**Architect Answer (What This Tests):**
This question tests:
- Do you understand the cost of maintaining multiple API versions? (Each version = more testing, more bugs, more confusion)
- Do you know Stripe's pattern (one URL version for years, logical versioning via headers)?
- Can you design a deprecation cycle that doesn't crash dependent teams?
- Do you think about backward compatibility intentionally (additive changes only)?

**The intent:** Good architects **prevent versioning problems before they start** by designing backward-compatible APIs.

```text
I'd use "additive versioning" — design so breaking changes are rare:

STRATEGY: Single URL version (/v1/) with account-level API version

GET /v1/users/123
  Header: X-API-Version: 2026-02-15

Account-level versioning (like Stripe):
  - Company account pinned to API date: 2026-02-15
  - When backend makes breaking change (e.g., removed field), new date created: 2026-03-01
  - Old account continues at 2026-02-15
  - New account defaults to 2026-03-01
  - Team can opt-in when ready

PROTOCOL:
  - One URL version (/v1/)
  - Logical versions via X-API-Version header or query param

BACKWARD COMPATIBILITY RULES:
  ✅ Allowed (no version bump):
    - Add new field to response
    - Add new optional parameter
    - Add new endpoint
    - Deprecate field (dual-write both old + new names)

  ❌ Breaking (requires version bump):
    - Remove field
    - Rename field (unless aliasing)
    - Change field type (int → string)
    - Change HTTP method semantics
    - Rename endpoint

DEPRECATION FLOW (6-month cycle):
  Month 1: Announce (Slack, changelog)
    Field: "user_name" is deprecated, use "name"
    Dual-write: return both "user_name" (old) and "name" (new)

  Month 2-3: Clients migrate
    Monitor: track how many clients still use old field
    Alert: if > 10% still using after 2 months, ping teams directly

  Month 4: Brownout (turn off briefly to find holdouts)
    Random 1% of requests: return 400 without "user_name"
    Alerts tell client: "remove this code!"

  Month 5: Likely shutdown
    New API version removes the field
    Old version still returns it (dual-write)

  Month 6: Maintenance window
    Remove field from code, monitor, database schema

REAL EXAMPLE:
  API Version: 2026-02-15
  Our change: GET /users/:id response now includes "phone_domain" (new field)
  → No version bump needed, clients ignore unknown fields

  Later, we want to remove "internal_cost" field
  → Create new API version 2026-03-01
  → Old accounts: still get "internal_cost"
  → New accounts: don't get it
  → In 6 months: deprecate, migrate teams, remove

PREVENTING VERSION HELL:
  CI enforcement:
    - Break-check: OpenAPI-diff detects removed fields, rejects PR
    - Every PR checked against "no removals, no renames"
    - Only engineers with "breaking change waiver" can override

  Monitoring:
    - Per-version usage metrics
    - Can see: how many teams on 2026-01? How many on 2026-02?
    - If 99% migrated from v2025-12 → safe to sunset

  Tooling:
    - Automated migration guides: "to migrate from v2025-11 → v2025-12, change X to Y"
    - Canary testing: test client against new version before rolling out

ACCOUNT-LEVEL VERSIONING SCHEMA:
  table api_accounts {
    account_id: UUID
    api_version: VARCHAR (e.g., "2026-02-15")
    pinned_at: TIMESTAMP
    can_use_versions: ARRAY of VARCHAR
  }

  Before each request:
    Account X → pinned version = 2026-02-15
    Load version config for 2026-02-15:
      - which fields to return
      - which endpoints available
      - deprecated field mappings
    Respond according to that version
```

---

### Q3: Design State Transitions for Order System Under High Contention

**Question:**
"Design the state transitions for a ride-sharing order system. Drivers claim orders in <1 second. Orders can transition: PENDING → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED. Multiple requests can arrive simultaneously. How do you prevent race conditions? How do you ensure exactly-once state transitions? What about compensation if payment fails?"

**Architect Answer (What This Tests):**
This question tests:
- Do you understand optimistic vs. pessimistic locking? (ETag vs. database locks)
- Can you design idempotent state transitions (POST /transitions vs. PATCH)?
- Do you know saga patterns for multi-service consistency?
- Do you think about failure modes (what if payment fails mid-way)?
- Can you explain why sub-resource POST is better than PATCH for state changes?

**The intent:** Great architects **think in failure modes first.** They ask: "What can go wrong?" before designing the happy path.

```text
I'd combine multiple patterns based on contention:

CORE PATTERN: Sub-resource POST (not PATCH)
  POST /orders/:id/state-transitions
  {
    "to_state": "ACCEPTED",
    "reason": "driver_claimed"
  }
  Idempotency-Key: ik_transition_xyz

Why sub-resource POST?
  - Each transition is an event (auditable)
  - Idempotency key prevents double-acceptance
  - State is derived from event history

RACE CONDITION HANDLING:
  Driver A clicks "accept" → Network timeout → clicks again
  Driver B also claims same order

  Request timeline:
    t=0: Driver A GET /orders/:id → state=PENDING, etag=v1
    t=0: Driver B GET /orders/:id → state=PENDING, etag=v1
    t=1: Driver A POST /state-transitions → ACCEPTED, If-Match: v1 ✅ succeeds
    t=2: Driver B POST /state-transitions → ACCEPTED, If-Match: v1 ❌ 412 Precondition Failed

Response for Driver B:
  HTTP 412 Precondition Failed
  {
    "error": {
      "code": "ORDER_ALREADY_ACCEPTED",
      "message": "Order is no longer in PENDING state",
      "current_state": "ACCEPTED",
      "accepted_by": "driver_5678"
    }
  }

IDEMPOTENCY (prevent double-charging if API called twice):
  POST /orders/:id/state-transitions
  Idempotency-Key: ik_transition_abc123
  
  First call → succeeds, stored in DB
  Network timeout, client retries with SAME idempotency key
  Second call → server returns cached response (same as first), no double transition

PAYMENT INTEGRATION:
  Flow:
    1. POST /orders → creates order, state=PENDING
    2. Driver accepts → POST /transitions {to: ACCEPTED}
    3. Async: attempt payment (no blocking!)
       If payment fails → automatic rollback to PENDING
    4. GET /orders/:id → state=ACCEPTED (payment succeeded) or PENDING (payment failed)

Why async?
  - Payment might take 5-10 seconds (3D Secure, fraud check)
  - If synchronous → driver waits 10s → bad UX
  - Async + webhook → instant feedback to driver

DISTRIBUTED SAGA PATTERN (multi-service):
  Order Service orchestrates:
    1. POST /transitions {state: PENDING} ✅ always succeeds
    2. Driver calls: POST /driver/:id/claim
       → If fails → rollback (mark order unclaimed) ✅ compensating
    3. Payment Service: POST /charges {amount, order_id}
       → If fails → POST /driver/:id/unclaim ✅ compensating
    4. Async: notify both driver and customer (webhooks)

  No 2-phase commit (blocks). If step 3 fails, step 2 compensation undoes it.

CONTENTION AT SCALE (thousands of drivers in same city):
  Problem: Same order, 1000 drivers try to accept in parallel
  All race to: POST /transitions {to: ACCEPTED}
  
  Solution: Database-level lock + fail-fast
    BEGIN TRANSACTION;
    SELECT * FROM orders WHERE id = ? FOR UPDATE;  ← row lock
    if (current_state != PENDING) {
      ROLLBACK; return 409 Conflict;
    }
    UPDATE orders SET state = ACCEPTED, driver_id = ? WHERE id = ?;
    INSERT INTO state_transitions (order_id, from, to, driver_id);
    COMMIT;

  Result: 999 drivers instantly get 409 (locked), 1 driver succeeds
  No double-accepting, no race conditions

MONITORING & OBSERVABILITY:
  Metrics:
    - state_transition_latency_p99 (alert if > 100ms)
    - race_condition_rate (409 rate, should be <1%)
    - sage_compensation_rate (payment failures → auto-rollbacks)
  
  Tracing:
    X-Request-ID: order_claim_xyz
    logs: [Order Service] claiming order, [Payment Service] charging, [Webhook] notifying

BACKWARD COMPATIBILITY (future):
  If we add new state "SCHEDULED" later:
    Old drivers: try to transition to unknown state → 400 Bad Request
    New drivers: support it immediately
    Migration: deploy new code, old clients fail gracefully

TESTING:
  Load test: 1000 concurrent claims on same order
  Expected: 1 succeeds, 999 get 409
  Verify: only 1 insert in state_transitions table
```

---

### Q4: Design Rate Limiting for Tiered Pricing

**Question:**
"Your SaaS API has 3 tiers: Basic ($10/mo, 1k req/day), Pro ($50/mo, 100k req/day), Enterprise (custom). Implement rate limiting that's fair, can't be gamed, and scales to millions of users. Some endpoints are expensive (search costs 5 points, list costs 1 point). How do you design this?"

**Architect Answer (What This Tests):**
This question tests:
- Do you understand layered rate limiting (global → per-tier → per-endpoint)?
- Can you design token bucket with burst allowance?
- Do you think about gaming prevention (timezone abuse, request batching)?
- Can you explain why cost-weighted rate limiting is fairer than per-request?
- Can you handle the operational burden (quota resets, monitoring)?

**The intent:** Rate limiting is an **economic problem, not just a technical one.** You're protecting your infrastructure while being fair to customers.

```text
LAYERED RATE LIMITING:

Layer 1: Global capacity (don't overload)
  Total: 1M req/s per datacenter
  Alert: if > 900k req/s, scale up or reject new traffic

Layer 2: Per-tier limits (fairness)
  Basic: 50 req/s concurrent (1000 req/day cap)
  Pro: 1000 req/s concurrent (100k req/day cap)
  Enterprise: custom (negotiated)

Layer 3: Per-tier daily allowance
  Basic: 1000 requests/day total
  Pro: 100000 requests/day total
  Enterprise: None (unlimited)

Layer 4: Cost-weighted per-endpoint
  GET /products (list) = 1 point
  POST /search = 5 points (expensive)
  GET /reports = 50 points (very expensive)

Layer 5: Burst allowance (token bucket)
  Basic: 50 tokens/min, max 100 tokens (stores 2 minutes worth)
  Pro: 2000 tokens/min, max 5000 tokens
  Enterprise: unlimited

RATE LIMIT SCHEMA:
  table quota {
    account_id: UUID
    tier: VARCHAR (basic, pro, enterprise)
    daily_limit: INT
    concurrent_limit: INT
    reset_time: TIMESTAMP (next 00:00 UTC)
    requests_used_today: INT
  }

  table rate_limit_state {
    account_id: UUID
    endpoint: VARCHAR (/search, /products, etc)
    tokens: FLOAT
    last_refill_at: TIMESTAMP
  }

ALGORITHM (token bucket with daily cap):
  On request:
    1. Load account quota
    2. Check if daily limit exceeded
       if (requests_used_today >= daily_limit) {
         return 429 TooManyRequests
       }
    3. Calculate endpoint cost (1, 5, 50)
    4. Load token bucket state
    5. Refill tokens: tokens += (time_since_last_refill * tokens_per_second)
    6. Deduct cost: tokens -= endpoint_cost
       if (tokens < 0) {
         return 429 TooManyRequests, Retry-After: 30s
       }
    7. Increment daily counter
    8. Save state

RESPONSE FORMAT:
  HTTP 200 OK
  X-RateLimit-Limit: 100000 (daily)
  X-RateLimit-Remaining: 78523
  X-RateLimit-Reset: 1712380800 (next UTC midnight)
  X-RateLimit-Request-Cost: 5 (this request cost 5 points)

GAMING PREVENTION:
  Problem 1: Burst all tokens at once
    Solution: Token bucket + daily cap
    Even if you burst 5000 tokens in Pro tier, limited to 100k/day

  Problem 2: Time-zone gaming (claim reset by changing timezone)
    Solution: Reset at UTC midnight, not local time
    All accounts reset same time

  Problem 3: Distributed requests (single account across multiple IPs)
    Solution: Rate limit by API key (account), not IP
    One compromised key = account blocked, not collateral damage

  Problem 4: Service-to-service exhaustion (one service uses all quota)
    Solution: Sub-quotas per namespace
      /v1/products = 50% of quota
      /v1/users = 30% of quota
      /v1/admin = 20% of quota
    One service can't starve others

MONITORING:
  Metrics:
    - quota_hit_rate (% of users hitting limit)
    - cost_distribution (which endpoints cost most?)
    - burst_frequency (how often tokens max out?)
  
  Alerts:
    - Basic tier: hitting limit repeatedly → suggest upgrade
    - Pro tier: consistently > 80% of daily quota → alert account manager
    - Spike: burst > 10x normal → possible abuse, investigate

CACHING FOR PERFORMANCE:
  Rate limiting check on every request is expensive.
  Solution: Cache quota state in edge (Cloudflare Workers, AWS@Edge)
  
  Local cache (at gateway):
    account_123 quota: expires in 1 minute
    First request bypasses cache, loads from central DB
    Next 100 requests hit local cache (no DB latency)
    After 1 minute, refetch from DB
  
  Trade-off: quota slightly inaccurate (1-min stale) vs 100x faster

UPGRADE/DOWNGRADE:
  User upgrades Basic → Pro mid-day
  Daily quota resets: pick the higher (Pro) limit
  Old used: 300 reqs
  New limit: 100000 reqs
  New remaining: 100000 - 300 = 99700

  User downgrades Pro → Basic mid-day
  New limit: 1000 reqs
  Old used: 50000 reqs
  Result: account over-quota
  Action: block until reset (or pro-rate refund)

ENTERPRISE CUSTOM:
  Negotiated limits stored separately
  Tier: enterprise
  Custom limits: {daily: None, concurrent: 10000, cost_multiplier: 0.5}
  cost_multiplier: 0.5 means half-price (search costs 2.5 points, not 5)
```

---

### Q5: Backward Compatibility at Scale: Handling Null Responses

**Question:**
"A critical API returns 'user' objects. Originally, all fields were required. Now you want to add 3 new fields (username_suggestions, recommended_friends, badges). But you can't guarantee these in all cases (legacy data, missing data in source system). How do you add optional fields without breaking 50+ client teams that expect all fields to exist?"

**Architect Answer (What This Tests):**
This question tests:
- Do you understand schema versioning vs. additive changes?
- Can you design a deprecation flow that doesn't require coordinating 50 teams?
- Do you think about client-side defensive code?
- Can you use CI to prevent future breaking changes?
- Do you know the difference between optional and required fields in contracts?

**The intent:** The hardest part of API design isn't the first version—it's **evolving without breaking people.** This separates architects from developers.

```text
PROBLEM: 
  Old schema (all required):
    {"id": "123", "name": "Alice", "email": "alice@co.com"}
  
  New schema (with optionals):
    {"id": "123", "name": "Alice", "email": "alice@co.com", "badges": [...], ...}
  
  Some users don't have badges (null or missing).
  If client does: user.badges.length — crashes if badges is null!

SOLUTION 1: SCHEMA VERSIONING (safest)
  New API version (2026-03-01):
    GET /v1/users/123
    X-API-Version: 2026-03-01
    
  Old API version (2026-02-15):
    GET /v1/users/123
    X-API-Version: 2026-02-15
    
  Responses differ:
    v2026-02-15: {"id": "123", "name": "Alice", "email": "alice@co.com"}
    v2026-03-01: {"id": "123", "name": "Alice", "email": "alice@co.com", "badges": []}

  Clients opt-in to new version when ready.

SOLUTION 2: ADDITIVE WITHOUT SCHEMA VERSION (if you must)
  New fields ALWAYS present, may be empty:
    - badges: [] (empty array, not null)
    - username_suggestions: [] (empty array)
    - recommended_friends: [] (empty array)
  
  Client code:
    for (friend of user.recommended_friends) {  // iterates 0 times if empty
      addFriend(friend);
    }
  
  Not broken: `user.recommended_friends?.length ?? 0` works

  OR: always return nulls consistently
    "badges": null (not missing)
    "recommended_friends": null
  
  Client expected this from the start (defensive programming):
    for (friend of user.recommended_friends || []) {
      addFriend(friend);
    }

SOLUTION 3: DEPRECATION + DUAL-WRITE (complex but backward-compat)
  Stage 1: Dual-write (month 1-2)
    Return both old and new representation:
      {"id": "123", "name": "Alice", "badges": [], "_meta": {new_fields: true}}
  
  Stage 2: Monitor (month 2-3)
    Track: which clients use new fields?
    If > 90% use them, safe to make mandatory

  Stage 3: Make new representation default (month 4)
    Old versions return warning header:
      Sunset: Fri, 31 May 2026
      Deprecation: true
    
  Stage 4: Sunset old representation (month 5-6)

SCHEMA DESIGN (recommended):
  {
    "id": "user_123",
    "name": "Alice",
    "email": "alice@co.com",
    
    // NEW OPTIONAL FEATURES (always present, may be empty/null)
    "badges": [],                      // empty array if no badges
    "username_suggestions": [],        // empty if no suggestions
    "recommended_friends": []          // empty if no recommendations
  }

CLIENT SDK (defensive code):
  class User {
    constructor(data) {
      this.id = data.id;
      this.name = data.name;
      this.badges = data.badges || [];        // default to empty
      this.recommended_friends = data.recommended_friends || [];
    }
  }

OPENAPI/CONTRACT (enforces this):
  User:
    type: object
    required:
      - id
      - name
      - email
    properties:
      id: {type: string}
      name: {type: string}
      email: {type: string}
      badges:                     # NEW, optional
        type: array
        items: {type: string}
        default: []               # default to empty
      recommended_friends:        # NEW, optional
        type: array
        items: {type: object}
        default: []

CI CHECK:
  PR adds new field?
  If (field_required = true AND new_field AND no_default) {
    ERROR: "Breaking change! New required field without default value"
  }

TESTING (before shipping):
  Test with:
    - Old client parsing new response (should not crash)
    - Null value: {"badges": null}
    - Missing field: (field omitted entirely)
    - Empty array: {"badges": []}
  
  Client SDK test:
    assert(user.badges.length === 0)  // doesn't crash even if null

MONITORING:
  For 6 months post-launch:
    - Track: which clients still send old request headers?
    - Alert: if > 10% fail parsing new fields, investigate
    - Metric: error_rate on clients using old code
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| API contract | The stable surface — harder to change than any backend implementation |
| REST = resources | URLs are nouns, HTTP methods are verbs |
| Most APIs aren't REST | They're HTTP-JSON APIs — skip HATEOAS, and that's ok |
| State transitions | Model as sub-resource POST: `POST /orders/123/cancellation` (audit trail, idempotent) |
| State transitions anti-pattern | Don't: `POST /orders/123/cancel` (verb in URL, no audit trail) |
| PATCH with state | Requires If-Match etag to prevent race conditions; fallible when concurrent |
| Optimistic locking | ETag-based PATCH: client holds version, server rejects if changed (412 Precondition) |
| Async state transitions | 202 Accepted + Location header, client polls or receives webhook |
| Saga pattern | Orchestrated compensation for multi-service transitions (eventual consistency) |
| Event sourcing | Store immutable events (source of truth), replay for current state |
| Idempotency key | Client-generated UUID, server deduplicates writes on retry |
| Stripe pattern | Idempotency key + expandable fields + cursor pagination + webhooks |
| PUT erases missing fields | PUT is full replace — use PATCH for partial updates |
| URL versioning | Best for public APIs — Stripe, GitHub, Twilio, Google Cloud |
| Best version = no version | Design additive changes so breaking versions are rare |
| Breaking change | Removing/renaming fields, changing types — requires version bump |
| Deprecation | Sunset header → throttle → brownout → 410 Gone |
| Offset pagination fails | `OFFSET 100000` scans all rows — use cursor at scale |
| Cursor pagination | Index seek, mutation-safe, fast at any depth |
| Total count is expensive | `COUNT(*)` is O(n) — cache, approximate, or omit |
| GraphQL wins when | Multiple clients need different data shapes from same backend |
| N+1 problem | DataLoader batches all loads in one event loop tick |
| GraphQL defense | Depth limit + cost analysis + persisted queries |
| GraphQL rate limit | Cost-weighted per query, not per request (GitHub pattern) |
| gRPC wins internally | Binary protobuf, HTTP/2, streaming, deadline propagation |
| gRPC deadline propagation | Automatic timeout inheritance across service chain |
| Protobuf evolution | Field numbers are the identity — renames are free |
| gRPC + browsers | Requires gRPC-Web proxy or Connect protocol |
| Gateway owns | TLS, auth, rate limiting, routing, circuit breaking |
| Service owns | Authorization, business logic, domain validation |
| BFF pattern | Separate API layer per client type (mobile BFF, web BFF) |
| Error format | `{code, message, details, request_id}` — structured, machine-actionable |
| 4xx vs 5xx | 4xx = client's fault, 5xx = your bug — alert differently |
| Multi-protocol | REST external + GraphQL web + gRPC internal = industry standard |
| Google pattern | Proto-first, auto-generate REST from .proto annotations |
| Netflix pattern | GraphQL Federation — each team owns their schema slice |
| Mobile breaking change | Response field rename = app crash — binary can't be hotfixed |
| Offset pagination attack | Deep page scraping causes DB OOM — cap or use cursor |
| GraphQL query of death | No depth/cost limit = 50k DB queries from one request |
| Gateway regex incident | Untested regex in hot path = global outage (Cloudflare 2019) |
| Sub-resource POST transitions | Each transition is idempotent creation; audit trail via event history |
| Distributed state consensus | No 2PC; use sagas + eventual consistency or event sourcing |
| Compensating transactions | Must be as reliable as primary (retry policy, deadletter queues) |
| State race condition | Concurrent PATCHes without etag → duplicate state transitions (double charge) |
| Long-running operations | 202 Accepted pattern with polling or webhook for completion |
| State authorization | Who can transition from state X to Y? Enforce at service layer, not gateway |
| HTTP caching | Cache-Control: public/private, max-age, immutable for versioned URLs |
| Cache hit ratio | Healthy: 95%+; alert if < 80% (misconfiguration) |
| ETag + If-None-Match | Browser cache revalidation (304 Not Modified) saves bandwidth |
| Cache invalidation | Hard problem: purge on update, or use versioned URLs (immutable) |
| Rate limiting: fixed window | Bursty, easy to implement, but boundary spike problem |
| Rate limiting: sliding window | Smooth, but memory overhead (track all request timestamps) |
| Rate limiting: token bucket | Production standard (accumulate tokens, bursty traffic ok) |
| Layered rate limiting | Global capacity → per-customer → per-endpoint (cost-weighted) |
| Rate limit response | 429 Too Many Requests, X-RateLimit-Remaining, Retry-After |
| Burst allowance | Token bucket: store N tokens, refill M tokens/sec, allows spikes |
| Sparse fields | GET /users?fields=name,email (80% bandwidth savings for mobile) |
| Gzip vs Brotli | Gzip: fast encoding, safe at scale; Brotli: slow encoding, use only where beneficial |
| Webhook reliability | Retry with exponential backoff, dead letter queue, event_id for dedup |
| Event_id in webhooks | Idempotency: client stores event_id, rejects duplicates |
| X-Request-ID propagation | Follow across services: gateway → service1 → service2, grep logs in seconds |
| Metrics that matter | p99 latency, availability (%), error rate, error budget, cache hit ratio |
| SLO vs budget | SLO: 99.9% uptime, Budget: 0.1% failure allowed, exhaust = pager duty |
| Batch operations | POST /items/batch faster than N individual POSTs (100x speedup) |
| Search API: GET vs POST | GET: simple queries; POST: complex filters (20+ fields, nested) |
| Field masking (Google) | update_mask: only update specified fields (null ambiguity solved) |
| POST /search pattern | Complex queries → POST with JSON body (readable, typed) |
| Observability: request tracing | X-Request-ID: link all logs across services (debug in seconds) |
| Per-version usage metrics | Track: how many teams on each API version, safe to sunset old |
| Canary testing for API changes | New version → test subset of traffic, monitor errors before rollout |
| OpenAPI-diff in CI | Rejects PRs that remove fields, rename endpoints (prevents breaking) |
| Dual-write during deprecation | Month 1-2: return both old name + new name, month 3: old only, month 4: new only |
| Sunset header | Deprecation: true, Sunset: Fri Dec 31 2026 (tells clients deadline) |
| Account-level versioning | Stripe pattern: accounts pinned to API date, opt-in to new versions |
| Additive changes only | Most API changes should not need version bump (backward compat) |
| Sub-quota per namespace | /products quota = 50%, /users = 30%, prevent one service starving others |
| Gaming prevention: time-zone | UTC midnight reset, not local time (prevents time-zone gaming) |
| Gaming prevention: distributed | Rate limit by API key (account), not IP (prevents collateral damage) |
| Default empty vs null | New field: return [] not null (iteration-safe: for (x of arr || [])) |
| CORS at scale | Gateway enforces, not service (cross-cutting); origin whitelist in config |
| CSRF protection | SameSite=Strict cookie for web clients; Service-to-service: mTLS |
| Exponential backoff formula | delay = base_ms × (multiplier ^ attempt), with jitter to prevent thundering herd |
| Distributed saga | No 2PC; orchestrated compensation (payment fails → refund) |
| Event sourcing immutability | Events are truth, state is derived, perfect audit trail |
| High-contention locking | FOR UPDATE + database lock, fail-fast (409 Conflict) on race |
| Compensating transactions | Must be as reliable as primary (retry, circuit breaker, DLQ) |
