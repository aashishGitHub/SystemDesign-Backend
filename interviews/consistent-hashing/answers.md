# Answers: Consistent Hashing

> Keyed to [questions.md](./questions.md). Read questions first — attempt each before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on decisions that matter.

---

## Level 1 — The Core Problem

### A1. The problem consistent hashing solves

Consistent hashing solves the problem of distributing data across a cluster of nodes such that **adding or removing one node requires moving only a small, bounded fraction of data** — not a full reshuffle.

Without it: every topology change forces nearly all data to relocate, emptying a distributed cache and causing a thundering herd against the backend.

| Property | Modulo Hashing (`hash(key) % N`) | Consistent Hashing |
|---|---|---|
| Keys moved on node addition | ~(N-1)/N ≈ 80-99% | ~1/N ≈ 10-25% |
| Node addition complexity | Full reshuffle required | Only adjacent key range moves |
| Cluster stability | Brittle — any change causes cascade | Stable — changes are bounded |
| Typical use | Fixed-size deployments | Growing distributed systems |

---

### A2. Fraction of keys remapped with modulo hashing

With `hash(key) % N`:

```
N=4 → N=5:

Key K maps to hash(K) % 4 = bucket B4
After adding node: hash(K) % 5 = bucket B5
B4 and B5 are the same only when hash(K) % 4 == hash(K) % 5, which is rare.

Expected fraction remapped = (N-1) / N = 4/5 = 80%
```

| Transition | Keys that must move |
|---|---|
| 4 → 5 nodes | ~80% |
| 10 → 11 nodes | ~90% |
| 100 → 101 nodes | ~99% |

As the cluster grows, even a single node addition forces nearly a complete reshuffle.

---

### A3. Downstream effect: cache miss flood

When keys remap, every cached key that moved to a new node is a cache miss on first access — the new node has no data yet.

```
Scenario: 10M cached keys, 80% remap on node addition
→ 8M simultaneous cache misses
→ All 8M requests fall through to the database
→ Database receives 8M unexpected queries in seconds
→ Database collapses → cascading outage
```

This is the "thundering herd" pattern. The cache was designed to absorb load, but the remapping event converts cache capacity into a concentrated DB attack.

---

### A4. Replication factor and mass remapping

| Replication Factor | Impact of Mass Remapping |
|---|---|
| RF=1 | Every remapped key is an immediate cache miss; no fallback |
| RF=3 | Remapped keys may exist on replica nodes temporarily, reducing miss severity |

With RF=1, every key that moves is completely unavailable until the new node is populated. With RF=3, at least one replica likely still holds the data during the transition window — but the write path is still disrupted and background rebalancing adds load. RF does not eliminate the mass movement problem, it only softens the read impact.

---

## Level 2 — The Hash Ring Mechanics

### A5. What is a consistent hash ring

A hash ring maps both **nodes** and **keys** onto the same circular hash space (0 to 2³²-1 is common). Each entity is hashed to a position on this ring.

```
hash("NodeA") = 10   → placed at position 10
hash("NodeB") = 120  → placed at position 120
hash("NodeC") = 230  → placed at position 230

Ring (0 → 359, wrapping):
  0 ... [10:A] ... [120:B] ... [230:C] ... 359 → back to 0
```

To find which node owns a key: hash the key, then **walk clockwise** on the ring until you hit a node. That node is the owner.

---

### A6. Clockwise routing on the ring

```
Nodes: A=10, B=120, C=230
Ring size: 0–359

hash(K) = 150 → walk clockwise from 150
  → next node clockwise: C at 230
  → Node C owns key K

hash(M) = 80  → walk clockwise from 80
  → next node clockwise: B at 120
  → Node B owns key M
```

| Key hash value | Walk clockwise finds | Owner |
|---|---|---|
| 5 | Node A at 10 | A |
| 80 | Node B at 120 | B |
| 150 | Node C at 230 | C |
| 240 | wraps around to Node A at 10 | A |

---

### A7. Impact of node D joining at position 180

```
Before: C at 230 owns keys 121–230 (from after B to C inclusive)
D joins at 180:

Keys 121–180 → moved from C to D
Keys 181–230 → remain with C

Fraction moved = (180 - 120) / 360 = 60/360 ≈ 16.7%
Expected disruption (1/N) = 1/4 = 25% → actual depends on node positions
```

