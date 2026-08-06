# System Design Key Technologies — Quick Revision

## 1. Core Database

### Relational (RDBMS)
- Tables, rows, columns; queried with SQL
- Key features: **SQL Joins**, **Indexes** (B-Tree/Hash), **ACID Transactions**
- Use for: transactional/product data (default choice)
- Popular: **Postgres** (recommended), MySQL

### NoSQL
- Schema-less; key-value, document, column-family, graph models
- Scales horizontally via consistent hashing / sharding
- Consistency: strong → eventual (configurable)
- Popular: **DynamoDB**, Cassandra (write-heavy), MongoDB

> ⚠️ Don't make broad SQL vs NoSQL comparisons. Pick one, talk about its specific properties.

→ Full classification (all data-model families + CAP/PACELC placement + a pick-a-DB decision guide): [`fundamentals/Use_Cases_for_Databases.md`](fundamentals/Use_Cases_for_Databases.md).

---

## 2. Blob Storage
- For large unstructured data: images, videos, files
- Pattern: DB stores pointer (URL) → blob in S3
- Key traits: durable (replication + erasure coding), infinitely scalable, cheap (~$0.023/GB/mo S3)
- **Chunking** (multipart upload) for large files — resumable + parallel
- Popular: **AWS S3**, GCS, Azure Blob

> Note — **Erasure coding**: split a file into data chunks + recovery chunks stored across machines. If some chunks are lost, the original is reconstructed from the remaining ones. Like RAID parity, but across many servers. Uses less storage than full replication while still surviving failures.

### Presigned URLs ⭐
A **presigned URL** is a time-limited, cryptographically signed URL that grants temporary access to a private blob — either to upload or download — **without exposing your credentials or making the object public**.

The server signs the URL using its IAM credentials + an HMAC signature. The client presents this URL directly to S3; S3 verifies the signature and grants access only for the specified **operation**, **resource (object key)**, and **time window**.

#### Upload Flow (PUT presigned URL)
```
Client  →  Server: "I want to upload profile.jpg"
Server  →  S3:     Generate presigned PUT URL (expires in 5 min)
Server  →  Client: presigned PUT URL
Client  →  S3:     PUT profile.jpg directly (server not in the middle)
S3      →  Server: Event notification (optional, via SNS/SQS/Lambda)
Server  →  DB:     Store object key / URL pointer
```
- ✅ Server never handles raw binary → saves bandwidth and compute
- ✅ Upload goes client → S3 directly (faster, no bottleneck through app servers)
- ✅ Short expiry limits abuse window if URL is leaked

#### Download Flow (GET presigned URL)
```
Client  →  Server: "Give me access to invoice_123.pdf"
Server:             Check auth → generate presigned GET URL (expires in 15 min)
Server  →  Client: presigned GET URL
Client  →  S3/CDN: GET file directly
```
- Use when objects are **private by default** (no public bucket policy)
- CDN can sit in front of S3 as origin — CDN caches the file, presigned URL still controls access

#### Key Properties
| Property | Detail |
|---|---|
| **Expiry (TTL)** | Configurable — short for uploads (1–5 min), longer for downloads (minutes to hours) |
| **Operation-scoped** | A PUT URL cannot be used for GET, and vice versa |
| **No credential exposure** | Client never sees IAM keys — only the signed URL |
| **Object-scoped** | URL is tied to a specific key (`/users/42/avatar.jpg`), not a wildcard |
| **Revocation** | Cannot revoke before expiry — design TTLs conservatively for sensitive data |

#### When to use in interviews
- **Any user-generated content flow**: profile photos, video uploads, document uploads
- **Secure private downloads**: invoices, medical records, private reports
- **Avoiding server as a proxy**: never route large binary payloads through your app server
- If asked "how does the client upload to S3?" → always answer with the presigned URL pattern, not "POST to our server"



---

## 3. Search Optimized Database
- Avoids slow `LIKE '%term%'` full table scans
- Uses **Inverted Index**: `{ "word" → [doc1, doc2] }` for fast lookups
- Key features: **Tokenization**, **Stemming** (run/running/runs → run), **Fuzzy search** (edit distance)
- Scales via sharding across nodes
- Popular: **Elasticsearch** (built on Lucene)
- Alternative: Postgres GIN indexes (good to reduce infra footprint)

---

## 4. API Gateway
- Sits in front of all services; routes requests to correct microservice
- An **API Gateway is an advanced L7 *reverse proxy*** — it centralizes cross-cutting concerns so services don't re-implement them
- Handles cross-cutting concerns: **auth, rate limiting, logging**, request transforms, TLS termination
- Almost always include in product design interviews
- Popular: AWS API Gateway, Kong, Apigee, NGINX

