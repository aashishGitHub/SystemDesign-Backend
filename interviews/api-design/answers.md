# Answers: API Design (REST vs GraphQL vs gRPC)

> Keyed to [questions.md](./questions.md). Read questions first.
> Each answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Fundamentals & API Contracts

### A1. What is an API contract

An API contract is the stable, documented interface between producer and consumer: URLs, methods, request/response shapes, status codes, error formats, and versioning policy. The implementation can change freely as long as the contract holds.

| Concern | Why Contract Matters |
|---|---|
| Client trust | Mobile apps ship binaries that can't be hotfixed — they depend on stable contracts |
| Team independence | Backend and frontend teams develop in parallel against the contract |
| Breaking change detection | Contract-first development (OpenAPI, protobuf) catches breaks in CI |

```yaml
# OpenAPI snippet — this IS the contract
paths:
  /orders:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateOrder'
      responses:
        '201':
          description: Order created
```

---

### A2. Six REST constraints and common violations

| Constraint | What It Requires | Commonly Violated? |
|---|---|---|
| Client-Server | Separate concerns | ✅ Usually followed |
| Stateless | No server-side session between requests | ❌ Violated by sticky sessions |
| Cacheable | Responses must declare cacheability | ❌ Often omitted (no Cache-Control) |
| Uniform Interface | Resources identified by URI, self-descriptive messages | ⚠️ Partially — most skip HATEOAS |
| Layered System | Client can't tell if it's talking to origin or proxy | ✅ Usually followed |
| Code-on-Demand | Server can send executable code (optional) | ⚠️ Rarely used |

Most "REST" APIs are actually **HTTP-JSON APIs** — they use resources and methods but skip HATEOAS and caching headers. This is fine in practice, but know the distinction for interviews.

---

### A3. Resources vs actions in URL design

Resources are nouns; actions are verbs. REST URLs model resources.

```text
✅ Good (resource-oriented):
POST   /orders              → create order
GET    /orders/123          → read order
PATCH  /orders/123          → update order
DELETE /orders/123          → delete order

❌ Bad (action-oriented):
POST /createOrder
POST /getOrderById
POST /updateOrderStatus
```

When an operation doesn't map to CRUD (e.g., "cancel order"), model it as a sub-resource action:
```text
POST /orders/123/cancellation   → creates a cancellation resource
```

---

### A4. Consistent error response format

Every error must include: machine-readable code, human-readable message, and correlation ID for debugging.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Field 'email' must be a valid email address.",
    "details": [
      {"field": "email", "issue": "invalid_format", "value": "notanemail"}
    ],
    "request_id": "req_abc123xyz",
    "doc_url": "https://docs.example.com/errors/VALIDATION_FAILED"
  }
}
```

| Field | Purpose |
|---|---|
| `code` | Machine-parseable, stable across versions |
| `message` | Human-readable, can change freely |
| `details` | Field-level validation errors |
| `request_id` | Traces through logs for support |
| `doc_url` | Self-service debugging |

Never return raw stack traces or internal exception messages to external clients.

---

## Level 2 — REST Deep Mechanics

### A5. Idempotent and safe methods

| Method | Safe? | Idempotent? | Explanation |
|---|---|---|---|
| GET | ✅ | ✅ | Read-only, no side effects |
| HEAD | ✅ | ✅ | Same as GET without body |
| OPTIONS | ✅ | ✅ | Metadata/CORS preflight |
| PUT | ❌ | ✅ | Full replace — same result on retry |
| DELETE | ❌ | ✅ | Deleting already-deleted = same state |
| PATCH | ❌ | ❌ | Depends on operation (increment is not idempotent) |
| POST | ❌ | ❌ | Creates new resource each time |

**Why this matters for retries:** Clients can safely retry idempotent methods on timeout. POST requires an idempotency key to prevent duplicates.

---

### A6. Preventing duplicate orders on POST retry

Use an **idempotency key** — a client-generated unique ID sent in a header.

```text
POST /orders
Idempotency-Key: ik_order_abc123
Content-Type: application/json

