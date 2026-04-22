# Interview Questions: Message Queues & Event Streaming

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.

---

## Level 1 — Fundamentals & Motivation
*Goal: verify you understand why async messaging exists and its core benefits.*

**Q1.** Why would you introduce a message queue between two services instead of direct HTTP calls? What problems does it solve?

**Q2.** What is the difference between synchronous and asynchronous communication? Give an example where async is clearly better.

**Q3.** What is "decoupling" in the context of message queues, and why is it valuable?

**Q4.** What is backpressure, and how do message queues help manage it?

---

## Level 2 — Messaging Models
*Goal: distinguish between queue types and messaging patterns.*

**Q5.** What is the difference between point-to-point (queue) and publish-subscribe (topic) messaging?

**Q6.** When would you use a queue vs a topic? Give a concrete example for each.

**Q7.** What is a consumer group in Kafka, and what problem does it solve?

**Q8.** In pub-sub messaging, what happens if a subscriber is offline when a message is published?

**Q9.** What is a fan-out pattern in messaging? When is it useful?

---

## Level 3 — Delivery Guarantees
*Goal: understand the tradeoffs between delivery semantics.*

**Q10.** What are the three delivery guarantees (at-most-once, at-least-once, exactly-once)? Define each precisely.

**Q11.** Why is exactly-once delivery considered hard or even "impossible" in distributed systems?

**Q12.** Your payment service uses at-least-once delivery. A customer is charged twice for the same order. What happened, and how do you prevent it?

**Q13.** How does Kafka achieve exactly-once semantics (EOS)? What are the requirements?

**Q14.** What is idempotency, and why is it essential for at-least-once delivery?

---

## Level 4 — Kafka Deep Dive
*Goal: master Kafka's architecture and operational model.*

**Q15.** Explain Kafka's core architecture: brokers, topics, partitions, and segments.

**Q16.** How does Kafka achieve message ordering? At what level is ordering guaranteed?

**Q17.** What is a partition key, and how does it affect message distribution and ordering?

**Q18.** Explain Kafka's offset mechanism. What is the difference between committed offset and current offset?

**Q19.** How does Kafka replicate data for fault tolerance? What are ISR (In-Sync Replicas) and ACKs?

**Q20.** What is the role of ZooKeeper in Kafka? What does KRaft mode change?

**Q21.** A consumer falls behind by 10 million messages. What is this called, and how do you remediate?

**Q22.** What is log compaction in Kafka, and when would you use it?

---

## Level 5 — Other Queue Technologies
*Goal: compare technologies and choose the right one for the job.*

**Q23.** Compare Kafka, RabbitMQ, and AWS SQS across these dimensions: ordering, persistence, throughput, and operational complexity.

**Q24.** When would you choose RabbitMQ over Kafka?

**Q25.** When would you choose AWS SQS over self-managed Kafka?

**Q26.** What is Apache Pulsar, and what advantages does it claim over Kafka?

**Q27.** Your team is building a job processing system where each job must be processed by exactly one worker. Which queue technology fits best and why?

---

## Level 6 — Reliability Patterns
*Goal: build reliable event-driven systems.*

**Q28.** What is the transactional outbox pattern? Why is dual-write (DB + queue) problematic?

**Q29.** Explain how to implement the transactional outbox pattern step by step.

**Q30.** What is a dead letter queue (DLQ)? When should messages go there?

**Q31.** Design a retry strategy with exponential backoff for a consumer that processes payment webhooks.

**Q32.** What is event sourcing? How does it differ from traditional state storage + event emission?

**Q33.** How do you handle poison messages (messages that always fail processing)?

---

## Level 7 — Stream Processing
*Goal: process event streams in real-time with stateful operations.*

**Q34.** What is stream processing, and how does it differ from batch processing?

**Q35.** Explain windowing in stream processing. What are tumbling, sliding, and session windows?

**Q36.** What is exactly-once processing in Kafka Streams, and how does it work?

**Q37.** You need to join two Kafka topics (orders and payments) in real-time. How do you handle the timing mismatch?

**Q38.** What are watermarks in stream processing, and why are they needed?

**Q39.** Compare Kafka Streams vs Apache Flink. When would you choose each?

---

## Level 8 — Architect / Production Operations
*Goal: design and operate messaging systems at scale.*

**Q40.** How do you size a Kafka cluster for 100K messages/sec with 1KB average message size?

**Q41.** What metrics should you monitor for a production Kafka cluster? List at least 8.

**Q42.** A partition is under-replicated. What does this mean, and what is the impact?

**Q43.** What is consumer group rebalancing, and how can it cause processing delays?

**Q44.** Design an event-driven architecture for an e-commerce order flow: order placed → inventory reserved → payment charged → shipment created → notification sent. Include failure handling for each step.

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** How do you handle schema evolution in an event-driven system? What is a schema registry?

**QB2.** What is the difference between event-carried state transfer and event notification patterns?

**QB3.** How do you implement distributed transactions across multiple services using events (Saga pattern)?

**QB4.** What is the "dual-write problem" and why does the outbox pattern solve it?

**QB5.** How do you migrate from one messaging system to another (e.g., RabbitMQ to Kafka) without downtime?

**QB6.** What is change data capture (CDC), and how does it relate to event streaming?