Only Node C is affected — it surrenders part of its range to D. Nodes A and B are completely unaffected. This is the core advantage: disruption is bounded to adjacent neighbors, not the entire cluster.

---

### A8. Why circular (ring) rather than linear

A linear hash space from 0 to max has endpoints that create an edge problem: the node with the lowest position would "own" keys from 0 to its position, and the node at the highest position would own keys from max back to... nothing. The ring resolves this by wrapping — the last node's range wraps clockwise back to the first node, making the assignment uniform with no special cases.

```
Linear (broken): node at position max has no successor → key range undefined
Ring (correct):  node at position max → successor is the first node (position 0)
                 range wraps seamlessly
```

---

## Level 3 — Virtual Nodes

### A9. Distribution problem with 3 physical nodes

With 3 physical nodes hashed once each to random ring positions, the probability of even distribution is low:

```
Example (ring 0–359):
  NodeA = 5
  NodeB = 8
  NodeC = 190

Key ranges:
  NodeA: 191–5   (wrap-around) = 174 positions → 48% of ring
  NodeB: 6–8     = 3 positions  →  1% of ring
  NodeC: 9–190   = 182 positions → 51% of ring

NodeB is handling 1% of keys; NodeA and NodeC are handling ~50% each.
NodeB is massively underutilized. NodeA and NodeC are hot.
```

The smaller the cluster, the worse this statistical accident can be.

---

### A10. What virtual nodes are and how they fix it

Virtual nodes (vnodes) assign each physical node **multiple positions** on the ring instead of one.

```
Physical nodes: A, B, C
Virtual nodes per physical node: 4

Ring positions:
  A: hash("A-1")=10, hash("A-2")=95, hash("A-3")=200, hash("A-4")=310
  B: hash("B-1")=30, hash("B-2")=120, hash("B-3")=220, hash("B-4")=330
  C: hash("C-1")=60, hash("C-2")=150, hash("C-3")=245, hash("C-4")=350

Each physical node now owns multiple small, interleaved arcs instead of one large arc.
By the law of large numbers, with 150+ vnodes per node, the distribution approaches even.
```

If any one vnode arc is large, it's balanced by smaller arcs elsewhere on the same physical node.

---

### A11. 6 nodes × 256 vnodes: even distribution guarantee?

```
Total ring positions: 6 × 256 = 1,536
```

No, this does **not guarantee** perfectly even distribution. The 1,536 virtual positions are placed by hash function output — which is pseudo-random. With a good hash function and 256 vnodes, the distribution is statistically close to even (within ~10% variance), but not mathematically guaranteed.

The more vnodes per physical node, the tighter the statistical distribution. 256 is a pragmatic sweet spot between operational complexity and distribution quality. Cassandra moved from 1 token (original) → configurable vnodes → 256 default.

---

### A12. Tradeoff: high vnodes (500) vs low vnodes (10)

**Tradeoff: Distribution Accuracy vs Operational Overhead**

| Aspect | Low vnodes (10/node) | High vnodes (500/node) |
|---|---|---|
| Load distribution | Poor — high variance | Excellent — near-uniform |
| Memory per node | Low ring metadata overhead | Higher metadata (~500 token entries per node) |
| Rebalance on node join/leave | Fewer data transfers | Many small transfers — easier to parallelize but more coordination |
| Bootstrap time for new node | Faster (fewer ranges to stream) | Slower (500 range endpoints to populate) |
| Failure blast radius | Large (one node failure = large dead range) | Small (one node failure = many small ranges scattered) |

**Tradeoff: Failure Blast Radius vs Bootstrap Cost.** With 500 vnodes, a single node failure creates 500 small gaps distributed around the ring. Each gap is small and quickly covered by replicas. With 10 vnodes, a single node failure creates 10 larger gaps — each larger gap means more keys are served from a replica for longer.

---

## Level 4 — Ring Operations: Joins and Departures

### A13. Node join: step by step

