# System Design Interview Roadmap
## Target: Google, Meta, Amazon, Microsoft, Uber, Stripe (L5/L6 / Senior / Staff)

> **How to use this file:**
> This is your single source of truth. Every topic has a status, a priority, a study order, a folder, and a checklist of what to build inside that folder.
> Update the status column as you complete each topic.
> Do not skip P1 topics. Do not start P3 before finishing P1.

---

## Progress Dashboard

| Category | Total Topics | ✅ Done | 🔄 In Progress | 🔲 Not Started |
|---|---|---|---|---|
| Core Patterns | 10 | 6 | 0 | 4 |
| Classic Problems | 18 | 5 | 0 | 13 |
| Advanced Topics | 6 | 0 | 0 | 6 |
| **Total** | **34** | **11** | **0** | **23** |

---

## How Each Topic Folder is Structured

Every topic lives at `interviews/<topic-slug>/` and contains exactly these files:

```
interviews/
  <topic-slug>/
    README.md       ← Index, problem statement, learning path, how to use
    questions.md    ← All interview questions (beginner → architect level)
    answers.md      ← Concise answers keyed to question numbers
    deep-dive.md    ← In-depth explanations, real-world examples, failure modes
```

**Creation checklist for each topic:**
- [ ] `README.md` — problem statement, constraints, learning path table, file index
- [ ] `questions.md` — minimum 30 questions, 8+ levels, beginner → architect
- [ ] `answers.md` — every question answered with code examples and tradeoff tables
- [ ] `deep-dive.md` — 3 depths per concept (🟢 beginner, 🟡 senior, 🔴 architect), real-world company examples, failure modes, quick recall cheat sheet at end

---

## Recommended Study Order

```
Week 1-2:   P1 Core Patterns (foundation for everything else)
Week 3-4:   P1 Classic Problems (most interviewed)
Week 5-6:   P2 Classic Problems
Week 7:     P2 Core Patterns
Week 8+:    P3 Advanced Topics + mock interviews
```

---

## Part 1: Core Patterns
> These are the **building blocks** used inside every problem breakdown.
> Master these first — you'll reference them in every problem interview.

---

### Pattern 1 — Rate Limiting
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/rate-limiting/`

**What it covers:**
Token bucket, leaky bucket, sliding window log, sliding window counter, fixed window counter. Distributed rate limiting across multiple API servers. Redis-based implementations. API Gateway integration. Per-user vs per-IP vs per-endpoint limits. DDoS mitigation.

**Why Google asks this:**
Every large-scale API must be protected. Rate limiting is asked as both a standalone design and as a sub-component of any service design.

**Key interview questions to anticipate:**
- How does token bucket differ from leaky bucket?
- How do you share rate limit state across 100 API server replicas?
- What's the race condition in a naive Redis `INCR` + `EXPIRE` implementation?
- How would you implement rate limiting without Redis?

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Pattern 2 — Consistent Hashing
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/consistent-hashing/`

**What it covers:**
The problem with modulo hashing and rehashing. Virtual nodes (vnodes). Ring-based routing. Minimal disruption on node add/remove. Real-world use in Cassandra, DynamoDB, Redis Cluster, CDN routing. Weighted virtual nodes for heterogeneous hardware.

**Why Google asks this:**
Any system with a sharded cache or distributed storage (Bigtable, Spanner, Memcache) uses consistent hashing. Interviewers probe this when you say "shard by user_id."

**Key concepts → deep-dive sections:**
- 🟢 The rehashing problem with `hash(key) % n`
- 🟡 Virtual nodes on the ring
- 🔴 Gossip protocol for ring membership changes

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Pattern 3 — Database Sharding & Replication
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/sharding-replication/`

**What it covers:**
Horizontal vs vertical scaling. Range-based vs hash-based vs directory-based sharding. Read replicas. Leader-follower vs multi-master replication. Replication lag and read-your-own-writes consistency. Hot shard problem. Cross-shard queries and transactions.

**Why Google asks this:**
"How would you scale this to 1 billion users?" always leads to DB sharding and replication. This is unavoidable in any final-round design interview.

**Key interview questions to anticipate:**
- You have a users table with 2 billion rows. How do you shard it?
- A user writes a post and immediately reads it back — they see the old state. Why? How do you fix it?
- What's a hot shard and how do you mitigate it?
- What's the difference between synchronous and asynchronous replication?

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Pattern 4 — Distributed Caching
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/distributed-caching/`