> → **Proxy taxonomy + use-case matrix** (forward vs reverse vs sidecar, L4 vs L7, per-system patterns for all 17 systems): [`fundamentals/Use_Cases_for_Proxies.md`](fundamentals/Use_Cases_for_Proxies.md).

---

## 5. Load Balancer
- A **load balancer is a *reverse proxy*** whose main job is spreading traffic across machines (horizontal scaling)
- **L4** (transport layer): fast + dumb — routes by IP/port only; use for persistent connections like WebSockets
- **L7** (application layer): smart + heavier — routes by header/path/cookie, decrypts TLS; default choice for HTTP
- Popular: AWS ELB (NLB=L4, ALB=L7), NGINX, HAProxy, Envoy

> → L4-vs-L7 in depth + which real system uses which: [`fundamentals/Use_Cases_for_Proxies.md`](fundamentals/Use_Cases_for_Proxies.md) §1C.

---

## 6. Queue
- Buffers bursty traffic; decouples producer and consumer
- Messages are processed at consumer's pace (not dropped!)
- ⚠️ Don't add queues to synchronous workloads with strict latency (<500ms)
- Key concepts:
  - **FIFO** ordering (most queues)
  - **Retry mechanisms** + **Dead Letter Queues** (DLQ) for failed messages
  - **Partitioning** for horizontal scaling (specify partition key)
  - **Backpressure**: reject/slow new messages when overwhelmed
- Popular: **Kafka**, **SQS**

---

## 7. Streams / Event Sourcing ⭐

### What is it?
- **Event Sourcing**: store state changes as a sequence of events → replay to reconstruct state at any point
- Unlike queues: **streams retain data** for a configurable period → consumers can re-read from a past offset
- Supports **multiple independent consumer groups** reading the same stream

### When to use?
1. **Real-time large-scale data processing** — e.g., social media engagement analytics dashboard (Flink/Spark Streaming)
2. **Event sourcing / audit trail** — e.g., banking system: every transaction stored as event, replayable for rollback/audit
3. **Pub-Sub / multiple consumers** — e.g., real-time chat: message published once, all room participants receive it

### Key concepts for interviews
| Concept | What it means |
|---|---|
| **Partitioning** | Scale by splitting stream across servers; partition key keeps related events together |
| **Consumer Groups** | Multiple groups read same stream independently (e.g., one for dashboard, one for DB archival) |
| **Replication** | Copy data across servers for fault tolerance |
| **Windowing** | Group events by time/count (e.g., hourly delivery time averages per region) |

### Popular technologies
- **Kafka** — most common; deep integration with consumer groups, retention, partitioning
- **Flink** — stream processing (stateful computations, windowing)
- **Kinesis** — AWS managed Kafka alternative

---

## 8. Distributed Lock
- Lock a resource across systems for a short period (e.g., 10 min seat hold on Ticketmaster)
- Implemented via Redis atomic `SET` + **TTL** (auto-expires if process crashes)
- **Redlock**: uses multiple Redis instances for quorum-based safe locking
- Key concepts:
  - **Lock expiry** — prevents stuck locks if process crashes
  - **Granularity** — lock single resource vs. group
  - **Deadlocks** — acquire locks in consistent order to prevent circular waits
- Use cases: e-commerce checkout hold, ride-share driver assignment, distributed cron jobs, auction bid locking

---

## 9. Distributed Cache
- In-memory store; reduces DB load and latency
- Use for: aggregated metrics, session data, expensive query results
- Key concepts:
  - **Eviction policies**: LRU (most common), FIFO, LFU
  - **Invalidation**: remove/update cache when DB changes
  - **Write strategies**:
    - Write-Through: write to cache + DB simultaneously (consistent, slower writes)
    - Write-Around: write to DB only (cache populated on next read)
    - Write-Back: write to cache first, async flush to DB (fast writes, risk of data loss)
- ✅ Be explicit about data structures (e.g., sorted sets for ranked events, not just "store in cache")
- Popular: **Redis** (rich data structures), Memcached (simple key-value)

---

## 10. CDN
- Caches content at edge servers close to users geographically
- Reduces latency for global users; offloads origin server
- Works for: static assets (images, JS, video), dynamic content, API responses
- **TTL** or cache invalidation determines freshness
- Popular: **Cloudflare**, Akamai, Amazon CloudFront

---

# Part II — Distributed Systems Building Blocks

> The sections above are the "product design" toolkit (design Instagram). The ones below are the **distributed-systems internals** that senior/staff interviews at data-infra orgs grill on. This is where "how does it actually stay correct under failure?" lives.

---

