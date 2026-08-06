# Use Cases for Caching

Caching keeps a **copy of an answer closer to the asker** so the expensive path (disk, network, another region, a recomputation) is skipped. It buys **latency** and **capacity** — and it pays for them with **staleness**.

- **Cache:** a *disposable, lossy, faster* copy of data whose home is somewhere else.
  - *In plain words:* the **sticky note on your monitor** with the phone number you keep dialling. The real number lives in your contacts; the sticky note is just faster. Lose it and nothing is destroyed — you look it up again.
  - *Example:* a product page held in Redis for 30 s so 10⁶ views/s don't become 10⁶ database queries/s.
- **Replica:** an *authoritative, durable* copy of data, kept for **availability and safety**.
  - *In plain words:* the **photocopy in a second filing cabinet** — as real as the original, and you can be held to it.

> **One-line difference to remember:** *A **replica** is a copy you are allowed to trust. A **cache** is a copy you are allowed to lose.* Losing a replica is a **durability** incident; losing a cache is a **capacity** incident (your origin suddenly eats 100% of traffic — which is often the bigger outage).
>
> The two dials for caching are **hit ratio** (how often you avoid the origin — sets your *capacity*) and **freshness window** (how stale an answer may be — sets your *correctness budget*). Say both numbers before you design.

>
> **How to use this in the repo:** this is the **use-case index** for *§9 Distributed Cache* and *§22 Which Caching Strategy Fits?* in [`key-technologies-notes.md`](../key-technologies-notes.md). Concept depth lives in [`interviews/distributed-caching/`](../interviews/distributed-caching/) (strategies, eviction, Redis internals, invalidation, failure modes) and [`interviews/cdn-edge/`](../interviews/cdn-edge/) (the edge tier). Each system below is cross-linked to its topic folder in the table at the end.
>
> **Companion doc:** [`Use_Cases_for_Redundancy_and_Replication.md`](./Use_Cases_for_Redundancy_and_Replication.md). The 17 numbered systems in §2 below are **the same systems, in the same order** as that doc's matrix — so row 8 is Netflix in both. Read a system's two rows together and you have its whole data-movement story: *replication = how it stays correct when machines die; caching = how it stays fast when users arrive.* Third in the series: [`Use_Cases_for_Proxies.md`](./Use_Cases_for_Proxies.md) — *how traffic reaches it safely.* Plus [`Use_Cases_for_Databases.md`](./Use_Cases_for_Databases.md).
>
> ⚠️ **Accuracy note (read before quoting):** the specific *system → technology* mappings are **illustrative teaching heuristics**, not verified current architectures. Vendor architectures change and much of what's public is dated. Trust the **patterns**; verify the **tech** against primary sources before citing it as fact.

---

## 1. Core Caching Concepts

```
                    [ Client Request ]
                            │
                            ▼
                   ┌─────────────────┐
                   │   Cache Lookup  │
                   └────────┬────────┘
                     ┌──────┴──────┐
                   HIT             MISS
              (~0.1–1 ms)     (fill the cache)
                     │               │
                     │               ▼
                     │      [ Origin: DB / service ]
                     │        (~10–100 ms, limited QPS)
                     │               │
                     ▼               ▼
                  [ Response ]  ◄────┘
```

*Read the diagram as a story:* every read asks the **cache** first. A **hit** returns in well under a millisecond and never touches the origin. A **miss** pays full price *and* does the extra work of populating the cache. So the cache's job is to make the miss path **rare** (hit ratio) and to make sure a burst of simultaneous misses can't kill the origin (stampede control).

### A. Cache Effectiveness Metrics — *"how good must it be?"*

These are the **requirements** you agree on *before* designing. They decide how much cache you need and how stale it may be.

- **Hit ratio:** the fraction of reads served by the cache. This is the *capacity* number.
  - *In plain words:* **"out of 100 questions, how many can I answer without asking the boss?"**
  - *Recall — the maths that matters:* origin load = `QPS × (1 − hit_ratio)`. At 10⁶ reads/s, a **99%** hit ratio still leaves **10,000 QPS** on your database. At **99.9%** it's 1,000. **The last nine is the one that saves you** — this is why read-heavy designs quote hit ratios with decimals.
