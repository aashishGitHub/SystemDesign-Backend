# Deep Dive: URL Shortener (TinyURL / Bitly)

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> Companion to [questions.md](./questions.md) and [answers.md](./answers.md). Numbers are drawn from the constraints in this interview set (≈115K reads/sec, ≈1,157 writes/sec, 100:1 read:write, 100M new URLs/day, ~182B rows over 5 years). Where a figure is illustrative it is labelled; where a fact is not independently verifiable it is flagged.

---

## Table of Contents

1. [The Two Operations: A Read-Heavy Key-Value System](#1-the-two-operations-a-read-heavy-key-value-system)
2. [Base62 Encoding: The Short-Code Alphabet](#2-base62-encoding-the-short-code-alphabet)
3. [ID Generation: Counters, Snowflake, and the Hash-Truncate Trap](#3-id-generation-counters-snowflake-and-the-hash-truncate-trap)
4. [The Redirect: 301 vs 302 and the Analytics Contract](#4-the-redirect-301-vs-302-and-the-analytics-contract)
5. [Caching the Read Path: Redis, Cache-Aside, and Hot Keys](#5-caching-the-read-path-redis-cache-aside-and-hot-keys)
6. [Sharding the URL Store](#6-sharding-the-url-store)
7. [Click Analytics: Kafka, HyperLogLog, and Async Decoupling](#7-click-analytics-kafka-hyperloglog-and-async-decoupling)
8. [Abuse, Rate Limiting, and Security](#8-abuse-rate-limiting-and-security)
9. [Scale, Multi-Region, and Five-Nines Availability](#9-scale-multi-region-and-five-nines-availability)
10. [Lifecycle: Expiry, Reclaim, and the Forever-Link SLA](#10-lifecycle-expiry-reclaim-and-the-forever-link-sla)
11. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Two Operations: A Read-Heavy Key-Value System

### 🟢 Beginner — The Speed-Dial Phone Book

A URL shortener is a speed-dial for the web. You hand it a long, unwieldy address — `https://www.example.com/products/2024/spring/catalog?ref=email&utm=promo` — and it hands you back a short one like `tinyurl.com/x7Gh2Kq`. When anyone opens the short link, the service instantly forwards their browser to the original address.

The whole product is two actions:
- **Create** — long URL in, short code out. This is like programming "press 2 = call Mom" into your phone. It happens rarely.
- **Resolve** — someone presses the button, the phone looks up "2 → Mom's real number" and dials it. This happens constantly.

Everything else — analytics, custom names, expiry, spam blocking — is built around those two actions.

---

### 🟡 Senior — The Two Access Patterns

Both operations are **point operations keyed by the short code**. There are no range scans on the hot path — you never ask "give me all codes between X and Y." That single fact shapes the entire architecture: a point-lookup-by-immutable-key workload is nearly 100% cacheable.

```
CREATE (write path, ~1,157 req/sec):
  1. POST /shorten { "url": "https://..." }  → API gateway (auth, rate-limit)
  2. Validate URL (scheme http/https, length ≤ 2048, not on blocklist)
  3. Generate a globally-unique ID (counter block or Snowflake) — §3
  4. Base62-encode the ID → 7-char code — §2
  5. INSERT (short_code, long_url, created_at, expires_at, owner_id)
  6. (optional) warm cache: SET short_code → long_url
  7. 201 Created { "short_url": "https://tinyurl.com/x7Gh2Kq" }

RESOLVE (read path, ~115,000 req/sec):
  1. GET /x7Gh2Kq
  2. Look up "x7Gh2Kq" in Redis
       hit  → long_url (> 99% of reads)
       miss → read DB, repopulate cache
  3. 302 Found, Location: https://www.example.com/...
  4. Emit click event to Kafka asynchronously (does NOT block step 3)
```

| Operation | Access pattern | Frequency | Optimize for |
|---|---|---|---|
| **Resolve** `code → url` | Point read by primary key, extremely read-heavy | ~115K/sec | Latency (< 10ms P99) — serve from cache, never scan |
| **Create** `insert(code, url)` | Point insert, 100× rarer than reads | ~1,157/sec | Uniqueness + durability — can touch DB synchronously |

The 100:1 read:write ratio is the design's north star: you can afford a synchronous DB insert on create, but the resolve path must never touch disk.

---

### 🔴 Architect — Where Uniqueness Comes From (the Fork That Shapes Everything)

The single design decision that ripples through the whole system is **step 3 of create: where does the short code's uniqueness come from?** Two philosophies, and the choice cascades:

```
Path A — hash(url) then truncate:
  + Free deduplication (same URL → same code)
  − Uniqueness is PROBABILISTIC → collisions certain at scale (§3)
  − Every create becomes a read-check-retry loop as density rises
  → Coordination moves ONTO the hot write path

Path B — unique ID (counter block / Snowflake) then Base62-encode:
  + Uniqueness by CONSTRUCTION → no collision check at all
  + Coordination-free at write time (server mints locally from a reserved block)
  − Loses free dedup (same URL → different code unless you add a lookup)
  → This is what production systems converge on
```

**Design-review talking point:** if an interviewer proposes deduplicating identical URLs, name the real cost — it forces a read-before-write (or a unique index on `long_url`, expensive at 182B rows) and, worse, it makes two customers **share** a link and its click analytics. For a business shortener that is an attribution/privacy defect, not a feature. Consumer shorteners may dedup; B2B shorteners mint distinct codes so each customer gets isolated analytics.

**Capacity sanity check (illustrative):** 100M creates/day ÷ 86,400 s ≈ **1,157 creates/sec** average. 182.5B rows × ~500 bytes ≈ **~91 TB** of primary data before replication. Reads at 115K/sec are 100× writes — so the DB is provisioned for the *write* path plus cache-miss traffic (~2K/sec), never for the read firehose.

**Real-world signal:** Bitly's actual business is B2B link management — mutable destinations plus per-customer analytics — which is precisely why the "distinct codes, no dedup" path is the industry default. The free consumer tool is the funnel, not the product.

---

## 2. Base62 Encoding: The Short-Code Alphabet

### 🟢 Beginner — Why Not Just Use Numbers?

If you numbered links 1, 2, 3, … you'd need long strings fast (a billion links is a 10-digit number). Letters help: using digits **and** upper- and lower-case letters gives you 62 symbols instead of 10, so each character carries far more information. Seven such characters cover trillions of links.

Think of it like license plates. A plate with only digits runs out quickly; adding letters means far more unique plates in the same number of characters.

---

### 🟡 Senior — Base62 Encode/Decode and Why Not Base64

Base62 is positional notation in base 62 over the alphabet `[0-9A-Za-z]`. Encoding a number means repeatedly taking it modulo 62 and dividing.

```typescript
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 62 chars
const BASE = 62n;

function encode(id: bigint): string {
  if (id === 0n) return "0";
  let out = "";
  while (id > 0n) {
    out = ALPHABET[Number(id % BASE)] + out;
    id = id / BASE;                       // integer (floor) division
  }
  return out;
}

function decode(code: string): bigint {
  let id = 0n;
  for (const ch of code) {
    id = id * BASE + BigInt(ALPHABET.indexOf(ch));
  }
  return id;
}
// encode / decode are exact inverses: decode(encode(x)) === x
```

**Why Base62 and not Base64?** Base64's alphabet contains three characters that break URLs:

| Char | Problem in a URL |
|---|---|
| `+` | Decoded as a space in `application/x-www-form-urlencoded` query strings |
| `/` | Path separator — `short.ly/a/b` reads as two path segments |
| `=` | Padding; ambiguous, often stripped |

There is a `base64url` variant (`+/` → `-_`, no padding), but `-` and `_` are still easy to mis-transcribe and can be confused with hyphenated word-breaks when a link is printed or read aloud. Base62 needs no escaping, double-click-selects as one token, and survives copy-paste through any medium.

---

### 🔴 Architect — The Namespace Math (62ⁿ)

The capacity of an n-character Base62 code is exactly **62ⁿ**:

| Length | 62ⁿ | Value |
|---|---|---|
| 6 | 62⁶ | 56,800,235,584 ≈ **56.8 billion** |
| 7 | 62⁷ | 3,521,614,606,208 ≈ **3.52 trillion** |
| 8 | 62⁸ | 218,340,105,584,896 ≈ **218 trillion** |

**Fill-time arithmetic (illustrative):** at 100M creates/day, exhausting 62⁷ takes `3.52×10¹² / 10⁸ = 35,216 days ≈ 96 years`. Seven characters is the industry-standard sweet spot: short enough to be tweetable, large enough to last a century.

**The elegant migration property:** a short code is an **opaque lookup key**. Extending 7 → 8 characters is a **config-only, non-breaking change** — the Base62 encoder naturally emits 8 characters once IDs exceed 62⁷, old 7-char codes keep resolving (the resolver is just a key lookup, length-agnostic), and no existing data migrates. You go to 8 chars only for namespace exhaustion or more entropy, never as an emergency.

**Design-review talking point:** if human transcription matters (codes read aloud, typed from print), some systems drop the visually ambiguous glyphs `0/O`, `l/1/I` and use **Base58** — the same alphabet Bitcoin addresses use, chosen for exactly this readability reason. It trades a slightly smaller namespace (58ⁿ) for fewer transcription errors.

**Real-world signal:** YouTube video IDs are 11-character URL-safe codes (a base64url-style alphabet) rather than sequential integers; the opaque-key-in-the-URL pattern is used widely to keep identifiers non-sequential and copy-paste-safe. (I am confident YouTube uses fixed-length opaque IDs; treat the exact alphabet details as illustrative.)

---

## 3. ID Generation: Counters, Snowflake, and the Hash-Truncate Trap

### 🟢 Beginner — Two Ways to Hand Out Ticket Numbers

Imagine a deli counter. Two ways to give each customer a unique number:

1. **The ticket dispenser (counter):** everyone pulls the next number in sequence. Guaranteed unique, but if the machine sits in one place, everyone has to queue at it.
2. **The dice roll (hash):** each customer rolls dice and uses the result as their number. Fast and no queue — but eventually two people roll the same number, and now you have a fight over who's next.

The lesson of this whole section: dice-rolls (hashing) *feel* convenient but eventually collide; dispensers (counters/Snowflake) are unique forever. The engineering is in making the dispenser fast without a queue.

---

### 🟡 Senior — Counter Blocks and Snowflake

A naive central counter (one row, incremented per create) is a bottleneck and a single point of failure. The fix is **ranged blocks**: each app server reserves a *block* of IDs and mints locally with zero coordination.

```typescript
class IdAllocator {
  private next = 0n;
  private ceiling = 0n;
  private readonly BLOCK = 1000n;

  async nextId(): Promise<bigint> {
    if (this.next >= this.ceiling) {
      // Atomic reserve: INCRBY returns the NEW top of the reserved range.
      const top = BigInt(await counter.incrby("url:id", Number(this.BLOCK)));
      this.ceiling = top;
      this.next = top - this.BLOCK;
    }
    return this.next++;                    // local, lock-free, no network hop
  }
}
```

Server A gets `[1..1000]`, server B gets `[1001..2000]`, and so on. Each mints from its own block; only when a block drains does it fetch another. Fetch early (at ~80% used) so there's never a stall.

The other coordination-free option is a **Snowflake ID** (open-sourced by Twitter in 2010) — a 64-bit integer many servers mint in parallel:

```
 1 bit  |        41 bits          |  10 bits   |  12 bits
 unused | ms since custom epoch   | machine id | sequence #
```

| Field | Bits | Capacity |
|---|---|---|
| Timestamp (ms) | 41 | 2⁴¹ ms ≈ **69.7 years** from a custom epoch |
| Machine / worker id | 10 | 2¹⁰ = **1,024** generators |
| Sequence per ms | 12 | 2¹² = **4,096** IDs per machine per ms |

That is 1,024 × 4,096 ≈ **4.19 million IDs/sec** cluster-wide, all unique, no lock, no round-trip. Bonus: the timestamp is the high bits, so IDs sort roughly by creation time (good for DB index locality).

| Property | Base62(counter/Snowflake) | MD5(url) truncated to 7 chars |
|---|---|---|
| Uniqueness | Guaranteed by construction | **Probabilistic** — collisions certain at scale |
| Collision handling | None needed | Must retry with a salt on every collision |
| Determinism | Same URL → different code (unless you dedup) | Same URL → same code (natural dedup) |
| Failure mode | ID source down / counter exhaustion | Collisions grow with URL count (birthday) |

---

### 🔴 Architect — The Birthday Wall and Auto-Increment Leaks

**Why hash-truncate is a trap.** Truncating a 128-bit MD5 to a 7-char Base62 code (~2⁴¹·⁷ ≈ 3.52×10¹² slots) throws away nearly all of MD5's collision resistance. The birthday problem governs it:

```
P(collision after k insertions into N slots) ≈ 1 − e^(−k² / 2N)   (for k << N)

N = 62⁷ = 3.52×10¹²

k = 1,000,000:   k²/2N = 10¹² / 7.04×10¹² = 0.142  → P ≈ 1 − e^(−0.142) ≈ 13.2%
k = 100,000,000: k²/2N = 1,420                     → P ≈ 100% (certain)

50% cumulative collision at k ≈ 1.177·√N = 1.177·√(3.52×10¹²) ≈ 2.2 MILLION codes.
```

The striking part: 50% collision probability arrives at only ~2.2M URLs, and certainty by ~100M — *far* below the namespace's 3.5-trillion capacity (100M is 0.003% full). **Hash-truncate fails at a URL count orders of magnitude below exhaustion.** These are derived from the birthday approximation, not measured benchmarks.

**What a collision *is* in production:** a wrong redirect — customer A's link now points to customer B's destination. That is worse than a 404; it's a correctness and security incident. The fix when you're already on hash-truncate: `INSERT ... IF NOT EXISTS` (unique constraint so a collision can never overwrite), re-hash with an incrementing salt on conflict (`md5(url + ":" + attempt)`), then migrate new codes to counter/Snowflake and extend 7 → 8 chars for headroom.

**Why not raw auto-increment?** Two disqualifying leaks for a *public* shortener:

| Risk | Mechanism | Impact |
|---|---|---|
| **Enumeration** | Sequential codes: `abc0001 → abc0002 → …` all valid | Attacker walks the space, scrapes every URL ever created |
| **German-tank BI leak** | Create one link today (ID 1,000,000), one tomorrow (1,050,000) | The delta reveals ~50,000 links/day — competitors read your volume and growth |

Keep a dense internal monotonic ID (great for locality) but **decouple the external code**: run the ID through a reversible bijective scramble (a Feistel network, or multiply-by-a-coprime mod N) before Base62-encoding, or use Snowflake whose machine/sequence bits break strict adjacency.

**Counter-service failure mode:** if the central counter dies, each server keeps minting from its **currently reserved block** — a grace window of `block_size ÷ mint_rate`. With 1,000-ID blocks at normal rates that's seconds-to-minutes of runway. Mitigate by (1) sizing blocks to outlast your MTTR, (2) prefetching at 80%, (3) running the counter as a replicated HA service. Tradeoff is **block size vs wasted IDs** — a server crashing with 900 unused IDs "wastes" them, but against a 3.5-trillion namespace that is irrelevant.

**Real-world signal:** this ranged-block pattern is essentially **Flickr's "ticket server"** design — MySQL auto-increment with offset stepping (e.g., one server issues odd IDs, another even) to get coordination-free unique IDs from a boring, well-understood component. (I am confident about Flickr's ticket-server approach; exact stepping details vary by write-up.) Instagram published a similar sharded-ID scheme combining a timestamp, a shard id, and a per-shard sequence — the same "time bits + machine bits + sequence bits" idea as Snowflake.

---

## 4. The Redirect: 301 vs 302 and the Analytics Contract

### 🟢 Beginner — The Forwarding Address

When you move house, you can leave two kinds of note at the post office:

- **"Moved permanently"** — the post office updates its records and stops even looking at the old address. Mail goes straight to the new place forever. Efficient, but you can never change it again, and you'll never know how much mail was still being sent to the old address.
- **"Temporarily forwarding"** — every letter still passes through the old address first, gets stamped "forwarded," and continues on. You can change the destination any day, and you can count every letter.

A URL shortener wants the second kind. It needs to count clicks and be able to re-point the link. That's the whole reason for the choice below.

---

### 🟡 Senior — 301 vs 302 and the Response Headers

| | 301 Moved Permanently | 302 Found (temporary) |
|---|---|---|
| Browser caching | Aggressively cached, often "forever" | Not cached by default |
| Repeat clicks | Browser skips the shortener → goes straight to destination | Browser returns to the shortener every time |
| Analytics | **You lose click tracking after the first hit** | **Every click is counted** |
| Re-pointing | Very hard — stale 301 cached in millions of browsers | Easy — next click re-reads the mapping |
| SEO link equity | Passes to destination | Not passed (treated as temporary) |
| Server load | Lower (fewer repeat requests) | Higher (all repeats hit you) |

**Use 302.** A shortener's product value *is* analytics and mutable destinations, and both require the browser to come back on every click. The extra load is affordable because the read path is cache-served (< 10ms).

The header pairing that makes a 302 *actually* behave as temporary:

```http
HTTP/1.1 302 Found
Location: https://www.example.com/products/spring/catalog
Cache-Control: private, no-store            ; do NOT let browsers/proxies cache the redirect
Referrer-Policy: no-referrer                ; don't leak the short URL to the destination
X-Content-Type-Options: nosniff             ; defense in depth
Strict-Transport-Security: max-age=63072000 ; force HTTPS on our short domain
Content-Length: 0
```

A 302 with a long `max-age` would be cached and quietly reintroduce the 301 problem. `no-store` guarantees the browser returns for every click.

---

### 🔴 Architect — The Latency Budget and a Cache-Poisoning Failure

**What "< 10ms P99" really means.** The SLO is on *generating the redirect response*, not end-to-end page load (the destination site is outside your control). A 302 adds one client round-trip (short URL → 302 → long URL); to keep the *response generation* under 10ms P99:

```
- Lookup from Redis (sub-ms) or edge cache, NEVER PostgreSQL (~1–10ms + network)
- Redirect service co-located with / near the cache (avoid cross-AZ hops)
- Cache hit rate > 99% so the p99 request is STILL a cache hit
- Click event emitted async (fire-and-forget to Kafka) — analytics adds 0 latency
- No synchronous malware re-check, no synchronous counter increment on the hot path
```

The moment a redirect touches disk or a remote DB, the p99 blows. The cache is not an optimization here — it is load-bearing architecture.

**Failure mode — 5% of users land on a 3-day-old destination.** Most likely: a `301` (or a `302` with a cacheable `Cache-Control`) was served for those links at some point, so browsers/proxies cached the *old* destination. The customer then re-pointed the link, but the 5% whose browsers hold the cached permanent redirect keep going to the stale target ("3 days ago" ≈ the age of the cached entry).

```
Diagnosis:  curl -I the short URL in prod. Look for 301 or a big max-age on a 302.
Fix:        serve 302 + Cache-Control: no-store for ALL redirects.
            You CANNOT purge already-cached 301s from users' browsers — they
            expire on their own. For poisoned links the only clean remedy is to
            mint a NEW code for the new destination and retire the old one.
Guardrail:  alert if any redirect response ever emits 301 or a cacheable
            Cache-Control. Treat it as a config regression.
```

**Design-review talking point / the lesson interviewers reward:** *a 301 is a promise you cannot take back.* Once cached in the wild it is effectively permanent, which also means you lose the ability to **revoke a malicious link** (§8) — a phishing destination behind a 301 keeps sending users there. Control and observability are the product; the load a 301 would save is not your bottleneck.

---

## 5. Caching the Read Path: Redis, Cache-Aside, and Hot Keys

### 🟢 Beginner — The Librarian's Front Desk

A library keeps millions of books in the basement (slow to fetch). But the ten books everyone wants this week sit on the front desk. When you ask for one, the librarian checks the desk first — instant. Only if it's not there do they walk to the basement, and on the way back they leave the book on the desk for the next person.

That's a cache. The front desk (Redis) serves the popular items instantly; the basement (database) is the source of truth you only visit on a miss.

---

### 🟡 Senior — Cache-Aside with a Negative Cache

Why the DB alone can't do it: even a primary-key lookup costs a network hop + B-tree traversal + possible page read — realistically ~1–10ms, and it *degrades* under 115K QPS (connection-pool exhaustion, IOPS saturation). Redis `GET` of a short string is sub-millisecond and horizontally shardable.

```
Key:        u:{short_code}  → long_url      (short keys save memory at 100M+ links)
TTL:        SET u:abc123 <url> EX 86400      (24h sliding window)
Pattern:    CACHE-ASIDE (lazy load) on reads
Eviction:   maxmemory-policy allkeys-lru     (bound memory, evict coldest links)
```

```typescript
async function resolve(code: string): Promise<string | null> {
  const hit = await redis.get(`u:${code}`);
  if (hit !== null) return hit === "__404__" ? null : hit;   // ~99%+ of reads
  const url = await db.lookup(code);                         // miss → source of truth
  if (url) {
    await redis.set(`u:${code}`, url, "EX", 86400);          // repopulate
  } else {
    await redis.set(`u:${code}`, "__404__", "EX", 60);       // NEGATIVE cache
  }
  return url;
}
```

| Decision | Choice | Why |
|---|---|---|
| Cache-aside vs write-through | **Cache-aside** for reads | Only caches links people actually click; write-through would cache 100M/day, most never clicked |
| TTL | 24h sliding (reset on hit) | Balances freshness (re-pointing takes effect within TTL) vs hit rate |
| Cache miss | Read DB, repopulate; negative-cache 404s | Stops an enumeration attack from becoming a DB DoS |
| Eviction | `allkeys-lru` | Memory bounded; the long tail evicts, hot links stay warm |

The negative cache (`__404__`, short TTL) is not optional: without it, an attacker requesting random codes (§8) drives every request to the DB.

---

### 🔴 Architect — The Hot Key and the Cache-Down Cascade

**The hot-key problem.** Consistent hashing spreads *keys* evenly across Redis nodes, but it cannot spread the *load of one key*. A viral link is one key:

```
Celebrity tweets a bit.ly link:
  Normal link: ~1 click/day
  Viral link:  ~500,000 clicks/minute, ALL on key u:viral123
  → that key lives on exactly ONE shard → that shard hits 100% CPU/NIC
  → every OTHER shard is idle. Adding shards does not help; a key can't split.
```

| Mitigation | How |
|---|---|
| **Local (L1) in-process cache** | Each redirect server caches the hottest codes in RAM (LRU, 1–5s TTL). Viral link served from app memory; Redis barely touched. **Highest-leverage fix** — nobody re-points a link mid-virality, so a tiny TTL is safe. |
| **Key fan-out / replication** | Store the value under N suffixed keys `u:viral123#0..#9` across shards; reads pick a random suffix, spreading load 10× |
| **Read replicas for the hot shard** | Round-robin reads across replicas |
| **CDN edge cache** | Terminate the redirect at the edge before it reaches origin |

**The cache-down cascade** — what happens if Redis dies completely:

```
T+0   Redis dies. Hit rate 99% → 0%.
T+0   ALL 115K reads/sec fall through to the DB (cache-aside miss path).
T+1s  DB was sized for ~2K QPS (writes + normal misses), not 115K.
        115K / ~20K DB ceiling ≈ 5.75× overload → pool exhaustion → query
        queueing → p99 explodes → timeouts → retries → MORE load (retry storm)
        → DB effectively down → redirects 5xx.
Result: total outage even though the DB "survived" — it's saturated.
```

Can the DB take 115K/sec? **No** — that is the entire reason the cache exists. Defenses: Redis HA (replicas + Sentinel/Cluster, multi-AZ so total loss requires a multi-AZ event); multi-tier cache (L1 + CDN absorb the hottest 80–95% even if Redis is gone); **request coalescing / single-flight** (collapse concurrent misses for the same key into one DB read); **circuit breaker** to the DB (serve stale/L1 or 503 rather than pile on); load shedding.

**Design-review talking point:** *a cache that is load-bearing is a single point of failure unless it is itself redundant and backed by additional tiers.* Never let a cache be a hard dependency without a fallback plan.

**Edge caching tradeoff:** pushing the redirect to a CDN (Cloudflare/Akamai/Fastly) gives the best global latency and massive origin offload, but fights the shortener's core needs — re-pointing requires a global purge, and if the edge serves the redirect you may not see the click (same 301-style blindness) unless the edge beacons it back. Common hybrid: edge with a **very short TTL** (seconds) to absorb viral spikes without meaningfully hurting freshness or analytics. **Cloudflare Workers KV** is a real product used for exactly this edge-KV redirect pattern.

**Real-world signal:** the L1-then-Redis-then-DB tiering is the standard shape of every high-QPS read service; the viral-link hot-key case is the canonical reason an in-process L1 tier exists even when a shared Redis is "fast enough" on paper.

---

## 6. Sharding the URL Store

### 🟢 Beginner — Too Many Files for One Cabinet

One filing cabinet holds only so many folders. When you have billions, you buy more cabinets and need a rule for which cabinet a folder goes in. A good rule lets anyone find a folder instantly *and* keeps the cabinets roughly equally full. A bad rule crams everything into one cabinet while the others sit empty.

For a shortener, the rule is "which cabinet by the short code" — because the short code is exactly what you have in hand when someone clicks a link.

---

### 🟡 Senior — Shard by Short Code, Not User ID

182B rows exceed a single instance. Partition horizontally, keyed on the **short code** (the hot lookup key):

```
shard = hash(short_code) % NUM_SHARDS     # or consistent hashing (see below)

Resolve (99.99% of traffic): you HAVE the short_code → compute the shard directly
  → single-shard point lookup. No scatter-gather. Perfect.
Create: mint code → compute shard → insert. Also single-shard.
```

| | Shard by `hash(short_code)` | Shard by `user_id` |
|---|---|---|
| Redirect (code → url) | **Single shard** — you have the code | **Scatter-gather** — code alone doesn't reveal the owner |
| "All links for user X" | Scatter-gather across shards | **Single shard** — user's links co-located |
| Load distribution | Even (hash spreads uniformly) | **Skewed** — a whale customer becomes a hot shard |
| Dominant workload fit | Redirects (115K/sec) | Per-user dashboard reads (rare) |

**Choose shard-by-short-code.** Optimize for the operation that runs 115K times/sec, not the dashboard query that runs occasionally. Serve "all links for user X" via a **secondary index** (`user_id → [codes]`) in a separate store. Sharding by user_id would force every redirect into a scatter-gather and create hot shards for large customers — unacceptable.

Sizing (illustrative): 182.5B × ~500 bytes ≈ **~91 TB** primary. With 16 shards ≈ 11 TB/shard (×3 with replicas). Each shard is a **replicated cluster** (primary + replicas), never a single node.

---

### 🔴 Architect — Hotspots, Consistent Hashing, and a Lost Shard

**Diagnose a hotspot before fixing it:**

```
Is it a KEY-distribution problem or an ACCESS-frequency problem?
  Key distribution (one shard owns too many codes) → rebalance / vnodes
  Access frequency (a few viral codes on one shard) → cache harder, do NOT reshard
```

For a shortener, hotspots are almost always **viral individual links (access frequency)**, so the first-line fix is more caching (L1 + Redis + edge), not resharding. Resharding is reserved for genuine key-distribution imbalance. **Tradeoff — data movement vs load absorption:** caching absorbs load with zero data movement; resharding moves data but permanently rebalances.

**When consistent hashing earns its complexity.** `hash(code) % N` is fine for a *fixed* shard count. The problem is when N changes: modulo remaps ~(N−1)/N of all keys (8→9 shards moves ~89%), a migration + cache-invalidation storm. Consistent hashing moves only ~1/N of keys.

| | Modulo `% N` | Consistent hashing (+ vnodes) |
|---|---|---|
| Keys moved when adding a shard | ~(N−1)/N (near-total) | ~1/N (bounded) |
| Best for | Fixed, never-resized cluster | A cluster that grows/shrinks over time |
| Complexity | Trivial | Ring + virtual nodes for balance |

The problem consistent hashing *actually* solves is not lookup speed — it's **bounding the blast radius of a topology change** so scaling out doesn't trigger a full reshuffle and a thundering herd. For a system growing from 182B toward larger, the shard count *will* change, so it's worth it. (See the [consistent-hashing deep-dive](../consistent-hashing/deep-dive.md) for ring mechanics.)

**Failure mode — 1 of 8 shards down, 12.5% of redirects 500ing:**

```
Immediate (minutes):
  1. Fail over to a replica of the dead shard (promote replica → most traffic recovers).
  2. Serve that shard's hot keys from Redis (many don't need the DB at all).
  3. Return 503 (retryable), not 500, for the unresolvable tail.
Recovery (hours):
  4. Rebuild the shard from snapshot + WAL; re-add to the ring.
  5. Verify integrity (row counts, checksums) before restoring write traffic.
Architectural fix:
  6. EVERY shard = a replicated group (RF ≥ 3, multi-AZ), never a single node.
  7. Automated failover (managed DB / Patroni) so promotion is seconds, not a 2am human.
```

**Design-review talking point:** *a shard must never be a single point of failure.* With replication + auto-failover, one node dying degrades latency for seconds, not availability for 12.5% of users.

**Real-world signal:** the "monotonic partition key becomes a hot shard" trap is documented from DynamoDB (a customer keyed on `date`, sending all of "today's" writes to one partition until it throttled). The lesson generalizes: hash sharding distributes by key *hash*, not by *access frequency* — sequential or time-based keys are a structural hotspot regardless of algorithm.

---

## 7. Click Analytics: Kafka, HyperLogLog, and Async Decoupling

### 🟢 Beginner — The Turnstile Counter

A stadium doesn't make you wait while it writes your name in a ledger — you walk through the turnstile immediately, and the turnstile *clicks* a counter. The counting happens off to the side and never slows you down. Later, staff read the counters to see how many people came, from which gates, at what times.

A shortener works the same way: the redirect fires instantly (the turnstile), and a click event is dropped into a queue to be counted later, off the hot path.

---

### 🟡 Senior — The Async Pipeline and INCR vs Kafka

The rule: **the redirect returns first; analytics happens off the hot path.**

```
Redirect service:
  1. Resolve code → 302 (return to user)                 ← < 10ms, blocking
  2. Fire-and-forget a click event to Kafka:             ← async, non-blocking
     { code, ts, ip, user_agent, referrer, geo_hint }

Kafka (topic: clicks, partitioned by short_code)
       ▼
Stream consumers (Flink / Kafka Streams / Spark):
  - user_agent → device type ;  GeoIP(ip) → country
  - PFADD hll:{code} ip      → unique visitors (HyperLogLog)
  - INCR counters by (code, country, device, hour)
       ▼
Stores: aggregates → OLAP (ClickHouse/Druid/BigQuery)
        raw events → cheap object storage (S3) for re-processing
```

Kafka in the middle **decouples** the redirect's rate from the analytics rate, buffers spikes (a viral link won't overwhelm the aggregator), and lets you **replay** events if a consumer has a bug.

| | `INCR code:clicks` in Redis | Stream to Kafka + async process |
|---|---|---|
| Latency to increment | Sub-ms, on/near hot path | Zero on hot path (fire-and-forget) |
| Data richness | Just a counter | Full event: geo, device, referrer, ts |
| Re-slice by new dimension | Impossible (only count survives) | Yes — replay raw events |
| Durability | Volatile unless persisted | Durable, replayable log |
| Failure isolation | A Redis hiccup can slow redirects | Redirect unaffected by analytics outage |
| Best for | One instant approximate number | Rich, multi-dimensional, auditable analytics |

Often you do **both**: `INCR` for the instant top-line badge, Kafka for the durable rich pipeline. **Named tradeoff — immediacy vs flexibility + durability.**

**Counting unique visitors without exploding memory.** A `SET` of IPs per code costs O(unique IPs) — a viral link with 10M uniques ≈ 10M × ~16 B ≈ 160 MB *per link*. Unworkable. **HyperLogLog** estimates cardinality in fixed ~O(1) space by observing the longest run of leading zeros in hashed inputs:

```
PFADD   hll:{code} 1.2.3.4        # add a visitor IP
PFCOUNT hll:{code}                # approximate unique count
PFMERGE hll:total hll:a hll:b     # union across codes/windows, still O(1) space
```

| | Exact SET of IPs | HyperLogLog |
|---|---|---|
| Memory | O(n), unbounded | **Fixed ~12 KB** per HLL (Redis) |
| Accuracy | Exact | Approximate, **~0.81% std error** (Redis) |
| Merge across windows | Expensive union | `PFMERGE` — cheap, still ~12 KB |

For "unique visitors," 0.81% error is invisible to the customer. (12 KB and 0.81% are documented figures for Redis's HLL implementation.)

---

### 🔴 Architect — Consumer Lag and Real-Time vs Batch

**Real-time (per-second) dashboard vs "good enough in 5 minutes."** The per-second requirement pulls aggregation forward and adds a push channel:

| | 5-minute dashboard | Per-second real-time |
|---|---|---|
| Aggregation | Micro-batch (1–5 min), cheap | Continuous stream + low-latency store |
| Store | Columnar OLAP queried on demand | In-memory counters (Redis) or Druid/Pinot |
| Delivery | Client polls | Server push (WebSocket/SSE) |
| Cost | Low | High — whole pipeline stays hot |
| Pipeline failure | Minutes stale (tolerable) | Dashboard visibly freezes (customer-facing) |

Most customers don't need per-second; sell the 5-minute view by default, reserve real-time for premium — real-time roughly multiplies analytics infra cost.

**Failure mode — Kafka consumer 2 hours behind (50M events lag):**

```
Detection:
  Monitor consumer lag = (log-end-offset − committed-offset) per partition.
  Alert when lag grows monotonically. Symptom: redirects green, dashboards
  stuck 2h ago.
User impact:
  Redirects: NONE — the whole point of decoupling. Analytics: 2h behind, but
  numbers are STALE, not wrong (they'll catch up). No data loss (Kafka retains).
Recovery:
  1. Find cause: throttled OLAP sink? poison message? under-provisioned
     consumers? a hot partition (skew on one popular code)?
  2. Scale consumers up to the partition count (parallelism ceiling = #partitions).
     If one partition is the bottleneck (hot code), repartition / add a salt key.
  3. Consumers burn down backlog faster than real-time once unblocked.
  4. Size Kafka retention (e.g., 7 days) so backlog never exceeds it → no loss.
```

**Design-review talking point:** *decoupling converts a would-be outage into a bounded staleness problem.* Because analytics is async, falling behind degrades a non-critical feature (freshness), not redirects — and Kafka's durable log means recovery without data loss. Preconditions: partition count >> peak parallelism, autoscale on lag, idempotent writes so replay is safe, a DLQ for poison messages.

**Raw vs pre-aggregated storage** (a classic senior follow-up): at 10B events/day, raw is ~1 TB/day (the question's figure) — expensive but flexible; pre-aggregates are tiny but locked to the dimensions you chose. Standard resolution: **raw in cheap cold storage (S3, tiered retention) for forensics and re-slicing + aggregates for serving dashboards.** Cold storage makes 1 TB/day affordable while dashboards stay fast.

**Real-world signal:** Bitly built and open-sourced **NSQ**, a realtime distributed message queue, to power exactly this kind of decoupled event pipeline. (I am confident about NSQ's origin at Bitly; treat exact internal topology as illustrative.)

---

## 8. Abuse, Rate Limiting, and Security

### 🟢 Beginner — The Bouncer at the Door

A club has a bouncer who does three things: stops any one person from flooding the door (rate limiting), keeps out people on a known-troublemaker list (blocklists), and can eject someone already inside if they start a fight (revocation). A URL shortener needs the same bouncer — because anyone on the internet can walk up and ask it to create or open links.

---

### 🟡 Senior — Token-Bucket Rate Limiting and Blocklists

A spammer creating 10,000 links/minute is stopped by a **layered, centralized** rate limit:

```
1. Per-API-key / per-user quota (token bucket): e.g., 100 creates/min, burst 200.
2. Per-IP limit for anonymous creation (sliding-window counter).
3. Global anomaly detection: a key suddenly 100× baseline → auto-throttle + alert.
4. Reputation tiers: new accounts get low quotas; earned trust raises them.
```

```typescript
// Distributed token bucket in Redis. Refill `rate` tokens/sec up to `burst`;
// each create costs 1 token. The Lua script makes read-refill-decrement atomic
// in ONE round-trip, so a spammer racing across app servers can't beat it.
async function allow(key: string, rate = 100/60, burst = 200): Promise<boolean> {
  return await redis.eval(TOKEN_BUCKET_LUA, [`rl:${key}`], [rate, burst, now()]);
}
```

| Algorithm | Property |
|---|---|
| **Token bucket** | Allows bursts up to `burst`, smooth average `rate`. Best general choice. |
| Sliding-window log/counter | Precise per-window limits; more memory |
| Fixed window | Cheapest; suffers 2× boundary bursts at the edge |

Rate limiting **must be centralized (Redis)**, not per-instance — a spammer round-robins across app servers, so per-instance counters miss the aggregate.

Per-customer allow/blocklists enforce org policy at **create time** (cheap, ~1.2K/sec write path), with the compiled policy cached per customer:

```
policy(customer_id, mode ENUM['allowlist','blocklist'], patterns[])
validateDestination(customerId, url):
  host = parse(url).host                    # normalize: punycode, case, trailing dot
  if blocklist and matchesAny(host, patterns): reject(403)
  if allowlist and NOT matchesAny(host, patterns): reject(403)
```

---

### 🔴 Architect — Enumeration, Phishing Revocation, and the 2am Kill Switch

**Enumeration defense.** An attacker walks `short.ly/aaaaaaa, aaaaaab, …` to scrape links. Layered defense:

```
1. NON-SEQUENTIAL codes (random/scrambled/Snowflake) — foundational; knowing one
   valid code gives ZERO information about the next.
2. Sparse namespace: 182.5B of 62⁷ = 3.52T → ~5.2% density. (Note: 5.2% is a HIGH
   hit rate — sparsity ALONE is not enough. 62⁸ = 218T → ~0.08%.)
3. Rate-limit + bot-detect on 404 floods; negative-cache 404s so scanning can't DoS the DB.
4. Accept the model: a shortener is "anyone with the link can access." It is NOT an
   access-control mechanism. Sensitive resources need real auth behind the redirect.
```

The honest senior answer names the limit: enumeration is *deterred* (non-sequential + rate limiting), not *prevented*.

**Phishing / malware.** The architectural enabler is that **you control the redirect** (302, not cached 301), so you can revoke a bad link at any moment and it stops working on the next click:

```
Prevention (create time):
  - Check destination against threat feeds: Google Safe Browsing, PhishTank, proprietary.
  - Block/flag known-bad domains synchronously.
Reactive (destinations mutate — a benign page turns malicious later):
  - Continuous re-scan of existing links.
  - On detection: DISABLE the code (interstitial warning or 410) — don't delete;
    preserve for investigation/audit.
```

**Named tradeoff — creation latency vs safety:** fast synchronous blocklist check + asynchronous/continuous deep scanning.

**Failure mode — zero-day exploited through your links; law enforcement at 2am.** Response quality is decided by what you built *beforehand*:

```
The night of:
  1. Triage: which codes resolve to the exploited domain? (needs a REVERSE INDEX)
  2. Contain: DISABLE those codes — takes effect on next click because we use 302.
  3. Preserve evidence: snapshot rows + click logs BEFORE cleanup (chain of custody).
  4. Communicate: incident commander + legal + comms; provide LE data under process.
  5. Broaden: block the destination pattern at CREATE time; scan for related IOCs.

Systems you MUST have PRE-BUILT to respond in minutes:
  - A kill switch (disable any code / all codes matching a destination pattern).
  - Reverse index: destination → [short codes].
  - Retained, queryable click logs (who/when/where).
  - Threat-intel integration + block-on-create pattern list.
  - On-call runbook + legal escalation path.
```

**Design-review talking point:** *incident response is determined by what you built beforehand.* The reverse index, kill switch, and retained click logs are the difference between minutes and days — and the strongest argument for 302-over-301 (revocability) and keeping raw click events (forensics).

**Real-world signal:** Bitly and TinyURL both run Safe-Browsing-style threat-intelligence checks on destinations. (I am confident they use threat-intel blocklists; exact vendors and cadence vary and aren't publicly specified.)

---

## 9. Scale, Multi-Region, and Five-Nines Availability

### 🟢 Beginner — Three Kitchens, One Menu

A restaurant chain that wants food served fast in three cities doesn't cook everything in one kitchen and ship it — it opens a kitchen in each city, all working from the same menu. Diners are served locally and quickly. The only tricky part is making sure the three kitchens never both invent a dish with the same name meaning two different things.

For a shortener: put a copy of the data near users in each region so redirects are fast, and make sure two regions never mint the same short code for different links.

---

### 🟡 Senior — Multi-Region Reads and Region-Partitioned IDs

```
Redirect (read) path — LOCAL and fast in every region:
  - Full read replicas of URL data in each region + regional Redis.
  - EU user resolves against EU cache/replica → < 10ms, no cross-ocean hop.
  - GeoDNS / anycast routes to the nearest region.

Create (write) path — pick a consistency model:
  Option A: single write region (leader) + async replication.
    + simple, no write conflicts.  − far-user create latency; leader outage stops writes.
  Option B: multi-master (write in any region).
    + local low-latency creates.   − MUST prevent cross-region code COLLISIONS.
      Fix: partition the ID space per region (region bits in the ID, or per-region
      counter blocks) → globally unique codes WITHOUT cross-region coordination.
```

The `code → url` mapping is **immutable after creation**, so **eventual consistency** for reads is fine — a new link may take replication-lag seconds to appear in a far region. The one hard invariant is **globally unique codes**, solved by region-partitioned IDs (exactly what Snowflake's machine bits or per-region counter blocks give you). **Named tradeoff — write latency vs coordination.**

**Five-nines math:**

```
99.9%   = 8.76 hours/year
99.99%  = 52.56 minutes/year
99.999% = 5.26 minutes/year   ← the target
```

| Layer | 5-nines requirement |
|---|---|
| DB replication | RF ≥ 3, multi-AZ, automated failover (seconds); cross-region replicas |
| Cache redundancy | Redis replicas + Sentinel/Cluster, multi-AZ; L1 + edge as extra tiers |
| Deployment | Zero-downtime blue-green / canary, automated rollback |
| Failure detection | Health checks + fast failover; detection + recovery must fit the 5.26-min budget |

---

### 🔴 Architect — What Breaks at 100× and the Cascade That Ignores Redundancy

**Google scale — 1 trillion redirects/day. Capacity math:**

```
1T/day ÷ 86,400 s ≈ 11.57 MILLION redirects/sec (100× our 115K).
Storage: 1B new URLs/day × 5yr × ~500 B ≈ ~900 TB primary (×3 ≈ ~2.7 PB).
```

Top 3 bottlenecks, in order:

| # | Bottleneck | Why it breaks first | Mitigation |
|---|---|---|---|
| 1 | **Cache/edge fleet + network** | At 11.5M req/s, even 99% hit rate leaves ~115K/s of misses — our *entire original system* is now just the miss traffic | Massive multi-tier edge caching (CDN does most redirects), regional fleets, L1 everywhere |
| 2 | **Analytics firehose** | 1T events/day ≈ 11.5M/s into Kafka; at ~200 B/event ≈ ~2 PB/day raw. Ingest + storage + processing dwarf the redirect | Sample/pre-aggregate at the edge, HLL for uniques, tiered retention |
| 3 | **Write-path ID generation** | 1B creates/day ≈ 11.6K/s, each needing a globally-unique code across a huge fleet — central counters can't keep up | Coordination-free IDs (Snowflake / ranged blocks) mandatory; shards in the thousands |

The insight: at 100× scale the **redirect itself stays a cache GET**; the supporting systems — edge bandwidth and the analytics firehose — become the dominant engineering problems. The DB is almost irrelevant on the read path because the cache fully shields it.

**Failure mode — a 2-hour cascading redirect outage *despite* redundancy** (reasoned from first principles; I cannot independently verify the specifics of the referenced 2016 Bitly incident):

```
T+0    Trigger: a DB primary fails OR a bad config/schema push OR a cache hiccup.
       Individually survivable.
T+0    Cache pressure: trigger drops hit rate; reads fall through to the DB.
T+30s  Retry storm: clients + services retry aggressively → MULTIPLY DB load.
T+1m   DB saturates → health checks flap → failover promotes a replica → replica
       is immediately hit by the SAME herd → it saturates too. (Failover doesn't
       help when the problem is LOAD, not the node.)
T+5m   Cold-cache trap: even after the DB recovers, the cache is empty; every read
       is a miss; refilling the cache requires surviving the very load the cache
       existed to absorb. This is what turns minutes into HOURS.
T+2h   Manual intervention breaks the loop (shed load, warm cache slowly, throttle retries).
```

What breaks the feedback loops:

```
1. Circuit breakers — trip DB calls under stress; serve stale/L1 or 503.
2. Request coalescing (single-flight) — one DB read per key on cold-cache refill.
3. Exponential backoff + jitter on ALL retries — no synchronized retry waves.
4. Load shedding — drop low-priority traffic to keep the redirect core alive.
5. Staged cache warming — refill top-N hot keys before reopening full traffic.
6. Cell / bulkhead isolation — one failing cell can't cascade globally.
7. Chaos testing — regularly kill the cache in prod-like conditions.
```

**Design-review talking point:** *redundancy protects against independent component failure, not against load-driven cascades.* The hard part of five-nines is not buying more replicas — it's eliminating **correlated failure and human error** (bad config push, schema-migration lock, cache stampede, retry storm). Also decide *what* needs five-nines: the **redirect path** must; **create** and **analytics** can run at lower tiers.

**Real-world signal:** the cold-cache + retry-storm + failover-into-load pattern is the recurring anatomy of multi-hour outages across the industry, not unique to any one company — which is why the mitigations above are all about breaking feedback loops rather than adding capacity.

---

## 10. Lifecycle: Expiry, Reclaim, and the Forever-Link SLA

### 🟢 Beginner — The Reassigned Phone Number

When someone gives up a phone number, the carrier doesn't hand it to a new customer the next day — because the old owner's contacts would start calling a stranger. There's a quarantine. A short code is the same: if you let an expired custom alias be re-registered, old flyers and QR codes pointing to it suddenly send people to a new, possibly malicious, destination.

---

### 🟡 Senior — Soft Delete, Expiry Semantics, and 410 vs 404

```
Delete model — SOFT delete first, HARD delete later:
  On expiry/delete: set status='expired'/'deleted' + deleted_at (don't DROP the row).
  A background reaper hard-deletes in batches after a retention window.
  Why: keeps deletes off the hot path, preserves audit/forensics, allows undo,
       lets analytics/legal queries still resolve historical codes.

Expiry (TTL hits zero):
  Cache: store expires_at in the value and check on read, OR set Redis TTL ==
         remaining lifetime so it auto-evicts.
  DB:    soft-delete; reaper cleans up later.
  User visit to an expired code: return 410 Gone or 404 Not Found — do NOT redirect.
```

```typescript
async function resolve(code: string): Promise<Result> {
  const rec = await getWithExpiry(code);            // cache, then DB
  if (!rec) return { status: 404 };
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    await redis.del(`u:${code}`);                   // evict stale entry
    return { status: 410 };                         // Gone
  }
  return { status: 302, location: rec.url };
}
```

**410 vs 404 — named tradeoff: information disclosure vs semantic accuracy.** 410 tells crawlers to stop retrying (SEO hygiene) but confirms the code once existed; 404 hides existence (better if enumeration/privacy matters). Most shorteners return 404.

---

### 🔴 Architect — The Alias-Reclaim Hijack and the Forever SLA

**The reclaim hijack.** If a user can register an *expired* custom alias (e.g., `acme-promo`) that someone else used before, then old emails, printed flyers, and QR codes pointing to that alias now redirect to the **new** owner's destination:

```
Attack: wait for a valuable alias to expire → claim it → redirect the victim's
        still-circulating links to malware/phishing.
Recommendation:
  - Do NOT allow reclaim of custom aliases by default. Once issued, retire forever.
  - If reclaim is a product requirement: long quarantine (alias unusable for N years)
    AND the old link shows an interstitial, never a silent redirect to a new owner.
```

**The "still works after 5 years" SLA:**

```
Technical:  data durability across hardware refreshes, DB version upgrades,
            re-shardings, region moves — all without breaking existing codes.
            Codes must NEVER be reused while an old one is alive (counter/Snowflake
            never reuse — good; random/hash schemes risk collision-over-time).
Operational: "5-year retention" vs "works forever" is a policy conflict — decide and
            document. "Works forever" ⇒ NO default expiry AND codes NEVER reclaimed.
Cost:       storing 182B+ rows indefinitely grows unboundedly. Tier COLD links to
            cheap object storage (a 5-year-old rarely-clicked link can afford a
            slower first hit); keep hot codes on SSD/cache.
```

**Named tradeoff — durability guarantee vs storage cost.** "Works forever" turns storage into a monotonically growing liability; you manage it by *tiering* cold links, not deleting them. The SLA also forbids code reuse and alias reclaim, trading a smaller effective namespace and less flexibility for permanence.

**Design-review talking point:** the birthday-paradox "when do we go to 8 chars?" worry **disappears entirely if codes come from a counter/Snowflake** (each ID used exactly once — no collision possible). Collisions only afflict random/hash generation. The only real trigger to lengthen codes is namespace exhaustion (~96 years out), and because a code is an opaque key, 7 → 8 is a config-only, backward-compatible change.

**Real-world signal:** carriers quarantine recycled phone numbers precisely because reassignment breaks the "this identifier always means the same thing" invariant — the same reason a public shortener should never silently reassign a code. (The phone-number recycling problem is well documented; specific quarantine durations vary by carrier and regulator.)

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Core operations | Create (write, ~1.2K/s) + Resolve (read, ~115K/s); both point-lookups by short code |
| Read:write | 100:1 — the redirect defines the architecture; cache-first, never DB on the hot path |
| Base62 alphabet | `[0-9A-Za-z]`, 62 symbols; URL-safe (no `+ / =` like Base64); double-click-selects clean |
| Base62 math | Capacity = 62ⁿ; 62⁷ = 3.52 trillion; 62⁸ = 218 trillion; encode = repeated mod-62 + floor-divide |
| ID → code (preferred) | Counter/Snowflake ID → Base62; unique BY CONSTRUCTION, no collision check |
| Hash → code (trap) | MD5/SHA truncated; collisions certain — 50% at ~2.2M URLs, ~100% by 100M |
| Birthday bound | P ≈ 1 − e^(−k²/2N); N = 62⁷; 50% at k ≈ 1.177√N ≈ 2.2M — far below the 3.5T capacity |
| Snowflake ID | 64-bit: 41-bit ms (69.7 yr) + 10-bit machine (1024) + 12-bit seq (4096/ms); coordination-free |
| Counter service | Hands out ID BLOCKS; server mints locally; survives outage until block drains (block/rate runway) |
| Auto-increment risk | Enumeration (scrape all) + German-tank BI leak (guess your volume) → never expose raw |
| 301 vs 302 | 301 = cached forever, kills analytics + can't re-point/revoke; 302 = every click counted → USE 302 |
| 302 headers | `Location` + `Cache-Control: no-store` (the pairing that makes 302 actually temporary) |
| < 10ms P99 | Redirect served from cache/edge, never DB; click event emitted async; > 99% hit rate |
| Cache-aside | GET Redis → hit; miss → DB → repopulate; negative-cache 404s to stop enumeration DoS |
| Hot key | One viral code overloads one shard; fix = L1 in-process cache + key fan-out + edge, NOT resharding |
| Redis-down cascade | 0% hit → 115K/s hits DB (sized ~2K) → saturation → outage; need HA cache + breaker + coalescing |
| Unique visitors | HyperLogLog: ~12KB fixed, ~0.81% error (Redis PFADD/PFCOUNT) vs unbounded SET of IPs |
| Analytics decoupling | 302 first, click → Kafka async; consumer lag = bounded staleness, NOT an outage |
| Shard by | short-code hash → single-shard redirects, even load; NOT user_id (scatter-gather + whale hotspots) |
| Consistent hashing | Worth it when shard count changes: moves ~1/N keys vs modulo's ~(N−1)/N |
| Shard failure | Every shard = replicated group (RF ≥ 3, multi-AZ) + auto-failover; never a single node |
| Enumeration defense | Non-sequential codes + sparse namespace (~5.2% density) + 404 rate-limit; NOT access control |
| Malware/phishing | Safe-Browsing/blocklist at create + continuous re-scan; 302 lets you REVOKE on next click |
| Rate limiting | Centralized token bucket in Redis (atomic Lua); per-key + per-IP + anomaly + reputation tiers |
| Kill switch prereqs | Reverse index (destination → codes) + disable-by-pattern + retained click logs, built in advance |
| Five nines | 5.26 min/yr; redundancy handles hardware, discipline (canary, breakers, backoff) handles cascades |
| Multi-region | Local read replicas + regional cache; region-partitioned IDs for uniqueness; eventual consistency OK |
| Google scale (1T/day) | 11.5M req/s; bottlenecks = edge cache bandwidth + analytics firehose (~2PB/day), not the DB |
| 5-yr link SLA | Immutable, never-reused codes + tiered cold storage; forbids alias reclaim; no default expiry |
| Alias reclaim risk | Reclaiming expired alias hijacks still-circulating old links → don't reclaim by default |
| 7→8 char migration | Config-only, non-breaking: old codes resolve forever, new codes get 62× more room |
| Cascade root cause | Cold cache + retry storm + failover-into-load; fix with breakers, coalescing, backoff, staged warming |
