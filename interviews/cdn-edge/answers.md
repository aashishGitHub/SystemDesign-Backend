# Answers: CDN & Edge Computing (Pattern 6)

> Keyed to [questions.md](./questions.md). Read the questions and attempt them cold first.
> Code/config examples use HTTP headers, pseudocode, and TypeScript where helpful.
> ⚠️ Note on numbers: CDN PoP counts and vendor specifics change frequently. Figures below are **order-of-magnitude** for reasoning, not exact current values — verify against vendor docs before quoting.

---

## Level 1 — Fundamentals

### A1. What a CDN solves + the latency math
A CDN moves content **physically closer to the user** so requests don't cross the planet to your origin. The dominant cost in a request is round trips: TCP + TLS handshakes plus the request itself, and each round trip pays the network RTT.

A naive HTTPS request needs roughly: 1 RTT (TCP handshake) + 1–2 RTT (TLS 1.2 handshake; TLS 1.3 is 1 RTT) + 1 RTT (HTTP request/response) ≈ **~3–4 RTT** before the first byte.

- **Origin 120 ms away:** ~3.5 × 120 ms ≈ **~420 ms** to first byte.
- **Edge PoP 10 ms away:** ~3.5 × 10 ms ≈ **~35 ms** to first byte.

That's a **~12× reduction** in connection setup latency, before you even count faster throughput on the shorter path. The named tradeoff is **latency vs. freshness** — you win latency by serving a cached (possibly slightly stale) copy.

### A2. Point of Presence (PoP)
A **PoP** is a physical cluster of edge servers in a data center in a specific metro/region. When you resolve a CDN hostname, you're routed to the nearest PoP.

Approximate scale (order-of-magnitude, verify before quoting): Cloudflare advertises presence in **300+ cities**; Fastly runs **fewer, larger** POPs (dozens); Akamai claims the most locations (**thousands**, many embedded inside ISP networks). More PoPs mainly help **P99/P100 for users in poorly-connected regions** — the median user is already near *some* PoP, so the marginal PoP shrinks the *tail*, not the median.

> Tradeoff: **coverage vs. cache efficiency**. More PoPs = closer to users but *lower hit ratio per PoP* (each PoP sees less traffic, so its cache is colder). This is why origin shield (A25) exists.

### A3. Cache hit vs. cache miss
- **Hit:** the edge has a fresh copy → serves it directly. No origin contact. Fast (single short RTT).
- **Miss:** the edge lacks a fresh copy → it fetches from origin (or a mid-tier shield), stores it per the `Cache-Control` policy, then serves the user. The first user pays the full origin RTT; subsequent users hit.

```
HIT:   User → Edge (returns cached) → User          [~1 short RTT]
MISS:  User → Edge → (Shield) → Origin → Edge → User [full origin RTT, then cached]
```

### A4. Cache hit ratio
**Hit ratio = hits / (hits + misses).** It's the single most important CDN health metric because it directly determines origin load.

At **10M req/sec** with a **95% hit ratio**: misses = 5% → **500,000 req/sec reach origin**. Push it to 99% and origin sees 100K req/sec — a **5× reduction** from one percentage point. That non-linearity near 100% is why teams obsess over the last few points (better cache keys, longer TTLs, `stale-while-revalidate`, origin shield).

### A5. Why "TTL = 1 year on everything" is wrong
1. **Stale content**: HTML/API responses change; users see wrong data with no way to force a refresh short of purging every PoP.
2. **No safe invalidation for mutable URLs**: if the URL doesn't change when content changes (e.g., `/products/42`), a 1-year TTL means the update never propagates naturally.
3. **Cache pollution / eviction pressure**: rarely-accessed objects pinned for a year waste cache capacity, evicting hot objects and *lowering* hit ratio.

The correct model: **long TTL only for immutable, content-hashed URLs** (`app.a3f9bc12.js`); short/validated TTL for mutable content.

### Failure mode Q1 — Fastly June 8, 2021 global outage
On **June 8, 2021**, Fastly had a roughly **one-hour** global outage that took down Reddit, Amazon, the Guardian, gov.uk, Twitch and others. Public post-incident reporting attributed it to a **customer configuration change that triggered a latent software bug** introduced in an earlier deployment, which then affected service globally.

**SPOF exposed:** a **single-CDN dependency**. A global control-plane/software bug can fail *all* PoPs at once — geographic redundancy within one vendor doesn't protect you from a vendor-wide software fault.