```
Step 1 — Position selection:
  New node generates virtual node positions via: hash(node_id + "-" + vnode_index)
  Positions are announced to the cluster via gossip.

Step 2 — Identify key ranges to acquire:
  For each new vnode position P, find the current owner: the nearest existing clockwise node.
  New node will take over keys from [prev_clockwise_position + 1 ... P].

Step 3 — Data streaming (bootstrap):
  Current owner streams key-value data for the acquired range to the new node.
  This runs in the background; the old owner continues serving the range.

Step 4 — Traffic cutover:
  Once data transfer for a range is complete and verified (checksum match),
  the new node notifies the cluster: "I now own range [X, Y]."
  Ring state is updated via gossip propagation.
  New writes immediately route to the new node.
  Old owner stops serving that range.

Step 5 — Cleanup:
  Old owner deletes the transferred key range after a safety window
  (to allow stragglers and repair operations to complete).
```

---

### A14. Graceful node departure vs crash

**Graceful departure (planned maintenance):**
```
1. Node signals intent to leave (decommission)
2. For each of its vnodes, identify successor nodes (next clockwise)
3. Stream all data to successors proactively
4. Once complete, remove node from ring state
5. Successors take ownership of the ranges
```

**Crash departure (ungraceful):**
```
1. Gossip detects heartbeat failure → marks node "suspected dead"
2. After phi-accrual threshold, declares node dead
3. Ring is updated to remove the crashed node's positions
4. Successor nodes are now primary for those ranges
5. If replication factor > 1: successors already hold replica copies → serve immediately
6. If RF=1: data is unavailable until recovery (read repair or restore from backup)
```

| Aspect | Graceful | Crash |
|---|---|---|
| Data transfer | Proactive, owner streams to successor | None — successor takes over from replicas |
| Data availability | No interruption (parallel serve + transfer) | Depends on replication factor |
| Ring update | Immediate, coordinated | After failure detection timeout (10-30s typical) |
| Data loss risk | None | Possible if RF=1 and no backup |

---

### A15. Reads and writes to a crashed node's range

```
Without replication (RF=1):
  - Read requests: return error or stale cached response
  - Write requests: blocked or queued until recovery
  - Data is unavailable for the failure duration

With replication (RF=3):
  - Replica nodes (next 2 clockwise) hold copies of the data
  - Read requests: routed to replica nodes → served normally
  - Write requests: coordinator routes to available replicas
  - If W=2: writes succeed even with one node down (2 of 3 replicas are available)
  - Once dead node recovers: read repair or anti-entropy reconciles missing writes
```

**Tradeoff: Availability vs Consistency During Failure.** With sloppy quorum (W+R < N), writes can succeed to substitute nodes during the failure, improving availability. But the recovered node may miss those writes until hinted handoff delivers them. This is the CAP tradeoff materialized: Cassandra/Dynamo choose availability over strict consistency during network partitions.

---

### A16. In-flight requests during ring rebalance

During data transfer, a key range is in transition. If a request arrives at the old owner after ownership has been transferred, and at the new owner before data is fully loaded, both can produce wrong results.

**Recommended approach — two-phase ownership:**
```
Phase 1 (transfer in progress):
  - Old owner: still authoritative, accepts reads and writes, streams data to new owner
  - New owner: shadow mode — receives writes but does not yet serve reads

Phase 2 (transfer complete):
  - Ring state updated: new owner is now authoritative
  - Old owner: forwards any requests it still receives to new owner for a grace window
  - New owner: starts serving reads

Writes during transfer are sent to BOTH nodes (dual-write window):
  - Ensures new owner has all writes even if transfer overlaps with incoming mutations
```

---

## Level 5 — Replication on the Ring

### A17. Preference list and replication

To replicate data, each key is owned by a **preference list**: the primary node plus the next N-1 distinct physical nodes clockwise on the ring.

```
Ring positions: A=10, vA2=50, B=80, vB2=140, C=190, vC2=260
Key K → primary node B (at 80)
Replication factor N=3
Preference list for K: [B, vB2 (skip — same physical as B), C, A]
                     = [B, C, A] (3 distinct physical nodes)
```

Virtual node duplicates from the same physical machine are skipped to ensure the data is on 3 different physical servers, not 3 virtual tokens on the same machine.

---

### A18. Quorum consistency condition

**Condition: W + R > N**