**What it covers:**
Cache-aside vs write-through vs write-back vs write-around. Cache eviction policies (LRU, LFU, FIFO). Redis data structures (String, Hash, List, Set, Sorted Set, HyperLogLog). Cache stampede / thundering herd. Cache penetration, avalanche, breakdown. Multi-layer caching (L1 in-process + L2 Redis + L3 DB). CDN as a cache layer. Cache warming strategies.

**Why Google asks this:**
Caching is the single most common performance optimization in system design. Every Google-scale system has multiple caching layers. Misconfigured caches cause outages.

**Key interview questions to anticipate:**
- What's the difference between cache-aside and write-through?
- How do you handle cache stampede in a popular user's profile?
- What Redis data structure would you use to store a leaderboard and why?
- You cache DB results. Then the DB gets updated. How does the cache know?

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Pattern 5 — Message Queues & Event Streaming
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/message-queues/`

**What it covers:**
Point-to-point vs pub-sub. Kafka vs RabbitMQ vs SQS vs Pulsar. At-least-once vs exactly-once delivery. Consumer groups. Backpressure. Dead letter queues. Outbox pattern. Transactional outbox. Idempotency. Event ordering. Compacted topics. Stream processing (Kafka Streams, Flink).

**Why Google asks this:**
> Note: Kafka was covered as a sub-topic in the recommendation-system. This topic standalone goes deeper into the patterns, tradeoffs between queue technologies, and stream processing.

**Key interview questions to anticipate:**
- How do you guarantee exactly-once delivery in Kafka?
- What is the outbox pattern and why does it exist?
- Kafka vs RabbitMQ — when do you use each?
- How do you handle message ordering when you need it globally (not just per-partition)?

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Pattern 6 — CDN & Edge Computing
**Status:** 🔲 Not Started | **Priority:** P1 | **Folder:** `interviews/cdn-edge/`

**What it covers:**
What a CDN is and how it routes requests (Anycast DNS, GeoDNS). Push vs pull CDN. Cache-Control headers, TTL, purging. Edge functions (Cloudflare Workers, Lambda@Edge). CDN for dynamic vs static content. Origin shield. Multi-CDN strategy. CDN for video streaming (HLS, DASH, byte-range requests). Cache hit ratio optimization.

**Why Google asks this:**
Any system serving media (Netflix, YouTube, Instagram) or global users (Google Maps) requires CDN knowledge. "How would you reduce latency for global users?" always involves CDN.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Pattern 7 — Load Balancing & Service Discovery
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/load-balancing/`

**What it covers:**
L4 vs L7 load balancing. Algorithms: round-robin, least connections, IP hash, weighted, consistent hash. Health checks. Session affinity (sticky sessions). Service discovery (Consul, Kubernetes DNS, etcd). Sidecar pattern. Client-side vs server-side load balancing. Global load balancing (GeoDNS, Anycast).

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Pattern 8 — API Design (REST vs GraphQL vs gRPC)
**Status:** ✅ Done | **Priority:** P2 | **Folder:** `interviews/api-design/`

**What it covers:**
REST principles, idempotency, HTTP status codes, versioning strategies. GraphQL: queries, mutations, subscriptions, N+1 problem, DataLoader. gRPC: protobuf, streaming, when to use vs REST. Pagination (cursor vs offset vs keyset). Idempotency keys for payment APIs. API gateway patterns. Rate limiting at API level.

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Pattern 9 — Blob / Object Storage
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/blob-storage/`

**What it covers:**
S3 architecture (buckets, objects, multipart upload). Presigned URLs. Chunked upload & resumable uploads. Data durability (11 nines). Replication across AZs/regions. Lifecycle policies. Versioning. Access control (IAM, bucket policy, ACL). CDN in front of S3. Use of blob storage as event archive (Kafka → S3 via connector).

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Pattern 10 — Distributed Transactions & Consistency
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/distributed-transactions/`

