# Answers: Communication & Messaging Protocols

> Keyed to [questions.md](./questions.md). Read questions first.
> Code examples use HTTP/JSON/proto/pseudocode where helpful.

---

## Level 1 — Communication Foundations

### A1. Synchronous vs asynchronous communication

**Synchronous** means caller and callee are both active at the same instant and the caller *blocks waiting for a response*. **Asynchronous** means the producer hands a message to a broker/queue and moves on; the consumer processes it whenever it is ready. The two parties never have to be alive at the same moment.

| Axis | Synchronous | Asynchronous |
|---|---|---|
| Liveness requirement | Both up simultaneously | Independent; broker buffers |
| Coupling | Temporal + availability coupling | Decoupled in time |
| Response | Caller waits inline | No immediate response expected |
| Failure if peer down | Call fails now | Message waits in queue |
| Examples | REST call, gRPC unary, phone call | Kafka, RabbitMQ/AMQP, SQS, email |

The key coupling difference is **temporal coupling**: synchronous binds the two services' availability windows together (if the callee is down, the caller's request dies *now*); async breaks that bind by inserting a durable buffer.

---

### A2. Three failure modes of "REST for everything"

When every inter-service hop is a blocking REST call, you inherit failures a broker would absorb:

| Failure mode | What happens with sync REST | What a broker avoids |
|---|---|---|
| Cascading failure | Downstream slowness ties up upstream threads/connections; the stall propagates up the call chain | Producer writes to queue and returns; consumer slowness only grows queue depth |
| Traffic spikes / overload | A burst floods the callee directly; it sheds load or times out | Queue absorbs the burst; consumer drains at its own rate |
| Lost work on crash | If the callee crashes mid-request, the in-flight work is gone unless the caller retries | Message persists in the broker until acknowledged |

```
Sync chain (one slow hop stalls everyone):
A --HTTP--> B --HTTP--> C(slow)   →  A, B both block, threads exhausted

Async (C's slowness is contained):
A --enqueue--> [queue] <--poll-- C(slow)   →  A unaffected, queue just deepens
```

---

### A3. "Async is always better" — why that's wrong

It's wrong because async trades immediacy and simplicity for operational complexity. You add a broker (a new thing to run and monitor), you lose a synchronous result (the caller must poll or receive a callback), debugging becomes harder (no single stack trace across the boundary), and you must now reason about ordering, duplicates, and eventual consistency.

**Synchronous request/response remains correct when:**

- The caller genuinely needs the result *before* it can proceed (e.g. "is this user authorized?", "what is the current price?").
- The interaction is a read/query with low latency expectations and a human waiting.
- Strong read-after-write consistency is required for that step.

Choose sync when the answer blocks the next line of code; choose async when the work can complete out of band (fire-and-forget, fan-out, batch, anything tolerant of seconds-to-minutes latency).

---

### A4. Decision tree: REST vs gRPC vs GraphQL vs queue vs stream

```
Does the caller need a response before it can continue?
├── NO  →  Asynchronous
│        ├── Do many independent consumers need the same event,
│        │   or do you need replay / event sourcing?
│        │     YES → Event stream (Kafka / Kinesis)
│        │     NO  → Message queue / routing (RabbitMQ-AMQP, SQS)
│        └── (fan-out notifications → SNS / EventBridge)
└── YES →  Synchronous
         ├── Internal service-to-service, low latency, typed contract,
         │   streaming? → gRPC (HTTP/2 + protobuf)
         ├── Client (esp. mobile/web) needs flexible/aggregated data,
         │   many resource shapes from one round trip? → GraphQL
         └── Public/partner API, CRUD over resources, broad
             tooling/cacheability? → REST
```

The first cut is always **sync vs async** (A1). Within sync, the cut is contract style + consumer (internal typed → gRPC; flexible client fetch → GraphQL; public CRUD → REST). Within async, the cut is **queue (work distribution, consume-and-delete) vs stream (replayable log, many consumers)**.

---

## Level 2 — HTTP Fundamentals

### A5. Parts of a URI and where the body goes

A URI locates a resource. Its parts:

```
        https://api.example.com:443/v1/products?category=books&sort=price
        └─┬─┘   └──────┬───────┘└┬┘└────┬─────┘└──────────┬──────────────┘
        scheme       host      port    path            query string
```

| Part | Role | Example |
|---|---|---|
| Scheme | Protocol | `https` |
| Host | Server domain/IP | `api.example.com` |
| Path | Identifies the resource | `/v1/products` |
| Query string | Filters/modifies the request | `?category=books&sort=price` |

The **request body (payload)** travels in `POST`/`PUT`/`PATCH` requests *after* the headers; it is **not part of the URI**. The URI is for *identification and addressing* — it appears in logs, browser history, bookmarks, and caches, and has length limits. Bodies can be large/binary/sensitive, so they're carried separately and are not used to identify the resource. This is also why `GET` should not depend on a body.

---

### A6. Safe vs idempotent methods, and why it matters for retries

- **Safe** = no observable state change on the server (read-only).
- **Idempotent** = doing it N times has the same effect as doing it once.

