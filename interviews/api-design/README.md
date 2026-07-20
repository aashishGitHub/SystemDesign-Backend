# System Design: API Design (REST vs GraphQL vs gRPC)

> **Target:** Senior / Staff backend engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended design choices.

---

## How to Use This Guide

1. Attempt each question in `questions.md` without opening answers.
2. Check your reasoning in `answers.md`.
3. Use `deep-dive.md` to practice senior/staff depth, failure modes, and production tradeoffs.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Contracts | What makes a good API, REST principles, HTTP semantics |
| 2 | REST Deep Mechanics | Idempotency, status codes, resource modeling, HATEOAS |
| 3 | Versioning & Evolution | URL vs header versioning, backward compatibility, deprecation |
| 4 | Pagination & Filtering | Cursor vs offset vs keyset, filtering patterns, partial responses |
| 5 | GraphQL Internals | Schema design, N+1, DataLoader, subscriptions, overfetching |
| 6 | gRPC & Protobuf | Streaming modes, service contracts, when gRPC beats REST |
| 7 | API Gateway & Security | Auth patterns, rate limiting, request validation, gateway design |
| 8 | Production Operations | Observability, backward compatibility, deprecation, incident patterns |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 34 structured interview questions (8 levels + bonus). |
| [answers.md](./answers.md) | Answers keyed to each question, with code/table per answer. |
| [deep-dive.md](./deep-dive.md) | Beginner → Senior → Architect depth, failure modes, and cheat sheet. |

---

## Problem Statement

> Design the API layer for a public-facing platform that serves mobile clients, web applications, third-party integrations, and internal microservices.
>
> The API must support:
> - multiple consumer types (mobile, web, third-party, internal services)
> - evolution without breaking existing clients
> - efficient data fetching (no over-fetching or under-fetching)
> - high-performance internal service-to-service communication
> - security, observability, and rate limiting at the API boundary

**Key Constraints:**
- **Consumer diversity:** mobile apps on slow networks, web SPAs, partner integrations, internal microservices
- **Scale:** 500k+ API calls/sec across all consumers
- **Availability:** API gateway must not be a single point of failure
- **Backward compatibility:** existing clients must never break on deploy
- **Latency:** p99 < 100ms for reads, < 500ms for writes at the gateway

---

## How a Senior Engineer Thinks About This

A strong answer recognizes that API design is not "REST vs GraphQL vs gRPC" — it's about matching the right protocol to the right consumer and use case. A senior engineer designs a **multi-protocol API surface** where REST serves public/external consumers, GraphQL serves frontend teams needing flexible queries, and gRPC serves internal service-to-service calls.

Next, they separate API **contract** from **implementation**. The contract (resource models, status codes, versioning, pagination) is the public surface that must remain stable. The implementation behind the gateway can change freely. This separation is what enables safe evolution.

Finally, they think about the API as a **product boundary**: it's where authentication, authorization, validation, rate limiting, and observability all converge. A well-designed API isn't just "correct endpoints" — it's idempotent writes, predictable error contracts, pagination that scales, and deprecation that doesn't break production clients.

---

## Related Topics

This topic is the **deep dive for the synchronous half** of inter-service communication. For the bird's-eye map of where REST/gRPC/GraphQL sit relative to async messaging, start at the umbrella topic.

- [Communication & Messaging Protocols](../communication-protocols/) — the umbrella: sync vs async decision tree, plus AMQP/Kafka/AWS/WebSockets that this topic doesn't cover
- [Message Queues & Event Streaming](../message-queues/) — the asynchronous counterpart (Kafka, RabbitMQ, SQS, outbox, exactly-once)
- [Rate Limiting](../rate-limiting/) — enforcing limits at the API boundary
- [Notification System](../notification-system/) — a concrete system built on these API patterns
