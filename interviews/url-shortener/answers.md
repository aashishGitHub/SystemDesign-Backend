# Answers: URL Shortener (TinyURL / Bitly)

> Keyed to [questions.md](./questions.md). Read questions first — attempt each aloud before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on decisions that matter.
> Numbers are derived from the constraints in [README.md](./README.md). Where a figure is illustrative, it is labelled as such.

---

## Level 1 — Fundamentals

### A1. What a URL shortener does (no jargon)

A URL shortener is a service that takes a long web address and hands you back a short one that points to the same place. You give it `https://www.example.com/products/2024/spring/catalog?ref=email&utm=promo`, it gives you back `tinyurl.com/x7Gh2Kq`. When anyone opens the short link, the service instantly forwards their browser to the original long address.

Think of it as a **speed-dial for the web**. Instead of dialling a 15-digit number, you press "2" and the phone knows to call your mother. The short code is the speed-dial button; the service keeps the phone book that maps "2 → the real number."

Two operations define the whole system:
- **Create:** long URL in, short code out (rare — the write path).
- **Resolve:** short code in, redirect to long URL (constant — the read path).

That is the entire product. Everything else (analytics, custom aliases, expiry, abuse controls) is built around those two operations.

---

### A2. Why a business uses a shortener (3+ reasons)

| Reason | What it buys the business |
|---|---|
| **Character economy** | Fits inside SMS (160 chars), tweets, and printed QR codes. A 200-char tracking URL is unusable in a text message; `bit.ly/abc` fits everywhere. |
| **Click analytics** | The shortener sits between the user and the destination, so it can count every click, and break it down by geography, device, and referrer — data the destination site cannot easily attribute back to a specific campaign. |
| **Link management / mutability** | You can change where a short link points *after* it is printed on a billboard. The QR code is fixed; the destination behind it is editable. This is the killer feature Bitly sells to enterprises. |
| **Branding & trust** | `nike.com/summer` reads as trustworthy; a raw AWS S3 pre-signed URL does not. Branded short domains raise click-through rates. |
| **Vanity / memorability** | Custom aliases (`tinyurl.com/my-launch`) are shareable verbally. |

The single most valuable one at the enterprise tier is **mutability + analytics**: the ability to reroute a link and to measure it. That is why Bitly's business is B2B link management, not the free consumer tool.

---

### A3. Full lifecycle of a shortening request (write path)

```
1. Client → API Gateway (POST /shorten { "url": "https://..." })
2. Gateway: authenticate (API key), rate-limit the caller
3. App server: validate URL (scheme http/https, length ≤ 2048, not on malware blocklist)
4. App server: generate a globally unique ID (counter block or Snowflake) — see A9/A8
5. App server: Base62-encode the ID → 7-char short code
6. Persist: INSERT (short_code, long_url, created_at, expires_at, owner_id) into DB
7. Warm cache: SET short_code → long_url in Redis (optional, since reads dominate)
8. Respond: 201 Created { "short_url": "https://tinyurl.com/x7Gh2Kq" }
```

The design decision that shapes everything here is **where uniqueness comes from** (step 4). If you generate the code by hashing the URL, you must handle collisions synchronously (step 4–6 becomes a read-check-retry loop). If you generate from a monotonic counter or Snowflake ID, the code is unique *by construction* and there is no collision check on the write path. The counter/Snowflake approach is preferred at scale precisely because it removes coordination from the hot part of the write.

The write path is comparatively slow and cheap (~1,157 writes/sec average from the README constraints) — you can afford a synchronous DB insert here.

---

### A4. Walk through a redirect (read path) and the status code

```
1. Browser → GET https://tinyurl.com/x7Gh2Kq
2. Edge/LB routes to redirect service
3. Redirect service: look up "x7Gh2Kq" in Redis
     hit  → got long_url (the common case, > 99% of reads)
     miss → read DB, repopulate cache
4. Service returns HTTP 302 Found
     Location: https://www.example.com/products/...
5. Browser reads the Location header and issues a second GET to the long URL
6. Service emits a click event to Kafka asynchronously (does NOT block step 4)
```

The status code is **302 Found** (temporary redirect), *not* 301. The reason is analytics: a 301 tells the browser "this move is permanent, cache it forever," so the browser will skip the shortener entirely on future clicks — and you lose the click count. A 302 makes the browser return to the shortener every time, so every click is measurable. This is the single most important HTTP decision in the whole design (see A14–A15).

---

### A5. The two critical DB operations and their access patterns

| Operation | Access pattern | Frequency (README) | Optimize for |
|---|---|---|---|
| **Resolve** `short_code → long_url` | Point lookup by primary key, read-only, extremely read-heavy | ~115K reads/sec | Latency (< 10ms P99). Serve from cache; never scan. |
| **Create** `insert (code, url)` | Point insert, write-heavy relative to nothing else, but 100× rarer than reads | ~1,157 writes/sec | Uniqueness + durability. Can touch the DB synchronously. |

Both are **key-value point operations** — there are no range scans on the hot path (you never ask "give me all codes between X and Y"). That is why the storage layer can be a partitioned key-value store or a sharded relational table keyed on `short_code`, and why a cache in front works so well: point lookups by an immutable key have a ~100% cacheable read pattern. The 100:1 read:write ratio means the entire architecture is shaped by the read path.

---

### A6. FAILURE MODE — two users submit the same long URL simultaneously

There are two valid designs; the choice is a **named tradeoff: storage/dedup cost vs analytics isolation.**

| Approach | Behaviour | Pros | Cons |
|---|---|---|---|
| **Same code (dedup)** | Look up the long URL first; if it exists, return the existing short code | Saves storage; one canonical link | Requires a read-before-write on every create (or a unique index on `long_url`, which is expensive at 182B rows); two customers now *share* a link and its analytics — a privacy/attribution problem |
| **Different codes (no dedup)** | Always mint a new code | Simple, no read-before-write, each customer gets isolated analytics | Storage grows with duplicates |

