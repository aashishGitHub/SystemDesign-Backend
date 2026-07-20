# Grill Me: Communication & Messaging Protocols

> **How to use this sheet.** Hand it to someone and have them fire these at you cold. Your job is to *defend* a choice under pressure, not recite a definition. Every question below has a tempting wrong answer baked in — the kind that catches people who memorized the survey in [questions.md](./questions.md) and [answers.md](./answers.md) but never had to argue a tradeoff out loud.
>
> The drill: read the question, *say your answer before reading the Answer block*, then check whether you fell into the trap in the "Why X is incorrect" section. If you can't explain the Key Insight in one sentence, you don't own it yet.
>
> Where the real depth lives elsewhere, follow the links: [api-design](../api-design/), [message-queues](../message-queues/), [chat-system](../chat-system/).

---

## Q1: You're building "place order → charge card → ship." A junior wires all three as synchronous REST calls in one request. The payment provider has a p99 of 4 seconds. What breaks, and what's the correct decomposition?

### Answer:
1. **Latency stacks and the caller pays for the slowest link.** The user's HTTP request can't return until *all three* hops finish. Your tail latency becomes the sum of tail latencies. One slow downstream (payment) drags the whole synchronous chain into timeouts.
2. **Coupling on availability.** If the shipping service is down, the order *cannot be placed* — even though placing an order doesn't logically require shipping to be alive *right now*. Synchronous REST couples the *liveness* of all three services together. That's an availability multiplication: 99.9% × 99.9% × 99.9% ≈ 99.7%.
3. **Correct decomposition:** Keep the call that the user *must* see succeed synchronous (charge the card, return success/failure). Everything that can happen *after the user leaves* — shipping, email confirmation, analytics — goes onto a queue/event as an async step. `POST /orders` writes the order + payment result, emits an `OrderPlaced` event, returns 201. Fulfillment consumes the event on its own schedule.

### Why "wrap the three calls in a retry + a longer timeout" is incorrect:
- Retries and bigger timeouts treat the symptom (occasional slowness) and *worsen* the disease (coupling). A 30s timeout means a user stares at a spinner for 30s before getting an error. Retrying a synchronous chain multiplies load on a struggling downstream — the exact moment you should be *shedding* load.
- The real problem isn't "the call is slow," it's "this call shouldn't be on the request path at all." No timeout value fixes a structural mistake.

### Key Insight:
Put on the synchronous request path *only* what the caller must know the result of *right now*; defer everything else to async so a downstream's availability and latency stop being your user's problem.

### When to use in interviews:
- Any "design checkout / signup / upload" flow — the first architectural decision is which steps are sync vs async.
- When an interviewer pushes "why not just call it directly?"

---

## Q2: The opposite mistake. A team puts a Kafka topic between the API and the database for a `GET /user/{id}` read because "events scale better." Why is this wrong, and what's the tell?

### Answer:
1. **A read is request/response by nature.** The caller needs *this specific answer* before it can proceed. Async messaging gives you fire-and-forget with no return channel; you'd have to invent a correlation-ID + response-topic dance to fake request/response over a log. That's rebuilding RPC badly on top of a streaming bus.
2. **Latency goes the wrong direction.** Kafka optimizes throughput via batching and is happy to add tens of milliseconds of buffering. A synchronous read wants the *lowest possible* single-request latency. You'd be paying queueing latency to retrieve a row you could fetch in a single round trip.
3. **The tell:** if the producer *waits for and depends on* a reply, it's synchronous communication wearing an async costume. Async is correct only when the producer can move on without the answer.

### Why "events are always more scalable, so use them everywhere" is incorrect:
- Events scale *write fan-out and decoupling*, not *point reads*. A point read has no fan-out and no decoupling benefit — there's exactly one logical consumer (the caller) who is blocked waiting.
- "Scalable" is meaningless without the axis. Kafka scales throughput; it does not lower the latency of a single correlated request/response.

### Key Insight:
If the producer needs the answer to continue, you want synchronous request/response — dressing it up as an event just rebuilds RPC over a log with worse latency.

### When to use in interviews:
- When someone reaches for Kafka/queues reflexively. Ask: "does the caller need the result to proceed?" If yes, it's sync.

---

## Q3: "Async always decouples, so it's always more resilient." Give a concrete case where adding a queue makes resilience *worse*, not better.

### Answer:
1. **A queue is a buffer, and buffers hide backpressure until they explode.** If your consumer is slower than your producer and you've put an unbounded queue between them, the queue grows silently. You don't fail fast; you fail *late and large* — disk fills, the broker degrades, and every consumer of that broker suffers. A synchronous call would have applied backpressure immediately (the caller blocks / gets a 503).
2. **You've added a new dependency: the broker itself.** Now the broker's availability is on your critical path for *writes*. If RabbitMQ/Kafka is down and you have no fallback, the "decoupled" producer can't publish either.
3. **Lost-message and ordering surface area.** Async introduces duplicate delivery, out-of-order delivery, and the need for idempotent consumers (see Q19). A direct synchronous call has none of these.

### Why "decoupling is unconditionally good" is incorrect:
- Decoupling trades *temporal coupling* (both must be up now) for *operational complexity* (a broker to run, DLQs to drain, dedup to implement). That trade pays off for genuinely async work; it's pure cost for work that's actually synchronous.

