# Communication & Messaging Protocols — Mermaid Diagrams

> Interview-ready diagrams. Start with Diagram 1 — the sync-vs-async decision tree decides everything downstream. Then drill into the specific protocol the interviewer probes.
>
> Reference: [answers.md](./answers.md) | [conducive-sentences.md](./conducive-sentences.md)
>
> Cross-links: [api-design](../api-design/) · [message-queues](../message-queues/) · [chat-system](../chat-system/) · [sse](../sse/)

---

## Diagram 1 — The Sync-vs-Async Decision Tree (Start Here)

> **When to use:** The very first thing to draw when asked "which protocol would you pick?" Everything else hangs off the answer to one question: *does the caller need the answer now?* Use it for Q4 ("walk through your decision tree") and Q44.

```mermaid
flowchart TD
    Start([New service-to-service\nintegration]) --> Q1{Caller needs the\nresult right now\nto continue?}

    Q1 -->|Yes — blocking,\nrequest/response| Sync[SYNCHRONOUS\nCaller waits · tight coupling\nBuilt on HTTP/HTTPS]
    Q1 -->|No — fire and forget,\ntolerate delay| Async[ASYNCHRONOUS\nBroker stores message\nuntil consumer is ready]

    Sync --> Q2{Who is the\nconsumer?}
    Q2 -->|External / public client\nbrowser · 3rd party| REST[REST\nJSON over HTTP/1.1 or 2\nCacheable · stateless · ubiquitous]
    Q2 -->|Internal microservice\nlow latency · typed| GRPC[gRPC\nProtobuf over HTTP/2\nBinary · streaming · contract-first]
    Q2 -->|Frontend picks its\nown shape of data| GQL[GraphQL\nOne round-trip · no over-fetch\nSchema as contract]

    Async --> Q3{One consumer\nor many?\nReplay needed?}
    Q3 -->|Work distribution\n1 job → 1 worker · routing| MQ[Message Queue\nAMQP / RabbitMQ · SQS\nConsume-and-delete · DLQ]
    Q3 -->|Many consumers · replay\nordered log · high throughput| STREAM[Event Stream\nKafka · Kinesis\nRetained log · offsets · event sourcing]
    Q3 -->|Fan-out one event\nto many subscribers| PUBSUB[Pub/Sub\nSNS · EventBridge\nTopic → many subscribers]

    style Sync fill:#dbeafe,stroke:#1d4ed8
    style Async fill:#fef9c3,stroke:#ca8a04
    style REST fill:#dcfce7,stroke:#16a34a
    style GRPC fill:#dcfce7,stroke:#16a34a
    style GQL fill:#dcfce7,stroke:#16a34a
    style MQ fill:#fed7aa,stroke:#ea580c
    style STREAM fill:#fed7aa,stroke:#ea580c
    style PUBSUB fill:#fed7aa,stroke:#ea580c
```

**What the interviewer is checking:**
- You lead with the *coupling* question (does the caller block?), not with a favourite technology.
- Sync = sender and receiver both active, caller waits → REST / gRPC / GraphQL. Async = broker buffers the message, no prompt response expected → queue / stream / pub-sub.
- You can justify the leaf you land on: public CRUD → REST; internal low-latency typed → gRPC; flexible frontend fetch → GraphQL; routed task queue → AMQP/SQS; replayable high-throughput → Kafka; fan-out → SNS/EventBridge.
- Bonus credit: "async is not *always* better" — sync request/response stays correct when the caller genuinely cannot proceed without the result (Q3).

---

## Diagram 2 — Anatomy of a URI + HTTP Request/Response

> **When to use:** Q5 ("break down a URI"), Q7 (path vs query params). Draw the URI as labelled segments, then the request and response envelopes side by side.

