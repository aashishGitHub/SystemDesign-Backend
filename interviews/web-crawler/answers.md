# Answers: Web Crawler (Google Search Indexer)

> Keyed to [questions.md](./questions.md). Read each question and attempt it aloud before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on the decisions that matter.
> Capacity numbers are derived from the constraints in [README.md](./README.md); illustrative figures are labeled as such.

---

## Level 1 — Fundamentals

### A1. The basic crawl loop end-to-end

A crawler is BFS over the web graph. Each iteration pulls one URL, fetches it, extracts links, and feeds new URLs back into the frontier. The output of each step is the input of the next.

```
1. DEQUEUE   frontier.next()            → a URL that is polite-to-fetch right now
2. RESOLVE   dns.resolve(host)          → IP (from cache if possible)
3. ROBOTS    robots.allowed(url)        → check cached robots.txt rules
4. FETCH     http.get(url)              → HTTP response (status, headers, body)
5. STORE     blob.put(hash, body)       → raw HTML to object storage (WARC record)
6. PARSE     parse(body)                → DOM, extract <a href>, <meta>, canonical
7. NORMALIZE canonicalize(each_link)    → absolute, lowercased host, sorted params
8. DEDUP     seen.contains(url)?        → Bloom filter + durable set check
9. ENQUEUE   frontier.add(new_urls)     → with priority + politeness metadata
10. SCHEDULE recrawl.set(url, next_time)→ record change signal for re-crawl
```

| Step | Component | Output goes to |
|---|---|---|
| Dequeue | URL frontier | Fetcher worker |
| Fetch | HTTP client pool | Blob storage + parser |
| Parse | HTML parser | Link extractor + content dedup |
| Dedup | Bloom filter + durable set | Frontier (only unseen URLs) |
| Store | Object storage (WARC) | Downstream indexer |

The **frontier is the heart of the loop** — it is not a plain queue; it encodes priority, freshness, and politeness (see A6).

---

### A2. BFS over DFS, and when DFS is catastrophic

Crawlers use **BFS** because importance correlates with shallowness: a site's homepage and top navigation (high PageRank, high value) are close to the seed, while low-value pages (deep parameter permutations, archives) are many hops away. BFS naturally crawls high-value pages first and spreads requests across many hosts, which helps politeness.

**DFS is catastrophic on a spider trap.** DFS dives down one path as deep as it can go. On a site with an infinite URL space — a calendar with `?date=` that generates `next month` forever, or faceted-search parameter explosion — DFS follows that single chain indefinitely, hammering one host, never returning to crawl the rest of the web.

| Property | BFS | DFS |
|---|---|---|
| Data structure | FIFO queue | LIFO stack |
| Crawls high-value pages first | Yes (importance ∝ shallowness) | No (dives deep immediately) |
| Host distribution | Spreads across many hosts | Concentrates on one host |
| Spider-trap behavior | Bounded per level; other work continues | Follows infinite chain forever |
| Politeness fit | Natural | Poor (hammers single host) |

In practice production crawlers use **priority-ordered BFS**, not pure FIFO — priority (PageRank proxy, freshness) reorders within the BFS frontier.

---

### A3. Seed URLs and bootstrapping a fresh crawl

A **seed URL** is a starting point injected into the frontier before any crawling has happened — the crawler has no link graph yet, so it needs manual entry points. Every other URL is discovered by extracting links from fetched pages.

**Strategy to bootstrap a fresh crawl of the whole web:**

```
1. High-authority hubs: Wikipedia, DMOZ-style directories, major news portals.
   These link out to a huge, diverse fraction of the web within 2-3 hops.
2. Domain popularity lists: e.g., the Tranco list / Cloudflare Radar top domains
   (the old "Alexa top 1M" is deprecated). One seed per registrable domain.
3. Sitemaps: sites publish /sitemap.xml listing their canonical URLs — cheap breadth.
4. Certificate Transparency logs / DNS zone files: enumerate live domains directly.
5. Prior crawl's frontier: a warm start from the last crawl's discovered-but-uncrawled set.
```

The goal is **maximum reachability with minimum seeds**: pick hubs whose out-degree covers the most of the web graph in the fewest hops. A single Wikipedia seed reaches millions of external domains.

---

### A4. [FAILURE MODE] Infinite scroll / parameter-generated URL trap

The site generates `?page=1 … ?page=10000000`. Each fetched page yields a new "next" link, so the frontier **grows without bound from one host** — memory blows up and the crawler wastes its entire budget on one worthless domain.

**Defenses, layered:**

```
1. Max crawl depth per domain: stop following links past N hops from the seed
   (e.g., N=20). Trap chains are deep; real content is usually shallow.

2. Per-domain URL budget: cap pages/domain/day proportional to domain authority
   (e.g., low-authority domain → max 10k pages/day). The trap hits the cap and stops.

3. URL pattern / parameter detection: track distinct URLs per (host, path-template).
   If example.com/list?page=* has produced 10k URLs with near-identical content,
   demote or drop the template.

4. Content-based cutoff: SimHash the fetched pages. If ?page=N pages are near-identical
   (or the fetched content stops changing), stop crawling the series.

5. Frontier size cap per host: a bounded back-queue per host; overflow is dropped or
   spilled to cold storage with low priority.
```

| Defense | Stops the trap by | Cost |
|---|---|---|
| Max depth | Bounding chain length | May miss deep legit content |
| Per-domain budget | Bounding total pages/host | Needs authority scoring |
| Pattern detection | Recognizing generated URLs | State per URL template |
| Content SimHash | Detecting no new content | Must fetch to detect |

The cheapest and most robust is the **per-domain budget** — it bounds the blast radius regardless of the trap's shape.

---

### A5. robots.txt handling

`robots.txt` is the Robots Exclusion Protocol, standardized as **RFC 9309 (2022)**. It lives at `https://host/robots.txt` and tells crawlers what they may fetch. A well-behaved crawler fetches and parses it **before** crawling any URL on a host, caches it, and re-checks periodically.

**Fields that matter:**

| Directive | Meaning | Standardized? |
|---|---|---|
| `User-agent` | Which crawler the block applies to (`*` = all) | Yes (RFC 9309) |
| `Disallow` | Path prefix the crawler must not fetch | Yes |
| `Allow` | Exception carve-out inside a Disallow | Yes |
| `Sitemap` | Absolute URL of a sitemap | De-facto, widely honored |
| `Crawl-delay` | Min seconds between requests | **Non-standard** — Bing/Yandex honor it; **Googlebot ignores it** |

Matching uses the **longest/most-specific rule** for the matching user-agent group.

**If robots.txt is unreachable (RFC 9309 §2.3.1):**

```
2xx  → parse and apply the rules
3xx  → follow redirects (a few hops), then apply
4xx (e.g., 404) → "unavailable" = NO restrictions → crawl everything (no file = allowed)
5xx / 429       → server error → assume COMPLETE DISALLOW (be conservative), retry later
```

The critical asymmetry: **404 means allow-all, 5xx means disallow-all.** A missing file is a deliberate "no rules"; a server error is a temporary "we don't know, so stay off." I am confident about the RFC's conservative 5xx rule; Google additionally falls back to the last cached robots.txt for a grace window (documented as up to ~30 days) — treat that exact figure as approximate and verify against current Google docs.

---

## Level 2 — URL Frontier Design

### A6. What a URL frontier is (and why it is not a FIFO queue)

The **URL frontier** is the set of discovered-but-not-yet-fetched URLs, plus the policy that decides *which URL to fetch next and when*. It must simultaneously satisfy two competing goals:

- **Priority / freshness** — fetch high-value and stale-and-changing pages first.
- **Politeness** — never exceed the per-domain rate limit, and spread load across hosts.

A plain FIFO fails both: it crawls in discovery order (low value first), and it will happily fire 10k requests at one host that happens to have 10k links on its homepage.

| Requirement | Plain FIFO | Production frontier |
|---|---|---|
| Priority ordering | No | Yes (front queues) |
| Per-domain politeness | No | Yes (back queues, one host each) |
| Freshness re-ordering | No | Yes (priority = f(change rate)) |
| Scale to billions of URLs | In-memory only | Sharded across disk + workers |

At scale the frontier is a **distributed, disk-backed priority queue**, partitioned by domain (see A23), commonly implemented over Redis sorted sets, Kafka, or a custom store, with the hottest slice in memory.

---

### A7. The two-level (front-queue / back-queue) frontier

This is the **Mercator design** (Heydon & Najork, 1999), and the standard interview answer. Two banks of queues separate *priority* from *politeness*.

