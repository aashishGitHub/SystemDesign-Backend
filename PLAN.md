# Distributed system design plan (P1) — architect-literate, not backend specialist

Part of the career plan: [AI/career](https://github.com/aashishGitHub/AI/tree/main/career).
Target: pass the one distributed-design round in a Senior/Staff frontend or fullstack loop. Use AWS primitives in every design.
Existing deep material: [interviews/ROADMAP.md](interviews/ROADMAP.md) and one folder per topic in [interviews/](interviews/). Rapid-fire QnA: [QNA-distributed-rapid-fire.md](QNA-distributed-rapid-fire.md).

Primary course: **DesignGurus — "Grokking the System Design Interview"** (you also have Vol II) + "Grokking the Advanced System Design Interview" (verify names in your dashboard).

## 12 classics, 1 per week (start 15 Nov)
| # | Design | Folder | Why for you | Done |
|---|---|---|---|---|
| 1 | Rate limiter | [interviews/rate-limiting](interviews/rate-limiting) | Most common; token bucket vs sliding window | ☐ |
| 2 | Notification service | [interviews/notification-system](interviews/notification-system) | Fan-out, queues, retries | ☐ |
| 3 | URL shortener | [interviews/url-shortener](interviews/url-shortener) | IDs, caching, read-heavy | ☐ |
| 4 | Distributed cache | [interviews/distributed-caching](interviews/distributed-caching) | Eviction, consistency | ☐ |
| 5 | Chat system | [interviews/chat-system](interviews/chat-system) | WebSocket, presence, ordering | ☐ |
| 6 | News feed | [interviews/social-feed](interviews/social-feed) | Fan-out on write vs read | ☐ |
| 7 | Search autocomplete | [interviews/search-autocomplete](interviews/search-autocomplete) | Bridges to the FE round | ☐ |
| 8 | Real-time updates (SSE) | [interviews/sse](interviews/sse) | Your Couchbase story | ☐ |
| 9 | Message queue / event bus | [interviews/message-queues](interviews/message-queues) | Delivery semantics | ☐ |
| 10 | Collaborative editing | [interviews/collaborative-editing](interviews/collaborative-editing) | OT vs CRDT | ☐ |
| 11 | Payment system | [interviews/payment-system](interviews/payment-system) | Idempotency, exactly-once myths | ☐ |
| 12 | RAG / AI search service | [AI/interviews/rag-hybrid-search](https://github.com/aashishGitHub/AI/tree/main/interviews/rag-hybrid-search) | Your differentiator | ☐ |

## Per design, produce
A one-page summary: requirements, back-of-envelope numbers, API, data model, diagram, 3 trade-offs, failure modes, AWS mapping. Then one free Claude/Gemini mock, scored.

## 45-minute structure
Requirements + scale (5) → API (5) → high-level design (10) → data model + storage choice (8) → deep dive on 1–2 components (10) → bottlenecks, failure modes, trade-offs (7).
