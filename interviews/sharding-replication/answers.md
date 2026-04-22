# Answers: Database Sharding & Replication

> Keyed to [questions.md](./questions.md). Read questions first.
> Every answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Fundamentals & Motivation

### A1. Scaling categories — vertical vs horizontal

| Category | Definition | Sharding? |
|---|---|---|
| Vertical scaling (scale-up) | Add more CPU, RAM, or disk to a single machine | No |
| Horizontal scaling (scale-out) | Add more machines and distribute data/load | Yes |

Sharding is horizontal scaling for writes. You cannot infinitely scale vertically — hardware limits and cost curves make it impractical beyond a point.

---

### A2. Vertical vs horizontal tradeoffs

| Aspect | Vertical Scaling | Horizontal Scaling |
|---|---|---|
| Cost curve | Exponential (2x CPU ≠ 2x price) | Near-linear |
| Ceiling | Hardware limits (~100 cores, 24 TB RAM) | No theoretical ceiling |
| Downtime | Requires migration or reboot | Rolling addition of nodes |
| Complexity | Low (single node) | High (distributed coordination) |

Vertical scaling becomes impractical when:
- Costs scale non-linearly (a 128-core machine costs 10x a 64-core, not 2x)
- You hit physical hardware limits
- Single-point-of-failure becomes unacceptable

---

### A3. What is sharding — precise definition

Sharding is **horizontal partitioning of data across multiple independent database nodes**, where each node (shard) holds a disjoint subset of the total dataset based on a **partitioning key**.

```text
Before sharding:
[Single DB] ← all 2B users

After sharding:
[Shard 0] ← users where hash(user_id) % 4 == 0
[Shard 1] ← users where hash(user_id) % 4 == 1
[Shard 2] ← users where hash(user_id) % 4 == 2
[Shard 3] ← users where hash(user_id) % 4 == 3
```

Key properties:
- Each row lives on exactly one shard
- The shard key determines placement
- Shards are operationally independent (can fail/upgrade independently)

---

### A4. Read replicas before sharding

For read-heavy workloads, add **read replicas** before sharding.

```text
[Primary] → writes
    ↓ async replication
[Replica 1] → reads
[Replica 2] → reads
[Replica 3] → reads
```

Why this helps:
- Reads scale out without changing the data model
- No cross-shard query complexity
- Lower operational burden than sharding

Sharding is for **write scaling**. Replicas are for **read scaling**. Try replicas first.

---

## Level 2 — Sharding Strategies

### A5. Three sharding strategies

| Strategy | How It Works | Ideal Use Case | Failure Case |
|---|---|---|---|
| Range-based | Shard by key ranges (e.g., A-M, N-Z) | Time-series data, log tables | Hot ranges if access is non-uniform |
| Hash-based | `shard = hash(key) % N` | User data with uniform access | Range queries impossible |
| Directory-based | Lookup table maps key→shard | Irregular key space, flexible reassignment | Lookup becomes bottleneck |

```ts
// Hash-based example
function getShard(userId: string, numShards: number): number {
  return hash(userId) % numShards;
}

// Range-based example
function getShard(timestamp: Date): string {
  if (timestamp.year === 2024) return "shard_2024";
  if (timestamp.year === 2025) return "shard_2025";
  return "shard_archive";
}
```

---

### A6. Hash-based for user_id — why preferred

Hash-based sharding distributes users uniformly, avoiding hot shards.

| Scenario | Range-Based | Hash-Based |
|---|---|---|
| User IDs 1–1M sign up in order | All on shard 0 (hot!) | Distributed evenly |
| Celebrity users access | May cluster if alphabetical | Distributed randomly |
| New signups | All hit latest range shard | Spread across all shards |

Hash-based is statistically uniform when the hash function is good (e.g., MD5, MurmurHash).

---

### A7. `created_at` as shard key — what goes wrong

Using timestamp as shard key creates **write-hot shards**:

```text
Time-range sharding:
[Shard Jan 2025] ← cold
[Shard Feb 2025] ← cold
[Shard Mar 2025] ← ALL WRITES GO HERE (hot!)
```

Problems:
- Latest shard receives 100% of writes
- Hardware for old shards is wasted
- Single-node write bottleneck (back to vertical scaling)

Better approach: use a hash of `event_id` or `user_id` + partition by time for archival.

---

### A8. Directory-based sharding