```mermaid
flowchart TD
    subgraph URI["URI — identifies the resource"]
        direction LR
        U1[scheme\nhttps] --> U2[host\napi.example.com] --> U3[path\n/v1/products/123] --> U4[query string\n?category=books&sort=price]
    end

    subgraph REQ["HTTP Request"]
        R1["Request line\nGET /v1/products/123?... HTTP/2"]
        R2["Headers\nHost · Accept · Authorization\nContent-Type · Cache-Control · Cookie"]
        R3["Body / Payload\nonly on POST · PUT · PATCH\nNOT part of the URI"]
        R1 --> R2 --> R3
    end

    subgraph RES["HTTP Response"]
        S1["Status line\nHTTP/2 200 OK"]
        S2["Headers\nContent-Type · Content-Length\nETag · Cache-Control · Set-Cookie · Location"]
        S3["Body\nrepresentation: JSON / XML"]
        S1 --> S2 --> S3
    end

    URI --> REQ --> RES

    style URI fill:#e0e7ff,stroke:#4338ca
    style REQ fill:#dbeafe,stroke:#1d4ed8
    style RES fill:#dcfce7,stroke:#16a34a
```

**What the interviewer is checking:**
- Scheme / host / path / query string each named correctly — path *identifies* the resource (`/products/123`), query string *filters or modifies* it (`?category=books`).
- The body/payload travels in `POST`/`PUT`/`PATCH` and is **not** part of the URI — that is why `GET` and `DELETE` carry their parameters in the path/query, not a body.
- Rule of thumb you can state: path params for "which resource," query params for "how to filter/sort/paginate the collection."
- You know which headers matter for caching (`ETag`, `Cache-Control`), auth (`Authorization`), and content negotiation (`Accept`, `Content-Type`).

---

## Diagram 3 — HTTP/1.1 vs HTTP/2 Multiplexing vs HTTP/3 QUIC

> **When to use:** Q8 and Q9 — the head-of-line-blocking story. Show that HTTP/2 fixes *application*-layer HOL blocking but TCP still has it, and HTTP/3 moves transport to QUIC over UDP to kill it.

```mermaid
flowchart TD
    subgraph H1["HTTP/1.1 — one request at a time per connection"]
        A1["Request 1 ──► wait full response"] --> A2["Request 2 ──► wait"] --> A3["Request 3 ──► wait"]
        A0["HOL blocking at the APPLICATION layer\nslow Req 1 stalls Req 2 and 3\nworkaround: 6 parallel TCP connections"]
    end

    subgraph H2["HTTP/2 — multiplexed streams over ONE TCP connection"]
        B1["Stream 1\ninterleaved"]
        B2["Stream 2\ninterleaved"]
        B3["Stream 3\ninterleaved"]
        B0["Binary framing · header compression (HPACK)\nstream prioritization · server push\n⚠️ One TCP connection → a single lost\npacket stalls ALL streams\n= HOL blocking at the TCP layer"]
        B1 -.-> B0
        B2 -.-> B0
        B3 -.-> B0
    end

    subgraph H3["HTTP/3 — QUIC over UDP"]
        C1["Stream 1\nindependent"]
        C2["Stream 2\nindependent"]
        C3["Stream 3\nindependent"]
        C0["QUIC = independent streams in user space\nLost packet only stalls ITS stream\n✅ No transport-layer HOL blocking\n+ 0-RTT resume · connection migration · TLS 1.3 built in"]
        C1 -.-> C0
        C2 -.-> C0
        C3 -.-> C0
    end

    H1 --> H2 --> H3

    style H1 fill:#fee2e2,stroke:#dc2626
    style H2 fill:#fef9c3,stroke:#ca8a04
    style H3 fill:#dcfce7,stroke:#16a34a
```

