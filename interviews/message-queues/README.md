# System Design: Message Queues & Event Streaming

> **Target:** Senior / Staff backend engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended implementation choices.

---

## How to Use This Guide

1. Attempt each question in `questions.md` without opening answers.
2. Check your reasoning in `answers.md`.
3. Use `deep-dive.md` to practice senior/staff depth, failure modes, and production tradeoffs.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Motivation | Why async messaging exists, decoupling, backpressure |
| 2 | Messaging Models | Point-to-point vs pub-sub, topics vs queues |
| 3 | Delivery Guarantees | At-most-once, at-least-once, exactly-once semantics |
| 4 | Kafka Deep Dive | Partitions, consumer groups, offsets, replication |
| 5 | Other Queue Technologies | RabbitMQ, SQS, Pulsar — when to use each |
| 6 | Reliability Patterns | Outbox, idempotency, dead letter queues, retries |
| 7 | Stream Processing | Kafka Streams, Flink, windowing, stateful processing |
| 8 | Production Operations | Capacity planning, monitoring, partition rebalancing |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 40+ structured interview questions (8 levels + bonus). |
| [answers.md](./answers.md) | Answers keyed to each question, with code/table per answer. |
| [deep-dive.md](./deep-dive.md) | Beginner → Senior → Architect depth, failure modes, and cheat sheet. |

---

## Problem Statement

> Your e-commerce platform processes 10,000 orders per minute at peak. The order service currently makes synchronous calls to inventory, payment, shipping, and notification services. When any downstream service is slow or down, the entire checkout fails.
>
> Design an event-driven architecture using message queues that:
> - decouples producers from consumers
> - guarantees every order is processed exactly once
> - handles 100K events/sec with < 100ms end-to-end latency for critical paths
> - survives broker failures without losing events

**Key Constraints:**
- Peak event throughput: **100K events/sec**
- End-to-end latency (critical path): **< 100ms**
- Event retention: **7 days** (replay capability)
- Delivery guarantee: **exactly-once** for payments, **at-least-once** for notifications
- Availability: **99.99%** (52 minutes downtime/year max)

---

## How a Senior Engineer Thinks About This

A strong answer starts by identifying **why async messaging** — it's not about speed, it's about **decoupling, resilience, and independent scaling**. Synchronous chains fail cascadingly; async systems degrade gracefully.

Next, they choose the messaging model by use case: **point-to-point queues** for work distribution (one consumer per message), **pub-sub topics** for event broadcasting (many consumers per event). They know Kafka is a commit log (replay, ordering), while RabbitMQ is a traditional broker (routing, acks).

Finally, they reason about **failure at every step**: producer fails after send but before ack (duplicate risk), consumer fails after processing but before commit (reprocessing), broker fails mid-write (data loss). A senior design includes idempotency keys, transactional outbox, dead letter queues, and consumer group rebalancing strategies.

---

## Related Topics

This topic is the **deep dive for the asynchronous half** of inter-service communication. For the bird's-eye map of where Kafka/RabbitMQ/SQS sit relative to synchronous request/response, start at the umbrella topic.

- [Communication & Messaging Protocols](../communication-protocols/) — the umbrella: sync vs async decision tree, plus REST/gRPC/GraphQL/WebSockets and AWS SNS/EventBridge framing
- [API Design (REST/GraphQL/gRPC)](../api-design/) — the synchronous counterpart
- [Chat System](../chat-system/) — queues + WebSockets applied to real-time messaging
- [Notification System](../notification-system/) — per-channel queues, fan-out, and DLQs in a concrete system