```
                 ┌──────────── FRONT QUEUES (prioritization) ─────────────┐
  URL ──prioritizer──► [F1 highest] [F2] [F3] ... [Fk lowest]
                 └────────────────────────────────────────────────────────┘
                                      │  (biased random pull: favor high priority)
                                      ▼
                 ┌──────────── BACK QUEUES (politeness) ───────────────────┐
  back-queue router ► [B1: host a.com] [B2: host b.com] ... [Bm: host z.com]
                 └────────────────────────────────────────────────────────┘
                                      │
                    min-heap keyed by each back-queue's next-allowed-fetch-time
                                      ▼
                              fetcher threads
```

- **Front queues (F of them):** one per priority band. A *prioritizer* scores each URL and drops it into the matching band. A biased selector pulls mostly from high-priority bands.
- **Back queues (B of them):** the invariant is **each back queue holds URLs for exactly one host**. A per-host mapping table routes URLs. A min-heap over "earliest next-fetch time" tells a fetcher which back queue is due next.

| Bank | Enforces | Key invariant |
|---|---|---|
| Front queues | Priority / freshness | Higher band → pulled more often |
| Back queues | Politeness | One host per queue; heap gates timing |

This cleanly decouples "what's important" (front) from "what's polite right now" (back).

---

### A8. Assigning priority before a URL is crawled

You have no PageRank for an uncrawled page, so you use **predictive signals** from the referring context and history:

```
priority(url) = w1 * source_page_pagerank      # who linked to it (best signal)
              + w2 * inlink_count               # how many known pages link to it
              + w3 * domain_authority           # authority of the host (eTLD+1)
              + w4 * (1 / url_depth)            # shallower = usually more important
              + w5 * freshness_urgency          # for re-crawl: overdue + high change rate
              - w6 * url_spam_score              # long query strings, many params → penalize
```

| Signal | Why it predicts value | Available pre-crawl? |
|---|---|---|
| Source page's PageRank | Important pages link to important pages | Yes (source already crawled) |
| In-link count | Many references → likely important | Yes |
| Domain authority | Reputable host → reputable page | Yes |
| URL depth (path segments) | Shallow ≈ navigational/important | Yes |
| URL structure / param count | Deep param spam ≈ low value | Yes |
| Historical change rate | Frequently-updated → re-crawl sooner | Only on re-crawl |

At least four independent signals: **source PageRank, in-link count, domain authority, URL depth.** Real crawlers approximate importance online with **OPIC** (Online Page Importance Computation, Abiteboul et al. 2003), which distributes "cash" across out-links during the crawl instead of waiting for a full PageRank pass.

---

### A9. Freshness scoring for re-crawl

Freshness scoring estimates **how likely a page has changed since we last saw it**, so we re-crawl pages that change often and skip ones that don't. The standard model treats changes as a **Poisson process** with a per-page change rate λ (changes per unit time).

```
Probability a page changed in time t since last crawl:
    P(changed) = 1 - e^(-λ * t)

λ is estimated from crawl history: if a page changed on c of the last n crawls,
    λ ≈ c / (n * avg_interval)

Re-crawl priority ∝ P(changed) * importance(page)
```

| Page type | Estimated λ | Re-crawl interval |
|---|---|---|
| News homepage | Very high | Minutes–hours |
| Product price page | High | Hours |
| Blog post | Low | Weeks |
| Archived doc / RFC | ~0 | 30+ days |

**Named tradeoff — Freshness vs Crawl Budget.** Re-crawling everything hourly maximizes freshness but wastes budget on static pages; a fixed long interval saves budget but serves stale results for news. The Poisson model spends budget proportional to *expected change × importance* (see A36 for the estimator).

---

### A10. [FAILURE MODE] Redis frontier: 50k ZADD/sec falling behind

**Diagnosis first.** Redis executes commands on a **single thread**, and `ZADD` on a sorted set is **O(log N)** per element. With a frontier of hundreds of millions of entries, log N is large and 50k ops/sec saturates that one core. Confirm before acting:

```
redis-cli INFO commandstats   # per-command cpu; look at cmdstat_zadd usec_per_call
redis-cli INFO cpu            # used_cpu_sys/user near one core's ceiling?
redis-cli --latency           # rising latency = command-queue backup
redis-cli INFO keyspace       # how big is the sorted set? (huge N → slow log N)
redis-cli SLOWLOG GET         # confirm ZADD/ZPOPMIN dominate
```

**Solutions, in order of leverage:**

| Fix | Mechanism | Tradeoff |
|---|---|---|
| **Shard the frontier by domain** | consistent-hash domains across M Redis instances; each does 50k/M | More instances to operate; matches politeness partitioning (A23) |
| **Pipeline / batch** | send ZADD in batches of 100s per round-trip | Reduces RTT overhead, not the O(log N) CPU |
| **Bound the sorted set** | keep only top-K in Redis; spill the tail to disk/Kafka | Cold URLs delayed |
| **Move to a log** | Kafka partitioned by domain for the bulk; Redis only for the hot priority slice | Loses O(log N) global ordering; ordering becomes per-partition |

The **root fix is sharding by domain** — it also aligns the frontier with the per-worker politeness model, so it is not just a scaling patch but an architectural correction.

---

### A11. PageRank in crawl priority, and the bootstrapping problem

PageRank measures a page's importance from the **link graph** — but you can't compute it for a URL you haven't crawled, because you don't yet know its out-links or the full graph. That's the **bootstrapping problem**: PageRank needs the graph, the graph needs crawling, crawling needs priority, priority wants PageRank.

**How it's resolved:**

```
1. Use in-link count as a cheap proxy for the uncrawled URL:
   "how many already-crawled pages point to this URL?" — high in-degree ≈ high importance.

2. Use the SOURCE page's PageRank: inherit priority from who links to you.
   A link from a PR-9 homepage > a link from a PR-1 spam page.

3. Use historical PageRank from the PREVIOUS crawl for known URLs (re-crawl case).

4. Approximate importance online with OPIC — distribute "cash" over out-links as you
   crawl, converging toward importance without a global matrix computation.
```

| Approach | Needs full graph? | Quality |
|---|---|---|
| True PageRank | Yes (iterative on whole graph) | Best, but offline/batch |
| In-link count | No (partial graph) | Good cheap proxy |
| Source-page PR inheritance | No | Good for new URLs |
| OPIC (online) | No | Converges during crawl |

So: you **cannot** use true PageRank for uncrawled URLs, but you can use **in-link count and inherited source PageRank** as live proxies, and recompute true PageRank in batch after each crawl to feed the next one.

---

## Level 3 — Deduplication

### A12. Checking "seen before" across 5 trillion URLs

A naive hash set is impossible: 5 trillion 64-bit fingerprints = 5e12 × 8 bytes = **40 TB of RAM** just for the hashes. The answer is a **Bloom filter** (probabilistic membership) fronting a **durable exact set** (e.g., a Bigtable/Spanner row per URL hash).

```
membership check (two tiers):
   if bloom.contains(url_hash) == false:   # definitely new (no false negatives)
        crawl it; then bloom.add + durable_set.put
   else:                                    # probably seen — verify to catch false positive
        if durable_set.contains(url_hash):  # exact confirm (only on the ~0.1% FP set)
             skip
        else:
             crawl it   # was a Bloom false positive
```

| Structure | Memory for 5T URLs | False negative? | False positive? |
|---|---|---|---|
| Exact hash set (in RAM) | ~40 TB | No | No |
| Bloom filter (0.1% FP) | ~9 TB (see A13) | **No** | Yes (~0.1%) |
| Bloom + durable exact set | ~9 TB RAM + disk | No | Resolved by exact check |

The **Bloom filter's defining property**: no false negatives (if it says "new," it is truly new) but tunable false positives (it may say "seen" for something new). That asymmetry is exactly what we want here — see A14.

---

### A13. Bloom filter math for 5 trillion URLs at 0.1% FP

The three formulas (n = elements, m = bits, k = hash functions, p = false-positive rate):

```
Optimal bits per element:  m/n = -ln(p) / (ln 2)^2
Optimal hash functions:    k   = (m/n) * ln 2
False-positive rate:       p   = (1 - e^(-k*n/m))^k
```

**Plug in p = 0.001 (0.1%):**

```
m/n = -ln(0.001) / (ln 2)^2
    = 6.9078 / 0.4805
    = 14.38 bits per URL

Total bits  m = 5e12 × 14.38  = 7.19e13 bits
Total bytes   = 7.19e13 / 8   = 8.99e12 bytes  ≈ 9 TB

k = 14.38 × ln 2 = 14.38 × 0.6931 ≈ 9.97  → 10 hash functions
```