{"product_id": "prod_42", "quantity": 1}
```

```ts
async function createOrder(req: Request) {
  const idempotencyKey = req.headers['idempotency-key'];
  // Check if this key was already processed
  const existing = await db.query(
    'SELECT response FROM idempotency_store WHERE key = $1',
    [idempotencyKey]
  );
  if (existing) return existing.response; // return cached response
  
  const order = await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO idempotency_store (key, status) VALUES ($1, $2)',
      [idempotencyKey, 'processing']
    );
    return tx.query('INSERT INTO orders (...) VALUES (...) RETURNING *');
  });
  
  await db.query(
    'UPDATE idempotency_store SET response = $1, status = $2 WHERE key = $3',
    [JSON.stringify(order), 'completed', idempotencyKey]
  );
  return order;
}
```

Stripe uses this exact pattern. Idempotency keys typically expire after 24-48 hours.

---

### A7. Choosing the right 2xx status code

| Code | When to Use | Example |
|---|---|---|
| `200 OK` | Synchronous success with body | `GET /users/123` returns user |
| `201 Created` | Resource created, include `Location` header | `POST /orders` → `Location: /orders/456` |
| `202 Accepted` | Async processing started, not yet complete | `POST /exports` (triggers background job) |
| `204 No Content` | Success but no body to return | `DELETE /orders/456` |

Common mistake: returning 200 for everything. This hides semantics from clients and breaks caching.

---

### A8. Modeling state transitions in REST

Three approaches ranked:

| Approach | Example | When to Use |
|---|---|---|
| Sub-resource POST | `POST /orders/123/cancellation` | Complex action with its own lifecycle |
| PATCH with state field | `PATCH /orders/123 {"status":"cancelled"}` | Simple flag transition |
| DELETE | `DELETE /orders/123` | Only if "cancel" means "remove" semantically |

Best practice: use **sub-resource POST** for non-trivial transitions because it creates an audit trail (the cancellation is itself a resource with a timestamp, actor, and reason).

```ts
// POST /orders/:id/cancellation
app.post('/orders/:id/cancellation', async (req, res) => {
  const cancellation = await orderService.cancel(req.params.id, {
    reason: req.body.reason,
    actor: req.auth.userId,   // from JWT, never from body
  });
  res.status(201).json(cancellation);
});
```

---

## Level 3 — Versioning & API Evolution

### A9. URL-path vs header versioning

| Approach | Pros | Cons |
|---|---|---|
| URL path (`/v1/users`) | Obvious, easy to route, easy to test in browser | Duplicates URL space, harder to share code |
| Header (`Accept: v=2`) | Clean URLs, one route definition | Invisible in browser, harder to debug |
| Query param (`?version=2`) | Easy to add | Pollutes caching, easy to forget |

**Industry consensus:** URL-path versioning wins for public APIs (Stripe, GitHub, Twilio all use it). Header versioning is cleaner for internal APIs where clients are controlled.

```text
Stripe:  https://api.stripe.com/v1/charges
GitHub:  Accept: application/vnd.github.v3+json (header, but also /v3/ in docs)
Twilio:  https://api.twilio.com/2010-04-01/Accounts/
```

---

### A10. Backward-compatible vs breaking changes

| Type | Examples |
|---|---|
| **Backward-compatible** (safe) | Adding a new optional field to response, adding a new endpoint, adding an optional query parameter |
| **Breaking** (requires version bump) | Removing a field from response, renaming a field, changing a field's type, making an optional param required |

Rule of thumb: **additions are safe, removals and renames are breaking.**

```json
// v1 response:
{"user_id": "u123", "name": "Alice"}

// Safe addition (v1-compatible):
{"user_id": "u123", "name": "Alice", "avatar_url": "https://..."}

// BREAKING (v2 required):
{"id": "u123", "full_name": "Alice"}  // renamed fields
```

---

### A11. Safe deprecation strategy

| Phase | Action | Timeline |
|---|---|---|
| 1. Announce | Add `Sunset` and `Deprecation` headers to responses | T+0 |
| 2. Measure | Log all callers of deprecated endpoint by API key | T+0 to T+3mo |
| 3. Notify | Email/dashboard alerts to active consumers | T+1mo |
| 4. Throttle | Gradually reduce rate limit on deprecated endpoint | T+6mo |
| 5. Error | Return `410 Gone` with migration guide URL | T+12mo |

```http
HTTP/1.1 200 OK
Sunset: Sat, 01 Jan 2027 00:00:00 GMT
Deprecation: true
Link: <https://docs.example.com/migration/v2>; rel="successor-version"
```

Never hard-cut without data. Always know who is still calling.

---

### A12. Renaming a response field safely

**Dual-write pattern:** include both field names during transition.

```json
// Phase 1: return both (backward compatible)
{"userName": "alice", "username": "alice"}