**What it covers:**
ACID vs BASE. CAP theorem (what it actually says vs common misunderstandings). 2-Phase Commit (2PC). Saga pattern (choreography vs orchestration). Eventual consistency. Strong vs eventual consistency at application level. Compensating transactions. Distributed locks (Redlock, etcd, ZooKeeper). Optimistic vs pessimistic locking.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

## Part 2: Classic Problem Breakdowns
> These are the full end-to-end system design problems asked in interviews.
> Each builds on 3–5 core patterns from Part 1.

---

### Problem 1 — Personalized Recommendation Engine ✅
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/recommendation-system/`

**Patterns used:** Kafka, Embeddings/Vector DB, Distributed Caching, CDN, Observability
**Files:** README.md ✅ | questions.md ✅ | answers.md ✅ | deep-dive.md ✅

---

### Problem 2 — URL Shortener (TinyURL / Bitly)
**Status:** 🔲 Not Started | **Priority:** P1 | **Folder:** `interviews/url-shortener/`

**What it covers:**
Encoding strategies (Base62, MD5+truncation). ID generation at scale (auto-increment vs Snowflake ID). Redirect types (301 vs 302). Custom aliases. Expiry. Analytics (click counting, geo tracking). Read-heavy optimization (Redis cache in front of DB). Handling collisions. DB sharding by short code. Abuse prevention.

**Patterns used:** Consistent Hashing, Distributed Caching, Rate Limiting, Blob Storage (QR codes)

**Why Google asks this:**
Classic beginner-friendly problem that tests ID generation, hashing, caching, and read optimization fundamentals. Often a 30-min warm-up before a harder problem.

**Key interview questions to anticipate:**
- How do you guarantee unique short codes at scale with multiple write servers?
- Why use 302 vs 301 redirect? What are the business implications?
- How would you implement click analytics without slowing down redirects?
- How do you prevent someone from creating billions of URLs to exhaust storage?

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 3 — Twitter / X Social Feed (News Feed Design)
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/social-feed/`

**What it covers:**
Fan-out on write vs fan-out on read vs hybrid. Social graph storage (adjacency list, graph DB). Timeline aggregation. Celebrity problem (accounts with 100M+ followers). Ranking and ML scoring. Home feed vs user timeline. Real-time updates (WebSockets, SSE). Pagination of infinite feeds. Eventual consistency in feeds.

**Patterns used:** Message Queues, Distributed Caching, Sharding, CDN, Load Balancing

**Why Google asks this:**
News feed design is the canonical "fan-out" problem. Every social product (Instagram, LinkedIn, Twitter, YouTube subscriptions) has this. The celebrity/hot user problem is a key differentiator for senior-level answers.