**So: ~9 TB of RAM and ~10 hash functions for 0.1% FP.**

| Target FP rate | Bits/URL | Hash funcs k | Total (5T URLs) |
|---|---|---|---|
| 1% | 9.59 | 7 | ~6.0 TB |
| ~0.8% | 10.0 | 7 | ~6.25 TB |
| **0.1%** | **14.38** | **10** | **~9 TB** |
| 0.01% | 19.17 | 13 | ~12 TB |

Note: the README's "10 bits/entry = 6.25 TB" figure corresponds to a **~0.8% FP rate**, not 0.1% — at a true 0.1% you need ~14.4 bits/entry (~9 TB). Either way it exceeds one machine, so the filter is **sharded** (by URL-hash prefix) across nodes. Using ~10 independent hashes is usually done via **double hashing**: `h_i = h1 + i*h2 mod m` from two base hashes.

---

### A14. Cost of a false positive vs false negative in URL dedup

```
FALSE POSITIVE: filter says "seen" but URL is actually new
   → we SKIP a real page → a page never gets crawled → a gap in the index
   → cost: lost coverage (bounded — ~0.1% of URLs)

FALSE NEGATIVE: filter says "new" but URL was already seen
   → we RE-CRAWL a duplicate → wasted fetch + storage + politeness budget
   → cost: wasted work (not correctness)
```

| | False Positive | False Negative |
|---|---|---|
| Effect | Skip a real, uncrawled page | Re-crawl an already-seen page |
| Damage | Missing content (coverage gap) | Wasted budget (efficiency loss) |
| Bloom filter | **Possible** (tunable rate) | **Impossible** (by construction) |