**What the interviewer is checking:**
- HTTP/2 wins: binary protocol (not text), multiplexing many requests over one connection, header compression, stream prioritization, server push.
- The precise gotcha: HTTP/2 removes *application*-layer HOL blocking but, because all streams share one TCP connection, a single dropped packet stalls every stream — TCP-layer HOL blocking remains.
- HTTP/3 sits on **QUIC over UDP**: streams are independent at the transport layer, so packet loss on one stream doesn't block the others. Bonus: 0-RTT reconnect and connection migration across network changes.
- gRPC's reliance on HTTP/2 (Diagram 5) is the reason this layering matters for internal APIs too.

---

## Diagram 4 — REST Conditional GET with ETag (304 Path)

> **When to use:** Q11 — walk a conditional GET. Show the first full response carrying the `ETag`, then the revalidation returning `304 Not Modified` with no body.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server / Origin

    Note over C,S: First request — cache is empty
    C->>S: GET /products/123
    S-->>C: 200 OK<br/>Cache-Control: max-age=3600<br/>ETag: "abc123"<br/>(full JSON body)
    Note over C: Cache the body + the ETag "abc123"

    Note over C,S: Within max-age — serve from cache, no network call

    Note over C,S: After max-age expires — revalidate, don't refetch blindly
    C->>S: GET /products/123<br/>If-None-Match: "abc123"
    alt Resource unchanged
        S-->>C: 304 Not Modified<br/>(NO body — saves bandwidth)
        Note over C: Reuse cached copy, refresh freshness window
    else Resource changed
        S-->>C: 200 OK<br/>ETag: "def456"<br/>(new full body)
        Note over C: Replace cached body + ETag
    end
```

**What the interviewer is checking:**
- You separate the three caching headers: `Cache-Control`/`Expires` control *freshness* (when to even ask), `ETag` enables *validation* (ask cheaply once stale).
- The conditional request uses `If-None-Match: "<etag>"`; a match returns **304 with no body** — the bandwidth win is the whole point.
- This is what "REST is cacheable" actually means at the wire level, and it depends on REST being stateless (Q10) — any node can validate because the client carries the validator.
- Deeper dive lives in [api-design](../api-design/).

---

## Diagram 5 — gRPC Four Streaming Modes

> **When to use:** Q16 — name the four modes with a real use case each. One compact sequence diagram showing the message direction in each mode.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: 1. UNARY — 1 request → 1 response
    C->>S: request
    S-->>C: response
    Note over C,S: e.g. GetUser(id) — standard RPC

    Note over C,S: 2. SERVER STREAMING — 1 request → N responses
    C->>S: request (subscribe)
    S-->>C: response 1
    S-->>C: response 2
    S-->>C: response N
    Note over C,S: e.g. stream price ticks / large result set

    Note over C,S: 3. CLIENT STREAMING — N requests → 1 response
    C->>S: chunk 1
    C->>S: chunk 2
    C->>S: chunk N
    S-->>C: single response
    Note over C,S: e.g. upload a large file in chunks

    Note over C,S: 4. BIDIRECTIONAL — independent streams both ways
    C->>S: msg A
    S-->>C: msg B
    C->>S: msg C
    S-->>C: msg D
    Note over C,S: e.g. real-time chat / live video
```

**What the interviewer is checking:**
- All four named with directionality correct: unary (1↔1), server-streaming (1→N), client-streaming (N→1), bidirectional (N↔N, independent).
- A concrete use case per mode — file upload = client streaming, live feed = server streaming, chat = bidirectional.
- *Why HTTP/2 specifically:* gRPC needs HTTP/2's multiplexed binary streams to carry these long-lived bidirectional flows over one connection (ties to Diagram 3 and Q15).
- Payloads are Protocol Buffers — compact binary, contract defined in a `.proto` file, with field numbers that are sacred (Q17).

---

## Diagram 6 — GraphQL Single Round-Trip vs REST + N+1 → DataLoader

> **When to use:** Q20 (over/under-fetching, round-trips) and Q22 (N+1 + DataLoader). Two contrasts in one figure: REST's many trips vs GraphQL's one, and the N+1 resolver trap with its batching fix.