**What an architect should do:** **multi-CDN** with health-based traffic steering (A30–A31), a documented failover runbook, and origin capable of degraded direct-serve. Named tradeoff: **resilience vs. cost/complexity** (multi-CDN roughly doubles integration and observability work).

---

## Level 2 — Routing & PoP Selection

### A6. Anycast BGP routing
**Anycast** advertises the *same IP prefix* from many PoPs simultaneously via BGP. Internet routers, running BGP's shortest-AS-path selection, each forward packets to whichever announcement is "closest" *in network topology* (not geography). So one IP resolves, and the network fabric itself steers each user to a nearby PoP.

- **Pro:** no DNS trickery needed; a single IP; automatic failover — if a PoP withdraws its route, BGP reconverges to the next nearest.
- **Con:** routing follows **BGP topology, not latency/geography**, so it can occasionally pick a suboptimal PoP; and long-lived TCP flows can (rarely) flap if routes change mid-connection.

### A7. GeoDNS vs. Anycast
**GeoDNS** returns *different IP addresses* based on the resolver's location — the steering happens at **DNS resolution time**, not in the packet fabric.

- **Difference:** Anycast = one IP, network routes it; GeoDNS = many IPs, DNS picks one.
- **Concrete divergence:** a user in Kenya whose DNS resolver is a Google Public DNS node in Europe may get a *European* IP from GeoDNS (which sees the resolver's location, not the user's) — whereas Anycast would route the user's actual packets to the nearest African PoP. GeoDNS is blind to the difference between resolver location and client location (mitigated somewhat by EDNS Client Subnet).

### A8. Latency-based DNS routing (Route 53)
Route 53 latency-based routing returns the endpoint with the **lowest measured network latency** from the user's region, using AWS's own latency measurements — not just geographic proximity. It differs from GeoDNS because **closest geographically ≠ lowest latency** (peering, congestion, and cable routes matter). It matters most where geography misleads — e.g., two regions equidistant on a map but with very different peering quality to the user's ISP.

### A9. Nairobi request walkthrough (where latency enters)
```
1. Browser cache / OS resolver check                     [~0 ms if cached]
2. Recursive DNS lookup for cdn.example.com              [RTT to resolver + upstream]  ← latency
3. CDN returns Anycast IP (or GeoDNS regional IP)
4. TCP handshake to nearest edge PoP (SYN/SYN-ACK/ACK)   [1 RTT to edge]               ← latency
5. TLS handshake (1 RTT for TLS 1.3, 2 for 1.2)          [1–2 RTT to edge]             ← latency
6. HTTP GET → edge checks cache
   6a. HIT  → serve immediately                          [done]
   6b. MISS → edge → (origin shield) → origin cache fill [full RTT to origin]          ← big latency
7. Response streamed back to user
```
The killer latency on a **miss** is step 6b (cross-continent RTT to origin). Everything else is edge-local and cheap once the connection is warm. This is the whole argument for high hit ratios + origin shield.

### A10. DNS TTL for CDN routing
DNS TTL controls how long resolvers cache the CDN's answer.
- **Too low (30 s):** more DNS lookups (slight latency + load), but **fast failover** — you can steer traffic away from a bad PoP/CDN quickly.
- **Too high (300 s+):** fewer lookups, but **slow failover** — during an incident, users stay pinned to a dead endpoint until TTL expires.
Most CDNs use **short TTLs (~20–60 s)** precisely to keep failover fast; the DNS lookup cost is small and often amortized by keep-alive. Named tradeoff: **DNS overhead vs. failover agility**.