### Key Insight:
A queue converts "fail fast and visibly" into "absorb silently until you can't" — that's a resilience *gain* only if the work is truly fire-and-forget and you've bounded the buffer and planned the broker's own failure.

### When to use in interviews:
- Push back on the "decouple everything" reflex. Name the broker as a new dependency and unbounded queues as a hidden failure mode.

---

## Q4: "Why HTTP/2 and not HTTP/3?" Walk me through head-of-line blocking precisely — at which layer HTTP/2 still has it, and why HTTP/3 doesn't.

### Answer:
1. **HTTP/1.1 HoL blocking is at the HTTP layer:** one request per connection at a time; a slow response blocks the requests behind it. Browsers worked around it by opening 6 parallel connections.
2. **HTTP/2 fixed the *application*-layer HoL** with multiplexing: many independent *streams* over one TCP connection, interleaved as binary frames. But all those streams ride **one TCP connection**, and TCP guarantees in-order byte delivery. If one packet is lost, TCP holds back *every* stream's bytes until that packet is retransmitted — even streams whose data already arrived. So HTTP/2 moved HoL blocking down to the **TCP transport layer**.
3. **HTTP/3 runs over QUIC (on UDP)**, which implements streams *inside* the transport and tracks loss/ordering per-stream. A lost packet for stream A no longer stalls stream B — only stream A waits for its retransmit. That eliminates transport-layer HoL blocking.

```
HTTP/1.1:  HoL at HTTP layer   (one request blocks the connection)
HTTP/2:    HoL at TCP layer    (one lost packet blocks all streams)
HTTP/3:    no transport HoL    (QUIC tracks loss per-stream over UDP)
```

### Why "HTTP/3 is just HTTP/2 but faster, so always pick it" is incorrect:
- HTTP/3's win is real *only on lossy networks* (mobile, congested links) where packet loss is common. On a clean datacenter link with near-zero loss, TCP rarely retransmits, so HTTP/2's transport HoL almost never fires — and HTTP/3 buys you little while costing you UDP middlebox issues, less mature tooling, and CPU spent on userspace congestion control.
- "Always pick the newest version" ignores that the benefit is conditional on the loss environment.

### Key Insight:
HTTP/2 multiplexes streams but they share one ordered TCP pipe, so one lost packet stalls all of them; HTTP/3 moves stream awareness into QUIC so loss is isolated per stream — a benefit that materializes on lossy networks, not clean ones.

### When to use in interviews:
- Whenever HTTP version comes up. The phrase "head-of-line blocking moved from the HTTP layer to the TCP layer" is the differentiator that proves you understand the *why*.

---

## Q5: A client `POST`s a payment, the network drops the response, the client retries, the user is charged twice. "Just make it a `PUT` — `PUT` is idempotent." Why does that not actually fix it?

### Answer:
1. **Idempotency of `PUT` is a *semantic contract*, not free magic.** `PUT /products/1` is idempotent because it means "set resource 1 to this state" — repeating it lands on the same final state. But "create a payment" has *no natural target ID the client knows in advance*; the server mints the payment ID. So you can't express it as "set payment X to this state."
2. **The actual fix is an idempotency key, not a method swap.** The client generates a unique key for the *logical operation* and sends it (e.g., `Idempotency-Key: <uuid>`). The server stores the key → result mapping. First request: process, persist result under the key. Retry with the *same* key: return the stored result without re-charging.
3. **Where it's checked:** at the start of request handling, before the side effect, inside the same transaction that records the charge — so a crash between "charge" and "store key" can't leave them inconsistent.

```http
POST /payments
Idempotency-Key: 7c9e6679-...-50f1     # SAME on every retry of this logical charge
{ "amount": 4200, "currency": "usd" }
```

### Why "make it a PUT to a client-chosen URL" is incorrect-ish (and the subtle trap):
- You *can* sometimes invert it to `PUT /payments/{client-generated-uuid}` and lean on `PUT` semantics — but now you've just reinvented the idempotency key as a path segment. The mechanism is *identical*; the method name is cosmetic. The point is the **stable key**, not the verb.
- Believing the verb alone does the work means you'll forget to persist and check the key, and double-charge anyway.

### Key Insight:
Retry safety comes from a stable key for the logical operation plus server-side dedup, not from the HTTP verb — `PUT`'s idempotency is just the special case where the key *is* the resource URL.

### When to use in interviews:
- Any payments/orders/"retry" question. Deeper treatment in [api-design](../api-design/).

---

## Q6: The classic idempotency-key trap. A team adds idempotency keys but still gets double charges under retry. What's the most likely bug in how they construct the key?

### Answer:
1. **They generated the key per *attempt* instead of per *logical operation*.** If the HTTP client library (or the retry middleware) mints a fresh UUID on each retry, every attempt looks "new" to the server, dedup never matches, and you double-charge. The key must be created **once, when the user clicks Pay**, and *reused* on every retry of that same intent.
2. **Or: the key is derived from request content that changes between retries** — e.g., including a timestamp or a client-side request-id that the retry layer regenerates. Same effect: the "same" operation produces different keys.
3. **Correct construction:** stable identifier tied to the *business intent* — generated at the UI/command layer, carried through every retry of that command, scoped to the operation (one key per checkout, not one per network send).

