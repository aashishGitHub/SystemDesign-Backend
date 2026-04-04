# Interview Questions: API Design (REST vs GraphQL vs gRPC)

> Attempt all questions before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.

---

## Level 1 — Fundamentals & API Contracts
*Goal: verify core understanding of what an API is and why design matters.*

**Q1.** What is an API contract, and why is it more important than the implementation behind it?

**Q2.** What are the six REST architectural constraints, and which ones do most "REST" APIs actually violate?

**Q3.** What is the difference between a resource and an action, and how does this affect URL design?

**Q4.** Why should API error responses have a consistent, structured format — and what should that format include?

---

## Level 2 — REST Deep Mechanics
*Goal: design correct, idempotent, predictable REST endpoints.*

**Q5.** Which HTTP methods are idempotent, which are safe, and why does this matter for retries?

**Q6.** A client sends `POST /orders` and the network drops the response. The client retries. How do you prevent a duplicate order?

**Q7.** When should you return `200 OK` vs `201 Created` vs `202 Accepted` vs `204 No Content`?

**Q8.** How do you model a state transition (e.g., cancel an order) in REST — `PATCH /orders/:id`, `POST /orders/:id/cancel`, or `DELETE /orders/:id`?

---

## Level 3 — Versioning & API Evolution
*Goal: evolve APIs without breaking existing clients.*

**Q9.** URL-path versioning (`/v1/users`) vs header versioning (`Accept: application/vnd.api+json;v=2`) — what are the tradeoffs?

**Q10.** What is a backward-compatible change vs a breaking change? Give three examples of each.

**Q11.** How do you safely deprecate an API endpoint that 10,000 active clients still call?

**Q12.** You need to rename a field from `userName` to `username` in the response. How do you ship this without breaking clients?

---

## Level 4 — Pagination, Filtering & Partial Responses
*Goal: design APIs that perform well at scale for large data sets.*

**Q13.** Offset pagination (`?page=5&limit=20`) vs cursor pagination (`?cursor=abc123&limit=20`) — when does offset break?

**Q14.** How does keyset pagination work, and why is it faster than offset at page 10,000?

**Q15.** How do you design filtering for a search API with 15 possible filter parameters without the URL becoming unmanageable?

**Q16.** What are partial responses (field selection), and how do GraphQL and REST each solve the over-fetching problem?

---

## Level 5 — GraphQL Internals
*Goal: understand GraphQL mechanics, tradeoffs, and failure modes.*

**Q17.** What problem does GraphQL solve that REST cannot, and what new problems does it introduce?

**Q18.** What is the N+1 query problem in GraphQL, and how does DataLoader solve it?

**Q19.** How do you preve0po
\t a malicious GraphQL query from requesting 10 levels of nested data and crashing your server?

**Q20.** When should you NOT use GraphQL — give three concrete scenarios where REST or gRPC is clearly better?

---

## Level 6 — gRPC & Protocol Buffers
*Goal: understand gRPC mechanics, streaming, and when it beats REST.*

**Q21.** How does gRPC differ from REST at the protocol level, and why does this make it faster for service-to-service calls?

**Q22.** What are the four gRPC streaming modes, and give a real use case for each?

**Q23.** Why is gRPC a poor fit for browser clients, and what workarounds exist?

**Q24.** How does protobuf schema evolution (adding/removing fields) compare to JSON schema evolution?

---

## Level 7 — API Gateway & Security Patterns
*Goal: design the infrastructure layer that sits in front of all APIs.*

**Q25.** What responsibilities belong in an API gateway vs in the service itself?

**Q26.** How should authentication flow through a multi-service architecture — tokens at the gateway, or propagated per-service?

**Q27.** How do you implement idempotency keys at the API gateway level for payment-critical endpoints?

**Q28.** What is the Backend-for-Frontend (BFF) pattern, and when does it become necessary?

---

## Level 8 — Production Operations & Architect Tradeoffs
*Goal: show deep system thinking beyond textbook API design.*

**Q29.** How do you design API observability — what should every request log, and what alerts should fire?

**Q30.** A partner integration sends malformed JSON in 5% of requests, causing 500 errors. How do you fix this without breaking the partner?

**Q31.** You discover that 30% of your API traffic is from clients using a deprecated v1 endpoint. How do you force migration?

**Q32.** REST for external, GraphQL for web frontend, gRPC for internal — does this multi-protocol architecture work, and what are the operational costs?

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** How do we generate and enforce API contracts (OpenAPI spec, protobuf) as part of CI/CD so breaking changes are caught before deploy?

**QB2.** What is our API deprecation SLA — how much notice do clients get, and how do we enforce sunset dates?

**QB3.** How do we handle API versioning across microservices — does each service version independently or do we version the gateway?

**QB4.** What is our strategy for API documentation — auto-generated from spec, or manually maintained — and how do we keep it in sync?
