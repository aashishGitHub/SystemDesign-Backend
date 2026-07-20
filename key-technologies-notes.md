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
- Handles cross-cutting concerns: **auth, rate limiting, logging**
- Almost always include in product design interviews
- Popular: AWS API Gateway, Kong, Apigee, NGINX

---

## 5. Load Balancer
- Distributes traffic across multiple machines (horizontal scaling)
- **L4** (transport layer): use for persistent connections like WebSockets
- **L7** (application layer): flexible routing, minimizes connection load — default choice for HTTP
- Popular: AWS ELB, NGINX, HAProxy

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