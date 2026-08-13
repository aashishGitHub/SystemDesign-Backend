# Pattern: Scaling Reads

> **Interviewer signal:** "100M users browse the catalog", "the feed must load in 100ms", "read-heavy", "1000:1 read/write ratio", "it's slow under load".

Read traffic grows faster than write traffic in almost every consumer system — typical ratios start around 10:1 and content platforms routinely exceed 100:1 or 1000:1. The good news is that reads are the *easy* side to scale, because copies are cheap and staleness is usually negotiable. The interview skill is **escalating in the right order**, because three of the five rungs cost almost nothing and candidates routinely skip straight to the expensive one.

📖 Source outline: [hellointerview.com — Scaling Reads](https://www.hellointerview.com/learn/system-design/patterns/scaling-reads) (prose paywalled; depth below is this repo's own).

---

## Table of Contents

1. [First: Is It Volume or Is It One Bad Query?](#1-first-is-it-volume-or-is-it-one-bad-query)
2. [Rung 1: Optimize Inside the Database](#2-rung-1-optimize-inside-the-database)
3. [Rung 2: Vertical Scaling (Yes, Really)](#3-rung-2-vertical-scaling-yes-really)
4. [Rung 3: Read Replicas](#4-rung-3-read-replicas)
5. [Rung 4: Caching](#5-rung-4-caching)
6. [Rung 5: Edge / CDN](#6-rung-5-edge--cdn)
7. [Rung 6: Sharding, and Why It's Last for Reads](#7-rung-6-sharding-and-why-its-last-for-reads)
8. [The Layered Read Path](#8-the-layered-read-path)
9. [Precomputation, Materialized Views, and CQRS](#9-precomputation-materialized-views-and-cqrs)
10. [Pagination Is a Read-Scaling Problem](#10-pagination-is-a-read-scaling-problem)
11. [Failure Modes](#11-failure-modes)
12. [Decision Framework](#12-decision-framework)
13. [Where This Shows Up in This Repo](#13-where-this-shows-up-in-this-repo)
14. [Real-World Cases](#14-real-world-cases)
15. [Interview Questions](#15-interview-questions)
16. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. First: Is It Volume or Is It One Bad Query?

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>"The reads are slow" is one sentence describing two unrelated problems, and their fixes point in opposite directions.</p>
<p>A <strong>bad query</strong> is slow even when nobody else is using the system, because the slowness is inside the query itself — the work it does per request is simply too large. More machines do not help. You now run the same bad query in more places.</p>
<p>A <strong>capacity problem</strong> is fast when the system is quiet and degrades as requests pile up, because the machine is running out of some resource. Here more machines genuinely help.</p>
<p>So the first measurement is not "how slow is it" but "is it slow when it is idle". That single question sorts the two apart before you spend anything.</p>
<p>An <strong>N+1 query</strong> is the case that disguises itself as the second while being the first. One page load becomes 1 query for the list plus 1 query per item, so 50 posts turn into 51 queries. The database sees a flood of small queries and the graph looks exactly like a traffic problem. It is a batching bug in the application, and no amount of database capacity fixes it.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why adding five read replicas to a system that is already slow at 1 QPS changes nothing.</p>

</div>

Before any architecture, separate the two failure shapes — they have opposite fixes:

| Symptom | Diagnosis | Fix |
|---|---|---|
| Mean latency fine, p99 terrible | Contention, lock waits, GC, a hot row, or occasional full scans | Fix the outlier path; adding replicas won't help |
| All latencies degrade as QPS rises | Genuine throughput ceiling | Add capacity (replicas/cache) |
| Latency bad even at 1 QPS | **A missing index or a bad query plan** | `EXPLAIN`. No amount of hardware fixes an O(n) scan |
| CPU low, disk I/O saturated | Working set exceeds RAM → reading from disk | More RAM, or a cache |
| CPU pinned, disk idle | Query complexity, serialization, or N+1 | Fix the query/serialization |

**Say this in an interview**: "First I'd look at whether this is a query-plan problem or a volume problem, because a missing index gives you a 1000× win for one line of DDL and no new infrastructure." That single line signals operational experience more than any architecture diagram.

The **N+1 query** deserves a call-out because it's the most common cause of "our reads don't scale": fetch 50 posts, then issue 50 more queries for each author. It looks like a volume problem and it's actually a batching bug — one `IN` query or a DataLoader fixes it. See [`communication-protocols §5`](../interviews/communication-protocols/deep-dive.md#5-graphql) for the GraphQL flavour of this.

---

## 2. Rung 1: Optimize Inside the Database

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>This rung changes nothing outside the database. No new services, no new failure modes, no new consistency questions.</p>
<p>An <strong>index</strong> is a separate structure holding the column values in sorted order, so the database can jump straight to the rows it wants instead of reading every row and discarding most of them.</p>
<p>Because the index is sorted, the order of its columns matters. <code>(user_id, created_at)</code> is sorted by <code>user_id</code> first, and sorted by <code>created_at</code> only <em>within</em> one <code>user_id</code>. A query that knows the <code>user_id</code> therefore finds one contiguous block to scan. A query that knows only the <code>created_at</code> does not, because its matching rows are scattered across every <code>user_id</code> block. That is the left-prefix rule, and it is why column order is a design decision rather than a detail.</p>
<p>A <strong>covering index</strong> already contains every column the query asks for, so the database answers from the index and never opens the table at all.</p>
<p><strong>Selectivity</strong> is how much of the table a lookup eliminates. An index on a true/false column eliminates only half the table, which does not justify the random jumps, so the planner correctly ignores it and scans instead.</p>
<p>The cost sits on the write side. Every index is another structure to update on every insert, so five indexes mean five updates per row written, plus the log and the disk they consume. An index buys read latency with write throughput.</p>
<p><strong>Denormalization</strong> means storing the answer's shape instead of computing it each time — a count column instead of counting, a copy of the author's name on the post row instead of a join. Reads get cheap and writes get expensive, because one change now has to reach every copy, and a fan-out that fails halfway leaves data that is visibly wrong.</p>
<p><strong>Connection pooling</strong> is the one that is not about queries at all. Each database connection costs real memory on the server, so a few hundred of them can cap throughput before any query does. A pooler puts thousands of application connections in front of a few dozen real ones.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why an index on <code>(user_id, created_at)</code> cannot serve <code>WHERE created_at &gt; ?</code> on its own.</p>

</div>

### Indexing

An index turns an O(n) scan into an O(log n) traversal. Three things to actually know:

**Left-prefix rule.** A composite index on `(user_id, created_at)` serves `WHERE user_id = ?`, and `WHERE user_id = ? ORDER BY created_at`, but **not** `WHERE created_at > ?` alone. Index column order is a design decision driven by your query shapes — this is the most commonly probed index detail.

**Covering indexes.** If the index contains every column the query needs, the database never touches the heap:

```sql
CREATE INDEX idx ON posts (user_id, created_at) INCLUDE (title);
-- SELECT title FROM posts WHERE user_id=? ORDER BY created_at DESC LIMIT 20
--   → index-only scan. No table lookup at all.
```

**Selectivity.** An index on a boolean with a 50/50 split is nearly useless — the planner will correctly ignore it, since reading half the rows via random index lookups is slower than a sequential scan. Indexes pay off on high-cardinality columns.

The cost side, which candidates forget: **every index is a write amplifier.** Five indexes means five B-tree updates per insert, more WAL, and more space. Indexes trade write throughput and storage for read latency — name that tradeoff rather than saying "add an index" unconditionally.

→ **Covering vs primary vs clustered, and the row-fetch they remove: [`extra-details §1`](./extra-details.md#1-index-internals-covering-primary-and-clustered)**
→ B-tree mechanics: [`storage-engines §2`](../interviews/storage-engines/deep-dive.md#2-the-b-tree-read-optimized-in-place-storage) · LSM read path and why it needs Bloom filters: [`§4`](../interviews/storage-engines/deep-dive.md#4-the-lsm-read-path) · [`§5`](../interviews/storage-engines/deep-dive.md#5-bloom-filters-and-friends) · [`fundamentals/bloom-filters.md`](../fundamentals/bloom-filters.md)

### Denormalization

Normalization optimizes writes and integrity; denormalization optimizes reads. If a read requires a five-table join executed 50,000 times a second, store the joined shape:

- **Counter columns** (`comment_count` on the post) instead of `COUNT(*)` on every read.
- **Embedded copies** (author name and avatar denormalized onto the post row) so the feed needs one query.
- **Materialized views** — the database maintains the precomputed result; you choose refresh semantics (on-commit vs periodic).

The price is **write amplification and consistency risk**: an author renaming themselves must now update N denormalized copies, and if that fan-out fails halfway you have visibly wrong data. Decide explicitly whether the copy is allowed to be stale (usually yes for display names, no for prices and permissions).

→ [`e-commerce §2 Catalog & Product — The Read Path at Scale`](../interviews/e-commerce/deep-dive.md#2-catalog--product--the-read-path-at-scale)

### Connection pooling

Often overlooked and frequently the actual ceiling. Each Postgres connection is a process with real memory cost, and past a few hundred, throughput *decreases*. A pooler (PgBouncer, RDS Proxy) multiplexing thousands of client connections onto tens of server connections can be a bigger win than a replica. Serverless workloads hit this immediately.

---

## 3. Rung 2: Vertical Scaling (Yes, Really)

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>Vertical scaling means running the same database on a bigger machine. The application does not change, the data does not move, and no new consistency questions appear. That is the entire appeal — every other rung adds something you then have to reason about forever.</p>
<p>The reason it works so well for <em>reads</em> specifically is memory, not processor speed. A database keeps recently used pages in RAM. If the part of the data your users actually touch — the working set — fits in that RAM, reads are answered from memory and never wait for a disk. If it does not fit, reads go to disk, and disk is roughly two orders of magnitude slower. Doubling RAM can move you across that line, and crossing that line is a far bigger win than any percentage improvement in CPU.</p>
<p>Three honest limits. Price stops being proportional at the top of the range. There is a largest machine in every family, and you cannot buy past it. And one machine is still one thing that can fail. So this rung buys time — which is genuinely valuable — rather than ending the problem.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why "does the working set fit in RAM?" is the question to ask here, rather than "is the CPU fast enough?"</p>

</div>

Doubling the instance size is a config change with no consistency implications, no application changes, and no new failure modes. Compared to that, replicas add lag semantics and sharding adds a distributed-systems project.

The specific reason it works so well for reads: **the win is usually RAM, not CPU.** If the working set fits in the buffer pool, reads never touch disk, and the latency difference between a memory hit and an SSD read is roughly two orders of magnitude. A modern instance can hold hundreds of gigabytes to a few terabytes of RAM — which is the entire hot dataset for a great many "web scale" applications.

Saying "I'd first check whether the working set fits in RAM on a larger instance, because that's a config change rather than an architecture change" is a genuinely senior move. The honest limits: cost scales super-linearly at the top end, there's a hard ceiling per instance family, and a single instance is still a single failure domain — so it buys time, not permanence.

---

## 4. Rung 3: Read Replicas

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>A read replica is a copy of the database that receives every write the primary received, a short time later. Reads are sent to the copies; writes still go to the original.</p>
<p>The delay exists because the primary tells the client "done" before the copies have the change. That is what asynchronous means here, and it is the source of every complication that follows.</p>
<p>The user-visible consequence has one specific shape. Someone edits their own data, the write succeeds, they reload the page, that read is served by a copy which has not caught up, and they see their old value. Nothing is broken — the system is behaving exactly as designed — but from the user's side their own edit vanished. Fixing it always means the same thing: make sure <em>that person's</em> read is served by something that definitely holds their write. The primary, a cache you wrote to at the same moment, or a replica you explicitly waited for.</p>
<p>Two limits are easy to miss.</p>
<p>Replicas do nothing for writes. Every copy applies every write, so ten replicas mean the same write stream executes eleven times across the fleet. If the primary is struggling <em>because of writes</em>, adding replicas makes the situation worse, not better.</p>
<p>And a copy may apply changes one at a time even though the primary accepted many at once. When that happens the copy cannot keep up at all, and the delay grows for as long as the load lasts instead of settling at some number. That is why lag is monitored as an alertable signal rather than watched on a dashboard.</p>
<p>Separately, and often the larger win: a replica in the user's region removes the intercontinental round trip from every read.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why a primary at 90% CPU might get <em>worse</em> after you add five replicas.</p>

</div>

Stream the write-ahead log from a primary to N followers; route reads to followers, writes to the primary.

```
        writes            ┌──► Replica 1 ──► reads
   ────────────► PRIMARY ─┼──► Replica 2 ──► reads
                    │     └──► Replica 3 ──► reads
                    └─ WAL shipping (async by default)
```

This scales read throughput near-linearly and is the standard second move. What you must be able to discuss:

### Replication lag and read-your-own-writes

Async replication means a replica is behind by anywhere from single-digit milliseconds to minutes under load. So:

```
User edits their profile   → PRIMARY  ✅
User immediately reloads   → REPLICA (500ms behind) → sees the OLD profile
User: "your app is broken"
```

This is a **monotonicity/session-consistency** violation, and the fixes, in ascending order of sophistication:

| Fix | Detail |
|---|---|
| **Read from primary after write** | Sticky "primary reads for N seconds after this user's write" (cookie/session flag). Crude, effective, most common |
| **Route the user's own data to primary** | A user reading *their own* profile hits primary; everyone else's reads go to replicas |
| **Write-through cache** | Update the cache synchronously on write, so the user's own read is served from cache regardless of replica lag |
| **LSN / token-based reads** | Client carries the log position of its last write and the replica waits until it has applied at least that position — strongest, and what a "read your writes" guarantee actually requires |
| **Semi-synchronous replication** | Primary waits for ≥1 replica to acknowledge before returning. Turns lag into write latency; doesn't eliminate lag on the *other* replicas |

→ [`sharding-replication §4 Consistency Under Replication Lag`](../interviews/sharding-replication/deep-dive.md#4-consistency-under-replication-lag) · session guarantees formally: [`distributed-transactions §6`](../interviews/distributed-transactions/deep-dive.md#6-client-centric-session-guarantees) · [`fundamentals/leader-and-follower.md`](../fundamentals/leader-and-follower.md)

### The two limits people miss

1. **Replicas do not scale writes.** Every replica applies **100%** of the write volume. Ten replicas means the write stream is executed eleven times across the fleet. If the primary is saturated on *writes*, replicas make things worse, not better — that's [Scaling Writes](./scaling-writes.md), a different pattern. Ask which side is actually saturated.
2. **Single-threaded replay can be the bottleneck.** In some engines, apply is serial even though the primary wrote in parallel, so a write-heavy primary can outrun a replica indefinitely — lag grows without bound rather than settling. Monitor lag as a first-class SLI with alerts, not as a dashboard curiosity.

Also worth naming: **cross-region replicas** cut read latency for distant users dramatically (a Sydney user reading from Sydney instead of Virginia saves ~150–200ms of round-trip), which is often a bigger user-visible win than throughput.

---

## 5. Rung 4: Caching

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>A cache is a copy of an answer kept somewhere faster than the place that produced it. It helps for exactly one reason: the same thing is being asked for repeatedly. If every read asks for different data, the copy is never reused and the cache is only an extra step.</p>
<p>The default arrangement is <strong>cache-aside</strong>. The application looks in the cache; on a miss it reads the database and stores the answer for next time. It is the default because it only ever holds things somebody actually asked for, and because if the cache disappears the application still works — it just gets slower.</p>
<p>Storing is not the hard part. Knowing when the stored copy has become wrong is. There are three honest answers, and choosing one deliberately is what the question is really testing.</p>
<p><strong>Give the copy an expiry time</strong> and accept it can be wrong for that long. No coordination, and it repairs itself, which is why it is usually the right answer. It converts the problem into "how stale is acceptable?" — a product question you should ask rather than assume.</p>
<p><strong>Delete the copy when the underlying data changes.</strong> Accurate, but it requires you to know every cached key derived from that data, and one path you forget is data that is wrong permanently rather than briefly.</p>
<p><strong>Put a version number in the key.</strong> A write bumps the version, so old entries are simply never asked for again and fall out on their own. Nothing has to be found and deleted, so there is no "did the delete succeed?" to worry about.</p>
<p>Two details separate people who have run caches from people who have only drawn them. Delete the entry rather than overwriting it — two writers overwriting the same entry can interleave and leave the cache permanently disagreeing with the database, while a delete just means the next reader rebuilds from the source of truth. And set an expiry even when you also invalidate explicitly, because it turns a missed invalidation from a permanent bug into a temporary one.</p>
<p>Finally, hit rate does not behave linearly. At a 90% hit rate the database handles 10% of reads; at 99% it handles 1%. The last few percentage points remove most of the load that was still left, which is why chasing them is worth real effort.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why deleting a cache entry is safer than updating it in place.</p>

</div>

The single highest-leverage rung: a Redis hit is sub-millisecond, versus single-digit-to-tens of milliseconds for a database query, and it removes load from the component that's hardest to scale.

### Strategies

| Strategy | Flow | Use when |
|---|---|---|
| **Cache-aside** (lazy) | App checks cache → miss → read DB → populate cache | **Default.** Only caches what's asked for; resilient to cache failure |
| **Read-through** | Cache library owns the DB fetch | Same profile, less app code, more coupling |
| **Write-through** | Write to cache *and* DB synchronously | Cache never stale; write latency includes both. Great for read-your-writes |
| **Write-behind** | Write to cache, flush to DB async | Fastest writes; **risk of data loss** if the cache dies before flush |
| **Refresh-ahead** | Proactively refresh hot keys before TTL expiry | Predictably hot keys; avoids the expiry-time latency spike |

### Invalidation — the actual hard part

Three honest options, and picking one deliberately is the answer:

1. **TTL** — accept bounded staleness. Simple, self-healing, no coordination. *Usually correct.* The follow-up question is "how stale can this be?", which is a product question, so **ask it**.
2. **Explicit invalidation on write** — delete/update the key when the source changes. Accurate but requires knowing every key derived from that data, and a missed path means permanently wrong data. Composite keys and derived aggregates make this hard.
3. **Versioned keys** — embed a version in the key (`user:42:v7`), so a write bumps the version and old entries are orphaned and evicted naturally. No invalidation call needed, and it's immune to the "did the delete succeed?" race. Costs memory until eviction.

The subtle trap: **invalidate rather than update.** A read-modify-write of a cache entry can race with another writer and leave the cache permanently inconsistent with the DB; deleting the key is idempotent and the next read re-derives from the source of truth.

→ [`distributed-caching §2 Strategies`](../interviews/distributed-caching/deep-dive.md#2-caching-strategies-deep-dive) · [`§5 Invalidation Patterns`](../interviews/distributed-caching/deep-dive.md#5-cache-invalidation-patterns) · [`recommendation-system §11`](../interviews/recommendation-system/deep-dive.md#11-cache-invalidation-the-hardest-problem-in-cs)

### Eviction and hit ratio

LRU is the default; LFU is better when there's a stable hot set and occasional scans would otherwise evict it (Redis offers `allkeys-lfu`); TTL-based expiry composes with both. Hit ratio is the metric that matters — and it's non-linear: going from 90% to 99% hit rate **removes 90% of the remaining database load**, which is why chasing the last few percent is worth real effort.

→ [`distributed-caching §3 Eviction`](../interviews/distributed-caching/deep-dive.md#3-eviction-policies-and-memory-management) · [`§4 Redis Internals`](../interviews/distributed-caching/deep-dive.md#4-redis-internals)

---

## 6. Rung 5: Edge / CDN

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>Every other rung makes the system do less work. This one makes the data travel less distance.</p>
<p>Some latency is not a software problem at all. A round trip from Sydney to Virginia costs on the order of 150 milliseconds because of distance and the speed of light in fibre, and no amount of server tuning touches it. The only fix is to keep a copy of the answer near the user, which is what a CDN is — a large set of caches spread geographically, sitting in front of your origin.</p>
<p><code>Cache-Control</code> is how you talk to those caches. It carries how long a copy stays fresh, plus two behaviours worth knowing by name. <code>stale-while-revalidate</code> lets the cache hand the user the slightly old copy immediately and fetch a fresh one in the background, so nobody waits for the refresh. <code>stale-if-error</code> lets it keep serving the old copy while your origin is down, turning an outage into staleness.</p>
<p><code>Vary</code> is the footgun. It tells the cache "this response differs by that request header", so <code>Vary: User-Agent</code> splits one cached object into thousands of near-identical variants and the hit rate collapses. Decide deliberately what belongs in the cache key.</p>
<p>Invalidating dynamic content at the edge is done with tags, not URLs. Label each response with keys like <code>product-42</code>, and a price change purges everything carrying that label — you never have to enumerate the URLs that response might live at.</p>
<p>Two things people underrate. The CDN collapses simultaneous misses for the same object into a single request to your origin, so a cold cache during a traffic spike does not become a flood. And dynamic responses are cacheable too: at 10,000 requests per second, even a 5-second lifetime turns 50,000 origin requests into 2.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why a 5-second cache lifetime on an API response is not too short to be worth setting.</p>

</div>

Push the copy geographically close to the user. This is the only rung that attacks **latency physics** rather than throughput: no amount of backend optimization beats the ~150ms round trip inherent in crossing an ocean, and a CDN removes that entirely for cacheable content.

Beyond static assets, the parts worth knowing:

- **`Cache-Control` is the API.** `max-age`, `s-maxage` (shared caches only), `stale-while-revalidate` (serve stale instantly, refresh in the background — a huge latency win), `stale-if-error` (survive origin outages). `ETag`/`If-None-Match` gives 304s that save bandwidth but not the round trip.
- **`Vary` is a footgun.** `Vary: User-Agent` explodes your cache into thousands of variants and destroys hit rate. Normalize the cache key deliberately instead.
- **Surrogate-key purge.** Tag responses with keys (`product-42`, `category-shoes`) and purge by tag rather than by URL — the only tractable way to invalidate dynamic content at the edge.
- **Request collapsing / origin shield.** N simultaneous edge misses for the same object become **one** origin request. This is stampede protection built into the CDN, and it's the reason a cold cache during a traffic spike doesn't necessarily take out your origin.
- **Dynamic content is cacheable too.** Even a 5-second TTL on a hot API response absorbs enormous load — at 10k QPS, a 5s TTL means 2 origin requests instead of 50,000.

→ [`cdn-edge §3 Cache-Control, TTL, ETag, Vary`](../interviews/cdn-edge/deep-dive.md#3-cache-control-ttl-etag-and-vary) · [`§5 Invalidation & Surrogate-Key Purge`](../interviews/cdn-edge/deep-dive.md#5-invalidation-and-surrogate-key-purge) · [`§6 Origin Shield & Request Collapsing`](../interviews/cdn-edge/deep-dive.md#6-origin-shield-request-collapsing-and-cache-stampede) · [`§1 The Latency Physics`](../interviews/cdn-edge/deep-dive.md#1-why-cdns-exist-the-latency-physics)

---

## 7. Rung 6: Sharding, and Why It's Last for Reads

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>Sharding means splitting the data itself, so each machine holds a different slice and no machine holds all of it. For writes, and for datasets too large to fit anywhere, it is the only real answer. For reads it comes last, because replicas and caches give you read capacity without splitting anything.</p>
<p>The cost lands on queries that do not name the shard key. If the request does not say which slice the answer is in, you must ask every slice and combine the answers — and you cannot reply until the <em>slowest</em> one has replied. That is why sharding makes tail latency worse rather than better: with ten shards each having a 1-in-100 chance of being slow, roughly one request in ten is slow, and the effect grows as you add shards. Horizontal scaling that punishes you for scaling horizontally is a real and counterintuitive property.</p>
<p>You also give up joins and transactions that cross slices, and changing the split afterwards is a project rather than a setting.</p>
<p>So the rule is: shard when the data no longer fits or the writes no longer fit — not because reads are slow. And when you do shard, choose the key so that the query you run most often lands on a single slice. That one choice is most of the outcome.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why the proportion of slow requests goes <em>up</em> as you add shards to a scatter-gather query.</p>

</div>

Sharding splits data across independent nodes. For **writes** and **dataset size** it's the only real answer. For **reads** it's a last resort, because replicas and caches give you read throughput without the costs sharding imposes:

- Queries that don't include the shard key become **scatter-gather** — hit every shard, merge results, and now your p99 is the *slowest* shard's p99 (tail-latency amplification). A 10-shard fan-out where each shard has a 1% slow rate means ~10% of requests are slow.
- No cross-shard joins or transactions without significant machinery.
- Re-sharding is a project, not a config change.

Shard for reads only when the *dataset* no longer fits, the write volume exceeds one primary, or you need per-tenant/per-region isolation. And when you do, **choose the shard key to match the dominant read pattern** so the common query hits one shard — that's the whole game.

→ [`sharding-replication §2 Choosing the Right Cut`](../interviews/sharding-replication/deep-dive.md#2-sharding-strategies-choosing-the-right-cut) · [`§5 Cross-Shard Queries`](../interviews/sharding-replication/deep-dive.md#5-cross-shard-queries-and-distributed-transactions) · [`§7 Online Re-sharding`](../interviews/sharding-replication/deep-dive.md#7-online-re-sharding-without-downtime) · read-vs-replicate for a specific system: [`search-autocomplete §7`](../interviews/search-autocomplete/deep-dive.md#7-scaling-out-sharding-vs-replication)

---

## 8. The Layered Read Path

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>A real read path is not one cache. It is a chain of them, and each step down the chain is slower, larger, and shared by more users than the step above. A request walks down until something can answer, and the answer is copied back up on the way out.</p>
<p>Two rules fall out of that shape.</p>
<p><strong>Each layer has to survive the layer below being empty.</strong> "What happens when the cache is empty?" needs an answer that is not "the database dies", because an empty cache is a normal event — a restart, a failover, a deploy.</p>
<p><strong>An in-process cache is the fastest thing available and the least consistent.</strong> It lives in the application instance's own memory, so twenty instances hold twenty independent copies, and you cannot delete an entry from all of them at once. That restricts it to data where instances briefly disagreeing is acceptable, with a lifetime measured in seconds.</p>
<p>That weakness is also its best property. Because every instance has its own copy, one extremely popular key cannot concentrate load on a single shared cache node. Putting a one-second in-process cache in front of Redis turns 50,000 requests per second on one key into about 20.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why an in-process cache is the right tool for a hot key and the wrong tool for data that must be consistent across the fleet.</p>

</div>

Every mature read path is a cascade, and being able to draw it with latencies is a strong whiteboard moment:

```
Browser cache        ~0 ms        ← free, and everyone forgets it
      ↓ miss
CDN / edge PoP       ~10–30 ms    ← kills the ocean crossing
      ↓ miss
API gateway cache    ~1–5 ms
      ↓ miss
App in-process (L1)  ~0.1 µs      ← nanoseconds; but per-instance and
                                    inconsistent across the fleet
      ↓ miss
Redis / Memcached    ~0.5–2 ms    ← shared, consistent across instances
      ↓ miss
DB buffer pool       ~0.1–1 ms    ← the DB's own RAM cache
      ↓ miss
Disk (SSD)           ~0.1–1 ms+   ← plus queueing under load
```

The design rules that follow:

- **Each layer must be independently survivable.** "What happens when Redis is empty?" must have an answer that isn't "the database melts" — see [§11](#11-failure-modes).
- **L1 in-process caches are inconsistent by construction**: 20 instances hold 20 slightly different views, and you cannot invalidate them synchronously. Use short TTLs (seconds) and only for data where fleet-wide disagreement is tolerable. The upside is that it absorbs hot keys perfectly — every instance has its own copy, so a single hot key can't overload one Redis shard.
- **Stack multiple layers for hot keys**: an L1 with a 1-second TTL in front of Redis converts 50,000 QPS on one key into 20 QPS.

→ [`distributed-caching §7 Multi-Layer Cache Architecture`](../interviews/distributed-caching/deep-dive.md#7-multi-layer-cache-architecture)

---

## 9. Precomputation, Materialized Views, and CQRS

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>Every rung so far makes the read faster. This one removes the work from the read entirely, by doing it earlier — at write time.</p>
<p>The reason it pays is the ratio. If a piece of data is read a hundred times for every time it changes, then computing the answer once when it changes and reading it a hundred times is an enormous saving, even if the computation becomes ten times more expensive. Write-time work also happens where no user is sitting and waiting for it.</p>
<p>The forms are the same idea at different scales. <strong>Fan-out-on-write</strong> puts a copy of a new post into each follower's prepared timeline, so reading a feed becomes fetching one list rather than querying across everyone you follow. <strong>Precomputed top-K</strong> stores the answer at each node so a query is a lookup rather than a traversal. <strong>CQRS</strong> keeps the authoritative, normalized data for writing, and builds separate copies shaped for each way you read, kept in step by events. <strong>Purpose-built stores</strong> are the same move across systems: full-text search into a search engine, similarity into a vector store, time series into a time-series database, instead of forcing one database to answer every kind of question well.</p>
<p>The bill is always the same three items: writes cost more, the same information is stored several times, and every copy is behind the source by some amount. Read latency is what you buy with them.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why fan-out-on-write is clearly right at a 100:1 read/write ratio and clearly wrong at 1:1.</p>

</div>

The deepest form of read scaling: **stop computing at read time.** Move work to write time, where volume is lower and latency doesn't face a user.

- **Fan-out-on-write** for feeds: when a user posts, write into each follower's precomputed timeline, so a feed read is one sequential fetch instead of a query across everyone you follow. Cost: expensive writes, and the celebrity problem. [`social-feed §1`](../interviews/social-feed/deep-dive.md#1-fan-out-models) · [`§3 Timeline Caching`](../interviews/social-feed/deep-dive.md#3-timeline-caching)
- **Precomputed top-K** at each node so a query is a lookup, not a traversal: [`search-autocomplete §4`](../interviews/search-autocomplete/deep-dive.md#4-top-k-stored-at-each-node)
- **CQRS** — separate write model (normalized, transactional) from read models (denormalized, per-query-shape), synchronized via events. You can then have several purpose-built read models over one write model: a search index, a cache, an analytics store. Cost: eventual consistency between them, and the operational burden of keeping projections correct and rebuildable. [`seat-reservation §8`](../interviews/seat-reservation/deep-dive.md#8-database-design-schema-sharding-and-cqrs)
- **Purpose-built stores.** Full-text search → Elasticsearch; similarity → a vector DB; time series → Prometheus/Timescale. Trying to make one database serve every read shape is the underlying mistake. [`recommendation-system §13`](../interviews/recommendation-system/deep-dive.md#13-storage-decisions-one-database-per-job)

The universal tradeoff to state: precomputation trades **write cost, storage, and staleness** for read latency. It's the right trade when the read:write ratio is high — which, per this pattern's premise, it usually is.

---

## 10. Pagination Is a Read-Scaling Problem

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>Pagination looks like an API detail and is actually a read-scaling decision.</p>
<p><code>OFFSET 1000000 LIMIT 20</code> asks the database to produce a million rows in sorted order and throw all of them away before returning the twenty you wanted. The cost grows with how far the user has scrolled, so the feature gets slower the more someone uses it.</p>
<p>There is a second problem, and it is a correctness bug rather than a performance one. An offset is a count from the start of a list that is still changing. If new rows arrive at the top while the user reads, everything shifts down, and page 2 returns rows they already saw on page 1. Deletions produce the mirror image — rows that are skipped and never shown at all.</p>
<p>Cursor pagination fixes both by naming a position instead of counting to one. The client sends back the sort values of the last row it saw, and the next page is "the rows after this point". The database jumps straight there, so the cost no longer depends on depth, and inserts elsewhere in the list cannot change what "after this point" means.</p>
<p>The tie-breaker matters. If you sort only by a timestamp and several rows share one, the boundary between pages is ambiguous and rows get silently skipped. Including a unique column in both the sort and the cursor makes every position unambiguous.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why offset pagination shows the same item twice, and why a bare timestamp is not a safe cursor.</p>

</div>

`OFFSET 1000000 LIMIT 20` forces the database to produce and discard a million rows. Deep pagination is a self-inflicted read-scaling failure.

```sql
-- ❌ O(offset) — degrades the further users scroll
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 1000000;

-- ✅ O(log n) — cursor/keyset pagination
SELECT * FROM posts
 WHERE (created_at, id) < ($last_created_at, $last_id)   -- tie-break on id!
 ORDER BY created_at DESC, id DESC LIMIT 20;
```

Cursor pagination is also **stable under concurrent inserts** — offset pagination silently duplicates or skips rows when the underlying set shifts between pages, which is a correctness bug users experience as "I saw that post twice". The composite tie-breaker on a unique column matters: without it, rows sharing a timestamp get skipped.

→ [`api-design §6 Pagination at Scale`](../interviews/api-design/deep-dive.md#6-pagination-at-scale)

---

## 11. Failure Modes

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>Most read-path failures are the same accident with different triggers: something that was absorbing the majority of the traffic stops absorbing it, and the database receives load it was never sized for.</p>
<p>Three versions are worth telling apart. A <strong>stampede</strong> is one popular key expiring, so every request for it misses in the same instant and they all reach the database together. A <strong>cold cache</strong> is the whole cache being empty at once after a restart or failover — if it had been absorbing 95% of reads, the database suddenly sees twenty times its normal load. <strong>Penetration</strong> is requests for keys that do not exist, which an ordinary cache-aside path never stores and which therefore miss every single time; an attacker can generate them freely.</p>
<p>A <strong>hot key</strong> is a different shape and worth not confusing with those. The total load may be perfectly fine. The problem is that it is concentrated on one key, that key lives on one cache node, and that node is the ceiling.</p>
<p>The fixes fall into three families, and naming the family is more useful than memorizing the techniques:</p>
<ul><li><strong>Make only one request do the work.</strong> A per-key lock so one caller refills while the rest wait, or the CDN collapsing simultaneous misses into a single origin fetch.</li><li><strong>Spread the moment.</strong> Add randomness to expiry times so related keys do not expire together, refresh slightly early at a random offset, stagger deploys so instances do not all start cold at once.</li><li><strong>Serve something imperfect rather than nothing.</strong> Hand back the stale value while refreshing behind it, cache the fact that a key does not exist, return partial results when one shard is slow.</li></ul>
<p>And one operational point that carries more weight than any single technique: either capacity-plan the database for a cache-loss event, or rate-limit the path that refills the cache. Recovery is precisely the moment when the system is least able to absorb a flood.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> which of these failures is about everything happening at the same <em>moment</em>, and which is about load landing in the same <em>place</em>.</p>

</div>

| Failure | Mechanism | Mitigation |
|---|---|---|
| **Cache stampede / thundering herd** | A hot key expires; 10,000 concurrent requests all miss and all hit the DB simultaneously | **Per-key mutex / single-flight** (one request refills, others wait), probabilistic early expiry, `stale-while-revalidate`, request collapsing at the edge |
| **Hot key** | One key (celebrity, viral post) exceeds a single cache shard's capacity | Replicate the key across shards with a suffix, or an L1 in-process cache in front — the [Scaling Writes](./scaling-writes.md) hot-key techniques apply symmetrically |
| **Cache penetration** | Requests for keys that **don't exist** always miss and always hit the DB; trivially weaponized | **Negative caching** (cache the "not found" with a short TTL) + a Bloom filter to reject definitely-absent keys cheaply |
| **Cold cache / cache loss** | Redis restarts or fails over; 100% of traffic hits a database sized for 1% of it → cascading outage | Capacity-plan the DB for a cold-cache event, or gate recovery with a rate limiter; warm caches before taking traffic; use a replicated cache so failover keeps the data. **This is the question that separates candidates who've operated caches from those who've only drawn them** |
| **Stale data served indefinitely** | An invalidation path was missed | Always pair explicit invalidation with a TTL as a backstop — TTL turns a permanent bug into a temporary one |
| **Replica lag spike** | Bulk write/backfill on the primary | Alert on lag as an SLI; route reads back to primary above a threshold; throttle backfills |
| **Tail-latency amplification** | Scatter-gather across N shards → p99 becomes the slowest of N | Hedged/backup requests, per-shard timeouts with partial results, or don't scatter (fix the shard key) |
| **Thundering herd on deploy** | All instances start with empty L1 caches simultaneously | Staggered rollout, cache warming on startup |

→ [`distributed-caching §6 Failure Modes and Mitigations`](../interviews/distributed-caching/deep-dive.md#6-failure-modes-and-mitigations) · [`search-autocomplete §8`](../interviews/search-autocomplete/deep-dive.md#8-the-redis-prefix-cache-eviction-and-stampede)

---

## 12. Decision Framework

```
Measure first: bad query, or genuine volume?
├─ bad query / N+1 / missing index ──► FIX THE QUERY. Nothing else first.
└─ genuine volume
   │
   ├─ Does the working set fit in RAM on a bigger box?
   │     ──────────────────────────► VERTICAL SCALE. Config change, no new semantics.
   │
   ├─ Is the same data read repeatedly?
   │     ──────────────────────────► CACHE (cache-aside + TTL).
   │        • can it be stale? → TTL, and ask how long
   │        • must be fresh?   → write-through or explicit invalidation + TTL backstop
   │
   ├─ Are users geographically distant, and is the content cacheable?
   │     ──────────────────────────► CDN / EDGE (even a 5s TTL on dynamic responses)
   │
   ├─ Many distinct reads, low repetition, and the primary is read-saturated?
   │     ──────────────────────────► READ REPLICAS
   │        + answer read-your-own-writes explicitly
   │        + monitor lag as an SLI
   │
   ├─ Is the query shape itself the problem (joins, aggregates, search)?
   │     ──────────────────────────► PRECOMPUTE: materialized view, fan-out-on-write,
   │                                  CQRS read model, or a purpose-built store
   │
   └─ Dataset too big for one box, or writes saturated?
         ──────────────────────────► SHARD (see Scaling Writes)
                                     ...and pick the key to match the read pattern
```

---

## 13. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **Distributed caching** | The home topic: strategies, eviction, Redis internals, invalidation, multi-layer, failure modes | [`§2`](../interviews/distributed-caching/deep-dive.md#2-caching-strategies-deep-dive) · [`§3`](../interviews/distributed-caching/deep-dive.md#3-eviction-policies-and-memory-management) · [`§5`](../interviews/distributed-caching/deep-dive.md#5-cache-invalidation-patterns) · [`§6`](../interviews/distributed-caching/deep-dive.md#6-failure-modes-and-mitigations) · [`§7`](../interviews/distributed-caching/deep-dive.md#7-multi-layer-cache-architecture) · [`§9 When to Cache`](../interviews/distributed-caching/deep-dive.md#9-pattern-recognition--when-to-cache) |
| **CDN & edge** | The geographic rung: cache-control, key design, surrogate purge, request collapsing | [`§1`](../interviews/cdn-edge/deep-dive.md#1-why-cdns-exist-the-latency-physics) · [`§3`](../interviews/cdn-edge/deep-dive.md#3-cache-control-ttl-etag-and-vary) · [`§4`](../interviews/cdn-edge/deep-dive.md#4-push-vs-pull-and-cache-key-design) · [`§5`](../interviews/cdn-edge/deep-dive.md#5-invalidation-and-surrogate-key-purge) · [`§6`](../interviews/cdn-edge/deep-dive.md#6-origin-shield-request-collapsing-and-cache-stampede) |
| **Sharding & replication** | Replicas, lag semantics, and when sharding is actually required | [`§3`](../interviews/sharding-replication/deep-dive.md#3-replication-copies-for-safety-and-speed) · [`§4`](../interviews/sharding-replication/deep-dive.md#4-consistency-under-replication-lag) · [`§2`](../interviews/sharding-replication/deep-dive.md#2-sharding-strategies-choosing-the-right-cut) · [`§9`](../interviews/sharding-replication/deep-dive.md#9-pattern-recognition--when-to-shard) |
| **URL shortener** | A pure read-heavy KV system — the cleanest worked example of this pattern | [`§1`](../interviews/url-shortener/deep-dive.md#1-the-two-operations-a-read-heavy-key-value-system) · [`§5 Cache-Aside & Hot Keys`](../interviews/url-shortener/deep-dive.md#5-caching-the-read-path-redis-cache-aside-and-hot-keys) |
| **Social feed** | Fan-out-on-write as precomputation; timeline caching; the celebrity read/write inversion | [`§1`](../interviews/social-feed/deep-dive.md#1-fan-out-models) · [`§2`](../interviews/social-feed/deep-dive.md#2-the-celebrity-problem) · [`§3`](../interviews/social-feed/deep-dive.md#3-timeline-caching) |
| **Search autocomplete** | Precomputed top-K, prefix cache, stampede, shard-vs-replicate decision | [`§1`](../interviews/search-autocomplete/deep-dive.md#1-what-autocomplete-is-the-read-path-end-to-end) · [`§4`](../interviews/search-autocomplete/deep-dive.md#4-top-k-stored-at-each-node) · [`§7`](../interviews/search-autocomplete/deep-dive.md#7-scaling-out-sharding-vs-replication) · [`§8`](../interviews/search-autocomplete/deep-dive.md#8-the-redis-prefix-cache-eviction-and-stampede) |
| **E-commerce** | The consistency gradient: browse can be stale, checkout cannot — read scaling as a per-surface decision | [`§1`](../interviews/e-commerce/deep-dive.md#1-the-consistency-gradient--why-four-stages) · [`§2`](../interviews/e-commerce/deep-dive.md#2-catalog--product--the-read-path-at-scale) |
| **Recommendation system** | Precomputed recommendations, Redis layer, and the invalidation problem | [`§10`](../interviews/recommendation-system/deep-dive.md#10-redis-caching-the-fastest-answer-is-a-pre-written-one) · [`§11`](../interviews/recommendation-system/deep-dive.md#11-cache-invalidation-the-hardest-problem-in-cs) · [`§13`](../interviews/recommendation-system/deep-dive.md#13-storage-decisions-one-database-per-job) |
| **Storage engines** | Why B-trees are read-optimized and what an LSM read costs | [`§2`](../interviews/storage-engines/deep-dive.md#2-the-b-tree-read-optimized-in-place-storage) · [`§4`](../interviews/storage-engines/deep-dive.md#4-the-lsm-read-path) · [`§5`](../interviews/storage-engines/deep-dive.md#5-bloom-filters-and-friends) |
| **API design** | Pagination at scale, and caching semantics in the HTTP contract | [`§6`](../interviews/api-design/deep-dive.md#6-pagination-at-scale) |
| **Video streaming** | CDN-first delivery where the object is far too big to serve from origin | [`§5`](../interviews/video-streaming/deep-dive.md#5-cdn--global-video-delivery) |
| **KV store** | Tunable read consistency (`R`) and why coordinators wait | [`§4`](../interviews/kv-store/deep-dive.md#4-tunable-consistency-n-w-r-quorums) · [`§10`](../interviews/kv-store/deep-dive.md#10-tail-latency-and-why-coordinators-wait-for-w) |

---

## 14. Real-World Cases

| Case | What's done | Lesson |
|---|---|---|
| **Instagram feed** | Precomputed timelines in a cache; the read is a lookup, not a query | At high read:write ratios, move the work to write time |
| **Twitter/X** | Fan-out-on-write for normal users, fan-out-on-read for celebrities | One system, two read strategies chosen per-user by fanout. Hybrid beats purity |
| **Amazon product pages** | Aggressively cached and replicated; "only 3 left" is deliberately approximate | Different surfaces of the same product get different consistency. Browse ≠ checkout |
| **YouTube / Netflix** | Video bytes served from CDN edge caches, some deployed inside ISP networks | For large static objects the answer is entirely geographic, not architectural |
| **Wikipedia** | Heavy Varnish/edge caching in front of the application; most reads never reach it | A read-mostly site can serve the overwhelming majority of traffic from cache |
| **Stack Overflow** | Famously served enormous traffic from a small number of servers with very large RAM | Vertical scaling plus good caching goes far further than the "web scale" instinct suggests |
| **Facebook memcache** | A very large, well-documented multi-layer cache tier with leases to prevent stampedes | At extreme scale the *cache* becomes the primary system and the DB is a backing store. Their published work on lease-based stampede prevention is the canonical treatment |

*(Numbers and internal details for these companies change over time and are often undisclosed — treat the architectures as directionally accurate patterns rather than verified current implementations.)*

---

## 15. Interview Questions

**Q1. Read latency is 800ms. Where do you look first?**
At whether it's a query problem or a volume problem, because they have opposite fixes. If latency is bad even at low QPS, it's a query plan issue — `EXPLAIN` it, look for a missing index or a full scan, and check for N+1 patterns where one logical read became 51 queries. If latency is fine at low QPS and degrades as traffic rises, it's capacity, and then I check whether CPU or I/O is the binding constraint, because I/O saturation usually means the working set no longer fits in RAM. I'd resist adding replicas before knowing this — replicas multiply a bad query rather than fixing it.

**Q2. Composite index on `(user_id, created_at)`. Which queries does it serve?**
It serves `WHERE user_id = ?`, and `WHERE user_id = ? ORDER BY created_at`, and range scans on `created_at` *within* a `user_id`. It does **not** serve `WHERE created_at > ?` alone, because of the left-prefix rule — the index is sorted by `user_id` first, so without it there's no contiguous range to scan. That's why index column order is a design decision driven by query shape. And the cost: each index adds a B-tree write per insert, so five indexes means five extra writes plus WAL and storage — indexes trade write throughput for read latency.

**Q3. Cache or read replica — which first, and why?**
Cache, almost always. A cache hit is sub-millisecond versus milliseconds for a replica query, it removes load from the database entirely rather than redistributing it, and it's cheaper per unit of relief. Replicas make sense when reads are *diverse* — low repetition, so the hit rate would be poor — or when I want geographic read locality or a failover target, since a replica gives me HA that a cache doesn't. In practice most systems end up with both, but if I can only do one and the access pattern is skewed, the cache wins.

**Q4 (depth). A user updates their profile and immediately sees the old version. Explain and fix.**
The write went to the primary and the read went to an async replica that hadn't applied it yet — a read-your-own-writes violation, which is a session-consistency problem rather than a bug in either component. Fixes in ascending order: route that user's reads to the primary for a few seconds after their write, using a session or cookie flag — crude but effective and the most common; or route a user's reads of *their own* data to the primary permanently; or write through the cache synchronously so their read is served from cache regardless of lag; or, strongest, have the client carry the log position of its write and have the replica wait until it has applied at least that position. Semi-synchronous replication reduces the window but doesn't eliminate it on the other replicas.

**Q5 (depth). Your primary is at 90% CPU. You add five read replicas. What happens?**
It depends entirely on *why* it's at 90%, and this is the trap. If it's read-saturated, the replicas help roughly linearly. If it's **write**-saturated, they make it worse: every replica applies 100% of the write volume, so I've now got the write stream executing six times across the fleet plus the added replication overhead on the primary. Replicas scale reads only — they do nothing for write throughput, which needs sharding or a different write path. So my first question is the read/write split of that CPU, and I'd also check whether replication apply is single-threaded in this engine, because a write-heavy primary can outrun a serial replica and lag will grow without bound rather than settling.

**Q6 (depth). One hot key expires and 10,000 requests hit the database in the same millisecond. Fix it.**
That's a cache stampede, and the core fix is single-flight: a per-key mutex or lock so exactly one request recomputes the value while the others either wait briefly for it or are served the stale value. Complementary techniques: probabilistic early expiry, where each reader independently decides to refresh slightly before the TTL, spreading refreshes over a window instead of synchronizing them on one instant; `stale-while-revalidate` semantics, serving the stale value immediately and refreshing in the background so no user waits at all; refresh-ahead for keys I know are hot; and at the edge, request collapsing, which coalesces N simultaneous misses into one origin fetch. The thing to avoid is uniform TTLs across many related keys, which synchronizes expiries into a recurring herd — add jitter.

**Q7 (senior). Your Redis cluster fails and comes back empty. What happens to the database?**
It probably falls over, and this is the failure I'd design for explicitly. If the cache was absorbing 95% of reads, a cold cache means the database instantly sees 20× its normal load, which is well past capacity, so requests queue, timeouts cascade, retries amplify, and the cache can't refill because the backing queries are timing out — a self-sustaining outage. Mitigations: capacity-plan the database for some defined fraction of cold-cache traffic rather than for the steady state; put a rate limiter or concurrency limit in front of the fill path so recovery is gated rather than a stampede; use a replicated cache with failover so a node loss doesn't lose the dataset; warm the cache before routing traffic to a restarted node; and serve stale-or-degraded responses rather than queueing. I'd also actually test it, because this failure is common and rarely rehearsed.

**Q8 (senior). How do you decide TTL versus explicit invalidation?**
By the cost of being wrong and the tractability of enumerating the derived keys. TTL is self-healing and needs no coordination, so it's my default, and the design question becomes "how stale is acceptable?" — a product question I should ask rather than assume. Explicit invalidation is required when stale data is genuinely harmful — prices, permissions, account status — but it demands that I know every cache key derived from the changed data, and a single missed path yields permanently wrong data. So I use both: invalidate explicitly *and* set a TTL as a backstop, which converts a missed-invalidation bug from permanent to bounded. And I invalidate by deleting rather than updating in place, because a read-modify-write of a cache entry can race and leave the cache permanently diverged, while a delete is idempotent and the next read re-derives from the source of truth. Versioned keys are a nice third option — bump a version and old entries orphan themselves.

**Q9 (senior). What does a 100:1 read/write ratio let you do that 1:1 wouldn't?**
It justifies moving essentially all work to the write path. At 100:1, an operation that makes writes 10× more expensive but reads 10× cheaper is a large net win, so fan-out-on-write, materialized views, denormalized copies, precomputed top-K, and multiple purpose-built read models all become clearly correct rather than speculative. It also means caching has a high ceiling, because the same data is genuinely read repeatedly, so hit rates will be good. At 1:1 those trades invert — precomputation costs more than it saves, cache hit rates are poor because data changes as often as it's read, and I'd focus on making the write path efficient and reading from the same store instead. So the ratio isn't trivia; it's the input that selects the architecture.

**Q10 (staff). Design the read path for a product catalog: 50M products, 1M QPS, updates a few thousand times a day.**
That ratio — reads outnumbering writes by an enormous factor, and writes being rare and non-urgent — says precompute everything and serve from the edge. I'd render each product's read model as a self-contained document at write time, so a read is one key lookup with no joins, and store it in a KV store rather than querying a normalized schema. Then layers: CDN with a meaningful TTL and surrogate keys tagged per product and per category, so a price change purges precisely what it should; behind that a Redis tier for edge misses; behind that the KV store; and the normalized relational source of truth serving only the write path and projection rebuilds. Because updates are rare, explicit surrogate-key purge on write is tractable here, and I'd still set a TTL as a backstop. Personalization is the part that breaks edge caching, so I'd split the response — cache the shared product body at the edge and fetch the small per-user fragment (price eligibility, recommendations, stock at your store) separately, rather than making the whole page uncacheable. At 1M QPS I'd also expect a long-tail distribution, so I'd add a short-TTL in-process L1 for the top keys to keep a single hot product from concentrating on one Redis shard. Sharding the catalog is unnecessary — 50M documents is not large, and the read scaling is entirely a caching and precomputation story.

**Q11 (staff). Users report duplicate items while scrolling an infinite feed. Diagnose.**
Almost certainly offset-based pagination against a set that's changing underneath the user: new items inserted at the head shift everything down, so page 2 re-serves rows that were on page 1 — and the inverse, deletions causing skipped rows, happens too. It also gets slower the deeper they scroll, since `OFFSET 1000000` makes the database generate and discard a million rows. The fix is keyset/cursor pagination — `WHERE (created_at, id) < (last_created_at, last_id)` — which is O(log n) regardless of depth and stable under concurrent inserts because the cursor names a position in the ordering rather than a count. The composite tie-breaker on a unique column is essential: with a timestamp alone, rows sharing a timestamp at a page boundary get silently skipped. If the product genuinely needs jump-to-page-N, that's a different requirement and I'd bound the maximum depth or precompute a page index rather than allowing unbounded offsets.

**Q12 (staff). When is scatter-gather across shards the wrong answer, and what do you do instead?**
It's wrong whenever the query is on the hot path, because p99 becomes the *maximum* of N shards' p99 rather than the average — tail-latency amplification. With 10 shards each having a 1% chance of a slow response, roughly 10% of requests are slow, and the effect worsens as you add shards, so scatter-gather actively punishes horizontal scaling. The first response is to not scatter: pick a shard key aligned to the dominant query so the common read hits one shard, and accept that secondary access patterns need their own denormalized index — a global secondary index or a separate read model keyed differently. Where I must scatter, I'd bound the damage with per-shard timeouts and return partial results with a degraded flag rather than blocking on the slowest, use hedged requests to a replica of the straggler after a p95-ish delay, and cache the merged result if the query repeats. And I'd push aggregations to write time where possible, since scatter-gather for counts and top-K is exactly what precomputation exists to eliminate.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **Read:write ratios** | Commonly 10:1, often 100:1+ on content platforms — the ratio selects the architecture |
| **Diagnose first** | Bad at 1 QPS = query plan. Degrades with QPS = capacity. p99-only = contention/outliers |
| **N+1 query** | 1 query for the list + N for children. Looks like a volume problem, is a batching bug |
| **Left-prefix rule** | `(a, b)` index serves `a` and `a`+`b`, never `b` alone |
| **Covering index** | Index contains all needed columns → index-only scan, no heap access |
| **Index cost** | Every index is a write amplifier: one B-tree write per index per insert |
| **Selectivity** | Low-cardinality columns (booleans) barely benefit from indexes |
| **Denormalization** | Precompute the join shape. Costs write amplification + staleness risk |
| **Connection pooling** | Often the real ceiling; PgBouncer/RDS Proxy can beat adding a replica |
| **Vertical scaling** | Config change, no new semantics. The win is usually RAM (working set in buffer pool) |
| **Read replica** | Async WAL shipping; scales reads near-linearly; adds lag semantics |
| **Replicas don't scale writes** | Every replica applies **100%** of writes. 10 replicas = 11× write execution |
| **Read-your-own-writes fixes** | Primary reads after write · own-data to primary · write-through cache · LSN/token reads |
| **Replication lag** | Monitor as an SLI. Serial apply can make lag grow unbounded, not settle |
| **Cache-aside** | Check cache → miss → DB → populate. The default strategy |
| **Write-through** | Write cache + DB synchronously; never stale; helps read-your-writes |
| **Write-behind** | Fast writes, risk of loss if the cache dies before flush |
| **Invalidation options** | TTL (default, self-healing) · explicit (accurate, fragile) · versioned keys (self-orphaning) |
| **Delete, don't update** | Cache updates can race and diverge permanently; deletes are idempotent |
| **Always add a TTL backstop** | Turns a missed invalidation from permanent into temporary |
| **Hit ratio non-linearity** | 90%→99% removes 90% of the *remaining* DB load |
| **LRU vs LFU** | LFU protects a stable hot set from scan-induced eviction |
| **`stale-while-revalidate`** | Serve stale instantly, refresh in background. Big latency + stampede win |
| **`Vary` footgun** | `Vary: User-Agent` shatters hit rate — normalize the cache key instead |
| **Surrogate keys** | Tag responses, purge by tag. The only tractable dynamic-content invalidation at the edge |
| **Request collapsing** | N simultaneous edge misses → 1 origin fetch |
| **Even a 5s TTL** | At 10k QPS turns 50,000 origin requests into 2 |
| **L1 in-process cache** | Nanoseconds, but per-instance and un-invalidatable → short TTL only. Great for hot keys |
| **Layered path** | Browser → CDN → gateway → L1 → Redis → buffer pool → disk |
| **Cache stampede** | Hot key expires → all requests miss at once. Fix: single-flight, jitter, early probabilistic expiry |
| **Cache penetration** | Repeated reads of nonexistent keys. Fix: negative caching + Bloom filter |
| **Cold cache** | Cache loss = DB sees 20× load = cascade. Capacity-plan or gate the refill |
| **Hot key** | One key exceeds one shard. Fix: key replication with suffixes, or L1 |
| **CQRS** | Separate write model from purpose-built read models, synced via events |
| **Fan-out-on-write** | Precompute per-recipient results at write time; celebrity fanout is the exception |
| **Sharding for reads** | Last resort — replicas and caches are cheaper. Scatter-gather makes p99 = worst shard |
| **Tail-latency amplification** | p99 of N shards ≈ worst of N. Hedged requests, per-shard timeouts, or don't scatter |
| **Offset pagination** | O(offset), and duplicates/skips rows under concurrent writes |
| **Cursor pagination** | `WHERE (ts, id) < (?, ?)` — O(log n), stable. Tie-break on a unique column |

---

## Related

- **Appendix:** [Extra Details §1 — Index Internals: Covering, Primary, and Clustered](./extra-details.md#1-index-internals-covering-primary-and-clustered) (the mechanism under §2's three lines on covering indexes)
- **Patterns:** [Scaling Writes](./scaling-writes.md) (the other half — check which side is actually saturated) · [Handling Large Blobs](./large-blobs.md) (reads too big to proxy) · [Real-Time Updates](./realtime-updates.md) (push as an optimization over this pull path)
- **Fundamentals:** [bloom-filters](../fundamentals/bloom-filters.md) · [leader-and-follower](../fundamentals/leader-and-follower.md) · [read-repair](../fundamentals/read-repair.md) · [pacelc-theorem](../fundamentals/pacelc-theorem.md) · [Use_Cases_for_Caching](../fundamentals/Use_Cases_for_Caching.md)
- **Topics:** [`distributed-caching`](../interviews/distributed-caching/README.md) · [`cdn-edge`](../interviews/cdn-edge/README.md) · [`sharding-replication`](../interviews/sharding-replication/README.md) · [`url-shortener`](../interviews/url-shortener/README.md) · [`social-feed`](../interviews/social-feed/README.md) · [`search-autocomplete`](../interviews/search-autocomplete/README.md)
