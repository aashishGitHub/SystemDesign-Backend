# Answers: Search Autocomplete / Typeahead

> Keyed to [questions.md](./questions.md). Attempt each question cold first.
> Code examples use TypeScript-style pseudocode; Redis examples use real commands.
> ⚠️ Capacity numbers are **illustrative order-of-magnitude** estimates for reasoning, not exact figures — they depend on language, encoding, and data distribution.

---

## Level 1 — Fundamentals & Data Structures

### A1. What autocomplete is + the "type 'a'" walkthrough
Autocomplete (typeahead) returns the top-K most likely **completions** of a prefix, ranked by popularity/relevance, within a tight latency budget (usually **< 100 ms** so it feels instant while typing).

Typing "a" → 5 suggestions:
```
1. Browser debounces keystrokes (~100–300 ms) so it doesn't fire on every char
2. GET /autocomplete?q=a  → nearest edge / API gateway
3. Gateway → autocomplete service (with auth, rate limit)
4. Service checks Redis prefix cache  → HIT: return top-5 immediately
                                       → MISS: query the trie service
5. Trie service walks to the node for "a", reads its precomputed top-5 list
6. (Optional) blend with user's personal history + apply safety filter
7. Response (5 strings) → browser renders dropdown
```
The design pressure is **latency** — every hop must be cheap, which is why results are **precomputed** (top-K stored at nodes) rather than computed per request.

### A2. Why a hash map isn't enough
A hash map gives **O(1) exact-key** lookup but has **no notion of prefixes** — keys are scattered by hash, so "find all queries starting with 'app'" would require scanning **every** key. A **trie** stores strings by shared prefix along a path, so reaching the "app" node is **O(length of prefix)** and everything under it is exactly the set of completions. The trie encodes the *prefix relationship* structurally; the hash map destroys it.

### A3. Prefix-lookup complexity by structure
| Structure | Prefix lookup | When to choose |
|---|---|---|
| **Trie** | **O(L)** (L = prefix length), independent of N | Prefix search, autocomplete — the default |
| **Sorted list + binary search** | O(L · log N) to find range start, then scan matches | Small/static datasets; simpler than a trie |
| **Hash map** | O(L) for **exact** key; **can't** do prefix (O(N) scan) | Exact-match lookups only, never prefix |

Trie wins because lookup cost depends on **prefix length, not corpus size** — 10 queries or 10 billion, "app" is the same 3 hops.

### A4. Trie node structure
```ts
class TrieNode {
  children: Map<char, TrieNode>; // or fixed array[26/128] for known alphabet
  isEndOfWord: boolean;          // true if a stored query ends here
  topK: SuggestionRef[];         // precomputed top-K completions under this node
  // optional: frequency (if this node is itself a complete query)
}
```
- **Internal node:** has children, `isEndOfWord=false` (a prefix, not itself a query).
- **Leaf / end node:** `isEndOfWord=true`; may have no children (e.g., "apt") or children (e.g., "app" is both a word and a prefix of "apple").

### A5. (Failure mode) Single in-memory Python trie at 5K req/s — three failures
1. **No redundancy / SPOF:** one process crash = total autocomplete outage; a restart reloads the whole trie (cold start, A10).
2. **Concurrency / GIL bottleneck:** a single Python process can't use multiple cores for CPU-bound traversal; under 5K req/s, tail latency (P99) blows past the 100 ms budget.
3. **Memory ceiling + no update path:** the full trie may not fit; and there's no pipeline to keep it fresh — suggestions go stale, and rebuilding blocks reads.

Fix: replicated, sharded, precomputed top-K served from a read-only trie + Redis cache, with a separate update pipeline.

---

## Level 2 — Trie Design