```
WRONG:  key = uuid()                 # called inside the retry loop → new every attempt
WRONG:  key = hash(body + now())     # timestamp changes on retry
RIGHT:  key = uuid() generated once at "Pay" click, stored, reused on all retries
```

### Why "any unique key per request works" is incorrect:
- "Per request" is exactly the bug. The whole point is that a retry is *the same logical request*, so it must carry the *same* key. Uniqueness must be at the granularity of the *intent*, not the *transmission*.

### Key Insight:
The idempotency key identifies the *logical operation*, so it must be generated once at intent and reused across every retry — a key minted per network attempt defeats the entire mechanism.

### When to use in interviews:
- When the interviewer says "okay you have idempotency keys — how exactly do you build the key?" This per-attempt-vs-per-op distinction is what separates people who used the pattern from people who only read about it.

---

## Q7: You have a `.proto` deployed to thousands of clients. You delete an old field `int32 status = 3;` and later add `string region = 3;` reusing number 3. Production starts returning garbage. Explain the failure on the wire.

### Answer:
1. **Protobuf encodes by field *number*, not field name.** On the wire a field is `(field_number << 3) | wire_type` followed by the value. The field name exists only in the `.proto`; it is *never* sent. So old peers that still send `status=3` as a varint, and new peers that read field 3 as a length-delimited string, will collide.
2. **Reusing number 3 means old data and new data are indistinguishable.** A message produced by an old client carries an `int32` under tag 3; a new server decodes tag 3 as a `string` and misinterprets the varint bytes as a length-prefixed UTF-8 blob → garbage, or a decode error, or silent corruption.
3. **The rule:** field numbers are permanent identities. To remove a field, mark it `reserved 3;` (and optionally `reserved "status";`) so nobody can ever reassign that number. New fields get *new, never-before-used* numbers.

```proto
message User {
  // status removed — DO NOT reuse 3
  reserved 3;
  reserved "status";
  string region = 4;   // new field gets a fresh number
}
```

### Why "renaming/renumbering is fine as long as I update all clients" is incorrect:
- In a distributed system you *cannot* atomically update all clients. During any rollout (and forever, for cached/queued messages encoded under the old schema) old and new wire formats coexist. Backward/forward compatibility *is* the requirement, not a nice-to-have.
- The field *name* is irrelevant to compatibility — renaming a field while keeping its number is safe; reusing a number while keeping/ changing the name is catastrophic. People get this exactly backwards.

### Key Insight:
Protobuf's wire contract is the field *number* and type, not the name — numbers are immutable identities you `reserve` on removal and never recycle, because old and new encodings always coexist on the wire.

### When to use in interviews:
- Any gRPC schema-evolution question. Tie it to the same principle behind REST versioning and Kafka Schema Registry: never break an existing contract; only add.

---

## Q8: gRPC "requires HTTP/2." Someone says "fine, I'll expose my gRPC service straight through API Gateway like my REST APIs." Why does that struggle, and what AWS components actually carry gRPC end-to-end?

### Answer:
1. **gRPC needs *end-to-end* HTTP/2 with long-lived, multiplexed streams and trailers.** REST-oriented API Gateway (REST/HTTP APIs) is built around request/response HTTP/1.1-style semantics and doesn't transparently proxy HTTP/2 streaming + trailing metadata that gRPC relies on. So unary might be coerced, but streaming and the framing gRPC depends on don't pass through cleanly.
2. **What works on AWS:** an **Application Load Balancer (ALB) supports end-to-end HTTP/2 and gRPC** (it can route on gRPC, return gRPC status codes). Run the server on **ECS/Fargate** (containers) or **EC2** for full control. The ALB terminates/forwards HTTP/2 to your gRPC server.
3. So the pattern is **ALB → ECS/Fargate (or EC2) gRPC server**, not API Gateway → Lambda for streaming gRPC.

### Why "it's just HTTP, any gateway/LB will proxy it" is incorrect:
- gRPC is HTTP/2 *plus* a specific framing (length-prefixed messages) and *trailers* (gRPC status arrives in HTTP/2 trailing headers). A proxy that buffers, downgrades to HTTP/1.1, or strips trailers silently breaks gRPC even though "it's HTTP."
- A classic L7 proxy tuned for short request/response can also kill the long-lived streams gRPC streaming needs.

### Key Insight:
gRPC isn't "just HTTP" — it's HTTP/2 with multiplexed streams and trailers, so it needs infrastructure that proxies HTTP/2 end-to-end (ALB + Fargate/ECS/EC2), not a REST-shaped gateway that buffers or downgrades.

### When to use in interviews:
- "Deploy gRPC on AWS" questions. Naming ALB for end-to-end HTTP/2 is the concrete detail interviewers look for.

---

## Q9: "GraphQL fixes REST's multiple round-trips, so it's always faster." Show me how a naive GraphQL resolver can be *slower* than the explicit REST calls it replaced.

### Answer:
1. **The N+1 resolver problem.** A query for `posts { author { name } }` runs the `posts` resolver once (returns N posts), then runs the `author` resolver *once per post* — N additional fetches. One client query silently fans out into 1 + N backend calls. REST made those round trips *visible and explicit*; GraphQL hides them behind the field, so naive resolvers issue more backend queries than the REST version ever did.
2. **It's worse than REST precisely because it's invisible.** With REST, a frontend dev *sees* they're calling `/authors/{id}` in a loop and feels the pain. With GraphQL the loop is on the *server*, inside resolvers the client author never sees — so the inefficiency ships silently and shows up as DB load.
3. **The fix is batching: DataLoader.** It defers individual `author(id)` loads within a tick, coalesces them into one batched fetch (`WHERE id IN (...)`), and dedupes. 1 + N becomes 1 + 1.

