# Search Autocomplete / Typeahead — System Design Interview Guide

**Target Audience:** Senior (L5) and Staff (L6+) engineers interviewing at Google, Meta, Amazon, Microsoft  
**Estimated Study Time:** 8–12 hours across 3 passes  
**Difficulty:** Hard (Google screen / onsite core topic) → Very Hard (Staff-level distributed trie depth expected)

> Google uses this problem verbatim in SWE and SRE onsite rounds. Amazon surfaces it as part of the search platform design loop. Meta asks the personalization variant. Knowing only the trie is not enough — you must walk through the full update pipeline and distributed read path.

---

## How to Use This Guide (3-Pass Method)

| Pass | Time | Goal | Files |
|------|------|------|-------|
| **Pass 1 — Orientation** | 45 min | Understand the problem space, data flow, and key tradeoffs at a high level | `README.md` → `deep-dive.md` §1–2 |
| **Pass 2 — Drill** | 3–4 hrs | Work every question blind (cover answers), speak your answer aloud, then self-grade | `questions.md` → `answers.md` |
| **Pass 3 — Simulate** | 45 min | Whiteboard the full system in 45 min — read/write paths, aggregation pipeline, failure modes | `deep-dive.md` Quick Recall Cheat Sheet |

**Pro tip:** On Pass 2, draw the trie, Redis cache, and Kafka pipeline on a whiteboard *before* you read the answer. Communication, not just correctness, is evaluated.

---

## Learning Path (8 Levels)

| Level | Theme | Mastery Signal |
|-------|-------|----------------|
| **L1 — Fundamentals & Data Structures** | What autocomplete is, why it is hard, trie structure and complexity | Can explain prefix lookup vs hash lookup tradeoffs to a non-engineer |
| **L2 — Trie Design** | Node structure, insert/search, memory footprint, top-K storage per node | Can implement a trie node in TypeScript with top-K stored inline and explain the space tradeoff |
| **L3 — Top-K Storage & Retrieval** | Storing top-K at each node vs DFS traversal, heap maintenance, score decay | Can quantify the memory cost of top-K storage vs traversal cost at scale |
| **L4 — Update Pipeline** | Raw search logs → frequency counts → trie rebuild; batch vs real-time; Kafka + Spark/Flink | Can design the full data pipeline with SLA: trending queries surfaced in < 1 hour |
| **L5 — Distributed Scale** | Sharding the trie, partition strategies, cache layer (Redis), read path design | Can explain why a trie alone is too slow at 5K req/sec and design the Redis cache layer |
| **L6 — Personalization & Filtering** | Per-user recent searches, global vs personal ranking, profanity/legal filtering | Can explain when to blend global top-K with personal signals without violating privacy |
| **L7 — Operations & Failure Modes** | Trie update lag during breaking news, stale cache, cache stampede, graceful degradation | Can name three failure modes and give concrete mitigations with numbers |
| **L8 — Architect-Level** | Capacity math, SLO design, multi-region, Google Suggest architecture deep-dive | Can size a distributed trie cluster and defend SLO choices with capacity math |

---

## Files in This Guide

| File | Purpose | Lines |
|------|---------|-------|
| `README.md` | Orientation, learning path, problem statement, senior mental model | ~130 |
| `questions.md` | 38 interview questions across 8 levels + 3 bonus unprompted questions | ~230 |
| `answers.md` | Full answers with TypeScript code, comparison tables, pipeline diagrams, cheat sheet | ~900 |
| `deep-dive.md` | 8 deep-dive sections at 3 depths (beginner/senior/architect) + capacity math + cheat sheet | ~1100 |

---

## Problem Statement

Design the search autocomplete system (typeahead) for a major search engine. As a user types a query, show up to 5 suggestions in under 100ms that match the prefix typed so far.

### Core Behavior

- User types "prog" → system returns `["programming", "programmer", "program", "programming tutorial", "programming languages"]`
- Each keystroke fires a suggestion request (with frontend debouncing)
- Suggestions are ranked by global query popularity (and optionally personal history)
- Trending queries (e.g., "earthquake [city]") must appear in suggestions within 1 hour of becoming popular

### Exact Constraints

| Constraint | Value | Notes |
|-----------|-------|-------|
| DAU | 10 million | Active users triggering autocomplete |
| Queries per user per day | 5 | Average across search sessions |
| Total queries per day | 50 million | = 10M × 5 |
| Average QPS | 580 req/sec | = 50M / 86,400 |
| Peak QPS | 5,000 req/sec | ~8.6× average; breaking news spike |
| Suggestions per request | 5 | Top-K = 5 |
| Suggestion latency SLO | < 100ms P99 | End-to-end, including network |
| Trending update SLA | ≤ 1 hour | Trending query appears in suggestions |
| Unique prefixes covered | 10 million | Based on historical query data |
| Trie node count (estimate) | ~50 million nodes | Average 5 nodes per unique query |
| Availability target | 99.9% | ~8.7 hours downtime/year |

### Non-Functional Requirements (Senior-level scope)

- Suggestions must degrade gracefully if the trie update pipeline is delayed
- Personalized suggestions blended with global top-K for logged-in users
- Profanity, hate speech, and legally mandated query filtering
- Multi-language support: at minimum English, Spanish, Mandarin, Arabic
- Analytics: clickthrough rate on autocomplete suggestions to improve ranking models
- Frontend debouncing: no request fired until user pauses ≥ 300ms or explicitly waits

---

## How a Senior Engineer Thinks About This

The first thing a senior engineer recognizes is that **the interview question has two completely separate design problems**: the *read path* (returning 5 suggestions in < 100ms) and the *write path* (keeping those suggestions accurate within 1 hour). Most candidates spend all their time on the trie data structure and never get to the write path, which is where Google actually differentiates its system. The read path is mostly a caching problem once you understand that a raw trie traversal at scale is far too slow. The write path is a distributed data pipeline problem involving Kafka, stream processing, and trie consistency.

The second key insight is about **top-K storage strategy**. A naive trie requires a DFS traversal to find the top-5 suggestions for any prefix — at 10M unique prefixes, that traversal is prohibitively slow. The production approach is to pre-compute and store the top-K suggestions directly in each prefix node of the trie. When a user types "prog", the node for "prog" immediately returns its stored top-5 list without any traversal. The tradeoff is memory: storing top-5 strings in every node multiplies memory usage by roughly 5×. For 50M nodes each holding 5 strings averaging 20 bytes, that is ~5 GB — totally acceptable. This pre-computation is what makes < 100ms P99 feasible.

The third thing a senior engineer understands is the **asymmetry between stable and trending queries**. Google Suggest serves two query populations: "stable" queries (e.g., "how to make pasta") that change very slowly and can be batch-updated daily, and "trending" queries (e.g., "Super Bowl score") that must appear in suggestions within minutes of a news event. These two populations require different update pipelines. Stable queries use a nightly Spark batch job that rebuilds the full trie from 30-day rolling query logs. Trending queries use a real-time Flink job that monitors a 15-minute sliding window of query frequencies and injects high-velocity queries into the trie hot-path. Understanding this bifurcation is the difference between a passing answer and a hire answer at Google.
