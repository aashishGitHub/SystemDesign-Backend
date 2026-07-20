# Deep Dive: CDN & Edge Computing

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code/config, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> ⚠️ **Note on numbers:** CDN PoP counts, vendor limits, and vendor mixes change
> frequently. Figures below are **order-of-magnitude / illustrative** for reasoning,
> not exact current values — verify against vendor docs before quoting in a real design.

---

## Table of Contents

1. [Why CDNs Exist: The Latency Physics](#1-why-cdns-exist-the-latency-physics)
2. [Routing: Anycast, GeoDNS, and Latency Steering](#2-routing-anycast-geodns-and-latency-steering)
3. [Cache-Control, TTL, ETag, and Vary](#3-cache-control-ttl-etag-and-vary)
4. [Push vs Pull and Cache-Key Design](#4-push-vs-pull-and-cache-key-design)
5. [Invalidation and Surrogate-Key Purge](#5-invalidation-and-surrogate-key-purge)
6. [Origin Shield, Request Collapsing, and Cache Stampede](#6-origin-shield-request-collapsing-and-cache-stampede)
7. [Edge Functions: Workers and Lambda@Edge](#7-edge-functions-workers-and-lambdaedge)
8. [Video Delivery: HLS, Byte-Range, and ABR](#8-video-delivery-hls-byte-range-and-abr)
9. [Multi-CDN, Resilience, and Edge Security](#9-multi-cdn-resilience-and-edge-security)
10. [Architect-Level Design and Capacity Math](#10-architect-level-design-and-capacity-math)
11. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why CDNs Exist: The Latency Physics

### 🟢 Beginner — The Neighborhood Warehouse

Imagine you order a book. If the only warehouse is on another continent, every order
takes a week to arrive. Now imagine the company opens a small warehouse in your city
that stocks the most popular books. Your order arrives the same day. The rare titles
still ship from the big central warehouse, but 95% of what people want is already
nearby.

A CDN is that network of neighborhood warehouses for web content. The "central
warehouse" is your **origin server**. The local ones are **edge PoPs**. The whole game
is: keep the popular stuff close, and only bother the origin for the rare stuff.

---

### 🟡 Senior — The Round-Trip Math

The dominant cost of a web request is not bandwidth — it's **round trips**, and each
round trip pays the network RTT (round-trip time). A cold HTTPS request needs roughly:

```
1 RTT  — TCP handshake (SYN / SYN-ACK / ACK)
1 RTT  — TLS 1.3 handshake  (TLS 1.2 needs 2 RTT)
1 RTT  — HTTP request → first byte of response
------
~3 RTT before the first byte (≈3.5 including DNS on a cold connection)
```

Apply that to two distances:

| Path | RTT | ~3.5 RTT to first byte |
|---|---|---|
| Edge PoP 10 ms away | 10 ms | ~35 ms |
| Origin 120 ms away | 120 ms | ~420 ms |

That is a **~12× reduction** in connection-setup latency before you even count the
faster throughput on the shorter path (TCP congestion window grows faster over a short
RTT). The named tradeoff is **latency vs. freshness**: you win latency by serving a
cached — possibly slightly stale — copy.

```
HIT:   User → Edge (returns cached)            → User    [~1 short RTT]
MISS:  User → Edge → (Shield) → Origin → Edge  → User    [full origin RTT, then cached]
```

---

### 🔴 Architect — What "More PoPs" Actually Buys, and the Fastly SPOF

A **PoP (Point of Presence)** is a physical cluster of edge servers in one metro. When
you resolve a CDN hostname you're steered to a nearby PoP.

Approximate, illustrative scale (verify before quoting): some CDNs advertise presence in
**300+ cities** with many small PoPs; others run **fewer, larger** PoPs (dozens); the
largest-footprint providers claim **thousands** of locations, many embedded inside ISP
networks. The critical architect insight:

> **More PoPs shrink the tail (P99/P100) for poorly-connected regions, not the median.**
> The median user is already near *some* PoP. But more PoPs also mean *lower hit ratio
> per PoP* — each PoP sees less traffic, so its cache is colder. This coverage-vs-cache-
> efficiency tension is exactly why origin shield exists (§6).

**Real incident — Fastly global outage, June 8, 2021.** For roughly **one hour**, a
large slice of the internet went dark: Reddit, Amazon, the Guardian, gov.uk, Twitch, and
others. Public post-incident reporting attributed it to a **customer configuration change
that triggered a latent software bug** introduced in an earlier deployment; once
triggered, it affected service globally.

- **SPOF exposed:** a **single-CDN dependency**. A global control-plane or software bug
  can fail *all* PoPs at once. Geographic redundancy *within one vendor* does not protect
  you from a vendor-wide software fault.
- **Architect response:** multi-CDN with health-based steering (§9), a documented failover
  runbook, and an origin capable of degraded direct-serve. Named tradeoff:
  **resilience vs. cost/complexity** — multi-CDN roughly doubles integration and
  observability work.

**Design-review talking points**
- "What is our blast radius if the CDN control plane fails globally, not just one region?"
- "Can origin survive if the CDN drops to 0% hit ratio for 10 minutes? Show the math."
- "Is DNS TTL short enough to steer away from a failed vendor quickly?" (§2)

---

## 2. Routing: Anycast, GeoDNS, and Latency Steering

### 🟢 Beginner — One Phone Number vs. a Directory

**Anycast** is like a single national phone number (say, an emergency line) that
automatically connects you to the nearest call center — you dial one number and the phone
network figures out where to route you.

**GeoDNS** is like a directory that hands you a *different* local number depending on
which city you're calling from. You look up the number first, then dial that specific
office.

Both get you to a nearby office. One does it in the network; the other does it at
lookup time.

---

### 🟡 Senior — Anycast vs. GeoDNS vs. Latency-Based DNS

**Anycast BGP:** the *same IP prefix* is advertised from many PoPs simultaneously via
BGP. Internet routers, running BGP's shortest-AS-path selection, each forward packets to
whichever announcement is "closest" **in network topology** (not geography). One IP; the
fabric steers each packet.

**GeoDNS:** returns *different IPs* based on the resolver's location — steering happens at
**DNS resolution time**, not in the packet fabric.

**Latency-based DNS** (e.g., AWS Route 53 latency routing): returns the endpoint with the
**lowest measured network latency** from the user's region, using the provider's own
latency measurements — because *closest geographically ≠ lowest latency* (peering,
congestion, and cable routes matter).

| Property | Anycast | GeoDNS | Latency-based DNS |
|---|---|---|---|
| How steering happens | BGP routes packets | DNS returns regional IP | DNS returns lowest-latency IP |
| Number of IPs | One (shared) | Many | Many |
| Failover | Automatic (route withdraws) | Requires DNS TTL expiry | Requires DNS TTL expiry |
| Blind spot | Suboptimal PoP if BGP path is odd | Resolver ≠ client location | Depends on measurement freshness |
| Long-lived TCP risk | Route flap can reset flow (rare) | Stable once resolved | Stable once resolved |

**Concrete GeoDNS divergence:** a user in Nairobi whose DNS resolver is a public-DNS node
in Europe may be handed a *European* IP by GeoDNS (which sees the resolver's location, not
the user's), while **Anycast** routes the user's actual packets to the nearest African
PoP. GeoDNS is blind to resolver-vs-client mismatch — partially mitigated by **EDNS Client
Subnet (ECS)**, which passes a truncated client IP to the authoritative server.

**Nairobi request walkthrough (where latency enters):**
```
1. Browser / OS resolver cache check                      [~0 ms if cached]
2. Recursive DNS lookup for cdn.example.com               [RTT to resolver + upstream]  ← latency
3. CDN returns Anycast IP (or GeoDNS regional IP)
4. TCP handshake to nearest edge PoP                      [1 RTT to edge]               ← latency
5. TLS handshake (1 RTT for 1.3, 2 for 1.2)              [1–2 RTT to edge]             ← latency
6. HTTP GET → edge checks cache
   6a. HIT  → serve immediately                           [done]
   6b. MISS → edge → (origin shield) → origin cache fill  [full RTT to origin]          ← big latency
7. Response streamed back to user
```
The killer latency on a **miss** is 6b (cross-continent RTT to origin). Everything else
is edge-local once the connection is warm — the whole argument for high hit ratios +
origin shield.

**DNS TTL for routing:**

| DNS TTL | Effect |
|---|---|
| Too low (~30 s) | More lookups (slight cost) but **fast failover** — steer away from a bad PoP/CDN quickly |
| Too high (300 s+) | Fewer lookups but **slow failover** — users stay pinned to a dead endpoint until TTL expires |

Most CDNs use **short TTLs (~20–60 s)** precisely to keep failover fast. Named tradeoff:
**DNS overhead vs. failover agility.**

---

### 🔴 Architect — BGP Route Leaks and the Cloudflare 2019 Incident

Anycast inherits BGP's core weakness: **BGP trusts announcements by default.** A network
that mis-announces a prefix can attract traffic that isn't theirs — a **route leak** (or,
if malicious, a **hijack**).

**Real incident — Cloudflare, June 2019 BGP route leak.** A **BGP route leak** (an ISP
propagating routes it should not have) caused large volumes of traffic — including
Cloudflare's — to be misrouted through unintended networks, degrading latency and
availability globally. The root cause chain involved a route optimizer and a leak that
transit providers propagated instead of filtering.

**Defenses (name these in a review):**
- **RPKI + ROAs (Route Origin Authorizations):** cryptographically declare which ASes may
  originate a prefix, so routers can reject invalid announcements (Route Origin
  Validation). Effective only with ecosystem-wide adoption.
- **Prefix filtering + max-prefix limits** on sessions with peers and transit providers —
  the missing control in most leak incidents.
- **BGP monitoring** (route-leak/hijack detection) to alert and react fast.

**Capacity/latency reasoning under a leak:** if your Anycast prefix is suddenly routed
through a distant, congested AS, effective RTT can jump from ~10 ms to 100 ms+ for a
region, and that region's throughput collapses as TCP windows shrink. Because Anycast
gives you *no application-layer signal* that routing changed, you need **external RUM
(real-user monitoring)** to detect it — the origin looks healthy while users suffer.

Named tradeoff: **openness of BGP vs. security.** RPKI adds a validation layer but does
not fully solve path validation (that's what BGPsec aims at, with limited deployment).

**Design-review talking points**
- "Are our prefixes covered by ROAs, and do our transit providers do origin validation?"
- "How do we *detect* a route leak — do we have third-party RUM, not just origin health?"
- "Does our multi-CDN steering key off RUM latency so a leaked CDN gets drained
  automatically?"

---

## 3. Cache-Control, TTL, ETag, and Vary

### 🟢 Beginner — The Milk Carton Date

Every carton of milk has a "best by" date. You drink it freely until then. Past the date,
you don't automatically throw it out — you *check* (smell it) before deciding. If it's
fine, you keep it a bit longer; if not, you get a fresh one.

Cache headers work the same way. `max-age` is the "best by" date. `ETag` revalidation is
the "smell check" — the cache asks the origin "is my copy still good?" and the origin
answers "yes, keep it" (a cheap `304`) or hands over a fresh carton.

---

### 🟡 Senior — Every Directive, Correctly

| Directive | Precise meaning | Correct use case |
|---|---|---|
| `max-age=31536000` | Fresh for 1 year in **any** cache (browser + shared) | Immutable, content-hashed assets (`app.a3f9bc12.js`); pair with `immutable` |
| `s-maxage=3600` | Fresh for 1 h in **shared** caches (CDN/proxy); overrides `max-age` there | Hold longer at CDN than in the browser |
| `no-cache` | May store, but **must revalidate** with origin (ETag/If-None-Match) before serving | Changes unpredictably, but a `304` revalidation is cheap |
| `no-store` | **Never store** anywhere | Sensitive/personalized responses (banking, auth) |
| `private` | Only the **browser** may cache, not shared/CDN caches | Per-user responses safe in the user's own browser |
| `stale-while-revalidate=60` | Serve stale up to 60 s **while** fetching fresh in the background | Kill the expiry latency cliff (§5) |
| `immutable` | Promise the body will never change while fresh → skip revalidation on reload | Hashed static assets |

**`max-age` vs. `s-maxage`:** `max-age` applies to *all* caches; `s-maxage` applies only
to *shared* caches and overrides `max-age` there. Set `s-maxage` **higher** when you want
the CDN to absorb origin load but browsers to re-check more often:

```
Cache-Control: public, max-age=60, s-maxage=86400
# Browser revalidates every 60 s; CDN serves the same object for a day.
# Origin is barely touched. Tradeoff: origin offload vs. browser freshness.
```

**ETag / conditional requests** — the "smell check" wire protocol:
```
# First response from origin
HTTP/1.1 200 OK
ETag: "v3-a3f9bc12"
Cache-Control: no-cache

# Cache revalidates when serving a client
GET /page  If-None-Match: "v3-a3f9bc12"

# Origin, unchanged:
HTTP/1.1 304 Not Modified          ← no body; cheap; cache keeps its copy

# Origin, changed:
HTTP/1.1 200 OK
ETag: "v4-77de01aa"                 ← new body + new validator
```
A `304` carries **no body**, so revalidation costs one small round trip instead of a full
transfer. `no-cache` = "always revalidate"; it is **not** `no-store`.

**The `Vary` header** tells caches the response depends on specific *request* headers, so
they must key on them:

| `Vary` value | Effect |
|---|---|
| `Vary: Accept-Encoding` | ✅ Correct — separate entries for gzip / brotli / identity so a client isn't handed a codec it can't decode |
| `Vary: Cookie` | ❌ Nearly every user has a unique cookie → cache key becomes **per-user** → hit ratio → ~0 → every request hits origin |

Never `Vary` on high-cardinality headers.

---

### 🔴 Architect — TTL Strategy by Content Type, and the Personalization Leak

TTL is not one number — it is a **function of change rate**:

| Content | Strategy | Why |
|---|---|---|
| Hashed JS/CSS (`app.a3f9bc12.js`) | `max-age=31536000, immutable` | URL changes every deploy → file is immutable → cache forever |
| HTML (`/products/42`) | `s-maxage=60` + `stale-while-revalidate`, or `no-cache` + ETag | Mutable, SEO-sensitive; want quick propagation |
| API (`GET /api/v1/feed`) | `no-store` if personalized; micro-cache (1–5 s) if global | Freshness-critical; micro-caching still absorbs spikes |
| HLS segments | Long `max-age` (immutable once encoded) | A produced segment never changes |
| Profile images | Medium TTL + versioned URL (`avatar.jpg?v=7`) | Changes occasionally; version bump invalidates cleanly |

**Why "TTL = 1 year on everything" is wrong** (a classic junior mistake):
1. **Stale content** — HTML/API change; users see wrong data with no natural refresh.
2. **No safe invalidation for mutable URLs** — if the URL doesn't change when the content
   does (`/products/42`), a 1-year TTL means the update never propagates naturally.
3. **Cache pollution** — rarely-accessed objects pinned for a year evict hot objects and
   *lower* hit ratio.

**Failure mode — public cache on a personalized endpoint.**
`Cache-Control: public, max-age=3600` on `/api/user/profile` means the CDN caches
**user A's** profile at a PoP and serves it to **users B, C, D** hitting the same URL for
the next hour — a **cross-user data leak**, not just a staleness bug.

```
BROKEN:   Cache-Control: public, max-age=3600     # on /api/user/profile
CORRECT:  Cache-Control: private, no-store         # personalized → never shared-cache
```

This exact class of bug has caused real production data-exposure incidents across the
industry when a caching layer or misconfigured header let one user's authenticated
response be served to another. Personalized responses must **never** be `public`.

**Cache-hit-ratio math** — the single most important CDN metric, because it directly sets
origin load. `hit ratio = hits / (hits + misses)`:

```
10M req/s @ 95% hit → misses = 5% = 500,000 req/s reach origin
10M req/s @ 99% hit → misses = 1% = 100,000 req/s reach origin   (5× less!)
```
That non-linearity near 100% is why teams fight for the last few points (better cache
keys, longer TTLs, `stale-while-revalidate`, origin shield).

**Design-review talking points**
- "What is the change rate of each content type? That, not a default, sets the TTL."
- "What is the blast radius if we cache a personalized response `public` for one hour?"
- "Are we one percentage point of hit ratio away from exceeding origin capacity?"

---

## 4. Push vs Pull and Cache-Key Design

### 🟢 Beginner — Stocking Shelves Two Ways

**Pull:** the corner store only orders a product *after* the first customer asks for it.
The first customer waits; everyone after gets it off the shelf. Great for a huge catalog
where you can't predict demand.

**Push:** before a big holiday sale, the store pre-stocks the shelves with the items it
*knows* will sell out. No one waits, but you have to guess right and it wastes shelf space
on items nobody buys.

---

### 🟡 Senior — Push vs Pull, and the Cache Key

| | **Pull CDN** | **Push CDN** |
|---|---|---|
| How | Edge fetches from origin on first miss, then caches | You proactively upload/replicate content to edges |
| Best for | Large catalogs, long-tail, frequently-changing sites | A **small set of large, hot** files you *know* will be needed |
| Origin load | First-request-per-PoP misses | No miss storm; pre-warmed |
| Downside | Cold-cache miss penalty; possible stampede | You manage storage/lifecycle; wasteful for cold objects |

- **Pull scenario:** a news site with millions of articles — you can't pre-push them all.
- **Push scenario:** a scheduled global game patch or launch asset — pre-stage it at every
  PoP *before* the announcement to avoid a launch-time origin stampede.

**The cache key** is what the CDN uses to decide "same object or not." By default it's the
full URL (+ host, + `Vary` headers). Getting it wrong fragments the cache:

```
/article/42?utm_source=twitter   ┐
/article/42?utm_source=facebook  ├─ 3 cache entries for ONE identical article
/article/42?utm_source=email     ┘
```
**Fix:** configure the CDN to **strip/ignore** non-semantic query params (or allowlist
only params that actually change the response, e.g. `?page=`), collapsing them to one key.

```
# Illustrative CDN cache-key config (vendor syntax varies)
cache_key {
  include:  host, path, query["page"], query["sort"]
  ignore:   query["utm_*"], query["fbclid"], query["gclid"]
  normalize: lowercase_path, sort_query_params
}
```
Named tradeoff: **cache efficiency vs. correctness** — only strip params that genuinely do
not change the response.

---

### 🔴 Architect — Cache-Key Discipline as a Hit-Ratio Lever

At scale, cache-key design is a top-three lever on hit ratio (alongside TTL and shield):

```
Scenario: 100M req/day, article pages, 30% carry a tracking query param.
Without normalization:
  Each article effectively has ~5 URL variants in circulation
  → cache stores ~5× the objects, evicts hot ones sooner
  → measured hit ratio drops from ~95% to ~80%
  → origin load at 100M/day: 5% miss = 5M/day  vs  20% miss = 20M/day  (4× origin load)
With normalization:
  1 key per article → hit ratio recovers → origin load drops 4×
```

**Header/cookie hygiene at the key:** a single unexpected header in the cache key (or a
`Set-Cookie` that a proxy decides to `Vary` on) can silently shard the cache per-user.
Audit: what headers/cookies reach the cache key? Strip untrusted request headers at the
edge before they can influence caching (this also blocks a cache-poisoning vector, §9).

**Push-CDN capacity note:** pushing to *N* PoPs multiplies storage by *N* and multiplies
purge/lifecycle work by *N*. Only push objects whose (hotness × size) justifies pinning
them everywhere. Everything else should be pull + shield.

**Design-review talking points**
- "Which query params change the response? Everything else must be stripped at the key."
- "Do any per-user headers/cookies leak into the cache key and shard it?"
- "For a launch, do we pre-push the hero asset, or trust pull + shield + request
  collapsing to absorb the spike?"

---

## 5. Invalidation and Surrogate-Key Purge

### 🟢 Beginner — Recalling a Newspaper Edition

A newspaper is printed and distributed to thousands of stands. Then a front-page story
turns out to be wrong. You have three ways to fix it: wait for tomorrow's edition
(**TTL expiry** — slow), send a courier to each stand to pull that exact issue
(**URL purge** — precise but you must know every stand), or tell every stand "pull
anything tagged with today's lead story" (**surrogate-key purge** — one instruction,
grouped recall).

---

### 🟡 Senior — Three Invalidation Methods + Surrogate Keys

| Method | Propagation | Precision | Complexity |
|---|---|---|---|
| **TTL expiry** (passive) | Slow (wait out TTL) | Coarse (whole object) | Trivial — just headers |
| **Explicit purge** (by URL) | Fast (seconds) | Exact URL | Medium — must enumerate URLs |
| **Surrogate-key / tag purge** | Fast | **Group** of related objects | Higher — must tag responses |
| **Versioned URLs** (cache-busting) | Instant (new URL = new object) | Exact | Low — but requires URL control |

**Surrogate keys (cache tags)** — the origin tags each response; you later purge by tag:
```
# Origin response headers — tag one response with several keys
Surrogate-Key: product-9876 category-shoes homepage

# Later, purge everything touching product 9876 — without knowing any URL
POST /purge   { "surrogate_key": "product-9876" }
```
Every cached object tagged `product-9876` — the product page, the category listing, the
homepage carousel fragment — is invalidated in one call. This is how you invalidate
"everything affected by this data change" atomically.

**`stale-while-revalidate`** — the highest-leverage header for smoothing expiry:
```
Cache-Control: max-age=60, stale-while-revalidate=30
```
1. `0–60 s` — fresh → served directly.
2. `60–90 s` — stale but within SWR window → edge **serves the stale copy immediately**
   (zero user-facing latency) *and* kicks off an **async background revalidation**.
3. Background fetch completes → cache updated; later users get fresh.
4. `>90 s` — past SWR → the next request blocks on a synchronous revalidation.

`no-cache` vs. invalidation: `no-cache` forces an `If-None-Match` round trip on **every**
request (cheap `304`, but still a round trip). "Just `no-cache` everywhere" turns your CDN
into a slow reverse proxy — you lose most offload. Purge lets you cache aggressively and
pay origin cost only when content *actually* changes.

---

### 🔴 Architect — Global Purge Under Partition, and Fastly's Instant-Purge Model

Purging 250 PoPs in **30 seconds** is a distributed-systems fan-out:
```
Purge API → central control plane → fan-out (pub/sub or gossip) → 250 PoPs → mark invalid
```
**What makes it hard:** some PoPs are slow or partitioned; you need **at-least-once**
delivery, **idempotent** purge application, and **ack tracking**. Edge cases: a PoP that
was offline during the purge must reconcile on rejoin (replay the purge log or revalidate
on next request); an in-flight cache fill racing the purge must also be invalidated.

**Real capability anchor — Fastly's instant purge.** Fastly publicly documents a purge
architecture designed to invalidate content **globally in roughly ~150 ms** using a
banded-broadcast/gossip distribution among its nodes, and it built surrogate keys as a
first-class primitive. The design point worth citing: purge speed comes from a **broadcast
overlay separate from the data path**, and correctness under partition relies on
**idempotent apply + eventual reconciliation**, not on a global lock (which CAP forbids).

**Failure mode — uneven purge propagation.** Purge reaches PoP A in 2 s but PoP B in 45 s
(partition). For 45 s:
- Users in PoP B's region see **stale** content while others see fresh — a **read anomaly
  / consistency window**.
- A user bouncing between PoPs may **flip between stale and fresh** (violates monotonic
  reads).
- A correctness-critical change (wrong price, retracted article) stays live in that region.

**Design around the window:**
- **Versioned URLs** for correctness-critical content → stale = old URL = simply not
  requested.
- **Short TTL backstop** so even a failed purge self-heals quickly.
- **Revalidate-on-read (ETag)** for high-stakes objects so even a stale PoP re-checks.
- Track **purge acks per PoP**; alert on laggards; accept the window is bounded by CAP.

**Design-review talking points**
- "Is purge on the critical path of publishing? If the purge fan-out is down, do we block
  publishes or fall back to versioned URLs?"
- "What's our worst-case consistency window during a regional partition, and is it
  acceptable for pricing/legal content?"
- "Do we purge by surrogate key so one data change invalidates all derived pages
  atomically?"

---

## 6. Origin Shield, Request Collapsing, and Cache Stampede

### 🟢 Beginner — One Runner to the Warehouse

Fifty neighborhood stores all run out of the same toy at once. Without coordination, all
fifty send a truck to the central warehouse — fifty trucks for one restock. With a
regional hub, all fifty ask the hub; the hub sends **one** truck to the warehouse and then
supplies all fifty stores. The warehouse sees one order instead of fifty.

That regional hub is the **origin shield**. Sending one truck instead of a swarm is
**request collapsing**.

---

### 🟡 Senior — Shield Topology and Collapsing

An **origin shield** is a designated **mid-tier PoP** that all other PoPs consult on a
miss, so only *it* talks to origin:
```
Without shield: 250 PoPs each miss → 250 origin fetches for the same object
With shield:    250 PoPs → 1 shield PoP → 1 origin fetch → shield fans back out
```
For a first-request-everywhere object, worst-case origin load drops from **~250 fetches to
~1** — roughly a **250× reduction** — and long-tail hit ratio improves because the shield
aggregates traffic that individual PoPs are too cold to hold. Tradeoff: **one extra hop on
shield misses** (slightly higher latency on the rare cold path) for massive origin
protection.

**Request collapsing / coalescing** solves the *within-a-PoP* stampede: when many
concurrent requests miss on the same key, the PoP sends **one** origin fetch and queues
the rest to be served from that single fill:
```
t=0   1,000 concurrent GET /hot   → all miss (TTL just expired)
      PoP recognizes same cache key → sends 1 origin fetch
      queues the other 999 waiters
t=Δ   origin responds → PoP fills cache → serves all 1,000 from the one fill
Result: 1 origin request instead of 1,000
```

---

### 🔴 Architect — The Three Anti-Stampede Mechanisms (and their math)

When a hot URL's TTL expires and 1,000 concurrent requests miss at one PoP — and that
happens at 250 PoPs — three mechanisms compound to protect origin:

| Mechanism | Collapses | Reduces |
|---|---|---|
| **Request collapsing** (per PoP, per key) | Concurrent misses at one PoP | 1,000 → 1 per PoP |
| **`stale-while-revalidate`** | The synchronous stampede entirely | Serve stale to all instantly, 1 background fetch |
| **Origin shield** (cross-PoP) | Misses across all PoPs | 250 PoPs → 1 origin fetch |

Stacked worst case:
```
1,000 concurrent × 250 PoPs = 250,000 potential simultaneous origin hits
  → request collapsing: 250,000 → 250 (one per PoP)
  → origin shield:      250 → 1 (one per object, via the shield)
  → SWR (if enabled):   even that 1 is a background fetch; users never block
Net: a 250,000× spike becomes ~1 origin fetch.
```
Named tradeoff: **freshness vs. origin protection** — collapsing and SWR briefly serve
slightly older data to shield the origin.

**Capacity check that makes shield mandatory:** at 10M req/s and a 95% hit ratio, origin
sees **500K req/s**. If origin capacity is 500K req/s, you are *at the cliff* — any hit-
ratio dip breaches it. Shield + collapsing + pushing hit ratio to 98–99% is what builds
headroom (§10).

**Design-review talking points**
- "Is request collapsing enabled per cache key, and does it survive a slow origin (does
  the fetch have a timeout so the 999 waiters don't hang forever)?"
- "Do we have a single shield per region, and what happens if the shield PoP itself
  fails?" (Answer: PoPs must fail open to origin, accepting a temporary stampede.)
- "What is origin load at our *worst* hit ratio, not our average?"

---

## 7. Edge Functions: Workers and Lambda@Edge

### 🟢 Beginner — A Clerk at the Door, Not Just a Shelf

A plain cache is a shelf: it can hand you exactly what's on it, unchanged. An **edge
function** is a clerk standing at the store entrance who can *make decisions* — check your
ID, send you to a different aisle, gift-wrap the item, or turn you away — all before you
ever reach the back office (the origin). The shelf can only match and serve; the clerk can
compute and decide.

---

### 🟡 Senior — Workers vs Lambda@Edge, with Code

An **edge function** runs *your code at the PoP*, on the request/response path: request
rewriting, A/B routing, auth/JWT checks, header manipulation, personalization, API
aggregation, bot filtering. A cache rule can only *match and serve*; a function can
*compute and decide*.

| Dimension | Cloudflare Workers | Lambda@Edge |
|---|---|---|
| Runtime | V8 isolates (JS/WASM) | Node/Python (container-based) |
| Cold start | **Very low** (isolates, near-zero) | Higher (container model) |
| CPU time | Bounded, short per request | Higher limits, heavier per invocation |
| Origin access | Yes (`fetch`) | Yes |
| Persistence | KV / Durable Objects / R2 | Call back to AWS services |

> Exact quotas change frequently — verify in vendor docs before quoting. The durable
> contrast is **isolate model (fast cold start, tight CPU budget)** vs. **container model
> (heavier, more capable per invocation)**. Tradeoff: **startup latency vs. per-request
> compute headroom**.

```ts
// 1. A/B routing at the edge — no origin round trip to pick a variant
export default {
  fetch(req: Request) {
    const bucket = hash(getUserId(req)) % 100;
    const variant = bucket < 50 ? "A" : "B";
    const url = new URL(req.url);
    url.pathname = `/${variant}${url.pathname}`;
    return fetch(url, req);      // cache per-variant key
  }
};

// 2. Geo/auth gating — reject before hitting origin
export default {
  fetch(req: Request) {
    const country = req.headers.get("cf-ipcountry");
    if (BLOCKED.has(country)) return new Response("Unavailable", { status: 451 });
    return fetch(req);
  }
};

// 3. Response transformation — inject security headers / personalize a fragment
export default {
  async fetch(req: Request) {
    const res = await fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("Content-Security-Policy", "default-src 'self'");
    return out;
  }
};
```
Each does work a cache rule cannot: **compute a decision** from request attributes.

---

### 🔴 Architect — The Synchronous-Dependency Trap

**Failure mode — synchronous key fetch in a JWT-verifying edge function.** An auth Worker
verifies a JWT on every request, but calls a remote JWKS (key) endpoint **synchronously**
on *every* request. Consequences:
- A **blocking network round trip added to every request** → latency spike.
- The key endpoint becomes a **SPOF + bottleneck**: if it's slow or down, *all* auth
  fails, and retries can hammer it into overload (retry storm).
- Edge CPU/time budgets are tight — a blocking dependency can push you past the per-request
  limit and start throwing.

**Fix — cache keys at the edge, refresh asynchronously:**
```ts
// Cache JWKS in edge KV; keys rotate slowly (hours/days), so fetch is rare.
async function getKey(kid: string, env): Promise<Key> {
  let jwks = await env.KV.get("jwks", "json");
  if (!jwks || isStale(jwks)) {
    // stale-while-revalidate style: serve stale, refresh in background
    env.ctx.waitUntil(refreshJwks(env));      // async, non-blocking
    jwks = jwks ?? await refreshJwks(env);     // block only on cold start
  }
  return jwks.keys[kid];
}
// Verify signature LOCALLY against the cached key — no per-request network call.
```
This turns a **per-request** network call into a **per-rotation** one.

**General edge-compute rules for a review:**
- Any per-request external dependency must be **cached + async-refreshed**, never on the
  hot path synchronously.
- Respect the **CPU-time budget** — edge functions are for decisions, not heavy compute.
- Fail **open or closed deliberately** — decide what happens to auth when the key store is
  unreachable (usually fail closed for auth, fail open for personalization).

**Design-review talking points**
- "What external calls does this function make per request, and are they cached?"
- "What's the per-request CPU budget, and does our logic fit under it at P99?"
- "If the edge KV / origin is unreachable, does the function fail open or closed — and is
  that the right choice for this path?"

---

## 8. Video Delivery: HLS, Byte-Range, and ABR

### 🟢 Beginner — A Book Split Into Chapters

Streaming a two-hour movie as one giant file is like being forced to buy a whole book to
read page one. Instead, video is split into short **chapters** (segments) of a few seconds
each, plus a **table of contents** (the manifest) that lists them in order. Your player
reads the table of contents, then fetches chapters one at a time as you watch — and can
skip to any chapter instantly.

---

### 🟡 Senior — HLS, Byte-Range, and ABR

**HLS (HTTP Live Streaming)** chunks video into small HTTP-fetchable segments described by
a **manifest**:
- **Manifest (`.m3u8`)** — a playlist listing segment URLs and bitrate variants. For
  **VOD** it's static (long cache). For **live** it updates constantly as segments are
  appended (**very short / no cache**).
- **Segment (`.ts` or fMP4)** — a few seconds of video; **immutable once encoded** →
  cache long.

**Caching them differently is the whole trick:**

| Object | Cache behavior | Failure if you get it wrong |
|---|---|---|
| VOD manifest | Long TTL | — |
| **Live** manifest | **Very short TTL** | Long-caching a live manifest **freezes the stream** |
| Segment (`.ts`/fMP4) | Long `max-age` (immutable) | Short TTL → needless origin load |

**Byte-range requests** (`Range: bytes=0-1048575`) fetch *part* of a file so a player can
start playback and seek without downloading the whole thing. CDNs serve ranges either by
caching the **whole object** and slicing sub-ranges, or by caching **range chunks**
individually.

**ABR (Adaptive Bitrate Streaming)** encodes multiple quality "rungs" (240p/480p/720p/
1080p), each a separate set of segments in the manifest. The **player** measures
throughput/buffer and requests the rung it can sustain, switching at segment boundaries.
The CDN must cache **each variant under its own key** — otherwise a 480p viewer and a
1080p viewer collide on one entry. Tradeoff: **storage/cache multiplication (N rungs) vs.
smooth playback across network conditions**.

**HLS segment math** (2 h, 1080p, 6 s segments, 5 Mbps):
```
Segments  = 7200 s ÷ 6 s              = 1,200 segments
Seg size  = 5 Mbps × 6 s = 30 Mb      = 30 / 8 = 3.75 MB per segment
Total     = 1,200 × 3.75 MB           ≈ 4.5 GB  (for this one rendition)
With 4 ABR rungs, cache/storage ≈ 4× that per title.
```

---

### 🔴 Architect — Netflix Open Connect and Graceful Degradation

**Real architecture — Netflix Open Connect.** Netflix embeds caching appliances (**OCAs**)
*inside* ISP networks and at IXPs, pre-positioning popular content close to viewers
(largely a **push** model driven by predicted popularity, filled during off-peak hours).

**Failure mode — an OCA goes offline or holds stale content.** Netflix's control plane
gives each client a **ranked list of sources** at play time. If an OCA is unhealthy or
missing a segment, the client **fails over per-segment** to another OCA, a peering-point
cache, or cloud-served content. Because selection is **client-driven and health-aware**,
a single appliance failure degrades to a slightly farther fetch rather than a hard stall.
The general principle for any video system: **client-side, health-aware source selection
with fallbacks**, not a single hard-wired origin.

**Live-event capacity reasoning:**
```
Live sports, 5M concurrent viewers, 5 Mbps per stream:
  Egress = 5,000,000 × 5 Mbps = 25,000,000 Mbps = 25 Tbps sustained
  Manifest TTL is ~2–6 s (segment duration) → every viewer re-fetches the manifest
    every few seconds:
    5M viewers ÷ 4 s ≈ 1.25M manifest req/s
  → the LIVE MANIFEST, not the segments, is the request-rate hotspot.
  Mitigation: micro-cache the manifest for ~1 segment duration + request collapsing so
  origin sees ~1 manifest fetch per interval regardless of viewer count.
```
Segments dominate **bandwidth**; the live manifest dominates **request rate**. Provision
and cache them for different bottlenecks.

**Design-review talking points**
- "Is the live manifest micro-cached to exactly one segment duration, with collapsing, so
  origin sees one fetch per interval?"
- "Are ABR variants keyed separately, and are segments marked immutable?"
- "On appliance/PoP failure, does the *client* fail over per-segment, or does it stall?"

---

## 9. Multi-CDN, Resilience, and Edge Security

### 🟢 Beginner — Don't Fly One Airline

If your whole trip depends on one airline and it grounds its fleet, you're stuck. Book so
you can switch carriers, and a single airline's bad day doesn't cancel your trip.
**Multi-CDN** is flying more than one airline: when one CDN has a global bad day (Fastly,
June 2021), you re-route to another and stay online.

---

### 🟡 Senior — Multi-CDN Steering, Cache Poisoning, DDoS, TLS

**Why run more than one CDN:**
1. **Vendor-failure resilience** — the Fastly 2021 lesson: one vendor's global bug
   shouldn't take you down.
2. **Performance arbitrage** — different CDNs win in different regions/ISPs; steer per-geo
   to the best performer.
3. **Cost optimization** — shift volume to the cheaper CDN where performance is equal.
4. **Capacity** — spread load beyond one vendor's ceiling.

**Real-time steering** is a control loop: **measure → decide → route → re-measure**, using
**RUM latency/error rates**, **synthetic probes/health**, **cost/capacity targets**, and
**business rules**. It returns the chosen CDN's hostname (short DNS TTL for agility) or
instructs a client SDK. Operational cost: duplicated config, cross-vendor purge, unified
TLS/cert management, and unified observability — roughly **N× the integration surface**.

**Cache poisoning** tricks a CDN into caching a malicious response served to everyone.
Classic vector: **unkeyed input**.
```
Attacker: GET /page   X-Forwarded-Host: evil.com
          → origin reflects evil.com into a <script src> in the HTML
          → CDN caches it because X-Forwarded-Host is NOT in the cache key
Victims:  GET /page   → served the poisoned HTML pointing scripts at evil.com
```
**Mitigations:** don't reflect unkeyed headers; **include every response-affecting input
in the cache key** (or `Vary`); **strip untrusted headers at the edge**; scope caching
narrowly.

**Edge DDoS mitigation:**

| Mechanism | Threat model |
|---|---|
| **Anycast absorption** | Volumetric L3/L4 floods — spread across all PoPs so no single site saturates |
| **Rate limiting / JS or CAPTCHA challenge** | L7 request floods, credential stuffing, scrapers |
| **WAF rules + IP reputation + SYN cookies** | App-layer exploits, known-bad sources, TCP-state exhaustion |

The edge is the ideal choke point: attack traffic is dropped **before** it reaches origin.

**TLS termination at the edge:** the CDN **decrypts** at the PoP, inspects/caches, then
re-encrypts to origin. Implication: the CDN sees **plaintext** — it is effectively a
**trusted man-in-the-middle** holding/serving your certs. Enterprise concern: data
residency and key custody. Mitigations: **keyless SSL** (CDN does the handshake but *your*
infra holds the private key), strict compliance contracts, and app-layer encryption of
sensitive fields. Tradeoff: **edge caching/optimization needs plaintext at the edge vs.
end-to-end confidentiality**.

---

### 🔴 Architect — A WAF-Blocks-Everyone Runbook

**Failure mode — a bad WAF rule blocks legitimate traffic globally** (the shape of the
Fastly 2021 event, and of self-inflicted WAF misconfigurations generally). You serve 10M
users. Runbook:

```
1. DETECT
   Alerts on: 403 rate ↑, successful req/s ↓, RUM error surge.
   Golden signals: errors up, (successful) traffic down. MTTD target: < 2 min.

2. DIAGNOSE
   Correlate the spike with the LAST CHANGE — check the change log first.
   Reproduce with a known-good request that is now blocked.

3. MITIGATE (fast, in order of blast-radius)
   a. Roll back the WAF rule (or set it to log-only / monitor mode).
   b. If the CDN control plane itself is the fault → fail over to the secondary CDN
      via traffic steering (short DNS TTL makes this minutes, not hours).
   c. Last resort: DNS-steer to origin / degraded direct-serve mode.

4. VERIFY
   Watch 403 rate return to baseline across regions/PoPs, not just one.

5. POST-MORTEM (blameless)
   Why did a rule reach global prod without a canary?
   Add: staged rollout for WAF rules, log-only soak, automated rollback on error-budget
   burn, tested multi-CDN failover. Track MTTD / MTTR.
```

**Why short DNS TTL is load-bearing here:** if your DNS TTL is 300 s, step 3b takes 5+
minutes to drain even after you decide; at ~30 s it's near-immediate. This is the direct
link between the routing chapter (§2) and incident survivability.

**Capacity note on failover:** when you steer 10M req/s off a failed CDN onto the
secondary, the secondary must have **pre-provisioned headroom** for your full peak — you
cannot assume it can absorb a doubling instantly. Multi-CDN resilience is only real if the
backup is sized (and contractually committed) for the failover load.

**Design-review talking points**
- "Can the secondary CDN absorb 100% of peak, or only overflow? What does the contract
  commit?"
- "Are WAF/config changes canaried and auto-rolled-back on error-budget burn?"
- "Do we terminate TLS at the edge, and if so, is key custody (keyless SSL) acceptable to
  compliance?"

---

## 10. Architect-Level Design and Capacity Math

### 🟢 Beginner — The Whole System on One Page

Putting it together: users hit the **nearest PoP** (routing), which serves from **cache**
(TTL/headers) most of the time; misses funnel through a **regional shield** to protect the
**origin**; **purge** keeps content correct; **edge functions** personalize; **multi-CDN**
survives a vendor outage. The architect's job is to make the arithmetic work — enough PoPs
for latency, enough hit ratio for origin survival, and enough redundancy for the bad day.

---

### 🟡 Senior — A Reference Design (10M req/s, 500M users, P99<50ms)

Target: 10M req/s peak, 500M users in 190 countries, P99 < 50 ms for static assets, 95%
hit ratio, 30 s purge propagation, 500K req/s origin capacity.

| Layer | Decision |
|---|---|
| **PoP placement** | Presence in every major population/peering region (Americas, EU, India, SEA, East Asia, ME, Africa, Oceania); Anycast for nearest-PoP + auto-failover |
| **Routing** | Anycast BGP primary; latency-based DNS steering across **multiple CDNs**; short DNS TTL (~30 s) |
| **Cache key** | Normalize URLs, strip tracking params; `Vary: Accept-Encoding` only; never `Vary: Cookie` for shared content |
| **TTL** | Hashed assets `max-age=1y, immutable`; HTML short + SWR; API `no-store`/micro-cache; segments long, live manifest short |
| **Origin shield** | One shield per region; request collapsing; push hit ratio to 98–99% for headroom |
| **Purge** | Surrogate-key tagging + pub/sub fan-out with ack tracking; versioned URLs for correctness-critical content; short TTL backstop |
| **Multi-CDN** | RUM-driven steering; documented runbook; origin degraded-serve path; secondary sized for full peak |

**Personalized homepage (cacheable shell + personalized fragments):**
- **Static shell (CSS/JS/layout):** hashed URLs, cached forever at edge.
- **Personalized bits (name, avatar, recommendations):** fetched separately, *not*
  shared-cached; marked `private`/`no-store`, or injected by an **edge function** from a
  token, or stitched via **ESI (Edge Side Includes)**.
- Avoid `Vary: Cookie` on the whole page (kills hit ratio). Tradeoff: **hit ratio vs.
  personalization**, solved by *separating* the cacheable and per-user layers.

---

### 🔴 Architect — Show the Arithmetic

**1. Origin-survival check (the number that fails most designs):**
```
10M req/s × (1 − 0.95 hit) = 500,000 req/s to origin  → EXACTLY at the 500K cap → no margin
Any hit-ratio dip breaches origin. Fixes, in order of leverage:
  a. Raise hit ratio to 98% → 10M × 0.02 = 200,000 req/s   (2.5× headroom)
  b. Origin shield + request collapsing → cross-PoP misses collapse toward ~1 per object
  c. stale-while-revalidate → expiry misses served stale, refreshed in background
Design target: 98–99% hit ratio so origin runs at ≤ 40% of capacity.
```

**2. Latency budget → PoP geography:**
```
P99 < 50 ms edge RTT. Light in fiber ≈ 200 km/ms one-way (≈ 2/3 c).
50 ms RTT ≈ 25 ms one-way ≈ up to ~5,000 km path — minus handshake/queueing overhead,
budget more like a few thousand km max to the serving PoP.
⇒ PoPs must sit near every major metro/IXP; no populated region can be > ~2,000–3,000 km
  from a PoP. This is why large CDNs run dozens–hundreds of metros.
```

**3. Bandwidth capacity:**
```
10M req/s × 100 KB avg object = 1,000,000,000 KB/s = ~1 TB/s = ~8 Tbps aggregate egress.
Spread across ~50 major PoPs weighted by population:
  8 Tbps / 50 ≈ 160 Gbps average per PoP.
Provision 2–3× for peak/failover headroom:
  ≈ 320–480 Gbps per PoP → multiple 100 GbE uplinks per PoP.
(All figures illustrative — provision to MEASURED peak, not average.)
```

**4. Failover headroom:** the secondary CDN must hold **full 8 Tbps / 10M req/s peak**, not
just overflow — otherwise "multi-CDN" fails exactly when you need it.

**Questions a strong candidate raises unprompted:**
- **Change frequency:** cache strategy is a *function of change rate*. Quantify how often
  each content type changes before choosing TTLs — a per-deploy JS bundle and a per-second
  personalized API demand opposite strategies.
- **Blast radius of stale data:** if a wrong price or retracted post stays cached 5 minutes
  across a region, how many users and what legal/business cost? That sets how aggressively
  you cache and whether you need versioned URLs + revalidation.
- **Private/authenticated content:** must you serve signed-URL/token content? It's a major
  design fork — no public cache keys, auth integrated at the edge, less aggressive caching.

---

## Quick Recall Cheat Sheet

> Close the file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| CDN win | Serve from a nearby PoP → ~3–4 RTT of setup at 10 ms instead of 120 ms (~12×) |
| PoP count meaning | More PoPs shrink the P99 tail for poorly-connected regions, not the median |
| Hit-ratio math | Misses × total = origin load; 95% of 10M/s = 500K/s; 99% = 100K/s (5× less) |
| Anycast | One IP, many PoPs; BGP routes to nearest *in topology* (not geography) |
| GeoDNS | Many IPs; DNS picks by resolver location (blind to resolver≠client; ECS helps) |
| Latency DNS | Route 53-style: lowest *measured* latency, since geo-closest ≠ lowest latency |
| DNS TTL | Short (~30 s) = fast failover; long = slow failover. Load-bearing in incidents |
| BGP defense | RPKI/ROA + prefix filtering vs. route leaks (Cloudflare, June 2019) |
| `max-age` vs `s-maxage` | `s-maxage` overrides for **shared** (CDN) caches only |
| `no-cache` vs `no-store` | `no-cache` = store but always revalidate (304); `no-store` = never store |
| ETag / 304 | Validator; `If-None-Match` → 304 (no body) = cheap freshness check |
| `Vary: Cookie` | Per-user cache key → hit ratio → 0. Never do it |
| TTL by type | Hashed asset = 1y immutable; HTML = short+SWR; API = no-store/micro; segment = long |
| Personalization leak | `public` on `/api/user/profile` serves user A to users B,C,D → use `private,no-store` |
| Push vs Pull | Push = pre-stage few hot files; Pull = fetch-on-miss for big catalogs |
| Cache-key hygiene | Strip utm_*/tracking params; only key on params that change the response |
| Surrogate key | Tag responses → purge a whole group (product-9876) in one call |
| `stale-while-revalidate` | Serve stale instantly, refresh in background → no expiry latency cliff |
| Purge under partition | Idempotent apply + acks + reconcile; versioned URLs for correctness-critical |
| Origin shield | Mid-tier PoP collapses N-PoP misses to ~1 origin fetch (~250×) |
| Request collapsing | Concurrent misses for one key → single origin fetch |
| Stampede stack | Collapsing + SWR + shield turns 250,000× spike into ~1 origin fetch |
| Edge function | Runs your code at the PoP; computes decisions a cache rule can't |
| Workers vs Lambda@Edge | Isolates (fast cold start, tight CPU) vs. containers (heavier, more capable) |
| Edge dependency trap | Never call JWKS/origin synchronously per request; cache keys + async refresh |
| HLS | Manifest (.m3u8) + immutable segments; **live** manifest = short TTL or stream freezes |
| Live video bottleneck | Segments = bandwidth hotspot; live manifest = request-rate hotspot (micro-cache it) |
| ABR | Multiple bitrate rungs, each cached under its own key |
| Open Connect | Push OCAs into ISPs; client-driven, health-aware per-segment failover |
| Multi-CDN | Survive vendor-wide outages (Fastly, June 2021); steer by RUM; size backup for full peak |
| Cache poisoning | Unkeyed reflected header cached + served to all → key on all inputs, strip untrusted |
| Edge DDoS | Anycast absorption (L3/4) + rate-limit/challenge (L7) + WAF/IP-rep/SYN cookies |
| TLS at edge | CDN is a trusted MITM; keyless SSL keeps your private key on your infra |
| WAF-blocks-all runbook | Detect (403↑) → correlate last change → roll back → CDN failover → blameless PM |
| Capacity: origin | 5% miss of 10M/s = 500K/s; push hit ratio to 98%+ for headroom |
| Capacity: latency | 50 ms RTT ≈ few-thousand-km max path → PoP near every major metro/IXP |
| Capacity: bandwidth | 10M/s × 100 KB ≈ 8 Tbps aggregate; ~160 Gbps/PoP avg × 2–3 for peak |
| Unprompted asks | Change frequency? Stale-data blast radius? Private/authenticated content? |