```
Naive:      posts() → 1 query;  author() → N queries   (1 + N)
DataLoader: posts() → 1 query;  authors batched → 1 query (1 + 1)
```

### Why "GraphQL avoids round trips, so the DB load is automatically lower" is incorrect:
- GraphQL collapses *client↔server network* round trips, not *server↔database* round trips. The single network call can explode into many DB calls behind the resolver. Conflating the two layers is the trap.
- Over-fetching is also not automatically solved: a deeply nested query can pull far more work than a purpose-built REST endpoint.

### Key Insight:
GraphQL removes client round trips but can multiply *server-side* fetches via N+1 resolvers — and it's more dangerous than REST's loop because the fan-out is invisible to the client author until DataLoader batching tames it.

### When to use in interviews:
- Any GraphQL question. Deeper resolver/DataLoader treatment in [api-design](../api-design/).

---

## Q10: In RabbitMQ a developer swears their `topic` exchange "isn't routing correctly." They set the *routing key* on the binding and the *binding key* on the publish. Untangle routing key vs binding key and which side owns each.

### Answer:
1. **Routing key — set by the *publisher* on each message.** It's an attribute of the message ("here's what this message is about"), e.g. `order.eu.created`.
2. **Binding key — set on the *binding* between an exchange and a queue.** It's the *pattern the queue is interested in*, e.g. `order.eu.*`. The exchange compares the message's routing key against each binding key to decide which queue(s) get the message.
3. The developer reversed them: a message has no "binding key," and a binding has no "routing key." Putting the pattern on the publish and the literal value on the binding means nothing matches.

```
Publisher  --routing key: "order.eu.created"-->  [topic exchange]
                                                     |  compares against binding keys
[queue EU]  bound with binding key  "order.eu.*"  ✓ match
[queue US]  bound with binding key  "order.us.*"  ✗ no match
```

### Why "they're the same thing, just two names" is incorrect:
- They live on opposite ends of the routing decision. Routing key = property of the *message* (publisher-owned, per-message). Binding key = property of the *binding* (queue-owned, set once at bind time). The exchange's whole job is *matching one against the other*.
- For a **fanout** exchange neither matters — fanout ignores keys entirely and copies to all bound queues. For **direct** it's an exact-match; for **topic** it's wildcard pattern match (`*` one word, `#` zero-or-more). Knowing keys are irrelevant for fanout is itself a tell of understanding.

### Key Insight:
The publisher stamps a routing key on the message; the queue declares a binding key as the pattern it wants; the exchange routes by matching the two — they are opposite ends of the same decision, not synonyms.

### When to use in interviews:
- Any AMQP routing question. Pair it with "fanout ignores both keys" to show you know when matching even applies.

---

## Q11: Direct vs fanout vs topic — an interviewer gives you "notify billing, search-index, and email when an order is placed, and *also* let a fraud service see only EU orders." Which exchange(s), and why is "just use one topic exchange for all of it" a smell?

### Answer:
1. **Broadcast-to-all subscribers = fanout.** Billing, search-index, and email all need *every* `OrderPlaced` — they don't filter. A **fanout** exchange copies each message to all bound queues, no key matching. Simple, fast, intent-revealing.
2. **Selective subset = topic (or direct).** Fraud wants only EU orders. That's pattern matching on a routing key like `order.eu.placed` against a binding key `order.eu.*` — a **topic** exchange. (If it were a single exact value with no wildcards, **direct** suffices.)
3. **So it's two routing intents, ideally modeled distinctly:** one fanout for "everyone who needs all orders," one topic for "subscribers who want a filtered slice." You *can* do it all with one topic exchange (fanout is a topic with `#`), but collapsing them hides intent and tempts consumers to over-subscribe.

| Need | Exchange | Key matters? |
|---|---|---|
| Send to *all* bound queues | Fanout | No |
| Exact single-value match | Direct | Yes (exact) |
| Wildcard/pattern subset | Topic | Yes (`*`, `#`) |
| Match on message headers | Headers | No (uses arguments) |