## 11. Consistency Models & CAP / PACELC ⭐

**CAP** — during a **network partition**, you must pick one:
- **CP** — reject requests that can't be made consistent (return error/timeout) → stay correct, sacrifice availability. E.g., HBase, ZooKeeper, etcd.
- **AP** — keep serving, allow replicas to diverge, reconcile later. E.g., Cassandra, DynamoDB (default).
- ⚠️ **Misconception to kill:** CAP is *not* "pick 2 of 3." When there is **no** partition you get both C and A. CAP only forces the choice **during** a partition.

**PACELC** — the fuller, more useful rule:
- **P**artition → choose **A** or **C**
- **E**lse (normal operation) → choose **L**atency or **C**onsistency
- Dynamo/Cassandra = **PA/EL** (availability + low latency). Spanner = **PC/EC** (consistency always, pays latency).

**Consistency spectrum** (strong → weak):
| Model | Guarantee |
|---|---|
| **Linearizable** | Every read sees the latest committed write; system behaves like a single copy. Most expensive. |
| **Sequential** | All nodes agree on one order of ops (not necessarily real-time order) |
| **Causal** | Causally-related ops seen in order; concurrent ops may be seen differently |
| **Eventual** | Replicas converge *if writes stop*; no ordering guarantee in the meantime |

**Client-centric guarantees** (cheap, often "good enough"):
- **Read-your-writes** — you always see your own updates
- **Monotonic reads** — you never see time move backwards
- **Consistent prefix** — you never see an answer before its question

→ **Which database sits at which CAP/PACELC point** (Spanner = PC/EC, Dynamo/Cassandra = PA/EL, etc.) + how to read a PACELC label: [`fundamentals/Use_Cases_for_Databases.md`](fundamentals/Use_Cases_for_Databases.md) §3.
→ Deep dive: `interviews/distributed-transactions/`

---

## 12. Replication
Copy data to N nodes for durability + read scaling + HA.

| Model | How writes work | Key tradeoff |
|---|---|---|
| **Leader–Follower** (single-leader) | All writes go to the leader → replicated to followers | Simple, no write conflicts; leader is the write bottleneck/SPOF (needs failover) |
| **Multi-Leader** | Several leaders accept writes, replicate to each other | Write availability across regions; must **resolve write conflicts** |
| **Leaderless** (Dynamo-style) | Client writes to N nodes, reads from a quorum | No failover step; needs **quorum + conflict resolution** |

- **Sync** replication → wait for follower ack: no data loss, higher latency.
- **Async** → ack immediately: fast, but un-replicated writes are lost if the leader crashes.
- **Semi-sync** → wait for ≥1 follower: common middle ground.
- **Replication lag** causes stale reads and breaks read-your-writes → route a user's reads to the leader (or pin to a version/LSN) right after they write.

**RPO / RTO — the recovery targets that pick your replication mode** (pair these with the "nines"):
- **RPO (Recovery Point Objective)** — max *data loss* tolerated, measured in time. **RPO = 0 ⇒ synchronous** (or semi-sync) replication; the write isn't ack'd until a replica has it.
- **RTO (Recovery Time Objective)** — max *downtime* tolerated after a crash. Low RTO ⇒ **automated failover + hot standby** (auto-promote a replica), not manual recovery.
- Rule of thumb: **RPO chooses the replication *mode*** (0 → sync); **RTO chooses the failover *automation*** (seconds → hot standby). TicketMaster wants RPO=0 (no lost booking); Nearby Friends tolerates ~5 s RPO (a lost GPS ping is fine).

**Replication use-case matrix (pattern → real system → why).** Full breakdown + repo map: [`fundamentals/Use_Cases_for_Redundancy_and_Replication.md`](fundamentals/Use_Cases_for_Redundancy_and_Replication.md). Each system links to its topic folder. ⚠️ Tech names are illustrative teaching heuristics — verify against primary sources.