// Phase 2: after all clients migrated (verified by logs)
{"username": "alice"}
```

```ts
// Server-side dual-write
function serializeUser(user: User): object {
  return {
    username: user.username,
    userName: user.username, // deprecated alias — remove after migration
  };
}
```

Track which clients read `userName` vs `username` via request logging or feature flags.

---

## Level 4 — Pagination, Filtering & Partial Responses

### A13. Offset vs cursor pagination

| Aspect | Offset (`?page=5&limit=20`) | Cursor (`?cursor=abc&limit=20`) |
|---|---|---|
| Simplicity | ✅ Easy to implement | Slightly more complex |
| Performance at large offsets | ❌ `OFFSET 100000` scans and discards rows | ✅ Seeks directly using index |
| Consistency during mutations | ❌ Inserts/deletes shift pages (skip/duplicate items) | ✅ Stable — points to specific position |
| Random access (jump to page N) | ✅ Trivial | ❌ Not possible |
| Best for | Admin dashboards, small data sets | Mobile feeds, infinite scroll, large data sets |

```sql
-- Offset: slow at deep pages
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000;

-- Cursor (keyset): fast at any depth
SELECT * FROM orders WHERE created_at < '2026-03-15T10:00:00Z'
ORDER BY created_at DESC LIMIT 20;
```

---

### A14. Keyset pagination mechanics

Keyset pagination uses the last row's sort key as the "cursor" for the next page. The DB uses an index seek instead of scanning.

```ts
// Response includes next cursor
{
  "data": [...20 items...],
  "pagination": {
    "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0xNVQxMDowMDowMFoiLCJpZCI6Im9yZF85OTkifQ==",
    "has_more": true
  }
}
```

The cursor is a base64-encoded composite of sort key + tie-breaker (usually `created_at` + `id`):
```ts
function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({
    created_at: row.created_at,
    id: row.id,
  })).toString('base64');
}
```

| Why keyset is faster | Detail |
|---|---|
| Index seek | `WHERE (created_at, id) < (?, ?)` uses B-tree directly |
| No offset scan | DB doesn't discard N rows before returning results |
| Consistent | New inserts don't shift pages |

---

### A15. Designing filtering for many parameters

Use structured query parameters with a consistent naming convention:

```text
GET /products?filter[category]=electronics&filter[price_min]=100&filter[price_max]=500&sort=-created_at&fields=id,name,price
```

| Pattern | Approach |
|---|---|
| Simple filters | `?status=active&type=premium` |
| Nested/complex | `?filter[price][gte]=100&filter[price][lte]=500` |
| Sort | `?sort=-created_at,name` (prefix `-` for descending) |
| Field selection | `?fields=id,name,price` |

For high-complexity search, expose a `POST /search` endpoint with a JSON body:
```json
{
  "filters": [
    {"field": "category", "op": "in", "values": ["electronics", "books"]},
    {"field": "price", "op": "between", "values": [100, 500]}
  ],
  "sort": [{"field": "created_at", "direction": "desc"}],
  "limit": 20,
  "cursor": "abc123"
}
```

This avoids URL length limits and is easier to validate server-side.

---

### A16. Partial responses and over-fetching

| Approach | How It Solves Over-Fetching |
|---|---|
| REST field selection | `?fields=id,name,avatar_url` — server only serializes requested fields |
| GraphQL | Client specifies exact field tree in query |
| REST sparse fieldsets (JSON:API) | `?fields[users]=name,email&fields[posts]=title` |

```graphql
# GraphQL: client requests exactly what it needs
query {
  user(id: "123") {
    name
    avatarUrl
    posts(first: 5) {
      title
    }
  }
}
```

```text
# REST equivalent requires either:
GET /users/123?fields=name,avatar_url    (field selection)
# + separate call:
GET /users/123/posts?limit=5&fields=title
# OR: compound document pattern (JSON:API includes)
```

GraphQL wins for frontends with diverse data needs. REST field selection works when view shapes are predictable.

---

## Level 5 — GraphQL Internals

### A17. What GraphQL solves and what it introduces

| Problem It Solves | New Problem It Introduces |
|---|---|
| Over-fetching (REST returns full objects) | Query complexity attacks (deeply nested queries) |
| Under-fetching (multiple REST round-trips) | N+1 query problem without DataLoader |
| Versioning churn (new endpoint per view) | Schema design complexity |
| Documentation drift | Caching is harder (no URL-based HTTP caching) |

GraphQL is ideal when: many different clients need different shapes of the same data. It's overkill when: you have a single client with predictable views (use REST).

---

### A18. N+1 problem and DataLoader

The N+1 problem: resolving a list of users, then for each user resolving their posts = 1 query for users + N queries for posts.

```ts
// WITHOUT DataLoader — N+1 problem
const resolvers = {
  User: {
    posts: (user) => db.query('SELECT * FROM posts WHERE author_id = $1', [user.id])
    // Called N times = N separate DB queries
  }
};

