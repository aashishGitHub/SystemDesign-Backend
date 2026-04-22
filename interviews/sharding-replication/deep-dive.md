# Deep Dive: Database Sharding & Replication

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions

---

## Table of Contents

1. [Why Databases Hit a Ceiling](#1-why-databases-hit-a-ceiling)
2. [Sharding Strategies: Choosing the Right Cut](#2-sharding-strategies-choosing-the-right-cut)
3. [Replication: Copies for Safety and Speed](#3-replication-copies-for-safety-and-speed)
4. [Consistency Under Replication Lag](#4-consistency-under-replication-lag)
5. [Cross-Shard Queries and Distributed Transactions](#5-cross-shard-queries-and-distributed-transactions)
6. [Hot Shards and Load Imbalance](#6-hot-shards-and-load-imbalance)
7. [Online Re-sharding Without Downtime](#7-online-re-sharding-without-downtime)
8. [Real-World Company Case Studies](#8-real-world-company-case-studies)
9. [Pattern Recognition — When to Shard](#9-pattern-recognition--when-to-shard)
10. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Databases Hit a Ceiling

### 🟢 Beginner — The Restaurant Kitchen Analogy

Imagine a restaurant with one kitchen. When 10 customers order at once, the kitchen handles it fine. When 1,000 customers order, the single kitchen can't cook fast enough — food takes forever, some orders get dropped.

You have two choices:
1. **Bigger kitchen** (vertical scaling): Buy a bigger stove, hire more chefs for the same kitchen. Eventually, you hit physical limits.
2. **More kitchens** (horizontal scaling): Open multiple kitchens, each handling a portion of orders. No theoretical limit.

Databases face the same choice. A single PostgreSQL instance can handle millions of rows — but at billions of rows and thousands of writes per second, even the biggest server struggles.

---

### 🟡 Senior — Bottleneck Analysis

A single database instance has three main bottlenecks:

| Resource | Limit | Symptom |
|---|---|---|
| CPU | Cores max out | Query latency spikes, timeouts |
| Disk I/O | IOPS limit | Writes queue up, replication lags |
| Memory | RAM cap | Page faults, slow cold queries |

```sql
-- Diagnostic query: see where time goes
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users WHERE id = 12345;
-- Look for: Seq Scan (bad), Index Scan (good), Buffers read vs hit
```

When vertical scaling hits limits:
- AWS RDS maxes out at `db.r6g.16xlarge` (~64 vCPU, 512 GB RAM)
- Beyond that, you must distribute

---

### 🔴 Architect — Capacity Planning Math

**Scenario**: Social platform with 500M users, 10 KB avg row size.

```
Data size = 500M users × 10 KB = 5 TB
Peak writes = 50,000/sec (profile updates, posts)
Peak reads = 500,000/sec (feed loads)
```

Single PostgreSQL limits:
- Practical write ceiling: ~10,000 TPS on fast NVMe
- Single disk: 100K IOPS max (NVMe)

```
Required shards (write-based):
  50,000 / 10,000 = 5 shards minimum

Required shards (data-based):
  5 TB / 500 GB per shard = 10 shards

→ Start with 16 shards (power of 2 for future splits)
```

**Design review question**: "What happens if you're wrong and need 32 shards in a year?"
Answer: use consistent hashing so resharding moves minimal data.

---

## 2. Sharding Strategies: Choosing the Right Cut

### 🟢 Beginner — The Library Card Catalog

A library organizes books by **category** (fiction, science, history) — each category is a separate section. Finding a history book? Go to the history section.

Sharding is similar: you decide how to organize data so each query only checks one "section" instead of the entire library.

Three ways to organize:
1. **By range** (A-M, N-Z): Easy to understand, but some letters have more books
2. **By hash** (scramble the title): Even distribution, but "all books from 2023" requires checking everywhere
3. **By lookup** (card catalog tells you exactly where): Flexible, but the catalog itself becomes busy

---

### 🟡 Senior — Choosing the Right Strategy

| Strategy | Implementation | Best For | Avoid When |
|---|---|---|---|
| Range | `shard = floor(user_id / 1M)` | Archival (year-based), known key ranges | Hot ranges (new user IDs) |
| Hash | `shard = murmur3(user_id) % N` | Uniform access patterns | Range queries needed |
| Directory | Lookup table + routing service | Irregular distribution, flexible reassignment | Very high throughput (adds latency) |

```python
# Hash-based sharding in Python
import mmh3

def get_shard(user_id: str, num_shards: int) -> int:
    hash_value = mmh3.hash(user_id, signed=False)
    return hash_value % num_shards

# Directory-based sharding
class ShardRouter:
    def __init__(self, directory_client):
        self.directory = directory_client  # Redis, ZooKeeper, etc.
    
    def get_shard(self, user_id: str) -> str:
        shard = self.directory.get(f"user_shard:{user_id}")
        if not shard:
            shard = self._assign_new_shard(user_id)
        return shard
```

---

### 🔴 Architect — Pinterest's Sharding Evolution

**Real incident at Pinterest (2012)**:
- Started with 8 MySQL shards by user_id range
- User growth was non-uniform: shard 0 (early adopters) had 10x the data
- Had to emergency migrate to hash-based sharding mid-growth

**Lessons learned**:
1. Range sharding fails when growth is unpredictable
2. Hash sharding requires scatter-gather for analytics (build a separate data warehouse)
3. Re-sharding is expensive — over-provision shards initially

**Pinterest's current model**:
- 4096 virtual shards mapped to physical nodes
- Consistent hashing for assignment
- Each virtual shard is a separate MySQL database

---

## 3. Replication: Copies for Safety and Speed

### 🟢 Beginner — The Backup Singer Analogy

A lead singer performs the song. Backup singers know the same lyrics — if the lead loses their voice, a backup can take over. Plus, during concerts, backups help with volume (harmonizing).

Replication works the same way:
- **Primary (leader)**: Does the main work (writes)
- **Replicas (followers)**: Know everything the primary knows, help with read load, can take over if primary fails

---

### 🟡 Senior — Replication Topologies

```
                    ┌─────────────┐
     Writes ───────►│   Primary   │
                    └──────┬──────┘
                           │ Replication stream
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
      ┌─────────┐     ┌─────────┐     ┌─────────┐
      │Replica 1│     │Replica 2│     │Replica 3│
      └─────────┘     └─────────┘     └─────────┘
           ▲               ▲               ▲
           │               │               │
         Reads ─────────────────────────────
```

| Replication Mode | Write Latency | Data Loss Risk | Availability |
|---|---|---|---|
| Async | Lowest | Highest (lag window) | Highest |
| Semi-sync (1 ack) | Medium | Low (1 copy confirmed) | High |
| Sync (all ack) | Highest | Lowest | Lowest |

```sql
-- PostgreSQL: check replication lag
SELECT client_addr, 
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes,
       replay_lag
FROM pg_stat_replication;

-- MySQL: check replication status
SHOW SLAVE STATUS\G
-- Look for: Seconds_Behind_Master
```

---

### 🔴 Architect — GitHub's MySQL Replication Incident (2020)

**What happened**: GitHub's primary MySQL failed. Promotion happened, but a subtle data inconsistency emerged:
- Some webhooks fired twice
- Some issues showed incorrect state

**Root cause**: During failover, the new primary had lagged the old primary by ~5 seconds. Writes in that window were lost, causing inconsistent application state.

**Fix implemented**:
1. Moved to semi-synchronous replication for critical tables
2. Implemented write-ahead-log (WAL) fencing — old primary can't accept writes after failover
3. Added reconciliation jobs to detect and repair inconsistencies

**Capacity math — replication bandwidth**:

```
Write throughput: 10,000 TPS × 1 KB avg = 10 MB/s
Replication bandwidth needed: 10 MB/s × 3 replicas = 30 MB/s network
Cross-region replication (100ms RTT): adds ~100ms to sync writes
```

---

## 4. Consistency Under Replication Lag

### 🟢 Beginner — The Whiteboard Meeting Analogy

You're in a meeting. You write on the whiteboard "Meeting at 3pm." Your colleague in another room has a video feed of the whiteboard — but there's a 2-second delay.

You announce "It's updated!" Your colleague looks at their screen... still shows the old time. They refresh, and eventually it updates.

This is replication lag. The source is up-to-date, but the copies are behind.

---

### 🟡 Senior — Consistency Anomalies

| Anomaly | What Happens | User Experience |
|---|---|---|
| Stale read | User reads from lagging replica | "My post didn't save!" (it did) |
| Non-monotonic read | User reads from fast replica, then slow one | Sees update, then sees old version |
| Lost update (async) | Primary fails before replicating | User's write is permanently lost |

```typescript
// Solution: read-your-own-writes with token
class ConsistentReader {
  async write(userId: string, data: any): Promise<{writeToken: number}> {
    const result = await this.primary.write(userId, data);
    const writeToken = result.commitTimestamp;
    return { writeToken };
  }
  
  async read(userId: string, writeToken?: number): Promise<any> {
    if (writeToken) {
      // Wait for replica to catch up, or fallback to primary
      const replica = await this.getReplicaCaughtUp(writeToken, timeout: 100);
      if (replica) {
        return replica.read(userId);
      }
      return this.primary.read(userId); // fallback
    }
    return this.pickReplica().read(userId);
  }
}
```

---

### 🔴 Architect — Facebook's TAO Consistency Model

**TAO** (The Associations and Objects system) handles Facebook's social graph.

**Problem**: With billions of users and async replication across continents, consistency is hard.

**Facebook's solution — "Read-after-write consistency" per user**:
1. After a write, return a `version_token`
2. Client sends token with subsequent reads
3. TAO cache layer ensures read only returns if version >= token

```
Write: user_123 updates profile → version = 1001
       → response includes version: 1001

Read: client sends version: 1001
      → TAO checks: is cached version >= 1001?
         → Yes: return data
         → No: wait for invalidation or query primary
```

**Tradeoff**: Adds latency to reads when version isn't available. But preserves user experience — they always see their own writes.

**Grafana alert for replication lag**:
```yaml
- alert: ReplicationLagCritical
  expr: pg_replication_lag_seconds > 5
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Replication lag exceeds 5 seconds"
    description: "Primary-replica lag may cause stale reads"
```

---

## 5. Cross-Shard Queries and Distributed Transactions

### 🟢 Beginner — The Multi-Location Inventory Check

Imagine you run three warehouses. A customer orders 10 items. No single warehouse has all 10 — you need to check all three and combine the results.

That's scatter-gather: query each location, merge answers.

Now imagine the customer wants a "package deal" — they get all 10 items or nothing. Each warehouse must commit to holding the items simultaneously. If any warehouse can't hold their items, the whole deal is canceled.

That's a distributed transaction — coordinating agreement across locations.

---

### 🟡 Senior — Scatter-Gather Mechanics

```python
# Scatter-gather query execution
async def scatter_gather_count(query: str, shards: List[Shard]) -> int:
    # Scatter: send query to all shards in parallel
    tasks = [shard.execute(query) for shard in shards]
    results = await asyncio.gather(*tasks)
    
    # Gather: aggregate results
    return sum(result['count'] for result in results)

# Called like:
total_pending = await scatter_gather_count(
    "SELECT COUNT(*) as count FROM orders WHERE status = 'pending'",
    all_shards
)
```

| Operation | Single-Shard | Cross-Shard |
|---|---|---|
| Latency | Single DB round-trip | Max(all shard latencies) + coordination |
| Failure impact | Limited to one shard | One shard failure = whole query fails |
| Lock contention | Local only | Distributed deadlock possible |

---

### 🔴 Architect — Uber's Schemaless and Cross-Shard Transactions

**Uber's Schemaless** (MySQL-backed distributed store) handles cross-shard operations:

**Design decision**: No distributed transactions. Use idempotent operations + eventual consistency.

```
Instead of: BEGIN; UPDATE shard_1; UPDATE shard_2; COMMIT;
            (blocks, deadlocks, fails unpredictably)

They do:    UPDATE shard_1 SET ... WHERE version = X; -- returns success/conflict
            UPDATE shard_2 SET ... WHERE version = Y; -- returns success/conflict
            If conflict: retry with new version
```

**For money transfers (requires atomicity)**:

```
1. Debit source account (shard 1) — write pending_transfer record
2. Credit dest account (shard 2) — write pending_transfer record  
3. Background job: reconcile pending_transfers, mark completed
4. If any step fails: compensating transaction + alert

State machine:
  source: PENDING_DEBIT → DEBITED → CONFIRMED
  dest:   PENDING_CREDIT → CREDITED → CONFIRMED
```

**Chaos engineering test**: Kill a shard during step 2. Verify reconciliation job detects and compensates.

---

## 6. Hot Shards and Load Imbalance

### 🟢 Beginner — The Popular Checkout Lane

At a grocery store, one lane has a famous person. Everyone crowds that lane to see them. Meanwhile, 9 other lanes sit empty. The store's total capacity is limited by that one lane.

Hot shards are the same — one shard gets disproportionate traffic, becoming the bottleneck for the entire system.

---

### 🟡 Senior — Detecting and Mitigating Hot Shards

**Detection metrics**:
```sql
-- PostgreSQL: per-shard query count
SELECT datname, 
       numbackends as active_connections,
       xact_commit + xact_rollback as total_transactions
FROM pg_stat_database;
```

| Cause | Detection Signal | Mitigation |
|---|---|---|
| Celebrity user | One user_id dominates write logs | Salt key, dedicated shard |
| Viral content | One object_id in read hot path | Cache layer in front |
| Time partition | Newest partition gets all writes | Hash by event_id, not time |

```python
# Salted sharding for hot keys
import random

def get_shard_salted(user_id: str, num_shards: int, salt_factor: int = 10) -> int:
    # Hot users get spread across salt_factor sub-shards
    salt = random.randint(0, salt_factor - 1)
    composite_key = f"{user_id}:{salt}"
    return murmur3(composite_key) % num_shards

# Reads require scatter-gather across salt_factor shards
def read_all_for_user(user_id: str, salt_factor: int = 10) -> List:
    results = []
    for salt in range(salt_factor):
        shard = get_shard_salted(user_id, num_shards, salt_factor=1, fixed_salt=salt)
        results.extend(shard.query(user_id))
    return results
```

---

### 🔴 Architect — Slack's Hot Workspace Problem

**Problem**: Slack's sharding is by workspace_id. One workspace (a giant enterprise) had 100,000 users — 100x a normal workspace. That shard was constantly overloaded.

**Analysis**:
```
Normal workspace: 1,000 users × 100 msg/day = 100K events/day
Hot workspace: 100,000 users × 100 msg/day = 10M events/day
                                            (100x baseline)
```

**Solution implemented**:
1. Identified hot workspaces via monitoring
2. Sub-sharded hot workspaces by channel_id (within workspace)
3. Routing: `if workspace in hot_list: shard = hash(channel_id) else: shard = hash(workspace_id)`

**Monitoring to catch this earlier**:
```yaml
- alert: ShardLoadImbalance
  expr: |
    (max(shard_qps) / avg(shard_qps)) > 3
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Shard load imbalance detected"
    description: "Hottest shard has 3x average load"
```

---

## 7. Online Re-sharding Without Downtime

### 🟢 Beginner — Moving House Without Stopping Life

You're moving to a bigger house, but you can't stop living. You don't pack everything and move on one day. Instead:
1. Set up the new house furniture
2. Start sleeping at the new house, but keep your mail going to old house
3. Forward mail, changing one system at a time
4. Eventually, everything is at the new house

Re-sharding is the same — gradually move data while the system continues operating.

---

### 🟡 Senior — Double-Write Migration Pattern

```
Phase 1: Setup
┌──────────────┐     ┌──────────────┐
│  Old Shards  │     │  New Shards  │ (empty)
└──────────────┘     └──────────────┘

Phase 2: Double-Write
        writes ─────┬────► Old Shards ◄──── reads
                    └────► New Shards (writes only)

Phase 3: Backfill
        Copy historical data: Old → New
        Verify checksums match

Phase 4: Shadow Read
        reads ───┬────► Old Shards (returned to client)
                 └────► New Shards (compare only, log diffs)

Phase 5: Cutover
        reads ────────► New Shards
        writes ───────► New Shards only
        Old Shards: read-only for rollback

Phase 6: Cleanup  
        Decommission old shards after 7 days
```

```python
class MigrationRouter:
    def __init__(self, phase: str):
        self.phase = phase
    
    def route_write(self, key: str, data: Any):
        if self.phase in ['double_write', 'backfill', 'shadow']:
            self.old_shards.write(key, data)
            self.new_shards.write(key, data)
        elif self.phase == 'cutover':
            self.new_shards.write(key, data)
    
    def route_read(self, key: str) -> Any:
        if self.phase in ['double_write', 'backfill']:
            return self.old_shards.read(key)
        elif self.phase == 'shadow':
            old_result = self.old_shards.read(key)
            new_result = self.new_shards.read(key)
            if old_result != new_result:
                self.log_diff(key, old_result, new_result)
            return old_result
        elif self.phase == 'cutover':
            return self.new_shards.read(key)
```

---

### 🔴 Architect — Stripe's Online Migration System

**Stripe migrates billions of records** without downtime using a system called "Sorbet Dash":

**Key principles**:
1. **Dual-write from day 1**: Application writes to both old and new
2. **Backfill with checkpoints**: Resumable; tracks last processed ID
3. **Verification pass**: Compare all records, log mismatches
4. **Gradual traffic shift**: 1% → 5% → 25% → 100% reads from new system
5. **Rollback ready**: Keep old system writable for 1 week post-cutover

**Capacity planning for migration**:
```
Records to migrate: 1 billion
Backfill rate: 50,000 records/sec
Backfill duration: 1B / 50K = 20,000 seconds ≈ 5.5 hours

Extra write load during dual-write: 2x normal write QPS
   → Must pre-scale new shards to handle 2x
   
Network transfer: 1B × 10KB = 10 TB
Cross-region: 10 TB / 1 Gbps = ~22 hours
```

**Failure scenario**: Backfill job crashes mid-way
- Solution: Checkpoint every 10,000 records. On restart, resume from last checkpoint.

---

## 8. Real-World Company Case Studies

### Instagram — Sharding PostgreSQL

Instagram shards PostgreSQL by `user_id` using a custom routing layer.

**Key decisions**:
- 12 shards initially, grew to 64
- "User ID → Shard ID" mapping stored in application code (no external directory)
- Logical sharding: all user's data on same shard (posts, followers, likes collocated)

**Lesson**: Co-locate related data. Never shard the followers table by follower_id — it would separate a user from their own followers.

---

### YouTube — Vitess for MySQL

YouTube outgrew MySQL in 2010. Built Vitess as a sharding layer.

**Architecture**:
```
[VTGate] ← query routing, connection pooling
    │
[VTTablet] ← MySQL process manager, replication, backups
    │
[MySQL] ← actual data storage
```

**Why this works**:
- Application talks to VTGate, unaware of shards
- VTGate parses SQL, routes to correct shard(s)
- Cross-shard queries handled transparently (scatter-gather)

**Vitess specific**: supports online schema migrations (ghost tables).

---

### DynamoDB — Fully Managed Sharding

AWS DynamoDB hides sharding entirely.

**How it works**:
- Partition key → hash → partition placement
- Partitions auto-split at 10GB or high throughput
- User sees a single table, AWS manages distribution

**Trade-off**: Less control (can't specify shard count), but zero operational overhead.

---

## 9. Pattern Recognition — When to Shard

### Signals You Need Sharding

| Signal | Metric | Threshold |
|---|---|---|
| Write throughput exceeded | Write TPS | > 80% of single-node capacity |
| Data size | Table size | > 1 TB (query performance degrades) |
| Single-node recovery time | MTTR | > 15 minutes (too long for SLA) |
| Read replicas not helping | Replica lag | Growing despite adding replicas |

### Signals You Don't Need Sharding Yet

| Signal | Why Wait |
|---|---|
| Read-heavy workload | Add read replicas instead |
| Data fits in memory | Single node with good indexes |
| Low write throughput | Vertical scaling cheaper |
| Complex joins required | Sharding makes joins very expensive |

### Decision Flowchart

```
Is write throughput > single-node capacity?
  │
  ├─ YES → Shard
  │
  └─ NO → Is data > 1TB?
              │
              ├─ YES → Shard (or consider archival)
              │
              └─ NO → Is read latency the problem?
                          │
                          ├─ YES → Add read replicas
                          │
                          └─ NO → Don't shard yet
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Sharding | Horizontal partitioning by shard key — each shard holds a subset |
| Vertical scaling | Bigger server — limited by hardware ceiling |
| Horizontal scaling | More servers — no theoretical ceiling |
| Range sharding | Shard by key ranges — hot ranges kill it |
| Hash sharding | Uniform distribution — no range queries |
| Directory sharding | Lookup table — flexible but adds latency |
| Compound shard key | Multi-field key — must query with prefix |
| Leader-follower | All writes to leader, reads to followers |
| Sync replication | Wait for replica ack — durability over latency |
| Async replication | Return immediately — latency over durability |
| Replication lag | Time between leader commit and replica apply |
| Read-your-own-writes | User sees their own writes immediately |
| Monotonic reads | User never sees time go backward |
| Scatter-gather | Query all shards, merge results |
| 2PC | Distributed ACID — blocking, slow, avoid if possible |
| Saga pattern | Local transactions + compensation — eventually consistent |
| Hot shard | One shard gets disproportionate load |
| Salted key | Add random suffix to spread hot key across shards |
| Consistent hashing | Minimize data movement on shard add/remove |
| Dual-write migration | Write to old + new, then cutover |
| CDC | Capture DB changes as a stream — avoids dual-write inconsistency |
| CQRS | Separate read model from write model |
| Geo-partitioning | Data lives in the region it's accessed |
| RPO | Recovery Point Objective — max acceptable data loss |
| RTO | Recovery Time Objective — max acceptable downtime |
| Vitess | YouTube's MySQL sharding layer — VTGate + VTTablet |
| TAO | Facebook's distributed graph store — read-after-write per user |