### Why "one topic exchange with `#` everywhere is fine" is incorrect:
- It works mechanically but throws away the self-documenting value of fanout for true broadcasts, and it invites accidental over-matching (a too-broad pattern silently grabs messages a queue shouldn't get). The exchange type *is* the documentation of intent.

### Key Insight:
Pick the exchange by routing intent — fanout for unconditional broadcast, direct for exact-match, topic for wildcard slices — because the type encodes intent and prevents accidental over-subscription that a catch-all topic invites.

### When to use in interviews:
- Routing-design questions. Show you map *intent* → exchange type rather than defaulting to topic for everything.

---

## Q12: A team has a Kafka topic with 6 partitions and runs 12 consumers in one group "for more throughput." Why is that wasteful, and what's the relationship that actually caps parallelism?

### Answer:
1. **A partition is assigned to exactly one consumer within a group.** With 6 partitions and 12 consumers, the broker hands each partition to one consumer — so **6 consumers do all the work and 6 sit idle**, holding connections and contributing nothing to throughput.
2. **Partition count is the ceiling on consumer parallelism per group.** You cannot have more *active* consumers than partitions in a group. To go faster you must add *partitions*, not consumers.
3. **The over-provisioned consumers aren't free** — they participate in rebalances, consume coordinator resources, and add operational noise for zero throughput gain.

```
6 partitions, 12 consumers in one group:
P0→C0  P1→C1  P2→C2  P3→C3  P4→C4  P5→C5     C6..C11 = idle
```

### Why "more consumers = more throughput, always" is incorrect:
- Throughput scales with consumers *only up to the partition count*. Beyond that, extra consumers are pure overhead. The lever is partitions, and partitions are decided largely up front (increasing them later reshuffles key→partition assignment and can break per-key ordering).

### Why this connects to **rebalance storms**:
- Every time a consumer joins/leaves (deploys, crashes, scaling), the group **rebalances**: partition assignments are revoked and reassigned, and processing pauses during the rebalance. Running far more consumers than partitions, plus flapping/short-lived consumers, triggers frequent rebalances — a "rebalance storm" where the group spends its time reassigning instead of consuming.

### Key Insight:
Within a consumer group, partition count caps useful parallelism — extra consumers idle and only add rebalance overhead, so you scale by adding partitions (planned up front to preserve key ordering), not consumers.

### When to use in interviews:
- Kafka scaling questions. Deeper partition/ordering/consumer-group mechanics in [message-queues](../message-queues/).

---

## Q13: "SQS gives you exactly-once with FIFO queues, so I'll use FIFO everywhere and never worry about duplicates." Tear this apart.

### Answer:
1. **FIFO's exactly-once is *processing* dedup within a 5-minute window, not a universal guarantee.** SQS FIFO deduplicates messages with the same dedup ID inside a ~5-minute interval and preserves order per message group. Outside that window, or across a different group, you do not get magic global exactly-once.
2. **FIFO costs throughput.** Standard queues have effectively unlimited throughput; FIFO is throughput-limited (raised with high-throughput mode, but still bounded and constrained by per-message-group ordering). Choosing FIFO "to be safe" can throttle a high-volume workload that never needed ordering.
3. **Standard queues explicitly allow duplicates and best-effort order** — and that's *fine* for background/batch work (image processing, log aggregation) where the consumer is idempotent. FIFO is for when *order* and *no-dupes* are genuinely required: e-commerce order processing, financial transactions.

| | Standard | FIFO |
|---|---|---|
| Order | Best-effort | Strict per message group |
| Duplicates | Possible (must handle) | Deduped within ~5-min window |
| Throughput | ~Unlimited | Limited (bounded even in HT mode) |
| Use when | Idempotent background/batch | Order + no-dupes mandatory |

### Why "exactly-once = never think about duplicates" is incorrect:
- The dedup is *windowed and scoped*. A retry after the window, a producer that sends a different dedup ID for the same logical message, or consumption that crashes after processing but before deleting → reprocessing. You still want an idempotent consumer as the real safety net (Q18/Q19).
- Defaulting to FIFO "to be safe" trades away throughput you may critically need, to solve a problem (ordering) you may not have.

### Key Insight:
FIFO gives windowed, per-group dedup at a throughput cost — not a free universal exactly-once — so pick Standard + idempotent consumers unless ordering and no-duplicates are truly mandatory.

### When to use in interviews:
- SQS questions. The phrase "exactly-once is windowed and scoped, not universal" signals depth.

---

## Q14: SNS→SQS fan-out vs publishing SNS directly to consumers — and when does EventBridge beat plain SQS? Defend each choice.

### Answer:
1. **SNS→SQS fan-out** puts an SQS queue between SNS and each consumer. SNS publishes once to a topic; each subscribed SQS queue gets its own copy. Why combine them instead of SNS-direct to (say) an HTTP endpoint: the **queue buffers and retries**. If a consumer is down, the message waits in *its* queue (with retention + DLQ) instead of being lost or hammering a dead endpoint. You get per-consumer durability, independent processing speed, and replay/DLQ semantics. SNS alone is push-and-pray; SNS→SQS is push-into-a-durable-buffer.
2. **SNS-direct** (to Lambda/HTTP/SMS/email) is right when you *don't* need per-subscriber buffering — A2P notifications (SMS/email to people), or a Lambda you trust to scale and whose failures you're okay retrying via SNS's own retry policy.
3. **EventBridge over SQS** when you need **content-based routing rules**. SQS has *no* built-in filtering — every message goes to the one queue. EventBridge matches events against rules/patterns and routes to *different* targets accordingly, and supports many AWS targets + SaaS partner sources via event buses (default / custom / partner). Reach for it when the routing logic is "send order events to billing, but only high-value ones to fraud, and reflect schema changes" — declarative routing rather than point-to-point queuing.

### Why "SNS already fans out, so SQS in front is redundant" is incorrect:
- SNS fans out *delivery attempts*; it does not give each consumer a *durable, independently-paced buffer* with retention and a DLQ. Without the queue, a slow or down consumer drops messages or forces SNS retries against a dead target. The queue is what makes the fan-out *reliable* per consumer.

### Why "EventBridge is just a fancier SQS" is incorrect:
- They solve different problems: SQS is reliable *point-to-point queuing*; EventBridge is *rules-based event routing* with filtering and many targets. Using EventBridge as a plain queue wastes its routing; using SQS where you need content routing forces you to build filtering by hand.

### Key Insight:
SNS→SQS buys each consumer a durable, independently-paced buffer (retention + DLQ) that SNS-direct lacks; EventBridge buys declarative content-based routing to many targets that SQS lacks — choose by whether you need buffering or routing.

### When to use in interviews:
- AWS messaging design. The discriminators are *per-consumer durability* (→ SNS+SQS) and *content-based routing* (→ EventBridge).

---

## Q15: An interviewer says "use Kafka to push live notifications to 50,000 browser clients." What's the category error, and what's the right pairing?

### Answer:
1. **Kafka is not a client-facing transport.** Browsers don't (and shouldn't) speak the Kafka protocol; Kafka has no per-user connection model, no client push, no auth model for untrusted edge clients. It's a server-side, broker-centric streaming log for *backend* services with persistent retention.
2. **WebSocket is the client-facing transport.** It's a persistent, full-duplex TCP connection for low-latency server→client push to a *specific* connected user — exactly the "live notification to a browser" need.
3. **Use them together:** backend services produce events to **Kafka**; a **WebSocket gateway** service consumes from Kafka and pushes the relevant event down the right user's open WebSocket. Kafka = the durable internal event backbone; WebSocket = the last-mile delivery to the user.