### A6. Inserting `["apple", "app", "application", "apt"]`
```
        (root)
          │ a
          a
          │ p
          p
        ┌─┴──────────┐
        p(t)         t★(apt)
        │★(app)
        l
        │
        e★(apple)
        │
        (…c-a-t-i-o-n)★(application)
```
Insert order doesn't change the final structure. `isEndOfWord` (★) marks nodes where a stored query **terminates**: it's `true` at the `app`, `apt`, `apple`, and `application` end-nodes, and `false` at the shared prefix nodes (`a`, `ap`, `appl`, …). Crucially, "app" being a word **and** a prefix of "apple" is why you need an explicit `isEndOfWord` flag rather than "leaf = word."

### A7. Returning suggestions for "app"
```
1. Walk root → a → p → p   (O(L), L=3). If any char is missing → trie miss (A35).
2. At the "app" node, read its precomputed topK list (O(1)).
3. Return topK[:5].
```
Precomputing top-K at the node avoids traversing the (potentially huge) subtree per request. Without precompute you'd DFS the whole subtree and heap-select top-K on every keystroke (A11 — too slow).

### A8. Memory per trie node
Illustrative (language/encoding dependent):
| Field | ~Bytes |
|---|---|
| `children` map (overhead + entries) | ~50–150 (huge variable — a hashmap per node is the dominant cost) |
| `isEndOfWord` | 1 (often padded) |
| `topK` (5 × 4-byte IDs) | ~20 |
| object/GC header | ~16 |

So **~100–200 bytes/node** in a managed runtime. **Branching factor** matters enormously: a fixed `array[26]` of pointers wastes space on sparse nodes (26 × 8 = 208 bytes even for one child) but is fast; a `Map` is compact for sparse nodes but adds per-entry overhead. This is why compression (A9) matters at scale.

### A9. Compressing the trie
| Technique | Idea | Tradeoff |
|---|---|---|
| **Radix / Patricia trie** | Merge chains of single-child nodes into one edge holding a substring | Far fewer nodes; slightly more complex insert/split logic |
| **DAWG** (directed acyclic word graph) | Also **share common suffixes** (merge equivalent subtrees) | Minimal memory; **hard to mutate** (near read-only) and can't easily store per-node top-K/freq |
| **Double-array trie** | Compact array encoding | Very cache-friendly, memory-lean; complex to build/update |

Named tradeoff: **memory vs. update flexibility**. DAWG is smallest but effectively immutable — fine for a **static, rebuilt-offline** dictionary, bad if you mutate in place. Most large systems build a compact **read-only** structure offline and hot-swap it (A21).

### A10. (Failure mode) 8 GB trie load on restart — first 90 s
During load the server can't serve (or serves cold/empty) → **elevated latency/errors** right after deploy, and if many replicas restart together (rolling deploy), a **capacity dip** cascades.
Mitigations:
- **Rolling restarts** (never all at once) so healthy replicas absorb traffic.
- **Readiness probes** — don't add a server to the LB until the trie is loaded.
- **Memory-map** the trie file (mmap) so it's paged in lazily instead of a 90 s blocking load.
- **Warm standby / pre-warmed instances** swapped in.
- **Snapshot format** optimized for fast load (mmap-able flat structure, not object graph deserialization).

---

## Level 3 — Top-K Storage & Retrieval

### A11. Why per-request DFS is too slow
For a short prefix like "a", the subtree can contain a huge fraction of all queries. With **10M unique prefixes** and a broad subtree, a DFS + top-K heap could touch **millions of nodes** per request. At **5K req/s**, that's billions of node visits/sec — impossible under a 100 ms P99. Cost per request scales with **subtree size**, which is exactly backwards (short prefixes = biggest subtrees = most traffic). Precomputing top-K makes each request **O(L)** regardless of subtree size.

### A12. Top-K stored at each node
Each prefix node stores its **precomputed top-K completions** (as string IDs + score), computed offline from frequency data. On query, you walk to the node (O(L)) and return its list (O(1)) — no traversal. It trades **memory** (top-K × every node) for **query speed** (constant-time read). This is the central optimization of production autocomplete.