// WITH DataLoader — batched
const postLoader = new DataLoader(async (userIds: string[]) => {
  const posts = await db.query(
    'SELECT * FROM posts WHERE author_id = ANY($1)',
    [userIds]
  );
  // Group by author_id and return in same order as userIds
  return userIds.map(id => posts.filter(p => p.author_id === id));
});

const resolvers = {
  User: {
    posts: (user) => postLoader.load(user.id)  // batched automatically
  }
};
```

DataLoader collects all `.load()` calls in a single event loop tick, then fires one batched query.

---

### A19. Preventing query complexity attacks

Three defense layers:

| Defense | What It Does |
|---|---|
| Query depth limiting | Reject queries deeper than N levels (e.g., max 7) |
| Query cost analysis | Assign cost per field, reject if total exceeds budget |
| Persisted queries | Only allow pre-registered query hashes (production) |

```ts
// Query cost analysis example
const costMap = {
  User: 1,
  Post: 2,
  Comment: 1,
  'Post.comments': 5, // expensive resolver
};

function calculateCost(query: DocumentNode): number {
  // Walk AST, sum costs, multiply by list sizes
  // Reject if cost > 1000
}
```

```graphql
# Malicious query — depth 10, cost explosion:
query {
  users { posts { comments { author { posts { comments { author { posts { title }}}}}}} }
}
# → Rejected: depth=8 exceeds max=7
```

---

### A20. When NOT to use GraphQL

| Scenario | Why REST or gRPC Is Better |
|---|---|
| File upload/download | REST multipart upload or presigned URLs — GraphQL has no native binary support |
| Service-to-service (internal) | gRPC: lower latency, strong typing, streaming — GraphQL adds unnecessary parsing overhead |
| Simple CRUD with fixed views | REST with well-designed resources — GraphQL adds complexity with no benefit |
| Public API for third parties | REST: universally understood, cacheable, no client library needed |
| Real-time bi-directional streaming | gRPC bidirectional streaming or WebSockets — GraphQL subscriptions are limited |

---

## Level 6 — gRPC & Protocol Buffers

### A21. How gRPC differs from REST

| Aspect | REST (HTTP/JSON) | gRPC (HTTP/2 + Protobuf) |
|---|---|---|
| Transport | HTTP/1.1 or HTTP/2 | HTTP/2 (mandatory) |
| Serialization | JSON (text, ~2-10x larger) | Protobuf (binary, compact) |
| Contract | OpenAPI (optional) | `.proto` file (mandatory) |
| Streaming | Not native (workarounds: SSE, WebSocket) | Native 4 modes |
| Browser support | Universal | Requires gRPC-Web proxy |
| Latency | Higher (text parsing, no multiplexing on HTTP/1.1) | Lower (binary, multiplexed) |
| Code generation | Optional | Built-in (protoc) |

gRPC wins for internal service-to-service due to: binary efficiency, mandatory contracts, bidirectional streaming, and HTTP/2 multiplexing.

---

### A22. Four gRPC streaming modes

| Mode | Client | Server | Use Case |
|---|---|---|---|
| Unary | 1 request | 1 response | Standard RPC: `GetUser(id) → User` |
| Server streaming | 1 request | stream of responses | Real-time price feed: `Subscribe(stock) → stream<Price>` |
| Client streaming | stream of requests | 1 response | File upload: `stream<Chunk> → UploadResult` |
| Bidirectional streaming | stream | stream | Chat: `stream<Message> ↔ stream<Message>` |

```protobuf
service StockService {
  rpc GetPrice (StockRequest) returns (PriceResponse);              // unary
  rpc SubscribePrices (StockRequest) returns (stream PriceResponse); // server stream
  rpc UploadData (stream DataChunk) returns (UploadResult);          // client stream
  rpc Chat (stream ChatMessage) returns (stream ChatMessage);        // bidi
}
```

---

### A23. gRPC and browsers

gRPC uses HTTP/2 trailers and binary framing that browsers don't expose through fetch/XHR APIs.

| Workaround | How It Works | Tradeoff |
|---|---|---|
| gRPC-Web + Envoy proxy | Proxy translates gRPC-Web (HTTP/1.1 compatible) to native gRPC | Extra infra hop, no client streaming |
| Connect protocol (Buf) | Wire-compatible with gRPC but also works over HTTP/1.1 | Newer, less ecosystem support |
| REST gateway (grpc-gateway) | Auto-generates REST endpoints from `.proto` annotations | Loses streaming, adds latency |

Most companies: gRPC for internal, REST for external/browser. The gateway translates.

---

### A24. Protobuf vs JSON schema evolution

| Concern | Protobuf | JSON |
|---|---|---|
| Adding a field | Safe — unknown fields ignored by old clients | Safe if clients ignore unknown keys |
| Removing a field | Safe — old field number reserved, not reused | ⚠️ Clients may break if they depend on it |
| Renaming a field | ✅ Field numbers are the contract (name is cosmetic) | ❌ Breaking — name IS the contract |
| Type change | ❌ Breaking | ❌ Breaking |
| Required → optional | Safe in proto3 (all fields optional by default) | Depends on client validation |

```protobuf
message User {
  int32 id = 1;
  string name = 2;
  string email = 3;       // added in v2 — safe
  // string phone = 4;    // removed — reserve field number
  reserved 4;
}
```

Protobuf's numeric field identifiers make renames free — a significant advantage over JSON.

---

## Level 7 — API Gateway & Security

### A25. Gateway vs service responsibilities

| Responsibility | API Gateway | Service |
|---|---|---|
| TLS termination | ✅ | ❌ |
| Authentication (JWT validation) | ✅ | ❌ (trusts gateway) |
| Authorization (fine-grained) | ❌ | ✅ (owns business rules) |
| Rate limiting | ✅ | ⚠️ (secondary per-service limits) |
| Request validation (schema) | ✅ (coarse) | ✅ (detailed business rules) |
| Routing / load balancing | ✅ | ❌ |
| Response transformation | ✅ (format adaptation) | ❌ |
| Circuit breaker | ✅ | ❌ |
| Business logic | ❌ | ✅ |

Rule: gateway handles **cross-cutting infrastructure**; services handle **domain logic**.

---

### A26. Authentication propagation

```text
Client → [JWT in Authorization header] → API Gateway
  Gateway: validate signature, check expiry, extract claims
  Gateway: inject X-User-Id, X-Tenant-Id headers (trusted, signed)
  Gateway → Service A → Service B (headers propagated)