- **Freshness window (max staleness):** the longest a client may see an out-of-date answer. This is the *correctness* number.
  - *In plain words:* **"how out-of-date may this answer be before it's a bug?"**
  - *Example:* a product **price** badge tolerates ~30 s (cosmetic); a driver's **GPS position** used for matching tolerates ~5 s (any older and you dispatch to the wrong place); a **payment ledger** balance tolerates **0** (never cache it).
- **Working-set size vs memory:** how much of the hot data actually fits in RAM.
  - *In plain words:* **"is my desk big enough for the files I use every day?"**
  - *Why it matters:* hit ratio is a **cliff, not a slope**. When the working set outgrows memory, eviction starts thrashing and the hit ratio collapses far faster than the memory shortfall suggests.

> 🎯 **The two dials, connected:** **hit ratio is sized by your working set and eviction policy**; **freshness window picks your invalidation strategy** (0 → don't cache, or make the key immutable). Quote both, then the design follows.

### B. Write Strategies — *"who writes to the cache, and in what order?"*

This is the biggest fork. It's about **how the cache and the origin stay in step**.

1. **Cache-aside (lazy loading)** — *the default; assume this unless you say otherwise.*
   - **How it works:** the **application** checks the cache; on a miss it reads the origin, then puts the value in the cache. Writes go to the origin and **delete** the cache key.
   - *In plain words:* **you check your sticky note; if it's not there you look it up and write a new sticky note.**
   - *Real tech example:* app code + Redis/Memcached — the overwhelmingly common pattern.
   - *Pick it when:* read-heavy, and you can tolerate the first request after a write being a miss.
   - **Trade-off:** simple, cache failure is survivable (you just get slow), and you only cache what's actually asked for. But every miss is a **latency spike**, and the delete-vs-update race is a real source of stale entries.

2. **Read-through** — same laziness, but the **cache** does the fetching.
   - **How it works:** the app only ever talks to the cache; the cache library/proxy fetches from the origin on a miss.
   - *In plain words:* **you ask your assistant, and they look it up if they don't know.**
   - *Real tech example:* a CDN pulling from origin; a DAX-style proxy in front of a database; an engine's internal block cache.
   - *Pick it when:* you want the caching logic in one place instead of scattered through app code.
   - **Trade-off:** cleaner app code, but the cache is now on the critical path for *correctness*, not just speed.

3. **Write-through** — write both, synchronously, before acking.
   - **How it works:** a write updates the **cache and the origin together**; the client isn't told "success" until both are done.
   - *In plain words:* **update the sticky note and the contacts app before telling anyone it's done.**
   - *Pick it when:* the writer must immediately read its own write (session state, a profile edit, a user's notification preference).
   - **Trade-off:** no stale window and no post-write miss — but **slower writes**, and you cache data nobody may ever read.

4. **Write-back (write-behind)** — write the cache now, the origin later.
   - **How it works:** the write lands in the cache and is acknowledged; a background flush persists it to the origin in batches.
   - *In plain words:* **jot it on the sticky note now, update the real system tonight.**
   - *Pick it when:* write-heavy and a small loss window is acceptable — high-frequency counters, view counts, "last seen at."
   - **Trade-off:** the fastest writes and huge write coalescing — but a cache node death **loses acknowledged data**. This is the one strategy where the cache holds data you can't recover. Say the loss window out loud when you propose it.

5. **Write-around** — write the origin only; let reads populate the cache.
   - **How it works:** writes bypass the cache entirely (and usually invalidate the key); the next read fills it.
   - *Pick it when:* written-once-read-rarely data, or volatile values behind a short TTL, where write-through would just churn the cache.
   - **Trade-off:** keeps the cache dense with *read* data; costs a miss on the first read after each write.

6. **Refresh-ahead (precompute / materialize)** — never let the user pay for a miss.
   - **How it works:** a background job recomputes and writes the cache **before** the entry expires or before anyone asks. The online path becomes read-only.
   - *In plain words:* **the answer is written on the board before the class walks in.**
   - *Real tech example:* a precomputed social timeline; a recommendation feed; an autocomplete trie built offline and swapped in; a metrics recording rule.
   - *Pick it when:* the computation is far too slow to do at request time, and you can predict what will be asked.
   - **Trade-off:** best-possible tail latency and no stampede — but you spend compute on entries nobody reads, and a mispredicted key still misses.

### C. Invalidation Strategies — *"how does a stale entry die?"*

Same strategies, but *what makes the copy go away?* This is the half people forget, and it's the half that causes incidents.

- **TTL expiry (time-based):** the entry simply dies after N seconds.
  - *In plain words:* **the sticky note is thrown away every evening.**
  - *Guarantee:* staleness is **bounded by the TTL** — that's the whole guarantee, and it's often enough. *Cost:* you serve stale data for up to one TTL, and every expiry is a potential miss burst.
  - ⚠️ **Always jitter it.** Identical TTLs set at the same moment expire at the same moment → synchronized miss storm.
- **Explicit invalidation (delete-on-write):** the writer deletes or updates the key.
  - *In plain words:* **you throw away the sticky note the moment the number changes.**
  - *Guarantee:* near-zero staleness. *Cost:* you must find **every** key holding that data (hard once values are denormalized or composed), and a failed delete leaves a **permanently** stale entry. **Prefer delete over update** — an update can be applied out of order and write stale data back; a delete is idempotent and self-healing.
- **Versioned / immutable key (the best one when you can get it):** the key contains a version or content hash, so a change produces a *different key*.
  - *In plain words:* **you never correct the sticky note — you write a new one and stop reading the old.**
  - *Example:* `product:123:v87`, a content-addressed chunk `blob:<sha256>`, a video segment filename, `menu:{id}:{menu_version}`.
  - *Guarantee:* **invalidation becomes impossible to get wrong** — old keys are simply never requested again and age out via eviction. *Cost:* you must plumb a version through every reader, and dead keys occupy memory until evicted.
- **Event / CDC-driven invalidation:** the database's change stream drives cache deletes.
  - *In plain words:* **the contacts app tells you to bin the sticky note.**
  - *Why it's the right answer at scale:* it makes the invalidation **atomic with the commit** (via the transactional outbox / change log), which the app-code approach cannot guarantee. See [distributed-transactions](../interviews/distributed-transactions/) §11.
- **Stale-while-revalidate (serve stale, refresh behind):** on expiry, return the old value *immediately* and refresh asynchronously.
  - *In plain words:* **"here's last night's number, I'm double-checking it now."**
  - *Why it matters:* it converts an expiry from a **latency spike** into a **staleness blip**, and it is the single most effective stampede defence available at the HTTP/CDN layer.

> 🔗 **Connect the dots (B × C):** *Write strategy* answers **who writes the cache**; *invalidation* answers **how it stops lying**. Immutable content → **cache-aside + versioned key** (cache forever). Volatile content → **write-around + short jittered TTL**. Read-your-own-write → **write-through**. Precomputable and slow → **refresh-ahead**. Money → **don't cache it**.

### D. Jargon Decoder — *the scary words in the matrix, in plain English*

| Term | In plain words | Technical example | Appears in |
|---|---|---|---|
| **Hit ratio** | Share of reads the cache answers alone. | 99% hit at 10⁶ QPS still leaves 10K QPS on the DB | every read-heavy system |
| **Thundering herd / cache stampede** | A hot key expires and **every** client misses at once, all hammering the origin together. | 10⁶ clients miss one product key | e-commerce, TicketMaster, autocomplete |
| **Single-flight / request coalescing** | Let **one** request fetch; make the rest wait for its answer. | CDN origin-shield collapsing; a per-key mutex | CDN, e-commerce |
| **TTL jitter** | Add randomness to expiry so keys don't die in lockstep. | `ttl = 300 s ± rand(60 s)` | every TTL cache |
| **Stale-while-revalidate** | Serve the expired copy now, refresh in the background. | HTTP `Cache-Control: stale-while-revalidate` | CDN, catalog reads |
| **Negative caching** | Cache the **absence** of a thing, so misses stop hitting the DB. | cache a 404 for a bogus short code, briefly | url-shortener, web-crawler |
| **Cache penetration** | Requests for keys that **never** exist, so the cache can never help. | ID-scanning attack traffic | url-shortener, API gateway |
| **Hot key** | One key so popular it saturates the single node that holds it. | a celebrity's profile; a flash-sale SKU | social feed, e-commerce |
| **LRU / LFU / W-TinyLFU / ARC** | Eviction rules: drop the **least recently** used / **least frequently** used / a frequency-aware hybrid. | Redis `allkeys-lru`; Caffeine's W-TinyLFU | all memory-bound caches |
| **Working set** | The subset of data actually being used right now. | "the last 7 days of posts" | sizing every cache |
| **L1 / L2 (near-cache)** | An in-process cache in front of a shared network cache. | Caffeine (L1) → Redis (L2) | multi-layer designs |
| **Page cache** | The **OS**'s own cache of file bytes in free RAM — free, and often the whole story. | Kafka reads served from page cache, zero-copy | message-queues |
| **Buffer pool / block cache** | A storage engine's internal cache of **pages** (mutable, B-tree) or **blocks** (immutable, LSM). | InnoDB buffer pool; RocksDB block cache | storage-engines, kv-store |
| **Bloom filter** | A tiny probabilistic set that says "definitely not here" or "maybe here" — avoids a pointless disk read. | LSM SSTable filters; crawler URL-seen set | storage-engines, web-crawler |
| **Surrogate key purge** | Tag cached objects with a label, then purge everything with that label in one call. | Fastly surrogate keys | CDN, catalog publish |
| **Origin shield** | A single mid-tier cache all edge PoPs pull through, so the origin sees one request instead of hundreds. | CDN shield tier | CDN, video |
| **Cache-key normalization** | Stripping irrelevant URL/header variation so one object doesn't fragment into thousands. | dropping tracking query params | CDN |
| **`Vary` header** | Tells a shared cache "this response differs by *this* header." | `Vary: Accept-Encoding` | api-design, CDN |
| **Read model / CQRS projection** | A **precomputed, queryable** view — a cache that answers one question extremely well. | a seat map; a social timeline | seat-reservation, social-feed |
| **Ephemeral state** | Held only in RAM, deliberately never persisted, cheap to lose. | courier/driver GPS positions | ride-sharing, food-delivery |
| **Idempotency-key store** | A record of "I already did this," used to make retries safe. **Looks** like a cache; must be **durable**. | payment retry protection | payment-system |

### E. Decision Guide — *do I cache this, and how?* (for PRDs & interviews)

Walk these **five questions** in order; each answer eliminates options:

1. **What's the freshness window?** *Zero staleness allowed?* → **don't cache it** (or cache only behind a freshness proof — a lease, a version check, a `ReadIndex`). *Seconds OK?* → carry on.
2. **Is the content immutable, or can I make it so?** *Yes?* → **versioned / content-hashed key, cache effectively forever.** This is the cheapest correct answer available; reach for it before anything else.
3. **What's the read:write ratio?** *Reads ≫ writes?* → **cache-aside + TTL**. *Write-heavy but loss-tolerant?* → **write-back**. *Must read own write?* → **write-through**.
4. **Is the value too slow to compute at request time?** *Yes?* → **refresh-ahead / precompute** into a read model. Don't make a user wait for a fan-out or a model inference.
5. **What happens when the cache is empty or gone?** Answer this explicitly — it's the question that separates seniors from architects. Can the origin survive 100% of traffic? If not you need **single-flight + jittered TTL + stale-while-revalidate**, a documented **warm-up path**, and a replicated cache tier (you replicate a cache to protect the *database*, not the data).

> 📝 **PRD sentence template:** *"This path serves **{QPS}** reads with a **{freshness window}** staleness budget, so we use **{write strategy}** with **{invalidation}** in **{layer}**, targeting a **{hit ratio}** hit ratio — which leaves **{QPS × (1 − hit ratio)}** on the origin. If the cache is cold we **{stampede + warm-up plan}**."
>
> *Filled example (catalog):* "This path serves 10⁶ reads/s with a 30 s staleness budget, so we use **cache-aside with a version-keyed product body** (immutable, cached indefinitely) plus a **short jittered TTL** on the price overlay in Redis behind the CDN, targeting **99.9%** — which leaves ~1,000 QPS on the primary. If the cache is cold, **single-flight per key + stale-while-revalidate** keeps the origin from collapsing while it refills."

---

## 2. Comparative Caching Summary Matrix

> Read each row as: *layers (where the copy lives) → strategy (who writes it) → invalidation (how it stops lying) → why it fits this product.*
>
> **Rows 1–17 match [`Use_Cases_for_Redundancy_and_Replication.md`](./Use_Cases_for_Redundancy_and_Replication.md) §2 exactly** — same systems, same order, same numbers. Row *N* in both docs is the same product.

| # | System | Cache Layers | Write Strategy | Invalidation | Why It Fits |
|---|---|---|---|---|---|
| 1 | **TinyURL** | Browser (301) → CDN → Redis → DB replicas | Cache-aside + **negative caching** of unknown codes | Effectively never (mapping is immutable); TTL as a safety net | ~100:1 reads:writes on an immutable key — the ideal cache. `301` lets the *browser* cache the redirect forever, which is why analytics needs `302`. |
| 2 | **Pastebin** | CDN for the paste body → metadata cache | Cache-aside; body is write-once | **Immutable content, hash/ID-keyed** — no invalidation exists | Write-once-read-many text: the content can never change under you, so cache lifetime is bounded only by the expiry policy. |
| 3 | **Instagram** | CDN (photos) → Redis (feed, counters) → TAO-style graph cache → MySQL | **Refresh-ahead** (fan-out-on-write precomputes timelines) + cache-aside for the graph | Append + trim to a bounded window; deletes filtered at read time | Photos are immutable and huge → pure CDN. Timelines are slow to compute → precompute them. Two different caches for two different problems. |
| 4 | **Dropbox** | Client-local chunk cache → CDN → metadata cache | Cache-aside over **content-addressed** chunks | **None needed** — the key *is* the SHA of the content | The best example in this table: content-addressing makes cache invalidation *structurally impossible to get wrong*. New content = new hash = new key. |
| 5 | **FB Messenger** | Client-local history DB → Redis (recent window, presence, unread) | **Write-through** for the sender's own recent window | TTL on presence (heartbeat-refreshed); counters reconciled from the store | You must see your **own** sent message instantly → the sender's write goes *through* the cache. Presence is 100% disposable, so it's TTL-only. |
| 6 | **Twitter** | CDN → Redis timeline lists → graph/user caches | **Refresh-ahead** hybrid: fan-out-on-write, but fan-out-on-**read** for celebrities | Bounded-length lists; trim on append | The celebrity fan-out switch is purely a **caching-cost** decision: writing 100M lists costs more than merging N lists at read time. |
| 7 | **YouTube** | Player buffer → browser → edge PoP → mid-tier → origin | Read-through (pull), plus **popularity-driven pre-positioning** of viral content | Segments **immutable/versioned** → never; **manifests** get seconds-scale TTLs | Segments are immutable files, so the edge caches them indefinitely; only the manifest is volatile. Hit ratio here is a **bandwidth bill**, not a latency nicety. |
| 8 | **Netflix** | Device buffer → ISP-embedded appliance → regional cache | **Push / pre-position** — fill caches off-peak, before anyone asks | Immutable encoded files; replaced by new versions, never edited | The catalogue is known in advance, so caching becomes a *scheduling* problem instead of a demand-prediction problem — the purest refresh-ahead case here. |
| 9 | **Typeahead** | Edge cache (popular prefixes) → Redis prefix→top-K → in-RAM trie | **Refresh-ahead**: the trie is built offline and **hot-swapped** in | **Pointer swap to a new immutable version** — not a purge | Sub-20 ms on every keypress means every layer must be RAM. Zipf traffic means ~1% of prefixes serve most requests, so a tiny cache gets a huge hit ratio. |
| 10 | **API Rate Limiter** | In-process L1 counter → shared Redis L2 → local-only fallback | **Write-through by definition** — `INCR` is both the read and the write | **TTL *is* the algorithm** — window expiry is the eviction | The rare case where **the cache is the source of truth**. So losing it must **fail open** (allow) rather than fail closed (deny everyone). |
| 11 | **Twitter Search** | Query-result cache → in-RAM inverted-index shards | Cache-aside on results; index segments are refresh-ahead | Immutable index **segments** + generational swap; short TTL on result sets | Head queries repeat constantly → caching results is nearly free. The index itself is immutable-segment-based, so replicas and caches never disagree. |
| 12 | **WebCrawler** | DNS resolver cache → per-host `robots.txt` cache → URL-seen **Bloom filter** | Cache-aside; the Bloom filter is append-only | DNS record TTL; `robots.txt` hours-scale TTL; Bloom filter **never** | Caching here buys **politeness and cost**, not user latency. The Bloom filter is a deliberately **lossy** cache — false positives (a skipped URL) are cheaper than duplicate crawls. |
| 13 | **FB NewsFeed** | **TAO graph cache** → Redis feed store → MySQL | Read-through graph cache + refresh-ahead feed | **Asynchronous cross-region invalidation** from the write region | The canonical "cache is the read path" design: nearly all reads are served by the graph cache, and MySQL exists mostly to refill it. |
| 14 | **Yelp** | CDN (business pages) → Redis (page/geo results) → read replicas | Cache-aside + short TTL | TTL; explicit purge on business edits | Read-mostly, geographically clustered demand, cosmetic staleness. The boring correct answer — and read replicas act as the "cache" of last resort. |
| 15 | **Nearby Friends** | In-memory geo ring only (no durable tier) | **Write-back with no flush** — deliberately ephemeral | TTL ≈ the ping interval; a silent client must vanish in seconds | 100K+ writes/s of data that's worthless in 10 s. Persisting it would cost everything and buy nothing. Freshness *is* the product. |
| 16 | **Uber Backend** | In-memory geo index → Redis GEO → per-cell ETA/surge cache | Ephemeral write-back for locations; **refresh-ahead** per geohash cell for surge/ETA | Short TTL per cell; **trip state never cached** | Two opposite answers in one system — the location tier is disposable and RAM-only, while an in-progress trip is stateful and must survive a node death. |
| 17 | **TicketMaster** | CDN (event page) → Redis seat-map **read model** + TTL holds | CQRS read model updated from the hold/booking event stream | Event-driven invalidation; the **hold TTL is a business rule**, not a cache detail | The honest split: **the seat map may lie; the hold may not.** A stale map shows a gone seat and the user gets a clean rejection — overselling is prevented at the authoritative hold, never by the cache. |

### 2b. Caches that aren't in the 17 — *the ones interviewers use to separate levels*

These live in this repo's **pattern** folders rather than the product list, and each teaches something the table above doesn't.

| Cache | Where | Why it's worth naming |
|---|---|---|
| **OS page cache** | [message-queues](../interviews/message-queues/) | Kafka has **no user-space cache** — it delegates to the kernel and reads the same sequential region it just wrote, so recent messages are RAM-resident for free. Corollary: **a lagging consumer is a cache-miss problem** — fall out of the page-cache window and you start hitting disk, dragging every other consumer's latency with you. |
| **Buffer pool vs block cache** | [storage-engines](../interviews/storage-engines/) | The cleanest illustration of the whole doc: a B-tree caches **mutable pages** so it needs write-back + a WAL; an LSM caches **immutable blocks** so its cache is trivially correct and never invalidated — compaction just retires whole SSTables. |
| **Idempotency-key store** | [payment-system](../interviews/payment-system/) | Shaped like a cache, but it is a **correctness component and must be durable**. An evicted idempotency key is a **double charge**. The lesson: not everything in Redis is a cache. |
| **Recording rules / rollups** | [observability](../interviews/observability/) | Precompute the expensive query at **ingest** instead of caching its result at read time. Also: cache *closed* time windows aggressively, never the still-open current one. |
| **Ring / membership cache** | [consistent-hashing](../interviews/consistent-hashing/) | Clients cache the hash ring to avoid an extra hop — but a **stale ring** after a node join routes to the wrong owner. Fixed with a gossip-propagated version epoch. |
| **Follower reads under a lease** | [consensus](../interviews/consensus/) | The only *safe* way to cache a consensus value: a `ReadIndex` or leader lease is a **freshness proof**. Without one, a cached committed value is just an unverified replica. |
| **Memoized DAG cells** | [collaborative-editing](../interviews/collaborative-editing/) | A spreadsheet's calc engine is a cache keyed by the dependency graph — a precedent's change must invalidate **transitively**, which is cache invalidation with a correctness proof attached. |

---

## 3. Where these systems live in this repo

| # | System | Repo topic folder(s) |
|---|---|---|
| 1 | TinyURL | [url-shortener](../interviews/url-shortener/) |
| 2 | Pastebin | [file-storage](../interviews/file-storage/) |
| 3 | Instagram | [social-feed](../interviews/social-feed/) + [file-storage](../interviews/file-storage/) |
| 4 | Dropbox | [file-storage](../interviews/file-storage/) |
| 5 | FB Messenger | [chat-system](../interviews/chat-system/) + [kv-store](../interviews/kv-store/) |
| 6 | Twitter | [social-feed](../interviews/social-feed/) + [message-queues](../interviews/message-queues/) |
| 7 | YouTube | [video-streaming](../interviews/video-streaming/) + [cdn-edge](../interviews/cdn-edge/) |
| 8 | Netflix | [video-streaming](../interviews/video-streaming/) + [cdn-edge](../interviews/cdn-edge/) |
| 9 | Typeahead | [search-autocomplete](../interviews/search-autocomplete/) |
| 10 | API Rate Limiter | [rate-limiting](../interviews/rate-limiting/) |
| 11 | Twitter Search | [search-autocomplete](../interviews/search-autocomplete/) |
| 12 | WebCrawler | [web-crawler](../interviews/web-crawler/) |
| 13 | FB NewsFeed | [social-feed](../interviews/social-feed/) |
| 14 | Yelp | *no dedicated folder — geo read caching in [ride-sharing](../interviews/ride-sharing/); reviews/ranking in [recommendation-system](../interviews/recommendation-system/)* |
| 15 | Nearby Friends | [ride-sharing](../interviews/ride-sharing/) (+ courier-location parallel in [food-delivery](../interviews/food-delivery/)) |
| 16 | Uber Backend | [ride-sharing](../interviews/ride-sharing/) |
| 17 | TicketMaster | [seat-reservation](../interviews/seat-reservation/) |
| — | *concept home* | [distributed-caching](../interviews/distributed-caching/) — strategies, eviction, Redis internals, invalidation, failure modes |
| — | *edge tier* | [cdn-edge](../interviews/cdn-edge/) — TTL/ETag/`Vary`, surrogate purge, origin shield, request collapsing |
| — | *§2b caches* | [message-queues](../interviews/message-queues/) · [storage-engines](../interviews/storage-engines/) · [payment-system](../interviews/payment-system/) · [observability](../interviews/observability/) · [consistent-hashing](../interviews/consistent-hashing/) · [consensus](../interviews/consensus/) · [collaborative-editing](../interviews/collaborative-editing/) |

> Every topic folder's `deep-dive.md` ends with a **"🗄️ Caching Strategy — how *this* system does it"** callout that expands its row above, alongside the matching **"🔁 Redundancy & Replication"** callout. Read the pair together.

---

## Interview Recall Card (memorize these)

- **A replica is a copy you may trust. A cache is a copy you may lose.** Losing a replica = a durability incident; losing a cache = your origin eats 100% of traffic, which is usually the worse outage.
- **Two dials:** **hit ratio** (sets capacity) and **freshness window** (sets correctness). Origin load = `QPS × (1 − hit_ratio)` — at 10⁶ QPS, 99% still leaves **10,000 QPS** on the DB. **The last nine is the one that saves you.**
- **Strategy = who writes:** cache-aside (default, lazy) · read-through (cache fetches) · write-through (read-your-write) · write-back (fast, can lose data) · write-around (volatile) · refresh-ahead (precompute, no user-visible miss).
- **Invalidation = how it stops lying:** TTL (bounded staleness) · delete-on-write (**delete, never update** — deletes are idempotent, updates can reorder) · **versioned/immutable key** (best — invalidation becomes impossible to get wrong) · CDC/outbox (atomic with the commit) · stale-while-revalidate (turns a latency spike into a staleness blip).
- **Immutable → version the key and cache forever. Volatile → short jittered TTL. Read-your-write → write-through. Slow to compute → precompute. Money → don't cache it.**
- **Always name the stampede.** A hot key expires, 10⁶ clients miss at once. Fix = **single-flight + jittered TTL + stale-while-revalidate**, and a documented cold-start warm-up path.
- **You replicate a cache to protect your database, not to protect the data.** That's a different justification from every other replication decision in this repo.
- **The senior question is "what happens when the cache is empty?"** If the origin can't survive 100% of traffic, the cache isn't an optimization — it's load-bearing capacity, and it needs a capacity plan of its own.