### A13. Updating top-K when a query surges
When "earthquakeSF" jumps rank, its **new score must propagate to the top-K list of every ancestor prefix node** along its path: `e, ea, ear, …, earthquakeSF`. Worst case = **O(L)** ancestor lists to re-evaluate (L = query length), each a cheap top-K merge. In a **batch/offline rebuild** you don't do this incrementally at all — you recompute lists during the periodic rebuild. Incremental updates are only needed for **real-time trending** (A18), and even then you update O(L) ancestors, not the whole trie.

### A14. Full string vs. ID pointer in each node
Store an **ID/pointer into a shared string table**, not the full string, in each node's top-K.
| | Full string per node | ID → string table |
|---|---|---|
| Memory | Duplicated across every ancestor's top-K → huge | Stored once; nodes hold 4-byte IDs |
| Lookup latency | Zero indirection | One extra table lookup (cheap, cache-friendly) |
Named tradeoff: **memory vs. one indirection**. At scale the memory savings dominate — a popular query appears in the top-K of *all its prefixes*, so deduping via a string table is a big win.

### A15. Progressive filtering "p"→"pr"→"pro"→"prog"
Each keystroke *can* be a fresh trie lookup (each is still O(L) and cheap). But because results for a longer prefix are a **subset** of the shorter prefix's matches, the client can **filter locally** once it has a superset. Tradeoff:
- **Fresh lookup per keystroke:** always correct/fresh, but N requests + network cost.
- **Client-side progressive filter:** fewer requests, instant feel, but can go stale and can't surface items that weren't in the original superset (ranking may differ at deeper prefixes).
Common hybrid: fetch on short prefixes, filter locally for a few extra chars, re-fetch periodically. **Debouncing** reduces request volume either way.

### A16. (Failure mode) Top-K lists 3 hours stale
Users see **outdated rankings** — trending/new queries missing, recently-popular items ranked too low. It's usually **degraded, not broken** (old suggestions are still valid). Graceful design: serve stale suggestions (they're better than none), **alert on pipeline lag** (freshness SLO), show a freshness metric internally, and ensure the trie is **immutable+versioned** so a stuck pipeline never corrupts the served copy — it just ages. Autocomplete should **fail soft**.

---

## Level 4 — Update Pipeline

### A17. Full freshness pipeline + latency budgets
```
User search  → search log event
  → Kafka (ingest)                         [~seconds]
  → Stream processor (Flink/Spark) aggregates counts by query, windowed  [seconds–minutes]
  → Ranked frequency table (per query, per region)                        [minutes]
  → Trie build job (recompute top-K at nodes) OR incremental update        [minutes]
  → New trie snapshot published → hot-swapped into serving replicas        [minutes]
  → Redis prefix cache invalidated/refreshed                               [seconds]
Total: well within a 1-hour trending SLA
```

### A18. Batch vs. streaming update
| | Batch (rebuild every N hours) | Streaming (continuous) |
|---|---|---|
| Freshness | Hours | Seconds–minutes |
| Complexity | Low (offline job, simple) | High (stateful stream jobs, incremental trie updates) |
| Use when | Suggestions change slowly | Trending/breaking-news matters |

A **"1-hour trending SLA"** sits in between: a **frequent batch rebuild** (e.g., every 15–30 min) usually satisfies it without full streaming complexity. True second-level trending (breaking news) requires **streaming**. State the SLA-driven choice explicitly rather than defaulting to streaming.

### A19. Kafka + Flink/Spark design
- **Topic `search-events`**: key = **query string** (so all events for a query land on the same partition → correct per-query counts), partitioned by hash(query), retention short.
- **Flink job**: keyBy(query) → **windowed count** (tumbling or sliding, e.g., 15-min tumbling for periodic, or sliding for trending) → emit `(query, count, window)` to a `query-frequencies` topic/table.
- **Ranking job**: aggregate windows, compute per-prefix top-K, write the ranked table the trie-builder consumes.
- Partitioning by query keeps counting **accurate and parallel**; windowing bounds the "trending" horizon.