```

| Pattern | Pros | Cons |
|---|---|---|
| Gateway-only auth | Simple, single validation point | Services blindly trust gateway |
| JWT propagated to services | Services can verify independently | JWT validation cost on every hop |
| mTLS + gateway claims | Services trust gateway via mTLS, read claims from headers | More infrastructure |

Best practice: gateway validates JWT, injects claims as headers. Internal services trust gateway via mTLS. Never pass raw passwords between services.

---

### A27. Idempotency keys at gateway level

```ts
// Gateway middleware for idempotency
async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // no key = no dedup
  
  const cached = await redis.get(`idemp:${key}`);
  if (cached) {
    const { statusCode, body } = JSON.parse(cached);
    return res.status(statusCode).json(body);
  }
  
  // Acquire lock to prevent concurrent processing of same key
  const lock = await redis.set(`idemp:lock:${key}`, '1', { NX: true, PX: 30000 });
  if (!lock) return res.status(409).json({ error: 'Request in progress' });
  
  // Capture response to cache it
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    redis.setex(`idemp:${key}`, 86400, JSON.stringify({
      statusCode: res.statusCode,
      body,
    }));
    redis.del(`idemp:lock:${key}`);
    return originalJson(body);
  };
  next();
}
```

| Design Decision | Choice |
|---|---|
| Key TTL | 24-48 hours (Stripe uses 24h) |
| Scope | POST/PATCH only (GET is already idempotent) |
| Conflict response | `409 Conflict` if duplicate request still processing |
| Storage | Redis with TTL (fast, auto-expiring) |

---

### A28. Backend-for-Frontend (BFF) pattern

A BFF is a thin API layer that aggregates and adapts backend services for a specific frontend.

```text
Mobile App  → Mobile BFF  → [Orders, Users, Products services]
Web SPA     → Web BFF     → [Orders, Users, Products services]
Partner API → Public API   → [Orders, Users, Products services]
```

| When Needed | Why |
|---|---|
| Mobile needs smaller payloads than web | Different field selection, compression |
| Web needs real-time updates, mobile uses polling | Different response delivery |
| Partner API needs stable versioning, internal can break freely | Different compatibility contracts |

When NOT needed: if you have one client with one shape of data, BFF is unnecessary overhead.

---

## Level 8 — Production Operations & Architect Tradeoffs

### A29. API observability design

| What to Log Per Request | Why |
|---|---|
| `request_id` (correlation ID) | Trace across services |
| `method + path + status_code` | Basic traffic analytics |
| `latency_ms` | Performance monitoring |
| `user_id / api_key` | Per-consumer debugging |
| `request_size / response_size` | Bandwidth and cost analysis |
| `error_code` (if applicable) | Error rate dashboards |

```promql
# Key alerts
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
```

| Alert | Threshold |
|---|---|
| p99 latency per route | > 500ms for 5 minutes |
| 5xx error rate | > 1% for 3 minutes |
| 4xx spike (non-429) | > 3x baseline in 10 minutes |
| Request volume drop | > 50% drop vs same hour yesterday |

---

### A30. Handling malformed partner requests

Never break the partner — fix defensively at the boundary.

| Strategy | Implementation |
|---|---|
| Lenient parsing | Accept both `"quantity": "5"` (string) and `"quantity": 5` (number) |
| Coercion layer | Gateway normalizes known fields before routing to service |
| Logging without blocking | Log malformed fields for partner notification, process what's valid |
| Schema validation modes | `strict` for new partners, `lenient` for legacy |

```ts
// Coercion example
function coerceOrderRequest(body: unknown): OrderRequest {
  return {
    quantity: Number(body.quantity),  // handles string "5" → 5
    product_id: String(body.product_id || body.productId), // handle naming variants
  };
}
```

Define a migration path: log → notify partner → set deadline → enforce strict mode.

---

### A31. Forcing migration off deprecated endpoints

| Phase | Action | Impact |
|---|---|---|
| Warning headers | `Sunset` + `Deprecation` headers in all responses | Zero breaking impact |
| Rate limit reduction | Reduce v1 rate limit by 50% over 3 months | Encourages migration |
| Brownout testing | Disable v1 for 1 hour on announced dates | Forces clients to test v2 |
| 410 Gone | Return `410` with migration guide URL | Final sunset |

```ts
// Brownout middleware
function brownoutMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isDeprecatedRoute(req.path) && isBrownoutWindow()) {
    return res.status(410).json({
      error: 'ENDPOINT_SUNSET',
      message: 'This endpoint is in brownout. Migrate to /v2/.',
      migration_guide: 'https://docs.example.com/v2-migration',
    });
  }
  next();
}
```

GitHub used this exact brownout strategy for their OAuth API migration.

---

### A32. Multi-protocol architecture viability

```text
External/Public → REST (universally understood, cacheable)
Web Frontend   → GraphQL (flexible queries, one round-trip)
Internal       → gRPC (low latency, typed contracts, streaming)
```

| Operational Cost | Mitigation |
|---|---|
| Three serialization formats | Shared domain models with format-specific adapters |
| Three sets of documentation | Auto-generate from OpenAPI (REST), schema (GraphQL), proto (gRPC) |
| Three monitoring stacks | Unified observability layer at gateway |
| Team skill requirements | Specialize teams by protocol boundary |

This is how Google, Netflix, and Uber actually operate. The cost is real but manageable with automation. The alternative — one protocol for everything — creates worse tradeoffs.

---

## Bonus — Senior Questions

### AB1. Contract enforcement in CI/CD

| Tool | Protocol | What It Checks |
|---|---|---|
| `openapi-diff` | REST | Detects breaking changes in OpenAPI spec |
| `buf breaking` | gRPC | Detects breaking .proto changes (field removal, type change) |
| GraphQL schema diff | GraphQL | Detects removed fields, type changes |

All three run in CI on every PR. Breaking changes fail the build.

---

### AB2. API deprecation SLA

| Tier | Notice Period | Brownout | Hard Sunset |
|---|---|---|---|
| Enterprise partners | 12 months | 3 planned brownouts | After 12 months |
| Free-tier consumers | 6 months | 2 planned brownouts | After 6 months |
| Internal services | 1 sprint + migration PR | N/A | After migration verified |

Document this in your API terms of service.

---

### AB3. Versioning across microservices

| Strategy | When to Use |
|---|---|
| Gateway versioning (single version for all) | Simpler, works for monoliths or small service counts |
| Per-service versioning | Necessary when services evolve at different speeds |
| Contract-first with backward-compatible changes only | Best — avoids versioning entirely for most changes |

Best practice: version at the gateway (public surface), use backward-compatible changes internally. Only create a new version when a breaking change is unavoidable.

---

### AB4. API documentation strategy

| Approach | Pros | Cons |
|---|---|---|
| Auto-generated from spec (Swagger UI, Redoc) | Always in sync | Less narrative/tutorial content |
| Manually written (docs site) | Better developer experience | Drifts from reality |
| Hybrid: auto-generated reference + manual guides | Best of both | More tooling to maintain |

Stripe's hybrid approach is the gold standard: auto-generated API reference + hand-written integration guides.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| API contract | The stable surface — implementation can change, contract must not |
| REST constraints | Most APIs are HTTP-JSON, not truly REST (skip HATEOAS) |
| Resource vs action | URLs are nouns, HTTP methods are verbs |
| Idempotency key | Client-generated unique ID to prevent duplicate writes on retry |
| Safe methods | GET, HEAD, OPTIONS — no side effects |
| Idempotent methods | GET, PUT, DELETE — same result on retry |
| POST is not idempotent | Requires idempotency key for safe retries |
| 201 vs 202 | Created (sync) vs Accepted (async) |
| State transitions | Model as sub-resource POST (`/orders/123/cancellation`) |
| URL versioning | Wins for public APIs (Stripe, GitHub, Twilio) |
| Breaking change | Removing/renaming fields, changing types |
| Deprecation | Sunset header → throttle → brownout → 410 Gone |
| Cursor pagination | Always for large datasets — offset fails at depth |
| Keyset pagination | Uses index seek, not offset scan — fast at any depth |
| N+1 in GraphQL | DataLoader batches by event loop tick |
| GraphQL defense | Depth limit + cost analysis + persisted queries |
| gRPC advantage | Binary, HTTP/2, streaming, mandatory contracts |
| gRPC weakness | No browser support without proxy |
| Protobuf evolution | Field numbers are the contract — renames are free |
| Gateway owns | TLS, auth validation, rate limiting, routing |
| Service owns | Authorization, business logic, domain validation |
| BFF pattern | Separate API layer per client type |
| Error format | `{code, message, details, request_id}` — always structured |
| Multi-protocol | REST external + GraphQL web + gRPC internal = industry standard |