```
[services] → produce → [Kafka topic] → consumed by → [WS gateway] → push → [browser over WebSocket]
            (durable, replayable backbone)               (stateful per-user last mile)
```

### Why "Kafka is scalable so it can serve the clients directly" is incorrect:
- "Scalable" refers to backend throughput, not "can terminate 50k untrusted browser connections and push to individuals." Kafka has no notion of a per-recipient socket. Confusing the *event backbone* with the *delivery transport* is the category error.

### Key Insight:
Kafka is the durable server-side event backbone; WebSocket is the stateful per-user last-mile push — they compose (Kafka → WS gateway → client), and substituting one for the other is a category error.

### When to use in interviews:
- "Real-time updates to clients" questions. Deeper real-time/chat design in [chat-system](../chat-system/).

---

## Q16: WebSocket at scale. You terminate 200k WebSocket connections across 10 servers behind a load balancer. A user's messages start landing on a server that doesn't hold their socket. What broke, and how do you fix the LB and the fan-out?

### Answer:
1. **WebSocket connections are *stateful and server-pinned*.** Once a client's socket is established on server #4, *only server #4* can write to that socket. A round-robin L7 LB that routes the user's *next* request to server #7 means #7 can't reach the live socket. HTTP request/response is stateless and load-balances freely; WebSocket is the opposite.
2. **Fix the LB: sticky routing for the lifetime of the connection.** The upgrade and the connection stay pinned to one backend (sticky sessions / connection affinity). The TCP connection itself is long-lived, so "stickiness" is really "don't move an established connection."
3. **Fix the fan-out: a shared backplane.** To push a message to a user whose socket lives on *some* server, you need a pub/sub backplane (e.g., Redis pub/sub or a broker) that every WS server subscribes to. Server holding the socket receives the published message and writes it down the wire. This decouples "which server produced the event" from "which server owns the connection."

### Why "just add a stateless load balancer like for REST" is incorrect:
- WebSocket has *no* statelessness to exploit — the connection *is* the state, living in one process's memory. A stateless LB that reassigns mid-connection (or rebalances) severs or strands sockets. You also can't horizontally scale by "just adding servers" without a backplane, because servers can't reach each other's sockets.

### Key Insight:
A WebSocket connection is server-pinned state, so scaling needs connection-affinity at the LB plus a pub/sub backplane every server subscribes to — the stateless REST playbook actively breaks it.

### When to use in interviews:
- "Scale a chat / live feature" questions. Sticky LB + Redis/broker backplane is the standard answer. Deeper in [chat-system](../chat-system/).

---

## Q17: The "just use Kafka for everything — it's scalable" trap. Give three places Kafka is the *wrong* tool and say exactly what you lose.

### Answer:
1. **Request/response RPC** (e.g., "fetch this user's balance now"). Kafka has no return channel; you'd fake correlation IDs + reply topics. You lose: low single-request latency and simple semantics. *Right tool:* gRPC/REST.
2. **Per-message routing/competing-consumers with complex routing keys + per-message TTL/priority/DLX.** Kafka's model is partitions + offsets, not flexible routing/selective ack per message. You lose: rich routing (direct/topic/headers), per-message TTL, easy redelivery of a single failed message. *Right tool:* RabbitMQ/AMQP.
3. **Client-facing push to browsers/devices.** Kafka isn't a client transport (Q15). You lose: per-user sockets, edge auth. *Right tool:* WebSocket/SSE.
4. **Simple managed decoupling with no replay need.** Running Kafka (or even MSK) is operational weight — partitions, retention, consumer-group ops, schema registry. For "just decouple two services in AWS," you lose simplicity for capabilities you won't use. *Right tool:* SQS.