```
N = replication factor (total copies)
W = minimum replicas that must acknowledge a write before success is returned
R = minimum replicas that must respond to a read before result is returned

Strong consistency requires: W + R > N
  → At least one node overlaps between the write set and the read set
  → That overlapping node has the latest write → reads always see the latest value

Example with N=3:
  (W=2, R=2): W+R=4 > 3 ✅ Strong consistency
  (W=3, R=1): W+R=4 > 3 ✅ Strong consistency (but write latency is high)
  (W=1, R=2): W+R=3 = 3 ✗ NOT strong (no guaranteed overlap)
  (W=1, R=1): W+R=2 < 3 ✗ NOT strong (eventual consistency only)
```

| W | R | W+R | Consistency | Use case |
|---|---|---|---|---|
| 2 | 2 | 4 | Strong | General purpose |
| 3 | 1 | 4 | Strong | Write-heavy, fast reads |
| 1 | 3 | 4 | Strong | Read-heavy, slow writes |
| 1 | 1 | 2 | Eventual | High throughput, tolerate stale reads |

---

### A19. Sloppy quorum

A **sloppy quorum** allows the coordinator to count writes to *substitute* nodes (not in the key's normal preference list) toward the write quorum when the normal nodes are unavailable.

```
Normal preference list for key K: [A, B, C]
Node B is down.

Strict quorum (W=2): must wait for B to recover. Write blocked.

Sloppy quorum (W=2): write to A and D (D is not in K's preference list but is available).
  → Write succeeds immediately.
  → D stores the write with a hint: "this belongs to B, deliver when B recovers."
```

**Tradeoff: Availability vs Strict Consistency.** Sloppy quorum sacrifices the guarantee that the write is on the correct preference list nodes. During the window where B is down and D holds the hint, a strict quorum read to [A, C] might miss the value that was written to D. This is an explicit availability-over-consistency choice — the DynamoDB/Cassandra model.

---

### A20. Hinted handoff

When a coordinator writes to a substitute node D (due to sloppy quorum), D stores the value alongside a **hint** — metadata saying the data belongs to node B.

```json
{
  "key": "user:42",
  "value": "...",
  "hint": {
    "intended_node": "NodeB",
    "written_at": "2024-01-15T10:30:00Z"
  }
}
```

When NodeB recovers and rejoins the ring:
1. NodeD detects NodeB is alive (via gossip)
2. NodeD delivers the hinted writes to NodeB
3. NodeB integrates the data (last-write-wins or version vector merge)
4. NodeD deletes the local hint copies

If NodeB never recovers: the hints are held for a configurable window (e.g., 3 hours in Cassandra), then dropped. If durability requires it, anti-entropy (Merkle tree reconciliation) can catch the gap during repair.

---

## Level 6 — Real Systems

### A21. Cassandra tokens

In Cassandra, each virtual node is assigned a **token**: a 64-bit integer that represents its position on the hash ring (called the "token ring"). The default hash function is Murmur3.

```
cassandra.yaml:
  num_tokens: 256          # virtual nodes per physical node
  partitioner: Murmur3Partitioner

Example token assignment for a 3-node cluster with num_tokens=4:
  Node1: tokens [-9223372036854775808, -4611686018427387904, 0, 4611686018427387904]
  Node2: tokens [-6917529027641081856, -2305843009213693952, 2305843009213693952, 6917529027641081856]
  Node3: tokens [-3074457345618258602, 1537228672809129301, 3074457345618258602, 7686143364045646507]
```

Cassandra automatically assigns tokens evenly when `num_tokens > 1`. Historically (Cassandra 1.x), operators hand-calculated tokens — a painful process that vnodes eliminated.

**Company reference:** Cassandra was open-sourced by Facebook in 2008 and later became an Apache project. Instagram ran Cassandra at massive scale for their activity feeds. The token ring is how they scaled writes to billions of users without a master coordinator.

---

### A22. DynamoDB and the Dynamo paper

Amazon's 2007 Dynamo paper is the source document for many of these concepts. Key failure-handling mechanisms:

```
Challenge: A node fails. Its key range must remain available.

Dynamo's solution — combination of:

1. Sloppy quorum: writes redirect to alternate nodes during failure.
   → Availability maintained; data still written somewhere durable.

2. Hinted handoff: substitute node stores hints for the failed node.
   → Once failed node recovers, it receives the missed writes.

3. Anti-entropy via Merkle trees: background process compares
   data between replicas and repairs divergence.
   → Eventual consistency is achieved even after extended failures.

4. Vector clocks for conflict resolution: each version of a value
   carries a vector clock [nodeId: version] to detect and reconcile
   concurrent writes.
```

**Tradeoff: Availability vs Strict Consistency (the Dynamo Choice).** Amazon explicitly chose availability over consistency for Dynamo. The shopping cart must never fail to add an item even if a node is down. Occasional divergent versions (two users added items to the same cart in a partition) are resolved at read time by returning both versions and asking the application to reconcile. This is the CAP theorem made concrete.

---

### A23. Redis Cluster — hash slots, not a ring

Redis Cluster does not use a continuous hash ring. It uses **16,384 hash slots**:

```
key → CRC16(key) % 16384 → slot number (0–16383)

Each node owns a contiguous range of slots:
  Node1: slots 0–5460
  Node2: slots 5461–10922
  Node3: slots 10923–16383
```

**Why 16,384 and not a ring?**

| Feature | Traditional Ring | Redis Cluster Hash Slots |
|---|---|---|
| Slot assignment | Continuous, fraction-based | Discrete, fixed 16,384 slots |
| Node rebalancing | Move fraction of key range | Migrate specific slot sets |
| Configuration overhead | Low (automatic positions) | Explicit slot assignment |
| Cluster size | Scales to hundreds of nodes | Practical max ~1,000 nodes (gossip payload limit) |
| Cluster state size | Proportional to vnodes | Fixed ~8KB regardless of key count |

**Tradeoff: Operational Explicitness vs Automatic Rebalancing.** Redis Cluster's hash slots give operators explicit control over which data lives where. Moving slot 5000 from Node1 to Node2 is a concrete, auditable operation. In a Cassandra ring, token reassignment is implicit and harder to predict. Redis chose explicitness because its primary use case (cache + session store) demands operational predictability over fully automated rebalancing.

---

### A24. CDN routing with consistent hashing

Akamai and other CDN providers use consistent hashing to map incoming HTTP requests (by URL or cache key) to specific edge servers:

```
Incoming request URL: https://cdn.example.com/images/logo.png
Cache key: hash("/images/logo.png") → position 183 on ring
Ring contains: EdgeServer1=20, EdgeServer2=95, EdgeServer3=200, ...
→ Route request to EdgeServer3 (nearest clockwise from 183)
```

**Why consistent hashing is valuable here:**

```
Traditional round-robin or random: same URL may go to Edge1 one request, Edge4 the next.
→ No cache affinity → every edge server caches every URL separately → cache duplication

Consistent hashing: same URL always goes to the same edge server (unless topology changes).
→ Cache affinity → that server accumulates the cached file → cache hit rate much higher
→ When an edge server is added/removed: only its URL range is affected
```

**CDN-specific concern:** Consistent hashing provides cache affinity for reads. For writes (cache invalidation), all edge servers holding the content must be invalidated — CDNs use a separate invalidation broadcast mechanism, not the ring.

---

## Level 7 — Failure Modes and Edge Cases

### A25. Why consistent hashing does not solve hot keys

Consistent hashing distributes **keys** evenly across nodes. But if one key receives 10,000 requests/sec while all others receive 10 requests/sec, that one key's node is still overwhelmed regardless of ring topology.

```
Example: celebrity user_id=1 is mentioned in 1M posts in 1 hour.
hash("user:1") → Node C handles all 1M cache lookups.
Consistent hashing has no mechanism to distribute load for a single key.
```

| Problem | What Consistent Hashing Fixes | What It Does Not Fix |
|---|---|---|
| Key distribution | Spreads key space evenly | Uneven access frequency per key |
| Node imbalance | Vnodes ensure roughly equal key counts | One popular key can still overload a node |
| Hotspot from topology | Random positions avoid systematic hot spots | Access pattern hot spots are independent |

**Tradeoff: Key Distribution vs Access Pattern Distribution.** Consistent hashing solves structural distribution. Hot keys require a separate strategy: read replicas for that specific key, a local in-process cache layer, or key splitting (shard the hot key itself into K sub-keys with a suffix: `user:1:shard:3`).

---

### A26. Heterogeneous nodes and weighted virtual nodes

If a 32GB node and a 128GB node both have 256 vnodes, they serve equal fractions of the key space — but the 32GB node will be overloaded and the 128GB node will be underutilized.

```
Solution: assign virtual nodes proportional to capacity.

32GB node:  128 vnodes  (1x weight)
128GB node: 512 vnodes  (4x weight)

Resulting key distribution:
  32GB node:  128 / (128+512) = 20% of keys
  128GB node: 512 / (128+512) = 80% of keys
```

This matches the relative memory capacity (1:4 ratio). Cassandra supports this via the `cassandra.yaml` `initial_token` override or through the `allocate_tokens_for_keyspace` option.

---

### A27. Ring oscillation

Ring oscillation occurs when a node repeatedly joins and leaves the ring in rapid succession, causing the cluster to continuously rebalance:

```
Timeline:
  T=0:  NodeB declared dead (gossip timeout)
  T=5s: Ring rebalances → NodeC takes NodeB's key ranges + streams data
  T=8s: NodeB comes back online (was temporarily partitioned)
  T=8s: NodeB rejoins → Ring rebalances again → NodeB reclaims its ranges
  T=9s: NodeB disappears again (flapping)
  ...
```

Each oscillation triggers data streaming, gossip propagation, and cluster state changes — burning CPU, network bandwidth, and coordinator capacity. Detection is hard because each individual event looks like a normal join/leave.

**Tradeoff: Fast Recovery vs Oscillation Stability.** Shorter gossip failure detection timeouts recover faster from genuine failures but trigger oscillation more easily with flapping nodes. Cassandra's phi accrual failure detector addresses this by using a continuous score rather than a binary up/down threshold — a node must be consistently unresponsive before being declared dead.

---

### A28. Biased hash function: symptoms and detection

```
Normal distribution: keys scattered uniformly 0–359 on ring
Biased distribution: 70% of keys hash to positions 0–110 (one arc)

Observable symptoms:
  1. One or two nodes consistently have 3–5x higher memory usage than others
     (those nodes own the dense arc of the ring)
  2. One or two nodes have 3–5x higher request rate than others
     (hot nodes receive disproportionate key count AND request count)

Detection methods:
  1. Plot token-to-token distribution: each node should own ~(1/N * 100)% of the ring.
     A biased hash shows one node owning 40–60% while others own <10%.
  2. Monitor per-node key count and request rate. Ratio > 2x between nodes
     with same vnode count signals a distribution problem.
```

**Fix:** Replace the hash function (Murmur3 and xxHash have excellent uniformity; MD5 and CRC32 are weaker). If changing the hash function, all keys must be remapped — treat it as a full migration.

---

## Level 8 — Architect-Level Tradeoffs

### A29. Consistent hashing vs range-based sharding

**Tradeoff: Random Distribution vs Ordered Access**

| Feature | Consistent Hashing | Range-Based Sharding |
|---|---|---|
| Data distribution | Random (uniform) | Ordered (by key range) |
| Range queries | Not efficient (keys scattered) | Efficient (keys in shard are adjacent) |
| Hotspot resistance | Strong (random placement avoids sequential hot spots) | Weak (sequential keys → one shard gets all writes) |
| Rebalance complexity | Automatic via vnodes | Manual or semi-automatic split/merge |
| Use case fit | Key-value, cache, session store | Time-series, sorted data, range scans |

**Choose consistent hashing when:** you need to look up individual keys by ID with no range queries (user profile cache, session store, DynamoDB key-value access).

**Choose range-based sharding when:** you need to scan a range of keys (time-series queries, leaderboard scans, ordered message logs). HBase, Bigtable, CockroachDB, and Spanner use range-based sharding for exactly this reason.

---

### A30. Jump consistent hash

Jump consistent hash (Google, 2014) is a minimal perfect hash function that maps a key to a bucket (node index) in O(1) time and O(1) space:

```python
def jump_consistent_hash(key: int, num_buckets: int) -> int:
    b, j = -1, 0
    while j < num_buckets:
        b = j
        key = ((key * 2862933555777941757) + 1) & 0xFFFFFFFFFFFFFFFF
        j = int((b + 1) * (1 << 31) / ((key >> 33) + 1))
    return b
```

| Property | Ring-Based Consistent Hashing | Jump Consistent Hash |
|---|---|---|
| Time complexity | O(log n) for lookup (binary search on ring) | O(log n) iterations but O(1) in practice |
| Space complexity | O(n × vnodes) for ring structure | O(1) — no ring structure stored |
| Node removal | Supported (clockwise successor takes over) | **Not supported** — nodes must be removed from the end only |
| Arbitrary node weights | Supported via vnode count | Not supported |
| Best use case | General distributed storage with any join/leave | Stateless routing where nodes are added/removed by index only |

**Key limitation:** Jump consistent hash requires that buckets be numbered 0 to N-1 and that removals happen at the end (node N-1 is removed, not arbitrary nodes). This makes it unsuitable for systems where specific nodes fail (you can't control which index fails).

---

### A31. Zero-downtime migration from modulo to consistent hashing

```
Phase 1 — Dual-read setup (shadow mode):
  1. Deploy code that knows BOTH the old (modulo) and new (consistent hash) node addresses.
  2. All reads: try consistent hash node first. On miss, fall back to modulo node.
  3. All writes: write to BOTH systems simultaneously (dual-write).
  Duration: run for TTL + buffer to let old cache entries expire naturally.

Phase 2 — Consistent hash takes over:
  4. Disable modulo fallback reads (consistent hash is now fully populated).
  5. Disable dual-writes (write to consistent hash only).

Phase 3 — Cleanup:
  6. Decommission old modulo-based routing code.
  7. Old nodes can be repurposed or decommissioned.
```

**Key risk:** During Phase 1, a write goes to both systems but a read hits the consistent hash node (which may not have old data yet). The modulo fallback handles this. Any key that has been read at least once will be populated in the new system.

---

### A32. Three follow-up questions when "shard by user_id" is proposed

```
1. "What is the access pattern — read-heavy, write-heavy, or both?"
   → Determines if you need read replicas, quorum configuration, and consistency level.

2. "Do you need range queries or only point lookups by user_id?"
   → Point lookups: consistent hashing is a great fit.
   → Range queries (give me all users created between X and Y): use range-based sharding.

3. "What is your resharding strategy — will the cluster grow, and how?"
   → If adding nodes is infrequent and planned: consistent hashing handles it gracefully.
   → If the cluster is fixed-size and never changes: even modulo hashing is fine.
   → If the cluster grows non-uniformly (some nodes replaced by larger machines): 
     weighted virtual nodes need to be in the design.
```

---

## Bonus — Senior Questions

### AB1. 100x hot user_id

Consistent hashing cannot help here — all `user:1` requests are intentionally on one node. Options:

```
Option 1: In-process cache layer (L1 cache before Redis/Memcached)
  Each API server holds a local LRU cache for the hottest keys.
  user:1's data is served from memory on the API server itself.
  Cache invalidation: TTL-based (1-5 seconds acceptable for a hot user profile).

Option 2: Key splitting / sharding the hot key
  user:1 → split into user:1:shard:0, user:1:shard:1, ... user:1:shard:9
  Write fan-out: writes go to all shards.
  Read fan-out: reads pick a shard at random (or by request_id % 10).
  Distributes the read load across 10 nodes.

Option 3: Read replica for that specific key
  Dedicate 2–3 cache nodes as read replicas for identified hot keys.
  Coordinator routes hot key reads round-robin across replicas.
```

| Option | Write overhead | Read distribution | Staleness |
|---|---|---|---|
| L1 local cache | None | Per-server (good) | Up to TTL |
| Key splitting | Fan-out to N shards | Across N nodes | Consistent |
| Dedicated replicas | Replicate to N replicas | Across N nodes | Replication lag |

---

### AB2. Single key exceeds one node's capacity

No sharding technique can store a single key across multiple nodes in a standard key-value model. Options require changing the data model:

```
Option 1: Decompose the value
  Instead of one large value, split the value into chunks stored under separate keys.
  user:1:profile:page:0, user:1:profile:page:1, ...
  Read: fetch and assemble all pages.

Option 2: Use a DB natively designed for large values
  Redis supports string values up to 512MB; Cassandra supports blobs.
  But the hot key problem still applies to the node owning that key.

Option 3: Move large values to blob storage (S3/GCS)
  The cache key stores only a pointer (URL/metadata) to the blob.
  Large data is served from CDN/object storage, not the cache node.
  This is the standard pattern for large objects (images, documents).
```

---

### AB3. Increasing replication factor from 2 to 3

```
Step 1 — Update RF in cluster configuration:
  ALTER KEYSPACE mykeyspace WITH REPLICATION = {'class': 'NetworkTopologyStrategy', 'dc1': 3};

Step 2 — Run nodetool repair:
  This triggers Cassandra's anti-entropy mechanism to stream the missing 3rd replica.
  Run repair on each node: nodetool repair mykeyspace

Step 3 — Verify replication:
  Monitor streaming progress in nodetool tpstats and system logs.
  Confirm each node shows 3 replicas for a test key.

Risks:
  - Repair generates heavy streaming traffic → run during low-traffic window
  - If a node fails during repair: those key ranges temporarily have only 1 copy
  - Do not do this during a peak traffic period
```

---

### AB4. Cache vs database sharding with consistent hashing

| Aspect | Cache (Memcached, Redis) | Database (Cassandra, DynamoDB) |
|---|---|---|
| On node failure | Data loss acceptable (cache miss, DB fallback) | Data loss not acceptable → replication is mandatory |
| Replication factor | Often 1 (cache is ephemeral) | 3+ (data is durable) |
| On ring rebalance | Keys are simply missing until repopulated | Data must be streamed before new node serves traffic |
| Quorum | Not applicable (single copy, no quorum) | W + R > N required for consistency |
| Hot key impact | Cache miss → DB hit → refill | Hot key → node overload → cascading writes |

The fundamental difference: cache data loss is recoverable (fetch from the source and refill). Database data loss is potentially permanent. This makes replication factor, quorum, and repair essential for databases but optional for caches.

---

## Algorithm Decision Guide — Quick Reference

### Which Sharding Approach?

| Situation | Best Choice | Reason |
|---|---|---|
| Point lookups by key ID | Consistent hashing | Uniform distribution, O(log n) lookup |
| Range queries (time-series, sorted data) | Range-based sharding | Adjacent keys on same shard, efficient scans |
| Fixed cluster size | Modulo hashing | Simpler, zero overhead |
| Cluster grows frequently | Consistent hashing + vnodes | Minimal disruption on every topology change |
| Heterogeneous hardware | Consistent hashing with weighted vnodes | Match load to node capacity |
| Stateless routing, no arbitrary node removal | Jump consistent hash | O(1) space, no ring metadata |

### Which Quorum Configuration (N, W, R)?

| Use Case | Configuration | Tradeoff |
|---|---|---|
| Strong consistency, general | N=3, W=2, R=2 | Balanced latency and durability |
| Write-heavy, fast reads | N=3, W=2, R=1 | Fast reads, 2-node write ack |
| Read-heavy, slow writes tolerable | N=3, W=3, R=1 | Maximum read speed, slow writes |
| Maximum availability (eventual) | N=3, W=1, R=1 | Best availability, no consistency |
| Latency-critical, tolerate stale reads | N=3, W=1, R=2 | Fast writes, near-consistent reads |

### Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Modulo hashing failure | (N-1)/N keys remapped on every node change → thundering herd |
| Hash ring fix | hash both keys and nodes to same space; clockwise routing → only 1/N keys move |
| Virtual nodes purpose | Multiple ring positions per physical node → statistical load balance |
| Cassandra default vnodes | 256 per node; Murmur3 hash function |
| 1/N disruption guarantee | Only keys in the new node's clockwise predecessor range move |
| Preference list | Primary node + next N-1 distinct physical nodes clockwise |
| Quorum condition | W + R > N guarantees strong consistency |
| Sloppy quorum | Write to substitute node when preferred node is down → higher availability |
| Hinted handoff | Substitute node holds hint until original recovers and delivers it |
| Redis Cluster difference | 16,384 hash slots, not a ring; explicit slot assignment per node |
| Jump consistent hash | O(1) space; no arbitrary node removal |
| Range vs hash sharding | Hash = uniform distribution; Range = ordered access for scans |
| Hot key fix | L1 local cache + key splitting (user:1:shard:N) |
| Weighted vnodes | More vnodes on larger nodes to proportionally assign key range |
| Ring oscillation | Flapping node causes repeated rebalances; phi accrual detector mitigates it |
| Biased hash detection | Check per-node key count ratio; ratio > 2x with same vnode count = bias |
| Failure without RF | Dead node's keys are unavailable; cache miss → DB fallback; database = data loss |
| CF vs RF=3 crash behavior | Cache: miss and refill. DB: replicas take over, repair on recovery |
| Migration strategy | Dual-read + dual-write during transition window; disable fallback after TTL |