```text
┌───────────────┐
│  Shard Router │ ← lookup table: key → shard
└───────────────┘
      ↓
┌─────────────────────────────────────┐
│ Lookup Table (in Redis/ZooKeeper)  │
│ user_123 → shard_2                 │
│ user_456 → shard_0                 │
│ user_789 → shard_1                 │
└─────────────────────────────────────┘
```

| Aspect | Advantage | Disadvantage |
|---|---|---|
| Flexibility | Can move any key to any shard | Lookup adds latency |
| Rebalancing | Just update the directory | Directory itself must be highly available |
| Key irregularity | Handles skewed key spaces | Extra infrastructure to manage |

Used by: Vitess (YouTube's MySQL sharding layer).

---

### A9. Celebrity hot shard problem

Problem: hash-sharding by `user_id` concentrates all of a celebrity's posts on one shard.

```text
Celebrity user_123 → shard_2
All 10,000 daily posts → shard_2 overloaded
```

Mitigations:

| Strategy | How It Works |
|---|---|
| Salt the key | `shard_key = hash(user_id + random_suffix)` — spreads writes, complicates reads |
| Separate storage tier | Celebrity posts go to dedicated high-throughput shard |
| Sub-sharding | Further partition by `post_id` within user |
| Write buffering | Batch celebrity writes through a queue |

---

### A10. Compound shard key

A compound shard key uses multiple fields: `shard_key = hash(tenant_id, user_id)`.

```js
// MongoDB compound shard key
db.orders.createIndex({ tenantId: 1, orderId: 1 });
sh.shardCollection("db.orders", { tenantId: 1, orderId: 1 });
```

| Use Case | Why Compound |
|---|---|
| Multi-tenant SaaS | Isolate tenants while distributing within tenant |
| Time + user queries | `(user_id, created_at)` enables efficient range scans within user |

Limitation: queries that don't include prefix fields require scatter-gather.

---

## Level 3 — Replication Models

### A11. Leader-follower replication

```text
[Leader/Primary] ← writes (INSERT, UPDATE, DELETE)
     │
     ↓ replication stream
[Follower 1] ← reads only
[Follower 2] ← reads only
```

| Operation | Goes To |
|---|---|
| Writes | Leader only |
| Reads | Followers (or leader if fresh read needed) |
| Failover | Promote one follower to leader |

Used by: PostgreSQL, MySQL, MongoDB (replica sets).

---

### A12. Synchronous vs asynchronous replication

| Aspect | Synchronous | Asynchronous |
|---|---|---|
| Write latency | Higher (waits for replica ack) | Lower (returns immediately) |
| Durability | Strong (replicas confirmed) | Weaker (lag window = potential loss) |
| Availability | Lower (replica down = write blocked) | Higher (leader can proceed alone) |

```text
Synchronous:
Client → Leader → [wait for Replica ACK] → return success

Asynchronous:
Client → Leader → return success → [later] Replica receives
```

---

### A13. Multi-master replication

All nodes accept writes. Used for geo-distributed write-local latency.

```text
[Master US] ←→ replication ←→ [Master EU] ←→ [Master APAC]
```

| Advantage | New Problem |
|---|---|
| Low write latency (write locally) | Write-write conflicts |
| No single point of failure for writes | Conflict resolution logic required |
| Active-active disaster recovery | Last-write-wins may lose data |

Conflict resolution strategies: last-write-wins (LWW), vector clocks, application-level merge.

---

### A14. Leader crash with async replication — data loss

If leader crashes before replicating uncommitted transactions:

```text
Leader: tx_1, tx_2, tx_3 (committed locally)
Replica: tx_1, tx_2 (replicated)
         ↑
       tx_3 lost on failover
```

This defines **RPO (Recovery Point Objective)**: the maximum acceptable data loss window. With async replication, RPO = replication lag.

---

### A15. Semi-synchronous replication (MySQL)

```text
Client → Leader → [wait for AT LEAST 1 replica ACK] → return success
```

| Property | Value |
|---|---|
| Durability | At least 2 copies before ack |
| Latency | Higher than async, lower than full sync |
| Availability | Can proceed if 1+ replica is reachable |

MySQL `rpl_semi_sync_master_wait_for_slave_count = 1` enables this.

---

## Level 4 — Consistency, Replication Lag & Anomalies

### A16. Read-your-own-writes problem

```text
1. User updates profile (write → leader)
2. User refreshes page (read → replica)
3. Replica hasn't received update yet → shows stale data
```

User experience: "My update didn't save!" (but it did — just not visible yet).

Replication lag is the time between leader commit and replica apply.

---

### A17. Strategies for read-your-own-writes

| Strategy | How It Works | Tradeoff |
|---|---|---|
| Read from leader after write | Track "last_write_ts" per user, route reads to leader if recent | Adds load to leader |
| Monotonic read tokens | Include `read_after_ts` in session, replica waits until caught up | Adds latency |
| Sticky sessions | Always route user to same replica | Reduces load balancing flexibility |

```ts
// Token-based approach
async function getProfile(userId: string, readAfterTs?: number) {
  if (readAfterTs && replica.lastAppliedTs < readAfterTs) {
    return await leader.getProfile(userId); // fallback to leader
  }
  return await replica.getProfile(userId);
}
```

---

### A18. Monotonic read anomaly

Problem: user reads from Replica A (sees new data), then Replica B (sees old data) — time appears to go backward.

```text
Read 1 → Replica A (caught up) → sees post v3
Read 2 → Replica B (lagging)   → sees post v2 ← older!
```

Fix: **session stickiness** — route all reads from the same session to the same replica.

---

### A19. Profile update visible 200ms later with 500ms lag

Consistency model violated: **read-your-own-writes**.

Cheapest fix: after a write, set a session cookie `read_after_ts = now()`. For the next 1 second, route that user's reads to the leader.

```ts
function routeRead(userId: string, session: Session): Database {
  const recentWriteThreshold = 1000; // 1 second
  if (Date.now() - session.lastWriteTs < recentWriteThreshold) {
    return leader;
  }
  return pickReplica();
}
```

---

### A20. When to always read from leader

| Scenario | Why Leader Read Required |
|---|---|
| Immediately after write (user's own data) | Read-your-own-writes |
| Financial transactions | Strong consistency required |
| Inventory check before purchase | Stale read → oversell |
| Configuration that affects auth/permissions | Security-critical freshness |

Rule: if stale data causes **user-visible bugs** or **business logic errors**, read from leader.

---

## Level 5 — Cross-Shard Operations

### A21. Scatter-gather query

```sql
SELECT COUNT(*) FROM orders WHERE status = 'pending';
-- orders sharded by user_id, NOT by status
```

This query must:
1. Go to ALL shards (scatter)
2. Each shard counts locally
3. Coordinator sums results (gather)

```text
Coordinator
    ├─→ Shard 0: COUNT = 1,234
    ├─→ Shard 1: COUNT = 2,345
    ├─→ Shard 2: COUNT = 1,890
    └─→ Sum = 5,469
```

Called: **scatter-gather**. Expensive because it touches every shard.

---

### A22. Distributed joins

A join between `users` (shard by user_id) and `orders` (shard by user_id) is **co-located** — efficient.

A join between `users` (shard by user_id) and `products` (shard by product_id) is **distributed** — expensive.

```text
Distributed join:
For each user row:
  → Fetch matching product rows from DIFFERENT shards
  → Network round-trips × N
```

Avoidance strategies:

| Approach | How |
|---|---|
| Denormalization | Store product_name in orders table |
| Co-location | Shard related tables by same key |
| Application-level join | Fetch both, join in code |

---

### A23. Two-Phase Commit (2PC)

```text
Coordinator             Shard 1              Shard 2
     │                    │                    │
     ├── PREPARE ────────►│                    │
     ├── PREPARE ─────────┼───────────────────►│
     │                    │                    │
     │◄── VOTE YES ───────┤                    │
     │◄── VOTE YES ────────────────────────────┤
     │                    │                    │
     ├── COMMIT ─────────►│                    │
     ├── COMMIT ──────────┼───────────────────►│
     │                    │                    │
     ▼                    ▼                    ▼
```

Problems at scale:

| Issue | Impact |
|---|---|
| Blocking | If coordinator dies during prepare, participants wait forever |
| Latency | 2 round-trips minimum |
| Availability | Any participant failure blocks transaction |
| Lock holding | Resources locked during prepare phase |

2PC is avoided in high-throughput systems.

---

### A24. Saga pattern

Break transaction into local transactions with compensating actions.

| Variant | Coordination |
|---|---|
| Choreography | Each service emits events, next service reacts |
| Orchestration | Central orchestrator commands each step |

```text
Saga (orchestration):
1. Order Service: create order (pending)
2. Payment Service: charge card
3. Inventory Service: reserve stock
4. Order Service: confirm order

If step 3 fails:
   → Payment Service: refund (compensating action)
   → Order Service: cancel order
```

Preferred over 2PC when: transactions span services, latency matters, eventual consistency is acceptable.

---

## Level 6 — Hot Shards, Re-sharding & Migrations

### A25. Hot shard causes and mitigations

| Root Cause | Example | Mitigation |
|---|---|---|
| Skewed key distribution | Celebrity user, viral product | Salted keys, dedicated shard |
| Time-based access | "Today's" data shard for events | Hash by event_id, not time |
| Range key clustering | Alphabetical sharding, all users start with 'A' | Use hash-based sharding |

Detection: monitor shard-level CPU, IOPS, latency percentiles. Alert on imbalance.

---

### A26. Online re-sharding (8 → 16 shards)

```text
Phase 1: Dual-write
  - New writes go to BOTH old shard AND new shard
  - Read from old shards

Phase 2: Backfill
  - Copy historical data from old shards to new shards
  - Verify checksums

Phase 3: Shadow reads
  - Read from new shards, compare with old
  - Log discrepancies, fix bugs

Phase 4: Cutover
  - Switch reads to new shards
  - Stop dual-write to old shards

Phase 5: Cleanup
  - Decommission old shards after retention period
```

Zero-downtime because reads/writes continue throughout.

---

### A27. Consistent hashing reduces data movement

| Sharding | Adding 1 node to 8 nodes | Data moved |
|---|---|---|
| Modulo (`hash % N`) | ALL keys rehash | ~87.5% of data |
| Consistent hashing | Only keys in one ring arc affected | ~12.5% of data |

```text
Before: 8 nodes on ring, each owns 1/8
After:  9 nodes on ring, new node takes 1/9 from its neighbor
```

This is why DynamoDB, Cassandra, and Redis Cluster use consistent hashing.

---

### A28. Resharding without dual-write — what goes wrong

```text
1. Create new shard
2. Bulk copy data (takes hours)
3. Cutover reads/writes to new shard

Problem: writes during bulk copy go to OLD shard only
         → new shard is STALE at cutover
         → data loss or inconsistency
```

Dual-write ensures both old and new shards receive writes during migration.

---

## Level 7 — Advanced Patterns

### A29. CQRS (Command Query Responsibility Segregation)

Separate write model from read model.

```text
                    ┌──────────────┐
                    │   Writes     │
                    │ (normalized) │
                    └──────┬───────┘
                           │ CDC / events
                           ▼
                    ┌──────────────┐
                    │   Reads      │
                    │(denormalized)│
                    └──────────────┘
```

| Write Side | Read Side |
|---|---|
| Normalized schema | Denormalized for fast queries |
| Sharded by write key | Indexed by read patterns |
| Strong consistency | Eventually consistent |

Complements sharding by allowing read-optimized projections separate from write shards.

---

### A30. Change Data Capture (CDC)

CDC captures database changes as a stream.

```text
[Postgres] → WAL → [Debezium] → [Kafka] → consumers
```

| vs Application Dual-Write | CDC |
|---|---|
| App writes to DB + Kafka | DB writes to WAL, CDC streams it |
| Failure leaves them inconsistent | Exactly-once from committed DB state |
| App code complexity | Operational complexity |

CDC ensures downstream systems see exactly what the database committed — no inconsistency window.

---

### A31. Geo-partitioning

Data lives in the region where it's accessed.

```text
US Users → US Shards (us-east-1)
EU Users → EU Shards (eu-west-1)
```

| Benefit | Sacrifice |
|---|---|
| Low latency (data is local) | Cross-region reads are slow |
| Data sovereignty (GDPR) | Global queries require scatter-gather |
| Failure isolation | Complexity of geo-routing |

Consistency sacrifice: writes are locally consistent; global view is eventually consistent.

---

### A32. Spanner / CockroachDB — globally consistent SQL

Mechanism: **TrueTime** (Spanner) or **Hybrid Logical Clocks** (CockroachDB).

```text
TrueTime: GPS + atomic clocks → bounded clock uncertainty
Spanner waits for uncertainty window before committing
   → guarantees external consistency (linearizability)
```

Latency cost: commit latency includes TrueTime wait (~7ms average).

For most systems, this is acceptable for the benefit of global strong consistency.

---

## Level 8 — Architect / Design Review

### A33. Fintech platform sharding decision

| Decision | Choice | Rationale |
|---|---|---|
| Shard key | `user_id` (or `account_id`) | Most queries are user-scoped |
| Number of shards | 32 (power of 2 for consistent hashing) | Allows resharding to 64, 128 later |
| Sharding method | Hash-based with consistent hashing | Uniform distribution, minimal re-shard cost |
| Replication | Semi-synchronous, 2 replicas per shard | Strong durability + acceptable latency |
| Consistency tier | Strong for transactions, eventual for analytics | Protect money, allow analytics lag |

Cross-shard transfers: use Saga pattern with compensating transactions (refund on failure).

---

### A34. "Shard all by user_id" — problems

| Problem | Why It Breaks |
|---|---|
| Admin queries | "All orders today" requires scatter-gather to all shards |
| Product catalog | Products aren't owned by users — wrong shard key |
| Analytics | Aggregations become expensive N-shard operations |
| Foreign keys | Cross-table joins become distributed joins |

Counter-proposal: shard **selectively**. Only shard write-hot, user-scoped tables. Keep reference tables (products, config) replicated or on single node.

---

### A35. Shard 7 at 90% disk — resolution path

**Short-term**:
1. Add disk (if possible) or evacuate cold data to archive
2. Identify and migrate large tables to other shards

**Proper resolution**:
1. Trigger re-shard: split shard 7 into 7a and 7b
2. Use online resharding procedure (dual-write, backfill, cutover)
3. Update routing to include new shards

**Monitoring that should have caught this**:
- Alert: disk usage > 70% → warning
- Alert: disk usage > 80% → page on-call
- Dashboard: disk growth rate trend

---

## Bonus Answers

### QB1. Foreign key integrity across shards

You **cannot** enforce foreign keys across shards at the database level.

Options:
- Co-locate related tables on same shard key
- Enforce referential integrity in application code
- Use eventual consistency + cleanup jobs for orphaned records

---

### QB2. ORM SELECT * with cross-shard queries

Infrastructure changes needed:

| Layer | Change |
|---|---|
| Query router | Detect non-shard-key queries, execute scatter-gather |
| Secondary indexes | Build global secondary index (GSI) on `created_at` |
| Caching | Cache time-range query results |
| Schema | Add denormalized `created_at` partition for analytics |

Or: push analytics queries to a separate read replica / data warehouse.

---

### QB3. Sharding comparison across databases

| Database | Sharding Model | Routing Layer |
|---|---|---|
| PostgreSQL (Citus) | Extension-based, distributed tables | Coordinator node |
| MySQL (Vitess) | Proxy-based, VTGate routes queries | VTGate + VTTablet |
| Cassandra | Built-in, consistent hashing with vnodes | Any node (peer-to-peer) |
| DynamoDB | Managed, automatic partition splitting | AWS-managed |

---

### QB4. Thundering herd after leader failover

```text
Leader fails → Replica promoted → all clients reconnect at once
                                   ↓
                            connection storm + query spike
```

Mitigation:
- Exponential backoff with jitter on reconnect
- Connection pooling with rate-limited establishment
- Health check grace period before accepting traffic

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Sharding | Horizontal partitioning of data across multiple nodes by shard key |
| Vertical vs Horizontal | Vertical = bigger machine; Horizontal = more machines |
| Range sharding | Good for time-series, bad for write-hot ranges |
| Hash sharding | Uniform distribution, impossible range queries |
| Directory sharding | Flexible but adds lookup latency |
| Replication | Copies of data for read scaling and fault tolerance |
| Sync replication | Durability over latency |
| Async replication | Latency over durability, lag = potential data loss |
| Read-your-own-writes | Route to leader after write, or use monotonic tokens |
| Scatter-gather | Query touches all shards when shard key not in filter |
| 2PC | Distributed ACID but blocking and slow |
| Saga | Compensating transactions for cross-service consistency |
| Hot shard | One shard gets disproportionate load |
| Consistent hashing | Minimizes data movement on shard add/remove |
| CDC | Stream database changes to downstream systems |
| CQRS | Separate read and write models |
| Geo-partitioning | Data lives in the region where it's accessed |
