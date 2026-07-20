# Interview Questions: Communication & Messaging Protocols

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level — later questions assume earlier concepts.
> When a question needs depth beyond this survey, the answer links to the dedicated topic ([api-design](../api-design/), [message-queues](../message-queues/), [chat-system](../chat-system/)).

---

## Level 1 — Communication Foundations
*Who: Everyone — get the sync/async axis right before naming any protocol.*

**Q1.** Define *synchronous* vs *asynchronous* communication. What is the key coupling difference, and give one concrete example of each.

**Q2.** A team defaults to REST for every inter-service call. Name three failure modes this causes that a broker/async approach would avoid.

**Q3.** "Async is always better because it decouples services." Why is this wrong? When does synchronous request/response remain the correct choice?

**Q4.** You're handed a new service-to-service integration. Walk through the decision tree you use to pick between REST, gRPC, GraphQL, a message queue, and an event stream.

---

## Level 2 — HTTP Fundamentals
*Who: Mid-level — the protocol everything synchronous is built on.*

**Q5.** Break down the parts of a URI (scheme, host, path, query string). Where does the request body fit, and why is it *not* part of the URI?

**Q6.** Which HTTP methods are *safe* and which are *idempotent*? Why is `PUT` idempotent but `POST` is not, and why does that distinction matter for retries?

**Q7.** What is the difference between *path parameters* and *query parameters*? Give a rule for when to use each.

**Q8.** How does HTTP/2 improve on HTTP/1.1 (multiplexing, binary framing, header compression, server push)? What problem still remains?

**Q9.** HTTP/2 still suffers head-of-line blocking. At which layer does it occur, and how does HTTP/3 (QUIC over UDP) eliminate it?

---

## Level 3 — REST
*Who: Senior — the default public API style and why it scales.*

**Q10.** REST is "an architectural style, not a protocol." What does *statelessness* actually require of the server and the client, and what is the benefit at scale?

**Q11.** Explain HTTP caching for REST: what do `Cache-Control`, `Expires`, and `ETag` each do? Walk through a conditional GET using an `ETag`.

**Q12.** Give the rules for good REST URI design. What specifically is wrong with `POST /getUser?id=1`?

**Q13.** Compare URL-path versioning (`/v1/users`) with header-based versioning. What does each cost you operationally?

**Q14.** A client retries a failed `POST /payments` and the user is charged twice. How do idempotency keys fix this, where is the key stored, and when is it checked? *(Deeper: [api-design](../api-design/))*

---

## Level 4 — gRPC & Protobuf
*Who: Senior — internal low-latency service-to-service.*

**Q15.** What is gRPC and what does it inherit from RPC? Why does it require HTTP/2 specifically?

**Q16.** Name the four gRPC streaming modes and give a real use case for each.

**Q17.** What are Protocol Buffers, and why are field numbers in a `.proto` file sacred (never reused, never renumbered)? How does this enable backward compatibility?

**Q18.** When does gRPC beat REST, and when is REST the better choice? Give the deciding factors, not a generic "gRPC is faster."

**Q19.** Deploying gRPC on AWS: why does API Gateway struggle with it, and which AWS components support end-to-end gRPC?

---

## Level 5 — GraphQL
*Who: Senior — flexible data fetching for frontends.*

**Q20.** What REST problems does GraphQL solve (over-fetching, under-fetching, multiple round-trips)? What new problems does it introduce?

**Q21.** Explain queries, mutations, and subscriptions and their REST analogies. What transport do subscriptions typically use?

**Q22.** What is a resolver, and what is the N+1 problem in GraphQL? How does DataLoader (batching) fix it? *(Deeper: [api-design](../api-design/))*

**Q23.** GraphQL is "strongly typed." How does the schema act as a contract, and how do you evolve it without breaking clients (and without `/v2`)?

---

## Level 6 — Async Messaging: AMQP & RabbitMQ
*Who: Senior — work distribution and routing.*

**Q24.** In AMQP, trace a message's path: publisher → exchange → binding → queue → consumer. What exactly does the *broker* own?