### Failure mode Q2 — BGP route leak (Cloudflare 2019)
In **June 2019** a BGP **route leak** (an ISP mis-announcing routes it shouldn't) caused large volumes of traffic — including Cloudflare's — to be misrouted through unintended networks, degrading latency/availability globally.

**Defenses:**
- **RPKI (Resource Public Key Infrastructure)** with **ROAs** — cryptographically authorize which ASes may originate a prefix, so routers can reject invalid announcements (Route Origin Validation).
- **Prefix filtering / max-prefix limits** with peers and transit providers.
- **BGP monitoring** (e.g., route-leak/hijack detection) to alert and react.
Named tradeoff: **openness of BGP vs. security** — BGP trusts announcements by default; RPKI adds a validation layer but requires ecosystem-wide adoption to be fully effective.

---

## Level 3 — Cache Strategy

### A11. Push vs. Pull CDN
| | **Pull CDN** | **Push CDN** |
|---|---|---|
| How | Edge fetches from origin on first miss, then caches | You proactively upload/replicate content to edges |
| Best for | Large catalogs, long-tail content, frequently changing sites | A **small set of large, high-value files** you *know* will be hot (e.g., a game patch, a viral launch asset) |
| Origin load | First-request-per-PoP misses | No miss storm; content pre-warmed |
| Downside | Cold-cache miss penalty; possible origin stampede | You manage storage/lifecycle; wasteful for rarely-accessed objects |

**Scenario — Pull:** a news site with millions of articles (can't pre-push all). **Scenario — Push:** a scheduled global software release where you pre-stage the installer at every PoP before the announcement to avoid a launch-time origin stampede.

### A12. Cache-Control directives
| Directive | Meaning | Use case |
|---|---|---|
| `max-age=31536000` | Fresh for 1 year in **any** cache (browser + CDN) | Immutable, content-hashed assets (`app.a3f9bc12.js`) — pair with `immutable` |
| `s-maxage=3600` | Fresh for 1 hour in **shared** caches (CDN); overrides `max-age` for CDN only | Content you want CDN to hold longer than the browser |
| `no-cache` | May store, but **must revalidate** with origin (via ETag/If-None-Match) before serving | Content that changes unpredictably but revalidation (304) is cheap |
| `no-store` | **Never store** anywhere | Sensitive/personalized responses (banking, auth) |
| `stale-while-revalidate=60` | Serve stale for up to 60 s **while** fetching fresh in background | Cut tail latency at expiry (A21) |
| `private` | Only the **browser** may cache, not shared/CDN caches | Per-user responses that are safe in the user's own browser |

### A13. `max-age` vs. `s-maxage`
`max-age` applies to **all** caches; `s-maxage` applies **only to shared caches** (CDN/proxy) and overrides `max-age` there. You'd set `s-maxage` **higher than** `max-age` when you want the **CDN** to hold a copy a long time (absorbing origin load) but want **browsers** to re-check more often — e.g., `max-age=60, s-maxage=86400`: browser revalidates every minute, but the CDN serves the same object for a day, so origin is barely touched. Named tradeoff: **origin offload vs. browser freshness**.

### A14. TTL strategy by content type
| Content | Strategy | Why |
|---|---|---|
| Hashed JS/CSS (`app.a3f9bc12.js`) | `max-age=31536000, immutable` | URL changes on every deploy → the file is **immutable**; cache forever |
| HTML (`/products/42`) | Short (`s-maxage=60`) + `stale-while-revalidate`, or `no-cache` w/ ETag | Mutable, SEO-sensitive; want quick propagation |
| API (`GET /api/v1/feed`) | Very short or `no-store` if personalized; micro-cache (1–5 s) if global | Freshness-critical; micro-caching can still absorb spikes |
| HLS segments (`segment_..._001.ts`) | Long `max-age` (segments are immutable once encoded) | A produced segment never changes |
| User profile images | Medium TTL + versioned URL (`avatar.jpg?v=7`) on change | Changes occasionally; version bump invalidates cleanly |

### A15. The `Vary` header
`Vary` tells caches that the response depends on specific **request headers**, so the cache must key on them.
- **Correct:** `Vary: Accept-Encoding` → separate cache entries for gzip vs. brotli vs. identity, so a client that can't decompress brotli isn't handed brotli.
- **Broken:** `Vary: Cookie` → nearly every user has a unique cookie, so the cache key becomes **per-user** → hit ratio collapses to ~0 and every request hits origin. Never `Vary` on high-cardinality headers.

### A16. URL normalization / query-string handling
CDNs key on the full URL by default, so `?utm_source=...` tracking params create **distinct cache entries for identical content**, fragmenting the cache and tanking hit ratio.
```
/article/42?utm_source=twitter   ┐
/article/42?utm_source=facebook  ├─ 3 cache entries for ONE article
/article/42?utm_source=email     ┘
```
**Fix:** configure the CDN to **strip/ignore** non-semantic query params (or allowlist only params that change the response, e.g. `?page=`), collapsing them to one key. Named tradeoff: **cache efficiency vs. correctness** — only strip params that genuinely don't change the response.

### Failure mode Q3 — public cache on personalized endpoint
`Cache-Control: public, max-age=3600` on `/api/user/profile` means the CDN caches **user A's profile** and then serves it to **users B, C, D** who hit the same PoP/URL for the next hour — a serious **data leak / cross-user contamination** bug. Correct header: `Cache-Control: private, no-store` (or `no-cache` with per-user auth and no shared caching). Personalized responses must never be `public`.

---

## Level 4 — Invalidation & Purging

### A17. Three invalidation methods
| Method | Propagation | Precision | Complexity |
|---|---|---|---|
| **TTL expiry** (passive) | Slow (wait out TTL) | Coarse (whole object) | Trivial — just headers |
| **Explicit purge** (by URL) | Fast (seconds) | Exact URL | Medium — must enumerate URLs |
| **Surrogate-key / tag purge** | Fast | **Group** of related objects | Higher — must tag responses |
| **Versioned URLs** (cache-busting) | Instant (new URL = new object) | Exact | Low — but requires URL control |

Best practice: **immutable versioned URLs** where you control the URL; **surrogate keys** for grouped mutable content (all pages for product 9876).

### A18. Surrogate keys (cache tags)
The origin tags each response with keys; you later purge by key.
```
# Origin response headers
Surrogate-Key: product-9876 category-shoes homepage
```
To purge **all pages referencing product 9876** without touching anything else:
```
POST /purge   { "surrogate_key": "product-9876" }
```
Every cached object tagged `product-9876` (the product page, the category listing, the homepage carousel fragment) is invalidated in one call — no need to know their URLs. This is how you invalidate "everything affected by this data change" atomically.

### A19. Global purge to 250 PoPs in 30 s
The CDN's **control plane** broadcasts the purge to all PoPs, typically via a pub/sub / gossip distribution fabric.
```
Purge API → central control plane → fan-out (pub/sub) → 250 PoPs → each marks object invalid
```
**What makes it hard:** it's a distributed-systems fan-out — some PoPs are slow/partitioned; you need **at-least-once** delivery, idempotent purge application, and acknowledgment tracking. **Edge cases:** a PoP that was offline during the purge must reconcile on rejoin (replay the purge log / re-validate on next request); in-flight cache fills racing the purge must be invalidated too. Named tradeoff: **purge speed vs. delivery guarantee** — true global consistency is impossible during a partition (CAP), so CDNs favor fast eventual propagation + revalidation.

### A20. `no-cache` vs. invalidation
`no-cache` means "store but **always revalidate** before serving" — every request triggers an `If-None-Match`/`If-Modified-Since` round trip to origin (cheap 304 if unchanged, but still a round trip). Invalidation (purge) lets you cache aggressively and only pay origin cost when content *actually* changes.
"Just `no-cache` everywhere" means **every request revalidates against origin** → you lose most of the offload benefit and add origin load + latency proportional to traffic. Cost: you've turned your CDN into a slow reverse proxy. Purging is better when content changes rarely relative to reads.

### A21. `stale-while-revalidate`
```
Cache-Control: max-age=60, stale-while-revalidate=30
```
Step-by-step when the entry expires:
1. `0–60 s`: fresh → served directly.
2. `60–90 s`: **stale but within SWR window** → the edge **serves the stale copy immediately** (no user-facing latency) *and* kicks off an **async background revalidation** to origin.
3. Background fetch completes → cache updated; subsequent users get fresh.
4. `>90 s` (past SWR): the next request must block on a synchronous revalidation.

This decouples **freshness from latency** — users never wait for the origin fetch during the SWR window. It's one of the highest-leverage headers for smoothing the "expiry latency cliff."

### Failure mode Q4 — uneven purge propagation
Purge reaches PoP A in 2 s but PoP B in 45 s (partition). For 45 s, users in PoP B's region see **stale content** while users elsewhere see fresh — a **read-anomaly / consistency window**. Failure modes: users refreshing may flip between stale/fresh depending on which PoP they hit (violates monotonic reads); a critical correction (e.g., wrong price, retracted article) stays live in that region.

**Design around it:**
- Use **versioned URLs** for anything correctness-critical so stale = old URL = simply not requested.
- Add a **short TTL backstop** so even a failed purge self-heals quickly.
- **Revalidate-on-read** (ETag) for high-stakes objects so even a stale PoP re-checks origin.
- Track purge **acks per PoP**; alert on lagging PoPs; accept the window is bounded by CAP.

---

## Level 5 — Edge Functions

### A22. What an edge function is
An **edge function** (Cloudflare Workers, AWS Lambda@Edge, Fastly Compute) runs **your code at the PoP**, on the request/response path — programmable logic a static cache rule can't express: request rewriting, A/B routing, auth/JWT checks, header manipulation, personalization, API aggregation, bot filtering. A cache rule can only *match and serve*; a function can *compute and decide*.

### A23. Cloudflare Workers vs. Lambda@Edge
| Dimension | Cloudflare Workers | Lambda@Edge |
|---|---|---|
| Runtime | V8 isolates (JS/WASM) | Node/Python containers |
| Cold start | **Very low** (isolates, near-zero) | Higher (container-based) |
| CPU time | Bounded per request (short) | Higher limits, but heavier |
| Origin access | Yes (fetch) | Yes |
| Persistence | KV / Durable Objects / R2 | Must call back to AWS services |

> Exact limits change frequently — verify current quotas in vendor docs before quoting. The durable contrast is **isolate model (fast cold start, tight CPU budget)** vs. **container model (heavier, more capable per invocation)**. Tradeoff: **startup latency vs. per-request compute headroom**.

### A24. Three edge-function use cases (with logic)
```ts
// 1. A/B test routing without an origin round trip
export default {
  fetch(req: Request) {
    const bucket = hash(getUserId(req)) % 100;
    const variant = bucket < 50 ? "A" : "B";
    const url = new URL(req.url);
    url.pathname = `/${variant}${url.pathname}`;
    return fetch(url, req); // serve variant, cache per-variant key
  }
}

// 2. Auth / geo gating at the edge (reject before hitting origin)
export default {
  fetch(req: Request) {
    const country = req.headers.get("cf-ipcountry");
    if (BLOCKED.has(country)) return new Response("Unavailable", { status: 451 });
    return fetch(req);
  }
}

// 3. Response transformation (inject security headers / personalize a fragment)
export default {
  async fetch(req: Request) {
    const res = await fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("Content-Security-Policy", "default-src 'self'");
    return out;
  }
}
```
Each does work that a cache rule cannot: **compute a decision** based on request attributes.

### A25. Origin shield
An **origin shield** is a designated **mid-tier PoP** that all other PoPs consult on a miss, so only *it* talks to origin.
```
Without shield: 250 PoPs each miss → 250 origin fetches for the same object
With shield:    250 PoPs → 1 shield PoP → 1 origin fetch → shield fans back out
```
For a first-request-everywhere object, origin load drops from **~250 fetches to ~1** — roughly a **250× reduction** in worst-case origin miss load, and it dramatically improves hit ratio for long-tail content. Tradeoff: **one extra hop on shield misses** (slightly higher latency for the rare cold path) in exchange for massive origin protection.

### Failure mode Q5 — synchronous key-fetch in JWT edge function
Calling a remote key endpoint **synchronously on every request** adds a **blocking network round trip to every request** (latency spike) and turns the key endpoint into a **SPOF + bottleneck** — if it's slow or down, *all* auth fails, and you may hammer it into overload (retry storm).

**Fix:** **cache the signing keys (JWKS) at the edge** with a TTL (keys rotate slowly), refresh **asynchronously** in the background (stale-while-revalidate style), and verify the JWT signature locally against the cached key. Only fetch on cache miss/rotation. This turns a per-request network call into a per-rotation one.

---

## Level 6 — Video Delivery

### A26. HLS basics + caching
**HLS (HTTP Live Streaming)** chunks video into small HTTP-fetchable segments described by a **manifest**.
- **Manifest (`.m3u8`)**: a playlist listing segment URLs and bitrate variants. For **VOD** it's static (long cache); for **live** it updates constantly (short/no cache).
- **Segment (`.ts` or fMP4)**: a few seconds of video; **immutable once encoded** → cache long.

CDN caches them **differently**: segments get long TTL (immutable); the **live** manifest gets a **very short TTL** (it changes as new segments are appended). Getting this wrong (long-caching a live manifest) freezes the stream.

### A27. Byte-range requests
A byte-range request (`Range: bytes=0-1048575`) fetches **part** of a file. They matter for video because a player wants to **start playback and seek** without downloading the whole file. CDNs cache ranges by either caching the **whole object** and serving sub-ranges from it, or caching **range chunks** individually. Proper range support enables seeking, faster start, and bandwidth savings (fetch only what's watched).

### A28. HLS segment math (2 h, 1080p, 6 s segments, 5 Mbps)
- **Segments:** 2 h = 7200 s ÷ 6 s = **1,200 segments**.
- **Segment size:** 5 Mbps × 6 s = 30 megabits = **30 / 8 = 3.75 MB per segment**.
- **Total:** 1,200 × 3.75 MB ≈ **4.5 GB** for that rendition.
- **Cache behavior:** segments → **long `max-age`** (immutable); **VOD manifest** → long TTL too; a **live** manifest → short TTL. Cache each **bitrate variant separately** (A29).

### A29. Adaptive Bitrate Streaming (ABR)
ABR encodes the video at **multiple quality "rungs"** (e.g., 240p/480p/720p/1080p), each a separate set of segments listed in the manifest. The **player** measures throughput/buffer and requests the rung it can sustain, switching up/down at segment boundaries. The CDN must cache **each variant separately** (different URLs) — otherwise a 480p viewer and a 1080p viewer would collide on one cache key. Tradeoff: **storage/cache multiplication (N rungs) vs. smooth playback across network conditions**.

### Failure mode Q6 — Netflix Open Connect appliance offline/stale
Netflix **Open Connect** embeds caching appliances (OCAs) inside ISP networks. If an OCA goes offline or holds stale content, Netflix's control plane **steers clients to a healthy OCA or a fallback** (another appliance, a peering-point cache, or cloud-served content). Because the client gets a **ranked list of sources** and can retry/failover per segment, a single appliance failure degrades gracefully (maybe a slightly farther fetch) rather than causing a hard stall. The general principle: **client-driven, health-aware source selection** with fallbacks.

---

## Level 7 — Multi-CDN & Resilience

### A30. Why multiple CDNs
> ⚠️ I can't verify Netflix's exact *current* CDN vendor mix; treat the specific vendors in the question as illustrative. The **reasoning** for multi-CDN is what matters in an interview.

Reasons to run more than one CDN:
1. **Vendor-failure resilience** — the Fastly 2021 lesson: a single vendor's global bug shouldn't take you down.
2. **Performance arbitrage** — different CDNs are faster in different regions/ISPs; steer per-geo to the best performer.
3. **Cost optimization** — shift volume to the cheaper CDN where performance is equal.
4. **Capacity** — spread load beyond one vendor's ceiling.

**Operational costs:** duplicated config/cache-rule maintenance, harder cache invalidation (purge across all vendors), consistent TLS/cert management, unified observability, and a **traffic-steering layer** — roughly **N× the integration surface**. Tradeoff: **resilience/performance vs. operational complexity + minimum spend commitments**.

### A31. Real-time CDN traffic steering
A steering layer (often DNS-based or client-SDK-based) picks the CDN per request/session using signals:
- **Real-user monitoring (RUM)** latency/error rates per CDN per geo/ISP.
- **Synthetic probes** and CDN health/status.
- **Cost** and **capacity** targets.
- **Business rules** (e.g., pin a region to a specific CDN).
It then returns the chosen CDN's hostname/IP (short DNS TTL for agility) or instructs the client SDK. This is essentially a **control loop**: measure → decide → route → re-measure.

### A32. Cache poisoning
**Cache poisoning** tricks the CDN into caching a malicious/incorrect response that's then served to other users. Classic vector: **unkeyed input** — e.g., an app reflects the `X-Forwarded-Host` header into a response (a link/script src), but the CDN's cache key **doesn't include** that header. An attacker sends `X-Forwarded-Host: evil.com`; the poisoned response (pointing scripts at evil.com) is cached and served to everyone.
```
Attacker: GET /page  X-Forwarded-Host: evil.com   → origin reflects evil.com into HTML → CDN caches it
Victims:  GET /page                                → served poisoned HTML with evil.com scripts
```
**Mitigations:** don't reflect unkeyed headers; **include all response-affecting inputs in the cache key** (or via `Vary`); strip untrusted headers at the edge; scope caching narrowly.

### A33. Edge DDoS mitigation (three mechanisms)
| Mechanism | Threat model |
|---|---|
| **Anycast absorption** | Volumetric floods (L3/L4) — spread across all PoPs so no single site is saturated |
| **Rate limiting / challenge (JS/CAPTCHA)** | L7 request floods, credential stuffing, scrapers |
| **WAF rules + IP reputation / SYN cookies** | Application-layer exploits, known-bad sources, TCP-state exhaustion |

The edge is the ideal choke point because attack traffic is dropped **before** it reaches origin.

### A34. TLS termination at the edge
The CDN **terminates TLS** at the PoP (decrypts), inspects/caches, then re-encrypts to origin (or uses a separate origin TLS session). Security implications: the CDN sees **plaintext** — it's effectively a **trusted man-in-the-middle**. For enterprises this means the CDN holds/serves your certs and can read all traffic, which is a **trust and compliance** concern (data residency, key custody). Mitigations: **keyless SSL** (CDN does the handshake but your infra holds the private key), strict contracts/compliance certifications, and encrypting sensitive fields at the app layer. Tradeoff: **edge caching/optimization requires plaintext at the edge vs. end-to-end confidentiality**.

### Failure mode Q7 — WAF blocking legitimate traffic globally (runbook)
Scenario: a bad WAF rule starts blocking legitimate traffic for 10M users.
1. **Detect:** alerts fire on a spike in 4xx (esp. 403) + drop in successful req/sec + RUM error surge. Golden signals: errors ↑, traffic (successful) ↓.
2. **Diagnose:** correlate the spike with the **last change** (WAF rule/config deploy) — check the change log first; reproduce with a known-good request that's now blocked.
3. **Mitigate (fast):** **roll back the WAF rule** (or set it to log-only/monitor mode); if the CDN control plane is the problem, **fail over to the secondary CDN** via traffic steering; as a last resort, DNS-steer to origin/degraded mode.
4. **Verify:** watch 403 rate return to baseline; confirm across regions/PoPs.
5. **Post-mortem (blameless):** why did a rule reach global prod without a canary? Add **staged rollout for WAF rules**, log-only soak, automated rollback on error-budget burn, and a tested multi-CDN failover. Track **MTTD/MTTR**.

---

## Level 8 — Architect-Level Design

### A35. Full CDN architecture (10M req/s, 500M users, P99<50ms, 95% hit, 30s purge, 500K origin cap)
- **PoP placement:** presence in every major population/peering region (Americas, EU, India, SEA, East Asia, ME, Africa, Oceania) so **P99 client→edge RTT stays low**; rely on **Anycast** for automatic nearest-PoP routing + failover.
- **Routing:** Anycast BGP as the primary; latency-based DNS steering across **multiple CDNs**; short DNS TTL (~30 s) for failover.
- **Cache key design:** normalize URLs, **strip tracking query params**, `Vary: Accept-Encoding` only; never vary on cookies for shared content.
- **TTL strategy:** immutable hashed assets `max-age=1y, immutable`; HTML short + `stale-while-revalidate`; API `no-store`/micro-cache; video segments long, live manifests short.
- **Origin shield:** a mid-tier shield per region so the 500K origin cap is never exceeded — at 95% hit, origin sees 500K/s *worst case*; shield + request collapsing keeps it well under. Push hit ratio toward 98–99% to build headroom.
- **Purge infra:** surrogate-key tagging + pub/sub fan-out to all PoPs with ack tracking; versioned URLs for correctness-critical content; short TTL backstop.
- **Multi-CDN failover:** RUM-driven steering; documented runbook; origin degraded-serve path.
- **Capacity check:** 5% of 10M/s = **500K/s to origin at 95%** = exactly at cap → **must** raise hit ratio and/or add shield + collapsing to survive; design target 98%+ for margin.

### A36. Personalized homepage + static assets
Split the page into **cacheable shell + personalized fragments**:
- **Static shell (CSS/JS/layout):** hashed URLs, cached forever at edge.
- **Personalized bits (name, avatar, recommendations):** fetched separately and *not* shared-cached.
Techniques: **ESI (Edge Side Includes)** or client-side fragment hydration — the CDN caches the shell and stitches/streams personalized fragments; or **edge personalization** (an edge function injects the user's name/avatar from a token). Avoid `Vary: Cookie` on the whole page (kills hit ratio); instead cache the public shell publicly and mark only the personalized fragment `private`/`no-store`. Tradeoff: **cache hit ratio vs. personalization** — solved by *separating* the cacheable and per-user layers.

### A37. Capacity math for P99<50ms globally
- **Latency budget:** P99 < 50 ms edge RTT ⇒ users must be within roughly a few thousand km of a PoP (light in fiber ≈ 200 km/ms one-way; ~50 ms RTT ≈ up to ~5000 km path, minus handshake overhead) ⇒ you need PoPs in **every populated region**, concentrated near major metros/IXPs. This is why big CDNs run dozens–hundreds of metros.
- **Bandwidth per PoP:** 10M req/s × 100 KB avg = **10M × 100 KB = ~1 TB/s aggregate = ~8 Tbps** globally. Spread across, say, ~50 major PoPs weighted by population ⇒ **~160 Gbps average per PoP**, with headroom for peaks (provision 2–3× ⇒ multiple 100 GbE uplinks per PoP). (All figures illustrative — provision to measured peak, not average.)

### Failure mode Q8 — cache stampede / request collapsing
When a hot URL's TTL expires and 1,000 concurrent requests miss simultaneously, three mechanisms prevent origin overload:
1. **Request collapsing / coalescing:** the PoP detects concurrent misses for the same key and sends **one** origin fetch, queuing the other 999 to be served from that single fill. (CDNs implement this at the cache layer per object key.)
2. **`stale-while-revalidate`:** serve the stale copy to all 1,000 instantly while one background fetch refreshes — no synchronous stampede at all.
3. **Origin shield:** even if each PoP fetches once, the shield collapses cross-PoP misses to a single origin request.
Together these turn a 1,000× (or 250-PoP ×) spike into **~1 origin fetch**. Named tradeoff: **freshness vs. origin protection** (collapsing/SWR briefly serve slightly older data to shield origin).

---

## Bonus — Questions You Should Ask Unprompted

### AB1. Content update frequency
Correct instinct: **cache strategy is a function of change rate.** Before designing, quantify how often each content type changes. An immutable hashed JS bundle (`max-age=1y`) and a per-second personalized API response demand **opposite** strategies. Stating this shows you design from **data characteristics**, not defaults.

### AB2. Blast radius of stale data
Ask what a **stale-data bug costs**: if a wrong price/retracted post stays cached for 5 minutes across a region, how many users and what business/legal impact? That answer sets how aggressively you cache (and whether you need versioned URLs + revalidation for high-stakes content). This is **risk-driven caching**.

### AB3. Authenticated / private content
Ask whether you must serve **private content** (signed URLs, token auth). It's a **major design fork**: you can't use public cache keys, you must integrate auth at the edge (edge functions / signed cookies / signed URLs), and you lose aggressive public caching. Surfacing this early prevents an architecture that assumes everything is publicly cacheable.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| CDN win | Serve from a nearby PoP → ~3–4 RTT of setup at 10 ms instead of 120 ms |
| Hit ratio math | Misses × total = origin load; 95% of 10M/s = 500K/s to origin |
| Anycast | One IP, many PoPs; BGP routes to nearest *in topology* (not geography) |
| GeoDNS | Many IPs; DNS picks by resolver location (blind to resolver≠client) |
| Push vs Pull | Push = pre-stage few hot files; Pull = fetch-on-miss for big catalogs |
| `max-age` vs `s-maxage` | `s-maxage` overrides for **shared** (CDN) caches only |
| `Vary: Cookie` | Per-user cache key → hit ratio → 0. Never do it |
| Query-string keys | Strip tracking params or cache fragments per URL variant |
| Surrogate key | Tag responses → purge a whole group (product-9876) in one call |
| `stale-while-revalidate` | Serve stale instantly, refresh in background → no expiry latency cliff |
| Origin shield | Mid-tier PoP collapses N-PoP misses to ~1 origin fetch |
| Edge function | Runs your code at the PoP; computes decisions a cache rule can't |
| HLS | Manifest (.m3u8) + immutable segments; live manifest = short TTL |
| ABR | Multiple bitrate rungs, each cached under its own key |
| Multi-CDN | Survive vendor-wide outages (Fastly 2021); steer by RUM |
| Cache poisoning | Unkeyed reflected header cached + served to all → key on all inputs |
| Request collapsing | Concurrent misses for one key → single origin fetch |
| TLS at edge | CDN is a trusted MITM; keyless SSL keeps your private key |
| BGP defense | RPKI/ROA + prefix filtering vs. route leaks (Cloudflare 2019) |
| Personalized page | Cache public shell + `private`/edge-inject the per-user fragment |