| Method | Safe | Idempotent | Why |
|---|---|---|---|
| `GET` | Yes | Yes | Read-only |
| `HEAD` | Yes | Yes | Read-only (headers) |
| `OPTIONS` | Yes | Yes | Describes options |
| `PUT` | No | Yes | Replaces resource with a fixed representation |
| `DELETE` | No | Yes | Deleting twice leaves it deleted |
| `POST` | No | No | Each call creates a *new* resource |
| `PATCH` | No | Not guaranteed | Depends on the patch (relative ops aren't) |

`PUT /products/1` is idempotent because it sets the resource to a *specified* full state — repeating it lands on the same state. `POST /products` is not, because each call appends a new product. This matters for **retries**: a network timeout leaves the caller unsure if the request succeeded. Safe to blindly retry `PUT`/`GET`/`DELETE`; retrying `POST` risks duplicates — which is exactly why `POST` needs **idempotency keys** (A14).

---

### A7. Path parameters vs query parameters

```
GET /products/123                 ← path param: identifies ONE resource
GET /products?category=books&page=2  ← query params: filter/sort/paginate a collection
```

| | Path parameter | Query parameter |
|---|---|---|
| Identifies | A specific resource | A subset/view of a collection |
| Hierarchy | Part of the resource path | Optional modifiers |
| Required? | Usually required | Usually optional |
| Cache key | Cleaner, hierarchical | Still part of the cache key |

**Rule:** use a **path parameter** when the value selects *which resource* you mean (`/orders/{orderId}`). Use a **query parameter** for *filtering, sorting, pagination, or optional modifiers* over a collection (`/orders?status=open&limit=20`). If removing the value would make the URL point at a different *thing*, it's a path param; if it just narrows results, it's a query param.

---

### A8. HTTP/2 improvements over HTTP/1.1

| Feature | HTTP/1.1 problem | HTTP/2 fix |
|---|---|---|
| Binary framing | Text parsing, ambiguous | Binary frames — compact, unambiguous |
| Multiplexing | One request per connection at a time; head-of-line blocking; needs 6+ connections | Many concurrent streams over **one** TCP connection |
| Header compression | Repeated verbose headers each request | HPACK compresses headers |
| Stream prioritization | None | Client hints which streams matter |
| Server push | Client must request every asset | Server can proactively push resources |

HTTP/2 (released ~2015) makes the connection far more efficient and is *the* reason gRPC is fast (A15). **What still remains:** TCP-level head-of-line blocking — because all streams ride one TCP connection, a single lost packet stalls *every* multiplexed stream until TCP retransmits (A9).

---

### A9. HTTP/2 head-of-line blocking and how HTTP/3 fixes it

HTTP/2 eliminated *application-layer* HOL blocking (one slow request no longer blocks others at the HTTP level), but the blocking moved **down to the TCP transport layer**. TCP delivers bytes strictly in order; if one packet is lost, TCP holds back *all* later bytes — including bytes for unrelated HTTP/2 streams — until the lost packet is retransmitted. So one dropped packet stalls every stream on that connection.

```
HTTP/2 over TCP:  [stream A][stream B][stream C]  ← all in ONE ordered TCP byte stream
                   lost pkt in A's bytes ⇒ B and C also wait (TCP HOL block)

HTTP/3 over QUIC (UDP): stream A | stream B | stream C  ← independent streams
                   lost pkt in A ⇒ only A waits; B, C keep flowing
```

**HTTP/3 runs over QUIC, a transport built on UDP.** QUIC implements its own per-stream reliability, so loss in one stream doesn't block others. QUIC also folds the TLS handshake into the connection setup (faster handshakes) and supports connection migration across IP changes. Net effect: HOL blocking is solved at the transport layer because there is no single ordered byte stream to block.

---

## Level 3 — REST

### A10. Statelessness — what it requires and the payoff

REST is an architectural style layered on HTTP, not a wire protocol of its own. **Statelessness** requires that *every request carries everything the server needs to process it* — auth token, parameters, body. The server keeps **no per-client session state** between requests; any needed state lives with the client (or in a shared store the request points at, like a session ID resolved from a database/cache, not from server memory).

| | Client must supply | Server must NOT rely on |
|---|---|---|
| Auth | Token/credentials each request | In-memory login session |
| Context | All params/body needed | "Previous request" memory |
| Caching | `ETag`/`If-None-Match` | Per-connection scratch state |

```http
GET /v1/orders/42 HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJ...     ← every request re-authenticates; no server session
```

**Benefit at scale:** any server instance can handle any request, so you can put a plain load balancer in front of a fleet, add/remove nodes freely, and a node crash loses no session. No sticky sessions, no session replication. This horizontal scalability is the entire point.

---

### A11. HTTP caching: Cache-Control, Expires, ETag, and a conditional GET

| Header | Role |
|---|---|
| `Cache-Control` | Directives + freshness lifetime (`max-age`, `public/private`, `no-store`). Preferred modern control |
| `Expires` | Absolute expiry timestamp (HTTP/1.0 legacy; `Cache-Control: max-age` wins if both present) |
| `ETag` | Opaque version fingerprint of the representation, used for *revalidation* |

A **conditional GET** with an `ETag` lets a cache revalidate without re-downloading:

```http
# First response — server gives the validator
HTTP/1.1 200 OK
Cache-Control: public, max-age=3600
ETag: "abc123"

# Later request — client asks "still abc123?"
GET /v1/products/1 HTTP/1.1
If-None-Match: "abc123"

# Unchanged → tiny response, no body re-sent
HTTP/1.1 304 Not Modified
ETag: "abc123"
```

`Cache-Control: max-age` says "you may reuse this for 3600s without asking." After it goes stale, the client revalidates with `If-None-Match`; a `304` means "your copy is still good," saving bandwidth. `Expires` does the same job as `max-age` but with an absolute date and is effectively legacy.

---

### A12. Good REST URI design, and what's wrong with `POST /getUser?id=1`

Rules:

- **Nouns, not verbs.** The HTTP method *is* the verb. `/users`, `/users/123`, `/users/123/orders`.
- **Collections are plural; an item is `collection/{id}`.**
- **Hierarchy expresses relationships**, query string expresses filtering/sorting/pagination.
- **Version explicitly** (`/v1/...`), use proper status codes, stay consistent.

```
Bad:  POST /getUser?id=1          GET /createOrder
Good: GET  /users/1               POST /orders
```

`POST /getUser?id=1` is wrong on three counts: (1) `getUser` is a **verb in the URI** — REST puts the verb in the method; (2) it uses **`POST` for a read** — a read should be a safe, cacheable, idempotent `GET`, and using `POST` defeats caching and misleads about side effects; (3) the identifier `id=1` belongs in the **path** (`/users/1`), not the query string, because it selects one resource. Correct form: `GET /users/1`.

---

### A13. URL-path vs header-based versioning

| | URL path (`/v1/users`) | Header (`Accept: application/vnd.api.v1+json`) |
|---|---|---|
| Visibility | Obvious in URL/logs/browser | Hidden in headers |
| Routing | Easy — gateway routes by path prefix | Gateway must inspect headers |
| Caching | Distinct URLs cache cleanly | Needs `Vary: Accept`; trickier caches |
| Purity | "Less RESTful" (same resource, two URLs) | "Purer" — one URL, negotiated representation |
| Client ergonomics | Trivial to call/curl/share | Must set headers explicitly |

```http
# Path versioning — explicit, easy to route and cache
GET /v1/users/1

# Header versioning — same URL, version negotiated
GET /users/1
Accept: application/vnd.example.v2+json
```

**Operational cost:** path versioning costs you URL proliferation and duplicated routes, but is dead-simple to route, cache, log, and debug — pick it for most public APIs. Header versioning costs you cache complexity (`Vary`) and harder debugging (the version is invisible), but keeps URLs stable — pick it when you want one canonical resource URL and content negotiation. Default to **path versioning** unless you have a strong reason.

---

### A14. Idempotency keys for `POST /payments`

A retried `POST /payments` after a timeout can charge the user twice because `POST` is not idempotent (A6). The fix: the client generates a unique **idempotency key** per logical attempt and sends it as a header; the server records it and short-circuits duplicates.

```http
POST /v1/payments HTTP/1.1
Idempotency-Key: 4f1a-charge-order-9921     ← client-generated, stable across retries
Content-Type: application/json

{ "amount": 4200, "currency": "usd", "order_id": 9921 }
```

**Where it's stored and when it's checked:** the server stores the key (with the request fingerprint and the saved response) in a fast durable store (e.g. Redis/DB) the moment the request arrives, *inside the same transaction* that performs the charge. On every request the server checks first:

```
on POST /payments(idempotency_key):
  existing = store.get(idempotency_key)
  if existing: return existing.saved_response   # duplicate → replay original result, do NOT re-charge
  result = charge_card(...)                      # first time only
  store.put(idempotency_key, result, ttl=24h)    # persist atomically with the charge
  return result
```

This is exactly the Stripe model (the `Idempotency-Key` header). The key must be the same across retries of the *same* logical charge and different for new charges. Deeper treatment in [api-design](../api-design/).

---

## Level 4 — gRPC & Protobuf

### A15. What gRPC is and why it needs HTTP/2

gRPC is an open-source **RPC framework** from Google: you call a method on a remote service as if it were a local function. It inherits the RPC model (typed methods, request/response messages, generated stubs) and adds a strict contract (`.proto`) plus efficient binary serialization (**Protocol Buffers**).

```proto
service PaymentService {
  rpc Charge (ChargeRequest) returns (ChargeReply);   // looks like a local call
}
```

**Why HTTP/2 specifically:** gRPC's features map directly onto HTTP/2 primitives.

| gRPC needs | HTTP/2 provides |
|---|---|
| Multiple concurrent calls on one connection | Stream multiplexing |
| Streaming in both directions (A16) | Long-lived bidirectional streams |
| Compact framing of binary protobuf | Binary framing layer |
| Efficient repeated headers/metadata | HPACK header compression |

HTTP/1.1 has no native multiplexing or server-initiated streaming, so it can't carry client/server/bidirectional streaming cleanly. HTTP/2's stream model is what makes gRPC's four modes possible over a single connection.

---

### A16. The four gRPC streaming modes

| Mode | Shape | Real use case |
|---|---|---|
| **Unary** | 1 request → 1 response | Standard RPC: `Charge(req) → reply` |
| **Server streaming** | 1 request → N responses | Subscribe to a price feed / stream search results / tail logs |
| **Client streaming** | N requests → 1 response | Upload a large file in chunks; aggregate metrics, then one summary |
| **Bidirectional streaming** | N ↔ N independently | Real-time chat, live transcription, multiplayer game state |

```proto
service Feed {
  rpc Get      (Req) returns (Resp);            // unary
  rpc Subscribe(Req) returns (stream Resp);     // server streaming
  rpc Upload   (stream Chunk) returns (Ack);    // client streaming
  rpc Chat     (stream Msg) returns (stream Msg); // bidirectional
}
```

The `stream` keyword on the request side, response side, or both selects the mode. Bidirectional is the most powerful but also the hardest to reason about (flow control, ordering per stream).

---

### A17. Protobuf and why field numbers are sacred

Protocol Buffers are a language-agnostic, schema-driven binary serialization format. You declare messages in a `.proto`; `protoc` generates typed code for C++, Java, Python, Go, etc. The encoded form is **compact and fast to parse** because it's binary and the schema is known on both ends — no field *names* are sent on the wire, only the **field numbers** as tags.

```proto
message User {
  string name  = 1;   // the "1", "2", "3" are wire tags, NOT just ordering
  int32  age   = 2;
  string email = 3;
}
```

Because the field *number* is what's actually encoded, the rules are: **never reuse a number, never renumber an existing field.** If you remove `age`, you must `reserved 2;` so nobody reuses tag 2 with a different type. This is what gives **backward/forward compatibility**: an old client that doesn't know `email` (tag 3) simply ignores the unknown tag; a new server reading old data finds tag 3 absent and uses the default. Adding new fields with new numbers never breaks existing peers — the cornerstone of evolving gRPC contracts.

---

### A18. When gRPC beats REST — and when REST wins

Don't say "gRPC is faster." The deciding factors:

| Factor | Favors gRPC | Favors REST |
|---|---|---|
| Caller | Internal service-to-service | Public/partner/browser clients |
| Contract | Strict, generated, typed (`.proto`) | Loose, human-readable JSON |
| Payload | High-volume, low-latency, binary | Human-debuggable text |
| Streaming | Needs client/server/bidi streams | Simple request/response |
| Tooling/reach | Polyglot internal mesh | Browsers, curl, caches, gateways |

Choose **gRPC** for internal microservice meshes where you control both ends, want a typed contract and codegen, need streaming, and care about per-call latency and CPU (binary protobuf < JSON parsing). Choose **REST** for public APIs, browser consumers (native gRPC isn't directly browser-friendly without gRPC-Web), broad cacheability, and human-readable debugging. A common pattern: REST/GraphQL at the edge, gRPC between services behind it.

---

### A19. gRPC on AWS — why API Gateway struggles, what supports it

API Gateway struggles because it is built primarily for **REST/HTTP and WebSocket** APIs and does not natively proxy **end-to-end HTTP/2 with gRPC trailers**. gRPC depends on HTTP/2 framing and trailing metadata (status in trailers), which a REST-oriented gateway terminates/normalizes rather than passing through.

| AWS option | gRPC support |
|---|---|
| **Application Load Balancer (ALB)** | End-to-end HTTP/2 + gRPC supported (gRPC content type, gRPC health checks) — the front door for gRPC |
| **ECS on Fargate / EC2** | Run gRPC servers in containers; full control |
| **EC2** | Full control over the server and protocol stack |
| **API Gateway + Lambda** | Limited — REST/HTTP focused; not a clean end-to-end gRPC path |

```
gRPC client → ALB (HTTP/2, gRPC) → ECS/Fargate gRPC service (mTLS)
```

So: terminate/route gRPC at an **ALB** in front of **ECS/Fargate (or EC2)** gRPC servers. Reach for API Gateway only for REST/HTTP APIs, not native gRPC.

---

## Level 5 — GraphQL

### A20. What GraphQL solves and what it breaks

REST endpoints return fixed shapes, which causes three classic problems GraphQL targets:

| REST problem | GraphQL fix |
|---|---|
| **Over-fetching** | `/users/1` returns 30 fields you don't need | Client asks for exactly the fields it wants |
| **Under-fetching** | Need user + their orders + each order's items = 3 calls | One query traverses the graph in a single round trip |
| **Multiple round trips** | N endpoints for N resource shapes | One endpoint, client-shaped responses |

```graphql
query {
  user(id: "1") {           # exactly these fields, one round trip
    name
    orders(last: 3) { id total }
  }
}
```

**New problems it introduces:** caching is harder (one POST endpoint, not cache-friendly URLs/`ETags`); the **N+1 problem** appears in resolvers (A22); complex/nested queries can be expensive and need depth/complexity limits and rate controls; and you must guard against abusive queries. So GraphQL shifts cost from "too many endpoints" to "query governance and caching."

---

### A21. Queries, mutations, subscriptions and their REST analogies

| GraphQL op | Purpose | REST analogy | Transport |
|---|---|---|---|
| **Query** | Read/fetch data | `GET` | HTTP request/response |
| **Mutation** | Modify data | `POST`/`PUT`/`PATCH`/`DELETE` | HTTP request/response |
| **Subscription** | Server pushes real-time updates | WebSocket-like / SSE | Usually **WebSocket** (long-lived) |

```graphql
mutation { addItem(cartId: "9", sku: "ABC") { id total } }   # write

subscription { priceChanged(symbol: "AAPL") { price ts } }    # server push
```

Queries and mutations are ordinary request/response over HTTP. **Subscriptions** need a persistent server→client push channel, so they typically run over **WebSocket** (the `graphql-ws` style protocol) — conceptually like a WebSocket or SSE stream (A40). The server keeps the connection open and pushes new data as events occur.

---

### A22. Resolvers and the N+1 problem; DataLoader

A **resolver** is the function that produces the value for a single field of a type (there are Query/Mutation/Subscription resolvers and per-field resolvers). GraphQL executes the query by calling resolvers as it walks the tree.

The **N+1 problem**: fetching a list of N items, then resolving a related field per item, fires 1 query for the list + N queries for the children:

```
query { users(first: 100) { name  org { name } } }

users resolver:        1 query  → 100 users
org resolver per user: 100 queries → SELECT org WHERE id = ?   ← N=100 extra queries
Total: 1 + 100 = 101 round trips
```

**DataLoader fixes it by batching + caching within a request tick.** Instead of querying per user, each `org` resolver registers the needed `orgId` with a loader; DataLoader collects them within the same event-loop tick and issues **one** batched query (`SELECT ... WHERE id IN (...)`), then dedups repeated ids via a per-request cache.

```js
const orgLoader = new DataLoader(ids => db.orgsByIds(ids)); // one IN-query for the batch
// org resolver: return orgLoader.load(user.orgId)  → 1 + 1 = 2 queries total
```

Deeper batching/cache discussion in [api-design](../api-design/).

---

### A23. The schema as contract, and evolving it without `/v2`

GraphQL is strongly typed: the **schema** declares every type, field, and nullability, and the server enforces it. That schema *is* the contract — clients know exactly what they can request, and tooling (introspection, codegen, validation) is generated from it.

```graphql
type User {
  id: ID!
  name: String!
  email: String          # nullable — safe to add later
  phone: String @deprecated(reason: "use contact.phone")
}
```

You evolve **additively, never destructively**, which is why GraphQL avoids URL versioning:

| Safe (non-breaking) | Breaking (avoid) |
|---|---|
| Add a new optional field/type | Remove a field a client uses |
| Add a new query/mutation | Rename a field |
| Mark a field `@deprecated` | Change a field's type / make it non-null |

Because clients select only the fields they ask for, adding fields never affects existing queries. Deprecate old fields (`@deprecated`), watch field-usage analytics, and remove a field only after usage hits zero. This is the same principle as protobuf field numbers (A17) and Avro schema evolution (QB2): grow the contract, don't break it.

---

## Level 6 — Async Messaging: AMQP & RabbitMQ

### A24. AMQP message path and what the broker owns

```
Publisher → [Exchange] --(binding, routing key)--> [Queue] → Consumer
            └──────────────── Broker owns all of this ───────────┘
```

1. **Publisher** sends a message *to an exchange* (never directly to a queue) with a **routing key**.
2. The **exchange** applies its type's routing rules against the **bindings** to decide target queues.
3. The **binding** (exchange→queue rule, with a binding key/pattern) is matched.
4. The **queue** buffers the message until a consumer is ready.
5. The **consumer** receives it and **acknowledges** (ack) so the broker can delete it.

**What the broker owns:** the exchanges, the queues, the bindings between them, message storage/durability, routing logic, delivery + acknowledgements, and redelivery on nack/timeout. The publisher only knows about the exchange and a routing key; the consumer only knows its queue. This indirection (publisher → exchange → queue) is what decouples producers from consumers.

---

### A25. The four RabbitMQ exchange types

| Type | Routing rule | Scenario |
|---|---|---|
| **Direct** | Exact match: routing key == binding key | Route `task.pdf` jobs only to the PDF worker queue |
| **Fanout** | Ignore key; copy to **all** bound queues | Broadcast a cache-invalidation event to every service |
| **Topic** | Pattern match with wildcards `*` (one word) `#` (zero+ words) | `logs.*.error` → all error logs; `orders.eu.#` → all EU order events |
| **Headers** | Match on header attributes (`x-match: all` / `any`), key ignored | Route by `{format: pdf, region: eu}` headers, not a string key |

```
# Topic example
binding key: "orders.*.created"
routing keys: "orders.eu.created" ✓   "orders.us.created" ✓   "orders.eu.shipped" ✗
```

Mental model: **direct** = exact label, **fanout** = broadcast, **topic** = pattern/category subscription, **headers** = match on structured attributes when a single string key is too limiting.

---

### A26. Routing key vs binding key

| | Set by | When | Used by |
|---|---|---|---|
| **Routing key** | The **publisher**, per message | At publish time | Exchange, to decide routing |
| **Binding key** | The **queue's binding** to the exchange | At setup/declare time | Exchange, to match against routing key |

```
# Binding (queue side, set once)
queue.bind(exchange="logs", binding_key="logs.*.error")

# Publish (publisher side, per message)
publish(exchange="logs", routing_key="logs.payment.error", body=...)
#                          └── routing key matched against binding key "logs.*.error" → delivered
```

The publisher stamps each message with a **routing key**; the queue declares a **binding key** describing what it wants. The exchange compares them (exact for direct, pattern for topic). Fanout ignores both; headers uses header arguments instead.

---

### A27. Channel vs connection in AMQP

A **connection** is a single physical TCP connection to the broker. A **channel** is a lightweight *virtual* connection multiplexed *inside* that TCP connection. You open many channels over one connection.

| | Connection | Channel |
|---|---|---|
| Cost | Heavy (TCP + TLS handshake, FDs) | Cheap, lightweight |
| Cardinality | Few per app | Many per connection |
| Concurrency | — | One per thread/consumer |
| Isolation | — | Independent flow control, transactions |

```
TCP Connection ──┬── Channel 1  (publisher thread)
                 ├── Channel 2  (consumer A)
                 └── Channel 3  (consumer B)
```

**Why multiplex:** TCP connections are expensive to open and consume broker resources; opening one per thread/consumer doesn't scale. Channels give you per-thread isolation (each channel has its own flow control and transactional context) while sharing one TCP connection. Rule of thumb: one connection per process, one channel per thread/consumer (channels are not thread-safe to share).

---

### A28. RabbitMQ Queues vs Streams; quorum queues

RabbitMQ offers two consumption models:

| Use case | Pick |
|---|---|
| Simple buffering, point-to-point, request/reply, work distribution | **Queues** (consume-and-delete) |
| Large fan-out, high throughput, event sourcing, replay | **Streams** (append-only log) |

A **stream** is an **append-only log**: messages are *not* deleted on consume; many consumers read independently and can re-read from any offset until messages expire — like a Kafka-style log inside RabbitMQ. A classic **queue** removes a message once it's acknowledged.

```
Queue:  msg consumed → ACK → deleted        (one logical consumer takes each message)
Stream: msg appended → read by N consumers, replayable until retention expires
```

A **quorum queue** is a replicated, highly-available queue type that uses a consensus (Raft-based) replication across nodes. It protects against **broker/node failure and data loss**: messages are committed to a majority of replicas, so if a node dies, a replica with the data is promoted and no acknowledged messages are lost. Use quorum queues when durability/availability matters more than raw single-node speed; use classic queues for the simplest, fastest path. (Quorum queues replaced the older classic mirrored-queue approach for HA.)

---

## Level 7 — Kafka, Event Sourcing & Streaming

### A29. Kafka core model — parallelism *and* ordering together

| Concept | Role |
|---|---|
| **Topic** | Named logical stream of records |
| **Partition** | A topic is split into partitions; each is an ordered, append-only log |
| **Offset** | Monotonic position of a record within a partition |
| **Consumer group** | Set of consumers that *share* a topic's partitions (load balancing) |
| **Replication** | Each partition has a leader + followers across brokers (HA) |

The trick to getting **parallelism and ordering at the same time** is that **ordering is guaranteed only within a partition**, and the **partition is chosen by the record's key** (`partition = hash(key) % numPartitions`):

```
Topic "orders" (key = customer_id):
  Partition 0: [o1 o4 o7 ...]   ← all of customer A's events, in order
  Partition 1: [o2 o5 ...]      ← all of customer B's events, in order
  Partition 2: [o3 o6 ...]      ← customer C ...
Consumers in a group each own some partitions → process in parallel,
yet every single customer's events stay strictly ordered.
```

So you parallelize *across* keys (more partitions = more throughput and more consumers) while preserving order *within* each key. Pick the key to be the entity whose ordering matters (e.g. `customer_id`, `account_id`). Deeper internals (ISR, log compaction, `acks`) in [message-queues](../message-queues/).

---

### A30. Consumer group load balancing and rebalancing

A consumer group balances load by assigning **each partition to exactly one consumer** in the group. Add consumers → partitions redistribute → more parallelism, up to the partition count.

```
3 partitions, group with 2 consumers:
  C1 ← P0, P1      C2 ← P2

Add C3 (rebalance):
  C1 ← P0          C2 ← P1          C3 ← P2     (now 1:1)

Add C4 (4 consumers, 3 partitions):
  C1 ← P0  C2 ← P1  C3 ← P2  C4 ← (idle)        ← wasted
```

A **rebalance** happens when consumers join/leave or partitions change: the group pauses, partition ownership is recomputed, and consumers resume from each partition's last committed offset. During a rebalance, processing briefly stops ("stop-the-world"), so frequent rebalances hurt throughput (mitigated by cooperative/incremental rebalancing).

**Why more consumers than partitions wastes resources:** since a partition maps to one consumer, any consumer beyond `numPartitions` gets **no partition** and sits idle. The unit of parallelism is the partition — to scale consumers, you must first increase partitions.

---

### A31. Event sourcing — components and why Kafka fits

**Event sourcing**: instead of storing only the current state, you store **every state change as an immutable event**, in order. Current state is *derived* by replaying events.

| Component | Role |
|---|---|
| **Event store** | Append-only log of all events (the source of truth) |
| **Command** | A request to do something; may produce event(s) |
| **Event** | An immutable fact that something happened (`OrderPlaced`) |
| **Projection** | A read model built by replaying events into current state |
| **Aggregate** | A consistency boundary clustering related objects/events |

```
Command: PlaceOrder
  → Event: OrderPlaced{id, items}      ┐
  → Event: PaymentCaptured{id, amount} ├─ appended to event store (ordered)
  → Event: OrderShipped{id, tracking}  ┘
Projection: replay events → current order state / read views
```

**Why Kafka fits:** Kafka is an ordered, durable, replicated, append-only log — exactly an event store. It preserves ordering per key/partition (A29), retains events for replay (so you can rebuild projections at any time), scales horizontally, and supports many independent consumers building different projections. That's why it's a default backbone for event-sourced and event-driven systems. See [message-queues](../message-queues/).

---

### A32. Queue (consume-and-delete) vs Kafka commit log (replayable)

| | Traditional queue (SQS, classic RabbitMQ) | Kafka commit log |
|---|---|---|
| On consume | Message removed/acked away | Offset advances; record **stays** |
| Re-read | Gone once consumed | Re-readable until retention expires |
| Consumers | Compete; each message to one consumer | Many groups read the same data independently |
| Model | Work distribution | Durable, replayable event log |

```
Queue:  [m1 m2 m3]  consumer takes m1 → m1 deleted          (transient)
Kafka:  [r0 r1 r2 r3 ...]  group A at offset 3, group B at offset 0
        → both read the same log at their own pace; nothing deleted on read
```

**When replayability actually matters:**

- Rebuilding a read model/projection after a bug or schema change.
- Onboarding a *new* consumer that needs the full history (event sourcing).
- Reprocessing with corrected logic ("replay last 7 days through the fixed pipeline").
- Multiple independent teams consuming the same stream for different purposes.

If you only need "do this work once, then forget it," a queue is simpler and cheaper. If you need history, replay, or many independent readers, use the log.

---

### A33. Kafka vs Amazon Kinesis

| Factor | Apache Kafka | Amazon Kinesis |
|---|---|---|
| Flexibility / openness | More flexible, open-source, portable across clouds | AWS-proprietary, less flexible |
| Operational burden | You run brokers (or pay for MSK) — tuning, scaling, upgrades | Fully managed; no brokers to operate |
| AWS-native integration | Needs connectors | Native with Lambda, Firehose, S3, Analytics, IAM |
| Ecosystem | Kafka Streams, Connect, KSQL, huge ecosystem | Smaller, AWS-centric (Firehose, Analytics) |
| Partition unit | Partitions | Shards |

```
Choose Kinesis: AWS-centric pipeline, want zero broker ops, native Lambda/Firehose/S3 sinks.
Choose Kafka:   multi-cloud / on-prem, need the open ecosystem (Connect/Streams/KSQL),
                want full control, or already standardized on Kafka.
If on AWS but want Kafka semantics without ops → Amazon MSK (managed Kafka).
```

The real trade is **flexibility/portability/ecosystem (Kafka)** vs **zero operational burden + native AWS integration (Kinesis)**. On AWS, MSK is the middle ground.

---

## Level 8 — AWS Managed Messaging

### A34. SQS Standard vs FIFO

| | Standard | FIFO |
|---|---|---|
| Ordering | Best-effort, **no guarantee** | **Strict** order (per message group) |
| Duplicates | Possible — app must handle | **Exactly-once processing**, no duplicates |
| Throughput | Effectively **unlimited** | Limited (higher with high-throughput mode) |
| Use case | Background/batch, high volume | Orders, financial transactions, ticketing |

```
Standard: very high throughput, may reorder/duplicate → consumer must be idempotent
FIFO:     dedup via MessageDeduplicationId, order via MessageGroupId
```

**FIFO mandatory:** processing **financial transactions** or **e-commerce order events** where applying operations out of order (or twice) corrupts state — e.g. "deposit then withdraw" must not flip, and a charge must not duplicate. **Standard correct:** **background image processing / log aggregation** where throughput matters and each job is independent and idempotent, so occasional reordering or a rare duplicate is harmless. Default to Standard for scale; reach for FIFO only when ordering/dedup is a correctness requirement.

---

### A35. SQS Dead-Letter Queue

A **DLQ** is a separate SQS queue where messages that **repeatedly fail processing** are sent so they stop clogging the main queue. What sends a message there: the source queue's **redrive policy** with a `maxReceiveCount`. Each time a consumer receives a message but fails to delete it (it crashed, threw, or the **visibility timeout** expired before ack), the receive count increments; when it exceeds `maxReceiveCount`, SQS moves the message to the DLQ.

```json
{
  "RedrivePolicy": {
    "deadLetterTargetArn": "arn:aws:sqs:...:orders-dlq",
    "maxReceiveCount": 5
  }
}
```

**What you do with the DLQ:** (1) **alert** on DLQ depth — it's a leading indicator of a bad deploy, poison messages, or a downstream outage; (2) **inspect** the failed messages to find the root cause (bad payload vs transient dependency); (3) after a fix, **redrive** them back to the source queue for reprocessing (SQS has a built-in redrive-to-source action). A DLQ turns silent message loss into a visible, replayable backlog.

---

### A36. SNS → SQS fan-out

SNS is **pub/sub** (one message → many subscribers via a topic); SQS is a **durable queue** (one consumer group drains it). The **fan-out pattern** publishes one event to an **SNS topic** that has **multiple SQS queues subscribed**, so each downstream service gets its own durable copy.

```
            ┌──→ SQS: orders-billing   → Billing service
Publisher → SNS topic "OrderPlaced" ──→ SQS: orders-search    → Search indexer
            └──→ SQS: orders-analytics → Analytics
```

**Why combine them instead of either alone:**

| Alone | Limitation | Fan-out fixes |
|---|---|---|
| SNS only | No buffering; if a subscriber is down/slow, the push can be lost or throttled | SQS buffers per consumer; survives downstream downtime |
| SQS only | One queue = one logical consumer; can't broadcast to N independent teams | SNS broadcasts; each team owns its queue + retry/DLQ |

So SNS gives broadcast and decoupling of producers from the consumer *set*; SQS gives each consumer **durability, independent retry, DLQ, and its own processing pace**. Together they're the canonical AWS fan-out building block.

---

### A37. A2A vs A2P in SNS; SNS FIFO + SQS FIFO

| | A2A (Application-to-Application) | A2P (Application-to-Person) |
|---|---|---|
| Target | Other services/systems | End users (humans) |
| Subscribers | SQS, Lambda, HTTP/S endpoints | SMS, email, mobile push |
| Purpose | Decouple microservices, event routing | Notifications/alerts to people |

**SNS FIFO** adds **strict ordering and deduplication** to pub/sub (vs standard SNS's best-effort). It's typically paired with **SQS FIFO** subscribers so the ordering/dedup guarantee is preserved end-to-end through the queue:

```
Lambda → publishes price updates → SNS FIFO Topic (MessageGroupId=symbol, DedupId)
                                       └──→ SQS FIFO Queue → consumer reads in exact order
```

That pairing is the standard recipe when downstream processing must see events **in order and exactly once** (e.g. ordered price updates, financial events). For broadcast notifications to humans you use A2P; for ordered inter-service events you use SNS FIFO → SQS FIFO. (For mobile push specifics — APNs/FCM — see [chat-system](../chat-system/) and the notification-system guide.)

---

### A38. SQS vs EventBridge; the event bus and its three types

Reach for **EventBridge** instead of a plain SQS queue when you need **content-based routing**: route events to different targets based on the event's *contents*, with filtering rules, instead of having every consumer poll one queue and discard what it doesn't want.

| | SQS | EventBridge |
|---|---|---|
| Purpose | Reliable point-to-point queuing | Event-driven routing |
| Routing | None — consumer polls and filters itself | **Rules + event patterns** route by content |
| Filtering | No built-in filtering | Built-in pattern matching |
| Targets | The consumer of that queue | Many AWS targets (Lambda, SQS, SNS, Step Functions, ...) |

An **event bus** is the central pipe that receives events and routes them (via rules) to targets, decoupling producers from consumers. Three bus types:

| Bus type | Source |
|---|---|
| **Default** event bus | Events from AWS services |
| **Custom** event bus | Your own application events |
| **Partner** event bus | SaaS partner event sources (e.g. third-party integrations) |

```json
// EventBridge rule: route only big orders to the fraud-check Lambda
{ "detail-type": ["OrderPlaced"], "detail": { "amount": [{ "numeric": [">", 1000] }] } }
```

Use SQS for "buffer and process this stream of work"; use EventBridge for "route many event types to many targets by content," especially across AWS services and SaaS.

---

## Level 9 — WebSockets & Real-Time Transport

### A39. WebSocket lifecycle and full-duplex

```
1) HTTP upgrade handshake:
   Client → GET /chat HTTP/1.1
            Upgrade: websocket
            Connection: Upgrade
            Sec-WebSocket-Key: dGhlIHNhbXBsZ...
   Server → HTTP/1.1 101 Switching Protocols
            Upgrade: websocket
            Sec-WebSocket-Accept: s3pPLMBiTxaQ...

2) Data frames: both sides now exchange lightweight binary/text frames
3) Persistent connection: stays open for the whole session (until close frame)
```

It starts as a normal HTTP request that **upgrades** (status `101 Switching Protocols`) to the WebSocket protocol over the same TCP connection. After the handshake, both ends send **frames** at will until either side closes.

**Full-duplex vs HTTP request/response:** in HTTP, the client must *ask* before the server can *answer* — communication is half-duplex and client-initiated, one round trip at a time. In a WebSocket, **either side can send a message at any time, simultaneously**, with no request needed. That's what makes it right for chat, multiplayer games, and live collaboration where the **server** must push unsolicited updates. Scaling many persistent connections is hard (stateful, sticky) — see [chat-system](../chat-system/).

---

### A40. WebSocket vs SSE vs Long Polling

| | WebSocket | SSE (Server-Sent Events) | Long Polling |
|---|---|---|---|
| Direction | **Full-duplex** (both ways) | Server→client only | Client polls; server holds then responds |
| Transport | Upgraded TCP (`ws://`) | Plain HTTP stream (`text/event-stream`) | Plain HTTP repeated requests |
| Reconnect | Manual | **Built-in auto-reconnect + `Last-Event-ID`** | Re-issue request |
| Complexity | Higher (stateful) | Low (just HTTP) | Lowest, but inefficient |
| Best when | True bidirectional, low latency | One-way server push (feeds, notifications) | Fallback where SSE/WS unavailable |

```
Long Polling: client → request ───(server holds until data)──→ response → repeat
SSE:          client → 1 request → server streams events ↓↓↓ (one-way)
WebSocket:    client ↔ server, both push frames anytime
```

**Choose:** **WebSocket** when the client *and* server both push frequently (chat, games, collaborative editing). **SSE** when only the **server** pushes (live scores, notifications, dashboards) — it's simpler, rides plain HTTP/HTTP-2, and auto-reconnects. **Long Polling** only as a fallback for old clients/proxies that block WS/SSE. Deeper trade-offs in [sse](../sse/) and [chat-system](../chat-system/).

---

### A41. WebSockets vs Kafka — and using them together

They are constantly confused but solve **orthogonal** problems:

| | WebSocket | Kafka |
|---|---|---|
| Solves | **Transport** to a connected client (server↔browser/app push) | **Backbone** — durable, replayable event log between services |
| Persistence | Transient; nothing stored | Durable, retained, replayable |
| Scale model | Stateful per-connection (hard to scale) | Distributed, partitioned, highly scalable |
| Audience | One end user's live connection | Many backend consumers |

WebSocket is the **last mile** to a user's screen; Kafka is the **internal nervous system**. You use them **together**:

```
Producer service → Kafka topic "live.scores"
        → Stream consumer / gateway subscribes to Kafka
        → Gateway fans the events out over WebSocket to connected browsers

[backend event log]  ──Kafka──►  [WS gateway]  ──WebSocket──►  [user devices]
```

Kafka carries and buffers the events reliably across services and gives replay; the WebSocket gateway holds the live client connections and pushes the relevant events to each user in real time. Don't try to make Kafka talk to browsers, and don't try to make WebSockets your durable event store.

---

## Level 10 — Reliability & Cross-Cutting Concerns

### A42. Why exactly-once delivery is effectively impossible; at-least-once + idempotency

True **exactly-once *delivery*** across a network is impossible because of the **two-generals / acknowledgement problem**: the sender can never be 100% sure its message (or the receiver's ack) arrived. After a timeout it faces an unavoidable choice:

| Choice | Risk |
|---|---|
| Don't retry | Message may be **lost** (at-most-once) |
| Do retry | Message may be **duplicated** (at-least-once) |

```
Sender → [msg] → Receiver
Sender ← [ack lost on the way back]
Sender: "Did it arrive? Unknown." → retry → possible duplicate
```

You cannot eliminate this at the network layer. So the practical pattern is **at-least-once delivery + an idempotent consumer**: retry until you get an ack (no loss), and make processing the same message twice produce the same result (no duplicate *effect*). That yields **effectively-once *processing*** — the user-visible outcome of exactly-once, without the impossible delivery guarantee. (Kafka offers "exactly-once *processing*" within its own boundaries via idempotent producers + transactions, but that's bounded to Kafka, not arbitrary external sinks.) Deeper in [message-queues](../message-queues/).

---

### A43. Duplicate messages: two root causes, three idempotency techniques

**Two root causes:**

1. **Network issues** — a message or its ack is lost/delayed, so the system is unsure of delivery.
2. **Retry mechanisms** — to avoid loss, senders retry; a retry of an already-delivered message produces a duplicate.

**Three ways to make a consumer idempotent:**

| Technique | How it works |
|---|---|
| **Idempotent operations** | Design the effect to be naturally repeatable — `SET balance = 100` not `balance += 10`; upserts not inserts |
| **Dedup via processed-ID store** | Track each message's unique id; skip if already processed |
| **Idempotency key + dedup window** | Pass a stable key to the downstream (Stripe/Twilio/SQS FIFO `MessageDeduplicationId`); it returns the original result |

```sql
-- Manual dedup: atomic "insert if new", skip on conflict
INSERT INTO processed_messages (message_id) VALUES (:id)
ON CONFLICT (message_id) DO NOTHING;
-- rows_affected = 0  → already processed → skip side effects
```

The principle: never assume "delivered exactly once." Assume at-least-once and make the *effect* idempotent (see A42, A14). SQS FIFO and SNS FIFO give you dedup over a window; everywhere else you build it.

---

### A44. One-line "which technology" for each need

| Need | Pick | Why (one line) |
|---|---|---|
| Public CRUD API | **REST** | Resource-oriented, cacheable, universal tooling |
| Low-latency internal microservice call | **gRPC** | HTTP/2 + protobuf, typed contract, streaming |
| Flexible mobile data fetching | **GraphQL** | Client selects exact fields; one round trip, no over/under-fetch |
| Task queue with routing | **RabbitMQ / AMQP** | Exchanges + bindings route work to consumers |
| High-throughput event streaming | **Apache Kafka** | Partitioned, durable, replayable log (or Kinesis on AWS) |
| Fan-out notifications | **SNS (→ SQS) / EventBridge** | Pub/sub broadcast to many subscribers |
| Real-time chat | **WebSocket** | Full-duplex persistent connection per client |

Mnemonic: **public CRUD → REST; internal fast → gRPC; flexible fetch → GraphQL; route work → RabbitMQ; stream/replay → Kafka; broadcast → SNS; live bidirectional → WebSocket.**

---

## Bonus — Questions a Senior Brings Up Unprompted

### AB1. Backpressure across REST, gRPC streaming, Kafka, WebSockets

Backpressure = how the system pushes back when a consumer can't keep up with a producer.

| Transport | Backpressure behavior |
|---|---|
| **REST** | None intrinsic; the server protects itself with rate limiting + `429 Too Many Requests` (+ `Retry-After`). Caller must back off |
| **gRPC streaming** | Built on HTTP/2 **flow control** (per-stream windows); a slow reader shrinks the window so the sender naturally slows |
| **Kafka** | The **log is the buffer** — producers keep writing, slow consumers just lag (consumer lag grows); you monitor lag and scale consumers/partitions. Almost no producer pushback |
| **WebSocket** | TCP send buffer fills; if the app doesn't drain, you must throttle/drop/close. No automatic app-level signal — you build it |

```
gRPC/HTTP-2 flow control: receiver advertises window → sender can't outrun it
Kafka: producer → [retained log] → consumer (lag = backpressure signal, not a stall)
REST: 429 + Retry-After  → client-side backoff (A25 jitter)
WS:   monitor outbound buffer; shed/drop or close if it grows unbounded
```

The cleanest native backpressure is **gRPC/HTTP-2 flow control**; Kafka converts backpressure into **buffered lag** (you scale out); REST and raw WebSockets need explicit application-level handling.

---

### AB2. Contract evolution — the common principle

REST versioning, protobuf field numbers, and a Kafka **Schema Registry** (Avro) all enforce one principle: **evolve the contract additively and stay backward/forward compatible — never break existing readers.**

| Mechanism | How compatibility is preserved |
|---|---|
| REST | Add fields/endpoints; deprecate before removing; version (`/v1`) only for breaking changes |
| Protobuf | Field numbers are immutable; add new fields with new numbers; `reserved` removed ones |
| Avro + Schema Registry | Registry enforces compatibility (backward/forward) on every schema change; readers tolerate added fields with defaults |

```
Old reader + new writer (new optional field) → old reader ignores it      (forward compat)
New reader + old writer (missing field)       → new reader uses default    (backward compat)
```

The unifying rule: **add, don't mutate; default, don't require; deprecate, don't delete.** Whether the contract is JSON, protobuf, or Avro, you grow it so old and new participants coexist — same idea behind A17 and A23.

---

### AB3. Securing each transport

| Transport | Security |
|---|---|
| **REST** | **HTTPS/TLS** in transit; auth via OAuth2/JWT bearer or API keys; input validation; rate limiting |
| **gRPC** | **TLS** on the channel; **mTLS** (mutual certs) for service-to-service identity; per-call auth via JWT/OAuth in metadata; **interceptors** to enforce authz centrally |
| **WebSocket** | Authenticate **at the handshake** (token in the upgrade request / cookie), since you can't re-auth every frame cheaply; use `wss://` (TLS); validate origin; re-check authz on sensitive actions |
| **AWS messaging** | **IAM** policies/roles for who can publish/consume (SQS/SNS/EventBridge/Kinesis); encryption at rest (KMS) and in transit; VPC endpoints |

```
REST/gRPC:   TLS everywhere; gRPC adds mTLS for mutual service identity
WebSocket:   authenticate the UPGRADE request (token), then trust the session
AWS:         IAM is the gate — least-privilege policies on each queue/topic/bus
```

Key insight: **WebSocket auth happens once at the handshake** (the persistent connection is then trusted), whereas REST/gRPC re-authenticate per call; AWS messaging delegates authz to **IAM** rather than app-level tokens.

---

### AB4. Tracing one action across REST → Kafka → gRPC

You trace it with **distributed tracing**: a single **trace id** (plus span ids) is generated at the edge and **propagated across every boundary**, so all the spans link into one trace (W3C `traceparent` / OpenTelemetry context).

| Boundary | What must propagate, how |
|---|---|
| REST | `traceparent` (+ `tracestate`) **HTTP header** |
| Kafka | Trace context copied into **message headers** (Kafka records have headers) |
| gRPC | Trace context in **gRPC metadata** (interceptor injects/extracts) |

```
Client → REST [traceparent: 00-<trace_id>-<span>-01]
       → service A produces Kafka msg (copy traceparent into record headers)
       → consumer B reads headers, continues the SAME trace_id
       → B calls gRPC C (traceparent in metadata)
   → all spans share one trace_id → one timeline in Jaeger/Tempo/X-Ray
```

The non-negotiables: **propagate the trace context across each hop's native carrier** (HTTP header → Kafka header → gRPC metadata) and have every service create child spans under the inherited context. Without propagation through the *async* (Kafka) hop, the trace breaks in two — that's the step people forget.

---

### AB5. "Just use Kafka for everything" — push back

Kafka is excellent for high-throughput, durable, replayable event streaming — but it is the **wrong tool** in several places, and "scalable" doesn't make it universal:

| Want | Kafka is wrong because | Use instead |
|---|---|---|
| Synchronous request/response with a result | Kafka is fire-and-forget async; no built-in correlated reply | REST / gRPC |
| Per-message routing to one of N workers by attribute | No rich exchange-style routing | RabbitMQ/AMQP |
| Simple managed queue, low ops | You must run/operate brokers (or pay MSK); heavy for small jobs | SQS |
| Push to a browser/device | Kafka doesn't talk to clients | WebSocket / SSE |
| Strict per-message rich routing + DLQ ergonomics | Coarser than a broker | RabbitMQ / SQS DLQ |

```
"Scalable" ≠ "right". Kafka costs you:
 - operational complexity (brokers, partitions, ISR, rebalances)
 - no native request/reply, no per-message routing rules
 - over-engineering for a simple background queue
 - it cannot directly serve end-user connections
```

Concretely: a payment authorization that needs an answer *now* → gRPC/REST, not Kafka. A small background task queue → SQS. Routing tasks by type to specific workers → RabbitMQ. Pushing live updates to the UI → WebSocket/SSE. Use Kafka where you genuinely need a **durable, replayable, high-throughput, multi-consumer event log** — and a different tool everywhere else.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Sync vs async | Sync = block + temporal coupling; async = broker buffers, decoupled in time |
| Decision first cut | Pick sync vs async first; then contract style (REST/gRPC/GraphQL) or queue vs stream |
| URI parts | scheme://host:port/path?query — body is NOT part of the URI (it's for identity) |
| Safe vs idempotent | Safe = read-only; idempotent = repeat = same effect; PUT idempotent, POST not |
| Path vs query param | Path selects *which* resource; query filters/sorts/paginates a collection |
| HTTP/2 | Binary framing, multiplexing, HPACK, server push — one connection, many streams |
| HTTP/3 / QUIC | Over UDP, per-stream reliability → kills TCP head-of-line blocking |
| REST statelessness | Every request self-contained; no server session → any node serves any request |
| ETag conditional GET | `If-None-Match` → `304 Not Modified`, skip re-downloading the body |
| Idempotency key | Stripe-style `Idempotency-Key`; stored at arrival, checked first → replay, don't re-charge |
| gRPC | HTTP/2 + protobuf RPC; needs HTTP/2 for multiplexing + streaming |
| 4 gRPC streaming modes | Unary, server-stream, client-stream, bidirectional |
| Protobuf field numbers | Never reuse/renumber; `reserved` removals → backward/forward compatible |
| GraphQL | Fixes over/under-fetching; one endpoint, client picks fields; watch N+1 + caching |
| N+1 / DataLoader | 1+N queries → batch ids per tick into one `IN (...)` query |
| AMQP path | publisher → exchange → (binding/routing key) → queue → consumer; broker owns it all |
| 4 exchange types | Direct (exact), fanout (broadcast), topic (pattern), headers (attributes) |
| Routing vs binding key | Routing key = publisher per-message; binding key = queue's binding rule |
| Channel vs connection | Many cheap channels multiplexed over one TCP connection |
| RabbitMQ quorum queue | Raft-replicated HA queue; survives node loss without losing acked messages |
| Kafka model | Topic→partitions; order *within* partition by key → parallelism + ordering together |
| Consumer group rebalance | 1 partition → 1 consumer; >partitions = idle consumers; rebalance pauses processing |
| Event sourcing | Store events not state; replay to derive state; Kafka = append-only event store |
| Queue vs commit log | Queue consume-and-delete; Kafka log replayable by many groups |
| Kafka vs Kinesis | Kafka = open/flexible/ops; Kinesis = managed + AWS-native; MSK = managed Kafka |
| SQS Standard vs FIFO | Standard = unlimited, best-effort, maybe dup; FIFO = ordered, exactly-once processing |
| SQS DLQ | After `maxReceiveCount` failures → DLQ; alert, inspect, redrive |
| SNS → SQS fan-out | SNS broadcasts; each SQS subscriber gets a durable, independently-retried copy |
| A2A vs A2P | A2A = system-to-system (SQS/Lambda/HTTP); A2P = to people (SMS/email/push) |
| SQS vs EventBridge | SQS = buffer/queue; EventBridge = content-based rules routing to many targets |
| WebSocket lifecycle | HTTP `101` upgrade → frames → persistent full-duplex connection |
| WS vs SSE vs long poll | WS = bidirectional; SSE = one-way server push + auto-reconnect; long poll = fallback |
| WebSocket + Kafka | Kafka = internal event backbone; WS = last-mile push to clients; use together |
| Exactly-once delivery | Impossible across a network; use at-least-once + idempotency = effectively-once |
| Duplicate causes | Network loss + retries; fix with idempotent ops / dedup store / idempotency key |
| Backpressure | gRPC = HTTP/2 flow control; Kafka = consumer lag; REST = 429; WS = manual |
| Contract evolution | Add don't mutate, default don't require, deprecate don't delete (REST/proto/Avro) |
| Security per transport | REST=TLS+JWT; gRPC=mTLS+interceptors; WS=auth at handshake; AWS=IAM |
| Distributed tracing | Propagate trace context: HTTP header → Kafka record header → gRPC metadata |
| "Kafka for everything" | Wrong for sync req/reply, rich routing, simple managed queue, client push |
