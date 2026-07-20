# Deep Dive: Communication & Messaging Protocols

> Three reading levels per chapter:
> 🟢 Beginner — analogy-based, no jargon
> 🟡 Senior — mechanics, code, tradeoffs
> 🔴 Architect — failure modes, capacity math, design review depth

> Companion files: [api-design](../api-design/) (REST/gRPC/GraphQL depth, idempotency keys, DataLoader),
> [message-queues](../message-queues/) (Kafka/RabbitMQ/SQS, outbox, exactly-once),
> [chat-system](../chat-system/) and [sse](../sse/) (WebSocket/SSE depth).

---

## Table of Contents

1. [Synchronous vs Asynchronous](#1-synchronous-vs-asynchronous)
2. [HTTP & Its Evolution](#2-http--its-evolution)
3. [REST](#3-rest)
4. [gRPC & Protocol Buffers](#4-grpc--protocol-buffers)
5. [GraphQL](#5-graphql)
6. [AMQP & RabbitMQ](#6-amqp--rabbitmq)
7. [Kafka, Event Sourcing & Streaming](#7-kafka-event-sourcing--streaming)
8. [AWS Managed Messaging](#8-aws-managed-messaging)
9. [WebSockets & Real-Time](#9-websockets--real-time)
10. [Reliability: At-Least-Once, Idempotency, Backpressure & Contracts](#10-reliability-at-least-once-idempotency-backpressure--contracts)
11. [Quick Recall Cheat Sheet](#11-quick-recall-cheat-sheet)

---

## 1. Synchronous vs Asynchronous

### 🟢 Beginner — The Phone Call vs The Mailbox

Two ways to ask a coworker for something.

A **phone call** is synchronous: you dial, you wait, and you both have to be present at the same time. You can't hang up and do other work — you stand there holding the line until they answer. If they don't pick up, you got nothing; the conversation just fails.

A **letter in the mailbox** is asynchronous: you write it, drop it in the box, and walk away. You don't wait. The mailbox holds the letter until your coworker is ready to read it — maybe in five minutes, maybe tomorrow. You both never have to be available at the same moment. The mailbox (the queue) absorbs the difference in your schedules.

The whole tradeoff in distributed systems lives in that picture. Phone calls give you an immediate answer but couple you tightly to the other person being there *right now*. Mailboxes decouple your schedules but you don't get an instant reply.

---

### 🟡 Senior — The Coupling Axis

"Sync vs async" is really about **temporal coupling**: must both parties be alive and reachable at the same instant?

| Dimension | Synchronous (request/response) | Asynchronous (message/event) |
|---|---|---|
| Both ends live at once? | Yes — caller blocks for the reply | No — broker buffers until consumer is ready |
| Coupling | Tight (caller knows callee's address, waits) | Loose (producer knows only the topic/queue) |
| Failure when callee down | Request fails immediately | Message waits in queue, processed on recovery |
| Backpressure | Caller's threads/connections pile up | Queue depth grows; consumers drain at own pace |
| Typical transport | HTTP/HTTPS, gRPC | AMQP, Kafka, SQS/SNS |
| Latency profile | Low end-to-end *if* callee is fast | Higher (enqueue + poll), but smooths spikes |
| Example | REST call, gRPC unary, DB query | Order placed → event → email/billing later |

A useful decision tree for "I have a new service-to-service integration":

```
Need a result THIS request to continue?
├── YES → synchronous
│   ├── Internal, low-latency, typed contract, high QPS? → gRPC
│   ├── Public/partner API, cacheable, broad client support? → REST
│   └── Client (esp. mobile/web) needs to shape its own payload,
│        many resources in one round-trip? → GraphQL (BFF)
└── NO → asynchronous
    ├── Work distribution / routing / per-message ack, modest volume,
    │    consume-and-delete? → message queue (RabbitMQ, SQS)
    └── High throughput, replay, many independent consumers,
         event sourcing, retain history? → event stream (Kafka, Kinesis)
```

The two are not enemies — most real systems use both. A checkout does a *synchronous* gRPC call to the payment service (you need the auth result to show the user), then publishes an *asynchronous* `OrderPlaced` event so billing, inventory, and email each react on their own schedule.

---

### 🔴 Architect — Why "REST Everywhere" Hurts, Why "Async Everywhere" Also Hurts

**Three failure modes of defaulting to synchronous REST for every inter-service call:**

1. **Failure amplification / cascading outage.** If service A blocks on B which blocks on C, and C slows from 20 ms to 2 s, A's threads/connections are held open the whole chain. Under load the thread pool exhausts and A falls over *because C was slow* — even though A didn't strictly need C to be fast. A queue would have let A enqueue and move on.
2. **No load smoothing.** A traffic spike hits every downstream synchronously and at once. A broker absorbs the spike as queue depth and lets consumers drain at a steady rate. Without it, the spike is transmitted undamped down the whole call graph.
3. **Tight temporal coupling = poor availability math.** Synchronous chains multiply availability. Five hops each at 99.9% give roughly `0.999^5 ≈ 99.5%` — you *lost* a nine just by chaining. Async hops don't multiply this way because a down consumer just delays, it doesn't fail the producer.

**Why "async is always better" is wrong** — when synchronous is the correct choice:

- **You need the answer to proceed.** Authentication, payment authorization, "is this username taken?" — there is no useful "I'll get back to you" path. The user is waiting on the result.
- **Read-your-writes / immediate consistency** expectations: a UI that must reflect the result now.
- **Simplicity wins.** Async buys you eventual consistency, dedup logic, DLQs, idempotent consumers, and harder debugging (no single stack trace across a queue). If a plain request/response meets the SLA, the async machinery is pure cost.

**What to say in a design review:** "Default to synchronous for the *command that the caller is blocking on* and asynchronous for *everything that can happen after the user got their answer*. Draw the request path; anything off the critical path should be an event, not a blocking call."

**Monitoring signal:** alert when synchronous dependency P99 latency approaches the caller's timeout (`upstream_p99_ms > 0.8 * client_timeout_ms`) — that's the early warning of a thread-pool exhaustion cascade.

---

## 2. HTTP & Its Evolution

### 🟢 Beginner — One Road, Then a Multi-Lane Highway

Imagine ordering food from a restaurant by sending a runner back and forth.

**HTTP/1.1** is a single-lane road with one runner. They can carry one order at a time, and if order #1 is a slow dish, orders #2 and #3 stuck behind it just wait. To go faster you hire more runners (more connections), but the road is still narrow.

**HTTP/2** widens the road into many lanes so one runner can carry many orders side by side on the same trip (multiplexing). Much faster — but all the lanes still share one paved road, and if the road itself gets a pothole (a lost packet), *every* lane stalls until it's patched.

**HTTP/3** rebuilds the road so each lane has its own independent surface. A pothole in lane 2 only stops lane 2; lanes 1 and 3 keep flowing. That's the leap QUIC makes.

---

### 🟡 Senior — Anatomy and Versions

A URI names the resource the request acts on:

```
https://api.shop.com/v1/products/123?expand=reviews&page=2
└─┬─┘   └────┬─────┘ └──────┬──────┘ └──────────┬──────────┘
scheme     host           path             query string

Request body (payload): travels SEPARATELY from the URI, in POST/PUT/PATCH.
It is NOT part of the URI — URIs identify a resource; the body carries the
representation/data. (Bodies can be large/binary; URIs are meant to be short,
loggable, cacheable, bookmarkable.)
```

- **Path parameter** (`/products/123`) — identifies *which* resource. Use it for hierarchy/identity.
- **Query parameter** (`?page=2&category=electronics`) — filters, sorts, paginates a collection. Use it for non-identifying modifiers.

| | HTTP/1.1 | HTTP/2 (2015) | HTTP/3 |
|---|---|---|---|
| Year / basis | Text protocol | Binary framing | QUIC over UDP |
| Encoding | Text | Binary frames | Binary frames |
| Concurrency | 1 request/connection (pipelining unreliable) | Multiplexed streams over 1 connection | Multiplexed streams over 1 connection |
| Header handling | Plaintext, repeated | [HPACK](./glossary.md#hpack-and-qpack) compression | [QPACK](./glossary.md#hpack-and-qpack) compression |
| Head-of-line blocking | At HTTP layer (per connection) | Removed at HTTP layer, **remains at TCP layer** | Removed at both layers |
| Server push | No | Yes (largely deprecated in practice) | Yes (rarely used) |
| Transport | TCP | TCP | UDP (QUIC) |
| Connection setup | TCP + TLS handshakes | TCP + TLS | QUIC combines transport+TLS (0/1-RTT) |

```http
GET /v1/products/123 HTTP/1.1
Host: api.shop.com
Accept: application/json
Authorization: Bearer eyJ...

HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: public, max-age=3600
ETag: "abc123"
Content-Length: 142
```

**The HOL-blocking subtlety (a classic interview trap):** HTTP/2 multiplexes many logical streams over *one TCP connection*. TCP guarantees in-order byte delivery, so if a single TCP segment is lost, TCP holds back *all* bytes that arrived after it — stalling *every* HTTP/2 stream until the retransmit lands, even streams whose data already arrived. The blocking moved from the HTTP layer down to the **transport (TCP) layer**.

---

### 🔴 Architect — Where Each Version Earns Its Keep

**How HTTP/3 (QUIC) eliminates transport-layer HOL blocking:** QUIC runs over UDP and implements its *own* per-stream reliability. Each stream is delivered and retransmitted independently, so a lost packet affecting stream 2 does not block streams 1 and 3. QUIC also folds the transport and TLS handshakes together, enabling [0-RTT/1-RTT](./glossary.md#0-rtt-and-1-rtt) connection setup and seamless connection migration across network changes (e.g., Wi-Fi → cellular) via a connection ID instead of the 4-tuple.

**Where it actually matters — capacity/latency reasoning:**
- On a clean, low-loss data-center link, HTTP/2's TCP HOL blocking is rarely the bottleneck; the multiplexing already removed the painful part. HTTP/3's edge there is small.
- On lossy/high-latency networks (mobile, cross-continent, ~1–3%+ packet loss), TCP HOL blocking is real and HTTP/3 can meaningfully cut tail latency. This is why large content/CDN providers (Google, Cloudflare, Meta) push HTTP/3 to mobile clients first.

**Config decisions to raise in review:**
- **Connection reuse:** HTTP/1.1 cost is dominated by handshakes; ensure keep-alive and connection pooling. Don't open a fresh connection per request.
- **HTTP/2 with too few connections to a *backend* can re-introduce HOL** under load — this is why gRPC clients sometimes need multiple sub-channels.
- **Server push:** generally don't rely on it; it's effectively deprecated. Use [`103 Early Hints`](./glossary.md#103-early-hints) / preload links instead.

**Failure mode:** middleboxes/old load balancers that don't speak HTTP/2 or block UDP/443 will silently downgrade clients to HTTP/1.1 or break QUIC. Always keep a TCP+HTTP/2 fallback path; advertise HTTP/3 via [`Alt-Svc`](./glossary.md#alt-svc) and let clients negotiate.

**What a real system does:** Google originated QUIC and serves a large share of its traffic over HTTP/3; major CDNs offer it as a toggle. The generally-true practice is *progressive rollout to mobile first*, with HTTP/2-over-TCP as the always-available fallback — not a hard cutover.

---

## 3. REST

### 🟢 Beginner — The Self-Service Vending Machine

A vending machine is *stateless*. It doesn't remember you between purchases. Every time you buy, you must insert everything it needs right then: your money and your selection (B4). The machine keeps no notebook of "this is the third time this person came back." Because it remembers nothing about you, *any* identical vending machine can serve you next time — they're interchangeable. That's why you can put a hundred of them in a mall and they all work without coordinating.

A REST server is the same: each request carries everything needed to fulfill it (auth token, IDs, body). The server holds no per-client memory between requests, so you can run a hundred identical servers behind a load balancer and any one can handle any request.

---

### 🟡 Senior — Statelessness, Caching, Idempotency, Versioning

**Statelessness** requires: the *server* keeps no client session state between requests; the *client* sends all context each time (typically a token + resource IDs). Benefit at scale: any server instance can handle any request, so you scale horizontally and load-balance freely — no sticky sessions, trivial failover.

**Conditional GET with ETag** (saves bandwidth and re-validates cache):

```http
# First response — server stamps a version
HTTP/1.1 200 OK
ETag: "v7-abc123"
Cache-Control: public, max-age=60

# Later, client revalidates with the version it has
GET /v1/products/123 HTTP/1.1
If-None-Match: "v7-abc123"

# Unchanged → no body re-sent, just:
HTTP/1.1 304 Not Modified      # client reuses its cached copy
```

| Header | Does what |
|---|---|
| `Cache-Control: max-age=N` | How long a cache may serve without revalidating |
| `Expires` | Absolute expiry timestamp (older, superseded by `max-age`) |
| `ETag` + `If-None-Match` | Version token for conditional revalidation → `304` |
| `Last-Modified` + `If-Modified-Since` | Timestamp-based revalidation alternative |

**Safe vs idempotent methods** (the retry-safety property):

| Method | Safe (no state change) | Idempotent (N calls == 1 call) |
|---|---|---|
| GET, HEAD, OPTIONS | Yes | Yes |
| PUT | No | **Yes** (sets resource to a value; repeat = same value) |
| DELETE | No | Yes (deleting twice leaves it deleted) |
| POST | No | **No** (each call creates a new resource) |
| PATCH | No | Not guaranteed |

This is why a retried `PUT /products/1` is safe but a retried `POST /payments` can double-charge — `POST` is not idempotent, so you bolt on **idempotency keys** (see §10 and [api-design](../api-design/)).

**URI design rules:** nouns not verbs, plural collections, hierarchy in the path. `POST /getUser?id=1` is wrong on every axis — it puts a verb in the URI, uses `POST` for a read, and shoves identity into a query string. The REST form is `GET /users/1`.

**Versioning:**

| Strategy | Looks like | Cost |
|---|---|---|
| URL-path | `/v1/users` | Visible, cache/router-friendly, easy to route; but "version" leaks into every URL and clients hardcode it |
| Header / media-type | `Accept: application/vnd.api+json; version=1` | Clean URLs; harder to test in a browser, easy to forget, caches must vary on the header |

---

### 🔴 Architect — Caching Math, Versioning Cost, Failure Modes

**Cache-hit capacity math (illustrative):** suppose a catalog endpoint serves ~50,000 req/s and 90% are repeat reads of popular items. With `Cache-Control: public, max-age=60` at the CDN/edge, ~45,000 req/s never reach origin. Origin sees ~5,000 req/s. Add `ETag` revalidation so even the misses often return a tiny `304` (no body): if items are ~20 KB, every avoided full response saves ~20 KB; at 45,000 avoided/s that's ~900 MB/s of origin egress you didn't pay for. The lesson for review: *caching is a capacity decision, not a nicety* — quantify the origin offload.

**Versioning operational cost:** path versioning means you may run `/v1` and `/v2` *simultaneously* for the deprecation window (often months). That's two code paths, two test suites, two sets of metrics, and a migration/sunset plan. The cheaper long-game is **additive, non-breaking evolution**: add fields, never remove or repurpose them, so most clients never need a `/v2` at all. Reserve a new version for genuinely breaking changes.

**Failure modes:**
- **Cache poisoning / stale reads:** caching a response that depends on the auth header without [`Vary: Authorization`](./glossary.md#vary-header) can serve user A's data to user B. Always `Vary` on anything that changes the body, and never set `public` on per-user responses.
- **Thundering herd on expiry:** thousands of clients revalidate the instant `max-age` expires. Mitigate with [`stale-while-revalidate`](./glossary.md#stale-while-revalidate) and [jittered TTLs](./glossary.md#jitter-and-jittered-ttls).
- **Lost statelessness:** introducing server-side session affinity (sticky sessions) quietly breaks horizontal scaling and failover — flag it in review.

**What a real system does:** Stripe's API is a textbook example of additive, backward-compatible versioning pinned per-account (a date-based version), so existing integrations keep working for years while new features ship — minimizing forced `/v2`-style migrations. (Generally-known public practice.)

---

## 4. gRPC & Protocol Buffers

### 🟢 Beginner — Calling a Function in Another Building

Imagine you could call a function that actually runs in another company's building, and it *feels* exactly like calling a local function: you pass arguments, you get a return value, you don't think about the wires in between. That's RPC — Remote Procedure Call — "make a remote thing feel local."

gRPC is a modern, fast version of that. And instead of writing long English sentences for the data (like JSON), the two buildings agree on a tight shorthand code — a numbered checklist where "field 1 is the name, field 2 is the age." Both sides keep the same numbered checklist, so messages are tiny and unambiguous. That shorthand is Protocol Buffers.

---

### 🟡 Senior — HTTP/2 Transport, Streaming, .proto Contracts

gRPC inherits the RPC model (call a remote method like a local one) and runs on **HTTP/2 specifically** because it needs: multiplexed streams (many concurrent calls on one connection), binary framing (carries protobuf efficiently), and long-lived connections for **streaming** in both directions. HTTP/1.1 can't multiplex streams or hold open bidirectional frames the same way, so gRPC's streaming modes wouldn't work on it.

```protobuf
syntax = "proto3";

message User {
  int64  id    = 1;   // field NUMBERS are the wire contract, not names
  string name  = 2;
  string email = 3;
  // To remove a field later: `reserved 3;` — never reuse the number.
}

service UserService {
  rpc GetUser     (GetUserRequest)        returns (User);                 // unary
  rpc ListUsers   (ListUsersRequest)      returns (stream User);          // server stream
  rpc UploadBatch (stream UserRecord)     returns (UploadSummary);        // client stream
  rpc Chat        (stream ChatMessage)    returns (stream ChatMessage);   // bidi stream
}
```

| Streaming mode | Shape | Real use case |
|---|---|---|
| Unary | 1 request → 1 response | Standard "get/create" call |
| Server streaming | 1 request → N responses | Live price feed, large result set paged as a stream |
| Client streaming | N requests → 1 response | Upload a large file in chunks, then one summary |
| Bidirectional | N ⇄ N independently | Real-time chat, telemetry, interactive sessions |

**Why field numbers are sacred:** the wire format encodes `field_number + type`, **not the field name**. A new server and an old client stay compatible as long as numbers keep their meaning. Renumbering or reusing a number makes an old client interpret new bytes as the wrong field — silent data corruption. Rules: never reuse a retired number (`reserved` it), don't change a field's type, treat unknown fields as ignorable. That's how you evolve a schema without a `/v2`.

| Aspect | gRPC | REST |
|---|---|---|
| Contract | `.proto` (strongly typed, codegen) | Often informal (OpenAPI optional) |
| Wire format | Binary protobuf (compact, fast parse) | Usually JSON (human-readable, larger) |
| Transport | HTTP/2 required | HTTP/1.1 or HTTP/2 |
| Streaming | First-class, 4 modes | Limited (SSE/chunked) |
| Browser support | Needs gRPC-Web proxy | Native everywhere |
| Best at | Internal low-latency microservices | Public/partner APIs, broad clients, caching |

---

### 🔴 Architect — When to Choose It, Deadlines, AWS Deployment

**gRPC beats REST when:** internal east-west traffic at high QPS where serialization cost and payload size matter; you want a *generated, enforced* contract across many languages; you need streaming. **REST beats gRPC when:** the consumer is a browser or third party, you want HTTP caching and human-debuggable JSON, or broad tooling/firewall friendliness matters more than raw speed. Decide on *audience and contract enforcement*, not a vague "gRPC is faster."

**Deadlines/cancellation (a staff-level point):** gRPC propagates a **deadline** with each call. If the caller sets a 200 ms deadline and chains downstream, each hop passes the *remaining* budget; when it's exhausted the call returns `DEADLINE_EXCEEDED` and work is cancelled, freeing resources. Use this to prevent the synchronous-cascade problem from §1. Status codes like `UNAVAILABLE` (retryable), `DEADLINE_EXCEEDED`, and `RESOURCE_EXHAUSTED` (backpressure/quota) drive retry and circuit-breaker logic.

**AWS deployment — why API Gateway struggles:** API Gateway is built around REST/HTTP and WebSocket APIs and does not natively proxy HTTP/2 gRPC end-to-end. Components that *do* support end-to-end gRPC:

| Option | gRPC support |
|---|---|
| Application Load Balancer (ALB) | End-to-end HTTP/2 + gRPC, health checks, gRPC status codes |
| ECS/Fargate or EC2 running the gRPC server | Full control, full support |
| API Gateway + Lambda | Limited — primarily REST/HTTP; not a natural gRPC fit |

**Failure mode — L4 load balancing kills gRPC balance:** because gRPC uses long-lived HTTP/2 connections, a connection-level (L4) load balancer pins all of a client's calls to one backend, so new backends get no traffic and load is lopsided. Fix with an L7/gRPC-aware balancer (ALB, Envoy, or client-side load balancing across sub-channels). Raise this explicitly in review — it's a common production surprise.

**Security:** TLS for transport; [**mTLS**](./glossary.md#mtls) for service-to-service identity; JWT/OAuth in metadata; enforce authz/rate limits via **interceptors** (the gRPC equivalent of middleware).

---

## 5. GraphQL

### 🟢 Beginner — Ordering Exactly What You Want at a Restaurant

At a fixed-menu restaurant (REST), each dish comes plated a specific way. If you want the chicken from plate A, the rice from plate B, and the sauce from plate C, you must order three plates and throw away half of each (over-fetching), or wait through three trips to the kitchen (multiple round-trips).

GraphQL is a build-your-own-plate counter. You hand the kitchen one card listing *exactly* the items you want — "chicken, rice, that sauce, nothing else" — and you get back one plate with precisely that, no more, no less, in a single trip. You ask for what you need; you get what you asked for.

---

### 🟡 Senior — Resolvers, Operations, N+1, Subscriptions

GraphQL solves three REST pains: **over-fetching** (REST returns fixed fields you don't need), **under-fetching** (you need several endpoints to assemble one screen), and **multiple round-trips** (collapsed into one query).

```graphql
# Client asks for exactly these fields, across resources, in ONE request
query {
  user(id: "123") {
    name
    orders(last: 3) {
      total
      items { productName }
    }
  }
}
```

| Operation | Purpose | REST analogy | Transport |
|---|---|---|---|
| Query | Read data | `GET` | HTTP |
| Mutation | Modify data | `POST`/`PUT`/`DELETE` | HTTP |
| Subscription | Server pushes real-time updates | (no clean REST analog) | typically **WebSocket** |

A **resolver** is the function that fetches one field of one type. The runtime walks the query and calls a resolver per field. That's where the classic **N+1 problem** appears: a query for 100 users, each resolving `orders`, fires 1 query for the users + 100 separate queries for orders = 101 queries.

```javascript
// N+1: orders resolver hits the DB once PER user → 1 + N queries
const resolvers = {
  User: { orders: (user) => db.orders.findByUserId(user.id) }, // called N times
};

// Fix: DataLoader batches all the per-user calls in one tick into ONE query
const orderLoader = new DataLoader(async (userIds) => {
  const rows = await db.orders.findByUserIds(userIds);          // single IN(...) query
  return userIds.map(id => rows.filter(r => r.userId === id));  // map back, in order
});
const resolvers2 = {
  User: { orders: (user) => orderLoader.load(user.id) },        // batched + cached per request
};
```

DataLoader coalesces the N calls made in the same event-loop tick into one batched query and caches by key for the request. (Depth: [api-design](../api-design/).)

---

### 🔴 Architect — New Problems GraphQL Introduces, and Schema Evolution

GraphQL trades REST's problems for new ones you must manage:

- **Query-cost explosion / DoS:** a client can request deeply nested, expensive graphs (`user → friends → friends → posts …`). Mitigate with **query depth limits, complexity scoring, and persisted queries** (whitelist allowed queries by hash). Without this, one crafted query can melt your DB.
- **Caching is harder:** REST caches per-URL at the HTTP layer for free; GraphQL POSTs to one endpoint, so you lose simple HTTP/CDN caching and push caching down to resolvers/DataLoader (per-request) and the data layer. Persisted queries (GET + hash) can restore some CDN caching.
- **Observability:** "one endpoint" hides which fields are slow; you need per-resolver tracing.

**Schema as contract / evolving without `/v2`:** the schema is a strongly typed contract clients build against. Evolve it **additively** — add types and fields freely (old clients ignore what they don't request). To remove a field, mark it `@deprecated(reason: "...")`, watch field-usage metrics until traffic drops to zero, then remove. Because clients request *only* the fields they use, additive growth almost never breaks anyone — that's the principle it shares with gRPC field numbers and REST additive versioning (see §10/QB2).

**Failure mode — the unbounded resolver:** a list field with no pagination (`posts: [Post!]!`) lets one query pull millions of rows through N+1 resolvers. Always paginate list fields and enforce a max page size at the schema level.

**Capacity note:** without DataLoader, a page rendering 100 items each needing an author lookup issues ~101 DB round-trips per request; at 1,000 req/s that's ~101,000 DB queries/s. With DataLoader it collapses to ~2 batched queries/request → ~2,000 queries/s — a ~50× reduction. Quantify this in review; it's usually the difference between a healthy and a melting database.

**What a real system does:** GraphQL originated at Facebook to let mobile clients fetch exactly what a screen needs in one round-trip (saving battery and bytes on slow networks). Netflix and GitHub also expose GraphQL; the generally-true pattern is a **BFF (Backend-For-Frontend)** GraphQL layer in front of internal REST/gRPC services, not GraphQL all the way down.

---

## 6. AMQP & RabbitMQ

### 🟢 Beginner — The Mailroom with Sorting Rules

Picture a company mailroom. People drop letters at the front desk (the **exchange**) — they never walk to the recipients' desks themselves. The mailroom has sorting rules posted on the wall (**bindings**): "anything labeled `payroll` goes to the Finance pigeonhole; anything labeled `urgent.*` goes to every manager's pigeonhole." Each pigeonhole (**queue**) holds letters until that person comes by to pick them up (the **consumer**).

The sender just writes a label and drops it off. The mailroom's rules decide which pigeonholes get a copy. The sender and recipient never have to meet, and the mailroom owns all the sorting.

---

### 🟡 Senior — Exchanges, Bindings, Routing vs Binding Keys, Channels

The path of a message: **publisher → exchange → (binding) → queue → consumer**. The **broker** owns the exchanges, the queues, the bindings, routing, acknowledgements, and persistence. Publishers know only an exchange + routing key; consumers know only a queue.

```text
publisher --(routing key: "order.us.paid")--> [exchange] --binding match--> [queue] --> consumer
                                                   ▲
                          bindings define which routing keys reach which queue
```

| Exchange type | Routes by | Scenario |
|---|---|---|
| Direct | Exact match: routing key == binding key | Route `task.pdf` to the PDF-worker queue only |
| Fanout | Ignores key — copies to ALL bound queues | Broadcast a cache-invalidation to every service |
| Topic | Pattern match with wildcards (`*` one word, `#` many) | `order.us.*` → US queue, `order.#` → audit queue |
| Headers | Matches header attributes (`x-match: all`/`any`) | Route on `{format: pdf, region: eu}` without a key |

- **Routing key** — set by the **publisher** on each message ("here is my label").
- **Binding key** — set on the **queue's binding** to an exchange ("this queue wants labels matching this pattern"). Direct/topic exchanges compare the two.

**Channels vs connections:** a TCP **connection** to the broker is expensive to open and maintain. A **channel** is a lightweight virtual connection multiplexed inside one TCP connection. You open one connection per process and many channels (e.g., one per thread) over it — concurrency and isolation without paying for many TCP sockets.

```python
connection = pika.BlockingConnection(pika.ConnectionParameters('broker'))
channel = connection.channel()                          # cheap, multiplexed over the TCP conn
channel.exchange_declare('orders', exchange_type='topic')
channel.queue_declare('us-orders', durable=True)        # survives broker restart
channel.queue_bind('us-orders', 'orders', routing_key='order.us.*')  # binding key
channel.basic_publish('orders', routing_key='order.us.paid', body=payload,
                      properties=pika.BasicProperties(delivery_mode=2))  # persistent msg
```

**Queues vs Streams:**

| Use case | Pick |
|---|---|
| Simple buffering, point-to-point, request/reply | Queue (consume-and-delete) |
| Large fan-out, high throughput, event sourcing, re-readable history | Stream (append-only log) |

A **quorum queue** is a replicated queue using a consensus protocol across nodes; it protects against data loss on broker failure by requiring a majority to acknowledge writes (preferred over the older mirrored classic queues for HA).

---

### 🔴 Architect — Acks, Prefetch, Poison Messages, Capacity

**Delivery semantics:** RabbitMQ is at-least-once when consumers use **manual acks**. The consumer acks *after* it finishes processing; if it crashes mid-work, the unacked message is redelivered to another consumer. Auto-ack (ack on delivery) is at-most-once — faster but loses in-flight messages on a crash. Pair manual ack with idempotent consumers (§10).

**Prefetch / fair dispatch:** without a prefetch limit, the broker pushes many messages to one fast-grabbing consumer while others idle, and a slow message blocks the rest behind it. Set [`basic_qos(prefetch_count=N)`](./glossary.md#rabbitmq-prefetch-and-basic_qos) so each consumer holds at most N unacked messages — this is the per-consumer backpressure knob.

```python
channel.basic_qos(prefetch_count=20)   # don't hand a consumer >20 unacked at once
```

**Poison-message failure mode:** a message that always fails (malformed payload) gets redelivered forever, blocking the queue and burning CPU. Fix: configure a [**Dead-Letter Exchange (DLX)**](./glossary.md#dead-letter-exchange-dlx) + max-retry/TTL so a message that exceeds N attempts routes to a dead-letter queue for inspection instead of looping.

**Capacity reasoning (illustrative):** RabbitMQ throughput depends heavily on persistence and acks. Rough orders of magnitude: transient/unacked can reach tens of thousands of msg/s per queue, while durable + manual-ack + quorum replication is lower (single-digit-thousands to low-tens-of-thousands per queue) because each message hits disk and replicas. A single queue is a serialization point — to scale, **shard across many queues** (e.g., consistent-hash exchange) rather than expecting one queue to scale linearly. Treat these as ballpark figures to validate with your own load test, not benchmarks.

**What a real system does:** RabbitMQ is widely used for task/work queues and routing (think background job processing and per-message routing). The generally-true guidance: reach for RabbitMQ when you need rich routing and per-message ack semantics at moderate volume; reach for Kafka (§7) when you need replayable high-throughput logs.

---

## 7. Kafka, Event Sourcing & Streaming

### 🟢 Beginner — A Newspaper vs A To-Do Inbox

A normal task queue is like your **to-do inbox**: a coworker drops a sticky note in, you do the task, and you throw the note away. Once it's done, it's gone — nobody can re-read it.

Kafka is like a **newspaper archive**. Every event is printed in order and kept on the shelf. Many different readers — the sports desk, the ads team, a historian — each read the same archive at their *own* pace, each remembering which page they're on (their offset). If a new reader joins next year, they can start from page one and replay the whole history. Nothing is thrown away when read; it stays until it ages out.

---

### 🟡 Senior — Topics, Partitions, Consumer Groups, Offsets, Replay

A **topic** is a named log, split into **partitions** for parallelism. Each partition is an ordered, append-only sequence; a message's position is its **offset**. Ordering is guaranteed *within a partition*, not across the topic — so you get **parallelism (many partitions) and ordering (within each) at the same time** by routing related messages (same key) to the same partition.

```text
Topic "orders" (key = user_id, so a user's events stay ordered)
  partition 0: [o1][o4][o7]...        ← consumer A (group G)
  partition 1: [o2][o5][o8]...        ← consumer B (group G)
  partition 2: [o3][o6][o9]...        ← consumer C (group G)

Consumer group G: partitions split across members → parallel + per-partition order
Replication: each partition has RF=3 → 1 leader (read/write) + 2 followers (replicate)
```

A **consumer group** load-balances partitions across its members: each partition is owned by exactly one consumer in the group at a time. A **rebalance** happens when a consumer joins/leaves/crashes — partitions are reassigned (briefly pausing consumption). Key consequence: **more consumers than partitions = idle consumers** (a partition can't be split across two consumers in a group), so partition count caps useful parallelism.

| | Traditional queue (RabbitMQ/SQS) | Kafka commit log |
|---|---|---|
| After consume | Message deleted | Retained (offset advances; data stays) |
| Re-read / replay | No | Yes — reset offset, replay history |
| Multiple independent consumers | Compete for the same messages | Each group reads the full stream independently |
| Ordering | Per-queue (often weak) | Per-partition, strong |
| Throughput | Moderate | Very high (sequential disk, batching, zero-copy) |

**Event sourcing** stores every state change as an immutable **event** instead of overwriting current state.

| Term | Meaning |
|---|---|
| Event store | The append-only log of all events (Kafka fits well) |
| Command | A request to do something → may produce event(s) |
| Event | An immutable fact that *happened* (`MoneyWithdrawn`) |
| Projection | Reads events to derive current/queryable state |
| Aggregate | A consistency boundary (e.g., one bank account) |

Kafka fits because it is an ordered, durable, replayable log — exactly the "event store" shape. You replay events to rebuild a projection or seed a new service.

---

### 🔴 Architect — Replay Value, Partition Math, Kafka vs Kinesis, Backpressure

**When replayability actually matters (don't claim it always does):**
- Bootstrapping a *new* consumer/service from full history.
- Rebuilding a corrupted/changed downstream view (new projection, new index).
- Reprocessing after a bug fix in consumer logic.
- Audit/event sourcing where history *is* the source of truth.
If you only ever process each message once and never need history, a queue is simpler and cheaper.

**Partition-count capacity math (illustrative):** suppose a topic must sustain ~500,000 msg/s and one partition+consumer handles ~50,000 msg/s. You need ≥ `500,000 / 50,000 = 10` partitions, so provision ~12–16 for headroom and future growth. Note partitions are hard to *reduce* later (and increasing them breaks key→partition stability), so size with growth in mind. Consumers in the group ≤ partitions, or some sit idle.

**Backpressure in Kafka (QB1):** Kafka decouples producer and consumer via the durable log, so a slow consumer doesn't block the producer — instead **consumer lag** (latest offset − committed offset) grows. That lag is your primary alarm:

```promql
# Alert: a consumer group is falling behind
sum(kafka_consumergroup_lag{group="billing"}) > 100000
# or rate-based: lag growing for 10m straight (consumers can't keep up)
```

Remedies: add consumers (up to partition count), increase partitions for future, or scale processing. Retention is the safety buffer — but if lag exceeds retention, **un-consumed data ages out and is lost**, a real failure mode to monitor.

**Kafka vs Kinesis:**

| Aspect | Apache Kafka | Amazon Kinesis |
|---|---|---|
| Ops burden | You run/operate (or use MSK) | Fully managed by AWS |
| Flexibility | Very flexible, open ecosystem, multi-cloud | AWS-centric, simpler, less tunable |
| Integration | Broad (Connect, Streams, [KSQL](./glossary.md#ksql-and-ksqldb)) | Native AWS (Lambda, Firehose, Analytics) |
| Pick when | High control, portability, rich tooling | All-in on AWS, want managed simplicity |

**The "just use Kafka for everything" trap (QB5):** Kafka is the wrong tool for: request/reply where the caller needs a synchronous answer (that's REST/gRPC); simple low-volume task queues (RabbitMQ/SQS are simpler, support per-message ack and easy DLQ); per-message TTL/visibility-timeout work distribution; and small apps that don't want to operate a partitioned, ZooKeeper/[KRaft](./glossary.md#kraft)-coordinated cluster. Choosing Kafka there costs you operational complexity and per-message semantics you'd otherwise get for free.

**What a real system does:** LinkedIn originated Kafka for high-throughput activity/event pipelines; Uber and Netflix run very large Kafka deployments for event streaming, metrics, and stream processing. The generally-true pattern: Kafka as the central event backbone, with stream processors (Kafka Streams/Flink/Spark) building projections downstream.

---

## 8. AWS Managed Messaging

### 🟢 Beginner — The Post Office, the Bullhorn, and the Smart Switchboard

Three different tools for three different jobs.

- **SQS** is a **post office box**: messages wait in a box until one worker comes and takes one out. Once taken and finished, it's gone. Great for handing off work.
- **SNS** is a **bullhorn**: shout once, and everyone who subscribed hears it at the same time. One message, many listeners. Great for broadcasting.
- **EventBridge** is a **smart switchboard**: events come in, and rules decide which ones get forwarded where ("if it's a fraud event, send it to the security team; if it's a signup, send it to marketing"). Great for routing by content.

---

### 🟡 Senior — SQS Standard/FIFO, SNS Fan-out, EventBridge, DLQ

| Feature | SQS Standard | SQS FIFO |
|---|---|---|
| Ordering | Best-effort (not guaranteed) | Strict per message-group |
| Duplicates | Possible (at-least-once) | Deduplicated (exactly-once *processing* within dedup window) |
| Throughput | Effectively unlimited | Limited (much higher with high-throughput mode) |
| Use when | Background jobs, batch, image processing | Orders, financial txns, anything order-critical |

**SNS → SQS fan-out** is the canonical pattern: SNS alone delivers to subscribers but doesn't *buffer* per-subscriber, and a slow/offline subscriber can miss messages; SQS alone is point-to-point (one consumer set). Combine them — publish once to an SNS **topic**, subscribe *multiple* SQS queues to it. Each service gets its own durable queue copy, drains at its own pace, and gets independent retries/DLQ. One publish, N independent durable consumers.

```text
            ┌──> [SQS: billing queue]   --> billing service
[SNS topic] ┼──> [SQS: search queue]    --> search indexer
            └──> [SQS: analytics queue] --> analytics
publish once                 each queue buffers + retries independently
```

- **A2A (Application-to-Application):** decouples services; targets SQS, Lambda, HTTP/S, etc.
- **A2P (Application-to-Person):** delivers to people via SMS, email, push.
- **SNS FIFO** adds ordering + dedup to pub/sub; typically paired with **SQS FIFO** subscribers to preserve order end-to-end.

**Dead-Letter Queue (DLQ):** attach a DLQ to a source queue with a **`maxReceiveCount`** (the redrive policy). A message that is received and fails (not deleted) that many times is moved to the DLQ instead of redelivering forever — isolating poison messages. You then alert on DLQ depth, inspect, fix the bug, and **redrive** the messages back.

**EventBridge vs SQS:**

| | SQS | EventBridge |
|---|---|---|
| Purpose | Reliable queuing / work handoff | Event-driven routing |
| Pattern | Point-to-point | Rules-based content routing, many targets |
| Filtering | None built-in | Event patterns (route by content) |
| Reach for it when | A consumer pulls work | Many consumers, route by event shape, SaaS integration |

An **event bus** receives and routes events. Three bus types: **Default** (AWS service events), **Custom** (your app's events), **Partner** (SaaS sources like Zendesk/Datadog).

---

### 🔴 Architect — Visibility Timeout, Dedup Window, Capacity, Failure Modes

**Visibility timeout — the central SQS failure mode:** when a consumer receives a message it becomes *invisible* for the visibility timeout; the consumer must delete it before the timer expires. If processing takes *longer* than the timeout, the message becomes visible again and a **second worker processes it concurrently** → duplicate work. Set visibility timeout > worst-case processing time (or extend it via heartbeat), and make consumers idempotent regardless (§10).

**FIFO dedup window:** SQS FIFO dedups by content hash or `MessageDeduplicationId` within a **5-minute** window. A retry after the window can re-enqueue a "duplicate." Use a stable business `MessageDeduplicationId` (e.g., order id), not a per-attempt value, for protection beyond 5 minutes — same principle as idempotency keys.

**Capacity / cost reasoning (illustrative):** SQS Standard scales horizontally with no throughput ceiling you'll hit in practice; the lever is *consumer count* and batch size. Use `ReceiveMessage` long polling (`WaitTimeSeconds=20`) and batch up to 10 messages to cut request count ~10× and avoid empty-receive costs. FIFO has a per-message-group throughput ceiling — if one group (say, all events for one tenant) is hot, that group serializes and becomes the bottleneck; spread load across many message-group IDs.

**Ordering failure mode:** SQS Standard can deliver out of order and duplicated, so any logic assuming "message 2 arrives after message 1" is a bug waiting to happen — either use FIFO or make handlers order-independent and idempotent.

**Monitoring:**
```text
ALARM  ApproximateNumberOfMessagesVisible (DLQ) > 0 for 5m   # poison messages accruing
ALARM  ApproximateAgeOfOldestMessage > visibility_timeout    # consumers can't keep up
```

**What a real system does:** Amazon and countless AWS-native shops use SNS→SQS fan-out as the default decoupling pattern (one publish, many durable consumers) and EventBridge for content-based routing/SaaS integration. The generally-true rule: SQS for "hand off work," SNS for "broadcast," EventBridge for "route by content," and always attach a DLQ.

---

## 9. WebSockets & Real-Time

### 🟢 Beginner — From Walkie-Talkie to Open Phone Line

Normal web requests are like a **walkie-talkie**: you press the button, say something, release, and only then can the other side reply. One direction at a time, and *you* always have to start. If the server learns something new, it can't tell you until you press the button and ask again.

A **WebSocket** is like leaving an **open phone line**: once connected, either side can talk at any moment, both at the same time if they want, without redialing. The server can suddenly say "you have a new message!" without you asking. That always-open, both-directions line is what makes live chat and games feel instant.

---

### 🟡 Senior — Handshake, Full-Duplex, and the Transport Comparison

A WebSocket starts as a normal HTTP request and **upgrades**:

```http
# 1) Client asks to upgrade an ordinary HTTP connection
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

# 2) Server agrees — after this the SAME TCP connection speaks WS frames
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

After the `101`, the connection is **full-duplex**: client and server exchange binary/text **frames** in both directions independently over one persistent TCP connection — no new request needed for the server to push. Contrast with HTTP request/response, which is half-duplex and always client-initiated.

| | WebSocket | SSE (Server-Sent Events) | Long Polling |
|---|---|---|---|
| Direction | Full-duplex (both ways) | Server → client only | Client → server (simulated push) |
| Transport | TCP (after HTTP upgrade) | HTTP (one long response stream) | Repeated HTTP requests |
| Auto-reconnect | Manual | Built-in (`Last-Event-ID`) | Natural (new request each time) |
| Best for | Chat, games, collaborative editing | Live feeds, notifications, dashboards | Fallback when WS/SSE unavailable |
| Overhead | Low per message | Low | High (full request per poll) |

Choose **SSE** when you only need server→client push and want simplicity + auto-reconnect; **WebSocket** when you need genuine bidirectional, low-latency traffic; **Long Polling** only as a fallback for restrictive networks. (Depth: [sse](../sse/), [chat-system](../chat-system/).)

---

### 🔴 Architect — Stateful Scaling, WS vs Kafka, Failure Modes

**The stateful-connection problem:** WebSockets are **stateful** — each connection lives on one specific server. This breaks the stateless-horizontal-scaling story of REST. Implications to raise in review:
- You need a **connection registry / pub-sub backplane** (e.g., Redis pub/sub or a message bus) so a message produced on server B can reach a user connected to server A.
- Load balancers must support sticky, long-lived upgraded connections; a deploy/restart drops *all* connections on that node → reconnect storms.
- **Capacity:** a single node holds a finite number of open sockets (memory + file descriptors). Rough planning: if each connection costs ~tens of KB of memory, ~1M concurrent connections is far beyond one node — you fan out across many nodes and need the backplane. Plan node count by `concurrent_connections / per_node_socket_budget`.

**WebSockets vs Kafka — they solve different problems (a common confusion, Q41):**

| | WebSocket | Kafka |
|---|---|---|
| Solves | Live transport between *server and client* | Durable, high-throughput event pipeline *between services* |
| Persistence | None (transient) | Retained, replayable log |
| Model | Full-duplex connection | Pub/sub partitioned log |

Use them **together**: services publish events to Kafka; a WebSocket gateway service consumes the relevant Kafka topic and pushes updates down the live socket to connected clients. Kafka is the durable backbone; WebSocket is the last-mile delivery to the browser.

**Failure modes:**
- **Reconnect storm:** a node dies and thousands of clients reconnect simultaneously. Mitigate with [jittered](./glossary.md#jitter-and-jittered-ttls) exponential backoff on the client and capacity headroom.
- **Half-open connections:** TCP can keep a dead connection "open." Use WebSocket **ping/pong heartbeats** to detect and reap stale sockets, freeing resources.
- **Auth on the handshake:** authenticate at the upgrade (token in the initial request); you can't rely on per-message auth headers like REST. Re-validate periodically for long-lived sessions.

**Backpressure (QB1):** if the server pushes faster than a slow client drains, the per-connection send buffer grows; you must bound it (drop, coalesce, or disconnect slow consumers) or memory blows up. Unlike Kafka, there's no durable backlog — overflow is a per-connection memory problem.

**What a real system does:** Slack and chat platforms use persistent WebSocket connections for real-time messaging, typically fronted by a connection/gateway tier and backed by an internal event bus. The generally-true pattern: a dedicated WebSocket gateway tier + a pub/sub backplane, never WebSocket logic embedded in stateless business services.

---

## 10. Reliability: At-Least-Once, Idempotency, Backpressure & Contracts

### 🟢 Beginner — The "Did You Get My Text?" Problem

You text a friend "running 5 min late." Your phone shows it failed to send, so you send it again. But actually the first one *did* arrive — your friend's "delivered" receipt just got lost on the way back. Now your friend has two identical texts.

That's distributed messaging in a nutshell. To *guarantee* a message arrives, you must be willing to send it again when you're unsure — which means it might arrive twice. You can't perfectly avoid duplicates over an unreliable network. So instead, you make receiving the same message twice *harmless*: your friend reads "running late" twice and shrugs — the meaning didn't change. Making "twice == once" harmless is the whole trick.

---

### 🟡 Senior — At-Least-Once + Idempotency, the Exactly-Once Myth

**The three delivery semantics:**

| Guarantee | Means | Cost |
|---|---|---|
| At-most-once | Fire and forget; may lose messages | No dups, but data loss possible |
| At-least-once | Retry until acked; may duplicate | No loss, but dups must be handled |
| Exactly-once | Each message effects state once, no loss, no dup | Effectively unattainable as pure *delivery* across a network |

You can't get true exactly-once *delivery* across an unreliable network: the sender, on a lost ack, can't tell "lost in transit" from "lost on the way back," so it must choose to drop (risk loss) or resend (risk dup). The practical answer is **at-least-once delivery + idempotent processing**, which yields exactly-once *effect*.

Two root causes of duplicates: **network failures** (lost acks trigger resends) and **retry mechanisms** (the sender retries to guarantee delivery). Three ways to make a consumer idempotent:

```javascript
// 1) Dedup table on a stable message/business id (check-then-act atomically)
async function handle(msg) {
  const inserted = await db.query(
    `INSERT INTO processed(msg_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING msg_id`,
    [msg.id]
  );
  if (inserted.rowCount === 0) return;   // already processed → skip
  await doWork(msg);
}

// 2) Idempotency key passed to a downstream that dedups (payments, providers)
await payments.charge({ amount, idempotencyKey: order.id }); // same key = charged once

// 3) Naturally idempotent operations (set, not increment)
await db.query(`UPDATE account SET balance = $1 WHERE id = $2`, [finalBalance, id]);
// (replays converge to the same state; avoid balance = balance + x which compounds)
```

**Outbox pattern** — the atomicity fix for "wrote to DB but not to the broker (or vice versa)":

```javascript
// WRONG: two systems, no atomicity — a crash between them loses or orphans the event
await db.insert(order);
await broker.publish(orderEvent);  // crash here → order saved, event never sent

// RIGHT: write the event into an outbox table IN THE SAME DB TRANSACTION as the order
await db.transaction(async (tx) => {
  await tx.insert('orders', order);
  await tx.insert('outbox', { event: orderEvent });   // atomic with the order
});
// A relay (or CDC like Debezium — see glossary) reads the outbox and publishes to the broker at-least-once.
```

([Debezium](./glossary.md#debezium-and-cdc) is the most-used CDC relay for this pattern. Deep treatment of outbox + exactly-once in [message-queues](../message-queues/).)

---

### 🔴 Architect — Backpressure, Contract Evolution, Security, Tracing

**Backpressure across transports (QB1) — how each behaves when the consumer can't keep up:**

| Transport | Backpressure behavior |
|---|---|
| REST | No native backpressure; server returns `429`/`503`, client must back off. Threads/connections pile up if ignored → cascade. |
| gRPC streaming | Built-in flow control (HTTP/2 windows) pauses the sender until the receiver reads. |
| Kafka | Decoupled by the log; slow consumer → **lag grows**, producer unaffected (until retention is exceeded). |
| WebSocket | Per-connection send buffer grows; must bound/drop/disconnect or run out of memory. |

**Contract evolution — the shared principle (QB2):** REST additive versioning, gRPC protobuf **field numbers**, and a Kafka **Schema Registry** ([Avro](./glossary.md#avro)/Protobuf) all enforce the same rule: **evolve schemas backward/forward-compatibly — add, never remove or repurpose; old readers ignore unknown fields, new readers tolerate missing ones.** Identity (field number / field name / schema id) is stable forever. Get this right and you almost never need a breaking `/v2`.

**Circuit breaker + backoff scenario (synchronous dependency protection):**
```text
Closed  → calls flow. Count consecutive failures.
          5 consecutive failures → trip to OPEN.
Open    → fail fast (don't call the dying dependency) for 30s, freeing threads.
          After 30s → HALF-OPEN: allow ONE probe.
Half-open → probe succeeds → CLOSED; probe fails → back to OPEN (reset 30s timer).

Retry with FULL JITTER (avoid synchronized retry storms / thundering herd):
  delay = random() * min(cap, base * 2^attempt)
```

**Security per transport (QB3):** REST → HTTPS/TLS + token (OAuth/JWT); gRPC → TLS, [**mTLS**](./glossary.md#mtls) for service identity, JWT in metadata, interceptors for authz; WebSocket → authenticate on the **handshake** (token in upgrade request), heartbeat + periodic re-auth; AWS messaging → **IAM** policies + resource policies (who can publish/subscribe), encryption at rest (KMS) and in transit.

**Observability — tracing one action across REST → Kafka → gRPC (QB4):** propagate a **trace context** ([W3C `traceparent`](./glossary.md#w3c-traceparent) / correlation id) at every boundary: inject it into HTTP headers, carry it as a **Kafka message header**, and pass it in gRPC metadata. Each hop creates a child span under the same trace id, so a single user action is reconstructable end-to-end across sync and async hops. Without header propagation across the broker, the trace breaks at the queue.

**What a real system does:** Stripe popularized client-supplied **idempotency keys** on write APIs so a retried payment never double-charges; Confluent's Schema Registry is the standard way teams enforce compatible Kafka schema evolution. Both are concrete instances of the same "at-least-once + stable contract" discipline.

---

## 11. Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Sync vs async (coupling) | Sync = both live now, caller blocks (tight); async = broker buffers, decoupled (loose) |
| When sync is right | You need the answer to proceed (auth, payment, "is it taken?") |
| Sync chain availability | Chaining multiplies failure: `0.999^5 ≈ 99.5%` — async hops don't multiply this |
| Decision tree | Need result now? sync (gRPC internal / REST public / GraphQL BFF). Else async (queue vs stream) |
| URI parts | scheme · host · path · query; body travels separately, is NOT part of the URI |
| Path vs query param | Path = identity/hierarchy; query = filter/sort/paginate |
| Safe vs idempotent | GET safe+idempotent; PUT/DELETE idempotent; POST neither → why POST needs idempotency keys |
| HTTP/2 | Binary framing + multiplexing over 1 TCP conn + HPACK; removes HTTP-layer HOL |
| HTTP/2 residual HOL | One lost TCP segment stalls all streams — HOL moved to the transport (TCP) layer |
| HTTP/3 (QUIC) | Over UDP, per-stream reliability → no transport HOL; 0/1-RTT; connection migration |
| REST statelessness | Server keeps no session; client sends all context → any server handles any request |
| ETag / conditional GET | `If-None-Match` → `304 Not Modified`, reuse cache, skip the body |
| REST versioning | URL path = visible/route-friendly but leaks; header = clean but cache must `Vary` |
| gRPC needs HTTP/2 | For multiplexing, binary framing, and bidirectional streaming |
| gRPC streaming modes | Unary, server-stream, client-stream, bidirectional |
| Protobuf field numbers | Wire encodes the number not the name; never reuse/renumber → backward compatibility |
| gRPC LB pitfall | Long-lived HTTP/2 conns pin to one backend under L4 LB → use L7/gRPC-aware (ALB/Envoy) |
| gRPC on AWS | ALB + ECS/Fargate/EC2 do end-to-end gRPC; API Gateway does not (REST/HTTP focused) |
| GraphQL solves | Over-fetch, under-fetch, multiple round-trips → ask for exactly what you need |
| GraphQL N+1 | Per-field resolvers fire 1+N queries; **DataLoader** batches them into one |
| GraphQL new risks | Query-cost DoS (depth/complexity limits), hard caching, per-resolver tracing |
| Subscriptions | GraphQL real-time push, typically over WebSocket |
| AMQP path | publisher → exchange → binding → queue → consumer; **broker** owns routing/queues/acks |
| Routing vs binding key | Routing key set by publisher (message label); binding key set on the queue's binding |
| Exchange types | Direct (exact), Fanout (all), Topic (wildcard pattern), Headers (attribute match) |
| Channel vs connection | Many lightweight channels multiplexed over one TCP connection |
| Quorum queue | Replicated via consensus; protects against data loss on broker failure |
| Kafka model | Topic → partitions (ordered logs); offset = position; consumer group splits partitions |
| Parallelism + order | Many partitions (parallel) + per-partition order; key routes related msgs to same partition |
| Consumers > partitions | Wasteful — extra consumers idle; partition count caps group parallelism |
| Queue vs commit log | Queue = consume-and-delete; Kafka = retained, replayable log read independently per group |
| Event sourcing | Store events not state; event store + command + projection + aggregate; Kafka fits |
| Kafka vs Kinesis | Kafka flexible/portable (self/MSK); Kinesis managed + AWS-native |
| "Kafka for everything" trap | Wrong for request/reply and simple low-volume task queues; costs ops + per-msg semantics |
| SQS Standard vs FIFO | Standard: best-effort order, dups, unlimited; FIFO: strict order, dedup, lower throughput |
| SQS visibility timeout | Set > processing time or a 2nd worker reprocesses → still make consumers idempotent |
| DLQ | After `maxReceiveCount` failed receives, message moves to DLQ; alert, inspect, redrive |
| SNS→SQS fan-out | Publish once to SNS, many SQS queues subscribe → independent durable consumers + retries |
| A2A vs A2P | A2A: app-to-app (SQS/Lambda/HTTP); A2P: to people (SMS/email/push) |
| EventBridge vs SQS | EventBridge = rules-based content routing + filtering; SQS = point-to-point work handoff |
| WebSocket handshake | HTTP `Upgrade` → `101 Switching Protocols` → full-duplex frames on same TCP conn |
| WS vs SSE vs long poll | WS bidirectional; SSE server→client + auto-reconnect; long poll = fallback |
| WS scaling | Stateful per-node connections → need pub/sub backplane + sticky LBs; heartbeats reap dead sockets |
| WS + Kafka together | Kafka = durable event backbone; WebSocket gateway = last-mile push to clients |
| Exactly-once myth | True exactly-once *delivery* unattainable; use at-least-once + idempotency = exactly-once *effect* |
| Duplicate causes | Network failures (lost acks) + retries; fix with dedup table / idempotency key / idempotent ops |
| Outbox pattern | Write event to outbox in the same DB transaction; relay/CDC publishes at-least-once |
| Backpressure by transport | REST 429/backoff; gRPC HTTP/2 flow control; Kafka lag grows; WS bound the send buffer |
| Contract evolution | Additive-only, stable identity (field number/schema id); old readers ignore unknown fields |
| Circuit breaker | 5 fails → OPEN (fail fast 30s) → HALF-OPEN probe → CLOSED; retry with full jitter |
| Cross-boundary tracing | Propagate `traceparent`/correlation id via HTTP headers, Kafka headers, gRPC metadata |
| Which tech (one-liners) | Public CRUD→REST; internal low-latency→gRPC; flexible fetch→GraphQL; routed tasks→RabbitMQ; high-throughput events→Kafka; fan-out→SNS/SQS; real-time chat→WebSocket |
