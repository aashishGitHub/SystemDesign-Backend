# Web Crawler (Google Search Indexer) — System Design Interview Guide

**Problem Number:** 9  
**Target Audience:** Senior (L5) and Staff (L6+) engineers interviewing at Google, Meta, Amazon, Microsoft  
**Estimated Study Time:** 8–12 hours across 3 passes  
**Difficulty:** Hard (common Staff screen) → Very Hard (Architect-level depth expected)  
**Special Note:** Google literally operates the world's largest web crawler. This is a first-party problem at Google interviews. Googlebot behavior, crawl budget, and the transition to JavaScript rendering are all fair game.

---

## How to Use This Guide (3-Pass Method)

| Pass | Time | Goal | Files |
|------|------|------|-------|
| **Pass 1 — Orientation** | 45 min | Understand the problem space, constraints, and tradeoffs at a high level | `README.md` → `deep-dive.md` §1–2 |
| **Pass 2 — Drill** | 3–4 hrs | Work through every question blind (cover answers), then self-grade | `questions.md` → `answers.md` |
| **Pass 3 — Simulate** | 45 min | Whiteboard a full design in 45 min. Use the cheat sheet only for numbers | `deep-dive.md` Quick Recall Cheat Sheet |

**Pro tip:** On Pass 2, speak your answers aloud — especially capacity math. Interviewers at Google and Meta expect you to derive numbers from first principles, not memorize them.

---

## Learning Path (8 Levels)

| Level | Theme | Mastery Signal |
|-------|-------|----------------|
| **L1 — Fundamentals** | What a crawler does, the basic crawl loop, BFS vs DFS | Can walk through a single-machine crawl loop end-to-end |
| **L2 — URL Frontier Design** | Priority queue, freshness scoring, PageRank weighting | Can design a frontier that prioritizes high-value pages |
| **L3 — Deduplication** | Bloom filter math, SimHash for near-duplicates, URL normalization | Can explain false positive rate formula and memory sizing |
| **L4 — Politeness & robots.txt** | Per-domain rate limiting, crawl-delay, back-off, robots.txt caching | Can implement per-domain throttling without starving workers |
| **L5 — Distributed Architecture** | Consistent hashing for URL assignment, worker coordination | Can partition crawl work across 500+ workers correctly |
| **L6 — DNS & Network** | DNS caching, resolver pools, TTL, connection reuse | Can explain why naive DNS resolution kills crawler throughput |
| **L7 — Content Processing** | HTML parsing, link extraction, SimHash deduplication, storage | Can design the pipeline from raw HTTP response to indexed content |
| **L8 — Architect-Level** | Spider traps, re-crawl scheduling, 100TB/day storage, JS rendering | Can reason about Googlebot's production design decisions |

---

## Files in This Guide

| File | Purpose | Lines |
|------|---------|-------|
| `README.md` | Orientation, learning path, problem statement, senior mindset | ~130 |
| `questions.md` | 38 interview questions across 8 levels + bonus senior questions | ~250 |
| `answers.md` | Full answers with TypeScript code, ASCII architecture, cheat sheet | ~1100 |
| `deep-dive.md` | 8 deep-dive sections: analogy + code + failure modes per topic | ~1300 |

---

## Problem Statement

Design a web crawler that indexes the entire web. Starting from a set of seed URLs, it should crawl web pages, extract links, and store the content for a search indexing pipeline.

**Core Behavior:**
- Accept a set of seed URLs (e.g., Alexa top 1M domains)
- Fetch each URL via HTTP/HTTPS, parse the HTML response
- Extract all outgoing hyperlinks (`<a href="...">`)
- Add newly discovered URLs to the crawl queue if not already seen
- Store raw HTML content and metadata for downstream indexing
- Respect `robots.txt` and per-domain politeness rules
- Continuously re-crawl the web to maintain freshness

### Exact Constraints

| Constraint | Value | Notes |
|-----------|-------|-------|
| Target crawl rate | 1 billion pages/day | ~11,600 pages/sec sustained |
| Indexable web size | ~50 billion pages | Full crawl takes ~50 days at target rate |
| Re-crawl: high priority | Every 24 hours | News sites, high-churn content |
| Re-crawl: low priority | Every 30 days | Static docs, rarely-updated pages |
| Politeness | Max 1 req/domain/sec | Must respect `robots.txt` crawl-delay |
| Average page size | 100 KB | Compressed HTML + headers |
| Raw storage per day | 100 TB/day | 100 KB × 1B pages |
| Unique URLs in history | ~5 trillion | Must deduplicate across all crawl history |
| DNS lookups | ~10M unique domains | Must cache aggressively |
| Availability target | 99.9% | Crawl can degrade gracefully; indexer cannot |

### Non-Functional Requirements (Senior-level scope)
- Politeness: honor `robots.txt`, `crawl-delay`, and HTTP 429/503 back-off
- Deduplication: avoid re-crawling identical content at different URLs
- Trap avoidance: detect infinite-loop pages and URL parameter spam
- Freshness: prioritize re-crawling high-churn pages (news, social)
- JavaScript rendering: handle SPAs (React, Angular) that require JS execution
- Fault tolerance: worker crashes must not lose URL frontier progress
- Distributed: horizontally scalable to 500+ crawler workers

---

## How a Senior Engineer Thinks About This

A senior engineer immediately recognizes that **the URL frontier is the central design problem**. Naively, a crawler is just BFS over a graph — but the web graph has 50 billion nodes, infinite cycles (spider traps), and wildly uneven importance distribution. The frontier cannot just be a FIFO queue. It must encode priority (PageRank-weighted importance), freshness (when was this URL last crawled, how often does it change), and politeness constraints (no more than 1 req/domain/sec). Getting the frontier design wrong means either crawling low-value pages at the expense of high-value ones, or violating politeness and getting your IP blocked.

The second insight is the **scale of deduplication**. With 5 trillion URLs seen in crawl history, a naive hash set is impossible — 5 trillion 64-bit hashes = 40 TB of memory. The canonical solution is a Bloom filter: 5 trillion entries at 10 bits/entry = 6.25 TB — still large, but shardable. The math matters in a Google interview. You must know the false positive rate formula `(1 - e^(-kn/m))^k`, the optimal hash count `k = (m/n) * ln(2)`, and the practical implication: a 0.1% false positive rate means you miss crawling ~5 billion real pages — an acceptable tradeoff vs the cost of perfect deduplication. Near-duplicate content (same article, different URL parameters) requires a second layer: SimHash or MinHash over document content.

The third insight is that **politeness is an architectural constraint, not an afterthought**. With 10 million unique domains and a 1 req/domain/sec limit, you have a hard constraint: at any given moment, any one worker can only have one in-flight request per domain. This forces a separation of concerns: URL scheduling (which URLs to fetch) from URL assignment (which worker fetches which URL). Consistent hashing on the domain name is the standard solution — all URLs for `nytimes.com` go to worker shard 17, which maintains a per-domain rate limiter and a local politeness queue. This also means DNS lookups for a domain are localized to one worker shard, improving cache hit rates.

---

## Related Problems

| Problem | Connection |
|---------|-----------|
| **URL Shortener** | URL normalization and deduplication techniques overlap |
| **Search Autocomplete** | Downstream consumer of the crawled index |
| **Distributed Caching** | DNS cache design, robots.txt cache design |
| **Message Queues** | URL frontier is essentially a distributed priority queue |
| **Rate Limiting** | Per-domain politeness is rate limiting applied to outbound requests |
