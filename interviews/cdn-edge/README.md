# System Design: CDN & Edge Computing (Pattern 6)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Netflix
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.
> **Pattern type:** Foundational building block — referenced in video streaming, social feed, file storage, API design.

---

## How to Use This Guide

1. **First pass** — attempt every question yourself before reading the answer. Treat the constraints as real. Time-box yourself to 2 minutes per question.
2. **Second pass** — read the answers, compare against your attempt, mark what you missed. Pay attention to every table and capacity math block.
3. **Third pass** — whiteboard the full CDN architecture from scratch: routing, caching, purge, edge functions, multi-CDN. No notes. Explain it out loud.

---

## Learning Path

| Level | Topic | You Will Learn |
|-------|-------|----------------|
| 1 | Fundamentals | What a CDN is, latency math, RTT to origin vs edge PoP |
| 2 | Routing & PoP Selection | Anycast BGP, GeoDNS, latency-based DNS, how a request finds the nearest edge |
| 3 | Cache Strategy | Push vs Pull CDN, Cache-Control headers, TTL by content type |
| 4 | Invalidation & Purging | URL purge, surrogate keys, propagation guarantees |
| 5 | Edge Functions | Cloudflare Workers, Lambda@Edge — what they can do, where they fail |
| 6 | Video Delivery | HLS chunked delivery, byte-range requests, segment caching |
| 7 | Multi-CDN & Resilience | Netflix's 3-CDN strategy, failover, traffic steering |
| 8 | Architect-level | End-to-end design, capacity math, failure modes, real incidents |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | 35+ questions organized by level. Attempt before reading answers. |
| [answers.md](./answers.md) | Full answers with HTTP headers, config snippets, tradeoff tables, real incidents. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations at beginner, senior, and architect depth — with capacity math. |

---

## Problem Statement

> You are designing the content delivery architecture for a global platform serving **500 million users across 190 countries**. Static assets, images, video segments, and API responses must all be served with minimal latency.

**Constraints:**

| Constraint | Value |
|---|---|
| Peak global request rate | 10 million requests/sec |
| P99 latency for static assets | < 50 ms from anywhere in the world |
| Cache hit ratio (static content) | > 95% |
| Cache purge propagation | < 30 seconds globally after content update |
| Origin capacity | 500K req/sec (CDN must absorb the remaining 9.5M) |
| Geographic spread | 190 countries, 6 continents |
| Content types | Static assets, images, video segments, HTML, API responses |

---

## How a Senior Engineer Thinks About This

The first move a strong candidate makes is **decomposing content by cacheability**. Static assets (JS, CSS, fonts, images) and video segments have completely different caching properties than HTML or API responses. Treating them the same leads to over-caching dynamic content (stale data bugs) or under-caching static content (missing the 95% hit ratio target). A mature design routes these through different CDN behaviors with different TTLs, different cache keys, and different invalidation strategies — and this separation is driven by Cache-Control headers on the origin response, not CDN-side rules.

The second thing a senior thinks about is **what happens on a cache miss**. At 10M req/sec with a 95% hit ratio, that is still 500K req/sec that hit origin — which is exactly the stated origin capacity limit. A single thundering-herd event (celebrity post going viral, new product launch) can spike cache misses for a URL that was never cached before and generate 10× origin load in seconds. The correct mitigations are: origin shield (mid-tier cache that absorbs the first miss per PoP cluster), request collapsing (hold concurrent misses for the same URL and make only one origin request), and stale-while-revalidate (serve stale content while the background revalidation runs). These three mechanisms working together are what makes 95% hit ratio realistic in production.

The third dimension a staff-level candidate addresses is **operational failure**. The Fastly CDN outage of June 2021 took down Amazon, Reddit, the New York Times, and the UK Government website simultaneously — for about an hour. A single customer configuration change triggered a latent bug in Fastly's Varnish configuration, which cascaded across all PoPs globally when triggered. The architectural lesson: a platform dependent on a single CDN vendor has no defense against CDN-layer bugs. Netflix's answer is running three CDNs simultaneously (Open Connect for ISP-embedded servers, Fastly for edge, and AWS CloudFront as fallback) with real-time traffic steering. The purge propagation constraint — < 30 seconds globally — is also a safety net for stale data bugs: if you can push an invalidation in 30 seconds, a caching mistake has a short blast radius.

---

## Why This Pattern Is Referenced Everywhere

CDN and edge computing is not a standalone problem — it is infrastructure that every large-scale system relies on:

| System Design Problem | CDN/Edge Role |
|---|---|
| Video streaming (YouTube, Netflix) | HLS segment caching, byte-range requests, ABR ladder delivery |
| Social feed (Instagram, Twitter) | Image/video CDN, HTML fragment caching via ESI |
| File storage (Dropbox, Google Drive) | Large object delivery, byte-range resume, signed URLs |
| E-commerce (Amazon, Shopify) | Product image serving, cart API edge caching, DDoS protection |
| API design (public REST/GraphQL) | Edge caching of GET responses, rate limiting at edge, auth offload |
| Web crawler / search indexing | robots.txt, CDN cache directives, Vary header behavior |

If you cannot explain CDN architecture fluently, you will struggle with all of these problems in a senior/staff interview.
