# Deep Dive: API Design (REST vs GraphQL vs gRPC)

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions

---

## Table of Contents

1. [Why API Design Matters](#1-why-api-design-matters)
2. [REST: Resource Modeling and HTTP Semantics](#2-rest-resource-modeling-and-http-semantics)
3. [Idempotency and Safe Retries](#3-idempotency-and-safe-retries)
4. [Versioning and Evolution](#4-versioning-and-evolution)
5. [Pagination at Scale](#5-pagination-at-scale)
6. [GraphQL: Flexible Queries and Their Cost](#6-graphql-flexible-queries-and-their-cost)
7. [gRPC: High-Performance Service Communication](#7-grpc-high-performance-service-communication)
8. [API Gateway Architecture](#8-api-gateway-architecture)
9. [Error Contracts and Client Experience](#9-error-contracts-and-client-experience)
10. [Multi-Protocol Architecture](#10-multi-protocol-architecture)
11. [Real-World Company API Patterns](#11-real-world-company-api-patterns)
12. [Pattern Recognition — How to Identify API Design Decisions in Interviews](#12-pattern-recognition--how-to-identify-api-design-decisions-in-interviews)
13. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

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

## 3. Idempotency and Safe Retries

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

## 4. Versioning and Evolution

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

## 5. Pagination at Scale

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

## 6. GraphQL: Flexible Queries and Their Cost

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

## 7. gRPC: High-Performance Service Communication

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

## 8. API Gateway Architecture

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

## 9. Error Contracts and Client Experience

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

## 10. Multi-Protocol Architecture

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

## 11. Real-World Company API Patterns

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

## 12. Pattern Recognition — How to Identify API Design Decisions in Interviews

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

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| API contract | The stable surface — harder to change than any backend implementation |
| REST = resources | URLs are nouns, HTTP methods are verbs |
| Most APIs aren't REST | They're HTTP-JSON APIs — skip HATEOAS, and that's ok |
| Idempotency key | Client-generated UUID, server deduplicates writes on retry |
| Stripe pattern | Idempotency key + expandable fields + cursor pagination + webhooks |
| PUT erases missing fields | PUT is full replace — use PATCH for partial updates |
| State transitions | Model as sub-resource POST: `POST /orders/123/cancellation` |
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