### A20. Preventing a viral query from skewing the pipeline
- **Partition by query** so one hot query lands on **one** partition — but that creates a **hot partition** (A24-style). Mitigate with **local pre-aggregation / combiners** (count locally per task before shuffling) so the hot key sends *aggregated* counts, not millions of raw events.
- **Approximate counting** (Count-Min Sketch / HyperLogLog) to bound memory for heavy hitters.
- **Rate-limit/sample** ultra-high-frequency keys — you don't need exact counts to know it's #1.
The viral query gets counted correctly **without** starving aggregation for other queries.

### A21. Deploying a new trie with no read outage (hot-swap / blue-green)
Build the new trie **off to the side**, then atomically switch reads to it:
```
1. Builder produces trie snapshot v(n+1) → object store
2. Each serving replica downloads v(n+1) into memory (still serving v(n))
3. Atomic pointer swap: activeTrie = v(n+1)   (single reference assignment)
4. Old v(n) freed after in-flight requests drain
```
Because the switch is a **pointer swap** to an already-loaded immutable structure, there's **zero read downtime**. Roll it out replica-by-replica; keep old snapshots for rollback (BQ3).

### A22. (Failure mode) Flink crash at 2 AM, 6 h stale, news at 3 AM
Users type the breaking-news query and see **no/irrelevant suggestions** (it's not in the stale trie) — degraded but not down; existing suggestions still work.
Incident response:
1. **Detect:** freshness-lag alert (pipeline watermark / trie age SLO) should have paged at ~30–60 min lag, well before 6 h — first fix is *the missing alert*.
2. **Mitigate:** restart Flink from its last **checkpoint** (exactly-once state), or fail over to a standby job; if state is lost, backfill from Kafka retention.
3. **Backpressure/backfill:** replay retained events to catch up.
4. **Communicate:** note degraded trending in status.
5. **Post-mortem:** add job HA (checkpointing + standby), freshness-lag paging, and a manual "inject trending query" break-glass tool.

---

## Level 5 — Distributed Scale

### A23. Replication vs. sharding
| Direction | Solves | Choose when |
|---|---|---|
| **Replication** (full copy per server) | Throughput + HA | The trie **fits** in one server's memory; you just need more QPS/redundancy |
| **Sharding** (split trie across servers) | Memory (trie too big for one box) | The trie **doesn't fit** in one server |

They're not exclusive: **shard for memory, replicate each shard for QPS/HA**. Start with replication (simpler); shard only when memory-bound.

### A24. Sharding a trie across 5 servers
| Strategy | How | Hotspot risk |
|---|---|---|
| **First-character** | shard by first letter (a–e, f–j, …) | **Severe skew** — far more queries start with 's' than 'z'; uneven load/memory |
| **Prefix-range** | balanced ranges tuned to traffic (split hot ranges finer) | Better balance, but needs a routing map and rebalancing |
| **Consistent hashing on prefix** | hash(prefix) → shard | Even distribution; but **breaks prefix locality** (adjacent prefixes scatter) and a query may need routing by its short prefix |

A common answer: **route by a short prefix (first 1–3 chars) via a balanced range map**, keeping each prefix's subtree on one shard so a lookup hits a single server; rebalance hot ranges. Name the skew risk explicitly.

### A25. Why Redis in front + what it stores
Most keystrokes are for **popular prefixes** (heavy head of the distribution), so a cache serves the majority of traffic from memory in ~1 ms, slashing P99 and offloading the trie servers.
Two common Redis models:
```
# Model A: one sorted set PER PREFIX, top-K by frequency score
ZADD ac:sea 9500 "seattle weather" 9000 "search" 8000 "seahawks"
ZREVRANGE ac:sea 0 4 WITHSCORES        # top-5 for "sea"

# Model B: single sorted set, lexicographic ranges (all scores equal)
ZADD queries 0 "seattle" 0 "search" 0 "seahawks"
ZRANGEBYLEX queries "[sea" "[sea\xff"  # all members with prefix "sea"
```
Model A gives **precomputed top-K per prefix** (fast, but more keys); Model B is compact but you still rank client-side. Model A mirrors the "top-K at node" design and is the usual pick for ranked autocomplete.

### A26. Full read path for "sea" (with latency)
```
Browser (debounce)                                   [~150 ms wait, not server time]
→ nearest edge / API gateway                         [~10–20 ms RTT]
→ autocomplete service (auth, rate limit)            [~1 ms]
→ Redis prefix cache GET ac:sea                      [~1 ms]  HIT → return
     ↓ MISS
→ trie service: route by prefix → walk to "sea" node [~1–5 ms]
→ (blend personal history + safety filter)           [~1–3 ms]
→ populate Redis, return                             [~1 ms]
Total server time: ~5–25 ms (well under 100 ms P99)
```
The debounce dominates *perceived* time; server work is small because everything is precomputed/cached.

### A27. Cache eviction + the long-tail problem
**LRU** is standard, but it **evicts long-tail prefixes** repeatedly — a rare prefix is fetched, evicted before reuse, fetched again → constant misses for the tail while the head stays hot. Fixes:
- **LFU** (frequency-aware) so genuinely popular-but-bursty items survive.
- **Two-tier / segmented LRU** (protect a "hot" segment).
- **Admission control** (e.g., TinyLFU) so a one-off tail request doesn't evict a useful hot item.
- Accept tail misses (they hit the fast trie anyway) and size the cache for the head. Named tradeoff: **hit ratio for the head vs. churn for the tail**.

### A28. (Failure mode) Redis split-brain, half stale by 4 h
Users get **inconsistent suggestions** depending on which half they hit — freshness flip-flops (violates monotonic reads); some see 4-h-old rankings, some current, unpredictably.
- **Detect:** embed a **build/version timestamp** in cached entries (or a per-shard `trie_version` key); alert when shards disagree; monitor replication health.
- **Resolve:** stop the split (fence the minority, restore quorum), then **flush the stale half** and let it refill from the current trie; prefer serving from the trie (source of truth) until caches reconcile.
- **Design:** tag cache entries with the trie version so a client/service can **detect and reject stale-version** entries rather than trusting the cache blindly.

---

## Level 6 — Personalization & Filtering

### A29. Blending global top-K with personal history
Fetch **global top-K** from the trie/cache, fetch the user's **recent searches** (stored per-user in a fast KV store / Redis, or a small on-device history), then **merge and re-rank** with a weighted score:
```
score(s) = w_global · globalScore(s) + w_personal · personalScore(s) + w_recency · recency(s)
```
Personal history is per-user data (privacy-sensitive) kept in a user profile store; blending happens at the service layer (or partly client-side for privacy). Keep personalization a **re-rank on top of** the global set so it degrades to global if personal data is unavailable.

### A30. When personalization becomes harmful
Over-biasing (a single past "Python tutorial" dominating *all* future suggestions) creates a **filter bubble** and **stale intent** — the user moved on but suggestions haven't. Harm points: (1) recency decay missing (old searches weigh too long), (2) narrow topical lock-in suppressing exploration, (3) surprising/creepy suggestions hurting trust, (4) context mismatch (work vs. personal). Fix with **recency decay**, a **cap on personal weight**, and always blending in global results so the user isn't trapped.

### A31. Filtering profane/illegal suggestions — two enforcement points
| Point | How | Tradeoff |
|---|---|---|
| **Build-time (offline)** | Exclude blocklisted/regex-matched queries when building the trie | Cheap at query time; **slow to update** (needs rebuild) — bad for emergencies |
| **Serve-time (runtime)** | Filter against a fast denylist (Redis/bloom) on every response | **Instant updates**, but adds per-request cost and must be applied everywhere |

Use **both**: build-time for the bulk, serve-time for emergency/legal takedowns (A32). Named tradeoff: **update latency vs. per-request cost**.

### A32. (Failure mode) Emergency legal takedown in 15 min
With build-time filtering only, a rebuild is too slow. So rely on the **serve-time denylist**:
```
1. Add "celebrity leaked photos" (+ variants/normalized forms) to the runtime denylist (Redis set / config)
2. Denylist change propagates to all serving replicas + edge within seconds (pub/sub)
3. Every response is filtered against the denylist → the query is suppressed globally immediately
4. Invalidate any cached Redis entries containing it
5. Queue it for permanent removal in the next trie build
```
This is exactly why the **serve-time enforcement point** must exist — it's your break-glass control. Track propagation acks to confirm global coverage within the 15-min window.

---

## Level 7 — Operations & Failure Modes

### A33. Five metrics to alert on
| Metric | Example threshold |
|---|---|
| **P99 latency** | alert if > 100 ms for 5 min |
| **Error rate** (5xx / timeouts) | alert if > 0.5% |
| **Cache hit ratio** | alert if < 90% (drop signals cache/routing issue) |
| **Trie freshness / pipeline lag** | alert if trie age > 60 min (SLA breach) |
| **QPS anomaly** | alert on sudden spike/drop (traffic shift, event, or outage) |
Bonus: **suggestion empty-rate** (fraction of requests returning 0 suggestions) catches trie-miss regressions.

### A34. Cache stampede in autocomplete
A hot prefix's cache entry expires → many concurrent requests miss and hit the trie/backend simultaneously (thundering herd). Prevention:
- **Mutex / single-flight:** the first miss acquires a lock and refills; others wait for it or serve the previous value → only **one** backend fetch per key.
```
if (!cache.has(k)) { if (lock.acquire(k)) { v = trie.get(k); cache.set(k); lock.release(k); } else serveStaleOrWait(); }
```
- **Probabilistic early expiry** (XFetch): refresh *before* TTL with a probability rising as expiry nears, so entries refresh **staggered** instead of all at once.
- **`stale-while-revalidate`**: serve stale, refresh async.

### A35. Trie misses (prefix not present)
When the walk fails (new phrase, typo), options:
- **Fuzzy fallback:** edit-distance / n-gram matching to suggest near prefixes ("did you mean").
- **Backoff:** drop the last char(s) and suggest for the shorter valid prefix.
- **Empty + graceful UX:** show nothing rather than wrong guesses (empty dropdown is acceptable).
- Log the miss → feeds the update pipeline so genuinely new popular phrases enter the trie next build.
User experience: ideally a helpful fuzzy suggestion; at worst, an empty dropdown (never an error).

### A36. (Failure mode) 100× spike in 90 s (event ends)
Cascade: QPS spike → cache miss surge on new trending prefixes → trie/backends overload → latency ↑ → timeouts/retries → **retry storm** → wider overload.
Load-shedding / circuit-breaker strategies:
1. **Rate limiting / load shedding** at the gateway — cap QPS per client/region, shed excess with a fast empty/cached response rather than queueing.
2. **Circuit breaker** to the trie service — on rising errors, trip open and **serve stale cache** (fail soft) instead of hammering an overloaded backend.
3. **Serve degraded results** — return cached/global top-K only (skip personalization + real-time trending) to cut per-request cost; scale replicas out; add jitter+backoff to client retries to break the storm.

---

## Level 8 — Architect-Level

### A37. Full end-to-end design (Google scale)
**Read path:** Browser (debounce) → CDN/edge → API gateway (auth, rate limit) → autocomplete service → **Redis prefix cache** (head of distribution) → on miss, **sharded+replicated trie** (route by short prefix) → **blend personal history** → **safety filter (serve-time denylist)** → response. Budget < 100 ms P99, mostly cache/precomputed.

**Write/update path:** search logs → **Kafka** → **Flink** windowed aggregation (keyBy query, local combiners for hot keys, approx counting) → per-prefix top-K ranking → **offline trie build** (compact, immutable snapshot) → **hot-swap** into replicas (pointer swap) → invalidate Redis. Frequent batches for the trending SLA; streaming layer for breaking news.

**Personalization:** per-user history in a fast KV store; **re-rank** global results with decayed weights; degrade to global if unavailable.

**Filtering:** build-time exclusion for the bulk + **serve-time denylist** for emergency/legal takedowns (propagate in seconds).

**Multi-region:** replicas + caches per region for latency; regional frequency tables (local trends) + global fallback; trie snapshots replicated to each region; short DNS/edge TTL for failover. Version + retain snapshots for fast rollback.

### A38. (Capacity math) 10M unique prefixes, top-5/node
> Illustrative — depends on avg query length, sharing, and encoding.
- **(a) Nodes:** with ~10M unique queries averaging ~15–20 chars and heavy prefix sharing, expect on the order of **~10^8 nodes** (tens to ~200M) — far fewer than length×count due to shared prefixes.
- **(b) Memory/node:** ~100 bytes (children map + flags + 5 × 4-byte IDs + object header) — see A8.
- **(c) Cluster memory:** ~200M × 100 B ≈ **~20 GB** for nodes, plus a shared **string table** (10M strings × ~30 B ≈ 300 MB). Round to **tens of GB** → doesn't fit comfortably on one commodity box → **shard** (or use a compact double-array/radix structure to fit fewer, bigger nodes).
- **(d) Servers at 5K req/s:** lookups are O(L) microsecond-scale, so a single replica handles **many thousands** of QPS — **CPU is not the constraint**; **memory and HA are**. So: shard for the ~tens-of-GB footprint (say 2–3 shards) × **≥2–3 replicas each** for HA/headroom ⇒ on the order of **~6–9 servers**, plus the Redis cache tier. Justify by *memory + redundancy*, not raw QPS.

---

## Bonus — Unprompted Senior Questions

### ABQ1. CTR-by-position feedback loop
Measure **click-through rate per suggestion position** — if position 1 is chosen 60% of the time, that's signal. Feed CTR back into **ranking weights** so suggestions optimize for *what users actually pick*, not just raw frequency. Almost nobody volunteers this closed feedback loop; it shows product+systems thinking.

### ABQ2. Rollback plan for a bad trie (filtering regression)
If a new build serves offensive suggestions (filter regression), you need a **fast rollback**: revert the active pointer to the **previous trie snapshot** in minutes, plus the **serve-time denylist** as an immediate stopgap while rolling back. State an explicit **RTO** (e.g., < 5 min) and that rollback is a pointer swap to a retained snapshot.

### ABQ3. Versioning trie snapshots
**Keep the last N trie builds** (e.g., 5) in the object store so you can roll back to any recent good build in **under ~2 min**. Versioning also enables A/B of ranking changes and safe canary of new builds. This "data versioning / scar tissue" answer signals real production ownership.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Trie lookup | O(L) in prefix length, independent of corpus size |
| Why not hash map | Hash map has no prefix relationship → O(N) scan for prefixes |
| `isEndOfWord` | Distinguishes "app" (word) from "app" (prefix of apple) |
| Top-K at node | Precompute completions per prefix → O(1) read, no subtree DFS |
| ID vs string in node | Store IDs into a shared string table → dedupe memory |
| Radix / DAWG | Compress single-child chains / shared suffixes; DAWG ≈ read-only |
| Redis model | ZSET per prefix, ZREVRANGE for top-K by frequency |
| Cache long-tail | LRU churns tail → use LFU/TinyLFU admission |
| Update pipeline | logs → Kafka → Flink windowed counts → rebuild trie → hot-swap |
| Batch vs stream | Batch for slow-changing; streaming for breaking-news trending |
| Hot key in pipeline | Local combiners + approx counting so one viral query can't skew |
| Hot-swap deploy | Load new immutable trie, atomic pointer swap → zero read outage |
| Shard vs replicate | Shard for memory, replicate for QPS/HA |
| First-char shard | Skewed ('s' ≫ 'z') → use balanced prefix-range routing |
| Emergency takedown | Serve-time denylist propagates in seconds (break-glass) |
| Trie miss | Fuzzy/backoff fallback or empty dropdown — never an error |
| Cache stampede | Single-flight mutex + probabilistic early expiry + SWR |
| Spike load-shed | Rate limit + circuit-break to stale cache + drop personalization |
| Capacity | ~10^8 nodes × ~100B ≈ tens of GB → shard; bound by memory not QPS |
| Freshness SLO | Alert on trie age > SLA; autocomplete must fail soft |
