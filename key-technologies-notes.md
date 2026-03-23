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