```mermaid
flowchart TD
    subgraph REST["REST — multiple round-trips, over/under-fetch"]
        direction TB
        RC[Client] -->|GET /user/1| RS1[users]
        RC -->|GET /user/1/posts| RS2[posts]
        RC -->|GET /user/1/followers| RS3[followers]
        RNOTE["3 sequential trips\neach returns the WHOLE object\n→ over-fetch fields you ignore\n→ under-fetch forces more calls"]
    end

    subgraph GQL["GraphQL — one round-trip, exact shape"]
        direction TB
        GC[Client] -->|"one query:\nuser { name posts{title} followers{name} }"| GS[GraphQL server]
        GS --> GR["Resolvers fetch each field\nclient gets exactly the fields asked for"]
    end

    subgraph NPLUS["The N+1 problem inside the resolver"]
        direction TB
        N1["Query: posts { author { name } }"]
        N1 --> N2["1 query → list of N posts"]
        N2 --> N3["then 1 author query PER post\n= N more queries\n= N+1 total ❌"]
        N3 --> DL["DataLoader\ncollect all author IDs in one tick\nbatch into ONE query: WHERE id IN (...)\n+ per-request cache → N+1 becomes 2 ✅"]
    end

    REST --> GQL --> NPLUS

    style REST fill:#fee2e2,stroke:#dc2626
    style GQL fill:#dcfce7,stroke:#16a34a
    style DL fill:#dcfce7,stroke:#16a34a
    style N3 fill:#fee2e2,stroke:#dc2626
```

**What the interviewer is checking:**
- GraphQL collapses REST's multiple round-trips into one request and lets the client pick fields — killing over-fetching and under-fetching.
- The honest trade-off: GraphQL moves the cost server-side. A flexible query can fan out into the N+1 problem — one query for the list, then one per item.
- DataLoader fixes N+1 by *batching* the per-item lookups within a tick (`WHERE id IN (...)`) and caching per request, turning N+1 into 2 queries.
- Mention the new problems GraphQL introduces: caching is harder (no per-URL cache), query cost/complexity must be bounded. Deeper: [api-design](../api-design/).

---

## Diagram 7 — AMQP / RabbitMQ Routing (Exchange → Binding → Queue)

> **When to use:** Q24 (trace publisher → exchange → binding → queue → consumer) and Q25 (the four exchange types). Show that the publisher never names a queue — the exchange + bindings decide routing.

```mermaid
flowchart LR
    P[Publisher\nsets routing key\non each message] --> X{Exchange\nbroker-owned router}

    X -->|Direct\nexact key match\nkey=orders.eu → Q1| Q1[(Queue: EU orders)]
    X -->|Topic\npattern match · wildcards\norders.* → Q2| Q2[(Queue: all orders)]
    X -->|Fanout\nignores key → ALL queues| Q3[(Queue: audit log)]
    X -->|Headers\nmatch header attrs\nall/any → Q4| Q4[(Queue: by header)]

    Q1 --> C1[Consumer A]
    Q2 --> C2[Consumer B]
    Q3 --> C3[Consumer C]
    Q4 --> C4[Consumer D]

    BIND["Bindings connect exchange→queue\nbinding key + pattern\nset by the QUEUE, not the publisher"]
    X -.->|defined by| BIND

    style X fill:#fef9c3,stroke:#ca8a04
    style BIND fill:#e0e7ff,stroke:#4338ca
```