### Why "scalable, therefore correct for everything" is incorrect:
- Scalability is one axis. Kafka optimizes **high-throughput, ordered, replayable event streams**. It is poor at low-latency request/response, flexible per-message routing, client-facing push, and low-ops simple queuing. Picking it for those buys throughput you don't need at the cost of latency, routing flexibility, or operational simplicity you *do* need.
- Replayability — Kafka's signature feature — only earns its keep when you actually need to re-read history (reprocessing, new consumers replaying, event sourcing). For consume-and-forget work it's unused weight.

### Key Insight:
Kafka is the right answer specifically for high-throughput, ordered, *replayable* streams; for RPC use gRPC/REST, for flexible routing use RabbitMQ, for client push use WebSocket, and for simple managed decoupling use SQS — "scalable" doesn't make it universal.

### When to use in interviews:
- This is the staff-level pushback. Name the *specific* capability you lose for each misuse, not a vague "it's overkill."

---

## Q18: "True exactly-once delivery." An interviewer claims their system has it end-to-end across producers, broker, and consumers. Why is exactly-once *delivery* effectively a myth across a network, and what do you actually deliver?

### Answer:
1. **The Two Generals problem.** Any acknowledgment can be lost. If a consumer processes a message and then crashes before its ack reaches the broker, the broker must redeliver (or risk losing it). The broker cannot distinguish "consumer never processed it" from "consumer processed it but the ack was lost." So it must choose: redeliver (risk *duplicate*) or not (risk *loss*). There is no third option over an unreliable channel.
2. **So you get at-most-once (may lose) or at-least-once (may duplicate) — never a free exactly-once *delivery*.** Production systems pick **at-least-once** (favor not losing) and then *make duplicates harmless*.
3. **What you actually deliver: at-least-once delivery + idempotent processing = effectively-once *effect*.** The message may arrive twice; the consumer's idempotency ensures processing it twice has the same effect as once. "Exactly-once" claims (e.g., Kafka transactions/EOS) are real *within a closed Kafka boundary* (read-process-write to Kafka with transactions) — they are *not* a guarantee across arbitrary external side effects (charging a card, calling a third-party API).

### Why "the broker vendor guarantees exactly-once, so I don't need idempotency" is incorrect:
- Vendor "exactly-once" is scoped to their own system's read/transform/write, under specific configuration. The moment your consumer touches an *external* side effect (DB in another system, payment API, email), the cross-system ack problem reappears and only *idempotency* saves you.
- Trusting the label and skipping idempotency is how "exactly-once" systems still double-charge.

### Key Insight:
Lost acks force every broker to choose duplicate-or-lose, so real systems pick at-least-once and add idempotent consumers — "exactly-once" is only ever true inside a closed transactional boundary, never across external side effects.

### When to use in interviews:
- Whenever someone says "exactly-once." Reframe to "at-least-once + idempotency = effectively-once."

---

## Q19: Name the two root causes of duplicate messages and three concrete ways to make a consumer idempotent. Then defend why a `SELECT … then INSERT` dedup check is racy.

### Answer:
1. **Root causes:** (a) **network issues** — a message/ack is lost so the sender resends; (b) **retries** — at-least-once delivery and producer/consumer retries inherently re-emit. (Plus consumer crash-after-process-before-ack, which is really case (a) at the ack.)
2. **Three ways to make the consumer idempotent:**
   - **Dedup table on a business key** — record processed message IDs / logical operation keys; on arrival, *atomically* insert-if-absent and skip if present (use a unique constraint, not check-then-act).
   - **Idempotent operation design** — make the effect naturally repeat-safe: `SET status='paid'` instead of `balance = balance - 10`; upserts instead of blind inserts.
   - **Conditional / optimistic writes** — version numbers or compare-and-set so a replay with a stale version is rejected.
3. **Why check-then-insert is racy:** two concurrent deliveries of the same message both run `SELECT` (find nothing), both `INSERT` → two effects. The window between read and write is exploitable. Fix: push the check into the *write* — a `UNIQUE` constraint on the message key (the second insert fails) or `INSERT … ON CONFLICT DO NOTHING` — so the database does the dedup atomically.

```sql
-- RACY: SELECT then INSERT (two consumers both see "not processed")
-- SAFE: let the DB enforce it atomically
INSERT INTO processed(msg_id) VALUES ($1) ON CONFLICT (msg_id) DO NOTHING;
-- if 0 rows affected → already processed → skip the side effect
```

### Why "just check if we've seen the ID before processing" is incorrect:
- "Check then act" is a read-modify-write race under concurrency. With at-least-once delivery, the *same* message can be in flight on two consumers simultaneously. Only an atomic primitive (unique constraint / CAS / single conditional statement) actually dedups.

### Key Insight:
Duplicates come from lost acks and retries, so idempotency must be enforced atomically at the write (unique key / upsert / CAS) — a separate check-then-insert reintroduces the very race it's trying to prevent.

### When to use in interviews:
- Any async-consumer question. Deeper consumer/idempotency patterns in [message-queues](../message-queues/).

---

## Q20: Backpressure across transports. A producer outruns a consumer in each of REST, gRPC streaming, Kafka, and WebSocket. Describe what *each* does — and why "the queue handles backpressure for free" is wrong.

