# Multi-Model (Graph + Document) Data Service — Study Notes

> A complete, interview-ready breakdown of how to design a service that exposes one logical API over both a document store and a graph store. Each section builds on the previous — read sequentially for first pass, then use the cheatsheet for revision.

---

## Table of Contents

1. [Problem Overview](#1-problem-overview)
2. [Requirements](#2-requirements)
3. [Core Entities](#3-core-entities)
4. [API Design](#4-api-design)
5. [Storage Strategy — Unified vs Polyglot](#5-storage-strategy--unified-vs-polyglot)
6. [Write Path — Outbox Pattern Deep Dive](#6-write-path--outbox-pattern-deep-dive)
7. [Query Planner — Routing Reads to the Right Engine](#7-query-planner--routing-reads-to-the-right-engine)
8. [Indexing for Both Worlds](#8-indexing-for-both-worlds)
9. [Partitioning and Replication](#9-partitioning-and-replication)
10. [Caching Strategy](#10-caching-strategy)
11. [Security and Tenant Isolation](#11-security-and-tenant-isolation)
12. [Observability and Data Quality](#12-observability-and-data-quality)
13. [Schema Evolution and Operations](#13-schema-evolution-and-operations)
14. [Real-World Example — Social Commerce Feed](#14-real-world-example--social-commerce-feed)
15. [Common Pitfalls and Tradeoffs](#15-common-pitfalls-and-tradeoffs)
16. [Comparison Table — When to Use What](#16-comparison-table--when-to-use-what)
17. [Interview Grill Questions — Stress-Testing Your Understanding](#17-interview-grill-questions--stress-testing-your-understanding)
18. [Quick Revision Cheatsheet](#18-quick-revision-cheatsheet)

---

## 1. Problem Overview

Most products have **two distinct data access patterns** that fight each other:

1. **Document reads** — fetch a user profile, a product listing, or a post. You want flexible schemas, partial updates, and fast key-value lookups.
2. **Graph traversals** — find friends-of-friends, mutual connections, recommended products based on social proximity. You want relationship-first queries with cheap edge walks.

A **multi-model data service** solves this by exposing **one logical API** that can handle both patterns. Underneath, it may use one database or two — the client never knows. The service owns the modeling, the consistency guarantees, the caching, and the security boundary.

### Why this matters in an interview:

- Shows you can **avoid schema hacks** (storing adjacency lists in JSON arrays, doing 15 self-joins for graph queries in a relational DB).
- Proves you understand **operational tradeoffs** — one engine is simpler but limiting; two engines are powerful but harder to keep consistent.
- Demonstrates you can design a **clean API** that hides infrastructure complexity from consumers.
- Exercises key system design muscles: consistency patterns, partitioning, caching, multi-tenant security.

---

## 2. Requirements

### ✅ Functional Requirements (Core — design these)

1. **Clients should be able to read/write document-shaped entities** (User, Product, Post) with partial updates, projections, and version tracking.
2. **Clients should be able to traverse relationships** (follows, likes, purchased) with bounded depth and filtering (e.g., "friends-of-friends who liked Product X").
3. **Clients should be able to run hybrid queries** that combine traversal results with document data in a single request (e.g., "fetch profiles of users within 2 hops who match a filter").

### ❌ Below the Line (out of scope but show awareness)

- Full-text search integration (Elasticsearch sidecar — mention, don't design).
- Real-time push of graph changes (WebSocket subscriptions — separate concern).
- ML feature pipelines reading graph embeddings (batch export, not online API).
- Admin UI for schema registry management.

### ✅ Non-Functional Requirements (Core)

1. **Consistency between document and graph stores** — writes must propagate from document to graph within seconds, with exactly-once semantics and no data divergence.
2. **Bounded query latency** — pure document reads < 10ms p99, pure graph traversals < 50ms p99, hybrid queries < 200ms p99.
3. **Tenant isolation** — one tenant's data must never leak to another; row-level enforcement in both engines, scoped encryption keys.

*ELABORATE THE SAME*

Why p99 and not average?
Averages hide outliers. If 99 requests take 5ms and 1 request takes 10 seconds, the average is ~105ms — looks fine. But that 1 user waited 10 seconds.

In production, you care about the experience of almost all users (p99), not the average. A high p99 indicates a tail latency problem that needs fixing.

Example: 100 requests sorted by latency

p50 (median):  the 50th fastest  → "typical" user experience
p95:           the 95th fastest  → most users
p99:           the 99th fastest  → almost all users
p99.9:         the 999th of 1000 → tail latency (Amazon tracks this)

Request latencies (sorted):
  1ms, 2ms, 3ms, ... 8ms, 9ms, 50ms, 200ms
                            ↑           ↑
                          p99=9ms    max=200ms

Why these specific numbers?
- 10ms for documents — a key-value lookup from an indexed store (or cache hit) should be near-instant

- 50ms for graph traversals — walking edges across partitions involves multiple hops, so 5x the document read budget
- 200ms for hybrid — includes traversal time + batch document fetch + join + sort, so the combined budget is larger
In interviews, stating p99 targets (not averages) signals you understand production SLA thinking.

### ❌ Below the Line (non-functional)

- Multi-region active-active (mention, but design for single-region first).
- GDPR right-to-erasure across both stores (important but separate flow).
- CI/CD and blue-green deployments of schema changes.

---

## 3. Core Entities

1. **Entity (Document)** — The primary data object (User, Product, Post). Stored as a JSON-like document with a stable primary key (`entity_id`), a `type` field, a `version` number, and a `tenant_id`. Supports partial updates and field projections.

2. **Edge (Relationship)** — A typed, directed connection between two entities. Stored as `(source_id, edge_type, target_id)` with optional properties (e.g., `followed_at`, `weight`). Lives in the graph store.

3. **Vertex (Graph Node)** — A lightweight projection of an entity in the graph store. Contains `entity_id`, `type`, `tenant_id`, and key indexed fields (not the full document). Points back to the full document via `entity_id`.

4. **Schema Registry Entry** — Maps a document type to a graph vertex type, holds versioned JSON schemas for validation, and drives code generation for typed clients.

5. **Outbox Event** — A durable record of a write operation that needs to propagate from the document store to the graph store. Contains `event_id`, `entity_id`, `operation` (create/update/delete), `payload`, and `idempotency_key`.

6. **Cached Neighborhood** — A precomputed list of neighbor IDs for hot graph nodes (e.g., a celebrity's follower list). Stored in Redis/Memcached with TTL-based expiry and change-stream invalidation.

---

## 4. API Design

### 4.1 Document Operations

```
POST /entities -> Entity
Body: { type, tenant_id (from JWT), data, idempotency_key }
// Creates a new document entity. Schema validated against registry.

GET /entities/:entity_id?fields=name,email -> Entity (projected)
// Reads a single document with optional field projection.

PATCH /entities/:entity_id -> Entity
Body: { data (partial), version (for optimistic concurrency) }
// Partial update. Server rejects if version doesn't match (409 Conflict).

DELETE /entities/:entity_id -> { deleted: true }
// Soft-deletes the document and emits outbox event to remove graph vertex/edges.
```

### 4.2 Graph Operations

```
GET /graph/:entity_id/edges?type=follows&direction=outgoing&limit=50&cursor=... -> EdgeList
// Returns paginated edges of a specific type from an entity.

GET /graph/traverse?start=:entity_id&edge_types=follows,likes&depth=2&limit=100 -> VertexList
// Bounded traversal: returns vertex IDs within N hops, filtered by edge type.
```

### 4.3 Hybrid Queries

```
POST /query -> HybridResult
Body: {
  traversal: { start, edge_types, depth, filters },
  document_projection: { fields: ["name", "price", "rating"] },
  sort: { field: "rating", order: "desc" },
  pagination: { limit: 20, cursor: "..." }
}
// Runs traversal first, then batch-fetches documents for result IDs, sorts, paginates.
```

> **Security tip:** `tenant_id` is NEVER in the request body — always extracted from the JWT. Every query is scoped to the authenticated tenant. The `idempotency_key` prevents duplicate writes on retry.

---

## 5. Storage Strategy — Unified vs Polyglot

This is the **first major architectural decision**. You have two routes:

### Route A: Unified Multi-Model Database

One database cluster handles both document and graph storage.

| Examples | ArangoDB, OrientDB, CosmosDB (multi-model API), SurrealDB |
|---|---|
| **Strengths** | Single cluster to operate, one query language, transactions across both models, simpler security model |
| **Weaknesses** | Vendor lock-in, may not be best-in-class for either model, scaling knobs are shared (can't scale graph reads independently of document writes) |
| **When to choose** | Small-to-medium teams (< 20 engineers), moderate scale, simplicity over absolute performance |

### Route B: Polyglot Storage Behind One Service (Recommended at Scale)

Document store (MongoDB, DynamoDB, PostgreSQL JSONB) + Graph store (Neo4j, Neptune, Dgraph, JanusGraph) behind a single service that hides the split.

| **Strengths** | Best-of-breed for each pattern, independent scaling (scale graph reads without touching document store), freedom to swap engines |
| **Weaknesses** | Two clusters to operate, eventual consistency between them, more complex write path (outbox pattern required), integration testing is harder |
| **When to choose** | Large-scale products with heavy traversal AND heavy document reads, teams with platform engineering support |

### Grill Yourself — Key Questions:

1. **Q: If you pick polyglot, how do you prevent the two stores from diverging permanently?**
   - A: Outbox pattern — every document write creates a durable outbox event in the same transaction. A worker consumes the outbox, upserts the graph, and marks the event as processed. Idempotency keys make retries safe.

2. **Q: If you pick unified, what happens when your graph queries need 10x more read replicas than your document queries?**
   - A: You can't scale them independently — you over-provision the document side or under-provision the graph side. This is the core limitation of unified engines at scale.

3. **Q: How do you handle schema differences? Documents are schema-flexible, graphs are schema-rigid (typed edges).**
   - A: The schema registry bridges both — it validates document writes against a JSON schema AND maps document types to vertex types with defined edge types. The registry is the single source of truth.

---

## 6. Write Path — Outbox Pattern Deep Dive

This is the **most interview-critical section**. Interviewers frequently ask: *"How do you keep the two models in sync without two-phase commit?"*

### Step-by-Step Write Flow:

```
1. Client → POST /entities { type: "User", data: {...}, idempotency_key: "ik_abc" }

2. Service validates:
   a. JWT → extract tenant_id
   b. Schema registry → validate document against User schema
   c. Idempotency check → has ik_abc been processed? If yes, return cached response.

3. Service writes (single transaction):
   a. INSERT document into document store (with version=1)
   b. INSERT outbox event: { event_id, entity_id, operation: "create", payload, idempotency_key }
   (Both in the same DB transaction — atomic)

4. Service returns 201 Created to client immediately.
   (Graph is NOT yet updated — this is eventual consistency by design.)

5. Outbox Worker (runs continuously):
   a. Polls outbox for unprocessed events (or uses CDC/change stream)
   b. For each event:
      - Upsert vertex in graph store (entity_id → vertex with indexed fields)
      - Upsert edges based on relationship fields in the document
      - Mark outbox event as processed
   c. Uses idempotency_key to skip already-processed events on retry

6. If worker crashes mid-processing:
   - Event stays in outbox (not marked processed)
   - Worker restarts, picks up the event again
   - Idempotent upsert in graph means re-processing is safe
```

### Why NOT Two-Phase Commit (2PC)?

| Concern | 2PC | Outbox Pattern |
|---|---|---|
| Performance | Slow — locks held across two systems for the entire transaction | Fast — single-system transaction, async propagation |
| Availability | If either system is down, the write fails | Document write succeeds even if graph store is temporarily down |
| Complexity | Coordinator + participant protocol, timeout handling, prepare/commit phases | Simple: write + poll + upsert |
| Failure recovery | Complex rollback semantics across heterogeneous systems | Replay outbox — idempotent and simple |

### Grill Yourself — Key Questions:

1. **Q: What if the outbox worker is slow and there's a 30-second lag? A client writes a document, then immediately queries the graph — they won't see their own write.**
   - A: This is the **read-your-own-writes** problem. Solutions:
     - a. **Write-through shortcut**: after the document write, synchronously upsert the graph (best-effort) before returning. If it fails, the outbox is the fallback.
     - b. **Session stickiness**: route the user's graph reads to a "pending" index that includes unprocessed outbox events.
     - c. **Client-side optimistic update**: the client assumes the graph reflects the write and renders locally. The server catches up within seconds.

2. **Q: What happens if the graph upsert fails permanently (e.g., a schema mismatch)?**
   - A: The outbox event moves to a dead-letter queue (DLQ). An alert fires. An operator inspects and either fixes the schema or manually reconciles. The document is the source of truth — the graph can always be rebuilt from documents.

3. **Q: How do you handle deletes? If a document is deleted, you need to remove the vertex AND all its edges.**
   - A: The delete outbox event triggers: (a) remove all edges where source or target = entity_id, (b) remove the vertex. Order matters — remove edges first to avoid dangling references.

---

## 7. Query Planner — Routing Reads to the Right Engine

The query planner is the brain of the read path. It inspects the incoming query, decides which engine(s) to hit, and stitches results together.

### Query Classification:

| Query Shape | Route To | Example |
|---|---|---|
| Fetch single document by ID | Document store only | `GET /entities/user_123` |
| Fetch document with projection | Document store only | `GET /entities/user_123?fields=name,email` |
| List documents with filters/sort | Document store only | `GET /entities?type=Product&status=active&sort=price` |
| Traverse relationships (N hops) | Graph store only | `GET /graph/traverse?start=user_123&depth=2` |
| Find shortest path | Graph store only | "How is user A connected to user B?" |
| Hybrid: traverse + fetch documents | Graph store → Document store | "Profiles of friends-of-friends who like Product X" |

### Hybrid Query Execution — Step by Step:

```
1. Parse query → identify traversal part and document part.

2. Execute traversal (graph store):
   - Start at source vertex
   - Walk edges up to depth N
   - Apply edge-type filters (e.g., only "follows" edges)
   - Apply vertex-type filters (e.g., only "User" vertices)
   - Enforce hard limit (e.g., max 1000 result IDs)
   - Return: list of entity_ids

3. Batch document fetch (document store):
   - Multiget: fetch documents for all entity_ids in one call
   - Apply field projection (return only requested fields)
   - Apply business filters if needed (e.g., status = active)

4. Join and rank:
   - Merge graph metadata (hop distance, edge weight) with document fields
   - Sort by requested field (e.g., rating DESC)
   - Apply pagination (cursor-based)

5. Return paginated result to client.
```

### Why This Order? (Traversal First, Then Documents)

- The graph traversal produces a **small set of IDs** (bounded by `limit` and `depth`).
- Fetching documents by ID is a **cheap multiget** operation.
- The reverse (fetch all documents, then check graph relationships) would require scanning the entire document collection — far more expensive.

### Grill Yourself — Key Questions:

1. **Q: What if the traversal returns 100,000 IDs? The batch document fetch will be enormous.**
   - A: Enforce **server-side limits** on traversal results (e.g., max 1,000 IDs). If the traversal hits the limit, return a `truncated: true` flag. The client can narrow their query or paginate through the traversal itself.

2. **Q: How do you handle a traversal that touches a celebrity node (10M followers)?**
   - A: **Supernode mitigation** — see Section 8. Short answer: shard the celebrity's adjacency list across multiple physical vertices, sample from the shard rather than reading all edges, and use precomputed top-N neighbor caches.

3. **Q: What if the graph store returns IDs for documents that have been deleted (eventual consistency lag)?**
   - A: The batch document fetch simply returns fewer results than expected. The response includes only documents that exist. The client sees a consistent (if slightly smaller) result set. The graph will eventually be cleaned up by the outbox worker processing the delete event.

---

## 8. Indexing for Both Worlds

### 8.1 Document Store Indexes

Create **compound secondary indexes** for the most common query patterns:

| Index | Covers Query Pattern |
|---|---|
| `(tenant_id, type, status)` | "All active products for this tenant" |
| `(tenant_id, type, updated_at)` | "Recently updated users for this tenant" |
| `(tenant_id, entity_id)` | Primary key lookup (should already be the partition key) |
| `(type, category, price)` | Filtered product search with sort |

**Rules of thumb:**
- Every query must be covered by an index — no collection scans.
- Audit index usage monthly — remove unused indexes (they slow writes).
- Use partial indexes where possible (e.g., index only `status = 'active'` documents).

### 8.2 Graph Store Indexes

| Index | Purpose |
|---|---|
| Vertex index on `(type, tenant_id)` | "All User vertices for this tenant" |
| Edge index on `(edge_type, source_id)` | "All follows edges from this user" |
| Adjacency index for hot relations | Fast neighbor lookups without full edge scans |

### 8.3 Supernode Handling (Celebrity Problem)

A "supernode" is a vertex with millions of edges (e.g., a celebrity with 10M followers). Naive traversal of a supernode reads millions of edges in one query, blowing up latency and memory.

**Solutions (layered):**

1. **Neighbor sharding** — split the celebrity's adjacency list across multiple physical vertices (`celeb_follow_shard_001`, `celeb_follow_shard_002`, ...). Queries read a random shard instead of the full list.

2. **Sampled caches** — for hot supernodes, precompute a random sample of N neighbors (e.g., 1,000) and cache it in Redis. Traversals use the cached sample instead of walking all edges.

3. **Background top-N computation** — a batch job periodically computes "top N neighbors by some ranking" for celebrity nodes. Hybrid queries use this precomputed list.

4. **Server-side time budgets** — the query planner allocates a time budget per traversal step. If expanding a supernode exceeds the budget, it returns partial results with a `truncated` flag.

---

## 9. Partitioning and Replication

### 9.1 Partition Key Strategy

**Tenant-first partitioning** for both engines:

```
Document store partition key: (tenant_id, entity_id)
Graph store partition key:    (tenant_id, vertex_id)
```

**Why tenant-first?**
- Cross-model operations (write document → update graph) stay **colocated** within the same tenant partition.
- Tenant isolation is enforced at the storage level — a query for tenant A physically cannot touch tenant B's partition.
- Scaling model: add partitions per tenant as they grow.

### 9.2 Document Store Partitioning

- Use **consistent hashing on entity_id** within a tenant.
- Documents for a single tenant spread across multiple partitions for write throughput.
- Reads by entity_id are single-partition lookups (fast).

### 9.3 Graph Store Partitioning

- Use **edge-cut partitioning with community-based placement**.
- Goal: keep densely connected subgraphs on the same partition to minimize cross-partition traversals.
- For social graphs, communities (friend groups) tend to query together — colocating them reduces network hops.

### 9.4 Replication

| Concern | Strategy |
|---|---|
| Durability | Leader-follower replication with quorum writes (e.g., write to 2 of 3 replicas) |
| Read scaling | Read from followers for eventually-consistent reads, leader for strong reads |
| Cross-engine consistency | Accept eventual consistency between document and graph stores. The outbox worker is the consistency mechanism. |
| Failure recovery | If a graph replica falls behind, rebuild from document store (documents are the source of truth) |

### Grill Yourself — Key Questions:

1. **Q: If you partition by tenant, what happens when one tenant is 1000x larger than the rest?**
   - A: **Hot tenant problem**. Solutions: (a) sub-partition the large tenant by entity_id hash, (b) move the large tenant to a dedicated cluster, (c) introduce per-tenant quotas and rate limits.

2. **Q: If the graph store and document store use different partition strategies, how do cross-model joins work?**
   - A: The service layer handles it — the traversal returns entity_ids, and the service does a scatter-gather to the correct document partitions. Tenant-first partitioning ensures both stores use the same tenant boundary, minimizing cross-partition work.

---

## 10. Caching Strategy

### 10.1 What to Cache (and What NOT to)

| Cache Layer | What | TTL | Invalidation |
|---|---|---|---|
| Document cache (read-through) | Full or projected documents | Short: 30s–5min (based on update rate) | Change stream from outbox — invalidate on write |
| Graph neighborhood cache | First-degree and second-degree neighbor IDs for hot users | Medium: 5–15min | Change stream — invalidate when edges added/removed |
| Hybrid query result cache | Precomputed "top N results per user" for expensive queries | Long: 15min–1hr | Scheduled refresh (background job) |
| Schema registry cache | In-memory schema cache per service instance | Long: until registry change | Pub/sub notification on schema update |

### 10.2 Cache Invalidation — How It Works

```
1. Document write → outbox event created
2. Outbox worker processes event → updates graph
3. Same outbox worker (or a second consumer) → publishes cache invalidation message
4. Cache invalidation message → deletes key from Redis/Memcached
5. Next read → cache miss → fresh data loaded → cache repopulated
```

**Why outbox-driven invalidation?**
- The cache is invalidated from the same event stream that updates the graph. This means cache staleness is bounded by the same lag as graph propagation — typically < 5 seconds.
- No additional consistency mechanism needed.

### 10.3 Grill Yourself — Key Questions:

1. **Q: What if the cache invalidation message is lost? The cache serves stale data forever.**
   - A: TTL is the safety net. Even if invalidation fails, the cache entry expires within its TTL (e.g., 5 minutes max staleness). For critical data, use shorter TTLs.

2. **Q: Precomputed "top N results per user" — how often do you refresh?**
   - A: Depends on the use case. For a social feed: every 5–15 minutes (async background job). For product recommendations: every 1–6 hours. The key insight: precomputation trades freshness for latency. If the user needs real-time results, skip the cache and run the hybrid query live.

---

## 11. Security and Tenant Isolation

### 11.1 Tenant Isolation — The Non-Negotiable Requirement

Every operation — read, write, traversal — must be scoped to the authenticated tenant. If tenant isolation fails, you have a data breach.

### 11.2 Enforcement Layers

```
Layer 1: Auth Token
  - JWT contains tenant_id (signed, tamper-proof)
  - Gateway validates token, extracts tenant_id
  - tenant_id propagated to service via header (X-Tenant-Id)

Layer 2: Service Layer
  - Every DB query includes tenant_id in the WHERE clause
  - Every graph traversal starts from a vertex scoped to the tenant
  - Field-level access control: redact sensitive fields (SSN, card_number) based on role

Layer 3: Storage Layer
  - Partition key includes tenant_id — physically impossible to read cross-tenant data
  - Row-level security (PostgreSQL RLS, DynamoDB condition expressions)
  - Encryption at rest with per-tenant keys (tenant A's data encrypted with key A)

Layer 4: Testing
  - Automated integration tests with fuzzed tokens: intentionally try cross-tenant reads/writes
  - Verify every endpoint returns 403 when tenant_id doesn't match the resource
  - Chaos testing: what happens when X-Tenant-Id header is missing? (Must fail closed — reject the request, never default to a tenant)
```

### 11.3 Write Security

- **Idempotency tokens** — prevent replay attacks. Each write includes a unique `idempotency_key`. The server rejects duplicate keys (returns cached response).
- **Signed writes** — the client signs the request body with its API key. The server verifies the signature before processing. Prevents tampering in transit (beyond TLS).
- **Rate limiting per tenant** — prevents one tenant from consuming all write throughput.

### 11.4 Grill Yourself — Key Questions:

1. **Q: If tenant_id is in the JWT and you trust it, what if an attacker forges a JWT?**
   - A: JWTs are cryptographically signed. The gateway validates the signature against the public key. If the signing key is compromised, you have a much bigger problem — rotate keys immediately.

2. **Q: What if a developer accidentally writes a query without the tenant_id filter?**
   - A: Defense in depth: (a) row-level security at the DB layer catches it, (b) code review mandates tenant_id in all queries, (c) automated tests try every endpoint with mismatched tenant_ids. One layer failing shouldn't cause a breach.

---

## 12. Observability and Data Quality

### 12.1 Tracing and Metrics

Every hybrid query spans two stores. Without end-to-end tracing, debugging latency spikes is a nightmare.

| What to Trace | How |
|---|---|
| Correlation ID | Generate a unique `request_id` at the gateway, propagate to both stores and the outbox worker |
| Per-engine latency | Emit `document_read_ms`, `graph_traversal_ms`, `join_ms` as separate spans |
| Latency percentiles | Publish p50, p95, p99 for: pure document reads, pure graph traversals, hybrid queries |
| Outbox lag | Track time between outbox event creation and graph upsert completion (target: < 5s p99) |
| Per-tenant saturation | Monitor queries-per-second and data size per tenant — detect hot tenants before they cause problems |

### 12.2 Data Quality Expectations

| Rule | Why | How to Check |
|---|---|---|
| Every graph vertex must reference an existing document | Dangling vertices = broken reads | Periodic reconciliation job: scan graph vertices, verify document exists |
| No vertex should have dangling edge pointers | Edges pointing to deleted vertices = stale data | Reconciliation: scan edges, verify both source and target vertices exist |
| Document version must be monotonically increasing | Prevents write conflicts from causing rollback | Assertion in the write path |
| Outbox has zero unprocessed events older than 5 minutes | Ensures graph stays in sync | Alert on outbox lag > threshold |

### 12.3 Alerting

| Alert | Trigger | Severity |
|---|---|---|
| Outbox lag > 30 seconds | Graph is falling behind, reads may be stale | Warning |
| Outbox lag > 5 minutes | Graph is significantly diverged | Critical |
| Cross-tenant data access detected in tests | Tenant isolation breach | P0 |
| Dangling vertices > 0.1% of total | Data quality degradation | Warning |
| Hybrid query p99 > 500ms | Performance regression | Warning |

---

## 13. Schema Evolution and Operations

### 13.1 Backward-Compatible Changes (No Downtime)

| Change | How | Risk |
|---|---|---|
| Add new field to document | Add to schema, default to null for existing docs | None — clients ignore unknown fields |
| Add new edge type to graph | Register in schema registry, deploy worker code to handle it | None — existing edges unchanged |
| Add new index | Create index in background, no write lock | Slight write slowdown during build |

### 13.2 Breaking Changes (Require Migration)

| Change | How | Risk |
|---|---|---|
| Remove a document field | Dual-write (old + new) → migrate clients → stop writing old field → remove | Clients break if migrated too early |
| Rename an edge type | Create new edge type → backfill from old → migrate queries → remove old | Data duplication during migration |
| Change partition key | Create new collection with new key → dual-write → backfill → switch reads → drop old | Extended migration period |

### 13.3 Backfilling the Graph

When adding a new edge type or fixing divergence, you need to backfill the graph from documents:

```
1. Deploy new edge type schema to registry.
2. Start backfill job:
   a. Scan all documents of the relevant type (paginated, cursor-based).
   b. For each document, emit an outbox event with the backfill data.
   c. Use the SAME idempotency keys as the outbox worker — if the edge already exists, it's a no-op.
3. The outbox worker processes backfill events just like normal events.
4. Monitor: track backfill progress (% of documents processed) and graph edge count convergence.
5. Verify: run reconciliation job to confirm graph matches documents.
```

**Why use the outbox for backfills?** Reusing the same pipeline means you don't need a separate write path. Idempotency keys make it safe to run the backfill multiple times if it fails partway through.

---

## 14. Real-World Example — Social Commerce Feed

### The Product:

A social commerce app where users follow other users, browse products, and see a personalized feed of products liked by people in their social network.

### Data Model:

- **Documents**: User profiles, Product listings (title, price, stock, images, rating)
- **Graph edges**: `follows` (User → User), `liked` (User → Product), `viewed` (User → Product), `trust` (User → User, weighted)

### The Feed Query — Step by Step:

```
User opens home feed. The service needs to:

1. Traversal (graph store):
   - Start at user's vertex
   - Walk "follows" edges (1 hop) → get friend IDs
   - Walk "liked" edges from friends → get product IDs they liked
   - Deduplicate product IDs, apply tenant filter
   - Limit to top 200 candidate product IDs (sorted by edge timestamp)

2. Document fetch (document store):
   - Batch-fetch product documents for the 200 IDs
   - Project only: title, price, stock, images, rating
   - Filter: only in-stock products (stock > 0)

3. Ranking:
   - Score each product: social_proximity_score × rating × recency
   - Sort descending

4. Pagination:
   - Return top 20 with cursor for next page

5. Caching:
   - Cache the ranked candidate list (200 products) per user for 10 minutes
   - Subsequent page requests use the cached list
   - Invalidation: follows/likes changes → invalidate user's candidate cache
```

### What Happens When a Product Price Changes:

```
1. Merchant updates product price → PATCH /entities/product_456 { data: { price: 29.99 }, version: 7 }
2. Service validates, writes document (version=8), emits outbox event
3. Outbox worker updates graph vertex for product_456 (price field in metadata)
4. Same outbox worker publishes cache invalidation for product_456
5. Any cached feed containing product_456 serves stale price until:
   a. Cache invalidation message processed (< 5s), OR
   b. Cache TTL expires (10 min max staleness)
6. Next feed request fetches fresh price from document store
```

---

## 15. Common Pitfalls and Tradeoffs

### Pitfall 1: Dual-Write Anomalies

| Problem | The app writes to both document store AND graph store directly, without an outbox. If one write succeeds and the other fails, the stores diverge. Over time, divergence accumulates and is extremely hard to debug. |
|---|---|
| **Solution** | Always funnel writes through one transaction + outbox. The document store is the source of truth. The graph is a derived view. |
| **Detection** | Run periodic reconciliation: for every document, verify a corresponding graph vertex exists. For every edge, verify both endpoints exist as documents. |

### Pitfall 2: Unbounded Traversals

| Problem | A query like "find all users connected to user X" with no depth limit or result cap can walk millions of edges and return millions of IDs. This causes: graph store OOM, massive batch document fetch, gateway buffering → OOM cascade. |
|---|---|
| **Solution** | Require `depth` ≤ 3 and `limit` ≤ 1,000 on all traversal queries. Enforce server-side time budgets (e.g., kill traversal after 100ms). Return `truncated: true` if limit is hit. |

### Pitfall 3: Celebrity Nodes (Hot Partitions)

| Problem | A celebrity with 10M followers creates a hot partition. Every traversal touching this vertex reads millions of edges from one partition, causing skew and latency spikes. |
|---|---|
| **Solution** | Neighbor sharding (split adjacency list across shards), sampled caches (precompute random subset), background top-N computation, server-side sampling with time budgets. |

### Pitfall 4: Index Bloat

| Problem | Over-indexing slows writes and increases storage cost. Every index must be updated on every write. At write-heavy workloads, excess indexes become the bottleneck. |
|---|---|
| **Solution** | Audit index usage quarterly. Remove indexes with < 1% query hit rate. Use partial indexes where possible. Prefer compound indexes over multiple single-field indexes. |

### Pitfall 5: Leaky Tenant Boundaries

| Problem | If `tenant_id` is not part of **every** key and **every** filter, cross-tenant data can leak. A single query missing the tenant filter is a data breach. |
|---|---|
| **Solution** | Propagate tenant context everywhere. Use row-level security at the DB layer as a safety net. Test with fuzzed tokens. Fail closed (no tenant = reject, never default). |

### Pitfall 6: Vendor Lock-In

| Problem | A unified multi-model engine is simpler but may cap your scale or feature depth. Your team can't swap the graph engine without rewriting the document layer. |
|---|---|
| **Solution** | If using a unified engine, abstract the query layer behind interfaces. If scaling becomes a problem, the polyglot migration path is: extract graph queries → deploy dedicated graph store → route graph queries to new store → deprecate unified engine's graph features. |

---

## 16. Comparison Table — When to Use What

| Approach | Strengths | Weaknesses | When to Choose |
|---|---|---|---|
| **Multi-model service (document + graph)** | Best-of-breed engines, clear modeling, independent scaling, flexible indexing | Integration work, eventual consistency between engines, more ops | Large-scale products with both traversal AND rich document reads |
| **Single document store only** | Simple to operate, mature tooling, easy horizontal scaling | Deep graph queries are slow or require complex application-level joins | Catalog, content, or profile-heavy systems with limited traversal needs |
| **Single graph store only** | Native traversals, community detection, path queries | Document projections and partial updates are awkward, large blobs inflate memory | Relationship-heavy features with light document needs |
| **Unified multi-model database** | One cluster, single query language, simpler security model | Vendor limits on scale or features, fewer tuning knobs per model | Small-to-medium teams that value simplicity over absolute scale |

---

## 17. Interview Grill Questions — Stress-Testing Your Understanding

These are the questions an interviewer will use to probe depth. Practice answering each concisely.

### Consistency & Write Path

1. **How do you keep documents and edges consistent without 2PC?**
   > Outbox pattern. Write document + outbox event in one transaction. Worker reads outbox, upserts graph with idempotent operations. Safe on retry, safe on crash.

2. **What happens if the outbox worker crashes mid-processing?**
   > Event stays unprocessed. Worker restarts, re-reads the event. Idempotent upsert means re-processing is harmless.

3. **How do you handle the read-your-own-writes problem across two stores?**
   > Options: (a) synchronous write-through shortcut, (b) session stickiness to pending index, (c) client-side optimistic update.

4. **What if someone queries the graph 1 second after a document write?**
   > They may see stale data. This is the accepted tradeoff of eventual consistency. Document is correct, graph catches up within seconds. If strong consistency is required for a specific flow, use the synchronous write-through path.

### Query Path & Performance

5. **Why traversal-first, then document fetch?**
   > Traversal produces a small set of IDs (bounded by limit). Fetching documents by ID is a cheap multiget. The reverse (scan all documents, then filter by graph) is far more expensive.

6. **How do you prevent a single query from killing the system?**
   > Depth limit ≤ 3, result limit ≤ 1,000, server-side time budget per traversal step, query cost analysis for GraphQL, persisted queries in production.

7. **How do you handle supernodes?**
   > Neighbor sharding, sampled caches, precomputed top-N, time-budgeted traversals.

### Partitioning & Scaling

8. **Why tenant-first partitioning?**
   > Cross-model operations stay colocated. Tenant isolation is enforced at the storage layer. Scaling is per-tenant.

9. **What happens when one tenant is 1000x larger than others?**
   > Sub-partition by entity_id hash, move to dedicated cluster, or enforce per-tenant quotas.

### Security

10. **How do you prevent cross-tenant data leaks?**
    > Tenant ID in JWT → propagated as header → included in every query/key → row-level security at DB → automated testing with fuzzed tokens → fail closed.

11. **What if a developer forgets the tenant filter in a query?**
    > Row-level security at the DB layer catches it. Code review mandates it. Automated tests verify it. Defense in depth.

### Operations

12. **How do you add a new edge type to a running system?**
    > Register in schema registry → deploy worker code → run backfill job that scans documents and emits outbox events → idempotent upserts create new edges → verify with reconciliation.

13. **How do you rebuild the graph if it diverges from documents?**
    > Documents are the source of truth. Run a full backfill: scan all documents, emit outbox events, upsert graph. Idempotency keys make it safe. Monitor convergence.

---

## 18. Quick Revision Cheatsheet

### ⚡ One-Line Recalls

| Concept | Recall |
|---|---|
| Multi-model service | One API, two engines (document + graph), hidden from client |
| Outbox pattern | Write document + outbox atomically → worker upserts graph → idempotent, crash-safe |
| Query planner | Classify → route to right engine → traversal-first for hybrids → batch doc fetch → paginate |
| Supernode | Neighbor sharding + sampled caches + top-N precomputation + time budgets |
| Tenant isolation | tenant_id in JWT → every query → every key → row-level security → test with fuzz |
| Source of truth | Documents. Graph is derived. Can always rebuild graph from documents. |
| Cache invalidation | Outbox-driven → bounded staleness → TTL as safety net |
| Schema evolution | Additive = no downtime. Breaking = dual-write → migrate → remove old. Backfill via outbox. |

### ⚡ Key Technology Choices

| Component | Choice | Why |
|---|---|---|
| Document store | MongoDB / DynamoDB / PostgreSQL JSONB | Flexible schema, fast key-value reads, partial updates |
| Graph store | Neo4j / Neptune / JanusGraph | Native traversals, adjacency indexes, community detection |
| Outbox transport | CDC (Debezium) or polling | CDC is lower latency; polling is simpler |
| Cache | Redis | Fast, supports TTL, pub/sub for invalidation |
| Schema registry | Custom or Confluent | Versioned schemas, validation, code generation |
| API layer | GraphQL or REST | GraphQL for flexible hybrid queries; REST for simple CRUD |

### ⚡ Scale Numbers (Back-of-Envelope)

```
Social commerce app with 10M users:
  - Documents: 10M users + 50M products + 100M posts = ~160M documents
  - Edges: avg 200 follows/user + avg 50 likes/user = ~2.5B edges
  - Document reads: 50k/s (profile + product pages)
  - Graph traversals: 10k/s (feed generation, recommendations)
  - Hybrid queries: 5k/s (feed = traversal + doc fetch)
  - Outbox throughput: 5k writes/s → 5k graph upserts/s
  - Cache hit rate target: > 90% for documents, > 80% for graph neighborhoods
```

### ⚡ Common Interview Mistakes to Avoid

1. ❌ Writing to both stores directly without outbox → divergence
2. ❌ Allowing unbounded traversals → graph OOM → cascading failure
3. ❌ Forgetting tenant_id in graph queries → cross-tenant data leak
4. ❌ Using 2PC between heterogeneous stores → slow, fragile, unnecessary
5. ❌ Not handling supernodes → one celebrity query kills the cluster
6. ❌ Assuming strong consistency between stores → design for eventual, handle read-your-own-writes explicitly
7. ❌ Over-indexing → write throughput tanks under load