| System | Replication pattern | Mode | Why this pattern | Folder |
|---|---|---|---|---|
| TinyURL | Single-leader + Redis replicas | Async | 100:1 reads → replicas serve redirects; VIP auto-failover | [url-shortener](interviews/url-shortener/) |
| Dropbox | Reed-Solomon erasure coding + Paxos metadata | Sync (metadata) | 11-nines block durability + strict metadata accuracy | [file-storage](interviews/file-storage/) |
| Pastebin | Multi-AZ erasure coding + DB replica | Async media / Sync DB | Durable pastes, low storage overhead, fast global reads | [file-storage](interviews/file-storage/) |
| Instagram | Primary-replica shards + multi-region CDN | Async | Local timeline/photo reads from nearby replicas | [social-feed](interviews/social-feed/) |
| FB Messenger | Leaderless quorum (N=3, W=2, R=2) | Quorum | Messages never lost; high cross-DC write availability | [chat-system](interviews/chat-system/) · [kv-store](interviews/kv-store/) |
| Twitter | Kafka RF=3 + Redis replicas | Async | Durable timeline fan-out; instant feed failover | [social-feed](interviews/social-feed/) · [message-queues](interviews/message-queues/) |
| YouTube | Multi-tier CDN dynamic replication | Async | Viral videos fan out to edge by view count (1 → 1000+) | [video-streaming](interviews/video-streaming/) · [cdn-edge](interviews/cdn-edge/) |
| Netflix | Multi-region active-active (Cassandra) | Async (cross-region) | Evacuate a whole region without stream interruption | [video-streaming](interviews/video-streaming/) |
| Typeahead | Immutable trie read-replica swaps | Batch / snapshot | sub-20 ms lookups from RAM, no write locks | [search-autocomplete](interviews/search-autocomplete/) |
| API Rate Limiter | Redis Sentinel + local fallback | Async | Keep enforcing limits when a cache shard fails | [rate-limiting](interviews/rate-limiting/) |
| Twitter Search | Inverted-index shard replicas | Async | Balance heavy search across redundant index shards | [search-autocomplete](interviews/search-autocomplete/) |
| WebCrawler | Replicated task queues + DB sync | Async | Re-queue lost fetch tasks when a worker dies | [web-crawler](interviews/web-crawler/) |
| FB NewsFeed | TAO multi-region graph cache | Async invalidation | Local cache reads vs primary-region writes | [social-feed](interviews/social-feed/) |
| Yelp | Single-leader + read replicas | Async | Scale read-mostly business pages per region | *[ride-sharing](interviews/ride-sharing/) geo pattern* |
| Nearby Friends | Ephemeral memory ring + Redis geo | Async | 100K+ GPS writes/s; speed over durability (~5 s RPO OK) | [ride-sharing](interviews/ride-sharing/) |
| Uber | Active-active stateful (Ringpop) | Sync in-memory | Stateful failover for live trip/match sessions | [ride-sharing](interviews/ride-sharing/) |
| TicketMaster | Leader-follower + Raft locks | Sync | RPO = 0 — never double-book a seat during a drop | [seat-reservation](interviews/seat-reservation/) |

→ Existing folder: `interviews/sharding-replication/`

---

## 13. Partitioning / Sharding
Split one dataset across nodes so it can exceed a single machine.

| Strategy | How | Watch out |
|---|---|---|
| **Range** | Split by key ranges (A–F, G–M…) | Great for range scans; **hot partitions** on sequential keys (timestamps, auto-inc IDs) |
| **Hash** | `hash(key)` → partition | Even spread; destroys range-scan locality |
| **Consistent hashing** | Hash ring + virtual nodes | Minimal data reshuffle on node add/remove |
| **Directory** | Lookup service maps key → shard | Flexible re-mapping; the lookup is a SPOF/bottleneck |

- **Hot shard / celebrity key** — one partition takes disproportionate load → split it, add a suffix to spread the key, or front it with a cache.
- **Rebalancing** — moving partitions when you scale in/out; do it online (vnodes make this cheap).
- **Cross-shard queries/joins** are expensive (scatter-gather) → choose the partition key to match your dominant access pattern.

→ Deep dive: `interviews/consistent-hashing/`, `interviews/sharding-replication/`

---

## 14. Consensus & Coordination ⭐
Getting a cluster to **agree** despite failures — leader election, membership, config, distributed locks.