**Which is more dangerous?** For a crawler, a **false positive is more dangerous** — it silently drops content from the index (a correctness/coverage problem you can't detect after the fact), whereas a false negative just wastes a fetch. That is *why* Bloom filters fit: they guarantee zero false negatives and let you push the false-positive rate as low as budget allows — and you can eliminate the residual with the durable exact-set check (A12).

---

### A15. [FAILURE MODE] Same content, different URLs — detecting without fetching

`http://www.example.com/page` and `https://example.com/page?utm_source=google` are the same resource dressed up differently. You catch this **before fetching** with **URL normalization (canonicalization)** — reduce every URL to a canonical form, then dedup on that.

```
canonicalize("https://example.com/page?utm_source=google"):
  1. lowercase scheme + host           → https://example.com/page?utm_source=google
  2. drop default port                 → (none here)
  3. strip tracking params (utm_*, fbclid, gclid, sessionid)
                                       → https://example.com/page
  4. resolve ./ and ../, decode %7E→~  → https://example.com/page
  5. sort remaining query params       → (none left)
  6. remove fragment (#...)            → https://example.com/page
  7. collapse www / apply known aliases→ https://example.com/page
  8. treat http/https as same resource for dedup key

canonicalize("http://www.example.com/page")  → https://example.com/page   ← SAME KEY
```

Both collapse to one canonical key, so the second one is caught by the seen-set as a duplicate **without a fetch**.

| Layer | Catches | Requires fetch? |
|---|---|---|
| URL normalization | Cosmetic URL variants (params, www, scheme) | No |
| `rel="canonical"` tag | Site's declared canonical | Yes (must fetch) |
| Content checksum / SimHash | Genuinely different URLs, identical body | Yes |

Normalization handles the *URL-level* duplicate for free; content dedup (A16) handles the case where different canonical URLs still serve identical bytes.

---

### A16. Near-duplicate content detection — SimHash

After fetching, a page may be **near-identical** to one seen last week (same article, different site, minor edits). Exact checksums (MD5/SHA of the body) only catch **byte-identical** duplicates — a one-character change defeats them. Near-duplicate detection uses **SimHash** (Charikar 2002; applied to web crawling by Manku et al., Google, 2007) or **MinHash/shingling**.

**How SimHash works (locality-sensitive — similar docs → similar fingerprints):**

```
1. Tokenize the doc into features (words or k-word "shingles"), each with a weight
   (e.g., tf-idf).
2. Hash each feature to a b-bit value (b = 64 typical).
3. Maintain a vector V[0..63] initialized to 0. For each feature's hash:
      for each bit position i:
          if bit i is 1:  V[i] += weight
          else:           V[i] -= weight
4. Fingerprint: for each i, output bit 1 if V[i] > 0 else 0  →  a 64-bit signature.
5. Two docs are near-duplicates if Hamming distance(sig_a, sig_b) is small
   (Google used ≤ 3 bits out of 64).
```

The magic: flipping a few words barely moves the weighted sums, so the fingerprint changes in **few bits** — Hamming distance is a proxy for similarity.

| Method | Detects | Signature | Comparison |
|---|---|---|---|
| MD5/SHA checksum | Byte-identical only | 128/256-bit | Equality |
| **SimHash** | Near-duplicate (few edits) | 64-bit | Hamming distance ≤ k |
| MinHash + shingling | Jaccard set similarity | Set of min-hashes | Estimated overlap |

To find near-duplicates among billions without O(n²) comparison, SimHash fingerprints are indexed by **permuted bit-prefix blocks** so candidates within Hamming distance k share a block — a documented Google technique.

---

### A17. URL normalization — five required normalizations

**URL normalization** rewrites a URL into a single canonical form so that syntactically different URLs pointing to the same resource dedup to one key. Five that a production crawler must apply:

```
1. Scheme + host lowercasing:   HTTP://Example.COM/  → http://example.com/
2. Default-port removal:        http://x.com:80/     → http://x.com/
                                https://x.com:443/   → https://x.com/
3. Path normalization:          /a/./b/../c          → /a/c
                                percent-decode unreserved: %7E → ~
4. Query cleanup:               strip tracking params (utm_*, gclid, fbclid);
                                sort remaining params alphabetically
5. Fragment removal:            /page#section        → /page   (fragments are client-side)
```

| Normalization | Example in → out | Why |
|---|---|---|
| Lowercase host | `EXAMPLE.com` → `example.com` | Host is case-insensitive (DNS) |
| Default port | `:80`, `:443` removed | Same endpoint |
| Path `.`/`..` | `/a/../b` → `/b` | Same file |
| Strip tracking + sort params | `?b=2&a=1&utm=x` → `?a=1&b=2` | Params reorder freely; trackers don't change content |
| Drop fragment | `#top` removed | Not sent to server |

**Caution (accuracy):** path is **case-sensitive** on most servers (`/Page` ≠ `/page`) — do **not** lowercase the path, only the scheme and host. Over-normalizing (e.g., stripping a param that *is* significant, like `?id=`) causes **false merges** — two distinct pages collapsed into one. Normalization rules must be conservative and per-domain-tunable.

---

## Level 4 — Politeness & robots.txt

### A18. What crawl politeness means, and why the operator cares

**Politeness** = limiting how hard you hit any single server: obey `robots.txt`, cap requests-per-host (e.g., ≤1 req/domain/sec), honor `Crawl-delay`/`Retry-After`, identify yourself with a real `User-Agent`, and back off on errors.

It matters to the **crawled server** (an unthrottled crawler is a self-inflicted DoS on a small site). But — the interviewer's point — it matters even more to **the crawler operator**:

```
Consequences of impoliteness to the OPERATOR:
  1. IP/subnet bans        → your crawler is blocked; coverage drops
  2. robots.txt blacklist  → sites add "Disallow: /" for your user-agent specifically
  3. Legal / abuse complaints → hosting providers complain to your provider (see A38)
  4. WAF / rate-limit walls → 429/503 storms waste your own budget on retries
  5. Reputation damage     → "GoogleBot" being blocked hurts the product
```

| Stakeholder | Why politeness matters |
|---|---|
| Crawled server | Avoids overload / accidental DoS |
| Crawler operator | Avoids bans, legal complaints, wasted retry budget, blacklisting |

So politeness is **self-interest**, not charity — an impolite crawler gets locked out of the very web it needs to index.

---

### A19. [FAILURE MODE] 429 with Retry-After: 60 — the back-off state machine

HTTP **429 Too Many Requests** with `Retry-After: 60` is an explicit "stop for 60 seconds." The correct behavior is a per-host back-off state machine:

```
STATES per host:
  NORMAL      → fetch at politeness rate (≤1 req/sec)
  BACKING_OFF → suspend all fetches to this host until `resume_at`
  PROBING     → after wait, send ONE request to test the water

on 429 (Retry-After: 60):
   1. STOP all in-flight scheduling for this host immediately
   2. resume_at = now + 60s  (honor Retry-After exactly)
   3. requeue the 429'd URL (don't drop it) with resume_at
   4. state = BACKING_OFF

after 60s → state = PROBING:
   5. send one request
      - 200  → state = NORMAL, but LOWER the rate (e.g., halve req/sec for a while)
      - 429  → EXPONENTIAL BACKOFF: resume_at = now + min(60*2^attempts, cap)
               (60s → 120s → 240s ... capped, e.g., at 1 hour)
```

| Signal | Action |
|---|---|
| `429 Retry-After: 60` | Halt host 60s, requeue URL, then probe |
| Repeated 429/503 | Exponential backoff with a cap; add jitter |
| `200` after probe | Resume at a *reduced* rate, ramp back slowly |
| Persistent 5xx | Deprioritize host; schedule far-future re-crawl |

Two subtleties: **honor `Retry-After` literally** (don't retry early), and **don't drop the URL** — requeue it so the page isn't lost. Add jitter so 500 workers don't all resume at the same instant (thundering herd on the host).

---

### A20. [FAILURE MODE] robots.txt cache TTL and 304 Not Modified

Caching `robots.txt` **indefinitely** is the bug: the site later adds `Disallow: /private/`, and your stale cache keeps you crawling forbidden paths for months — an abuse complaint waiting to happen.

**Correct TTL: ~24 hours.** RFC 9309 (§2.4) says caching **SHOULD generally not exceed 24 hours**; Google refetches robots.txt roughly daily. So:

```
robots cache entry = { rules, fetched_at, etag, last_modified }
TTL = 24h (or the max-age from Cache-Control if the site sets a shorter one)

on TTL expiry → conditional refetch:
   GET /robots.txt
     If-None-Match: "<etag>"
     If-Modified-Since: <last_modified>
```

**On `304 Not Modified`:** the file hasn't changed — **keep the cached rules but reset the TTL** (refresh `fetched_at`). The 304 costs almost nothing (no body transferred) yet re-validates freshness. This is the whole point of conditional requests: cheap validation without re-downloading.

| Response to conditional refetch | Action |
|---|---|
| `200` + new body | Replace rules, reset TTL, store new ETag |
| `304 Not Modified` | Keep rules, **reset TTL**, no body downloaded |
| `5xx` | Keep last-good rules (grace window), retry sooner |
| `404` | Now no restrictions → allow all, reset TTL |

**Named tradeoff — Freshness vs Fetch Overhead.** Longer TTL = fewer robots fetches but staler rules (risk of crawling newly-forbidden paths); 24h + conditional GETs is the industry balance, giving near-zero overhead (304s) with at-most-one-day staleness.

---

### A21. Per-domain rate limiting across 500 workers

The hard part: 500 workers must collectively send **≤1 req/sec to nytimes.com**, but there is no shared clock. Two designs:

**Design A — Partition by domain (preferred).** Consistent-hash the domain so **all `nytimes.com` URLs go to exactly one worker** (see A23). That worker owns the domain's rate limiter locally — no coordination needed.

```
worker_id = consistent_hash(registrable_domain(url)) % num_workers
# every nytimes.com URL → worker 17 → single local token-bucket → trivially ≤1 req/sec
```

**Design B — Shared distributed limiter (if you can't partition).** A central store (Redis) holds a per-domain token bucket; every worker checks it before fetching.

```
allowed = redis.eval(token_bucket_lua, key="rl:nytimes.com", rate=1, burst=1)
# atomic check-and-decrement so two workers can't both pass
```

| Approach | Coordination | Politeness guarantee | Failure mode |
|---|---|---|---|
| **Partition by domain (A)** | None (local) | Exact — one owner | Owner crash loses that domain's state (see A25) |
| Shared limiter (B) | Every fetch hits Redis | Exact if atomic | Redis becomes hot-path bottleneck / SPOF |

**"What if two workers both decide to crawl nytimes.com at the same moment?"** In Design A this **cannot happen** — only worker 17 ever holds nytimes.com URLs. In Design B it's prevented by the **atomic** token-bucket check (Lua script / `INCR` with expiry). Partitioning by domain is why Google-scale crawlers hash by host: it makes politeness a **local, lock-free** property.

---

### A22. Crawl-delay vs your inherent politeness policy

Two knobs limit per-host rate:

- **`Crawl-delay`** (in robots.txt): the *site's* requested minimum seconds between requests. Non-standard; Bing/Yandex honor it, **Googlebot ignores it** (Google uses Search Console crawl-rate settings instead).
- **Inherent politeness policy**: *your* default cap (e.g., ≤1 req/sec/host), possibly adapted to the host's observed latency/capacity.

**Precedence: take the more conservative (larger delay) of the two — but cap extreme values.**

```
effective_delay = max(your_default_delay, crawl_delay_from_robots)
effective_delay = min(effective_delay, MAX_ALLOWED_DELAY)   # sanity cap
```

| Scenario | Effective behavior |
|---|---|
| `Crawl-delay: 0.5`, your default 1s | Use 1s (your policy is stricter) |
| `Crawl-delay: 10`, your default 1s | Use 10s (site is stricter — honor it) |
| **`Crawl-delay: 3600`** | Unreasonable — **cap it** and/or deprioritize the domain |

**`Crawl-delay: 3600` (1 hour)** means the site wants ≤24 pages/day. Honoring it literally could stall a large site forever and waste a worker slot. The pragmatic answer: **cap the delay** at a sane maximum (e.g., 30–60s) and **deprioritize** the domain (crawl only its most important pages), rather than either ignoring the site's wish or letting one hostile robots.txt freeze your throughput. This is why Google dropped `Crawl-delay` support — a single misconfigured value could cripple crawl coverage of a domain.

---

## Level 5 — Distributed Architecture

### A23. Assigning a URL to a worker via consistent hashing

Given `https://www.nytimes.com/sports/article-123` and 500 workers:

```
1. Extract the REGISTRABLE DOMAIN (eTLD+1), not the full host:
      www.nytimes.com  →  nytimes.com        (use the Public Suffix List)
   Why eTLD+1: sports.nytimes.com and www.nytimes.com share one server/politeness domain.

2. Hash it onto the consistent-hash ring:
      pos = murmur3("nytimes.com")

3. Walk clockwise to the next worker's virtual node:
      worker = ring.successor(pos)   →  e.g., worker 17

4. ALL nytimes.com URLs now route to worker 17 → it owns the domain's:
      - politeness rate limiter   (A21)
      - robots.txt cache          (A20)
      - DNS cache entry           (A26)
      - back-queue                (A7)
```

**Why consistent hashing and not `hash % 500`?** When a worker is added/removed, modulo remaps ~(N-1)/N of all domains → mass frontier reshuffle. Consistent hashing (with virtual nodes) moves only ~1/N of domains. **Why hash by domain, not by URL?** Hashing by URL would scatter one domain's pages across all 500 workers, making per-domain politeness a distributed-coordination nightmare. Hashing by **domain** keeps politeness, robots, and DNS **local to one worker** — the single most important distributed-crawler decision.

| Hash key | Politeness | robots/DNS cache | Load balance |
|---|---|---|---|
| Full URL | Distributed (hard) | Duplicated everywhere | Even |
| **eTLD+1 domain** | **Local (easy)** | **One owner, high hit rate** | Even with vnodes |

---

### A24. The URL dispatcher component

The **URL dispatcher** (a.k.a. frontier manager / URL router) sits between link extraction and the workers. It decides *which worker* gets each discovered URL and maintains global frontier bookkeeping.

```
INPUTS:   newly-extracted URLs (from parsers), worker health/membership (from gossip),
          the consistent-hash ring, per-domain state
PROCESS:  normalize → dedup-check (Bloom) → compute owner = ring.successor(hash(domain))
          → route URL to that worker's frontier shard
OUTPUTS:  URL enqueued on the correct worker's back-queue; ring updates on membership change
```

| Aspect | Detail |
|---|---|
| Inputs | Extracted URLs, worker membership, ring topology |
| Outputs | Routed URLs to per-worker frontier shards |
| State | Consistent-hash ring, dedup filter, per-domain owner map |

**Failure modes:**

```
1. Dispatcher is a SPOF → if it's a single node, its death halts routing.
   Fix: make it stateless + replicated behind a load balancer; ring state in a
        replicated store (or fully decentralized via gossip, no central dispatcher).
2. Stale ring after a worker joins/leaves → URLs routed to a dead/wrong worker.
   Fix: gossip ring updates; workers reject+forward misrouted URLs during transition.
3. Hot domain → one worker overloaded (e.g., a domain with billions of URLs).
   Fix: sub-partition a hot domain across a few workers (bounded), or cap its budget.
```

Many production designs make the dispatcher **decentralized** — each worker knows the ring and routes discovered URLs directly to the owning peer — eliminating the central SPOF.

---

### A25. [FAILURE MODE] Worker shard 17 crashes with 50k queued nytimes.com URLs

If shard 17 kept its frontier **only in memory**, those 50k URLs are gone and nytimes.com is unowned. Recovery depends on the frontier being **durable and replayable**, not in-memory-only.

```
Recovery strategy:
1. DURABILITY: the frontier must be backed by a persistent, partitioned log/store
   (Kafka topic partitioned by domain, or a WAL'd disk queue), NOT plain RAM.
   → the 50k URLs still exist in shard 17's partition after the crash.

2. FAILOVER: gossip detects shard 17 dead → the ring's next clockwise worker
   (or a standby) takes over nytimes.com's key range.

3. REPLAY: the new owner reads shard 17's durable partition from the last committed
   offset → rebuilds the back-queue with the 50k URLs. No re-crawl, no loss.

4. DEDUP IDEMPOTENCY: because dedup is checked against the durable seen-set, replaying
   any URLs that were fetched-but-not-committed just re-checks the Bloom/exact set —
   at worst a few duplicate fetches, never lost coverage.
```

| Design | On worker crash | Data loss? |
|---|---|---|
| In-memory frontier only | 50k URLs lost | **Yes** |
| Durable log partitioned by domain | New owner replays partition | **No** |
| Durable + checkpointed offsets | Replay from last checkpoint | No; minimal re-fetch |

**Named tradeoff — Throughput vs Durability.** An in-memory frontier is faster but loses state on crash; a durable log adds write latency but makes recovery a replay. At web scale the frontier **must** be durable — the standard is a partitioned log (Kafka-style) keyed by domain, so failover = reassign partition + replay from offset. The at-least-once replay yields at most a small number of duplicate fetches, which dedup absorbs idempotently.

---

### A26. DNS at 11,600 pages/sec — why naive resolution breaks

```
Target rate = 1e9 pages/day = 1e9 / 86,400 s ≈ 11,600 pages/sec.
Naive design: one DNS lookup per fetch → 11,600 DNS queries/sec.
```

Why that breaks: DNS resolution is typically **synchronous and high-latency** (10–200 ms per uncached lookup, sometimes seconds on cold/slow authoritative servers). At 11,600 blocking lookups/sec, threads stall waiting on DNS — historically DNS was *the* crawler bottleneck (noted in the Mercator paper, Heydon & Najork 1999). You also risk overwhelming your resolver and upstream DNS.

**The fix — aggressive caching + async resolution:**

```
Effective uncached lookup rate with caching:
   10M unique domains, and we crawl ~50B pages / 10M domains ≈ 5,000 pages per domain.
   → one lookup per domain amortizes over thousands of fetches.
   With TTL ~1 day: uncached lookups ≈ 10M domains / 86,400 s ≈ 116 lookups/sec.
   That's ~100x below the naive 11,600/sec.
```

| Technique | Effect |
|---|---|
| Per-worker DNS cache (respect TTL) | Turns most lookups into memory hits (domain partitioned to worker → high hit rate, A23) |
| Dedicated async resolver pool | Non-blocking; fetch threads never stall on DNS |
| Prefetch DNS when URL enters frontier | Resolve ahead of fetch time |
| Local caching resolver (e.g., Unbound) | Shared cache across workers; own the resolver capacity |

Because domains are partitioned to workers (A23), each worker's DNS cache sees the **same domains repeatedly** → very high hit rate. The naive 11,600/sec collapses to ~100/sec of real lookups.

---

### A27. DNS negative caching and its danger for a crawler

**Negative caching** = caching a *failure* response (notably `NXDOMAIN` — domain does not exist), so you don't re-query a name that just failed. The negative TTL comes from the domain's **SOA record** (minimum TTL field), per RFC 2308.

**Why it's dangerous for a crawler that constantly discovers new domains:**

```
Scenario:
  1. Crawler discovers brand-new-domain.com (just registered, DNS not yet propagated).
  2. Lookup returns NXDOMAIN (transient — propagation lag, or your resolver was slow).
  3. Negative cache stores NXDOMAIN with TTL = e.g. 3600s (or worse, days).
  4. For that whole TTL, the crawler believes the domain doesn't exist and SKIPS it,
     even though it's actually live → coverage gap.
```

| Cache type | Caches | Crawler risk |
|---|---|---|
| Positive (A/AAAA) | Successful IP resolution | Stale IP if server moves (bounded by TTL) |
| **Negative (NXDOMAIN)** | Resolution *failure* | **Skips a domain that actually exists** if failure was transient |

**Mitigations:** keep negative TTLs **short** (cap at, say, 60–300s regardless of SOA), **retry** transient failures a couple of times before caching the negative, and distinguish `NXDOMAIN` (real "doesn't exist") from `SERVFAIL`/timeout (transient — don't negatively cache aggressively). For a crawler, a false negative on domain existence is a silent coverage loss, so err toward re-querying.

---

## Level 6 — Content Processing

### A28. The content-processing pipeline after a 200 + HTML

```
HTTP 200 + HTML body arrives, then:

1. Content-type / size guard   → confirm text/html; reject if body > cap (e.g., 5 MB, SQ3)
2. Charset detection + decode  → bytes → Unicode (Content-Type charset, <meta>, BOM, sniff)
3. Store raw bytes             → write to blob storage as a WARC record (A32), keep the
                                 original for reproducibility BEFORE any transformation
4. Content dedup              → checksum (exact) + SimHash (near-dup, A16); if dup, link to
                                 existing doc and skip re-index
5. Parse to DOM               → tolerant HTML parser (real-world HTML is malformed)
6. Extract links              → <a href>, plus <link>, sometimes sitemap refs
7. Resolve relative → absolute → using base URL + <base href> (A29)
8. Extract directives         → <meta name="robots">, rel="canonical", rel="nofollow" (A30)
9. Extract main content/text  → boilerplate removal for the indexer
10. Normalize + dedup URLs    → canonicalize (A17), Bloom-check (A12)
11. Enqueue new URLs          → to frontier with priority (A8)
12. Emit for indexing         → parsed content + metadata to the index pipeline
13. Update re-crawl schedule  → record fetch time, ETag/Last-Modified, change signal (A33)
```

| Stage | Purpose | Failure guard |
|---|---|---|
| Size/type guard | Prevent resource-exhaustion attacks | Cap size, timeout (SQ3) |
| Charset decode | Correct text extraction | Fallback chain |
| Store-before-transform | Reproducibility | Raw WARC first |
| Content dedup | Avoid re-indexing dupes | Checksum + SimHash |
| Link extract + normalize | Feed frontier | Canonicalize + Bloom |

Key ordering principle: **store the raw bytes before transforming** — so any parser bug can be re-run against the original later.

---

### A29. Relative URLs and where naive resolution fails

HTML links are often relative (`href="../images/x.png"`); you resolve them against the page's base URL per **RFC 3986 §5**.

```
base = "https://example.com/blog/2024/post.html"
  href="../img.png"     → https://example.com/blog/img.png
  href="/about"         → https://example.com/about
  href="page2.html"     → https://example.com/blog/2024/page2.html
  href="//cdn.com/x.js" → https://cdn.com/x.js        (protocol-relative → inherit scheme)
```

**Where naive resolution fails — the `<base href>` tag.** If the page contains `<base href="https://othersite.com/app/">`, then **all** relative URLs resolve against *that* base, not the page's own URL. A crawler that ignores `<base>` computes every relative link wrong.

```
Page fetched from: https://example.com/blog/post.html
Page contains:     <base href="https://cdn.example.net/v2/">
  href="img.png"   →  naive:  https://example.com/blog/img.png     ❌ WRONG
                   →  correct: https://cdn.example.net/v2/img.png   ✅ (uses <base>)
```

| Relative form | Resolves to | Gotcha |
|---|---|---|
| `../x` , `./x` | Path-relative to base | Must honor `<base href>` if present |
| `/x` | Host root | Ignores current path |
| `//host/x` | Protocol-relative | Inherit page's scheme |
| `#frag` , `mailto:` , `javascript:` | Not crawlable | Must be filtered out |

Other traps: don't crawl `javascript:`, `mailto:`, `tel:`, or `data:` URIs; strip fragments; and handle percent-encoding consistently (A17).

---

### A30. [FAILURE MODE] `<meta name="robots" content="noindex, nofollow">`

This is a **page-level** directive (distinct from robots.txt, which is site-level). Two independent instructions:

```
noindex   → do NOT include this page in the search index
nofollow  → do NOT follow (enqueue) the links on this page
```

```
on parse:
  if "noindex" in meta_robots:  do_not_index(page); mark for removal if already indexed
  if "nofollow" in meta_robots: skip enqueuing this page's out-links
```

| Directive | Fetch? | Index? | Follow links? |
|---|---|---|---|
| (none) | Yes | Yes | Yes |
| `noindex` | Yes (must fetch to see it!) | **No** | Yes (unless also nofollow) |
| `nofollow` | Yes | Yes | **No** |
| `noindex, nofollow` | Yes | No | No |

Subtlety: you **must fetch** the page to read the meta tag (unlike robots.txt, which is checked before fetch) — so `noindex` doesn't save the fetch, only the indexing.

**"Page was indexed two days ago — do you retroactively remove it?"** **Yes.** `noindex` is authoritative and current: on the next crawl, seeing `noindex` must trigger **removal from the index** (or exclusion at the next index build). The site owner's current directive wins over stale indexed state — otherwise you'd serve results the owner explicitly asked you to drop (a compliance and quality problem). This is exactly why re-crawling exists: to reconcile the index with the page's current state.

---

### A31. Googlebot and JavaScript-rendered SPAs

**The challenge:** a React/Angular SPA ships a near-empty HTML shell (`<div id="root"></div>`) and builds the real content by executing JavaScript in the browser. A crawler that only reads the raw HTML sees **no content and no links** — the page looks empty.

**The solution — render the page like a browser (headless rendering):**

```
1. Fetch raw HTML (fast path). If it already has content/links, index it.
2. If content is JS-dependent, enqueue the URL for RENDERING.
3. A headless browser (Googlebot uses a Chromium-based "Web Rendering Service")
   loads the page, executes JS, waits for network/DOM to settle.
4. Extract content + links from the RENDERED DOM, not the raw HTML.
5. Index the rendered result; enqueue discovered links.
```

Google historically described this as **two waves / deferred rendering**: index the raw HTML immediately, then render later when compute is available (rendering can lag the initial crawl). Since 2019, Googlebot is **"evergreen"** — a current Chromium engine, kept up to date.

| Approach | Cost | Coverage of JS content |
|---|---|---|
| Raw-HTML only | Cheap | Misses SPA content |
| Headless render (Chromium) | **Very expensive** (CPU/RAM/time per page) | Full |
| Server-side rendering / prerendering (site-side) | Cheap for crawler | Requires site cooperation |
| Dynamic rendering (serve prerendered HTML to bots) | Site-side | Works, but extra site infra |

**Named tradeoff — Coverage vs Compute.** Rendering every page in a headless browser is orders of magnitude more expensive than parsing HTML, so crawlers **defer/ration** rendering by priority. The site-side mitigation is SSR/prerendering, which is why frameworks (Next.js, Angular Universal) exist — they make SPA content crawlable without forcing the crawler to render.

---

### A32. Storing 1B pages/day at 100 KB — the storage layer

```
Volume: 1e9 pages/day × 100 KB = 1e14 bytes/day = 100 TB/day (raw, uncompressed).
Write throughput: 100 TB / 86,400 s ≈ 1.16 GB/sec sustained ingest.
Yearly: ~36.5 PB/year raw.
```

**Design:**

| Decision | Choice | Why |
|---|---|---|
| Format | **WARC** (Web ARChive, ISO 28500) | Standard for archived HTTP responses (headers + body + metadata); used by Common Crawl & Internet Archive |
| Storage system | Object store (S3 / GCS; Google internally Colossus) | Cheap, durable (11 nines on S3), infinitely scalable, sequential-write friendly |
| Metadata index | Wide-column store (Bigtable / Cassandra) | Row per URL: fetch time, checksum, WARC offset, status |
| Compression | **gzip or zstd** per record/segment | HTML compresses ~4–6×; 100 KB → ~20 KB → ~20 TB/day stored |
| Batching | Aggregate pages into large WARC segments (100s of MB) | Object stores hate tiny objects; batch to amortize overhead |

```
Handling 1.16 GB/sec write:
  - Workers write locally, batch pages into large WARC segments, then bulk-PUT to the
    object store (large sequential writes, not 11,600 tiny PUTs/sec).
  - Parallelism: writes fan out across many prefixes/buckets to avoid hot partitions.
  - Metadata (offset pointers) written to Bigtable keyed by URL-hash for O(1) lookup.
```

Common Crawl is the public proof point: it publishes crawls as **WARC files on Amazon S3** (plus WAT metadata and WET extracted-text derivatives), on the order of billions of pages per monthly crawl. (Treat the exact per-crawl page count as approximate.)

**Named tradeoff — Compression Ratio vs CPU.** zstd gives better ratios and speed than gzip at tuned levels but costs CPU on the write path; at 1.16 GB/sec ingest, compression CPU is a real budget line — you tune the level to balance storage cost against crawler CPU.

---

## Level 7 — Re-crawl Strategy

### A33. When to re-crawl a page — signals

Re-crawl decisions balance **freshness** (don't serve stale results) against **budget** (don't waste fetches on unchanged pages). At least three signals:

```
1. Historical change rate (λ): how often did THIS page change on past crawls?
   → high λ (news) → short interval; λ≈0 (archived doc) → long interval.  (A9, A36)

2. Page importance / PageRank: high-value pages get re-crawled sooner even at equal λ
   → a stale homepage hurts more than a stale obscure page.

3. HTTP validators (ETag / Last-Modified): cheap conditional GET tells you IF it changed
   without a full fetch (A34) → drives the NEXT interval.

4. Content type / section signal: /news/, /blog/ churn; /docs/, /archive/ don't.

5. Sitemap <lastmod> / <changefreq>: the site's own declared update hints.

6. External change signals: pings, RSS/Atom feeds, PubSubHubbub-style push.
```

| Signal | Freshness value | Cost to obtain |
|---|---|---|
| Historical change rate | High (personalized per page) | Needs crawl history |
| PageRank / importance | High (prioritizes what matters) | From link graph |
| ETag/Last-Modified | Medium (binary changed/not) | 1 conditional GET |
| Sitemap lastmod | Medium (site-declared) | Cheap, but trust-dependent |

The production formula: **re-crawl priority ∝ P(changed since last crawl) × importance** — spend budget where change is likely *and* the page matters.

---

### A34. HTTP cache headers to avoid redundant fetches

Three headers let a crawler ask "did this change?" without downloading the body:

```
ETag: "abc123"                    → opaque version id of the content
Last-Modified: Wed, 01 Jan 2025…  → timestamp of last change
Cache-Control: max-age=3600       → how long the content is considered fresh
```

**Conditional GET** — the crawler sends the validators back; the server replies **304 Not Modified** (empty body) if nothing changed:

```
GET /article HTTP/1.1
If-None-Match: "abc123"
If-Modified-Since: Wed, 01 Jan 2025 10:00:00 GMT

→ 304 Not Modified   (no body!) → page unchanged → skip re-parse/re-index, save bandwidth
→ 200 + new body + new ETag     → changed → process normally
```

| Header | Sent back as | Server responds |
|---|---|---|
| `ETag` | `If-None-Match` | `304` if match, else `200`+body |
| `Last-Modified` | `If-Modified-Since` | `304` if not newer, else `200`+body |
| `Cache-Control: max-age` | (not echoed) | Hints when to even bother checking |

**Payoff:** for a 100 KB page that didn't change, a 304 transfers ~0 bytes of body instead of 100 KB. Across billions of mostly-unchanged pages, conditional GETs cut re-crawl **bandwidth and processing** dramatically, and the 304/200 outcome **feeds back into the change-rate estimate** (A36) to tune the next interval.

---

### A35. [FAILURE MODE] High-churn news site, 500 articles/hour, 24h interval → 18h stale

**Root cause:** a **single fixed re-crawl interval** applied to a domain whose change rate is wildly higher than the default. A 24h interval on a site publishing 500 articles/hour guarantees breaking news is up to ~24h stale. The scheduler is using the wrong model (uniform interval) for a high-λ domain.

**Redesign — adaptive, per-URL, change-rate-driven scheduling:**

```
1. Per-URL (not per-domain) intervals from historical λ:
   interval(url) = clamp( target_staleness / P(change), MIN_INTERVAL, MAX_INTERVAL )
   → news article pages get MINUTES, the site's static /about gets days.

2. Discover new URLs fast via push/pull change signals:
   - Poll the site's RSS/Atom feed and XML sitemap <lastmod> frequently (cheap).
   - Support push (sitemap pings / hub notifications) so new articles are known instantly.

3. Tiered freshness classes:
   TIER-0 (breaking news): re-check homepage/section pages every 1-5 min.
   TIER-1 (fresh articles): minutes-to-hours, decaying as the article ages.
   TIER-2 (archive): days.

4. Budget guardrail: cap the domain's re-crawl QPS so freshness doesn't violate politeness.
```

| Model | News freshness | Budget efficiency |
|---|---|---|
| Fixed 24h interval | ~18–24h stale ❌ | Wastes fetches on static pages |
| Per-URL adaptive (λ-driven) | Minutes ✅ | Spends budget where change happens |
| Feed/sitemap-driven discovery | Near-real-time for new URLs | Very cheap (poll one small file) |

The key shift: from **domain-uniform time-based** scheduling to **per-URL change-probability-driven** scheduling, plus **feed/sitemap polling** so new articles are discovered in minutes, not on the next 24h sweep. This is how search engines surface breaking news quickly.

---

### A36. The "history of change" model and interval derivation

Model each page's changes as a **Poisson process** with rate λ (expected changes per unit time), estimated from crawl history.

**"Changed on 3 of the last 10 crawls":**

```
Naive estimate: change probability per interval ≈ 3/10 = 0.30

But the crawl UNDERSAMPLES: if a page changed twice between two crawls, you only
observe "changed once." So the observed frequency is a LOWER BOUND on the true λ.
A better estimator (Cho & Garcia-Molina, 2003) corrects this bias:

   λ̂ ≈ -ln(1 - X/n) / interval        (X = # observed changes, n = # crawls)
   with X=3, n=10:  -ln(1 - 0.3) = -ln(0.7) ≈ 0.357 changes per interval
   → the true rate is slightly higher than the naive 0.30.
```

**Translating λ to a re-crawl interval** — pick an interval that keeps expected staleness (or P(changed)) at a target:

```
Want P(changed) ≤ 0.5 between crawls:  1 - e^(-λt) ≤ 0.5  →  t ≤ ln(2)/λ
   With λ̂ ≈ 0.357 per old-interval → t ≈ 0.693/0.357 ≈ 1.94 old-intervals.
Want fresher (P ≤ 0.2):  t ≤ -ln(0.8)/λ ≈ 0.223/0.357 ≈ 0.63 old-intervals (crawl MORE often).
```

| Observed changes (of 10) | Rough λ (per interval) | Relative re-crawl frequency |
|---|---|---|
| 0/10 | ~0 | Rare (stretch interval toward MAX) |
| 3/10 | ~0.36 | Moderate |
| 8/10 | ~1.6 | Frequent (shorten interval) |
| 10/10 | high (undersampled) | Very frequent |

**Named tradeoff — Freshness vs Budget, again.** Shorter intervals catch changes sooner but cost fetches; the Poisson model sets each page's interval so budget is proportional to *expected change × importance*. The estimator bias (undersampling) means you should **crawl frequently-changing pages even more often than the naive frequency suggests** — the true λ is under-observed.

---

## Level 8 — Architect-Level

### A37. Full architecture for 11,600 pages/sec (10-minute whiteboard)

```
                         ┌──────────────┐
   seeds ───────────────►│ URL FRONTIER │◄──────────── new URLs (deduped, prioritized)
                         │ front queues │
                         │  (priority)  │
                         │ back queues  │
                         │ (per-host)   │
                         └──────┬───────┘
                                │ dispatch by consistent-hash(domain)
                ┌───────────────┼───────────────┐
                ▼               ▼                ▼
          ┌─────────┐     ┌─────────┐     ┌─────────┐
          │ WORKER1 │     │ WORKER17│ ... │WORKER500│      (partitioned by domain)
          │ fetcher │     │ fetcher │     │ fetcher │
          └────┬────┘     └────┬────┘     └────┬────┘
               │ per-worker: DNS cache, robots cache, rate limiter (all LOCAL)
               ▼
          ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
          │ DNS resolver │   │ robots.txt   │   │ politeness   │
          │  pool+cache  │   │ cache (24h)  │   │ token bucket │
          └──────────────┘   └──────────────┘   └──────────────┘
               │ HTTP GET
               ▼
          ┌──────────────┐   store raw    ┌───────────────────┐
          │ HTTP fetcher │──────────────► │ BLOB STORE (WARC) │  (S3/GCS/Colossus)
          └──────┬───────┘                └───────────────────┘
                 │ 200 + HTML
                 ▼
          ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
          │  PARSER      │──►│ CONTENT DEDUP│──►│ RENDER QUEUE │ (headless Chromium
          │ link extract │   │ checksum+    │   │ for JS pages │  for SPAs)
          └──────┬───────┘   │ SimHash      │   └──────────────┘
                 │           └──────────────┘
                 ▼ new URLs
          ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
          │ URL NORMALIZE│──►│ DEDUP: Bloom │──►│ back to       │
          │ (canonical)  │   │ + durable set│   │ FRONTIER      │
          └──────────────┘   └──────────────┘   └──────────────┘
                 │
                 ▼ parsed content + metadata
          ┌──────────────┐   ┌──────────────┐
          │ METADATA (Bigtable/Cassandra): │  ┌──────────────┐
          │ url→{fetch_time, etag,          │─►│ INDEXER      │
          │ checksum, warc_offset, λ}       │  │ (downstream) │
          └────────────────────────────────┘  └──────────────┘
          RE-CRAWL SCHEDULER reads metadata → re-injects URLs by P(change)×importance
```

| Component | Technology | Why |
|---|---|---|
| URL frontier | Redis (hot slice) + Kafka/disk (bulk), partitioned by domain | Priority + politeness + durability (A7, A25) |
| Dispatcher | Consistent-hash ring (murmur3), decentralized | 1/N remap on membership change (A23) |
| Workers | 500 fetcher machines, domain-partitioned | Local politeness/DNS/robots (A21, A26) |
| DNS | Async resolver pool + per-worker cache | ~116 real lookups/sec after caching (A26) |
| Dedup | Bloom filter (~9 TB, sharded) + Bigtable exact set | No false negatives (A12–A14) |
| Content dedup | Checksum + SimHash (Hamming ≤ 3) | Near-duplicate detection (A16) |
| Blob store | WARC on S3/GCS/Colossus, zstd | 100 TB/day, 11-nines durable (A32) |
| Metadata | Bigtable / Cassandra | O(1) per-URL lookup, re-crawl state |
| Rendering | Headless Chromium pool (rationed) | SPA/JS pages (A31) |
| Re-crawl scheduler | Poisson λ × importance | Freshness vs budget (A33, A36) |

Talking track: **frontier is the brain; consistent-hash-by-domain makes politeness/DNS/robots local; Bloom+durable set handles 5T-URL dedup; WARC on object storage absorbs 100 TB/day; re-crawl is change-probability-driven.**

---

### A38. [FAILURE MODE] Accidental DDoS on 200 small sites from one seed page

**Root cause:** one high-priority seed page links to 200 small sites. BFS extracts all 200 links at once, and — if politeness is only enforced *per your worker* or not at all — 200 near-simultaneous requests hit 200 fragile hosts. Even at 1 req/host, 200 small shared-hosting sites getting hit together (and their linked pages fanning out) can look like a coordinated flood, especially if several share one hosting provider / IP.

**Three layers of safeguards:**

```
LAYER 1 — Per-domain politeness, enforced globally (not per-worker):
   Partition each domain to ONE worker (A23) with a token bucket ≤ 1 req/sec/host.
   → No domain ever receives more than the cap, no matter how many links point to it.

LAYER 2 — Per-IP / per-hosting-provider throttling (the missing layer here):
   Many small sites share ONE server IP (shared hosting). Politeness by DOMAIN misses this.
   Resolve domains to IPs and rate-limit per /24 subnet or per hosting IP, so 50 domains on
   one shared host don't collectively overwhelm that one physical server.

LAYER 3 — Global + adaptive back-pressure:
   - Cap total concurrent requests and ramp-up (don't fire all 200 at t=0; stagger).
   - Adaptive politeness: watch each host's latency/error rate; if a small site slows down
     or returns 5xx/429, automatically back off (A19) and lower its rate.
   - Crawl-rate budget per hosting ASN; honor abuse-contact/robots signals promptly.
```

| Layer | Prevents | The gap it closes |
|---|---|---|
| Per-domain limiter | One domain overloaded | Baseline politeness |
| **Per-IP / per-subnet limiter** | Shared-host overload | Many domains, one server |
| Adaptive back-pressure + staggering | Simultaneous burst | Reacts to real-time distress |

**The key insight** the interviewer wants: **per-domain politeness is not enough** — small sites share IPs, so you also need **per-IP/per-provider throttling** plus **adaptive back-off** that reacts to the servers' distress signals. Politeness must be enforced at the domain, IP, *and* provider level.

---

## Bonus — Unprompted Senior Questions

### ASQ1. Bloom filter false positives = 5 billion skipped pages — acceptable?

Framing the tradeoff quantitatively: at 0.1% FP over 5T URLs, ~5 billion real pages could be wrongly marked "seen" and skipped.

```
5e12 URLs × 0.001 FP rate = 5e9 URLs potentially skipped (coverage loss).
```

| Option | Coverage | Cost |
|---|---|---|
| Accept 0.1% FP | Lose ~5B pages | Cheapest; ~9 TB Bloom |
| Lower FP to 0.01% | Lose ~500M | ~12 TB Bloom (more RAM) |
| **Bloom + secondary exact check** | Lose ~0 | Bloom RAM + one Bigtable/Spanner lookup on the ~0.1% "seen" hits |

**Recommendation:** the exact-check fallback (A12). The Bloom filter answers 99.9% of queries from RAM; only the ~0.1% it flags as "seen" pay a durable-store lookup to confirm — turning a *coverage* problem into a small, bounded *latency* cost on a tiny fraction of checks. That converts "5 billion silently skipped pages" into "5 billion exact lookups," which is a far better business tradeoff.

---

### ASQ2. Crawl budget management — not every URL is worth the same

The risk: 80% of budget burned on low-value parameter-spam pages (faceted e-commerce, calendars) while high-PageRank deep pages starve.

```
per-domain crawl budget (proportional to authority):
   budget(domain) = base × authority_score(domain)        # pages/domain/day
   spend the budget by URL priority (A8), not discovery order:
     - high in-link / high source-PageRank URLs first
     - penalize URLs with many query params / deep param templates (spam signal)
     - allow deep-but-high-value pages (10 hops but high in-degree) to jump the queue
```

| Policy | Effect |
|---|---|
| No budget | Traps/param-spam consume everything |
| Flat budget/domain | Fair but ignores authority |
| **Authority-weighted budget + priority spend** | High-value coverage, spam starved |

**Recommendation:** cap pages/domain/day proportional to domain authority, and *within* that cap spend by URL priority — so a high-PageRank page 10 hops deep still gets crawled, while a million near-identical `?sort=` permutations do not. Budget by *value*, not by *discovery order*.

---

### ASQ3. Security surface — malicious/crafted responses

A hostile site can weaponize the parser: gigabyte responses, billion-laughs-style nested DOM, decompression bombs, redirect loops, meta-refresh chains.

```
Hardening controls:
  1. Response size cap:      abort download past N MB (e.g., 5 MB) — stops giant bodies.
  2. Parse timeout:          max 1-2 s per page — stops pathological DOM parsing.
  3. Decompression bomb guard: cap DECOMPRESSED size + compression ratio (e.g., ≤ 100:1).
  4. Redirect limit:         follow ≤ 5 redirects; detect cycles.
  5. Sandbox the parser:     isolated process / cgroup memory limit; crash ≠ crawler crash.
  6. Content-type allowlist: only parse text/html; treat others as opaque blobs.
  7. SSRF guard:             refuse to fetch internal/private IP ranges (169.254.x, 10.x,
                             127.x) — a crawler is a request-forger's dream if unguarded.
```

| Threat | Control |
|---|---|
| Huge body / OOM | Size cap (5 MB) |
| Nested-DOM CPU bomb | Parse timeout + depth limit |
| Decompression bomb | Ratio + absolute-size cap |
| Redirect loop | Max-hops + cycle detection |
| Parser exploit | Sandboxed, memory-capped process |
| SSRF to internal services | Private-IP-range block |

**Recommendation:** treat every response as hostile. Size caps, parse timeouts, decompression-ratio limits, redirect caps, a sandboxed parser, and an SSRF guard turn "a malicious page crashes the crawler" into "a malicious page wastes one bounded fetch." Naming the **SSRF** risk unprompted is a strong staff-level signal.

---

## Decision Guide — Quick Reference

### Which dedup layer for which duplicate?

| Duplicate type | Layer | Fetch needed? |
|---|---|---|
| Cosmetic URL variant (utm, www, scheme) | URL normalization | No |
| Same bytes, different URL | Content checksum | Yes |
| Near-identical content (minor edits) | SimHash (Hamming ≤ 3) | Yes |
| "Have I seen this URL ever?" | Bloom filter + durable set | No |

### Which re-crawl interval?

| Page | Signal | Interval |
|---|---|---|
| Breaking-news section | λ very high + feed/sitemap | 1–5 min |
| Fresh article | λ high, decaying with age | Hours |
| Blog post | λ low | Weeks |
| Archived doc | λ ≈ 0 | 30+ days |

### Politeness enforcement layers

| Layer | Limit | Catches |
|---|---|---|
| Per-domain | ≤1 req/sec/host | One domain overload |
| Per-IP / subnet | per shared server | Many domains, one host |
| Per-provider/ASN | budget per hosting | Provider-wide flood |
| Adaptive | react to 429/5xx/latency | Real-time distress |

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Crawl loop | Dequeue → resolve → robots → fetch → store → parse → extract → normalize → dedup → enqueue |
| BFS vs DFS | BFS: importance ∝ shallowness + host spread; DFS dies on spider traps |
| Frontier | Not a FIFO — encodes priority (front queues) + politeness (back queues, 1 host each) |
| Mercator two-level | Front = prioritization; back = politeness (one host per back-queue, min-heap on next-fetch-time) |
| Priority signals | Source PageRank, in-link count, domain authority, URL depth (OPIC approximates online) |
| Freshness model | Poisson: P(changed) = 1 − e^(−λt); re-crawl ∝ P(change) × importance |
| Dedup at 5T URLs | Bloom filter (no false negatives!) + durable exact set for the ~0.1% hits |
| Bloom math 0.1% | m/n = −ln(p)/(ln2)² ≈ 14.4 bits/URL; k = (m/n)·ln2 ≈ 10; ~9 TB for 5T |
| FP vs FN | FP = skip real page (coverage loss, worse); FN impossible in Bloom |
| URL normalization | Lowercase scheme+host (not path!), drop default port, strip trackers, sort params, drop fragment |
| Near-dup detection | SimHash: weighted-bit fingerprint; near-dup if Hamming distance ≤ 3 of 64 |
| robots.txt unreachable | 404 = allow all; 5xx/429 = disallow all (conservative); RFC 9309 |
| robots.txt TTL | ~24h (RFC 9309); 304 Not Modified → keep rules, reset TTL |
| Crawl-delay | Non-standard; Google ignores it; take max(yours, robots) but cap extreme values |
| 429 Retry-After | Halt host for the stated seconds, requeue URL, probe, then exponential backoff + jitter |
| Consistent hash by domain | Hash eTLD+1 → one worker owns politeness/DNS/robots locally; 1/N remap on change |
| Worker crash recovery | Durable log partitioned by domain → new owner replays offset → no loss (at-least-once) |
| DNS at scale | Naive 11,600/sec blocks; cache per worker → ~116 real lookups/sec; async resolver pool |
| DNS negative caching | Caching NXDOMAIN can skip a real new domain; keep negative TTL short, retry transient |
| meta robots | noindex = don't index (retroactively remove); nofollow = don't enqueue links; must fetch to see |
| JS/SPA rendering | Headless Chromium (evergreen Googlebot); expensive → deferred/rationed; SSR is the site-side fix |
| Storage 100 TB/day | WARC on object store (S3/GCS/Colossus), zstd, batched large segments; Bigtable metadata |
| Re-crawl estimator | Cho–Garcia-Molina: λ̂ ≈ −ln(1−X/n)/interval; undersampling → crawl churny pages even more |
| Crawl budget | Cap pages/domain/day ∝ authority; spend by priority, starve param-spam |
| Accidental DDoS fix | Per-domain + per-IP/subnet + per-provider limits + adaptive back-off (shared hosting gap) |
| Parser security | Size cap 5 MB, parse timeout, decompression-ratio cap, redirect cap, sandbox, SSRF guard |
| Real systems | Googlebot (evergreen Chromium), Common Crawl (WARC on S3), Mercator (frontier design) |