**Key interview questions to anticipate:**
- Fan-out on write vs read — when do you use each?
- Lady Gaga has 100M followers. She tweets. How do you fan-out?
- How does Twitter rank tweets in your timeline (it's not just reverse chronological)?
- How do you serve a feed to a user who just logged in after 3 days offline?

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Problem 4 — WhatsApp / Slack (Chat System)
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/chat-system/`

**What it covers:**
WebSocket vs Long Polling vs SSE for real-time messaging. Message delivery guarantees (at-least-once, exactly-once in chat). Message ordering per-thread. Presence (online/offline status). Push notifications for offline users (APNs, FCM). Group messaging fanout. Read receipts (single tick, double tick). End-to-end encryption basics. Chat history storage and retrieval. Message search.

**Patterns used:** Message Queues, Distributed Caching, WebSockets, Blob Storage (media)

**Why Google asks this:**
Chat is a canonical real-time system. It tests WebSocket management, message ordering, delivery guarantees, and offline notification handling.

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Problem 5 — Ticketmaster (Seat Reservation / Concurrency)
**Status:** 🔲 Not Started | **Priority:** P1 | **Folder:** `interviews/seat-reservation/`

**What it covers:**
Inventory management under high concurrency. Optimistic vs pessimistic locking for seat holds. Temporary seat reservation with TTL (Redis lock). Distributed queue for checkout (waiting room). Flash sale / demand spike handling. Idempotency in payment flow. ACID transaction boundaries (payment + seat assignment). Overbooking prevention. Database design for venue→event→seat hierarchy.

**Patterns used:** Distributed Caching (seat holds), Distributed Locking, Message Queues, Rate Limiting

**Why Google asks this:**
Concurrency control, the "thundering herd" at sale open time, and distributed locking are senior-level fundamentals. This problem exposes exactly how well a candidate understands transactions and race conditions.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 6 — Uber / Lyft (Ride Sharing & Location Tracking)
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/ride-sharing/`

**What it covers:**
Real-time driver location updates at scale (geospatial indexing — geohash, S2, H3). Matching algorithm (proximity search, surge pricing heuristics). Trip state machine. Real-time tracking via WebSockets. ETA calculation and routing. Driver supply / rider demand heat maps. Geofencing. Push notifications for driver assignment. Surge pricing computation. Data pipeline for analytics.

**Patterns used:** Geospatial indexing, WebSockets, Message Queues, Distributed Caching, CDN

**Why Google asks this:**
Location-based services are a core Google Maps / Waze problem. Geospatial data structures (geohash, S2) and real-time event streams are advanced topics that differentiate senior candidates.

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Problem 7 — Netflix / YouTube (Video Streaming)
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/video-streaming/`

**What it covers:**
Video upload pipeline (chunked upload → blob storage → transcoding). Adaptive bitrate streaming (HLS, DASH, MPEG-DASH). CDN strategy for video (edge caching, byte-range requests). Transcoding pipeline (FFmpeg, AWS Elemental). Video recommendation (covered in rec-system, but streaming-specific ranking). Content deduplication. DRM. Subtitle/caption pipeline. Thumbnail generation. Watch history and resume position. Live streaming architecture.

**Patterns used:** CDN, Blob Storage, Message Queues, Distributed Caching, Recommendation (covered)

**Why Google asks this:**
YouTube is Google. This is a first-party problem. Video pipeline, CDN, and adaptive bitrate are commonly probed.

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Problem 8 — Google Drive / Dropbox (File Sync & Storage)
**Status:** ✅ Done | **Priority:** P1 | **Folder:** `interviews/file-storage/`

**What it covers:**
Chunked upload with deduplication (content-addressable storage using hash). File sync protocol (delta sync, conflict resolution). Versioning and rollback. Metadata vs content separation. Offline support. Folder sharing and permissions (ACL). Collaborative editing basics. Storage quota management. Mobile sync optimization (bandwidth, battery). Resumable upload. Presigned URL for direct-to-S3 upload.

**Patterns used:** Blob Storage, Distributed Caching, Message Queues, API Design

**Why Google asks this:**
Google Drive is a Google product. Content-addressable storage, chunking, and sync protocols are classic interview territory that shows deep understanding of file system design.

**Creation checklist:**
- [x] `README.md`
- [x] `questions.md`
- [x] `answers.md`
- [x] `deep-dive.md`

---

### Problem 9 — Web Crawler (Google Search Indexer)
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/web-crawler/`

**What it covers:**
Seed URL management. BFS vs DFS traversal. URL frontier (priority queue). Duplicate URL detection (Bloom filter, hash set). robots.txt compliance. Politeness (rate limiting per domain). Distributed crawling with consistent hashing across workers. Content extraction and parsing. Link extraction. Scheduling re-crawl by freshness signal. DNS resolution at scale. Storing crawled content (blob storage).

**Patterns used:** Consistent Hashing, Message Queues, Blob Storage, Rate Limiting, Distributed Caching

**Why Google asks this:**
Googled it. Google literally indexes the web. Bloom filters, distributed BFS, and politeness are canonical CS + systems questions.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 10 — Search Autocomplete / Typeahead
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/search-autocomplete/`

**What it covers:**
Trie data structure for prefix matching. Aggregating top-K suggestions per prefix. Real-time updates vs batch updates to the trie. Personalized suggestions vs global top-K. Distributed trie (sharded by prefix character). Caching for common prefixes. Fuzzy matching (edit distance). Filtering inappropriate suggestions. Multi-language support. Analytics for improving suggestions.

**Patterns used:** Distributed Caching, Consistent Hashing, API Design

**Why Google asks this:**
Google Search has a world-class autocomplete. This tests data structures (trie), aggregation at scale, and caching.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 11 — Notification System (Push, Email, SMS)
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/notification-system/`

**What it covers:**
Multi-channel routing (push, email, SMS, in-app). Provider abstraction (APNs, FCM, SendGrid, Twilio). Notification templating. Batching and throttling. User preference management (opt-in/out, quiet hours). Retry with exponential backoff. Notification deduplication. Priority queues (transactional vs marketing). Delivery tracking and receipts. Rate limiting per user per channel.

**Patterns used:** Message Queues, Rate Limiting, Distributed Caching, API Design

**Why Google asks this:**
Notifications are a sub-system in nearly every product. Probing notification design reveals whether a candidate understands async pipelines, reliability, and user experience tradeoffs.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 12 — Distributed Key-Value Store (like DynamoDB / Redis)
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/kv-store/`

**What it covers:**
Hash ring for key distribution. Quorum reads/writes (N, W, R and W+R>N). Consistent hashing with virtual nodes. Vector clocks for conflict resolution. Gossip protocol for membership. Anti-entropy and Merkle trees for data repair. Compaction (LSM tree). Write path (WAL → MemTable → SSTable). Read path (Bloom filter → SSTable). Replication strategies.

**Patterns used:** Consistent Hashing, Replication, Distributed Transactions

**Why Google asks this:**
Bigtable (Google), Dynamo (Amazon), and Spanner (Google) are the foundation of cloud backends. This is a deep-dive question for Staff/Principal level but expected knowledge at Senior.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 13 — Ad Click Aggregation (like Google Ads)
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/ad-click-aggregation/`

**What it covers:**
High-throughput event ingestion. Time-windowed aggregation (tumbling, sliding windows). Approximate counting (Count-Min Sketch, HyperLogLog). Exactly-once aggregation. Lambda vs Kappa architecture. Aggregation at multiple time granularities. Real-time vs batch tradeoffs. Reporting API design. Click fraud detection. Attribution modeling.

**Patterns used:** Kafka, Stream Processing, Distributed Caching, Blob Storage (cold storage)

**Why Google asks this:**
Google's core revenue is ads. Aggregating ad clicks at billions-per-day scale is an internal Google problem. This tests stream processing and probabilistic data structures.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 14 — Leaderboard / Top-K System
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/leaderboard/`

**What it covers:**
Redis Sorted Sets for real-time leaderboard. Global vs segmented leaderboards (friends, country, weekly). Approximate top-K with Count-Min Sketch. Batch recompute vs real-time. Score update at scale. Windowed leaderboards (reset weekly). Handling ties. Pagination (rank 1000–1010). Leaderboard for gaming vs e-commerce vs social.

**Patterns used:** Distributed Caching (Redis Sorted Sets), Message Queues, Sharding

**Why Google asks this:**
YouTube's trending videos, Google Play top charts, and Google Maps "popular times" are all leaderboard problems. Redis Sorted Set is the go-to answer every interviewer expects.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 15 — Distributed Job Scheduler (like AWS Cron / Google Cloud Tasks)
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/job-scheduler/`

**What it covers:**
Cron expression parsing. Job persistence and durability. Exactly-once job execution. Leader election for scheduler coordination. Delayed job execution. Retry with backoff. Job priority queues. Idempotency tokens. Job history and audit logs. Fan-out jobs (trigger 1000 tasks from one job). Dead job detection. Timeout handling.

**Patterns used:** Distributed Locking, Message Queues, Distributed Transactions, Consistent Hashing

**Why Google asks this:**
Google Cloud Tasks, Cloud Scheduler, and internal batch pipeline orchestration are daily reality at Google. Leader election and distributed coordination are senior-level requirements.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 16 — Payment System (like Stripe / Google Pay)
**Status:** 🔲 Not Started | **Priority:** P2 | **Folder:** `interviews/payment-system/`

**What it covers:**
Idempotency keys (critical). Double-spend prevention. Payment state machine (initiated→processing→completed/failed). Ledger design (double-entry bookkeeping). Reconciliation. Retry mechanics with idempotency. Chargebacks and refunds. PCI DSS compliance basics. External payment provider integration (PSP abstraction). Currency handling (avoid floating point).

**Patterns used:** Distributed Transactions, Message Queues, Distributed Locking, API Design

**Why Google asks this:**
Google Pay is a Google product. Payment systems require the strongest guarantees (exactly-once, no money lost, no double charge). Idempotency keys consistently appear in final-round interviews.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 17 — Google Maps / Location Services
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/maps/`

**What it covers:**
Geospatial indexing (Quadtree, Geohash, S2 cells). Map tile serving (tile pyramid, zoom levels). Routing algorithms (Dijkstra, A*, contraction hierarchies). ETA prediction. Real-time traffic data integration. Points of Interest (POI) search. Reverse geocoding. Place search. Offline maps. Map rendering pipeline. Turn-by-turn navigation.

**Patterns used:** CDN, Distributed Caching, Blob Storage, Message Queues

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

### Problem 18 — Real-Time Collaborative Editing (Google Docs)
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/collaborative-editing/`

**What it covers:**
Operational Transformation (OT) vs Conflict-Free Replicated Data Types (CRDTs). Cursor presence. Multi-user awareness (who is editing where). WebSocket-based real-time sync. Server-side document state. Version history (snapshot + delta). Offline editing and merge. Access control. Comment threading. Export pipeline (PDF, DOCX).

**Patterns used:** WebSockets, Message Queues, Distributed Caching, Blob Storage

**Why Google asks this:**
Google Docs is a Google product. CRDTs and OT are advanced but expected for Staff-level Google interviews. This is the hardest problem on the list.

**Creation checklist:**
- [ ] `README.md`
- [ ] `questions.md`
- [ ] `answers.md`
- [ ] `deep-dive.md`

---

## Part 3: Advanced Topics
> These appear in Staff / Principal Engineer interviews or as follow-up depth questions.
> Complete after all P1 and P2 topics are done.

---

### Advanced 1 — Observability Stack (Metrics, Logs, Traces)
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/observability/`

**What it covers:**
The three pillars: metrics (Prometheus), logs (ELK Stack / Loki), traces (Jaeger, Zipkin, OpenTelemetry). SLO/SLA/SLI definitions. Error budgets. Distributed tracing context propagation. Cardinality problems with metrics. Alerting philosophy (symptom vs cause). Dashboarding with Grafana. On-call runbooks. Chaos engineering basics.

---

### Advanced 2 — Security Patterns
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/security/`

**What it covers:**
OAuth 2.0 / OIDC flows. JWT vs session tokens. mTLS for service-to-service auth. Secret management (Vault, AWS Secrets Manager). OWASP Top 10 in system design context. Data encryption at rest and in transit. DDoS protection. Zero-trust architecture.

---

### Advanced 3 — Multi-Region / Global Architecture
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/multi-region/`

**What it covers:**
Active-active vs active-passive. Data sovereignty and compliance (GDPR). Cross-region replication lag. Global load balancing (Anycast, GeoDNS). Conflict resolution in multi-region writes. Failover runbooks. RPO and RTO definitions.

---

### Advanced 4 — Stream Processing (Flink / Spark Streaming)
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/stream-processing/`

**What it covers:**
Batch vs stream processing. Lambda vs Kappa architecture. Windowing (tumbling, sliding, session). Watermarks and late-arriving events. Stateful stream processing. Exactly-once semantics in Flink. Backpressure handling. State backends.

---

### Advanced 5 — ML Platform & Feature Stores
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/ml-platform/`

**What it covers:**
Feature store (online vs offline). Training pipeline orchestration. Model serving (latency SLA, canary deployments). A/B testing framework. Shadow mode deployment. Feature computation (batch vs streaming). Data lineage. Model monitoring (data drift, concept drift).

---

### Advanced 6 — Search Engine (like Google Search)
**Status:** 🔲 Not Started | **Priority:** P3 | **Folder:** `interviews/search-engine/`

**What it covers:**
Inverted index construction. TF-IDF vs BM25 scoring. PageRank. Indexing pipeline (crawl → parse → index). Index partitioning (by document vs by term). Serving latency at scale. Index freshness. Spelling correction. Query understanding. Federated search. Results deduplication.

---

## Quick Reference Table

| # | Topic | Type | Priority | Status | Patterns Needed First |
|---|-------|------|----------|--------|-----------------------|
| 1 | Rate Limiting | Pattern | P1 | ✅ | None |
| 2 | Consistent Hashing | Pattern | P1 | ✅ | None |
| 3 | Sharding & Replication | Pattern | P1 | ✅ | None |
| 4 | Distributed Caching | Pattern | P1 | ✅ | None |
| 5 | Message Queues | Pattern | P1 | 🔲 | None |
| 6 | CDN & Edge | Pattern | P1 | 🔲 | None |
| 7 | Load Balancing | Pattern | P2 | 🔲 | None |
| 8 | API Design | Pattern | P2 | 🔲 | None |
| 9 | Blob Storage | Pattern | P2 | 🔲 | None |
| 10 | Distributed Transactions | Pattern | P2 | 🔲 | Sharding & Replication |
| 11 | ✅ Recommendation Engine | Problem | P1 | ✅ | Kafka, Caching, CDN |
| 12 | URL Shortener | Problem | P1 | 🔲 | Hashing, Caching |
| 13 | Social Feed (Twitter) | Problem | P1 | ✅ | Queues, Caching, Sharding |
| 14 | Chat System (WhatsApp) | Problem | P1 | 🔲 | Queues, WebSockets |
| 15 | Seat Reservation | Problem | P1 | 🔲 | Caching, Locking |
| 16 | Ride Sharing (Uber) | Problem | P1 | 🔲 | Geospatial, WebSockets |
| 17 | Video Streaming (Netflix) | Problem | P1 | 🔲 | CDN, Blob Storage |
| 18 | File Storage (Drive) | Problem | P1 | ✅ | Blob Storage, Caching |
| 19 | Web Crawler | Problem | P2 | 🔲 | Hashing, Queues |
| 20 | Search Autocomplete | Problem | P2 | 🔲 | Caching, Hashing |
| 21 | Notification System | Problem | P2 | 🔲 | Queues, Rate Limiting |
| 22 | Distributed KV Store | Problem | P2 | 🔲 | Hashing, Replication |
| 23 | Ad Click Aggregation | Problem | P2 | 🔲 | Kafka, Stream Processing |
| 24 | Leaderboard / Top-K | Problem | P2 | 🔲 | Caching (Redis) |
| 25 | Job Scheduler | Problem | P2 | 🔲 | Distributed Locking |
| 26 | Payment System | Problem | P2 | 🔲 | Distributed Transactions |
| 27 | Google Maps | Problem | P3 | 🔲 | CDN, Caching, Geospatial |
| 28 | Collaborative Editing | Problem | P3 | 🔲 | WebSockets, CRDTs |
| 29 | Observability Stack | Advanced | P3 | 🔲 | All patterns |
| 30 | Security Patterns | Advanced | P3 | 🔲 | API Design |
| 31 | Multi-Region Architecture | Advanced | P3 | 🔲 | Replication, CDN |
| 32 | Stream Processing | Advanced | P3 | 🔲 | Message Queues |
| 33 | ML Platform | Advanced | P3 | 🔲 | Rec Engine |
| 34 | Search Engine | Advanced | P3 | 🔲 | Web Crawler, Autocomplete |

---

## How to Update This File When You Complete a Topic

1. Change `🔲 Not Started` → `✅ Done` in the topic's Status field
2. Update the Progress Dashboard table at the top (increment Done count, decrement Not Started)
3. Mark all 4 checklist items as `[x]` in the topic's checklist

---

## External Resources

| Resource | Best For |
|---|---|
| hellointerview.com/learn/system-design/problem-breakdowns | Full problem walkthroughs with diagrams |
| hellointerview.com/learn/system-design/patterns | Pattern-level deep dives |
| systemdesign.one | Visual system design cards |
| bytebytego.com | Visually rich breakdowns |
| highscalability.com | Real-world company architecture posts |
| engineering.atspotify.com, netflixtechblog.com | Primary source engineering blogs |
| Martin Kleppmann — "Designing Data-Intensive Applications" | The best book for this topic, full stop |