- **Why**: prevents **split-brain** (two nodes each believing they're the leader). A single coordinator is a SPOF; consensus replicates the *decision* itself.
- **Algorithms**: **Paxos** (Lamport — correct, notoriously hard), **Raft** (Ongaro & Ousterhout, 2014 — designed for understandability: leader election + replicated log), **ZAB** (ZooKeeper).
- **Quorum**: a decision needs a **majority** = ⌊N/2⌋+1. Use **odd** cluster sizes — 3 tolerates 1 failure, 5 tolerates 2. (A 2-node cluster can't form a majority after any failure → avoid.)
- **FLP impossibility**: no deterministic consensus is guaranteed in a *fully asynchronous* network with even one crash-fault → real systems use timeouts + randomization to make progress in practice.
- **Coordination services**: **etcd** (Raft), **ZooKeeper** (ZAB), **Consul** (Raft) — used for leader election (lease / ephemeral node), service discovery, config, and locks.
- ⚠️ Consensus is expensive (a network round-trip + fsync per commit) → keep it **off the hot path**; shard into per-range Raft groups; use leases for fast reads.

→ Deep dive: `interviews/consensus/`

---

## 15. Clocks & Ordering
Wall clocks (NTP) drift and skew across machines → **never** order distributed events by `Date.now()` alone.

| Mechanism | What it buys you |
|---|---|
| **Lamport clock** | A logical counter: if A→B then LC(A) < LC(B) (but not the converse) |
| **Vector clock** | Detects **concurrency** — tells you whether two events are ordered or *truly concurrent* (a conflict) |
| **Hybrid Logical Clock (HLC)** | Physical time + logical counter — timestamps that track real time *and* preserve causality |
| **TrueTime** (Spanner) | Bounded clock uncertainty (GPS + atomic clocks); wait out the uncertainty window ε to get a global order |

- Use logical/vector clocks for causality & conflict detection; use HLC/TrueTime when timestamps must also mean something in wall-clock time.

---

## 16. Conflict Resolution
When concurrent writes land on different replicas (multi-leader / leaderless), you must reconcile them.

| Strategy | How | Cost |
|---|---|---|
| **Last-Write-Wins (LWW)** | Highest timestamp wins | Simple; **silently drops** the losing write; sensitive to clock skew |
| **Vector clocks + siblings** | Keep concurrent versions, resolve on read | No data loss; app/client must merge |
| **CRDTs** | Data types that merge deterministically (counters, sets, maps, registers) | Conflict-free *by construction*; limited to CRDT-able shapes |
| **CAS / optimistic concurrency** | Write only if the version is unchanged (compare-and-swap) | Prevents lost updates; caller retries on mismatch |

- **CAS is the everyday one**: read value + version → write "only if version == X" → on mismatch, re-read and retry. This is how you prevent lost updates without holding a lock.

---

## 17. Storage Engines (LSM-Tree vs B-Tree) ⭐
How a database physically persists data — this dictates its read/write performance profile.

| | **B-Tree** | **LSM-Tree** |
|---|---|---|
| Write path | In-place update (random I/O) | Append to WAL + in-memory **MemTable** → flush to immutable **SSTable** (sequential I/O) |
| Read path | Fast, direct (one tree walk) | Check MemTable → SSTables newest→oldest; **Bloom filter** skips SSTables that can't have the key |
| Optimized for | Read-heavy, range scans | **Write-heavy** ingest |
| Used by | Postgres, MySQL/InnoDB | Cassandra, RocksDB/LevelDB, Bigtable/HBase |

- **Compaction** — LSM merges SSTables in the background (size-tiered vs leveled), reclaiming space from overwrites/tombstones; can cause **write stalls** if it falls behind.
- **Amplification (RUM conjecture)** — you trade off **R**ead / **write** / **space** amplification; you can optimize two at the third's expense.
- **WAL (write-ahead log)** — durability primitive: append the change *before* applying it; replay on crash recovery.
- **Bloom filter** — probabilistic set membership: answers "definitely not present" or "maybe present" (**no false negatives**). Lets an LSM engine skip disk reads cheaply.

→ Deep dive: `interviews/storage-engines/`

---

## 18. Distributed Transactions & Idempotency
Atomicity across services/shards — the genuinely hard part of microservices.

- **Dual-write problem**: writing to the DB and to a queue as two separate steps isn't atomic → one can fail. Fix with the **Outbox pattern**: write the event to an outbox table *in the same DB transaction*, then a relay/CDC publishes it.
- **2PC (two-phase commit)**: prepare → commit across all participants. Correct but **blocking** — if the coordinator crashes after "prepare," participants are stuck holding locks; hurts availability.
- **Saga**: a sequence of local transactions, each with a **compensating action** to undo it. *Orchestration* (central coordinator) vs *choreography* (services react to events). No isolation between steps → guard with semantic locks / commutative updates.
- **Idempotency**: makes retries safe. Client sends an **idempotency key**; the server dedupes it. "Exactly-once" in practice = at-least-once delivery + an idempotent consumer.
- ⚠️ **Senior move**: often the best answer is to **redesign the boundaries** so a distributed transaction isn't needed at all.

→ Deep dive: `interviews/distributed-transactions/`

---

## 19. Resiliency Patterns
Keep one component's failure from cascading into a full outage.

| Pattern | What it does |
|---|---|
| **Timeout** | Never block forever on a dependency |
| **Retry + backoff + jitter** | Retry transient failures, exponentially, with randomness so clients don't retry in lockstep |
| **Circuit breaker** | Trip *open* after repeated failures → fail fast; *half-open* to probe recovery; *closed* when healthy |
| **Bulkhead** | Isolate resources (thread/connection pools) per dependency so one slow call can't starve everything |
| **Backpressure / load shedding** | Reject or slow intake when overwhelmed; drop low-priority work first |
| **Hedged requests** | After p95, send a duplicate to another replica; take whichever responds first (cuts tail latency) |
| **Idempotency** | Makes the retries above safe (see §18) |

- ⚠️ Retries **without** backoff+jitter and a circuit breaker = a **retry storm** that amplifies the very outage you're reacting to.

→ Existing notes: `fundamentals/circuit-breaker.md`, `fundamentals/chaos-monkey.md`

---

## 20. Observability
You cannot operate what you cannot see. Three pillars:

| Pillar | Answers | Tools |
|---|---|---|
| **Metrics** | "Is it healthy? how much?" (cheap aggregates) | Prometheus, Grafana |
| **Logs** | "What exactly happened for this one event?" | ELK, Loki |
| **Traces** | "Where did the time go across services?" | OpenTelemetry, Jaeger |

- **SLI / SLO / SLA**: SLI = a measured signal (e.g., p99 latency, success rate); **SLO** = your internal target (99.9%); SLA = the contractual promise + penalty. **Error budget = 1 − SLO** → it governs how much risk you can spend on shipping.
- **Alert on symptoms, not causes** (user-facing and actionable). Methods: **RED** (Rate, Errors, Duration — for services) and **USE** (Utilization, Saturation, Errors — for resources). The four **golden signals**: latency, traffic, errors, saturation.
- ⚠️ **Cardinality explosion**: high-cardinality metric labels (user_id, request_id) blow up storage/cost → keep label sets bounded; put high-cardinality data in traces/logs instead.

→ Deep dive: `interviews/observability/`

---

# Part III — When to Use What (Situational / Use-Case Driven)

> Parts I & II answer *"what is this tool?"* This part answers the interview question that actually earns points: *"given **this situation**, which strategy fits — and why?"* Each row is anchored to a concrete scenario from the [food-delivery](interviews/food-delivery/radio-walkthrough.md) and [e-commerce](interviews/e-commerce/radio-walkthrough.md) walkthroughs so the choice is defensible, not memorized.

## 21. Which Database Fits This Situation?

The senior move is **never** "SQL vs NoSQL" in the abstract — it's "this access pattern + this consistency bar → this store." Match the *property* to the *situation*:

| Situation (the tell) | Store type | Concrete example | Why it wins here |
|---|---|---|---|
| Money, state machine, "must be exactly right" | **RDBMS (Postgres, ACID)** | Order & checkout; payment ledger | Transactions + `UNIQUE` idempotency constraint + guarded conditional writes; correctness > scale (write volume is small) |
| "Must never reject a write," multi-device, mergeable | **AP key-value (DynamoDB/Cassandra)** | Shopping cart | Availability-first; a rejected write = lost revenue; merge concurrent versions with vector clocks / add-wins |
| Write-heavy, ephemeral, expires fast | **In-memory + TTL (Redis)** | Courier GPS pings (125K writes/s), seat holds | Firehose must never touch the transactional DB; a lost datum is re-sent, nothing to recover |
| Read-heavy, tolerates slight staleness | **RDBMS + read-replicas + cache** | Product catalog, restaurant/menu | Reads dominate ~1000:1 → serve from cache/replicas, primary reserved for writes |
| Full-text / fuzzy / faceted search | **Inverted index (Elasticsearch)** | Product & restaurant/dish search | Avoids `LIKE '%..%'` scans; CDC-fed from the source DB (not the source of truth) |
| Geospatial "what's near this lat/lng" | **Geo index (S2/H3, PostGIS, Redis GEO)** | Serviceable restaurants, courier matching | Cell-based lookup instead of scanning every row |
| Large binary (images, video) | **Blob store (S3) + CDN**; DB holds the pointer | Product images, menu photos | Cheap, durable, offloads origin; never stream binaries through app servers |
| Append-only, replayable, multi-consumer | **Log/stream (Kafka)** | Order events, analytics, outbox relay | Retains data → replay from offset; many independent consumer groups |
| Write-heavy ingest, range scans | **LSM-tree engine (Cassandra/RocksDB)** | Time-series, event logs | Sequential writes; see §17 |
| Read/range-scan-heavy, point lookups | **B-tree engine (Postgres/InnoDB)** | Orders, users, catalog | In-place reads; see §17 |

> **Interview line:** *"I don't pick a database, I pick a property. This path needs [ACID / availability / expiry / search / geo] because [situation], so I'd reach for [store] — swappable for any store with that property."*

## 22. Which Caching Strategy Fits?

Two independent decisions: **write strategy** (how the cache and DB stay in step) and **invalidation** (how staleness is bounded).

**Caching use-case matrix (layers → strategy → invalidation → why).** Full breakdown + repo map: [`fundamentals/Use_Cases_for_Caching.md`](fundamentals/Use_Cases_for_Caching.md) — same 17 systems, same order, as the replication matrix in §12, so row *N* is the same product in both. Each system links to its topic folder. ⚠️ Tech names are illustrative teaching heuristics — verify against primary sources.

- **The two dials:** **hit ratio** (sets *capacity*) and **freshness window** (sets *correctness*). Origin load = `QPS × (1 − hit_ratio)` — at 10⁶ QPS a **99%** hit ratio still leaves **10,000 QPS** on the DB; 99.9% leaves 1,000. **The last nine is the one that saves you.**
- **A replica is a copy you may trust; a cache is a copy you may lose.** Losing a replica = a durability incident; losing a cache = your origin eats 100% of traffic, usually the worse outage. Corollary: **you replicate a cache to protect your database, not the data.**
- **The senior question is "what happens when the cache is empty?"** If the origin can't survive 100% of traffic, the cache is **load-bearing capacity**, not an optimization, and needs its own capacity plan and warm-up path.

| Situation | Write strategy | Invalidation / TTL | Example |
|---|---|---|---|
| Read-mostly, rarely updated, large body | **Cache-aside** + **version-keyed** (immutable key) | Bump version → new key → old ages out; purge CDN by surrogate key | Product body / menu keyed by `version` / `menu_version` |
| Volatile value, slight staleness OK | **Write-around** (write DB, cache fills on read) | **Short TTL** (5–30 s) | Price / availability overlay |
| Must read your own write immediately | **Write-through** (cache + DB together) | Consistent by construction (slower writes) | Session, profile edits |
| Write-heavy, can tolerate small loss window | **Write-back** (cache first, async flush) | Flush interval | High-frequency counters (risky — data-loss window) |
| Ranked / leaderboard / sorted reads | Cache-aside with **Redis sorted sets** | Recompute or incrementally update | "Top restaurants," feed ranking |

**Failure mode to always name — the thundering herd / cache stampede:** a hot key expires and 10⁶ clients miss at once. Fix with **request coalescing (single-flight)** + **jittered TTLs** (don't expire in lockstep) + **stale-while-revalidate**. This is the existential risk of the e-commerce read path (§Deep dive 1 in the walkthrough).

> **Interview line:** *"Immutable content → version the cache key and cache forever. Volatile content → short TTL and re-check the source of truth at the money moment. The stock badge is a cached UX hint; overselling is prevented by the authoritative check at checkout, not the cache."*

## 23. Which Replication Strategy Fits?

| Situation | Strategy | Sync mode | Example |
|---|---|---|---|
| Single-writer truth, read scaling | **Leader–follower** | **Async** for read replicas (accept lag) | Order DB: writes → primary, browse reads → replicas |
| Can't lose a committed write | Leader–follower | **Sync / semi-sync** (wait ≥1 follower) | Payment / ledger writes |
| Multi-region writes, low latency everywhere | **Multi-leader** or **leaderless (Dynamo)** | Async + **conflict resolution** | Cart (leaderless AP), globally distributed writes |
| Read-your-writes right after a write | Leader–follower, but **route the user's reads to the leader** (or pin to LSN/version) for a short window | — | "I just placed an order and want to see it" |
| No failover step tolerable | **Leaderless quorum** (W+R>N) | Tunable per request | Dynamo-style KV / cart |

**Replication lag is the trap:** async replicas serve stale reads → breaks read-your-writes. Mitigate by routing post-write reads to the leader or pinning to a version. (Depth: [sharding-replication](interviews/sharding-replication/), [kv-store](interviews/kv-store/).)

## 24. Which Consistency Model Fits? (the gradient idea)

The single highest-signal framing in both walkthroughs: **match consistency to the path; don't use one model everywhere.**

| Path / situation | Model | Because |
|---|---|---|
| Browse / catalog / menu | **Eventual** | A stale price/badge is a UX blemish, not a correctness bug; buys cache + CDN + replicas |
| Cart | **Availability-first (AP)** | A rejected write is lost revenue; reconcile concurrent versions later |
| Checkout / inventory / payment | **Strong (CP / linearizable)** | Oversell and double-charge move real money — must never happen |
| Fulfillment / notifications / analytics | **Async / at-least-once + idempotent** | Must happen reliably but not synchronously; a spike becomes a backlog |

> **Interview line:** *"As the user moves toward the money, required consistency rises and tolerable staleness falls. Browse → eventual, cart → AP, checkout → strong, fulfillment → async. Each is a different CAP point on different infrastructure."* (See CAP/PACELC in §11.)

## 25. Which Distributed-Systems Pattern Solves This Problem?

| The problem (situation) | Pattern | Example |
|---|---|---|
| Retry / double-click must not double-charge | **Idempotency key** (`UNIQUE` in txn + stored response) | `POST /orders` |
| Atomic action across service-owned DBs | **Saga + compensating actions** (not 2PC) | reserve→authorize→create→ship, unwound on failure |
| "Wrote DB and queue as two steps — one failed" | **Transactional outbox** (+ CDC relay) | `order` + `OrderPlaced` in one txn |
| Prevent overselling a finite resource | **Guarded conditional write** (`WHERE stock-reserved>=qty`, 0 rows = sold out) | Inventory / menu-item decrement |
| Concurrent writes to different replicas | **Vector clocks + siblings** or **CRDTs** or **CAS** | Cart merge; lost-update prevention |
| One partition takes disproportionate load | **Hot-key mitigation** (cache in front, split, key-suffix) | Viral product, dinner-rush geo-cell |
| A dependency is failing — stop the cascade | **Circuit breaker + timeout + backoff&jitter** | PSP / downstream service calls |
| Spike will overwhelm the system | **Backpressure / load-shed by priority + queue backlog** | Prime Day, dinner rush |
| Size connections / threads / pools | **Little's Law** (concurrent = arrival × lifetime) | ~3M live tracking connections |

---

## Quick Decision Guide

| Need | Use |
|---|---|
| Transactional/relational data | Postgres |
| Unstructured/scale-out data | DynamoDB |
| Files, images, videos | S3 + CDN |
| Full-text search | Elasticsearch |
| Route & auth microservices | API Gateway |
| Distribute load | Load Balancer (L4 for WS, L7 for HTTP) |
| Async work / decouple | Queue (SQS/Kafka) |
| Real-time processing / event replay | Stream (Kafka + Flink) |
| Short-term resource lock | Redis distributed lock |
| Fast repeated reads | Redis cache |
| Global static content | CDN |
| Agree across nodes / elect a leader | Consensus (Raft) via etcd / ZooKeeper |
| Atomic op across services | Saga + Outbox + idempotency keys (avoid 2PC) |
| Detect concurrent writes | Vector clocks; resolve via CRDT / LWW / CAS |
| Prevent lost updates | CAS / optimistic concurrency |
| Write-heavy storage | LSM-tree engine (Cassandra/RocksDB) |
| Read / range-scan-heavy storage | B-tree engine (Postgres/InnoDB) |
| Order distributed events | Logical / vector clocks or HLC — never raw wall clock |
| Stop cascading failure | Circuit breaker + timeout + backoff&jitter |
| Know if the system is healthy | Metrics + SLO + error budget |

---

## Availability Cheat Sheet ("nines")

| Availability | Downtime / year | Downtime / month |
|---|---|---|
| 99% (two nines) | ~3.65 days | ~7.2 hours |
| 99.9% (three nines) | ~8.77 hours | ~43.8 min |
| 99.99% (four nines) | ~52.6 min | ~4.38 min |
| 99.999% (five nines) | ~5.26 min | ~26 sec |

> **Dependencies in series multiply**: three services at 99.9% each ≈ 99.7% combined (0.999³). Add **redundancy in parallel** to raise it back up. Always state your availability target *before* designing — it dictates replication, failover, and multi-region.

---

## Latency Numbers to Reason With (order-of-magnitude)

> ⚠️ These are the classic teaching figures ("Jeff Dean / Peter Norvig numbers"). Treat them as **order-of-magnitude for relative reasoning only** — real hardware has improved (modern NVMe SSDs are much faster than the original numbers) and values vary. Do not quote them as exact.

| Operation | Rough time | Takeaway |
|---|---|---|
| L1 cache reference | ~1 ns | — |
| Main memory reference | ~100 ns | ~100× slower than L1 |
| SSD random read | ~16–150 µs | ~1000× slower than RAM |
| Round trip, same datacenter | ~0.5 ms | Cheap; chatty in-DC calls are OK-ish |
| Read 1 MB sequentially from SSD | ~1 ms | — |
| Disk (HDD) seek | ~10 ms | Random HDD I/O is the enemy |
| Round trip across continents | ~150 ms | **Cross-region is 100–1000× a same-DC hop → keep chatty calls in-region** |

**How to use in an interview:** memory ≫ SSD ≫ disk ≫ cross-region network. This is *why* we cache (avoid disk), *why* we co-locate (avoid cross-region hops), and *why* consensus/2PC across regions is slow (each round-trip is ~100 ms+).