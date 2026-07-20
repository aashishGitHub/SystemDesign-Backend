# Glossary: Communication & Messaging Protocols

> Definitions for niche terms that appear in [deep-dive.md](./deep-dive.md) without enough surrounding context.
> Every entry links back to the chapter where the term is used.

---

## Table of Contents

| Term | Used in chapter |
|------|----------------|
| [Vary Header](#vary-header) | 3 — REST |
| [stale-while-revalidate](#stale-while-revalidate) | 3 — REST |
| [stale-if-error](#stale-if-error) | 3 — REST |
| [Jitter / Jittered TTLs](#jitter-and-jittered-ttls) | 3 — REST, 9 — WebSockets |
| [Alt-Svc](#alt-svc) | 2 — HTTP |
| [103 Early Hints](#103-early-hints) | 2 — HTTP |
| [0-RTT and 1-RTT](#0-rtt-and-1-rtt) | 2 — HTTP |
| [HPACK and QPACK](#hpack-and-qpack) | 2 — HTTP |
| [mTLS](#mtls) | 4 — gRPC, 10 — Reliability |
| [RabbitMQ Prefetch / basic_qos](#rabbitmq-prefetch-and-basic_qos) | 6 — AMQP & RabbitMQ |
| [Dead-Letter Exchange (DLX)](#dead-letter-exchange-dlx) | 6 — AMQP & RabbitMQ |
| [KRaft](#kraft) | 7 — Kafka |
| [KSQL / ksqlDB](#ksql-and-ksqldb) | 7 — Kafka |
| [Debezium / CDC](#debezium-and-cdc) | 10 — Reliability |
| [Avro](#avro) | 10 — Reliability |
| [W3C traceparent](#w3c-traceparent) | 10 — Reliability |

---

## Vary Header

**Where it appears in deep-dive.md:** Chapter 3 🔴 — cache poisoning failure mode.

```http
HTTP/1.1 200 OK
Cache-Control: public, max-age=3600
Vary: Authorization, Accept-Encoding
```

`Vary` is an HTTP **response header** that tells every cache (CDN, reverse proxy, browser) to store **separate cached copies** for each distinct value of the listed request headers.

**The critical rule:** if your response body changes based on a request header, that header *must* appear in `Vary`, or a cache will serve the same body to all requesters.

**The failure mode the deep-dive describes:** `GET /account` returns user-specific data. The server sends back `Cache-Control: public, max-age=3600` *without* `Vary: Authorization`. A CDN caches the first response. The second user (with a different `Authorization` token) hits the CDN — the CDN sees the same URL, ignores the different token (it wasn't listed in `Vary`), and serves user A's data to user B.

**The fix:** either add `Vary: Authorization` (CDN now keys the cache entry per token — effectively per-user caching, which is usually too granular for a CDN and wastes cache space), or better: drop `public` entirely and use `Cache-Control: private, max-age=3600` so the response is only cached in the user's browser (not in shared CDN nodes).

**Common `Vary` values:**

| Value | When to use |
|-------|-------------|
| `Accept-Encoding` | Response body differs by compression (`gzip`/`br`/none) — almost always correct |
| `Accept-Language` | Localised content differs by locale |
| `Authorization` | Avoid on shared CDN caches — see above; use `private` instead |
| `Origin` | For CORS preflight caching |

---

## stale-while-revalidate

**Where it appears in deep-dive.md:** Chapter 3 🔴 — thundering-herd-on-expiry failure mode.

```http
Cache-Control: max-age=60, stale-while-revalidate=30
```

Normally, once a cached entry's `max-age` expires the next request blocks — waiting for a fresh response before it can serve anything. If thousands of clients all hit expiry at the same moment, they all hammer the origin simultaneously: the **thundering herd**.

`stale-while-revalidate=N` adds a grace window. During the extra `N` seconds after `max-age` expires, the cache serves the *stale* (expired) copy **immediately** to the requester — zero added latency — and triggers a **background revalidation** to the origin. The origin doesn't see a thundering spike; it sees one quiet background fetch.

**Example timeline:**
```
t=0   First request → cache stores response (max-age=60)
t=60  max-age expires. Next request → serve stale (instant), background fetch starts.
t=61  Background fetch completes → cache now holds fresh copy.
t=91  stale-while-revalidate window also expires. Next miss is synchronous again.
```

**When to use it:** catalog pages, product listings, search results — anything where being 60–90 seconds stale is acceptable but blocking is not. Do NOT use it for data where showing stale values is harmful (account balances, inventory levels, auth decisions).

**Related:** `stale-if-error` (see below) is the error-resilience companion.

---

## stale-if-error

**Where it appears in deep-dive.md:** not explicit, but closely related to `stale-while-revalidate` in the same cache-failure context.

```http
Cache-Control: max-age=60, stale-if-error=86400
```

Normally, if the origin returns an error (5xx, timeout, TCP failure) during revalidation, the cache propagates the error to the client. `stale-if-error=N` says: if the origin errors, serve the stale cached copy for up to `N` more seconds instead of surfacing the error.

**Why it matters for system design:** it's a cheap **circuit-breaker at the CDN layer**. A brief origin outage is invisible to end users because the CDN absorbs it by serving a slightly stale page rather than a 500. The cost is data freshness; the benefit is user experience continuity.

**Use it on:** pages that are read-heavy, where showing yesterday's data is better than a 503. Do not use it for: real-time stock prices, authentication flows, or any response where stale = wrong.

---

## Jitter and Jittered TTLs

**Where it appears in deep-dive.md:** Chapter 3 🔴 (thundering herd) and Chapter 9 🔴 (reconnect storm).

**The problem:** if every cached object expires at the exact same second (because you set `max-age=3600` for everything that was cached in the same deploy), you get a thundering herd — all clients revalidate simultaneously, flooding the origin.

**The fix — jitter:** add a random offset to the TTL at the time the object is cached, so expirations spread out over a window rather than firing at one instant.

```python
import random

BASE_TTL = 3600        # 1 hour base
JITTER    = 600        # ± up to 10 minutes

ttl = BASE_TTL + random.randint(-JITTER, JITTER)
cache.set(key, value, ttl=ttl)
# Different keys expire at 3000s, 3421s, 3987s... spread over a 20-min window
```

**The retry-jitter variant** (mentioned in the deep-dive circuit breaker section) applies the same idea to exponential backoff: instead of all workers sleeping exactly `2^attempt` seconds, each sleeps a *random fraction* of that maximum, so retries scatter across the window instead of spiking together:

```
delay = random() * min(cap, base * 2^attempt)   # "full jitter"
```

**Real effect:** with 1,000 clients all at `attempt=3` (max delay 8s), full jitter scatters retries uniformly across 0–8s → 125 retries/second sustained. Without jitter, all 1,000 hit at second 8 → a 1,000 req/s spike.

---

## Alt-Svc

**Where it appears in deep-dive.md:** Chapter 2 🔴 — advertising HTTP/3 availability.

```http
HTTP/1.1 200 OK
Alt-Svc: h3=":443"; ma=86400
```

`Alt-Svc` (Alternative Services) is an HTTP response header that **advertises that the same resource is also available over a different protocol or endpoint**. It lets a server say "I'm currently replying over HTTP/2-over-TCP, but I also speak HTTP/3-over-QUIC on port 443; cache that fact for up to 86,400 seconds."

**How HTTP/3 rollout works in practice:**
1. Server responds over HTTP/1.1 or HTTP/2 with `Alt-Svc: h3=":443"`.
2. Client notes the hint and, on the *next* request (or after 0-RTT setup), attempts QUIC on port 443.
3. If QUIC succeeds, the client switches. If UDP/443 is blocked by a firewall, the client falls back to TCP silently.

**Why it's safe:** `Alt-Svc` is advisory, not mandatory. The existing TCP+TLS path always works as a fallback; HTTP/3 is opt-in per-client. This is why rolling out HTTP/3 is low-risk — you're never forcing anyone onto a path that might break.

---

## 103 Early Hints

**Where it appears in deep-dive.md:** Chapter 2 🔴 — deprecated HTTP/2 Server Push replacement.

HTTP `103 Early Hints` is a **provisional response status code** the server can send *before* the final `200 OK` response, while it's still processing the request. The `103` carries `Link` headers that hint to the browser which resources (JS, CSS, fonts) it should start fetching immediately — without waiting for the full HTML.

```http
HTTP/1.1 103 Early Hints
Link: </styles.css>; rel=preload; as=style
Link: </app.js>; rel=preload; as=script

HTTP/1.1 200 OK
Content-Type: text/html
...
```

**Why it replaces Server Push:** HTTP/2 Server Push let the server speculatively *send* resources to the client before the client asked for them — but this was often wasteful (pushing things already in the browser cache, no way for the client to cancel mid-push). `103 Early Hints` only sends a *hint* (a header saying "start fetching this"), leaving the actual fetch decision to the browser. The browser uses its cache intelligently, only fetches what it doesn't already have, and does so in parallel with downloading the HTML body.

**Practical upshot:** `103 Early Hints` gives most of the latency benefit of Server Push (parallel resource loading) without the waste, and is supported by major CDNs (Cloudflare, Fastly) and browsers. When you see "Server Push is deprecated," `103 Early Hints` is the recommended alternative.

---

## 0-RTT and 1-RTT

**Where it appears in deep-dive.md:** Chapter 2 🟡 (table) and 🔴 (QUIC explanation).

Round-trips (RTTs) are full request/response cycles between client and server — each one adds the network latency. QUIC (the transport under HTTP/3) reduces the number of RTTs needed to establish a secure connection compared to TLS-over-TCP.

**TLS 1.3 over TCP baseline (minimum 1-RTT after TCP):**
```
Client → Server:  TCP SYN
Client ← Server:  TCP SYN-ACK
Client → Server:  TCP ACK  +  TLS ClientHello       ← 1 network RTT just to open TCP
Client ← Server:  TLS ServerHello + certificate
Client → Server:  TLS Finished                       ← another RTT for TLS
                  → first HTTP request              ← data starts flowing (2 RTTs total from cold)
```

**QUIC 1-RTT (new connection):** QUIC combines the transport and TLS handshakes into a single message exchange. No separate TCP handshake.
```
Client → Server:  QUIC Initial + TLS ClientHello
Client ← Server:  QUIC Handshake + TLS ServerHello + certificate
Client → Server:  TLS Finished  +  first HTTP request (data piggybacked on Finished)
                  → 1 RTT from cold start
```

**QUIC 0-RTT (resumed connection):** if the client previously connected to this server and has a cached session ticket, it can send the first application data (the HTTP request) *in the very first packet* — zero additional RTTs before data starts flowing. The server can respond without waiting for a full handshake.

**The 0-RTT caveat:** 0-RTT data is not protected against **replay attacks** — an attacker who captures the first packet can re-send it. So 0-RTT is safe only for idempotent, non-sensitive reads (fetching a static asset), not for state-changing requests (payments, writes). TLS 1.3 and QUIC both support 0-RTT but limit which data can be sent in it.

---

## HPACK and QPACK

**Where it appears in deep-dive.md:** Chapter 2 🟡 (HTTP version comparison table).

HTTP headers are sent with every request and response. In HTTP/1.1 they are plaintext and often large (especially `Cookie`, `User-Agent`, `Authorization` can each be hundreds of bytes). On mobile or high-QPS APIs, repeatedly sending the same headers wastes bandwidth.

**HPACK (HTTP/2):** a stateful header compression scheme. Both client and server maintain a synchronized *header table* of previously-seen headers. Instead of re-sending `Authorization: Bearer eyJ...` on every request (500 bytes), they send a one-byte index: "use header table entry #23." This dramatically reduces header overhead on connections with many repeated requests.

**QPACK (HTTP/3):** HPACK was redesigned for QUIC because HPACK's stateful table depends on strict ordering — which breaks down if packets arrive out of order (which QUIC allows per-stream). QPACK solves this by making the encoder/decoder state updates explicit and order-independent, so it can still compress headers efficiently without needing streams to process in arrival order.

**Practical implication:** HPACK and QPACK are internal protocol mechanics; as an application developer you don't configure them. But you might reference them in an interview to show you understand *why* HTTP/2 and HTTP/3 reduce header overhead compared to HTTP/1.1.

---

## mTLS

**Where it appears in deep-dive.md:** Chapter 4 🔴 (gRPC security) and Chapter 10 🔴 (security per transport).

Standard **TLS** authenticates one direction: the *server* presents a certificate and the *client* verifies it (you trust `api.stripe.com` because it has a valid cert signed by a CA). The client remains anonymous to the server at the TLS layer.

**mTLS (mutual TLS)** makes the authentication bidirectional: **both** the client and the server present certificates, and both verify each other. The server checks: "is this client certificate signed by a CA I trust?" — before any application-level request is processed.

```
Client → Server:  "Here is my certificate (signed by our internal CA)"
Client ← Server:  "Here is my certificate. I verified yours. Connection established."
                  → all traffic is now encrypted AND both endpoints are authenticated
```

**Why it matters for microservices:** in a service mesh or internal gRPC network, you want to ensure that only your own services can call each other — not just any process that can reach port 9090. mTLS provides **service identity** at the transport layer, before any JWT or OAuth token is checked. Sidecar proxies (Envoy, Istio, Linkerd) automate certificate rotation so each service gets a short-lived cert, making this operationally practical at scale.

**Compared to JWT:** JWT (a token in the HTTP/gRPC header) authenticates the *logical identity* of a caller (user ID, service name in a claim). mTLS authenticates the *network endpoint* (this TLS connection comes from a process holding a cert signed by our CA). They're complementary layers, not alternatives.

---

## RabbitMQ Prefetch and basic_qos

**Where it appears in deep-dive.md:** Chapter 6 🔴 — fair dispatch / backpressure knob.

By default, RabbitMQ's push-based model sends messages to consumers as fast as they can accept them. A fast consumer might receive 5,000 messages from the broker and hold them all unacknowledged in memory — while a slow-starting consumer next to it gets nothing. This creates an unfair distribution and means a single slow message (one that keeps failing) can block dozens behind it in one consumer's in-flight buffer.

`basic_qos(prefetch_count=N)` sets a **per-consumer limit** on how many unacknowledged messages the broker will send before requiring at least one ack back.

```python
channel.basic_qos(prefetch_count=20)
# The broker will not deliver message 21 to this consumer
# until the consumer has acked at least one of the 20 it holds.
```

**Effect:**
- **Fair dispatch:** each consumer in a pool gets no more than `N` jobs in flight. Work is distributed evenly, not front-loaded onto the first responder.
- **Backpressure:** a slow consumer automatically slows the broker's delivery rate to it, without blocking other consumers.
- **Memory bound:** limits how much the consumer must buffer in memory before processing.

**How to size `prefetch_count`:** too low (e.g., 1) serializes delivery to each consumer and adds round-trip overhead for every message; too high negates the fairness benefit. A starting point of `prefetch_count = 20–50` is common for CPU-bound workers; increase it for I/O-bound workers that can safely hold many in flight.

---

## Dead-Letter Exchange (DLX)

**Where it appears in deep-dive.md:** Chapter 6 🔴 — poison message failure mode.

A **Dead-Letter Exchange (DLX)** is a regular AMQP exchange that a queue is configured to route *rejected* messages to, instead of re-enqueuing them or silently dropping them.

A message becomes a "dead letter" in RabbitMQ when:
1. It is **negatively acknowledged** (`basic.nack` or `basic.reject` with `requeue=false`).
2. It **expires** in the queue (its `message-ttl` or the queue's `x-message-ttl` elapsed).
3. The queue has a **length limit** (`x-max-length`) and the queue is full, so the oldest messages are dropped.

**Configuration:**
```python
channel.queue_declare(
    'orders',
    durable=True,
    arguments={
        'x-dead-letter-exchange': 'orders.dlx',   # route dead letters here
        'x-max-retries': 5,                        # library-level; not native AMQP
    }
)
channel.exchange_declare('orders.dlx', exchange_type='direct')
channel.queue_declare('orders.dead', durable=True)
channel.queue_bind('orders.dead', 'orders.dlx', routing_key='orders')
```

**DLX vs DLQ:** technically a DLX is the *exchange* that dead letters are published to; a DLQ (Dead-Letter Queue) is the *queue* bound to that exchange. In practice these terms are used interchangeably because you always use them together.

**Why it matters:** without a DLX, a poison message (malformed payload that always fails deserialization) gets redelivered endlessly, burning CPU and blocking legitimate work behind it in the queue. With a DLX, after `N` failed deliveries the message is routed to the dead-letter queue, alerting your on-call team while normal processing continues unblocked. The fix: inspect the DLQ, patch the consumer, and replay the dead letters.

**Compare with SQS DLQ:** SQS has the equivalent concept — `maxReceiveCount` in a redrive policy. Same idea, different API.

---

## KRaft

**Where it appears in deep-dive.md:** Chapter 7 🔴 — "ZooKeeper/KRaft-coordinated cluster."

For most of its history, Kafka relied on **Apache ZooKeeper** as a separate distributed coordination service: ZooKeeper stored the cluster metadata (which broker is the leader for each partition, which topics exist, consumer group offsets, etc.). Running Kafka meant running and operating *two* separate distributed systems.

**KRaft** (Kafka Raft) is Kafka's built-in **Raft-based consensus protocol** that eliminates the ZooKeeper dependency entirely. Starting from Kafka 2.8 (preview) and stabilised in Kafka 3.3+, KRaft stores all cluster metadata *inside* Kafka itself — a small set of brokers act as the metadata quorum using the Raft consensus algorithm.

**Why it matters for system design:**
- Operators no longer need to run/size/monitor a separate ZooKeeper ensemble alongside Kafka.
- KRaft scales to more partitions (millions vs the ~200K practical limit with ZooKeeper, due to ZooKeeper bottlenecks on metadata operations).
- Faster controller failover (the KRaft leader election is faster than ZooKeeper-based).

**When you'll hear it in an interview:** if you mention Kafka at scale, a staff-level interviewer may ask "are you running ZooKeeper or KRaft mode?" Answering "new deployments should be KRaft; ZooKeeper mode is legacy and being retired" shows operational currency.

---

## KSQL and ksqlDB

**Where it appears in deep-dive.md:** Chapter 7 🟡 (Kafka integration ecosystem table, "KSQL").

**ksqlDB** (originally KSQL) is a **streaming SQL engine** built on top of Kafka Streams that lets you write SQL-like queries over Kafka topics in real time — without writing Java or Scala code.

```sql
-- Create a stream from an existing Kafka topic
CREATE STREAM page_views (
  user_id VARCHAR,
  page    VARCHAR,
  ts      BIGINT
) WITH (KAFKA_TOPIC='page-views', VALUE_FORMAT='JSON');

-- Continuously aggregate: rolling 1-minute view count per page
CREATE TABLE view_counts AS
  SELECT page, COUNT(*) AS views
  FROM page_views
  WINDOW TUMBLING (SIZE 1 MINUTE)
  GROUP BY page;
-- Results are written to a new Kafka topic AND queryable as a materialised view.
```

**Key concepts:**
- **Stream:** an unbounded sequence of events from a Kafka topic (think: a table of facts, append-only).
- **Table:** a materialised view of a stream, representing the *current state* (latest value per key).
- **Push query:** runs continuously; emits results as new events arrive.
- **Pull query:** a point-in-time lookup against a materialised table (like a normal DB query).

**When to reach for it vs Kafka Streams:** ksqlDB is better for analysts or teams who prefer SQL and don't want to deploy a Java application. Kafka Streams (a library) is better for complex stateful logic, custom serializers, or embedding stream processing inside an existing JVM service.

---

## Debezium and CDC

**Where it appears in deep-dive.md:** Chapter 10 🟡 — the outbox pattern code comment.

**CDC (Change Data Capture)** is a pattern for *capturing every row-level change* (INSERT, UPDATE, DELETE) in a database by reading the database's **transaction log** (WAL in PostgreSQL, binlog in MySQL), rather than polling tables or using application-level triggers.

**Debezium** is an open-source CDC framework (backed by Red Hat) that connects to database transaction logs, converts each change event into a message, and publishes it to Kafka. It supports PostgreSQL, MySQL, MongoDB, SQL Server, and more.

**Why it matters for the outbox pattern:**

```
Application → writes to DB (order + outbox row in one transaction)
Debezium   → reads the DB WAL, detects the new outbox row
Debezium   → publishes the event to Kafka (at-least-once)
Consumer   → reads from Kafka, idempotently processes
```

Debezium closes the gap between "the DB change happened" and "the Kafka event was published" **without requiring application code to explicitly call Kafka**. The application only writes to the database; Debezium handles the rest. This means the DB write and the event publish are as close to atomic as you can get without a two-phase commit — the database's own durability is the guarantee.

**Key Debezium concepts:**
- **Connector:** per-database plugin (e.g., `debezium-connector-postgres`) that reads the WAL.
- **Snapshot:** on startup, Debezium takes a full snapshot of the current table state before streaming ongoing changes.
- **Exactly-once in Debezium:** Debezium itself delivers at-least-once (network failures can cause re-sends); the consuming application must be idempotent using the event's Kafka offset or message ID.

---

## Avro

**Where it appears in deep-dive.md:** Chapter 10 🔴 — Schema Registry and contract evolution.

**Apache Avro** is a **binary serialisation format** commonly used for Kafka messages (alongside Protobuf and JSON Schema) because it has compact encoding and, crucially, **schema-aware compatibility rules** enforced by a Schema Registry.

```json
// Avro schema definition (.avsc) — describes the shape of a Kafka message
{
  "type": "record",
  "name": "OrderPlaced",
  "namespace": "com.shop.events",
  "fields": [
    { "name": "orderId",  "type": "string" },
    { "name": "userId",   "type": "string" },
    { "name": "amount",   "type": "double" },
    { "name": "currency", "type": "string", "default": "USD" }  // new field with default = backward compatible
  ]
}
```

**How the Schema Registry works with Avro:**
1. Producer registers the schema with the **Confluent Schema Registry** (or AWS Glue Schema Registry).
2. Each Kafka message payload is prefixed with the **schema ID** (a 4-byte integer), not the full schema.
3. Consumer fetches the schema by ID from the registry, deserialises.
4. The registry enforces compatibility rules: `BACKWARD` (old consumers can read new data), `FORWARD` (new consumers can read old data), `FULL` (both).

**Why it exists:** without a schema registry, a producer changing a field name or removing a field silently breaks consumers. The registry acts as the **contract enforcement layer for Kafka topics** — analogous to how protobuf field numbers and a `.proto` file enforce gRPC contract stability.

**Avro vs Protobuf:** both are binary, both use a schema/registry. Avro schemas are JSON files (human-readable, dynamic); Protobuf schemas are `.proto` files (compiled, richer types, better cross-language tooling). In Kafka, Avro + Schema Registry is the historically dominant combination (Confluent's default); Protobuf is increasingly common in polyglot shops that already use gRPC.

---

## W3C traceparent

**Where it appears in deep-dive.md:** Chapter 10 🔴 — cross-boundary distributed tracing.

```http
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ││  └────────────────────────────┘ └──────────────┘ │└ flags
             ││        trace-id (128-bit)        parent-span-id   └ sampled
             │└─ version
             └── spec version (00)
```

`traceparent` is a standard HTTP header defined by the **W3C Trace Context specification**. It is the glue that lets a single user action — say, a checkout — be traced *end-to-end* as one coherent unit even though it crosses many services, queues, and protocols.

**The four fields:**
| Field | Size | Meaning |
|-------|------|---------|
| `version` | 2 hex | Spec version (always `00` today) |
| `trace-id` | 32 hex (128-bit) | Globally unique ID for the entire request chain. Stays the **same** across every hop. |
| `parent-span-id` | 16 hex (64-bit) | ID of the *current* span (changes at each service boundary). |
| `flags` | 2 hex | Sampling flag — `01` = sampled (record this trace). |

**How it propagates across protocols:**
- **HTTP (REST/gRPC):** inject `traceparent` as a request header; every downstream service reads it, creates a child span, and re-injects the updated header.
- **Kafka:** carry the `traceparent` value in a **Kafka message header** (key: `traceparent`). The consumer reads it and creates a child span continuing the same trace.
- **gRPC:** pass it in gRPC metadata (a key-value header equivalent).

**What breaks without it:** without propagating `traceparent` across a Kafka topic boundary, the trace ends at the Kafka producer. You can see "the REST handler called Kafka and took 5ms" but you can't see what happened in the async consumer — a broken trace is the #1 reason post-incident root-cause analysis takes hours instead of minutes.

**Tooling:** OpenTelemetry (the CNCF standard) auto-instruments most web frameworks and Kafka clients to extract/inject `traceparent` transparently. Jaeger, Zipkin, Datadog, and Honeycomb all understand this format.

---

*Last updated to match [deep-dive.md](./deep-dive.md) v1. If you add new technical terms to deep-dive.md, add an entry here and link it inline.*
