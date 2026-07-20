# System Design: Communication & Messaging Protocols (REST · gRPC · GraphQL · AMQP · Kafka · AWS · WebSockets)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.

---

## Why This Topic Exists (Read This First)

This is the **umbrella topic** for *how services talk to each other*. It exists because the single most common opening move in a backend system-design interview is choosing a communication style — and a weak candidate reaches for REST by reflex every time.

It is intentionally **breadth-first**. It covers the entire surface — synchronous (HTTP, REST, gRPC, GraphQL, WebSockets) and asynchronous (AMQP/RabbitMQ, Kafka, AWS SQS/SNS/EventBridge, Kinesis) — so you can sit down before an interview and revise *the whole decision space in one place*. When a section needs depth beyond survey level, it **links out** to the topic that already goes deep, rather than duplicating it:

| When you need depth on… | Go to |
|---|---|
| REST mechanics, gRPC/protobuf internals, GraphQL N+1/DataLoader, pagination, versioning | [`api-design/`](../api-design/) |
| Kafka partitions/offsets, RabbitMQ vs SQS vs Pulsar, outbox, exactly-once, stream processing | [`message-queues/`](../message-queues/) |
| WebSocket connection management at scale, presence, fan-out | [`chat-system/`](../chat-system/) |
| SSE transport specifics and reconnection | [`sse/`](../sse/) |
| Push/Email/SMS dispatch built *on top* of these protocols | [`notification-system/`](../notification-system/) |

**Mental model:** this topic is the *map*. The topics above are the *territory*.

---

## How to Use This Guide

1. First pass — attempt every question yourself before reading the answer.
2. Second pass — read the answers, compare, note what you missed.
3. Third pass — whiteboard the protocol-selection decision tree from memory. No notes.
4. Pre-interview — run [`grill-me.md`](./grill-me.md) out loud; it forces you to *defend* a choice, not just recite it.

---

## Learning Path

| Level | Topic | You'll Learn |
|-------|-------|-------------|
| 1 | Communication Foundations | Sync vs async, coupling, and the protocol-selection decision tree |
| 2 | HTTP Fundamentals | URIs, methods, safe/idempotent semantics, headers, HTTP/1.1 → 2 → 3 |
| 3 | REST | Statelessness, caching (ETag), URI design, versioning, idempotency keys |
| 4 | gRPC & Protobuf | RPC over HTTP/2, streaming modes, field-number compatibility, AWS deployment |
| 5 | GraphQL | Queries/mutations/subscriptions, resolvers, over/under-fetching, N+1 |
| 6 | AMQP & RabbitMQ | Exchanges, bindings, routing vs binding keys, channels, queues vs streams |
| 7 | Kafka, Event Sourcing & Streaming | Topics/partitions/consumer groups, commit log vs queue, Kinesis vs Kafka |
| 8 | AWS Managed Messaging | SQS (Standard/FIFO), SNS (A2A/A2P, fan-out), EventBridge, DLQs |
| 9 | WebSockets & Real-Time Transport | Full-duplex handshake, WS vs SSE vs Long Polling, WS vs Kafka |
| 10 | Reliability & Cross-Cutting | Exactly-once myth, duplicate handling, idempotency, the "which tech" cheat |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | All questions, organized by level. Read first. |
| [answers.md](./answers.md) | Full answers with code examples and tradeoff tables + cheat sheet. |
| [conducive-sentences.md](./conducive-sentences.md) | Every answer rewritten as plain-English connected prose — read to *understand*, not just recall. |
| [deep-dive.md](./deep-dive.md) | Beginner 🟢 → Senior 🟡 → Architect 🔴 depth, failure modes, capacity math. |
| [diagrams.md](./diagrams.md) | Mermaid diagrams — protocol decision tree, AMQP routing, Kafka groups, fan-out. |
| [grill-me.md](./grill-me.md) | Relentless branching Q&A — defend each choice under pressure. |
| [glossary.md](./glossary.md) | Definitions for niche terms in deep-dive.md — `Vary`, `stale-while-revalidate`, `mTLS`, `KRaft`, Debezium, `W3C traceparent`, and more. |

---

## The Problem Statement

> You are the architect for a platform of ~40 microservices plus mobile, web, and third-party clients. Design the **communication fabric**: which protocol each interaction uses, why, and how it fails safely.
>
> Concretely, the platform must support:
> - public CRUD APIs for external consumers and partners
> - low-latency, high-volume internal service-to-service calls
> - flexible data fetching for mobile/web frontends on variable networks
> - asynchronous task processing and work distribution that survives a slow/down consumer
> - high-throughput event streaming for analytics and event sourcing
> - fan-out notifications to many subscribers
> - real-time, bidirectional client updates

**Key Constraints:**
- **No single protocol fits everything** — the answer is a *multi-protocol surface*, justified per interaction.
- A slow or failed downstream must **not cascade** into caller failure (decoupling where it matters).
- Retries are inevitable → the design must be **safe under at-least-once delivery** (idempotency).
- Contracts must **evolve without breaking existing clients** (versioning, protobuf field numbers, schema registry).
- Each transport must be **securable, observable, and back-pressure-aware**.

---

## How a Senior Engineer Thinks About This

The first move is to **reject "REST for everything."** A strong candidate frames the whole problem along one axis — *does the caller need the answer right now to make progress?* If yes, it's synchronous request/response (REST, gRPC, GraphQL). If no — if the work can be handed off and confirmed later — it's asynchronous messaging (a queue or an event stream). Getting this axis right is worth more than any single protocol detail, because picking sync where async belonged is what creates cascading outages.

The second move is to **match protocol to consumer, not to fashion.** REST for public/partner APIs because it's universal, cacheable, and debuggable. gRPC for internal service-to-service because protobuf + HTTP/2 give low latency and strict contracts. GraphQL for frontend teams that need to shape their own payloads and avoid N round-trips. A message broker (RabbitMQ/SQS) for work distribution and routing. A commit log (Kafka/Kinesis) for high-throughput, replayable event streams. WebSockets for genuinely bidirectional real-time. The skill is justifying each choice with the *constraint it satisfies*, not the buzzword.

The third move is to **assume failure and retries from the start.** Across a network you cannot get true exactly-once delivery, so you design for at-least-once and make consumers idempotent — idempotency keys for payment APIs, dedup on message IDs for queues, stable protobuf field numbers and a schema registry so a producer change doesn't break a consumer mid-flight. The candidate who says "we'll do exactly-once" loses; the one who says "at-least-once plus idempotency, and here's where the dedup lives" wins.

---

## Related Topics

- [API Design (REST/GraphQL/gRPC)](../api-design/) — the deep dive for the *synchronous* half of this topic
- [Message Queues & Event Streaming](../message-queues/) — the deep dive for the *asynchronous* half (Kafka, RabbitMQ, SQS, outbox, exactly-once)
- [Chat System](../chat-system/) — WebSocket management, presence, and fan-out at scale
- [Server-Sent Events](../sse/) — SSE transport mechanics and reconnection
- [Notification System](../notification-system/) — push/email/SMS dispatch built on top of these protocols
- [Rate Limiting](../rate-limiting/) — protecting any of these surfaces from abuse