**Q25.** Compare the four RabbitMQ exchange types (direct, fanout, topic, headers). Give a routing scenario for each.

**Q26.** Distinguish a *routing key* from a *binding key*. Which is set by the publisher and which by the queue's binding?

**Q27.** What is a *channel* vs a *connection* in AMQP, and why do you multiplex many channels over a single TCP connection?

**Q28.** RabbitMQ Queues vs Streams: when do you pick each? What is a *quorum queue* and what does it protect against?

---

## Level 7 — Kafka, Event Sourcing & Streaming
*Who: Senior / Staff — high-throughput, replayable event pipelines.*

**Q29.** Explain Kafka's core model: topics, partitions, consumer groups, offsets, replication. How does partitioning give you parallelism *and* ordering at the same time? *(Deeper: [message-queues](../message-queues/))*

**Q30.** How does a consumer group achieve load balancing, and what happens during a *rebalance*? Why does running more consumers than partitions waste resources?

**Q31.** What is *event sourcing*? Define event store, command, projection, and aggregate. Why is Kafka a strong fit?

**Q32.** Contrast a traditional message queue (consume-and-delete) with Kafka's commit log (replayable). When does replayability actually matter?

**Q33.** Kafka vs Amazon Kinesis — what are the real tradeoffs (flexibility, operational burden, AWS-native integration)?

---

## Level 8 — AWS Managed Messaging
*Who: Senior / Staff — cloud-native messaging without running brokers.*

**Q34.** SQS Standard vs FIFO: compare ordering, duplicates, and throughput. Give one use case where FIFO is mandatory and one where Standard is correct.

**Q35.** What is a Dead-Letter Queue in SQS, and what determines when a message lands there? What do you do with the DLQ?

**Q36.** SNS is pub/sub; SQS is a queue. Explain the SNS → SQS fan-out pattern and why you'd combine them instead of using either alone.

**Q37.** Distinguish A2A from A2P in SNS. What does SNS FIFO add, and how is it typically paired with SQS FIFO?

**Q38.** SQS vs EventBridge: when do you reach for EventBridge's rules-based routing instead of a queue? What is an *event bus*, and what are its three bus types?

---

## Level 9 — WebSockets & Real-Time Transport
*Who: Senior — genuinely bidirectional, low-latency client traffic.*

**Q39.** Walk through the WebSocket lifecycle: HTTP upgrade handshake → data frames → persistent connection. How is it *full-duplex* compared with HTTP request/response?

**Q40.** Compare WebSocket vs SSE vs Long Polling for server-to-client push. When is each the right choice? *(Deeper: [sse](../sse/), [chat-system](../chat-system/))*

**Q41.** WebSockets vs Kafka are often confused. What problem does each actually solve, and how would you use them *together* in one system?

---

## Level 10 — Reliability & Cross-Cutting Concerns
*Who: Staff — the parts that separate a diagram from a production design.*

**Q42.** Why is true *exactly-once delivery* effectively impossible across a network, and what do *at-least-once + idempotency* give you instead?

**Q43.** Duplicate messages: name the two root causes (network + retries) and three ways to make a consumer idempotent.

**Q44.** Give the one-line "which technology" answer for each: public CRUD API; low-latency internal microservice call; flexible mobile data fetching; task queue with routing; high-throughput event streaming; fan-out notifications; real-time chat.

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** *Backpressure:* how do REST, gRPC streaming, Kafka, and WebSockets each behave when a consumer can't keep up with the producer?

**QB2.** *Contract evolution:* what is the common principle behind REST versioning, gRPC protobuf field numbers, and a Kafka Schema Registry (Avro)?

**QB3.** *Security:* how do you secure each transport — HTTPS/TLS for REST, mTLS/JWT for gRPC, auth on the WebSocket handshake, IAM for AWS messaging?

**QB4.** *Observability:* how do you trace a single user action that crosses REST → Kafka → gRPC boundaries? What must propagate, and how?

**QB5.** *The trap:* an interviewer says "just use Kafka for everything — it's scalable." Push back. Where is Kafka the *wrong* tool, and what do you lose?