**What the interviewer is checking:**
- Correct path: publisher → exchange → binding → queue → consumer. The publisher publishes to an *exchange* with a *routing key*; it does not pick the queue.
- The **broker** owns the exchanges, queues, and the bindings between them, and does the routing — that decoupling is the point of AMQP.
- Routing key (set by the *publisher*, per message) vs binding key (set by the *queue's binding*) — Q26 hinges on getting this direction right.
- The four exchange types with a scenario each: direct = exact match, topic = wildcard patterns, fanout = broadcast to all, headers = match on header attributes. See [message-queues](../message-queues/) for quorum queues vs streams (Q28).

---

## Diagram 8 — Kafka Topic → Partitions → Consumer Group + Offsets

> **When to use:** Q29 (topics/partitions/consumer groups/offsets) and Q30 (rebalance, why more consumers than partitions wastes resources). The key visual: each partition is assigned to exactly one consumer in a group.

```mermaid
flowchart TD
    PROD[Producers\npartition by key →\nsame key always same partition\n= ordering within a key] --> TOPIC

    subgraph TOPIC["Topic: orders (retained, replayable log)"]
        P0["Partition 0\noffsets 0,1,2,3..."]
        P1["Partition 1\noffsets 0,1,2,3..."]
        P2["Partition 2\noffsets 0,1,2,3..."]
    end

    subgraph CG["Consumer Group A (load-balanced)"]
        C0[Consumer 0]
        C1[Consumer 1]
        C2[Consumer 2]
        C3["Consumer 3\n💤 IDLE — no partition left\n(consumers > partitions = waste)"]
    end

    P0 -->|assigned to| C0
    P1 -->|assigned to| C1
    P2 -->|assigned to| C2

    OFF["Each consumer commits its OFFSET\n= last record processed per partition\nrestart / rebalance resumes from there\nlog is NOT deleted on read → replayable"]
    CG -.-> OFF

    OTHER["Consumer Group B reads the SAME topic\nindependently with its OWN offsets\n(pub/sub: many groups, one log)"]
    TOPIC -.-> OTHER

    style TOPIC fill:#fed7aa,stroke:#ea580c
    style C3 fill:#fee2e2,stroke:#dc2626
    style OFF fill:#dcfce7,stroke:#16a34a
```

**What the interviewer is checking:**
- The core invariant: within a consumer group, **one partition → exactly one consumer**. That gives parallelism *across* partitions and ordering *within* a partition simultaneously.
- Why more consumers than partitions is wasteful — extras sit idle; partition count is the parallelism ceiling.
- Offsets are committed per consumer per partition; the log is retained (consume does not delete), which is what makes Kafka *replayable* and a fit for event sourcing (Q31, Q32).
- A rebalance reassigns partitions when consumers join/leave — briefly pausing consumption. Different consumer *groups* read the same topic independently (pub/sub). Deeper: [message-queues](../message-queues/).

---

## Diagram 9 — AWS SNS → SQS Fan-out (with DLQ)

> **When to use:** Q36 (why combine SNS + SQS instead of either alone) and Q35 (DLQ). One SNS topic publishes once; each subscribed SQS queue gets its own durable copy for an independent consumer.

```mermaid
flowchart TD
    PUB[Publisher\ne.g. OrderPlaced event] --> SNS{{SNS Topic\npub/sub · publish ONCE}}

    SNS -->|subscription + filter policy| SQS1[(SQS Queue\nInventory)]
    SNS -->|subscription| SQS2[(SQS Queue\nBilling)]
    SNS -->|subscription| SQS3[(SQS Queue\nAnalytics)]

    SQS1 --> W1[Inventory workers\nown retry · own pace]
    SQS2 --> W2[Billing workers]
    SQS3 --> W3[Analytics workers]

    W1 -.->|exceeds maxReceiveCount\nafter N failed receives| DLQ[(Dead-Letter Queue)]
    W2 -.->|poison message| DLQ

    DLQ --> INSPECT["Inspect · alert · fix · redrive\nDLQ depth is a monitored metric"]

    style SNS fill:#fef9c3,stroke:#ca8a04
    style DLQ fill:#fee2e2,stroke:#dc2626
    style INSPECT fill:#e0e7ff,stroke:#4338ca
```

**What the interviewer is checking:**
- SNS alone is fire-and-forget pub/sub (no buffering for slow/offline consumers); SQS alone is point-to-point (one logical consumer). Combining them gives durable fan-out: publish once, each queue buffers its own copy, each consumer retries and scales independently.
- Filter policies on subscriptions let each queue receive only the events it cares about.
- A message lands in the DLQ after exceeding `maxReceiveCount` (repeated failed receives) — a poison message. The DLQ is for inspect / alert / fix / redrive, not a graveyard.
- Bonus: SNS FIFO + SQS FIFO pairs for ordered, deduplicated fan-out (Q37); EventBridge if you need rules-based routing instead of a queue (Q38).

---

## Diagram 10 — WebSocket Lifecycle (Upgrade → Frames → Close)

> **When to use:** Q39 — walk the lifecycle and explain full-duplex. Show the HTTP upgrade handshake, then the long-lived bidirectional frame exchange, then the close.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: 1. Handshake — upgrade an ordinary HTTP request
    C->>S: GET /ws HTTP/1.1<br/>Upgrade: websocket<br/>Connection: Upgrade<br/>Sec-WebSocket-Key: ...
    S-->>C: HTTP 101 Switching Protocols<br/>Sec-WebSocket-Accept: ...
    Note over C,S: TCP connection now persists — no more HTTP semantics

    Note over C,S: 2. Data frames — full-duplex, either side sends anytime
    C->>S: frame (text/binary)
    S-->>C: frame (server push — unprompted)
    C->>S: frame
    S-->>C: frame
    Note over C,S: ping / pong frames keep the connection alive

    Note over C,S: 3. Close handshake
    C->>S: Close frame
    S-->>C: Close frame
    Note over C,S: Connection torn down
```

**What the interviewer is checking:**
- The lifecycle in order: HTTP handshake with `Upgrade: websocket` → server replies **101 Switching Protocols** → persistent TCP connection → bidirectional frames → close handshake.
- *Full-duplex* means either side can send at any time over the one connection — unlike HTTP request/response where the server only speaks when asked.
- It starts as HTTP (so it traverses proxies/firewalls on 80/443) but then sheds HTTP semantics; the connection is *stateful*, which limits horizontal scalability vs stateless REST.
- Auth happens on the handshake (the upgrade request carries the token/cookie). Deeper real-time design: [chat-system](../chat-system/).

---

## Diagram 11 — WebSocket vs SSE vs Long Polling vs Short Polling

> **When to use:** Q40 — compare the server-to-client push options and say when each wins. A timeline-style contrast of the four transports.

```mermaid
flowchart TD
    subgraph SHORT["Short Polling — client asks on a fixed interval"]
        SH["Client: GET every Ns → mostly empty responses\n↑ simple · ↓ wasteful · ↓ latency = poll interval\nUse: low-freq updates, trivial setup"]
    end

    subgraph LONG["Long Polling — server holds the request open"]
        LO["Client: GET → server holds until data or timeout → reply → re-poll\n↑ near-real-time on plain HTTP · ↓ connection churn\nUse: real-time-ish, no WS support"]
    end

    subgraph SSE["SSE — one-way server→client stream over HTTP"]
        SS["Client opens EventSource → server streams events on one connection\n↑ simple · auto-reconnect · text only · ONE direction\nUse: live feeds, notifications, dashboards"]
    end

    subgraph WS["WebSocket — full-duplex persistent connection"]
        W["Both sides send anytime over one TCP connection\n↑ true bidirectional · low latency · ↓ stateful, harder to scale\nUse: chat, gaming, collaborative editing"]
    end

    SHORT --> LONG --> SSE --> WS

    style SHORT fill:#fee2e2,stroke:#dc2626
    style LONG fill:#fef9c3,stroke:#ca8a04
    style SSE fill:#dbeafe,stroke:#1d4ed8
    style WS fill:#dcfce7,stroke:#16a34a
```

**What the interviewer is checking:**
- The axis that matters: **direction** (one-way vs bidirectional) and **persistence** (poll vs held-open vs streamed vs full-duplex).
- SSE is the underused right answer for *server → client only* push (notifications, live feeds): simpler than WebSocket, runs over plain HTTP, auto-reconnects. Reach for WebSocket only when the client must also push frequently (chat, gaming).
- Long polling is the fallback when neither SSE nor WS is available; short polling is the wasteful baseline (latency bounded by the interval).
- Deeper: [sse](../sse/) and [chat-system](../chat-system/).

---

## Diagram 12 — End-to-End: REST → Kafka → gRPC with a Trace ID

> **When to use:** QB4 (observability) and Q41 (WebSocket + Kafka, REST + Kafka together). Show one user action crossing a sync edge, an async hop, and an internal RPC — with a correlation/trace ID propagating the whole way.

```mermaid
sequenceDiagram
    participant U as User
    participant GW as API Gateway (REST)
    participant SVC as Order Service
    participant K as Kafka (topic: orders)
    participant WK as Fulfilment Worker
    participant INV as Inventory Service (gRPC)

    U->>GW: POST /orders (HTTPS)
    Note over GW: Generate trace_id = T1\n(or accept inbound one)
    GW->>SVC: forward + header traceparent: T1
    SVC->>K: produce OrderPlaced<br/>headers: { trace_id: T1 }
    SVC-->>GW: 202 Accepted (returns fast)
    GW-->>U: 202 Accepted {order_id}

    Note over K,WK: async boundary — decoupled in time
    K->>WK: consume OrderPlaced (trace_id: T1 in headers)
    WK->>INV: gRPC ReserveStock(...)<br/>metadata: trace_id = T1
    INV-->>WK: OK
    Note over U,INV: ONE trace_id T1 stitches REST → Kafka → gRPC\ninto a single distributed trace
```

**What the interviewer is checking:**
- A trace/correlation ID (e.g. W3C `traceparent`) is generated at the edge and **propagated across every boundary** — HTTP headers on REST/gRPC, message headers on Kafka records.
- The sync edge returns `202 Accepted` immediately; the work continues asynchronously through Kafka — the caller is decoupled from fulfilment latency (the Diagram 1 sync/async split in action).
- The async hop is where naive tracing breaks: you must copy the ID into the Kafka message headers so the consumer can continue the same trace.
- This is the production-grade story tying every protocol in this guide together: pick the right transport per edge, and carry context across all of them. Related: [message-queues](../message-queues/), [chat-system](../chat-system/).

---

## Quick Interview Reference

### One-line "which technology" (Q44)

| Need | Pick | Why |
|---|---|---|
| Public CRUD API | REST | Cacheable, stateless, universal |
| Low-latency internal call | gRPC | Binary Protobuf over HTTP/2, typed contract |
| Flexible mobile data fetch | GraphQL | One round-trip, client picks fields |
| Task queue with routing | AMQP / RabbitMQ (or SQS) | Exchanges + bindings, DLQ, consume-and-delete |
| High-throughput event streaming | Kafka | Retained replayable log, partitions, offsets |
| Fan-out notifications | SNS → SQS (or EventBridge) | Publish once, durable per-subscriber copies |
| Real-time chat | WebSocket | Full-duplex persistent connection |
| Server→client push only | SSE | Simpler one-way stream over HTTP |

### The reliability spine (Level 10)

- **Exactly-once is effectively impossible across a network** → use *at-least-once delivery + idempotent consumers* (Q42).
- Duplicates come from **network loss + retries**; defend with idempotent operations, dedup on message ID, and exactly-once-style patterns (Q43).
- **Contract evolution** shares one principle across REST versioning, gRPC protobuf field numbers, and a Kafka Schema Registry: never break existing readers — add, don't reuse/remove (QB2).
- **The Kafka trap (QB5):** Kafka is the wrong tool for request/response, low-volume task routing, or when you need per-message ack/DLQ semantics — you lose simplicity and pay operational cost.
