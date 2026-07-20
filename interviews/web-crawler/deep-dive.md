# Deep Dive: Distributed Web Crawler

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> Vendor-neutral. Real systems referenced as examples: Googlebot, Common Crawl,
> the Internet Archive, and the Mercator research crawler. Capacity figures are
> **derived from stated targets** (1B pages/day ≈ 11,600 pages/sec) and are
> **labeled illustrative** where they are estimates rather than measured facts.

---

## Table of Contents

1. [The Crawl Loop and BFS vs DFS](#1-the-crawl-loop-and-bfs-vs-dfs)
2. [The URL Frontier: Priority Meets Politeness](#2-the-url-frontier-priority-meets-politeness)
3. [URL Deduplication with Bloom Filters](#3-url-deduplication-with-bloom-filters)
4. [Near-Duplicate Content: SimHash and Shingling](#4-near-duplicate-content-simhash-and-shingling)
5. [robots.txt and Politeness](#5-robotstxt-and-politeness)
6. [Distributing Work: Consistent Hashing by Domain](#6-distributing-work-consistent-hashing-by-domain)
7. [DNS at Crawl Scale](#7-dns-at-crawl-scale)
8. [Crawler Traps and Crawl Budget](#8-crawler-traps-and-crawl-budget)
9. [Content Processing and Blob Storage](#9-content-processing-and-blob-storage)
10. [Re-Crawl Freshness Scheduling](#10-re-crawl-freshness-scheduling)
11. [Full Architecture and Failure Modes](#11-full-architecture-and-failure-modes)
12. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Crawl Loop and BFS vs DFS

### 🟢 Beginner — Exploring a City by Handing Out Flyers

Imagine you want to visit every shop in a city, starting from one street corner. You
write down the addresses of every shop you can see from where you stand, then visit the
*nearest* ones first. At each shop, you jot down any new addresses posted in the window,
add them to the bottom of your list, and keep going.

You never revisit a shop you have already been to (you keep a checklist), you never knock
so often that a shopkeeper gets annoyed (politeness), and you note which shops change
their window display often so you can come back to those sooner (freshness). That is a web
crawler: a patient visitor working a to-do list, discovering new places as it goes.

The important instinct: visit **breadth-first** (nearby, important shops first), not
**depth-first** (following one alley as far as it goes before looking around), because
the alley might be an endless maze.

---

### 🟡 Senior — The Crawl Loop as a Pipeline

Every crawler is BFS over the web graph. Each iteration pulls one URL, fetches it,
extracts links, and feeds the *new* URLs back into the frontier. The output of each step
is the input of the next.

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
10. SCHEDULE  recrawl.set(url, next_time)→ record change signal for re-crawl
```

A minimal loop in pseudocode, with the BFS invariant made explicit:

```python
from collections import deque

def crawl(seeds):
    frontier = deque(seeds)          # FIFO ⇒ BFS (a priority queue in production, see §2)
    seen = SeenSet()                 # Bloom filter + durable set (see §3)

    while frontier:
        url = frontier.popleft()     # BFS: oldest-discovered first
        if not robots_allowed(url):  # politeness gate (see §5)
            continue
        resp = polite_fetch(url)     # respects per-domain rate limit
        blob_store.put(content_hash(resp.body), resp.body)   # store raw first
        for link in extract_links(resp.body, base=url):
            u = canonicalize(link)   # normalize before dedup (see §3, §4)
            if not seen.contains(u): # Bloom: "definitely new" is trustworthy
                seen.add(u)
                frontier.append(u)   # append = BFS; a stack/appendleft = DFS
```

**Why BFS, not DFS?** Importance correlates with shallowness: a site's homepage and top
navigation (high PageRank, high value) are close to the seed, while low-value pages (deep
parameter permutations, archives) are many hops away. BFS crawls high-value pages first
*and* spreads requests across many hosts, which helps politeness.

| Property | BFS | DFS |
|---|---|---|
| Data structure | FIFO queue | LIFO stack |
| Crawls high-value pages first | Yes (importance ∝ shallowness) | No (dives deep immediately) |
| Host distribution | Spreads across many hosts | Concentrates on one host |
| Spider-trap behavior | Bounded per level; other work continues | Follows infinite chain forever |
| Politeness fit | Natural | Poor (hammers one host) |

Production crawlers use **priority-ordered BFS**, not pure FIFO: a priority (PageRank
proxy, freshness) reorders *within* the BFS frontier.

---

### 🔴 Architect — Why DFS Is Catastrophic, and the Loop's Real Bottleneck

**The DFS failure mode is a design-review red flag.** DFS dives down one path as deep as
it can. On a site with an infinite URL space — a calendar with `?date=` that generates
`next month` forever, or faceted-search parameter explosion — DFS follows that single
chain indefinitely, hammering one host, never returning to crawl the rest of the web. BFS
bounds the damage: the trap's URLs sit at one frontier level while other work proceeds.

**Where the loop actually bottlenecks.** The naive mental model says "fetch is the slow
part." At scale the hidden costs dominate:

```
Target: 1e9 pages/day = 1e9 / 86,400 s ≈ 11,600 pages/sec  (derived from stated goal)

Per-page hidden costs that must NOT be on the critical path:
  - DNS lookup:    10–200 ms uncached  → must be cached + async (see §7)
  - robots fetch:  one per host per day → must be cached (see §5)
  - politeness wait: up to 1 s/host    → overlapped across many hosts, not serialized
```

The architectural consequence: a crawler is **not** CPU-bound on parsing; it is
**concurrency-bound on I/O wait**. One machine issuing 11,600 *serial* blocking fetches
is impossible; you need thousands of concurrent in-flight requests, which forces the
distributed, per-domain-partitioned design in §6.

**Design-review talking points:**
- "Store raw bytes *before* parsing" — so a parser bug can be re-run against the original.
- "The frontier is the brain, not a queue" — priority + politeness + durability (§2).
- "BFS is a politeness feature, not just a traversal choice" — it spreads host load.

**Real-system anchor — Mercator (Heydon & Najork, 1999).** The Mercator research crawler
established this loop and explicitly identified DNS resolution as *the* dominant
bottleneck of a naive design — a finding that still shapes crawler architecture. I am
confident about the DNS-bottleneck claim from that paper; treat any exact throughput
number I might cite as approximate and verify against the primary source.

---

## 2. The URL Frontier: Priority Meets Politeness

### 🟢 Beginner — A Smart To-Do List with a Bouncer

Your crawl to-do list is not first-come-first-served. Two rules fight each other:

1. **Do the important things first.** The homepage of a major newspaper matters more than
   the 40,000th product-filter page of a shop.
2. **Do not pester any one person.** Even if you have 10,000 tasks all involving the same
   shop, you knock on that shop's door only once every few seconds.

So the frontier is a to-do list with a *bouncer* at the door of each shop. The list picks
*what* is important; the bouncer decides *when* it is polite to actually go. A plain queue
has neither — it would knock on one door 10,000 times in a row.

---

### 🟡 Senior — The Mercator Two-Level Frontier

The **URL frontier** is the set of discovered-but-not-yet-fetched URLs *plus* the policy
that decides which URL to fetch next and when. It must satisfy two competing goals at
once: **priority/freshness** and **politeness**. A plain FIFO fails both.

| Requirement | Plain FIFO | Production frontier |
|---|---|---|
| Priority ordering | No | Yes (front queues) |
| Per-domain politeness | No | Yes (back queues, one host each) |
| Freshness re-ordering | No | Yes (priority = f(change rate)) |
| Scale to billions of URLs | In-memory only | Sharded across disk + workers |

The standard interview answer is the **Mercator two-level design** (Heydon & Najork,
1999): two banks of queues separate *priority* from *politeness*.

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

- **Front queues (F of them):** one per priority band. A prioritizer scores each URL and
  drops it into the matching band. A biased selector pulls mostly from high bands.
- **Back queues (B of them):** the invariant is **each back queue holds URLs for exactly
  one host**. A min-heap over "earliest next-fetch time" tells a fetcher which back queue
  is due next.

A dequeue that respects politeness looks like this:

```python
import heapq, time

class Frontier:
    def __init__(self):
        self.back = {}      # host -> deque of urls
        self.heap = []      # (next_allowed_ts, host)

    def add(self, url, priority):
        host = registrable_domain(url)          # eTLD+1 (see §6)
        if host not in self.back:
            self.back[host] = []
            heapq.heappush(self.heap, (time.time(), host))
        # priority ordering lives in the front queues; shown here as insort by score
        insort_by_priority(self.back[host], url, priority)

    def next(self):
        # Pop the host whose politeness timer is soonest.
        next_ts, host = self.heap[0]
        if next_ts > time.time():
            sleep_until(next_ts)                # nothing polite to do yet
        heapq.heappop(self.heap)
        url = self.back[host].pop(0)            # highest-priority URL for this host
        # Re-arm this host's timer for its per-domain delay (e.g., 1 s).
        heapq.heappush(self.heap, (time.time() + host_delay(host), host))
        return url
```

Assigning **priority before a URL is crawled** uses predictive signals (you have no
PageRank for an uncrawled page):

```
priority(url) = w1 * source_page_pagerank   # who linked to it (best signal)
              + w2 * inlink_count            # how many known pages link to it
              + w3 * domain_authority        # authority of the host (eTLD+1)
              + w4 * (1 / url_depth)         # shallower = usually more important
              + w5 * freshness_urgency       # for re-crawl: overdue + high change rate
              - w6 * url_spam_score          # long query strings, many params → penalize
```

Real crawlers approximate importance online with **OPIC** (Online Page Importance
Computation, Abiteboul et al., 2003), distributing "cash" across out-links during the
crawl instead of waiting for a full offline PageRank pass.

---

### 🔴 Architect — Sharding the Frontier, and a Redis Capacity Wall

At web scale the frontier is a **distributed, disk-backed priority queue, partitioned by
domain** (aligning with the politeness model in §6). The hot slice lives in memory; the
tail spills to disk or a partitioned log.

**A concrete capacity failure — Redis sorted-set frontier falling behind.** Suppose the
frontier is a Redis sorted set keyed by priority, taking 50,000 `ZADD`/sec and lagging.

```
Diagnosis:
  Redis executes commands on a SINGLE thread.
  ZADD on a sorted set is O(log N) per element.
  With N in the hundreds of millions, log N is large ⇒ one core saturates near 50k ops/s.

  redis-cli INFO commandstats   # cmdstat_zadd usec_per_call
  redis-cli INFO cpu            # used_cpu_user near one core's ceiling?
  redis-cli --latency           # rising latency = command-queue backup
```

| Fix | Mechanism | Tradeoff |
|---|---|---|
| **Shard by domain** | consistent-hash domains across M instances; each does 50k/M | More instances; matches politeness partitioning (§6) |
| Pipeline/batch | send ZADD in batches per round-trip | Cuts RTT, **not** the O(log N) CPU |
| Bound the set | keep top-K in memory; spill tail to disk/log | Cold URLs delayed |
| Move to a log | Kafka partitioned by domain for bulk; Redis for the hot slice | Loses global ordering; ordering becomes per-partition |

The **root fix is sharding by domain** — not a scaling patch but an architectural
correction, because it also makes politeness a local, lock-free property (§6).

**Durability is mandatory.** If a worker keeps its frontier only in RAM and crashes, its
queued URLs are lost and its domains are unowned. The frontier must be a **durable,
partitioned log** (Kafka-style topic keyed by domain, or a WAL'd disk queue) so a new
owner can replay from the last committed offset — at-least-once replay yields at most a
few duplicate fetches, which dedup (§3) absorbs idempotently.

**Named tradeoff — Throughput vs Durability.** In-memory is faster but loses state on
crash; a durable log adds write latency but makes recovery a replay. At web scale, choose
durability.

**Real-system anchor.** The Mercator design is the canonical two-level frontier cited in
system-design literature and the Manning/教科书 crawler chapters. Production crawlers at
search-engine scale keep the frontier durable precisely so a worker crash never loses
discovered-but-uncrawled URLs.

---

## 3. URL Deduplication with Bloom Filters

### 🟢 Beginner — A Guest List That Never Lets a Stranger In by Mistake

You are the bouncer at a huge party. Millions of people have already been in. You need a
fast way to answer "has this person been here before?" without carrying millions of ID
cards.

A **Bloom filter** is a magic checklist with one guarantee and one quirk:
- **Guarantee:** if it says "this person is *new*," it is *always right*. It never turns
  away a genuine newcomer thinking they already came. (No false negatives.)
- **Quirk:** it *occasionally* says "this person already came" about a true newcomer. (A
  small, tunable rate of false positives.)

For a crawler that asymmetry is perfect: wrongly re-crawling a page (a false negative)
would only waste effort — but the Bloom filter *prevents that entirely*. The rare false
positive (skipping a page) we clean up with a backup exact list.

---

### 🟡 Senior — How a Bloom Filter Works (and the Two-Tier Check)

A naive hash set is impossible at scale: 5 trillion 64-bit fingerprints = 5e12 × 8 bytes
= **40 TB of RAM** just for hashes. Use a **Bloom filter** (probabilistic membership)
fronting a **durable exact set** (a row per URL hash in a wide-column store).

A Bloom filter is a bit array of `m` bits and `k` independent hash functions:

```python
class BloomFilter:
    def __init__(self, m_bits: int, k_hashes: int):
        self.m = m_bits
        self.k = k_hashes
        self.bits = bytearray(m_bits // 8 + 1)

    def _positions(self, item: bytes):
        # Double hashing: derive k indices from two base hashes.
        # h_i = (h1 + i*h2) mod m  — standard, avoids computing k full hashes.
        h1 = mmh3_128(item, seed=0)
        h2 = mmh3_128(item, seed=1)
        for i in range(self.k):
            yield (h1 + i * h2) % self.m

    def add(self, item: bytes):
        for pos in self._positions(item):
            self.bits[pos // 8] |= (1 << (pos % 8))     # set bit

    def contains(self, item: bytes) -> bool:
        # If ANY of the k bits is 0, the item was definitely never added.
        for pos in self._positions(item):
            if not (self.bits[pos // 8] & (1 << (pos % 8))):
                return False        # DEFINITELY NEW — never a false negative
        return True                 # PROBABLY seen — could be a false positive
```

The membership check is two-tiered to eliminate the residual false positives:

```python
def should_crawl(url_hash):
    if not bloom.contains(url_hash):     # definitely new (no false negatives)
        bloom.add(url_hash)
        durable_set.put(url_hash)
        return True
    # "probably seen" — verify against the exact set to catch a Bloom false positive
    if durable_set.contains(url_hash):   # exact confirm (only on the ~0.1% FP set)
        return False                     # truly seen → skip
    return True                          # was a Bloom false positive → crawl it
```

| Structure | Memory for 5T URLs | False negative? | False positive? |
|---|---|---|---|
| Exact hash set (RAM) | ~40 TB | No | No |
| Bloom filter (0.1% FP) | ~9 TB (see below) | **No (by construction)** | Yes (~0.1%) |
| Bloom + durable exact set | ~9 TB RAM + disk | No | Resolved by exact check |

The **defining property**: no false negatives (if it says "new," it is truly new) but
tunable false positives. That is exactly the asymmetry a crawler wants.

**Cost asymmetry — which error hurts more?**

```
FALSE POSITIVE: filter says "seen" but URL is new  → SKIP a real page → coverage gap
FALSE NEGATIVE: filter says "new" but URL was seen → RE-CRAWL a dup → wasted budget
```

A false positive is *more dangerous* (silent coverage loss you cannot detect later),
which is *why* the Bloom filter fits: it guarantees zero false negatives and lets you
push the false-positive rate as low as budget allows.

---

### 🔴 Architect — The Capacity Math, Sharding, and a Fallback Decision

**Bloom filter sizing arithmetic** (n = elements, m = bits, k = hashes, p = FP rate):

```
Optimal bits per element:  m/n = -ln(p) / (ln 2)^2
Optimal hash functions:    k   = (m/n) * ln 2
False-positive rate:       p   = (1 - e^(-k*n/m))^k

Plug in p = 0.001 (0.1%):
  m/n = -ln(0.001) / (ln 2)^2
      = 6.9078 / 0.4805
      = 14.38 bits per URL

  Total bits  m = 5e12 × 14.38  = 7.19e13 bits
  Total bytes   = 7.19e13 / 8   = 8.99e12 bytes  ≈ 9 TB

  k = 14.38 × ln 2 = 14.38 × 0.6931 ≈ 9.97  → 10 hash functions
```

So: **~9 TB of RAM and ~10 hash functions for 0.1% FP over 5 trillion URLs.**

| Target FP rate | Bits/URL | Hash funcs k | Total (5T URLs) |
|---|---|---|---|
| 1% | 9.59 | 7 | ~6.0 TB |
| ~0.8% | 10.0 | 7 | ~6.25 TB |
| **0.1%** | **14.38** | **10** | **~9 TB** |
| 0.01% | 19.17 | 13 | ~12 TB |

(All figures above are **derived from the formulas**, not measured benchmarks.) Nine TB
exceeds one machine, so the filter is **sharded by URL-hash prefix** across nodes; each
node holds one slice of the bit array. A common trick is to use **counting Bloom filters**
or scalable/partitioned variants if you need deletes or growth — plain Bloom filters do
not support deletion.

**The architect-level tradeoff — accept FP, or add a fallback?**

```
At 0.1% FP over 5e12 URLs:  5e12 × 0.001 = 5e9 URLs could be wrongly skipped (coverage loss).
```

| Option | Coverage | Cost |
|---|---|---|
| Accept 0.1% FP | Lose ~5B pages | Cheapest; ~9 TB Bloom |
| Lower FP to 0.01% | Lose ~500M | ~12 TB Bloom (more RAM) |
| **Bloom + secondary exact check** | Lose ~0 | Bloom RAM + one exact lookup on the ~0.1% "seen" hits |

The exact-check fallback is usually right: the Bloom filter answers 99.9% of queries from
RAM, and only the ~0.1% it flags as "seen" pay a durable-store lookup. That converts a
*coverage* problem into a small, bounded *latency* cost on a tiny fraction of checks.

**Design-review talking point:** never let anyone claim a Bloom filter has false
negatives — it is the one guarantee it makes. If someone proposes it *because* it "might
miss some," they have it backwards.

**Real-system anchor.** Bloom filters are widely documented in large-scale storage and
crawling systems for membership tests (e.g., they are a standard read-path optimization
in LSM-tree databases like the Bigtable/Cassandra lineage to avoid disk reads for absent
keys). I am confident Bloom filters are used this way in LSM engines; I do not have a
verified public number for any specific search engine's URL-dedup filter size, so treat
the 5T/9 TB figures as an illustrative sizing exercise.

---

## 4. Near-Duplicate Content: SimHash and Shingling

### 🟢 Beginner — Spotting the Same Article in a New Outfit

The same news story often appears on dozens of sites with tiny edits — a different date, a
changed byline, an extra ad line. To a byte-by-byte checker these look totally different
(one changed character defeats it), yet to a human they are obviously the same story.

**SimHash** is a fingerprinting trick that gives *similar documents similar fingerprints*.
Change a few words and the fingerprint barely moves. So you can tell "these two pages are
95% the same" by checking how few bits differ between their fingerprints — without
comparing the full text.

---

### 🟡 Senior — SimHash Mechanics and the Dedup Layer Map

Exact checksums (MD5/SHA of the body) only catch **byte-identical** duplicates. Near-dup
detection uses **SimHash** (Charikar, 2002; applied to web crawling by Manku, Jain &
Das Sarma, Google, 2007) or **MinHash/shingling**.

```
SimHash (locality-sensitive: similar docs → similar fingerprints):

1. Tokenize the doc into features (words or k-word "shingles"), each with a weight
   (e.g., tf-idf).
2. Hash each feature to a b-bit value (b = 64 typical).
3. Maintain a vector V[0..63] initialized to 0. For each feature's hash:
      for each bit position i:
          if bit i is 1:  V[i] += weight
          else:           V[i] -= weight
4. Fingerprint: for each i, output bit 1 if V[i] > 0 else 0  → a 64-bit signature.
5. Two docs are near-duplicates if Hamming distance(sig_a, sig_b) is small
   (Google reported using ≤ 3 bits out of 64).
```

In code:

```python
def simhash(features_with_weights, bits=64):
    V = [0] * bits
    for feature, weight in features_with_weights:
        h = hash64(feature)
        for i in range(bits):
            if (h >> i) & 1:
                V[i] += weight
            else:
                V[i] -= weight
    fingerprint = 0
    for i in range(bits):
        if V[i] > 0:
            fingerprint |= (1 << i)
    return fingerprint

def near_duplicate(sig_a, sig_b, max_hamming=3):
    return bin(sig_a ^ sig_b).count("1") <= max_hamming   # XOR then popcount
```

The magic: flipping a few words barely moves the weighted sums, so the fingerprint
changes in *few bits* — Hamming distance becomes a proxy for similarity.

| Method | Detects | Signature | Comparison |
|---|---|---|---|
| MD5/SHA checksum | Byte-identical only | 128/256-bit | Equality |
| **SimHash** | Near-duplicate (few edits) | 64-bit | Hamming distance ≤ k |
| MinHash + shingling | Jaccard set similarity | Set of min-hashes | Estimated overlap |

Which dedup layer catches which duplicate:

| Duplicate type | Layer | Fetch needed? |
|---|---|---|
| Cosmetic URL variant (utm, www, scheme) | URL normalization | No |
| Same bytes, different URL | Content checksum | Yes |
| Near-identical content (minor edits) | SimHash (Hamming ≤ 3) | Yes |
| "Have I seen this URL ever?" | Bloom + durable set (§3) | No |

---

### 🔴 Architect — Finding Near-Dups Among Billions Without O(n²)

The naive approach compares every new fingerprint to every stored one — O(n²), impossible
at billions of documents. The Google 2007 paper's technique: index fingerprints by
**permuted bit-prefix blocks** so any two fingerprints within Hamming distance k are
guaranteed to share at least one block prefix.

```
Problem: given a 64-bit fingerprint F, find all stored fingerprints within Hamming ≤ 3.

Technique (Manku et al., 2007):
  - Build several tables, each a different PERMUTATION of the 64 bits, sorted by a
    high-order prefix of d bits.
  - Two fingerprints differing in ≤ 3 bits must AGREE on some prefix block in at least
    one permutation (pigeonhole: 3 differing bits cannot land in every block).
  - Query = probe each table's prefix range; only candidates in a matching block are
    compared bit-by-bit. Turns a full scan into a few sorted-range lookups.

Illustrative sizing (labeled illustrative):
  1e9 fingerprints × 8 bytes = 8 GB per table; a handful of permutation tables = tens of GB
  → fits in memory across a small cluster; each near-dup query is O(log n) range probes.
```

**Failure modes and review points:**
- **Threshold tuning is a precision/recall knob.** Hamming ≤ 3 of 64 is a *choice*; too
  loose merges distinct pages (over-collapse, coverage loss), too tight misses real
  near-dups (index bloat, wasted re-indexing). It should be tuned and monitored, not
  hardcoded blindly.
- **Boilerplate dominates weak fingerprints.** If you SimHash the whole HTML including
  nav/footer/ads, two different articles on the same template look near-identical. Extract
  main content *before* fingerprinting.
- **Canonical + checksum + SimHash are layers, not alternatives.** Normalize the URL
  first (free, no fetch), then checksum (catches byte-identical), then SimHash (catches
  near-dups). Each layer removes work from the next.

**Real-system anchor.** Manku, Jain & Das Sarma (WWW 2007, Google) is the canonical paper
describing SimHash applied to a multi-billion-page crawl with the permuted-block index. I
am confident this paper exists and describes the 64-bit / Hamming-≤-3 approach; treat any
specific throughput number as approximate.

---

## 5. robots.txt and Politeness

### 🟢 Beginner — Reading the "House Rules" Sign Before Entering

Many websites post a sign at the front door (`/robots.txt`) that says which rooms visitors
may enter and how often to knock. A well-behaved crawler *always reads the sign first*,
follows it, and does not knock so often that it disturbs the household.

There is a subtle rule about a *missing* or *broken* sign: if there is simply **no sign**
(a clear "404 not found"), that means "no special rules — come in." But if the sign is
**temporarily unreadable** because the house is on fire (a server error), the polite
assumption is "stay out until things settle." A missing sign is permission; a broken sign
is caution.

---

### 🟡 Senior — The Robots Exclusion Protocol and the Backoff State Machine

`robots.txt` is the Robots Exclusion Protocol, standardized as **RFC 9309 (2022)**. It
lives at `https://host/robots.txt`; a well-behaved crawler fetches and parses it *before*
crawling any URL on the host, caches it, and re-checks periodically.

| Directive | Meaning | Standardized? |
|---|---|---|
| `User-agent` | Which crawler the block applies to (`*` = all) | Yes (RFC 9309) |
| `Disallow` | Path prefix the crawler must not fetch | Yes |
| `Allow` | Exception carve-out inside a Disallow | Yes |
| `Sitemap` | Absolute URL of a sitemap | De-facto, widely honored |
| `Crawl-delay` | Min seconds between requests | **Non-standard** — Bing/Yandex honor it; **Googlebot ignores it** |

Matching uses the **longest / most-specific rule** for the matching user-agent group.

**Unreachable robots.txt (RFC 9309 §2.3.1):**

```
2xx  → parse and apply the rules
3xx  → follow redirects (a few hops), then apply
4xx (e.g., 404) → "unavailable" = NO restrictions → crawl everything (no file = allowed)
5xx / 429       → server error → assume COMPLETE DISALLOW (be conservative), retry later
```

The critical asymmetry: **404 = allow-all, 5xx = disallow-all.** Google additionally
falls back to the last cached robots.txt for a grace window (documented as up to ~30 days
in Google's docs) — treat that exact figure as approximate and verify against current
Google documentation.

**Politeness is self-interest, not charity.** Limit per-host request rate, honor
`Crawl-delay`/`Retry-After`, identify with a real `User-Agent`, back off on errors.

| Stakeholder | Why politeness matters |
|---|---|
| Crawled server | Avoids overload / accidental DoS |
| Crawler operator | Avoids IP bans, robots blacklists, abuse complaints, wasted retry budget |

**The 429 backoff state machine** (server sends `429 Too Many Requests`, `Retry-After: 60`):

```
STATES per host:
  NORMAL      → fetch at politeness rate (≤1 req/sec)
  BACKING_OFF → suspend all fetches to this host until resume_at
  PROBING     → after wait, send ONE request to test the water

on 429 (Retry-After: 60):
   1. STOP all in-flight scheduling for this host immediately
   2. resume_at = now + 60s  (honor Retry-After exactly — do NOT retry early)
   3. requeue the 429'd URL (don't drop it) with resume_at
   4. state = BACKING_OFF

after 60s → state = PROBING:
   5. send one request
      - 200  → state = NORMAL, but LOWER the rate (e.g., halve req/sec for a while)
      - 429  → EXPONENTIAL BACKOFF: resume_at = now + min(60*2^attempts, cap)  (add jitter)
```

Two subtleties: **honor `Retry-After` literally**, and **do not drop the URL** — requeue
it. Add jitter so 500 workers do not all resume at the same instant (thundering herd).

**Crawl-delay vs your policy:** take the more conservative of the two, but cap extremes.

```
effective_delay = max(your_default_delay, crawl_delay_from_robots)
effective_delay = min(effective_delay, MAX_ALLOWED_DELAY)   # sanity cap, e.g. 30–60s
```

`Crawl-delay: 3600` (1 hour) means ≤24 pages/day — honoring it literally could stall a
large site forever. Cap it and deprioritize the domain. This is precisely why Google
dropped `Crawl-delay` support: one misconfigured value could cripple crawl coverage.

---

### 🔴 Architect — Robots Cache TTL, Conditional Refetch, and Distributed Rate Limiting

**The cache-TTL failure mode.** Caching `robots.txt` *indefinitely* is a bug: the site
later adds `Disallow: /private/`, and your stale cache keeps you crawling forbidden paths
for months — an abuse complaint waiting to happen.

```
Correct TTL: ~24 hours (RFC 9309 §2.4: caching SHOULD generally not exceed 24 hours).

robots cache entry = { rules, fetched_at, etag, last_modified }
TTL = 24h (or shorter Cache-Control max-age if the site sets one)

on TTL expiry → conditional refetch:
   GET /robots.txt
     If-None-Match: "<etag>"
     If-Modified-Since: <last_modified>
```

| Response to conditional refetch | Action |
|---|---|
| `200` + new body | Replace rules, reset TTL, store new ETag |
| `304 Not Modified` | **Keep rules, reset TTL, no body downloaded** |
| `5xx` | Keep last-good rules (grace window), retry sooner |
| `404` | Now no restrictions → allow all, reset TTL |

A `304` costs almost nothing (no body transferred) yet re-validates freshness — that is
the whole point of conditional requests.

**Per-domain rate limiting across 500 workers** — the hard part is that workers share no
clock. Two designs:

```
Design A — Partition by domain (PREFERRED):
   worker_id = consistent_hash(registrable_domain(url))    # see §6
   # every nytimes.com URL → one worker → local token bucket → trivially ≤1 req/sec
   # "two workers both crawl nytimes.com at once" CANNOT happen: only one owner exists.

Design B — Shared distributed limiter (if you cannot partition):
   allowed = redis.eval(token_bucket_lua, key="rl:nytimes.com", rate=1, burst=1)
   # atomic check-and-decrement so two workers can't both pass
```

| Approach | Coordination | Politeness guarantee | Failure mode |
|---|---|---|---|
| **Partition by domain (A)** | None (local) | Exact — one owner | Owner crash loses that domain's state (durable log fixes; §2) |
| Shared limiter (B) | Every fetch hits Redis | Exact if atomic | Redis becomes hot-path bottleneck / SPOF |

Partitioning by domain makes politeness a **local, lock-free** property — the single most
important reason Google-scale crawlers hash by host.

**Named tradeoff — Robots Freshness vs Fetch Overhead.** Longer TTL = fewer robots
fetches but staler rules; 24h + conditional GETs is the industry balance (near-zero
overhead via 304s, at-most-one-day staleness).

**Real-system anchor.** RFC 9309 was authored largely by Google engineers and reflects
Googlebot's long-standing behavior; Google publicly open-sourced its robots.txt parser in
2019 as part of the standardization push. I am confident RFC 9309 exists (2022) and that
Google open-sourced a robots parser; verify the exact grace-window and Crawl-delay
statements against current Google docs, as crawler behavior can change after my cutoff.

---

## 6. Distributing Work: Consistent Hashing by Domain

### 🟢 Beginner — Every Neighborhood Gets One Mail Carrier

You have 500 mail carriers and millions of houses. If you shuffled which carrier handles
which house every day, no carrier would ever learn their route, and two carriers might
knock on the same door at once.

Instead, assign each *neighborhood* (domain) to exactly one carrier, permanently. That
carrier learns the neighborhood's shortcuts (DNS), its house rules (robots.txt), and paces
themselves so no household is disturbed (politeness) — all without phoning the other 499
carriers. When you hire a new carrier, only a *few* neighborhoods change hands, not
everyone's.

---

### 🟡 Senior — Assigning a URL to a Worker

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
      - politeness rate limiter   (§5)
      - robots.txt cache          (§5)
      - DNS cache entry           (§7)
      - back-queue                (§2)
```

```python
import bisect

def owner_worker(url, ring_positions, ring_map, hash_fn):
    domain = registrable_domain(url)         # eTLD+1 via Public Suffix List
    pos = hash_fn(domain)
    idx = bisect.bisect_right(ring_positions, pos) % len(ring_positions)
    return ring_map[ring_positions[idx]]     # clockwise successor = owning worker
```

**Why consistent hashing, not `hash % 500`?** Adding/removing a worker under modulo
remaps ~(N−1)/N of all domains → a mass frontier reshuffle. Consistent hashing (with
virtual nodes) moves only ~1/N of domains.

**Why hash by domain, not by URL?** Hashing by URL scatters one domain's pages across all
500 workers, making per-domain politeness a distributed-coordination nightmare.

| Hash key | Politeness | robots/DNS cache | Load balance |
|---|---|---|---|
| Full URL | Distributed (hard) | Duplicated everywhere | Even |
| **eTLD+1 domain** | **Local (easy)** | **One owner, high hit rate** | Even with vnodes |

---

### 🔴 Architect — Worker Crash Recovery and Hot-Domain Sub-Partitioning

**The crash-recovery failure mode.** Worker 17 owns all `nytimes.com` URLs and crashes
with 50,000 queued, unfetched URLs. If its frontier was in-memory only, those URLs are
gone and the domain is unowned.

```
Recovery (only possible if the frontier is durable — see §2):
1. DURABILITY: frontier backed by a partitioned log keyed by domain (Kafka-style / WAL).
   → the 50k URLs still exist in shard 17's partition after the crash.
2. FAILOVER: gossip detects shard 17 dead → the ring's next clockwise worker takes over
   nytimes.com's key range.
3. REPLAY: the new owner reads shard 17's durable partition from the last committed offset
   → rebuilds the back-queue. No re-crawl, no loss.
4. IDEMPOTENCY: replaying fetched-but-not-committed URLs just re-checks the dedup set —
   at worst a few duplicate fetches, never lost coverage (at-least-once).
```

**The hot-domain failure mode.** A single domain with billions of URLs (a giant
e-commerce or UGC site) overloads its one owning worker.

```
Fix: bounded sub-partitioning of a hot domain across a few workers, e.g.
   sub_key = domain + ":" + (hash(path) % S)     # S small, e.g. 4
   owner   = ring.successor(hash(sub_key))
Caveat: now S workers touch the domain → politeness must be COORDINATED across them
   (shared token bucket, Design B in §5) for that domain only. Keep S small to bound cost.
```

**Capacity sanity check for the ring:**

```
500 workers, 1e9 pages/day = ~11,600 pages/sec total (derived).
Even split: ~23 pages/sec/worker average.
But domains are wildly unequal in size → without virtual nodes, a few workers own the
mega-domains and saturate. Virtual nodes (e.g., 150–256 per worker) smooth key-space
ownership; hot-domain sub-partitioning smooths the remaining outliers.
```

**Design-review talking points:**
- "Partition by eTLD+1, not full host and not full URL" — this one decision makes
  politeness, DNS, and robots all *local*.
- "The dispatcher should be decentralized" — each worker knows the ring and routes
  discovered URLs directly to the owning peer, eliminating a central SPOF.
- "Consistent hashing here is a *correctness* enabler (politeness), not just load
  balancing" — that framing signals depth.

**Real-system anchor.** Consistent hashing is the partitioning scheme behind Dynamo-family
stores (Cassandra, DynamoDB) and Akamai's edge routing; partitioning a crawler by host is
the standard approach in the crawler literature (Mercator and successors) precisely to
localize politeness. See the sibling `consistent-hashing/deep-dive.md` for ring mechanics,
virtual nodes, and gossip.

---

## 7. DNS at Crawl Scale

### 🟢 Beginner — Memorize Phone Numbers, Do Not Redial the Operator

Every time you want to call a shop, you *could* phone the operator to look up its number.
But if you call the same shop thousands of times, redialing the operator each time is
absurdly slow. You memorize the number after the first lookup.

DNS is the operator: it turns a domain name into an IP address. A crawler that looks up
DNS on *every* fetch grinds to a halt. Because each worker owns whole neighborhoods
(§6), it looks up each domain once and remembers it — turning millions of lookups into a
trickle.

---

### 🟡 Senior — Why Naive Resolution Breaks, and the Fix

```
Target: 1e9 pages/day ≈ 11,600 pages/sec (derived).
Naive: one DNS lookup per fetch → 11,600 DNS queries/sec.
```

DNS resolution is typically **synchronous and high-latency** (10–200 ms per uncached
lookup, sometimes seconds on cold/slow authoritative servers). At 11,600 blocking
lookups/sec, fetch threads stall waiting on DNS — historically *the* crawler bottleneck
(Mercator, 1999). The fix is aggressive caching plus async resolution:

```
Effective uncached lookup rate WITH caching (illustrative arithmetic):
   Suppose 10M unique domains, ~5,000 pages crawled per domain on average.
   → one lookup per domain amortizes over thousands of fetches.
   With TTL ~1 day: uncached lookups ≈ 10M domains / 86,400 s ≈ 116 lookups/sec.
   That's ~100x below the naive 11,600/sec.
```

| Technique | Effect |
|---|---|
| Per-worker DNS cache (respect TTL) | Most lookups become memory hits (domain partitioned → high hit rate, §6) |
| Dedicated async resolver pool | Non-blocking; fetch threads never stall on DNS |
| Prefetch DNS when URL enters frontier | Resolve ahead of fetch time |
| Local caching resolver (e.g., Unbound) | Shared cache across workers; own the resolver capacity |

Because domains are partitioned to workers (§6), each worker's DNS cache sees the *same*
domains repeatedly → very high hit rate. The naive 11,600/sec collapses to ~100/sec of
real lookups (illustrative).

---

### 🔴 Architect — Negative Caching, the Silent Coverage Killer

**Negative caching** = caching a *failure* response (notably `NXDOMAIN` — domain does not
exist), so you do not re-query a name that just failed. The negative TTL comes from the
domain's **SOA record** minimum-TTL field, per RFC 2308.

**Why it is dangerous for a crawler that constantly discovers new domains:**

```
1. Crawler discovers brand-new-domain.com (just registered, DNS not yet propagated).
2. Lookup returns NXDOMAIN (transient — propagation lag, or a slow resolver).
3. Negative cache stores NXDOMAIN with TTL = e.g. 3600s (or, per SOA, much longer).
4. For that whole TTL the crawler believes the domain doesn't exist and SKIPS it,
   even though it's actually live → a SILENT coverage gap.
```

| Cache type | Caches | Crawler risk |
|---|---|---|
| Positive (A/AAAA) | Successful IP resolution | Stale IP if server moves (bounded by TTL) |
| **Negative (NXDOMAIN)** | Resolution *failure* | **Skips a domain that actually exists** if failure was transient |

**Mitigations:** cap negative TTLs short (e.g., 60–300s regardless of SOA); retry
transient failures a couple of times before caching a negative; and distinguish
`NXDOMAIN` (real "doesn't exist") from `SERVFAIL`/timeout (transient — do not negatively
cache aggressively). For a crawler, a false negative on domain *existence* is a silent
coverage loss, so err toward re-querying.

**Design-review talking points:**
- "Run your own recursive resolver" — at 11,600 pages/sec you do not want to hammer a
  public resolver; you want to own resolver capacity and cache policy.
- "Prefetch DNS at frontier-enqueue time, not fetch time" — hides latency entirely.
- "Watch the negative cache TTL as closely as the positive one" — it is the subtle
  coverage killer.

**Real-system anchor.** The Mercator paper (Heydon & Najork, 1999) explicitly identified
DNS as the crawler's throughput ceiling and added a custom asynchronous DNS resolver — one
of the earliest documented cases of DNS being the bottleneck in a large system. I am
confident about this attribution.

---

## 8. Crawler Traps and Crawl Budget

### 🟢 Beginner — The Maze That Never Ends

Some websites are accidental (or deliberate) mazes: a calendar with a "next month" link
that goes on forever, or a shop filter that generates a brand-new page for every
combination of color, size, and sort order — millions of near-identical pages.

A naive crawler wanders into the maze and never comes out, spending all its time on one
worthless site while the rest of the web goes uncrawled. The defenses are like giving
yourself a rule: "I'll only go so deep, I'll only spend so much time in any one building,
and if every room looks the same, I leave."

---

### 🟡 Senior — Trap Types and Layered Defenses

A trap generates an unbounded URL space from one host, so the frontier **grows without
bound from a single domain** — memory blows up and the crawl budget is wasted.

| Trap | Shape | Example |
|---|---|---|
| Calendar / date trap | Infinite `?date=`/`next` chain | `/events?month=2050-12` forever |
| Faceted-search explosion | Combinatorial params | `?color=red&size=9&sort=price&page=…` |
| Session-ID in URL | New URL per visit | `/?sid=<random>` |
| Infinite pagination | `?page=1…?page=∞` | Generated "next page" links |

Layered defenses:

```
1. Max crawl depth per domain: stop following links past N hops from the seed (e.g., 20).
2. Per-domain URL budget: cap pages/domain/day ∝ domain authority.
3. URL pattern detection: track distinct URLs per (host, path-template); if
   example.com/list?page=* produced 10k near-identical pages, demote/drop the template.
4. Content-based cutoff: SimHash the fetched pages (§4); if the series stops changing, stop.
5. Frontier size cap per host: bounded back-queue; overflow spilled to cold storage.
```

| Defense | Stops the trap by | Cost |
|---|---|---|
| Max depth | Bounding chain length | May miss deep legit content |
| Per-domain budget | Bounding total pages/host | Needs authority scoring |
| Pattern detection | Recognizing generated URLs | State per URL template |
| Content SimHash | Detecting no new content | Must fetch to detect |

The cheapest and most robust is the **per-domain budget** — it bounds the blast radius
regardless of the trap's shape.

---

### 🔴 Architect — Crawl Budget as Value Allocation

The deeper problem is not just traps; it is **spending budget by value, not by discovery
order.** Without a budget, faceted-search param spam consumes everything while
high-PageRank pages 10 hops deep starve.

```
per-domain crawl budget (proportional to authority):
   budget(domain) = base × authority_score(domain)        # pages/domain/day
   spend the budget by URL priority (§2), not discovery order:
     - high in-link / high source-PageRank URLs first
     - penalize URLs with many query params / deep param templates (spam signal)
     - allow deep-but-high-value pages (10 hops but high in-degree) to jump the queue
```

| Policy | Effect |
|---|---|
| No budget | Traps / param-spam consume everything |
| Flat budget/domain | Fair but ignores authority |
| **Authority-weighted budget + priority spend** | High-value coverage, spam starved |

**Capacity framing:**

```
Suppose global budget = 1e9 pages/day. If one trap can generate 1e7 URLs/day and you have
no per-domain cap, a single hostile/broken domain can consume 1% of the ENTIRE web's daily
crawl budget. With a per-domain cap of, say, 10k pages/day for a low-authority domain, the
same trap consumes 0.001% before hitting its ceiling. (Illustrative numbers.)
```

**The accidental-DDoS variant.** One high-priority seed links to 200 small sites; BFS
extracts all 200 at once, and if politeness is only per-worker, 200 fragile hosts get hit
simultaneously — abuse complaints follow, especially when many share one hosting IP.

```
LAYER 1 — Per-domain politeness enforced globally (partition to one worker, §6).
LAYER 2 — Per-IP / per-hosting-provider throttling: resolve to IP, rate-limit per /24
          subnet, so 50 domains on one shared host don't collectively overwhelm it.
LAYER 3 — Global + adaptive back-pressure: stagger the initial 200 (don't fire at t=0);
          watch latency/error rate; back off on 5xx/429; budget per hosting ASN.
```

| Layer | Prevents | Gap it closes |
|---|---|---|
| Per-domain limiter | One domain overloaded | Baseline politeness |
| **Per-IP / per-subnet limiter** | Shared-host overload | Many domains, one server |
| Adaptive back-pressure + staggering | Simultaneous burst | Reacts to real-time distress |

The key insight interviewers probe: **per-domain politeness is not enough** — small sites
share IPs, so you also need per-IP/per-provider throttling plus adaptive back-off.

**Real-system anchor.** Google's Search Central documentation discusses "crawl budget" as
a real operational concept for large sites (crawl-rate limit + crawl demand), and search
engines publicly advise site owners to avoid faceted-navigation URL explosions in
robots.txt / URL parameters. I am confident "crawl budget" is Google-documented
terminology; verify the current parameter-handling guidance against Search Central, as it
has changed over the years.

---

## 9. Content Processing and Blob Storage

### 🟢 Beginner — Photocopy First, Then Read

When a page comes back, the first thing a careful crawler does is make an exact photocopy
of it and file it away — *before* trying to read or interpret it. Why? Because if the
crawler's "reading" logic has a bug, you can always go back to the original photocopy and
re-read it later. If you only kept your interpretation, a bug would lose the page forever.

After filing the photocopy, the crawler reads it: pulls out the links, notices any "do not
list this page" signs, extracts the article text for the search index, and writes down
when to come back.

---

### 🟡 Senior — The Content Pipeline and Relative-URL Traps

After an HTTP 200 with HTML:

```
1. Content-type / size guard   → confirm text/html; reject if body > cap (e.g., 5 MB)
2. Charset detection + decode  → bytes → Unicode (Content-Type charset, <meta>, BOM, sniff)
3. Store raw bytes             → write to blob storage as a WARC record; keep original
                                 BEFORE any transformation (reproducibility)
4. Content dedup               → checksum (exact) + SimHash (near-dup, §4)
5. Parse to DOM                → tolerant HTML parser (real HTML is malformed)
6. Extract links               → <a href>, <link>, sitemap refs
7. Resolve relative → absolute → base URL + <base href>
8. Extract directives          → <meta name="robots">, rel="canonical", rel="nofollow"
9. Extract main content/text   → boilerplate removal for the indexer
10. Normalize + dedup URLs     → canonicalize, Bloom-check (§3)
11. Enqueue new URLs           → to frontier with priority (§2)
12. Emit for indexing          → parsed content + metadata
13. Update re-crawl schedule   → fetch time, ETag/Last-Modified, change signal (§10)
```

**Relative-URL resolution (RFC 3986 §5)** and its trap — the `<base href>` tag:

```
Page fetched from: https://example.com/blog/post.html
Page contains:     <base href="https://cdn.example.net/v2/">
  href="img.png"   →  naive:  https://example.com/blog/img.png     ❌ WRONG
                   →  correct: https://cdn.example.net/v2/img.png   ✅ (uses <base>)
```

Also filter `javascript:`, `mailto:`, `tel:`, `data:` URIs; strip fragments; handle
protocol-relative `//host/x` by inheriting the page's scheme.

**URL normalization — do it before dedup, and do it carefully:**

```
1. Scheme + host lowercasing:   HTTP://Example.COM/  → http://example.com/
2. Default-port removal:        http://x.com:80/     → http://x.com/
3. Path normalization:          /a/./b/../c          → /a/c ; %7E → ~
4. Query cleanup:               strip utm_*/gclid/fbclid; SORT remaining params
5. Fragment removal:            /page#section        → /page
```

**Accuracy caution:** the **path is case-sensitive** on most servers (`/Page` ≠ `/page`) —
lowercase only scheme and host, never the path. Over-normalizing (stripping a *significant*
param like `?id=`) causes **false merges** — two distinct pages collapsed into one.

**The `<meta name="robots">` directive** (page-level, distinct from site-level robots.txt):

| Directive | Fetch? | Index? | Follow links? |
|---|---|---|---|
| (none) | Yes | Yes | Yes |
| `noindex` | Yes (must fetch to see it!) | **No** | Yes (unless also nofollow) |
| `nofollow` | Yes | Yes | **No** |
| `noindex, nofollow` | Yes | No | No |

If a page was indexed two days ago and now returns `noindex`, you **retroactively remove
it** — the owner's current directive wins over stale indexed state.

---

### 🔴 Architect — Storing 100 TB/Day and Rendering JavaScript

**Capacity math for the blob layer:**

```
Volume: 1e9 pages/day × 100 KB = 1e14 bytes/day = 100 TB/day raw.
Write throughput: 100 TB / 86,400 s ≈ 1.16 GB/sec sustained ingest.
Yearly: ~36.5 PB/year raw.
```

| Decision | Choice | Why |
|---|---|---|
| Format | **WARC** (Web ARChive, ISO 28500) | Standard for archived HTTP responses (headers + body + metadata); used by Common Crawl & Internet Archive |
| Storage system | Object store (S3 / GCS; internal equivalents) | Cheap, durable, scalable, sequential-write friendly |
| Metadata index | Wide-column store (Bigtable / Cassandra-lineage) | Row per URL: fetch time, checksum, WARC offset, status |
| Compression | gzip or zstd per record/segment | HTML compresses ~4–6×; 100 KB → ~20 KB → ~20 TB/day stored |
| Batching | Aggregate pages into large WARC segments (100s of MB) | Object stores hate tiny objects |

```
Handling 1.16 GB/sec write:
  - Workers batch pages into large WARC segments locally, then bulk-PUT (large sequential
    writes, NOT 11,600 tiny PUTs/sec).
  - Writes fan out across many prefixes/buckets to avoid hot partitions.
  - Metadata (offset pointers) in a wide-column store keyed by URL-hash for O(1) lookup.
```

**Named tradeoff — Compression Ratio vs CPU.** zstd gives better ratio and speed than
gzip at tuned levels but costs CPU on the write path; at 1.16 GB/sec ingest, compression
CPU is a real budget line — tune the level to balance storage cost against crawler CPU.

**The JavaScript/SPA rendering problem.** A React/Angular SPA ships an empty
`<div id="root"></div>` and builds content via JS. A crawler reading only raw HTML sees
*no content and no links*.

| Approach | Cost | Coverage of JS content |
|---|---|---|
| Raw-HTML only | Cheap | Misses SPA content |
| Headless render (Chromium) | **Very expensive** (CPU/RAM/time per page) | Full |
| Server-side rendering / prerendering (site-side) | Cheap for crawler | Requires site cooperation |

Google historically described **two waves / deferred rendering** — index raw HTML
immediately, render later when compute is available. Since 2019, Googlebot is "evergreen"
(a current, continuously-updated Chromium engine). **Named tradeoff — Coverage vs
Compute:** rendering is orders of magnitude more expensive than parsing, so crawlers
defer/ration it by priority; SSR/prerendering (Next.js, Angular Universal) is the
site-side fix.

**Real-system anchor — Common Crawl.** Common Crawl publishes its crawls as **WARC files
on Amazon S3**, plus WAT (metadata) and WET (extracted text) derivatives, on the order of
billions of pages per monthly crawl. This is the public proof point for the WARC +
object-store design. I am confident Common Crawl uses WARC on S3 with WAT/WET
derivatives; treat the exact per-crawl page count as approximate.

---

## 10. Re-Crawl Freshness Scheduling

### 🟢 Beginner — Check the News Stand Daily, the Library Yearly

A news stand changes every few minutes; a library's reference section barely changes in a
year. It would be silly to check both equally often. A smart crawler watches how often
each page *actually* changes and comes back proportionally: minute-by-minute for breaking
news, once a month for an archived document.

It also uses a cheap trick: instead of re-downloading a whole page to see if it changed,
it asks the server "has this changed since I last saw it?" and the server can answer "no"
in a tiny reply — saving almost all the bandwidth.

---

### 🟡 Senior — The Poisson Change Model and Conditional GETs

Re-crawl balances **freshness** against **budget**. Model each page's changes as a
**Poisson process** with per-page rate λ (changes per unit time):

```
Probability a page changed in time t since last crawl:
    P(changed) = 1 - e^(-λ * t)

Re-crawl priority ∝ P(changed) * importance(page)
```

| Page type | Estimated λ | Re-crawl interval |
|---|---|---|
| News homepage | Very high | Minutes–hours |
| Product price page | High | Hours |
| Blog post | Low | Weeks |
| Archived doc / RFC | ~0 | 30+ days |

**Conditional GETs** avoid re-downloading unchanged pages:

```
GET /article HTTP/1.1
If-None-Match: "abc123"
If-Modified-Since: Wed, 01 Jan 2025 10:00:00 GMT

→ 304 Not Modified   (no body!) → unchanged → skip re-parse/re-index, save bandwidth
→ 200 + new body + new ETag     → changed → process normally
```

| Header | Sent back as | Server responds |
|---|---|---|
| `ETag` | `If-None-Match` | `304` if match, else `200`+body |
| `Last-Modified` | `If-Modified-Since` | `304` if not newer, else `200`+body |
| `Cache-Control: max-age` | (not echoed) | Hints when to even bother checking |

For a 100 KB unchanged page, a 304 transfers ~0 body bytes instead of 100 KB — across
billions of mostly-unchanged pages this slashes re-crawl bandwidth, and the 304/200
outcome feeds back into the λ estimate.

---

### 🔴 Architect — The Change-Rate Estimator and High-Churn Redesign

**The estimator, done right.** "Changed on 3 of the last 10 crawls":

```
Naive: change probability per interval ≈ 3/10 = 0.30

BUT crawling UNDERSAMPLES: if a page changed twice between two crawls, you observe only
"changed once." Observed frequency is a LOWER BOUND on the true λ. The Cho & Garcia-Molina
(2003) bias-corrected estimator:

   λ̂ ≈ -ln(1 - X/n) / interval          (X = observed changes, n = crawls)
   with X=3, n=10:  -ln(1 - 0.3) = -ln(0.7) ≈ 0.357 changes per interval
   → the true rate is HIGHER than the naive 0.30.
```

Translating λ to an interval — pick t to keep P(changed) at a target:

```
Want P(changed) ≤ 0.5:  1 - e^(-λt) ≤ 0.5  →  t ≤ ln(2)/λ
   With λ̂ ≈ 0.357/old-interval → t ≈ 0.693/0.357 ≈ 1.94 old-intervals.
Want fresher (P ≤ 0.2):  t ≤ -ln(0.8)/λ ≈ 0.223/0.357 ≈ 0.63 old-intervals (crawl MORE).
```

**The high-churn failure mode.** A news site publishes 500 articles/hour; the scheduler
assigns a flat 24h interval → breaking news is up to ~24h stale. Root cause: a **single
fixed interval** applied to a high-λ domain. Redesign:

```
1. Per-URL (not per-domain) intervals from historical λ:
   interval(url) = clamp( target_staleness / P(change), MIN_INTERVAL, MAX_INTERVAL )
2. Feed/sitemap-driven discovery: poll RSS/Atom + sitemap <lastmod> frequently (cheap);
   support push (sitemap pings / hub notifications) so new articles are known in minutes.
3. Tiered freshness classes:
   TIER-0 (breaking): re-check homepage/section pages every 1–5 min.
   TIER-1 (fresh articles): minutes-to-hours, decaying as the article ages.
   TIER-2 (archive): days.
4. Budget guardrail: cap the domain's re-crawl QPS so freshness never violates politeness.
```

| Model | News freshness | Budget efficiency |
|---|---|---|
| Fixed 24h interval | ~18–24h stale ❌ | Wastes fetches on static pages |
| Per-URL adaptive (λ-driven) | Minutes ✅ | Spends budget where change happens |
| Feed/sitemap-driven discovery | Near-real-time for new URLs | Very cheap (poll one small file) |

**Named tradeoff — Freshness vs Budget.** The Poisson model sets each page's interval so
budget is proportional to *expected change × importance*. Crucially, the undersampling
bias means you should crawl churny pages **even more often than the naive frequency
suggests**.

**Design-review talking points:**
- "Freshness is per-URL, not per-domain" — a news site's `/about` is static even though
  its homepage churns.
- "Use feeds/sitemaps for *discovery* latency, the λ model for *re-crawl* cadence" — two
  different problems.
- "Conditional GETs make re-crawl nearly free for unchanged pages" — the cheap win.

**Real-system anchor.** Cho & Garcia-Molina ("Effective Page Refresh Policies for Web
Crawlers," 2003, and related "Estimating Frequency of Change") formalized the Poisson
change model and the bias-corrected estimator used here. I am confident these papers exist
and introduce this model; verify exact formula variants against the primary source.

---

## 11. Full Architecture and Failure Modes

### 🟢 Beginner — The Whole Post Office

Zoom out and the crawler is one big, well-run post office: a master to-do list (frontier)
that knows what is urgent and who not to disturb; a fleet of carriers (workers) each
owning their neighborhoods; a memory of every address ever seen (dedup); a filing room for
copies of everything collected (storage); and a scheduler that decides when to revisit.
Every part exists to keep the whole thing fast, polite, and complete.

---

### 🟡 Senior — The End-to-End Architecture

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
          │ HTTP fetcher │──────────────► │ BLOB STORE (WARC) │  (S3/GCS/object store)
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
          ┌────────────────────────────────┐  ┌──────────────┐
          │ METADATA (Bigtable/Cassandra):  │─►│ INDEXER      │
          │ url→{fetch_time, etag,          │  │ (downstream) │
          │ checksum, warc_offset, λ}       │  └──────────────┘
          └────────────────────────────────┘
          RE-CRAWL SCHEDULER reads metadata → re-injects URLs by P(change)×importance
```

| Component | Technology | Why |
|---|---|---|
| URL frontier | Redis (hot slice) + Kafka/disk (bulk), partitioned by domain | Priority + politeness + durability (§2) |
| Dispatcher | Consistent-hash ring (murmur3), decentralized | 1/N remap on membership change (§6) |
| Workers | 500 fetcher machines, domain-partitioned | Local politeness/DNS/robots (§5, §6) |
| DNS | Async resolver pool + per-worker cache | ~116 real lookups/sec after caching (§7) |
| URL dedup | Bloom filter (~9 TB, sharded) + exact set | No false negatives (§3) |
| Content dedup | Checksum + SimHash (Hamming ≤ 3) | Near-duplicate detection (§4) |
| Blob store | WARC on object store, zstd | 100 TB/day (§9) |
| Metadata | Bigtable / Cassandra-lineage | O(1) per-URL lookup, re-crawl state |
| Rendering | Headless Chromium pool (rationed) | SPA/JS pages (§9) |
| Re-crawl scheduler | Poisson λ × importance | Freshness vs budget (§10) |

Talking track: **frontier is the brain; consistent-hash-by-domain makes
politeness/DNS/robots local; Bloom + durable set handles 5T-URL dedup; WARC on object
storage absorbs 100 TB/day; re-crawl is change-probability-driven.**

---

### 🔴 Architect — Failure-Mode Catalog, Capacity Budget, and Security Surface

**Failure-mode catalog** (the questions that separate Senior from Staff):

```
Frontier loss on crash       → durable partitioned log; new owner replays offset (§2, §6)
Redis frontier CPU wall      → shard by domain; O(log N) ZADD saturates one core (§2)
Spider trap / infinite space → per-domain budget + depth cap + pattern detection (§8)
Accidental DDoS (shared host)→ per-domain + per-IP/subnet + per-provider + adaptive (§8)
Stale robots.txt cache       → 24h TTL + conditional GET; 5xx = disallow, 404 = allow (§5)
DNS negative-cache coverage  → short negative TTL, retry transient failures (§7)
Bloom false positive skips   → durable exact-set fallback on the 0.1% "seen" hits (§3)
Boilerplate defeats SimHash  → strip main content before fingerprinting (§4)
High-churn staleness         → per-URL λ intervals + feed/sitemap discovery (§10)
Hostile response (OOM/bomb)  → size cap, parse timeout, decompression-ratio cap, sandbox
```

**End-to-end capacity budget** (all derived / labeled illustrative):

```
Throughput:  1e9 pages/day / 86,400 s ≈ 11,600 pages/sec
Fetch conc.: at ~200 ms avg fetch, need ≈ 11,600 × 0.2 ≈ 2,320 concurrent fetches
             (across 500 workers ≈ ~5 concurrent/worker — I/O-bound, not CPU-bound)
Dedup RAM:   5e12 URLs at 0.1% FP → ~9 TB Bloom, sharded across nodes
Storage:     100 TB/day raw → ~20 TB/day at ~5× compression → ~7.3 PB/year stored
DNS:         ~116 real lookups/sec after caching (vs 11,600 naive) → ~100× reduction
Metadata:    5e12 rows × ~100 B ≈ 500 TB in a wide-column store (illustrative)
```

**Security surface — treat every response as hostile:**

| Threat | Control |
|---|---|
| Huge body / OOM | Response size cap (e.g., 5 MB) |
| Nested-DOM CPU bomb | Parse timeout (1–2 s) + depth limit |
| Decompression bomb | Decompressed-size + ratio cap (e.g., ≤ 100:1) |
| Redirect loop | Max-hops (≤5) + cycle detection |
| Parser exploit | Sandboxed, memory-capped process |
| SSRF to internal services | Block private IP ranges (127.x, 10.x, 169.254.x) |

Naming **SSRF** unprompted (a crawler is a request-forger's dream if it will fetch
`http://169.254.169.254/`) is a strong Staff-level signal.

**Design-review closing points:**
- "Which failures are *silent*?" — Bloom false positives, DNS negative-cache misses, and
  over-normalization all *lose coverage without erroring*. Those need monitoring, not just
  handling.
- "Politeness is enforced at domain, IP, *and* provider levels" — not just per-domain.
- "Every heavy component (dedup, storage, DNS) is sharded/partitioned by domain or
  hash-prefix" — nothing global sits on the hot path.

**Real-system anchor.** Common Crawl (WARC on S3), Googlebot (evergreen Chromium
rendering, RFC 9309 robots handling, documented crawl budget), and the Mercator research
crawler (two-level frontier, async DNS) together validate every major component here. I am
confident about these attributions at the level stated; specific internal numbers for any
proprietary crawler are not publicly verified and are labeled illustrative throughout.

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Crawl loop | Dequeue → resolve → robots → fetch → store → parse → extract → normalize → dedup → enqueue |
| BFS vs DFS | BFS: importance ∝ shallowness + host spread; DFS dies on spider traps |
| Frontier ≠ FIFO | Encodes priority (front queues) + politeness (back queues, one host each) |
| Mercator two-level | Front = prioritization; back = politeness; min-heap on next-fetch-time |
| Priority signals | Source PageRank, in-link count, domain authority, URL depth (OPIC approximates online) |
| Frontier durability | Partitioned log keyed by domain → new owner replays offset; at-least-once |
| Redis frontier wall | ZADD is O(log N) on one thread → shard by domain, don't just pipeline |
| Bloom key property | **No false negatives**; tunable false positives (never the reverse) |
| Bloom math 0.1% | m/n = −ln(p)/(ln2)² ≈ 14.4 bits/URL; k = (m/n)·ln2 ≈ 10; ~9 TB for 5T URLs |
| FP vs FN cost | FP = skip real page (coverage loss, worse); FN impossible in Bloom |
| Dedup fallback | Bloom + durable exact set → verify the ~0.1% "seen" hits → ~0 coverage loss |
| Near-dup detection | SimHash: weighted-bit 64-bit fingerprint; near-dup if Hamming ≤ 3 |
| SimHash at scale | Permuted bit-prefix blocks (Manku 2007) → avoid O(n²) comparison |
| URL normalization | Lowercase scheme+host (NOT path!), drop default port, strip trackers, sort params, drop fragment |
| robots unreachable | 404 = allow all; 5xx/429 = disallow all (conservative); RFC 9309 |
| robots TTL | ~24h; 304 Not Modified → keep rules, reset TTL, no body |
| Crawl-delay | Non-standard; Google ignores; take max(yours, robots) but cap extremes |
| 429 Retry-After | Halt host the stated seconds, requeue URL, probe, then exp backoff + jitter |
| Hash by eTLD+1 | One worker owns politeness/DNS/robots locally; 1/N remap on change |
| Worker crash recovery | Durable domain-partitioned log → new owner replays → no loss |
| Hot domain | Bounded sub-partition across S workers + shared token bucket for that domain |
| DNS at scale | Naive 11,600/sec blocks; per-worker cache → ~116 real lookups/sec; async pool |
| DNS negative caching | Caching NXDOMAIN can skip a real new domain; short negative TTL, retry transient |
| Crawler trap defense | Per-domain budget (best) + depth cap + pattern detection + content SimHash |
| Accidental DDoS fix | Per-domain + per-IP/subnet + per-provider limits + adaptive back-off |
| Content pipeline | Store raw BEFORE parse; honor `<base href>`; noindex retroactively removes |
| meta robots | noindex = don't index (remove retroactively); nofollow = don't enqueue; must fetch to see |
| JS/SPA rendering | Headless Chromium (evergreen Googlebot); expensive → deferred/rationed; SSR is site-side fix |
| Storage 100 TB/day | WARC on object store, zstd, batched large segments; wide-column metadata |
| Re-crawl model | Poisson: P(changed) = 1 − e^(−λt); re-crawl ∝ P(change) × importance |
| Re-crawl estimator | Cho–Garcia-Molina: λ̂ ≈ −ln(1−X/n)/interval; undersampling → crawl churny pages more |
| High-churn news | Per-URL adaptive intervals + feed/sitemap discovery + tiered freshness |
| Conditional GET | ETag/Last-Modified → 304 = ~0 body bytes for unchanged pages |
| Parser security | Size cap 5 MB, parse timeout, decompression-ratio cap, redirect cap, sandbox, SSRF guard |
| Silent failures | Bloom FP, DNS negative-cache, over-normalization lose coverage without erroring — monitor them |
| Real systems | Googlebot (evergreen Chromium, RFC 9309), Common Crawl (WARC on S3), Mercator (frontier + async DNS) |