For a **consumer** shortener, deduplicating is defensible. For a **business** shortener (Bitly's model), you almost always mint **different codes**, because two customers shortening the same landing page must get separate links with separate click analytics — customer A must not see customer B's clicks. Attribution isolation beats storage savings.

On the concurrency itself: if you *do* dedup, the race is handled by a unique constraint on `long_url` — the loser of the race catches the constraint violation and re-reads the winner's code. If you don't dedup, there is no race at all because each request draws its own unique ID from the counter/Snowflake source.

---

## Level 2 — Encoding & ID Generation

### A7. Base62 encoding vs MD5+truncation

These solve the same problem (produce a short code) but from opposite directions.

| Property | Base62(counter/Snowflake ID) | MD5(url) truncated to 7 chars |
|---|---|---|
| Uniqueness | Guaranteed by construction (each ID used once) | **Probabilistic** — collisions are certain at scale (birthday bound) |
| Collision handling | None needed | Must retry with a salt/probe on every collision |
| Determinism | Same URL → different code each time (unless you dedup) | Same URL → same code (natural dedup) |
| Predictability | Low if ID is scrambled/Snowflake; sequential if raw counter | Low (hash output looks random) |
| Failure mode | Counter exhaustion / ID service down (A9) | Collisions grow quadratically with URL count (A11) |

**Base62-of-an-ID fails when:** the ID source fails (counter service down) or when a raw sequential counter leaks business intelligence (A13).

**MD5+truncation fails when:** you hit the birthday wall. Truncating a 128-bit hash to ~42 bits (a 7-char Base62 code) throws away almost all the collision resistance MD5 had. At ~2.2 million URLs you cross 50% cumulative collision probability (A11). Every collision forces a "hash the URL + a salt, check again" loop, and once the namespace fills, that loop gets long. This is why production systems (Bitly-style) generally prefer **ID → Base62** over **hash → truncate**: uniqueness by construction beats uniqueness by retry.

Correct Base62 encode/decode:

```typescript
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 62 chars
const BASE = 62n;

function encode(id: bigint): string {
  if (id === 0n) return "0";
  let out = "";
  while (id > 0n) {
    out = ALPHABET[Number(id % BASE)] + out;
    id = id / BASE;                       // integer division
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
// encode(3521614606207n) → a 7-char code near the top of the 62^7 namespace
```

---

### A8. Snowflake IDs — what they are and their structure

A **Snowflake ID** (open-sourced by Twitter in 2010) is a 64-bit integer generated **without any central coordination**, so many servers can mint globally unique, roughly time-ordered IDs in parallel. Structure:

```
 1 bit   |        41 bits         |   10 bits   |   12 bits
 unused  |  ms since custom epoch |  machine id | sequence #
 (sign)  |                        |             |
```

| Field | Bits | Capacity |
|---|---|---|
| Timestamp (ms) | 41 | 2^41 ms ≈ **69.7 years** from a custom epoch |
| Machine / worker ID | 10 | 2^10 = **1,024** generators |
| Sequence per ms | 12 | 2^12 = **4,096** IDs per machine per millisecond |

That is 1,024 × 4,096 ≈ **4.19 million IDs/sec** cluster-wide, all unique, no lock, no round-trip to a central server.

To use it for a short code: generate the 64-bit Snowflake ID, then Base62-encode it. One catch — a raw 64-bit Snowflake Base62-encodes to ~11 characters, longer than the 7-char target. So in practice you either (a) use a smaller custom bit layout tuned to your namespace, or (b) use Snowflake for the *primary key* and derive a shorter code from a separate counter. The interview-relevant point is **why** Snowflake exists: coordination-free unique ID generation, with a bonus of rough time-ordering (the timestamp is the high bits, so IDs sort by creation time — good for DB index locality).

---

### A9. The counter / range-based ID allocator, and its failure mode

A **counter service** hands out **blocks (ranges)** of the ID space to each app server so that servers can mint IDs locally, without a network round-trip per ID.

```
Central counter (e.g., a row in a DB, or Redis INCRBY, or ZooKeeper):
  Server A requests a block → gets [1        .. 1000]
  Server B requests a block → gets [1001     .. 2000]
  Server C requests a block → gets [2001     .. 3000]

Each server hands out IDs from its own block with zero coordination.
When a server's block is ~80% used, it asynchronously fetches the next block.
```

```typescript
class IdAllocator {
  private next = 0n;
  private ceiling = 0n;
  private readonly BLOCK = 1000n;

  async nextId(): Promise<bigint> {
    if (this.next >= this.ceiling) {
      // Atomic reserve: INCRBY returns the new top of the reserved range
      const top = BigInt(await counter.incrby("url:id", Number(this.BLOCK)));
      this.ceiling = top;
      this.next = top - this.BLOCK;
    }
    return this.next++;
  }
}
```

**What happens if the counter service goes down?** Each server keeps minting from its **currently reserved block** — so there is a grace window equal to "block size ÷ mint rate." With 1,000-ID blocks and normal write rates, that is seconds to minutes of runway. New ID generation only stalls when every server exhausts its in-memory block *and* cannot fetch a new one. Mitigations: (1) size blocks large enough that the buffer outlasts your recovery MTTR; (2) fetch the next block early (at 80% used, not 100%); (3) run the counter as a replicated HA service. The tradeoff is **block size vs wasted IDs**: bigger blocks = more failure runway, but a server that crashes with 900 unused IDs "wastes" them (they are never reissued). With a 3.5-trillion namespace, wasted IDs are irrelevant. This is essentially Flickr's "ticket server" pattern (MySQL auto-increment with offset stepping) generalized.

---

### A10. Why Base62 over Base64

Base64's alphabet includes three characters that break URLs:

| Char | Problem in a URL |
|---|---|
| `+` | Decoded as a space in `application/x-www-form-urlencoded` query strings |
| `/` | Path separator — `tinyurl.com/a/b` looks like two path segments |
| `=` | Padding character; ambiguous and often stripped |

There is a `base64url` variant that swaps `+`/`/` for `-`/`_` and drops padding — but that still leaves `-` and `_`, which are easy to mis-transcribe and can be confused with hyphenated word breaks when a link is printed or read aloud.

**Base62 = `[0-9A-Za-z]` only.** No escaping, no ambiguity, double-click-selects as one token, survives copy-paste through any medium, and is safe in the path, query, or fragment. The cost is trivial: 62 vs 64 symbols barely changes code length (62^7 = 3.52T vs 64^7 = 4.4T). The URL-safety win dominates. (Some shorteners go further and drop visually ambiguous chars like `0/O/l/1` for human-transcribed codes — that is "Base58," used by Bitcoin addresses for the same readability reason.)

---

### A11. Collision probability of MD5-truncated 7-char codes

This is the **birthday problem**. The probability of at least one collision after inserting `k` items into a space of size `N` is:

```
P(collision) ≈ 1 - e^(-k² / 2N)      (accurate for k << N)
```

A 7-char Base62 code has `N = 62^7 = 3,521,614,606,208 ≈ 3.52 × 10^12` slots (≈ 2^41.7; the question's "43 bits" ≈ 2^43 = 8.8×10^12 is the same order of magnitude — I show both).

| URLs created (k) | N = 62^7 (3.52 T) | N = 2^43 (8.8 T) |
|---|---|---|
| 1,000,000 | k²/2N = 0.142 → **≈ 13.2%** | 0.057 → **≈ 5.5%** |
| 100,000,000 | k²/2N = 1420 → **≈ 100% (certain)** | 568 → **≈ 100% (certain)** |

Arithmetic for the 1M / 62^7 cell: `(10^6)² / (2 × 3.52×10^12) = 10^12 / 7.04×10^12 = 0.142`, so `P ≈ 1 − e^(−0.142) ≈ 0.132`.

The striking result: **50% cumulative collision probability arrives at only ~2.2 million URLs** (`k ≈ 1.177 × √N = 1.177 × √(3.52×10^12) ≈ 2.2M`). At 100 million URLs a collision is a mathematical certainty, and this is *before* the namespace is anywhere near full (100M is 0.003% of 3.5T). This is the core reason hash-and-truncate is a trap: it fails at a URL count far below the raw namespace capacity. These are computed from the birthday approximation, not measured benchmarks.

---

### A12. FAILURE MODE — collision after 2 years and 50 billion URLs (MD5+truncate)

**What went wrong:** With 50 billion URLs in a 3.52-trillion namespace, density is ~1.4%, but the birthday bound made collisions certain **decades of URL-count ago** (certain by ~100M). If two different long URLs truncated to the same 7-char code, whichever was written *second* either (a) silently overwrote the first mapping — now the first customer's link points to the *second* customer's destination (worse than a 404: it's a correctness/security incident), or (b) was rejected because a unique index caught it, and the create silently failed or looped.

**How to handle it in production:**
```
Immediate (stop the bleeding):
  1. Freeze the overwrite path: creates must use INSERT ... IF NOT EXISTS
     (unique constraint on short_code) so a collision can never overwrite.
  2. On collision, re-hash with an incrementing salt: md5(url + ":" + attempt),
     truncate, retry. This is "open addressing / probing" for short codes.
  3. Audit: scan for any code whose stored long_url changed unexpectedly;
     restore from the write-ahead log / audit table.

Structural fix (migrate off hash-truncate):
  4. Switch new codes to counter/Snowflake-derived Base62 (unique by construction).
  5. Extend code length 7 → 8 (62^8 = 218T) to buy namespace headroom (A/BQ3).
  6. Old 7-char codes keep resolving; only new codes use the new scheme.
```

**Named tradeoff — determinism vs uniqueness.** Hash-truncate gave you free deduplication (same URL → same code) at the cost of collisions. Counter/Snowflake gives you guaranteed uniqueness at the cost of losing free dedup. At 50B rows, uniqueness wins decisively — a collision is a *wrong redirect*, the worst possible failure for this product.

---

### A13. Two security risks of auto-incrementing integer IDs

| Risk | Mechanism | Impact |
|---|---|---|
| **Enumeration** | Codes are sequential, so `abc0001 → abc0002 → …` are all valid. An attacker walks the space and scrapes *every* URL ever created. | Mass privacy leak — anyone's "unlisted" shortened links (internal docs, pre-signed S3 URLs, private invites) are discoverable. |
| **Business-intelligence leak (German-tank problem)** | Create one URL today (ID 1,000,000), one tomorrow (ID 1,050,000). The delta reveals you created ~50,000 URLs/day. | Competitors can estimate your total volume, growth rate, and launch timing just by minting two links and subtracting IDs. |

Both disqualify raw auto-increment for a **public** shortener. The fix is to keep an internal monotonic ID (great for DB locality) but **decouple the external code from it** — e.g., run the ID through a reversible bijective scramble (Feistel network / multiply-by-coprime-mod-N) before Base62-encoding, or use Snowflake IDs whose machine/sequence bits break strict adjacency. The external code must be non-sequential and non-guessable even though the internal key is dense. (This is the same reason Instagram/YouTube don't expose raw auto-increment IDs in URLs.)

---

## Level 3 — Redirect & HTTP

### A14. HTTP 301 vs 302 — which TinyURL should use

| | 301 Moved Permanently | 302 Found (temporary) |
|---|---|---|
| Browser caching | Aggressively cached, often "forever" | Not cached by default |
| Repeat clicks | Browser skips the shortener → goes straight to destination | Browser returns to the shortener every time |
| Analytics | **You lose click tracking** after the first hit | **Every click is counted** |
| Changing the destination | Very hard — stale 301 is cached in millions of browsers (A18) | Easy — next click re-reads current mapping |
| SEO link equity | Passes to destination (good if that's the goal) | Does not pass (treated as temporary) |
| Server load | Lower (fewer repeat requests) | Higher (all repeats hit you) |

**Use 302** for a consumer/business shortener like TinyURL/Bitly. The product's value is analytics and mutable destinations, both of which require the browser to come back every time. The extra server load is the price of the business model, and it is affordable because the read path is cache-served (< 10ms). Use 301 only for a pure SEO/canonicalization redirect where you never need to change the target or count clicks — the opposite of a shortener's use case.

---

### A15. Counter-argument to "just use 301 to cut load"

The PM is right that 301 cuts load — and that is exactly the problem. **A 301 caches the redirect in the user's browser, so the second and every subsequent click never reaches your servers.** Consequences:

1. **Analytics die.** You count click #1 and are blind to clicks #2…∞. For a business whose product *is* click analytics, this is deleting the revenue-generating feature.
2. **You lose the ability to change or kill a link.** If a shortened URL points to a phishing site (A36) or the customer wants to re-point a printed QR code, a 301 already cached in millions of browsers keeps sending users to the old (possibly malicious) destination. You cannot recall it.
3. **You lose rate-limiting / abuse control** on the redirect, because the traffic never arrives.

The correct framing: "The redirect path is cheap because it is cache-served at < 10ms; the load 301 would save is not our bottleneck, but the analytics and mutability 301 would destroy *are* our product." **Named tradeoff: server load vs control+observability** — and for this product, control wins.

---

### A16. What must be true to hit < 10ms P99 despite a redirect round-trip

A 302 adds one extra client round-trip (short URL → 302 → long URL). The SLO of < 10ms P99 is on **generating the redirect response**, not on the end-to-end page load (which includes the destination site, outside your control). So the requirement is: **the redirect response must be produced without a database read on the hot path** — it must be served from an in-memory tier close to the user.

```
Concretely, to hit < 10ms P99:
  - Lookup served from Redis (sub-ms) or an edge cache, NOT PostgreSQL (~1–10ms + network)
  - Redirect service co-located with / near the cache (avoid cross-AZ hops)
  - Cache hit rate > 99% so the p99 request is still a cache hit
  - Click event emitted async (fire-and-forget to Kafka) so analytics never adds latency
  - No synchronous malware re-check, no synchronous counter increment on the hot path
```

The moment a redirect touches disk or a remote DB, you blow the p99. This is why the cache is not an optimization here — it is load-bearing architecture.

---

### A17. Redirect response headers

```http
HTTP/1.1 302 Found
Location: https://www.example.com/products/spring/catalog
Cache-Control: private, no-store          ; do NOT let browsers/proxies cache the redirect
                                          ; (preserves per-click analytics; enables re-pointing)
Referrer-Policy: no-referrer              ; don't leak the short URL as referrer to destination
X-Content-Type-Options: nosniff           ; defense-in-depth
Strict-Transport-Security: max-age=63072000 ; force HTTPS on our short domain
Content-Length: 0
```

Key choices:
- **`Location`** carries the destination — the whole point of the redirect.
- **`Cache-Control: no-store`** is the pairing that makes the 302 *actually* behave as temporary. A 302 with a long `max-age` would be cached and reintroduce the 301 problem. `no-store` guarantees the browser returns for every click.
- **Security note:** a URL shortener is, by definition, an **open redirect**, so the real security work is *upstream* (validate/blocklist destinations at create time, A36) — headers can't fix a malicious destination. `Referrer-Policy: no-referrer` avoids leaking your short code to the destination's logs.

---

### A18. FAILURE MODE — 5% of users land on a 3-days-old destination

**Most likely cause: someone served a `301` (or a `302` with a cacheable `Cache-Control`/`max-age`) for those links at some point, so browsers/proxies cached the *old* destination.** The customer then re-pointed the short link to a new destination, but the 5% of users whose browsers hold the cached permanent redirect keep going to the stale target. "3 days ago" ≈ the age of the cached entry.

```
Diagnosis:
  - Check the redirect handler's response headers in prod (curl -I the short URL).
    Look for `301` or `Cache-Control: max-age=<big>` on a 302.
  - The 5% correlates with browsers/networks that cached before the re-point.

Fix:
  - Serve 302 with `Cache-Control: no-store` for all shortener redirects.
  - You CANNOT purge already-cached 301s from users' browsers — they expire on
    their own schedule. For the affected links, the only clean remedy is to
    mint a NEW short code for the new destination and retire the poisoned one.
  - Add a monitoring assertion: alert if any redirect response ever emits 301
    or a cacheable Cache-Control. Treat it as a config regression.
```

The lesson interviewers want: **301 is a promise you cannot take back.** Once cached in the wild, it is effectively permanent. Shorteners must use 302 + `no-store`.

---

## Level 4 — Caching & Read Optimization

### A19. Why a DB query (even indexed) is not enough

Even a primary-key lookup on an indexed table costs a network hop plus a B-tree traversal plus (often) a disk/page-cache read — realistically **~1–10ms per query**, and it *degrades* under concurrency because 115K QPS saturates connection pools, buffer cache, and IOPS.

```
Constraints: 115K reads/sec, < 10ms P99.
A single PostgreSQL primary handling 115K point-reads/sec would need:
  - enormous connection concurrency (pool exhaustion, context-switch storms)
  - the working set fully in RAM to avoid disk (else p99 blows out on cache-miss pages)
  - and even then, per-query latency + tail effects push p99 over 10ms

Redis GET of a short string: sub-millisecond, ~100K+ ops/sec per node,
horizontally shardable. It is designed for exactly this: point reads by key.
```

**Named tradeoff — latency vs durability/cost.** The DB is the durable source of truth but is slow and expensive per read; the cache is fast and cheap per read but volatile. With a 100:1 read:write ratio and immutable `code → url` mappings (a near-perfect cache candidate), you put a cache in front to absorb ~99%+ of reads and reserve the DB for the write path and cache misses. The DB alone cannot meet the SLO at this QPS; the cache is mandatory, not optional.

---

### A20. Design the Redis cache layer

```
Key structure:   u:{short_code}         → long_url   (string; short keys save memory at scale)
                 (optionally)  meta:{short_code} → hash of {expires_at, owner, disabled}
TTL:             SET u:abc123 <url> EX 86400   (24h sliding window; hot links stay warm,
                                                cold links evict naturally)
Pattern:         CACHE-ASIDE (lazy loading) on reads; write-through optional on create
Eviction:        maxmemory-policy allkeys-lru  (bound memory; evict coldest links)
```

**Cache-aside read (the hot path):**
```typescript
async function resolve(code: string): Promise<string | null> {
  const hit = await redis.get(`u:${code}`);
  if (hit !== null) return hit;                        // ~99%+ of reads
  const url = await db.lookup(code);                   // miss → source of truth
  if (url) {
    await redis.set(`u:${code}`, url, "EX", 86400);    // repopulate
  } else {
    await redis.set(`u:${code}`, "__404__", "EX", 60); // negative cache: stop repeated
                                                       // DB hits for garbage/enumeration codes
  }
  return url === "__404__" ? null : url;
}
```

| Decision | Choice | Why |
|---|---|---|
| Cache-aside vs write-through | **Cache-aside** for reads | Only caches links people actually click; write-through would cache 100M/day links, most never clicked |
| TTL | 24h sliding (reset on hit) | Balances freshness (re-pointing takes effect within TTL) vs hit rate |
| Cache miss | Read DB, repopulate; negative-cache 404s | Prevents an enumeration attack from becoming a DB DoS |
| Eviction | `allkeys-lru` | Memory is bounded; the long tail evicts, hot links stay |

**On a miss** you pay one DB read, then every subsequent click is a hit until TTL/eviction. The negative cache entry (`__404__`, short TTL) is important: without it, an attacker requesting random codes (A37) drives every request to the DB.

---

### A21. The hot-key problem

A **hot key** is a single cache key receiving a disproportionate share of traffic — enough to overload the *one* Redis node/shard that owns it, even though the cluster as a whole is fine. Consistent hashing spreads *keys* evenly across nodes, but it cannot spread the *load of one key*.

```
Concrete example: a celebrity tweets a bit.ly link. It goes viral.
  - Normal link: ~1 click/day
  - Viral link:  ~500,000 clicks/minute, ALL hitting key u:viral123
  - That key lives on exactly ONE Redis shard → that shard hits 100% CPU / NIC
  - Every OTHER shard is idle. Adding shards does not help; the key can't split.
```

**Mitigations:**
| Strategy | How |
|---|---|
| **Local (L1) cache** | Each redirect server caches the hottest codes in-process (LRU, 1–5s TTL). A viral link is served from the app server's own RAM; Redis is barely touched. |
| **Key replication / fan-out** | Store the hot value under N suffixed keys `u:viral123#0..#9` across shards; reads pick a random suffix, spreading load 10×. |
| **Read replicas for the hot shard** | Route reads for the hot key round-robin across replicas. |
| **CDN edge cache** | Push the redirect itself to the edge (A24) so viral traffic terminates before it reaches your origin. |

The **L1 in-process cache** is the highest-leverage fix for a shortener: viral links are exactly the case where a tiny TTL is acceptable (nobody re-points a link mid-virality) and the traffic is enormous.

---

### A22. URL expiry (TTL hits zero)

```
When a URL's expires_at passes:
  Cache:  the entry should stop resolving. Two mechanisms:
          (a) store expires_at in the cached value and check it on read, OR
          (b) set the Redis TTL == the URL's remaining lifetime so it auto-evicts.
  DB:     the row is NOT immediately deleted — mark it expired (soft-delete /
          status='expired'). A background reaper hard-deletes in batches later
          (keeps the delete off the hot path; supports BQ1 reclaim/audit).
  User visit to an expired code:
          → return 410 Gone (preferred: "this link existed but is dead")
          → or 404 Not Found (if you don't want to reveal it ever existed)
          Do NOT redirect.
```

```typescript
async function resolve(code: string): Promise<Result> {
  const rec = await getWithExpiry(code);            // from cache, then DB
  if (!rec) return { status: 404 };
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    await redis.del(`u:${code}`);                   // evict stale entry
    return { status: 410 };                         // Gone
  }
  return { status: 302, location: rec.url };
}
```

**410 vs 404 is a named tradeoff — information disclosure vs semantic accuracy.** 410 Gone tells crawlers to stop retrying (good for SEO hygiene) but confirms the code once existed; 404 hides existence (better if enumeration/privacy matters). Most shorteners return 404 to avoid leaking that a code was ever valid.

---

### A23. FAILURE MODE — Redis cluster goes down completely

```
Cascade:
  T+0   Redis dies. Cache hit rate 99% → 0%.
  T+0   ALL 115K reads/sec now fall through to the DB (cache-aside miss path).
  T+1s  DB was sized for ~1–2K QPS (misses + writes), not 115K.
        115K / (say 20K QPS DB ceiling) ≈ 5.75× overload → connection pool
        exhaustion → query queueing → p99 explodes → timeouts → retries →
        MORE load (retry storm) → DB effectively down → redirects 5xx.
  Result: total outage, even though the DB "survived" — it's saturated.
```

Can the DB handle 115K/sec? **No** — a shortener DB is provisioned for the write path (~1.2K/sec) plus normal miss traffic, not the full read firehose. That is the entire reason the cache exists.

**Design for it:**
| Defense | Effect |
|---|---|
| **Redis HA (replicas + Sentinel/Cluster)** | A single node death fails over in seconds; "complete" loss requires losing all replicas across AZs — make that require a multi-AZ event. |
| **Multi-tier cache (L1 in-process + CDN edge)** | If Redis dies, L1 and the CDN still absorb the hottest 80–95% of traffic; only the cold tail hits the DB. |
| **Load shedding + request coalescing** | On mass miss, coalesce concurrent misses for the same key into one DB read ("single-flight"); shed excess with 503 to protect the DB. |
| **DB read replicas** | Spread residual read load; still not 115K-capable, but buys headroom. |
| **Circuit breaker to DB** | Trip when DB latency climbs; serve stale/L1 or 503 rather than pile on. |

The key insight interviewers reward: **a cache that is load-bearing is a single point of failure unless it is itself redundant and backed by additional tiers.** You never let a cache be a hard dependency without a fallback plan.

---

### A24. Cache at the CDN edge vs app-tier Redis only

| | CDN edge (Cloudflare/Akamai/Fastly) | App-tier Redis |
|---|---|---|
| Latency | Best — served from PoP near the user (single-digit ms globally) | Good regionally; cross-region adds RTT |
| Origin offload | Massive — viral/hot links terminate at the edge | None from the edge; all reads reach your region |
| Freshness / re-pointing | **Hard** — must purge edge caches globally on change; propagation delay | Easy — TTL/`DEL` on your own Redis |
| Analytics | **Risky** — if the edge serves the redirect, you may not see the click (same 301-style blindness) unless the edge logs/beacons it back | Full — every click reaches your tier |
| Cost / control | Per-request edge cost; less control | Full control; you run it |

**Tradeoff — global latency & offload vs freshness & analytics.** Edge caching is excellent for **static, long-lived, high-traffic** links but fights the shortener's core needs (mutable destinations, per-click analytics). Common hybrid: use the edge with a **very short TTL** (seconds) so it absorbs viral spikes without meaningfully hurting re-pointing or analytics (the edge still forwards enough traffic, or beacons clicks). Pure-Redis is the default; add edge caching selectively for identified viral links. Cloudflare Workers KV is a real product used for exactly this edge-KV redirect pattern.

---

## Level 5 — Analytics

### A25. Analytics pipeline without adding redirect latency

The rule: **the redirect returns first; analytics happens off the hot path.**

```
Redirect service:
  1. Resolve code → 302 (return to user immediately)     ← < 10ms, blocking
  2. Fire-and-forget a click event to Kafka:             ← async, non-blocking
     { code, ts, ip, user_agent, referrer, geo_hint }

Kafka (topic: clicks, partitioned by short_code):
       │
       ▼
Stream consumers (Flink / Kafka Streams / Spark):
  - parse user_agent → device type
  - GeoIP(ip) → country
  - PFADD hll:{code} ip → unique visitors (HyperLogLog, A27)
  - INCR counters by (code, country, device, hour)
       │
       ▼
Stores:  aggregates → OLAP/columnar (ClickHouse/Druid/BigQuery)
         raw events → cheap object storage (S3) for re-processing (BQ2)
```

Why Kafka in the middle: it **decouples** the redirect's write rate from the analytics processing rate, buffers spikes (a viral link won't overwhelm the aggregator), and lets you replay events if a consumer has a bug. The redirect path only does a single non-blocking produce (or writes to a local ring buffer flushed by a sidecar). This is the standard Bitly-style design — Bitly built and open-sourced **NSQ**, a realtime distributed message queue, to power exactly this kind of decoupled event pipeline (I'm confident about NSQ's origin at Bitly; treat exact internal topology as illustrative).

---

### A26. Redis `INCR` vs Kafka streaming for click counts

| | `INCR code:clicks` in Redis | Stream to Kafka + async process |
|---|---|---|
| Latency to increment | Sub-ms, on/near hot path | Zero on hot path (fire-and-forget) |
| Data richness | Just a counter | Full event: geo, device, referrer, timestamp |
| Re-processing / new dimensions | Impossible (only the count survives) | Yes — replay raw events (BQ2) |
| Durability | Volatile unless persisted | Durable, replayable log |
| Failure isolation | A Redis hiccup can slow redirects | Redirect unaffected by analytics outages |
| Best for | A single real-time counter you show instantly | Rich, multi-dimensional, auditable analytics |

**When to choose each:** Use **Redis `INCR`** when you need a *single, instant, approximate* number (e.g., a live "clicks so far" badge) and can tolerate loss. Use **Kafka** when you need multi-dimensional breakdowns (country/device/referrer), durability, and the ability to re-slice later. In practice you often do **both**: `INCR` for the instant top-line number, Kafka for the durable rich pipeline (A28). Named tradeoff: **immediacy vs flexibility+durability.**

---

### A27. Counting unique visitors at scale — HyperLogLog

A naive `SET` of IPs per code costs O(unique IPs) memory — a viral link with 10M unique visitors would store 10M × ~16 bytes ≈ 160MB **per link**. Unworkable.

**HyperLogLog (HLL)** estimates cardinality in **fixed ~O(1) space** by observing the maximum run of leading zeros in hashes of the inputs (rare long runs imply many distinct inputs). Redis implements it directly:

```
PFADD   hll:{code} 1.2.3.4        # add a visitor IP
PFADD   hll:{code} 5.6.7.8
PFCOUNT hll:{code}                # → approximate unique count
PFMERGE hll:total hll:a hll:b     # union across codes/time-windows, still O(1) space
```

| | Exact SET of IPs | HyperLogLog |
|---|---|---|
| Memory | O(n) — grows without bound | **Fixed ~12KB** per HLL (Redis) |
| Accuracy | Exact | Approximate, **~0.81% standard error** (Redis) |
| Merge across windows | Expensive set union | `PFMERGE` — cheap, still ~12KB |

The **named tradeoff is accuracy vs memory**: you give up ~0.81% precision to go from unbounded memory to a flat ~12KB per counter. For "unique visitors," 0.81% error is invisible to the customer, so HLL is the standard choice. (Redis's 12KB and 0.81% are documented figures for its HLL implementation.)

---

### A28. Real-time (per-second) dashboard vs "good enough in 5 minutes"

| | 5-minute dashboard | Per-second real-time dashboard |
|---|---|---|
| Aggregation | Batch/micro-batch (e.g., 1–5 min windows), cheap | Continuous stream processing + low-latency store |
| Store | Columnar OLAP (ClickHouse/BigQuery) queried on demand | In-memory counters (Redis `INCR`) or a streaming store (Druid/Pinot) |
| Delivery | Client polls every N seconds | Server push (WebSocket/SSE) of live deltas |
| Cost | Low | High — must keep the whole pipeline hot and low-latency |
| Failure of pipeline | Dashboard is a few minutes stale (tolerable) | Dashboard visibly freezes (customer-facing) |

The per-second requirement **pulls the aggregation forward and adds a push channel**: you increment Redis counters directly from the consumer (or even do a best-effort `INCR` on the redirect path) and push updates over WebSocket/SSE. The 5-minute version can lazily aggregate in an OLAP store and let the client poll. **Named tradeoff — freshness vs cost/complexity.** Most customers do not actually need per-second; sell the 5-minute view by default and reserve real-time for premium/enterprise, because real-time roughly multiplies the analytics infra cost.

---

### A29. FAILURE MODE — Kafka consumer 2 hours behind (50M events lag)

```
Detection:
  - Monitor consumer lag: (log-end-offset − committed-offset) per partition.
    Alert when lag > threshold or lag is growing monotonically.
  - Grafana: kafka_consumergroup_lag{group="analytics"} rising steadily.
  - Symptom: redirects healthy (green), dashboards stale (last update 2h ago).

User impact:
  - Redirects: NONE. The whole point of decoupling — the hot path is unaffected.
  - Analytics: click counts are 2h behind. Business customers see stale numbers,
    not wrong ones (they'll catch up). No data loss (Kafka retains the log).

Recovery:
  1. Find the cause: slow downstream (OLAP write throttled)? poison message?
     under-provisioned consumers? a hot partition (skew on one popular code)?
  2. Scale out consumers up to the partition count (parallelism ceiling = #partitions).
     If one partition is the bottleneck (hot code), repartition or add a salt key.
  3. Let consumers burn down the backlog (they read faster than real-time when
     not latency-bound). 50M events at, say, 100K events/sec/consumer × 8 = ~60s
     of pure processing once unblocked (illustrative).
  4. If the backlog exceeds Kafka retention, you lose the oldest events — size
     retention (e.g., 7 days) to survive realistic outages.

Prevention:
  - Partition count >> peak needed parallelism (headroom to scale consumers).
  - Autoscale consumers on lag. Idempotent writes so replay is safe.
  - Backpressure-aware sink; DLQ for poison messages.
```

The interview point: **decoupling converts a would-be outage into a bounded staleness problem.** Because analytics is async, falling behind degrades a non-critical feature (freshness) instead of taking down redirects — and Kafka's durable log means you recover without data loss.

---

## Level 6 — Scale & Sharding

### A30. Sharding 182 billion URL records

182B rows exceed a single instance, so partition horizontally. **Shard by the short code** (the hot lookup key):

```
shard = hash(short_code) % NUM_SHARDS        # or consistent hashing (A33)

Resolve path (99.99% of traffic): you HAVE the short_code, so you compute the
shard directly → single-shard point lookup. No scatter-gather. Perfect.

Create path: mint code → compute shard → insert. Also single-shard.
```

Sizing (illustrative, from README constraints): 182.5B records × ~500 bytes/record ≈ **~91 TB** of primary data. With, say, 16 shards that is ~11 TB/shard (with replicas: ×3). Each shard is a replicated cluster (primary + replicas) for durability and read scaling.

Why short-code sharding fits: the dominant operation is a **point lookup by short code**, and hashing the code distributes both storage and read load uniformly, with no cross-shard fan-out. There are no hot-path range scans that would benefit from range partitioning. **Named tradeoff — even distribution vs range-query ability:** hash sharding gives uniform load but kills range scans; that is exactly the right trade here because we never range-scan on the hot path.

---

### A31. Shard by short-code hash vs by user ID

| | Shard by `hash(short_code)` | Shard by `user_id` |
|---|---|---|
| Redirect (code → url) | **Single shard** — you have the code | **Scatter-gather** — you don't know the owner from the code alone (must store owner in the code or do a lookup) |
| "All links for user X" (dashboard) | Scatter-gather across all shards | **Single shard** — user's links co-located |
| Load distribution | Even (hash spreads uniformly) | **Skewed** — a whale customer (millions of links) becomes a hot shard (A32) |
| Dominant workload fit | Redirects (115K/sec) | Per-user analytics reads (rare) |

**Choose shard-by-short-code.** The system is 100:1 read-heavy and the read is *the redirect*, which only knows the short code. Optimize for the operation that runs 115K times/sec, not the dashboard query that runs occasionally. To still serve "all links for user X" efficiently, maintain a **secondary index** (`user_id → [codes]`) in a separate store, or denormalize. Sharding by user_id would force every redirect into a scatter-gather or a second lookup — unacceptable at 115K/sec — and would create hot shards for large customers.

---

### A32. Handling a shard hotspot (one shard gets 10× traffic)

```
Diagnose first: is it a KEY-distribution problem or an ACCESS-frequency problem?
  - Key distribution (one shard owns too many codes): fix with rebalancing/vnodes.
  - Access frequency (a few viral codes on one shard): fix with caching, not resharding.
```

| Mitigation | When it applies |
|---|---|
| **Cache the hot keys harder (L1 + Redis + edge)** | Access-frequency hotspot from viral links — absorb reads before they reach the shard. This is usually the real fix for a shortener. |
| **Split the hot shard** | Key-distribution hotspot — subdivide the shard's key range across more nodes (consistent hashing with vnodes makes this incremental, A33). |
| **Add read replicas to the hot shard** | Spread read load without moving data. |
| **Hot-key fan-out** | Replicate the specific viral code across shards under salted keys (A21). |

Because a shortener's hotspots are almost always **viral individual links (access frequency)**, the first-line mitigation is **more caching**, not resharding. Resharding is reserved for genuine key-distribution imbalance. **Named tradeoff — data movement vs load absorption:** caching absorbs load with zero data movement; resharding moves data but permanently rebalances.

---

### A33. When consistent hashing beats modulo sharding

`hash(code) % N` is simple and, for a **fixed** shard count, perfectly fine. The problem appears when **N changes**: with modulo, adding one shard remaps ~(N−1)/N of all keys (e.g., 8→9 shards moves ~89% of keys), triggering a massive data-migration/cache-invalidation storm.

**Consistent hashing** places shards and keys on a ring so that adding/removing a shard moves only ~**1/N** of keys (just the new node's arc), not ~all of them.

| | Modulo `% N` | Consistent hashing (+ vnodes) |
|---|---|---|
| Keys moved when adding a shard | ~(N−1)/N (near-total) | ~1/N (bounded) |
| Best for | Fixed, never-resized cluster | A cluster that grows/shrinks over time |
| Complexity | Trivial | Ring + virtual nodes to keep balance |

**It is worth the complexity when the shard count will change** — which, for a system growing from 182B toward larger, it will. The problem it *actually* solves is not lookup speed; it is **bounding the blast radius of a topology change** so scaling out doesn't cause a full reshuffle + thundering-herd on the DB. If the cluster were truly fixed-size forever, modulo is the right, simpler call. (See the consistent-hashing topic for the ring mechanics.)

---

### A34. FAILURE MODE — 1 of 8 shards down, 12.5% of redirects 500ing

```
Immediate mitigation (minutes):
  1. Fail over to a replica of the dead shard. If the shard is a replicated
     cluster (primary + 2 replicas), promote a replica → most traffic recovers.
  2. If no fast failover: serve from cache for that shard's keys (many hot codes
     are still in Redis and don't need the DB at all) → reduces the 12.5% sharply.
  3. Return 503 (retryable) not 500 for the truly-unresolvable tail; add a
     "try again" so clients/browsers retry rather than treat it as permanent.

Recovery (hours):
  4. Rebuild the failed shard from replica/snapshot + WAL; re-add to the ring.
  5. Verify data integrity (row counts, checksums) before restoring write traffic.

Architectural fix (prevents recurrence):
  6. EVERY shard must be a replicated group (RF ≥ 3, multi-AZ), never a single node.
     A single-node shard failing = 1/N of the product down. Unacceptable.
  7. Automated failover (managed DB / Patroni / etc.) so promotion is seconds, not
     a human at 2am.
  8. The cache tier (Redis) already shields most reads — ensure cache is also HA so
     a shard loss doesn't coincide with cache pressure (A23).
```

The core lesson: **a shard must never be a single point of failure.** With replication + auto-failover, one node dying degrades latency for seconds, not availability for 12.5% of users.

---

## Level 7 — Abuse & Security

### A35. Spammer creating 10,000 short URLs/minute — rate limiting

```
Layered defense:
  1. Per-API-key / per-user quota (token bucket): e.g., 100 creates/min, burst 200.
  2. Per-IP limit (for anonymous creation): sliding-window counter.
  3. Global anomaly detection: a key suddenly 100× its baseline → auto-throttle + alert.
  4. Reputation: new accounts get low quotas; earned trust raises them.
```

**Distributed token bucket in Redis (works at scale):**
```typescript
// Refill `rate` tokens/sec up to `burst`; each create costs 1 token.
async function allow(key: string, rate = 100/60, burst = 200): Promise<boolean> {
  // Lua script (atomic): read tokens+timestamp, refill by elapsed*rate,
  // if tokens >= 1 decrement and allow, else deny. One round-trip, no race.
  return await redis.eval(TOKEN_BUCKET_LUA, [`rl:${key}`], [rate, burst, now()]);
}
```

| Algorithm | Property |
|---|---|
| **Token bucket** | Allows bursts up to `burst`, smooth average `rate`. Best general choice. |
| **Sliding-window log/counter** | Precise per-window limits; more memory. |
| **Fixed window** | Cheapest; suffers boundary bursts (2× at the edge). |

Rate limiting must be **centralized (Redis)**, not per-instance — a spammer round-robins across your app servers, so per-instance counters miss the aggregate. Combine with CAPTCHA on anonymous creates and account-reputation tiers. This is the standard Cloudflare/Stripe-style layered approach.

---

### A36. Short URL points to a phishing/malware site

```
Prevention (at create time):
  1. Check the destination against threat-intel feeds:
     Google Safe Browsing API, PhishTank, proprietary blocklists.
  2. Block/flag creates to known-bad domains synchronously.
  3. Async deep scan (sandbox render) for new/unknown domains — the destination
     of a live phishing site can change AFTER creation, so scan continuously.

Reactive (after a link goes bad):
  4. Continuous re-scan of existing links (destinations mutate — a benign page
     turns malicious later; this is why 302 + mutability matters: you can kill it).
  5. On detection: DISABLE the code (serve an interstitial warning or 410),
     don't just delete — preserve for investigation/audit.
  6. Interstitial "you are leaving / this link is flagged" page for suspicious links.
  7. Abuse-report intake + human review queue.
```

The architectural enabler is that **you control the redirect** (302, not cached 301) — so you can revoke a malicious link at any moment and it stops working on the next click. A 301 shortener could never do this (A15). **Named tradeoff — creation latency vs safety:** synchronous scanning slows creates; the standard compromise is a fast synchronous blocklist check plus asynchronous/continuous deep scanning. Bitly and TinyURL both run Safe-Browsing-style checks (I'm confident they use threat-intelligence blocklists; exact vendors/details vary).

---

### A37. Preventing short-code enumeration

```
Threat: attacker walks tinyurl.com/aaaaaaa, aaaaaab, ... to scrape all links.

Defenses (layered):
  1. NON-SEQUENTIAL codes: random / scrambled / Snowflake-derived, so knowing
     one valid code gives ZERO information about the next (A13). This is the
     foundational defense — sequential codes make enumeration trivial.
  2. Sparse namespace: 182.5B used of 62^7 = 3.52T → ~5.2% density. Random guesses
     mostly hit 404. (Note: 5.2% is a HIGH hit rate — sparsity alone is NOT enough;
     it must be combined with the measures below. Longer codes lower density:
     62^8 = 218T → ~0.08%.)
  3. Rate-limit + bot-detect on 404s: an enumerator generates a flood of misses.
     Throttle/ban IPs whose 404 rate spikes. Negative-cache 404s (A20) so scanning
     can't DoS the DB.
  4. Accept the security model: a URL shortener is "anyone with the link can access."
     It is security-by-obscurity by design. Truly sensitive content must NOT rely
     on an unguessable short URL — that's an application-level rule, not a shortener
     feature.
```

The honest senior answer names the limit: shorteners are **not** an access-control mechanism. Enumeration is *deterred* (non-sequential + rate limiting), not *prevented*; sensitive resources need real auth behind the redirect.

---

### A38. Per-customer URL blacklist/allowlist

```
Data model:
  policy(customer_id, mode ENUM['allowlist','blocklist'], patterns[])
  patterns: domain globs / regexes, e.g., "*.competitor.com", "example.org/*"

Enforcement (at create time, on the write path):
  function validateDestination(customerId, url):
      policy = getPolicy(customerId)              # cached per customer
      host   = parse(url).host
      if policy.mode == 'blocklist' and matchesAny(host, policy.patterns):
          reject(403, "destination blocked by your org policy")
      if policy.mode == 'allowlist' and not matchesAny(host, policy.patterns):
          reject(403, "destination not on your org allowlist")
```

| Mode | Semantics | Use case |
|---|---|---|
| **Blocklist** | Deny listed domains, allow everything else | "Employees can't link to competitors" |
| **Allowlist** | Allow only listed domains, deny everything else | High-security orgs — only approved destinations |

Enforce at **create time** (cheap, ~1.2K/sec write path) and cache each customer's compiled policy in Redis so lookup is O(1). Re-validate on any policy change by scanning that customer's existing links asynchronously and disabling violators. **Named tradeoff — flexibility vs safety:** allowlist is safer but higher-friction (blocks legitimate new domains); blocklist is lower-friction but leaky. Enterprises with compliance needs choose allowlist; most choose blocklist. Normalize hosts (punycode, case, trailing dots) to avoid bypass.

---

### A39. FAILURE MODE — zero-day exploited through your links; law enforcement at 2 AM

```
Incident response (the night of):
  1. Triage: identify the malicious destination(s) and the short codes pointing there.
     Query: which codes resolve to the exploited domain/URL pattern?
  2. Contain: DISABLE those codes immediately (serve 410/interstitial). Because we
     use 302 (not cached 301), disabling takes effect on the next click.
  3. Preserve evidence: snapshot the affected rows, click logs (who clicked, when,
     from where) BEFORE any cleanup. Chain-of-custody for law enforcement.
  4. Communicate: legal + comms + a single incident commander. Provide LE the
     click data under proper legal process.
  5. Broaden: block the destination pattern at CREATE time so new codes can't
     point there; scan existing links for related indicators of compromise.

Systems you MUST have built in ADVANCE to respond in minutes, not days:
  - A "kill switch": disable any code / all codes matching a destination pattern,
    fast and audited.
  - Reverse index: destination → [short codes] (so you can find all links to a URL).
  - Retained, queryable click logs (who/when/where) — analytics pipeline pays off here.
  - Threat-intel integration + a block-on-create pattern list.
  - An on-call runbook + legal escalation path for LE requests.
```

The interview signal: **incident response quality is determined by what you built beforehand.** The reverse index (destination → codes), the kill switch, and retained click logs are the difference between responding in minutes and being helpless. This is also the strongest argument for 302-over-301 (revocability) and for keeping raw click events (BQ2, forensics).

---

## Level 8 — Architect-Level

### A40. Designing for 99.999% availability (5.26 min/year)

| Layer | 5-nines requirement |
|---|---|
| **DB replication** | RF ≥ 3, multi-AZ, automated failover (seconds). No single-node shard. Cross-region replicas for regional failure. |
| **Cache redundancy** | Redis with replicas + Sentinel/Cluster, multi-AZ; L1 in-process + edge as additional tiers so a cache-tier loss ≠ outage (A23). |
| **Deployment strategy** | Zero-downtime: blue-green / canary, automated rollback. A bad deploy is a top cause of outages — gate it. |
| **Failure detection** | Health checks + fast automated failover; the *detection + recovery* time must fit inside the 5.26-min/year budget. |
| **Redundancy math** | 5 nines ≈ 5.26 min/year. With `A_total = 1 − Π(1 − A_i)` for redundant components, two independent 99.9% instances give ~99.9999% *if failures are independent* — the catch is correlated failure (shared AZ, shared config push, shared dependency). |

```
Availability arithmetic:
  99.9%   = 8.76 hours/year
  99.99%  = 52.56 minutes/year
  99.999% = 5.26 minutes/year   ← the target
```

The hard part of 5 nines is **not** buying more replicas — it is eliminating **correlated failure and human error**: a bad config push, a schema migration lock, a cache stampede, a cascading retry storm (A44). Redundancy handles independent hardware failure; discipline (canaries, circuit breakers, load shedding, chaos testing) handles the correlated failures that actually cause multi-minute outages. Also decide *what* needs 5 nines: the **redirect path** must; the **create path** and **analytics** can run at lower tiers (a create failing for 30s is annoying; a redirect failing loses trust).

---

### A41. Expanding to 3 regions (US, EU, APAC)

```
Redirect (read) path — must be LOCAL and fast in every region:
  - Full read replicas of the URL data in each region + regional Redis.
  - A user in EU resolves against EU cache/replica → < 10ms, no cross-ocean hop.
  - Route via GeoDNS / anycast to the nearest region.

Create (write) path — choose a consistency model:
  Option A: Single write region (leader) + async replication to others.
    + Simple, no write conflicts.
    − Cross-region create latency for far users; leader-region outage stops writes.
  Option B: Multi-master (write in any region).
    + Local low-latency creates everywhere.
    − Must prevent short-code COLLISIONS across regions (two regions minting the
      same code). Fix: partition the ID space per region (region bits in the ID,
      or per-region counter ranges) so codes are globally unique WITHOUT
      cross-region coordination. This is exactly what Snowflake's machine-id bits
      or per-region counter blocks give you.
```

**Consistency model:** the `code → url` mapping is **immutable after creation** (the destination is set once, edits are rare), so **eventual consistency** across regions is fine for reads — a newly created link may take replication-lag seconds to appear in a far region, which is acceptable. The one hard invariant is **globally unique codes**, solved by partitioning the ID namespace per region (region-prefixed IDs / per-region counter blocks) so no two regions ever mint the same code without talking to each other. **Named tradeoff — write latency vs coordination:** single-leader avoids conflicts but adds write latency and a write SPOF; region-partitioned multi-master gives local writes and no coordination at the cost of a slightly less dense namespace. For a read-heavy, immutable-mapping system, region-partitioned IDs + async replication is the standard answer.

---

### A42. Google scale — 1 trillion redirects/day — what breaks first

```
Capacity math:
  1T/day ÷ 86,400 s ≈ 11.57 MILLION redirects/sec average (100× our 115K).
  Storage: at 100M×10 = 1B new URLs/day × 5yr × ~500B ≈ ~900 TB primary (×3 = ~2.7 PB).
```

Top 3 bottlenecks, in order:

| # | Bottleneck | Why it breaks first | Mitigation |
|---|---|---|---|
| 1 | **Cache/edge fleet & network** | 11.5M req/sec means even a 99% hit rate leaves ~115K/sec of misses — our *entire original system* is now just the miss traffic. The cache tier + NIC bandwidth is the first wall. | Massive multi-tier edge caching (CDN does most redirects), regional cache fleets, L1 everywhere. Redirect terminates at the edge for hot links. |
| 2 | **Analytics pipeline** | 1T click events/day ≈ 11.5M events/sec into Kafka; at ~200 bytes/event that's ~2 PB/day of raw events. Ingest, storage, and processing dwarf the redirect problem. | Sample or pre-aggregate at the edge; HLL for uniques; tiered retention (raw → warm → cold); this is a bigger system than the shortener itself. |
| 3 | **Write-path ID generation & DB fan-out** | 1B creates/day ≈ 11.6K creates/sec, each needing a globally-unique code across a huge fleet — central counters can't keep up. | Coordination-free IDs (Snowflake / per-node ranged blocks) become mandatory, not optional. Shard count in the thousands. |

The insight: at 100× scale, **the redirect itself stays simple (it's a cache GET), but the supporting systems — edge caching bandwidth and the analytics firehose — become the dominant engineering problems.** The DB is almost irrelevant on the read path because it's fully shielded by cache; the challenge moves to the edge and the event pipeline.

---

### A43. Guaranteeing a 5-year-old link still works

```
Technical challenges:
  - Data durability over 5+ years: backups, migrations, format changes, no data loss
    across hardware refreshes and DB version upgrades.
  - Namespace: the code must never be reissued to a different URL while the old one
    is "alive" (collision-over-time). Counter/Snowflake IDs never reuse — good.
  - Schema/tech migrations: the resolve path must survive DB engine swaps,
    re-shardings, region moves — all without breaking existing codes.

Operational challenges:
  - Expiry policy conflict: "5-year retention" vs "link works forever" — decide and
    document the SLA. If default retention is 5 years, a "still works after 5 years"
    guarantee means NO default expiry (or explicit renewal).
  - Cost: storing 182B+ rows indefinitely grows unboundedly. Tier cold links to
    cheaper storage (rarely-clicked codes → cold store; hot codes stay fast).
  - Custom-alias reclaim (BQ1): if expired aliases can be re-registered, an OLD
    printed link could suddenly point somewhere NEW — a security/consistency risk.
    Guarantee "works forever" ⇒ codes are NEVER reclaimed.

Design for it:
  - Immutable, never-reused codes (counter/Snowflake).
  - Multi-tier storage: hot (SSD/cache) for active links, cold (object storage) for
    the long tail — a 5-year-old rarely-clicked link can afford a slower first hit.
  - Durable, versioned backups + tested restore. Migration playbooks that keep
    resolve working throughout.
```

**Named tradeoff — durability guarantee vs storage cost.** "Works forever" turns storage into a monotonically growing liability; you manage the cost by *tiering* cold links, not by deleting them. The SLA also forbids code reuse and alias reclaim, which trades a smaller effective namespace and less flexibility for the permanence guarantee.

---

### A44. FAILURE MODE — reasoning about a 2-hour cascading redirect outage

> Note: I cannot independently verify the specifics of the referenced 2016 Bitly incident, so I'll reason from first principles about how such an outage happens despite redundancy — which is what the question actually asks.

```
A plausible cascade to a 2-hour redirect outage WITH redundancy:

  T+0    Trigger: a DB primary fails OR a bad config/schema push OR a cache-tier
         hiccup. Individually survivable.
  T+0    Cache pressure: if the trigger evicts/loses cache, hit rate drops. Reads
         that were cache-served now fall through to the DB (A23).
  T+30s  Retry storm: clients + internal services retry failed reads aggressively,
         MULTIPLYING load on the already-stressed DB.
  T+1m   DB saturates → latency climbs → health checks flap → automated failover
         promotes a replica → but the replica is immediately hit by the SAME
         thundering herd → it saturates too (failover doesn't help if the problem
         is load, not the node).
  T+5m   Cold-cache problem: even after the DB recovers, the cache is empty; every
         read is a miss; the herd persists → the system can't "catch up" because
         refilling the cache requires surviving the very load the cache existed to
         absorb. This is the trap that turns minutes into HOURS.
  T+2h   Manual intervention finally breaks the loop (shed load, warm cache slowly,
         throttle retries).

What I'd have done differently:
  1. Circuit breakers: trip the DB call under stress; serve stale/L1 or 503 instead
     of piling on. Stops the retry storm from killing the DB.
  2. Request coalescing (single-flight): collapse concurrent misses for the same
     key into ONE DB read → cold-cache refill doesn't become N× load.
  3. Exponential backoff + jitter on ALL retries (clients and services) → no
     synchronized retry waves.
  4. Load shedding: shed low-priority traffic to keep the redirect core alive.
  5. Staged cache warming: on recovery, warm the cache from the top-N hot keys
     before reopening full traffic, so the DB isn't hit by a cold herd.
  6. Cell/bulkhead isolation: partition so one failing cell can't cascade globally.
  7. Chaos testing: regularly kill the cache in prod-like conditions to prove the
     system degrades gracefully instead of collapsing.
```

The root lesson: **redundancy protects against independent component failure, not against load-driven cascades.** A cold cache + retry storm + failover-into-the-same-load is how "redundant" systems still go down for hours. The fixes are all about **breaking feedback loops** (circuit breakers, backoff, coalescing, shedding) — not adding more replicas.

---

## Bonus — Unprompted Senior Questions

### AB1. Delete story, expiry, and alias reclaim

```
Delete model — SOFT delete first, hard delete later:
  - On expiry/delete: set status='expired'/'deleted' + deleted_at (don't DROP the row).
  - A background reaper HARD-deletes in batches after a grace/retention window.
  Why soft first: keeps the delete off the hot path, preserves audit/forensics (A39),
  allows undo, and lets analytics/legal queries still resolve historical codes.

Custom-alias reclaim — the security risk:
  If a user can register an EXPIRED custom alias (e.g., "acme-promo") that someone
  else used before, then OLD material (emails, printed flyers, QR codes) pointing to
  that alias now redirects to the NEW owner's destination — a hijack.
  → Attacker waits for a valuable alias to expire, claims it, and redirects the
    victim's still-circulating links to malware/phishing.

Recommendation:
  - Do NOT allow reclaim of custom aliases by default. Once issued, retire forever.
  - If reclaim is a product requirement, enforce a long quarantine (e.g., alias
    unusable for N years after expiry) AND require the old link to show an
    interstitial, never a silent redirect to a new owner.
```

**Named tradeoff — namespace reuse vs link-integrity/security.** Reclaiming aliases recovers a scarce human-readable namespace but breaks the "a link always means the same thing" invariant. For a public shortener, integrity wins: never silently reassign a code.

---

### AB2. Raw click events vs pre-aggregated counts

| | Raw events (log-level) | Pre-aggregated counts |
|---|---|---|
| Storage | ~1 TB/day at 10B events (question's figure) — expensive | Tiny — a few counters per code |
| Flexibility | Re-slice by ANY new dimension later; forensics (A39); ML | Locked to the dimensions you chose upfront |
| Query cost | Heavy (scan raw) unless also aggregated | Cheap |
| Compliance/legal | Full audit trail (who/when/where) | No detail — can't answer "who clicked" |

**What the company actually needs — do both, tiered:**
```
- Keep raw events in CHEAP storage (S3/object) with tiered retention
  (hot 30d → warm 1y → cold/Glacier), so you CAN re-slice & do forensics.
- Serve dashboards from PRE-AGGREGATED rollups (fast, cheap to query).
- Roll up raw → aggregates continuously (stream processing).
```
The pure-aggregate approach saves money but loses the ability to answer new questions ("break clicks down by browser version") and loses forensic/legal capability (A39) — often a dealbreaker for enterprise/compliance. The pure-raw approach is flexible but expensive to store and slow to query. The standard resolution is **raw in cold storage + aggregates for serving**, which is what makes the ~1 TB/day affordable (cold storage is cheap) while keeping dashboards fast. **Named tradeoff — flexibility/auditability vs storage+query cost.**

---

### AB3. Birthday-paradox timing and the migration to 8-char codes

```
Namespace math:
  62^7 = 3,521,614,606,208 ≈ 3.52 TRILLION codes.
  Fill time at 100M creates/day: 3.52T / 100M = 35,216 days ≈ 96 years to EXHAUST.

But collisions bite FAR sooner than exhaustion (birthday paradox):
  50% cumulative collision probability at k ≈ 1.177 × √(62^7) ≈ 2.2 MILLION codes
  — IF codes are chosen randomly (hash/random). At 100M creates/day that's ~32 min.

Resolution:
  - If codes come from a COUNTER/Snowflake (unique by construction), there is NO
    birthday problem at all — you use each ID exactly once. Collisions only afflict
    RANDOM/HASH generation. This is the decisive reason to prefer counter/Snowflake.
  - "Real operational concern" for a RANDOM scheme: collision RETRIES become common
    as density rises; with retry-on-collision it stays correct but write latency
    creeps up. Watch the collision-retry rate as the health metric.

Migration path 7 → 8 chars (62^8 = 218 TRILLION, 62× bigger):
  1. Bump the generator to emit 8-char codes for NEW links (flip a config; the
     Base62 encoder naturally produces 8 chars once IDs exceed 62^7).
  2. Resolver already handles variable-length codes (it's just a key lookup) —
     OLD 7-char codes keep working unchanged. NO migration of existing data.
  3. That's it — because codes are opaque keys, lengthening is backward-compatible.
```

The elegant part: because a short code is just an **opaque lookup key**, extending its length is a **non-breaking, config-only change** — old codes resolve forever, new codes get more room. And if you use counter/Snowflake IDs, the "birthday" worry disappears entirely; the only real trigger to go to 8 chars is **namespace exhaustion** (~96 years away) or a desire for more entropy, not collisions.

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Core operations | Create (write, ~1.2K/s) + Resolve (read, ~115K/s); both point-lookups by short code |
| Read:write | 100:1 — the redirect (read) path defines the architecture; cache-first, never DB on hot path |
| Base62 | `[0-9A-Za-z]`, 62 symbols; URL-safe (no `+ / =` like Base64); 62^7 = 3.52 trillion codes |
| ID → code (preferred) | Counter/Snowflake ID → Base62; unique BY CONSTRUCTION, no collision check |
| Hash → code (trap) | MD5/SHA truncated; collisions certain — 50% at ~2.2M URLs (birthday), 100% by 100M |
| Birthday bound | P(collision) ≈ 1 − e^(−k²/2N); N = 62^7; 50% at k ≈ 1.177√N ≈ 2.2M |
| Snowflake ID | 64-bit: 41 bit ms (69.7 yr) + 10 bit machine (1024) + 12 bit seq (4096/ms); coordination-free |
| Counter service | Hands out ID BLOCKS to servers; server mints locally; survives outage until block drains |
| Auto-increment risk | Enumeration (scrape all) + German-tank BI leak (guess your volume) → never expose raw |
| 301 vs 302 | 301 = cached forever, kills analytics + can't re-point; 302 = every click counted → USE 302 |
| 302 headers | `Location` + `Cache-Control: no-store` (the pairing that makes 302 actually temporary) |
| < 10ms P99 | Redirect served from cache/edge, never DB; click event emitted async |
| Cache-aside | GET Redis → hit; miss → DB → repopulate; negative-cache 404s to stop enumeration DoS |
| Hot key | One viral code overloads one shard; fix = L1 in-process cache + key fan-out + edge, not resharding |
| Redis-down cascade | 0% hit → 115K/s hits DB (sized for ~2K) → saturation → outage; need HA cache + circuit breaker + coalescing |
| Unique visitors | HyperLogLog: ~12KB fixed, ~0.81% error (Redis PFADD/PFCOUNT), vs unbounded SET of IPs |
| Analytics decoupling | 302 first, click → Kafka async; consumer lag = bounded staleness, NOT an outage |
| Shard by | short-code hash → single-shard redirects, even load; NOT user_id (scatter-gather + whale hotspots) |
| Consistent hashing | Worth it when shard count changes: moves ~1/N keys vs modulo's ~(N−1)/N |
| Shard failure | Every shard = replicated group (RF≥3, multi-AZ) + auto-failover; never a single node |
| Enumeration defense | Non-sequential codes + sparse namespace (5.2% density) + 404 rate-limit; NOT an access-control system |
| Malware/phishing | Safe-Browsing/blocklist at create + continuous re-scan; 302 lets you REVOKE on next click |
| 5 nines | 5.26 min/yr; redundancy handles hardware, discipline (canary, breakers, backoff) handles cascades |
| Multi-region | Local read replicas + regional cache; region-partitioned IDs for global uniqueness; eventual consistency OK |
| Google scale (1T/day) | 11.5M req/s; bottlenecks = edge cache bandwidth + analytics firehose (2PB/day), not the DB |
| 5-yr link SLA | Immutable, never-reused codes + tiered cold storage; forbids alias reclaim |
| Alias reclaim risk | Reclaiming expired alias hijacks still-circulating old links → don't reclaim by default |
| Raw vs aggregate | Raw in cheap cold storage (forensics/re-slice) + aggregates for serving dashboards |
| 7→8 char migration | Config-only, non-breaking: old codes resolve forever, new codes get 62× more room |
| Cascade root cause | Cold cache + retry storm + failover-into-load; fix with breakers, coalescing, backoff, staged warming |