### Answer:
| Transport | What happens when the consumer can't keep up |
|---|---|
| **REST (request/response)** | Natural backpressure: the caller blocks on the response and can't send the next request until this one returns; an overloaded server returns **503 / 429 (`Retry-After`)** and the client must slow down. Synchronous coupling *is* the flow control. |
| **gRPC streaming** | Built on HTTP/2 flow control: per-stream and connection-level **windows**. If the receiver doesn't read, the window fills and the sender's writes block/await — backpressure propagates through the stream automatically. |
| **Kafka** | The log absorbs the lag: producers keep writing, the consumer's **offset falls behind** (consumer lag grows). No automatic slowdown of the producer — backpressure is *your* job: monitor lag, add partitions/consumers, or the producer can outrun retention and lose unread data. |
| **WebSocket** | TCP flow control + the per-connection **send buffer**. If the client reads slowly, the server's outbound buffer grows; you must detect it and shed/drop/throttle, or the buffer bloats and memory/latency blow up. The protocol won't shed for you. |

### Why "putting a queue in front means backpressure is handled" is incorrect:
- A queue/log *defers* the pressure rather than signaling it. Kafka happily lets the producer race ahead while consumer lag balloons — there's no automatic "slow down" sent upstream. You've converted instantaneous backpressure into *unbounded lag*, which you must actively monitor and act on. With an unbounded buffer you don't get backpressure; you get a delayed outage.

### Key Insight:
Synchronous transports (REST, gRPC streaming, WebSocket/TCP) push backpressure *upstream* automatically via blocking/windows/buffers; log-based Kafka instead converts overload into *consumer lag* you must monitor and remediate — the buffer doesn't apply backpressure, it hides it.

### When to use in interviews:
- The "what happens under load" follow-up. The crisp split is: sync = automatic upstream signal; log = silent lag you must watch.

---

## Q21: "Kafka vs Kinesis — Kinesis is just managed Kafka, so always pick it on AWS." Where does that oversimplify?

### Answer:
1. **Kinesis trades flexibility for AWS-native, zero-ops integration.** It's fully managed and integrates natively with AWS (Firehose to S3/Redshift, Lambda triggers, Analytics). For an AWS-centric pipeline that wins on operational simplicity.
2. **Kafka is more flexible and open** — richer ecosystem (Kafka Connect, Streams, KSQL), portable across clouds/on-prem, and not locked to one provider's quotas and shard model. For multi-cloud, open deployments, or workloads needing the broader ecosystem, Kafka (or MSK if you want managed Kafka *on* AWS) fits better.
3. So the axis is **operational burden + AWS lock-in vs flexibility + portability**, not "one is strictly better." And note **MSK** exists precisely so you can get managed Kafka on AWS without choosing Kinesis.

### Why "managed always beats self-run" is incorrect:
- Managed reduces ops *but* imposes the provider's model (shard mechanics, retention/quota limits, native-only integrations) and lock-in. If you need Kafka's ecosystem or cloud portability, Kinesis's convenience doesn't substitute for it — and MSK gives managed Kafka anyway.

### Key Insight:
Kinesis wins on AWS-native integration and zero ops; Kafka wins on flexibility, ecosystem, and portability — and MSK covers "managed Kafka on AWS," so the choice is lock-in/ops vs flexibility, not newer-is-better.

### When to use in interviews:
- AWS streaming questions. Mentioning MSK as the "managed Kafka without Kinesis" option shows you know the full option space.

---

## Q22: One-liner discipline. For each, name the technology *and* the single deciding reason — no hedging. Public CRUD API; low-latency internal microservice call; flexible mobile data fetch; task queue with routing; high-throughput replayable streaming; fan-out notifications; real-time chat.

### Answer:
| Need | Pick | Deciding reason (the *why*, in one breath) |
|---|---|---|
| Public CRUD API | **REST** | Ubiquitous, cacheable, stateless, human-debuggable over plain HTTP |
| Low-latency internal microservice call | **gRPC** | HTTP/2 + protobuf: compact binary, multiplexed streams, codegen contract |
| Flexible mobile data fetching | **GraphQL** | Client asks for exactly the fields it needs → no over/under-fetch, fewer round trips |
| Task queue with routing | **RabbitMQ / AMQP** | Rich routing (direct/topic/headers), per-message ack/TTL/DLX, competing consumers |
| High-throughput replayable streaming | **Kafka** | Partitioned ordered log with retention → parallelism + replay/event-sourcing |
| Fan-out notifications | **SNS (often SNS→SQS)** | Pub/sub topic fans one publish out to many subscribers; +SQS for durable per-consumer buffering |
| Real-time chat | **WebSocket** | Persistent full-duplex socket for low-latency bidirectional client traffic |

### Why a hedged "it depends, could be several" is the wrong move here:
- The interviewer is testing whether you can *commit with a reason*. "It depends" without first giving a default and its deciding factor reads as not knowing. State the default + the one reason; *then* you may note the condition that flips it (e.g., "REST, unless I need streaming and a strict contract → gRPC").

### Key Insight:
Each technology has a *single dominant reason* it's the default for a need; lead with the pick and that reason, then qualify — committing with a justification beats hedging.

### When to use in interviews:
- Rapid-fire "which would you use" rounds. Memorize the deciding reason, not just the mapping — anyone can pair words; the *why* is what's scored.

---
```
Cross-references:
  REST idempotency keys, GraphQL resolvers/DataLoader → ../api-design/
  Kafka partitions/consumer groups, idempotent consumers → ../message-queues/
  WebSocket scaling, real-time push, backplane           → ../chat-system/
```
