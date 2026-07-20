# Answers: Distributed Key-Value Store (Dynamo-Style)

> Keyed to [questions.md](./questions.md). Read questions first — attempt each before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on decisions that matter.
> Code is illustrative pseudocode (TypeScript/Python/Go-flavored) — logically correct, not tied to a specific library API.

---

## Level 1 — Requirements & API

### A1. What a KV store is, and what you trade away

A key-value store is a database whose entire data model is a dictionary: an opaque `key` maps to an opaque `value`, and the only first-class operations are "put this value under this key" and "get the value for this key." Because the store never has to understand the value's internals, it can partition, replicate, and cache purely on the key.

What you give up versus a relational database:

| Capability | Relational DB | Dynamo-style KV Store |
|---|---|---|
| Point lookup by primary key | Yes | Yes (this is the whole point) |
| Range / secondary-index queries | Yes | No (keys are hashed and scattered) |
| Joins across entities | Yes | No — denormalize into the value |
| Multi-key ACID transactions | Yes | No (or very limited) |
| Horizontal scale to 1000s of nodes | Hard | Native |
| Availability during partition | Usually CP (may reject writes) | AP (stays writable) |

**Tradeoff: Query Flexibility vs Horizontal Scale.** You surrender ad-hoc queries and cross-key transactions in exchange for near-linear scale-out and predictable single-key latency. If the workload is "fetch the object for this ID," this is a great deal; if it's "find all orders over $100 last week," it is the wrong tool (see A32).

---

### A2. The `get` / `put` contract under partitions

```
put(key: bytes, value: bytes, context?: Context) -> PutResult
  PutResult = { success: bool, version: VersionToken }
  // version is the vector clock / timestamp the write was tagged with

get(key: bytes) -> GetResult
  GetResult = { values: Value[], context: Context }
  // NOTE: values is a LIST, not a single value
```

The non-obvious part is that `get` returns a **list** of values plus a **context** (an opaque version token), not a single value. In a system that stays available during partitions, two clients can concurrently write the same key on either side of a partition. When the partition heals, both versions survive as **siblings** (A19). The client passes the returned `context` back on its next `put`, which lets the store record causality and collapse the versions it now supersedes.

**Error semantics:** `put` can return success once W replicas ack (A13), timeout, or "quorum not met." `get` can return success with one value, success with multiple siblings, or "not found." Crucially, a `put` timeout is *ambiguous* — the write may or may not have landed on some replicas. Clients must treat writes as idempotent (same key + version) to retry safely.

---

### A3. The three requirements that reshape the architecture

```
1. Consistency requirement  → sets W, R, and conflict-resolution strategy
2. Availability target       → decides AP vs CP and whether sloppy quorum is on
3. Access pattern & size      → decides partitioning key and node count
```

| Requirement you pin down | If the answer is X | Architectural consequence |
|---|---|---|
| "Can a read ever be stale?" | No → strong | W+R>N, higher latency, maybe reject on partition |
| "Can a read ever be stale?" | Yes → eventual | W=R=1, lowest latency, siblings possible |
| "Must writes succeed during an outage?" | Yes (99.9%+) | AP model, sloppy quorum + hinted handoff |
| "Any range or list queries?" | Yes | KV store is wrong; reconsider (A32) |
| "How big / how hot?" | Billions of keys, 1M ops/s | Node count and vnode math (A31) |

**Why 99.9% matters concretely:** 99.9% availability = ~8.77 hours of allowed downtime per year (0.1% × 8,766 hours/year). 99.99% = ~52.6 minutes/year; 99.999% = ~5.26 minutes/year. Each extra nine roughly 10x's the engineering cost, so pin the real target — do not over-build for five nines when the SLA is three.

---

### A4. Where single-Postgres breaks

```
Single Postgres with PRIMARY KEY (key), value BYTEA:

Fine until roughly:
  - Working set exceeds RAM  → cache miss rate climbs, read p99 degrades
  - Write throughput exceeds one machine's WAL fsync + disk  → WRITES fail first
  - Data exceeds one disk / one node's storage  → hard ceiling
```

Writes break first in most scaling stories: a single primary serializes all writes through one WAL and one fsync path. You can add read replicas to scale reads, but a single-leader relational database has exactly one write node. Storage is the hard ceiling (one machine's disks), and reads degrade gracefully (cache misses) before either.

**Tradeoff: Vertical vs Horizontal Scale.** Postgres scales *up* (bigger box) beautifully and is the right first choice for most systems. A Dynamo-style store scales *out* (more boxes) and is justified only once you've outgrown the biggest single box or need availability guarantees a single leader can't give. Real systems: Amazon moved the shopping cart off a relational core precisely because a single write leader couldn't meet the availability target during peak/partition (Dynamo paper, DeCandia et al., 2007).

---

## Level 2 — Partitioning

### A5. Deciding which node owns a key

Use **consistent hashing with virtual nodes** — hash both keys and node tokens onto the same ring, and a key belongs to the first node found walking clockwise from `hash(key)`. See [consistent hashing](../consistent-hashing/README.md) for full mechanics.

The one-sentence reason it beats `hash(key) % N`: modulo hashing remaps ~(N−1)/N of all keys whenever the node count changes, whereas consistent hashing moves only ~1/N keys — the keys in the joining/leaving node's arc.

| Approach | Keys moved when a node joins | Fit for a growing KV cluster |
|---|---|---|
| `hash(key) % N` | ~(N−1)/N (≈80–99%) | Terrible — every scale-out reshuffles everything |
| Consistent hashing + vnodes | ~1/N | Native — designed for exactly this |

**Real systems:** Cassandra, Riak, Voldemort, and DynamoDB all use consistent hashing internally. Cassandra calls ring positions "tokens" and defaults to 256 vnodes per node with the Murmur3 partitioner.

---

### A6. The coordinator and request routing

Any node can receive any request; the node that receives it acts as the **coordinator** for that request. It does not need to own the key.

```
Client → PUT key=user:42, value=V   (lands on Node C, chosen by client's load balancer)

Coordinator (Node C):
  1. pos = hash("user:42")
  2. prefList = preferenceList(pos, N=3)      // e.g. [A, D, F] via the ring
  3. tag V with a version (vector clock or timestamp)
  4. fan out Put(user:42, V, version) to A, D, F in parallel
  5. wait for W acks (A13), then ack the client
```

Two coordinator models exist:

| Model | How the coordinator is chosen | Used by |
|---|---|---|
| Any-node / server-side | Client hits any node; that node forwards to the preference list | Cassandra (any node coordinates), classic Dynamo |
| Client-driven / partition-aware | A smart client library computes the ring locally and hits a replica directly (saves one hop) | Cassandra `TokenAwarePolicy`, Dynamo's "partition-aware client" |

**Tradeoff: Extra Hop vs Client Complexity.** A dumb client that hits a random coordinator is simple but pays one extra network hop when that coordinator isn't a replica. A token-aware client removes the hop but must track ring membership (via gossip metadata), coupling client and cluster topology.

---

### A7. Why virtual nodes matter for a KV store

Without vnodes, each physical node is one point on the ring, so three nodes rarely split the ring evenly — one node can own 50% of keys by random placement. Vnodes give each physical node many small, scattered arcs, so by the law of large numbers every node ends up owning roughly the same fraction of keys and, just as importantly, when a node dies its load is redistributed across *many* neighbors instead of dumped entirely on its one clockwise successor.

```
Node failure blast radius:
  1 token per node:   Node B dies → all of B's range floods onto Node C (2x load spike on C)
  256 vnodes per node: Node B dies → B's 256 small ranges spread across ~all peers (each +~1/N)
```

**Tradeoff: Distribution Quality vs Bootstrap/Metadata Cost.** More vnodes → smoother load and smaller blast radius, but more ring metadata and more streaming connections when a node joins. Cassandra's 256 default balances these; details in [consistent hashing](../consistent-hashing/README.md).

---

### A8. The hot-partition problem

Consistent hashing balances the *number of keys* per node, but a KV store's load is `keys × access_frequency`. If one key or one narrow key range gets 50x the traffic, its owning node is overwhelmed even though it holds an average key count. This is a **hot partition** (or **hot key**).

```
Balanced by consistent hashing:   key COUNT per node ≈ equal
NOT balanced:                      REQUESTS per node (depends on access pattern)

Example: partition key = "date". All of today's writes hash to one partition
→ that one node saturates while yesterday's partition is idle.
```

| Cause of hot partition | Fix |
|---|---|
| One naturally popular key (celebrity, global config) | Replicate/cache that key wider; client-side L1 cache (QB2) |
| Monotonic/sequential partition key (timestamp, auto-id) | Add a random or hashed prefix: `shard(0..K) + key` |
| Low-cardinality partition key (e.g., `country`) | Composite key with higher-cardinality suffix |

**Real incident:** AWS has publicly documented DynamoDB customers using a date as the partition key, sending all "today" writes to one partition until it throttled at the per-partition write limit. Fix: a composite key spreading writes across K shards. Full treatment in [consistent hashing](../consistent-hashing/README.md#13-hot-keys-and-weighted-nodes).

---

## Level 3 — Replication

### A9. The preference list

The **preference list** for a key is the ordered set of the first N *distinct physical nodes* encountered walking clockwise on the ring from the key's position. The first is the primary; the rest are replicas.

```python
def preference_list(key, ring, N):
    pos = hash(key)
    result, seen_physical = [], set()
    idx = ring.first_index_clockwise_from(pos)
    while len(result) < N:
        node = ring.physical_node_at(idx)
        if node not in seen_physical:          # skip vnodes of an already-included machine
            result.append(node)
            seen_physical.add(node)
        idx = (idx + 1) % ring.size
    return result
# key "user:42", N=3  →  [NodeA, NodeD, NodeF]
```

**Why skip same-machine vnodes:** if NodeA owns 256 vnodes, the next few clockwise positions may all be NodeA. Counting them would put "3 replicas" on 1 physical box — zero fault tolerance. Skipping guarantees N *distinct machines*. Production preference lists also skip to distinct *racks/datacenters* (A11).

**Real systems:** This is the Dynamo paper's preference list; Cassandra implements the same idea via replication strategy walking the token ring and skipping to distinct racks/DCs.

---

### A10. Synchronous vs asynchronous replication

```
Synchronous:  coordinator waits for replicas to durably ack BEFORE acking client
Asynchronous: coordinator acks client after local write; replicas catch up in background
```

| Dimension | Synchronous (wait for W) | Asynchronous (fire-and-forget) |
|---|---|---|
| Write latency | Higher (slowest of W replicas) | Lowest (one local write) |
| Durability on coordinator crash | Strong (W copies exist) | Weak (may be the only copy) |
| Consistency of a following read | Can be strong (W+R>N) | Eventual only |
| Availability during replica outage | Good if W < N | Best |

In a Dynamo-style store this isn't binary — the **quorum parameter W** is the dial. `W=1` is effectively async (ack after the coordinator's own write, replicate the rest lazily). `W=N` is fully synchronous. `W=2, N=3` is the common middle ground: wait for two durable copies, let the third catch up.

**Tradeoff: Latency vs Durability.** Every replica you wait for adds a copy (safer) but also adds latency equal to that replica's response time. You pay the slowest of the W you wait for — which is exactly why you wait for W and not N (A30). Cassandra exposes this as consistency levels (`ONE`, `QUORUM`, `ALL`).

---

### A11. Multi-datacenter replica placement

Place the N replicas so no single datacenter (or rack) failure loses data or blocks the write quorum.

```
Bad:  N=3 all in DC1        → DC1 dies → total data loss
Good: N=3 as 2 in DC1, 1 in DC2   → survives losing either DC (with care on quorum)
Best for 2-DC durability: RF=3 PER DC (6 copies total), use LOCAL_QUORUM
```

| Strategy | Replica placement | Survives DC loss? | Write latency |
|---|---|---|---|
| Naive (SimpleStrategy) | Next N nodes clockwise, DC-blind | Maybe not | Low |
| Per-DC replication (NetworkTopologyStrategy) | RF replicas in *each* DC, skipping to distinct racks | Yes | `LOCAL_QUORUM` keeps it low |

The preference-list walk is extended: when picking the N nodes, skip forward to nodes in distinct racks/DCs so replicas never share a failure domain. Reads/writes then use **`LOCAL_QUORUM`** — a quorum *within the local DC* — so cross-DC latency (tens to ~100+ ms) doesn't sit in the request path, while async cross-DC replication keeps the remote copy fresh.

**Real systems:** Cassandra's `NetworkTopologyStrategy` + `LOCAL_QUORUM` is the production standard for this. DynamoDB Global Tables replicate across regions with last-write-wins reconciliation.

---

### A12. Coordinator crash after client ack

```
put(user:42) → coordinator writes locally, acks client at W=2 (A + D acked), then crashes
                before replica F receives it.

Possible states right after:
  Node A: has V   (acked)
  Node D: has V   (acked)
  Node F: missing V
```

The data is safe — W=2 copies exist, which is why we required durable acks before telling the client "success." Convergence to all three replicas happens through three overlapping mechanisms:

```
1. Hinted handoff (A16): if F was down, whoever held F's hint replays it when F returns.
2. Read repair (A21):    a later read that touches F detects it's stale and pushes V to it.
3. Anti-entropy (A22):   periodic Merkle-tree comparison finds and repairs the gap.
```

**Tradeoff: Acknowledged ≠ Fully Replicated.** Acking at W means the client's "success" guarantees W durable copies, not N. The gap between W and N is closed asynchronously. This is safe for reads *iff* R is set so `W+R>N` (A13); otherwise a read hitting only {D, F} could return stale/absent data until repair catches up. Real systems accept this window explicitly — it's the eventual-consistency contract.

---

## Level 4 — Tunable Consistency & Quorums

### A13. The quorum condition

**Strong consistency requires `W + R > N`.**

```
N = number of replicas (preference list size)
W = replicas that must ack a write before it's "successful"
R = replicas that must respond to a read before it returns

Why W + R > N works:
  A write touches W replicas. A read touches R replicas.
  If W + R > N, the write-set and read-set MUST overlap in ≥1 replica (pigeonhole).
  That overlapping replica holds the latest write → the read is guaranteed to see it.
```

The overlap is the entire trick: pigeonhole guarantees at least one node is in both the last write's quorum and this read's quorum, so a correct read (taking the highest version among the R it sees) cannot miss the latest committed write.

**Real systems:** This is the R+W>N rule from the Dynamo paper (DeCandia et al., 2007), the same math Cassandra's `QUORUM` level enforces.

---

### A14. N=3 quorum configurations

For N=3, a quorum is `ceil((3+1)/2) = 2`, so `QUORUM = 2`.

| W | R | W+R | Strong? | Optimizes for |
|---|---|---|---|---|
| 2 | 2 | 4 | Yes | Balanced (the classic default) |
| 3 | 1 | 4 | Yes | Fast reads, write-side durability; slow/fragile writes |
| 1 | 3 | 4 | Yes | Fast writes; slow reads that must be fresh |
| 2 | 1 | 3 | No | Fast reads; may miss the newest write |
| 1 | 1 | 2 | No | Max availability + lowest latency; eventual only |

```
Strong (W+R>N):     (2,2) ✅   (3,1) ✅   (1,3) ✅
NOT strong (≤N):    (2,1) ❌   (1,2) ❌   (1,1) ❌
```

**Tradeoff: Read Latency vs Write Latency vs Consistency.** `(3,1)` makes reads cheap but every write must reach all 3 replicas — one slow/dead replica blocks writes. `(1,3)` inverts it. `(2,2)` tolerates exactly one node being down on *either* path while staying strongly consistent — which is why it's the default recommendation for N=3.

**Real systems:** Amazon's shopping cart ran `N=3, R=2, W=2` per the Dynamo paper; Cassandra `LOCAL_QUORUM`/`LOCAL_QUORUM` is the modern equivalent.

---

### A15. Sloppy quorum vs strict quorum

A **strict quorum** counts only acks from the key's actual preference-list nodes. A **sloppy quorum** lets the coordinator count a write to a *substitute* node (the next available healthy node, not normally responsible for the key) toward W when a preferred node is down.

```
Preference list for key K: [A, B, C], W=2.  Node B is DOWN.

Strict quorum:  wait for 2 of {A, B, C}. B is down → only A responds → write BLOCKS.
Sloppy quorum:  write to A and to D (D ∉ preference list, but healthy),
                D stores it with a HINT "this belongs to B" → write SUCCEEDS.
```

**What you lose:** the guarantee behind `W+R>N`. A subsequent strict-quorum read of {A, C} can miss the value now sitting on substitute D, because D is not in the read set. Sloppy quorum trades the overlap guarantee for write availability.

**Tradeoff: Availability vs Strict Consistency (the Dynamo choice).** Sloppy quorum keeps you writable through node failures at the cost of a temporary consistency gap that hinted handoff + repair later close. This is exactly why Dynamo/Cassandra are "AP" — the shopping cart must accept the write even when B is down.

---

### A16. Hinted handoff

When a sloppy-quorum write goes to substitute D, D stores the value **plus a hint** — metadata recording which node the write was really for.

```json
{ "key": "user:42", "value": "...", "version": "...",
  "hint": { "intended_node": "NodeB", "stored_at": "2026-07-06T10:30:00Z" } }
```

```
Delivery:
  1. Gossip tells D that NodeB is alive again.
  2. D replays all hinted writes it holds for B → B.
  3. B applies them (LWW or vector-clock merge).
  4. D deletes the local hints after B confirms.
```

**Failure mode — hint window exceeded:** hints are kept only for a bounded window (Cassandra's `max_hint_window_in_ms` defaults to 3 hours). If B stays down longer, D drops the old hints to avoid unbounded disk growth. Writes made during that window are then missing on B until **anti-entropy repair** (A22) reconciles them. If you skip repair, those writes can be lost for good on that replica.

**Tradeoff: Hint Retention vs Disk Bloat.** A longer window survives longer outages but lets hints pile up on healthy nodes (and a permanently dead node's hints grow forever). Rule: set the window ≥ typical MTTR, and *always* run repair after any extended outage.

---

## Level 5 — Conflict Resolution

### A17. Last-write-wins and clock skew

LWW resolves a conflict by keeping the value with the highest timestamp and discarding the rest.

```
Node A clock is 200ms ahead of Node B (NTP skew).

t=0ms  (B's clock 100)  Client-1 writes X=1 via B  → timestamp 100
t=50ms (A's clock 350)  Client-2 writes X=2 via A  → timestamp 350
t=80ms (B's clock 180)  Client-3 writes X=3 via B  → timestamp 180

LWW keeps the max timestamp = 350 → X=2.
But X=3 was the CAUSALLY LATEST real-world write and it is silently LOST.
```

The failure: LWW trusts wall-clock timestamps, but clocks drift. A write with a skewed-forward timestamp can shadow genuinely-later writes, causing **silent lost updates**. Worse, a buggy client sending a far-future timestamp can make a value effectively un-overwritable until real time catches up.

**Who uses it anyway and why:** Cassandra uses LWW at the cell level with client/coordinator-supplied timestamps, because for most of its workloads (time-series, last-known-state, caches) the occasional lost concurrent update is acceptable and LWW is *stateless and cheap* — no version vectors to store or merge. DynamoDB Global Tables also use LWW across regions.

**Tradeoff: Simplicity vs Correctness.** LWW needs zero extra metadata and never returns siblings, but it can silently discard concurrent writes. Acceptable for "latest value wins" data; unacceptable for anything where a lost write is a real bug (carts, counters, sets) — use vector clocks or CRDTs there (A18, A20).

---

### A18. Vector clocks (version vectors)

A **vector clock** is a map `{nodeId → counter}` attached to each value. Each time a node coordinates a write to a key, it increments its own entry. Comparing two vector clocks tells you whether one *causally descends from* the other (safe to overwrite) or they are *concurrent* (a genuine conflict).

```typescript
type VectorClock = Map<NodeId, number>;

function increment(vc: VectorClock, node: NodeId): VectorClock {
  const out = new Map(vc);
  out.set(node, (out.get(node) ?? 0) + 1);
  return out;
}

// element-wise max — used when merging a resolved value
function merge(a: VectorClock, b: VectorClock): VectorClock {
  const out = new Map(a);
  for (const [n, v] of b) out.set(n, Math.max(out.get(n) ?? 0, v));
  return out;
}

type Ordering = "before" | "after" | "equal" | "concurrent";
function compare(a: VectorClock, b: VectorClock): Ordering {
  let aBigger = false, bBigger = false;
  for (const n of new Set([...a.keys(), ...b.keys()])) {
    const av = a.get(n) ?? 0, bv = b.get(n) ?? 0;
    if (av > bv) aBigger = true;
    if (bv > av) bBigger = true;
  }
  if (aBigger && bBigger) return "concurrent";  // real conflict → keep both (siblings)
  if (aBigger) return "after";                  // a descends from b → a wins
  if (bBigger) return "before";                 // b descends from a → b wins
  return "equal";
}
```

```
Causal (safe):     A:{x:1}  then  A:{x:2}     → compare = "after"  → keep x:2
Concurrent (conflict): A:{x:1,y:0}  vs  B:{x:0,y:1} → "concurrent" → SIBLINGS
```

**Provenance:** the "happens-before" relation is Lamport (1978); vector clocks were formalized independently by Fidge and by Mattern (both 1988). Dynamo uses them; Riak later moved to *dotted version vectors* to bound sibling explosion.

**Tradeoff: Precision vs Metadata Size.** Vector clocks correctly detect concurrency (no silent lost updates) but the clock grows with the number of coordinating nodes. Dynamo bounds it by truncating the oldest (node, counter) pairs beyond a threshold, accepting rare false-concurrency for bounded metadata.

---

### A19. Siblings and who resolves them

**Siblings** are two or more concurrent versions of the same key that the store cannot order (their vector clocks compare as `concurrent`). Rather than silently discard one, an AP store keeps all of them and returns the whole list on the next `get`.

```
get("cart:42") → { values: [ {items:[A,B]}, {items:[A,C]} ], context: mergedVClock }
                  # two siblings — the store refuses to guess which is "right"
```

| Who resolves | How | Example |
|---|---|---|
| Client / application (semantic merge) | App understands the type and merges meaningfully | Shopping cart: union the item sets → `[A,B,C]` |
| Server (syntactic, e.g., LWW) | Pick highest timestamp automatically | Cassandra cells (no siblings surfaced) |
| The data type itself (CRDT) | Merge is defined by the type; conflict impossible | Counter, OR-Set (A20) |

The application resolves siblings by reading all of them, merging with domain logic (Dynamo's cart merges by *union*, which is why a deleted item can famously reappear), then writing back the merged value tagged with the combined context — which supersedes both siblings.

**Failure mode — sibling explosion:** if nobody ever reads-merges-writes, siblings accumulate on every concurrent write. Unbounded siblings bloat the value and can eventually make a key too large to fetch. Riak's dotted version vectors and per-key sibling limits exist specifically to cap this.

---

### A20. CRDTs

A **CRDT** (Conflict-free Replicated Data Type) is a data type whose merge function is mathematically guaranteed to converge: it's commutative, associative, and idempotent. Because merge always yields the same result regardless of order or duplication, concurrent updates *cannot* conflict — there are never siblings to resolve.

```
G-Counter (grow-only counter), one entry per node:
  Node A increments:  {A:3, B:0}
  Node B increments:  {A:0, B:5}
  merge = element-wise max? NO — for counters, merge = per-node MAX of each node's count,
          value = SUM of entries → {A:3, B:5}, value = 8.   Order-independent, convergent.

OR-Set (observed-remove set): each element carries unique add-tags;
  remove only cancels the add-tags it has seen → concurrent add+remove resolves to "present".
```

| CRDT fits cleanly | CRDT does NOT fit |
|---|---|
| Counters (likes, views) — PN-Counter | "The one true current value" of an arbitrary blob (no meaningful merge) |
| Sets (cart items, tags) — OR-Set | Values with cross-field invariants (e.g., balance ≥ 0) |
| Registers with LWW semantics — LWW-Register | Anything needing a global transaction across keys |

**Tradeoff: Automatic Convergence vs Expressiveness & Metadata.** CRDTs remove application-side conflict handling entirely, but only a limited catalog of types have clean merge functions, and they carry per-element metadata (tags/version info) that grows over time. **Real systems:** Riak ships CRDTs ("Riak DT": counters, sets, maps, registers), based on the Shapiro/Preguiça/Baquero/Zawirski (2011) work. Redis (Enterprise/CRDB) uses CRDTs for active-active geo-replication.

---

## Level 6 — Anti-Entropy & Failure Detection

### A21. Read repair

**Read repair** runs *on the read path*: when a coordinator gathers responses from R (or more) replicas and sees version divergence, it (a) returns the newest version to the client and (b) pushes that newest version to the stale replicas in the background.

```
get("user:42"), coordinator reads all 3 replicas:
  A: V2   D: V2   F: V1 (stale)
→ return V2 to client
→ async: write V2 back to F   (F is now repaired)
```

**Why it's not sufficient alone:** read repair only fixes keys that are *actually read*. Cold keys — written once, rarely read — can stay divergent on a replica indefinitely (e.g., a replica that missed a write while down, whose hint window then expired). Those need a proactive process. Cassandra also offers *blocking* read repair at `QUORUM`+ (repair before returning) vs *background* read repair.

**Tradeoff: Read-Path Cost vs Freshness.** Contacting more than R replicas on each read (`read_repair_chance`, or `speculative_retry`) catches more divergence but adds load and latency to every read. That's why read repair is paired with periodic full anti-entropy (A22) rather than relied on alone.

---

### A22. Merkle trees for anti-entropy

A **Merkle tree** is a hash tree: leaves hash individual keys (or key ranges), each internal node hashes its children, and the root is a single fingerprint of the whole dataset. Two replicas compare trees top-down and only descend into subtrees whose hashes differ, so they exchange O(differences), not O(dataset).

```
Replica A root hash == Replica B root hash  → identical, nothing to do.
Root differs → compare 2 children → follow only the differing child → ... → reach
               the specific leaf ranges that differ → stream only those keys.
```

```
1 billion keys, 1,000 differ:
  Naive:  ship/compare all 1B keys.
  Merkle: exchange ~tree-height × few hashes per level to localize 1,000 keys.
          Comparison cost ≈ O(k · log n)  (k = differing keys) — a few thousand hashes,
          then stream ~1,000 keys. Orders of magnitude less than 1B.
```

**Provenance & real systems:** Merkle trees are Ralph Merkle's (late 1970s). Dynamo uses per-key-range Merkle trees for anti-entropy between replicas; Cassandra's `nodetool repair` builds Merkle trees and streams only mismatched ranges.

**Tradeoff: Tree Granularity vs Repair Precision.** Coarser leaves (each covering a big key range) make a smaller, cheaper tree but force you to stream a whole range when any single key in it differs (over-streaming). Finer leaves localize differences precisely but cost more memory/CPU to build. Repair granularity is a real tuning knob.

---

### A23. Gossip for membership

A **gossip protocol** disseminates membership/state by having each node periodically pick a few random peers and exchange its view; state spreads epidemically until the whole cluster converges — no central coordinator required.

```
every 1s, each node:
  peers = pick_random(known_nodes, k=3)
  for p in peers: exchange_and_merge(my_view, p.view)   # keep the newer heartbeat per node
# a change reaches all N nodes in O(log_k N) rounds
```

| Membership mechanism | Single point of failure? | Scales to 1000s? | Notes |
|---|---|---|---|
| Central config server (e.g., a coordinator DB) | Yes — it's the SPOF | Bottlenecks | Simple but fragile; the thing you're avoiding |
| ZooKeeper/etcd (consensus) | No (quorum) | Hundreds well | Strong consistency; used by HBase/Bigtable-style CP systems |
| Gossip (epidemic) | No | Yes | Eventually-consistent membership; Dynamo/Cassandra choice |

**Why gossip is fail-tolerant:** there is no node whose death stops dissemination — information flows over *many* redundant random paths, so the protocol degrades gracefully as nodes fail. This matches the AP philosophy: membership itself is eventually consistent.

**Real systems:** Dynamo and Cassandra use gossip for membership and failure detection. **SWIM** (Das, Gupta, Motivala, 2002) is a well-known gossip-style membership protocol used by Serf/Consul and Hashicorp's memberlist.

---

### A24. Phi-accrual failure detection

A **phi (φ) accrual failure detector** outputs a *continuous suspicion level* instead of a binary up/down. It models the recent distribution of heartbeat inter-arrival times and computes φ = the (log-scaled) unlikeliness that no heartbeat has arrived for this long given history. The application picks a threshold.

```
φ(t) = -log10( P(no heartbeat since last one, for this long | historical intervals) )

φ = 1  → ~10%  chance this is a false positive if you convict now
φ = 8  → ~10^-8 chance of false positive (Cassandra's default convict threshold)
```

```
Node normally heartbeats every 1s. It GC-pauses for 8s:
  Fixed 5s timeout:  declares DEAD at 5s → needless rebalance → node returns → ring churns.
  Phi accrual:       if the node's history shows occasional multi-second gaps, φ climbs
                     slowly; 8s may still be below the convict threshold → NOT declared dead
                     → no false-positive rebalance.
```

**Why it avoids the false positive:** the threshold is relative to the node's *own* observed jitter. A node that historically has bursty heartbeats is given more slack before conviction; a rock-steady node is suspected sooner. This adapts to network conditions and GC behavior instead of a brittle fixed timeout.

**Provenance & real systems:** the φ accrual detector is Hayashibara, Défago, Yared, Katayama (2004). Cassandra uses it (`phi_convict_threshold`, default 8); Akka's cluster module also implements it.

**Tradeoff: Detection Speed vs False-Positive Rate.** A lower φ threshold detects real failures faster but convicts healthy-but-slow nodes more often, causing ring oscillation (flapping → repeated rebalancing). Higher φ is stabler but slower to react to genuine death.

---

## Level 7 — Local Storage Engine

*Summarized here; full treatment in [storage engines](../storage-engines/README.md).*

### A25. The write path (LSM tree)

```
put(key, value) on one node:
  1. Append (key, value, version) to the COMMIT LOG (append-only, fsync) → durability
  2. Insert into the MEMTABLE (in-memory sorted map, e.g., skip list / red-black tree)
  3. Ack the write (it's durable in the commit log + queryable in the memtable)
  --- later, asynchronously ---
  4. When the memtable fills, FLUSH it to a new immutable SSTABLE on disk (sorted, sequential write)
  5. Truncate the corresponding commit-log segment once flushed
```

**Why this is fast for writes:** every write is (a) one sequential append to the commit log and (b) one in-memory insert — no random disk seeks, no in-place update of on-disk pages. Flushes and merges are sequential I/O done in the background. This is the **Log-Structured Merge (LSM) tree**, and it's why Cassandra/Dynamo/Bigtable/HBase/ScyllaDB/RocksDB absorb high write throughput.

**Tradeoff: Write Speed vs Read Amplification.** Turning every write into an append means a key's history is scattered across the memtable + many SSTables, so reads may have to check several places (A26) and compaction must run to clean up (A27). LSM optimizes writes at the cost of read/space amplification — the opposite of a B-tree's in-place updates. Contrast in [storage engines](../storage-engines/README.md).

---

### A26. The read path (and Bloom filters)

```
get(key) on one node:
  1. Check the MEMTABLE (newest data).                                [in memory]
  2. (optional) Check the row/key cache.                              [in memory]
  3. For each candidate SSTABLE, newest→oldest:
       a. Ask its BLOOM FILTER: "could this key be here?"
          - "no"  → skip this SSTable entirely (no disk I/O)  ← the win
          - "maybe" → consult partition index/summary, then read the SSTable
  4. Merge the versions found (highest version / newest timestamp wins), return it.
```

A **Bloom filter** is a small in-memory probabilistic set. Its value: if it says "no," the key is *definitely* not in that SSTable, so you skip a disk read. Without it, a `get` for a key that lives in only one of, say, 10 SSTables would touch all 10 on disk. The filter turns that into ~1 disk read.

**Tradeoff: Read Amplification vs Memory.** More SSTables (fewer compactions) = cheaper writes but more places to check on read; Bloom filters + compaction fight that read amplification, at the cost of RAM (filters) and background I/O (compaction). Details in [storage engines](../storage-engines/README.md).

---

### A27. Compaction

**Compaction** is the background process that merges multiple SSTables into fewer, removing superseded versions, tombstones (deletes), and duplicates. It's solving the read/space amplification that append-only writes create: without it, SSTables accumulate forever, reads slow down, and deleted/overwritten data never reclaims disk.

| Strategy | Write amplification | Read amplification | Space amplification | Best for |
|---|---|---|---|---|
| Size-Tiered (STCS) | Low | Higher | Higher (temp 2x during merge) | Write-heavy workloads |
| Leveled (LCS) | Higher | Low | Low | Read-heavy, latency-sensitive |
| Time-Windowed (TWCS) | Low | Low (for time queries) | Low | Time-series / TTL data |

**Tradeoff: Write Amplification vs Read/Space Amplification.** This is the fundamental LSM tuning knob. Leveled compaction rewrites data more times (higher write amp) to keep few overlapping SSTables per level (low read amp, tight space). Size-tiered rewrites less (low write amp) but leaves more SSTables to check on reads and can temporarily double disk usage during a big merge. **Real systems:** Cassandra/ScyllaDB expose all three; RocksDB defaults to leveled. Full detail in [storage engines](../storage-engines/README.md).

---

### A28. Bloom filter false positives

A Bloom filter can return a **false positive** ("maybe present" when the key is absent) but *never* a false negative ("no" is always truth). So a "maybe" that turns out empty costs you a wasted lookup into that SSTable's index/data; a "no" is always safe to trust and skip.

```
Bloom filter guarantees:
  says "no"    → key is DEFINITELY absent          (0% false negatives)
  says "maybe" → key is PROBABLY present, could be absent  (tunable false-positive rate)
```

**Operational consequence of too-small a filter:** the false-positive rate rises, so more `get`s for absent keys trigger useless disk reads into SSTables that don't have the key — read amplification and latency climb, especially for "key not found" queries. The fix is more bits per key (lower FP rate) at the cost of memory. Cassandra exposes `bloom_filter_fp_chance` (a lower value = bigger filter, fewer wasted reads).

**Tradeoff: False-Positive Rate vs Memory.** Halving the false-positive rate costs roughly a fixed number of extra bits per key. Too small → wasted disk reads; too large → RAM you could've spent on caching data. More in [storage engines](../storage-engines/README.md).

---

## Level 8 — Architect Tradeoffs

### A29. Dynamo vs Bigtable/HBase vs Spanner

| Model | Topology | CAP stance | Consistency | Best for |
|---|---|---|---|---|
| **Dynamo** (Cassandra, Riak, Voldemort, DynamoDB) | Leaderless; any replica takes writes | **AP** | Tunable, eventual by default; conflicts via VC/LWW/CRDT | Always-writable, high-availability KV at scale (carts, sessions, timelines) |
| **Bigtable / HBase** | Range-partitioned tablets/regions; **one server owns a tablet at a time** | **CP** | Strong per row/key (single writer per range) | Huge sorted datasets with range scans; strong single-key reads |
| **Spanner** | Paxos groups per shard; leader per group; **TrueTime** clock | **CP** | **External consistency** (linearizable), global ACID txns | Globally-distributed data needing SQL + real transactions |

```
Partition happens:
  Dynamo:   both sides keep serving writes → reconcile later (available, not linearizable)
  HBase:    the side that can't reach its region server / ZK quorum stops → (consistent, not available)
  Spanner:  minority side can't get Paxos quorum → stops → (consistent, not available)
```

**Named tradeoff — Availability vs Linearizability (CAP under partition).** Dynamo picks A: never reject a write, tolerate temporary divergence. Bigtable/HBase and Spanner pick C: prefer to reject/stall writes on the minority side to preserve a single history. Spanner's extra trick is **TrueTime** — GPS + atomic-clock-backed clock bounds (`TT.now()` returns an interval) that let it assign globally-ordered commit timestamps and wait out the uncertainty, achieving external consistency. (I'm confident in the TrueTime concept; exact commit-wait durations are implementation detail I won't quote as fact.)

**When each wins:** Dynamo for a shopping cart or session store that must never fail a write. HBase/Bigtable for a massive, range-scanned analytical/time-series store. Spanner when you genuinely need global transactions and SQL and can pay for the clock infrastructure.

---

### A30. Why the coordinator waits for W (or R), not N

Because waiting for all N means waiting for the **slowest** replica on every request — and in a large fleet, *something* is always slow (GC pause, hot disk, noisy neighbor). Waiting for a quorum W < N lets the request complete as soon as the W-th fastest replica answers, cutting the tail.

```
N=3 replica latencies for one request: [2ms, 3ms, 90ms]  (third is GC-paused)
  Wait for all N (W=3): request takes 90ms   ← tail dominated by the slowest
  Wait for W=2:         request takes 3ms    ← ignore the straggler
```

**Tail-latency math intuition:** if each replica independently has a 1% chance of being slow, the chance that *at least one* of 3 is slow is `1 - 0.99^3 ≈ 3%`. Requiring all 3 exposes you to that 3%; requiring 2-of-3 lets you skip whichever one is slow. This is why p99 latency, not average, drives the W/R choice.

**Speculative / hedged reads** push this further: after a short delay, the coordinator sends the read to an *extra* replica and takes whichever returns first, trading a bit of extra load for a tighter tail.

**Tradeoff: Consistency/Durability vs Tail Latency.** Larger W/R = stronger guarantees but you wait for more (slower) replicas; smaller W/R = faster tail but weaker guarantees. **Real systems:** the "tail at scale" problem is well-documented (Dean & Barroso, CACM 2013); Cassandra implements `speculative_retry`, DynamoDB hides this behind its managed latency SLAs.

---

### A31. Capacity math (illustrative — verify with real numbers)

```
Assumptions (LABELED ILLUSTRATIVE):
  keys           = 10 billion
  avg value      = 1 KB   (key + metadata overhead folded in, rounded)
  replication N  = 3

Logical data     = 10e9 keys × 1 KB       = 10 TB
Physical data    = 10 TB × RF 3           = 30 TB   ← replication overhead is (N-1)×base = +20 TB
Per-node usable  = 2 TB   (leave room for compaction temp space, commit log, indexes)
Nodes for data   = 30 TB / 2 TB           = 15 nodes (bare minimum)

Headroom rule: target ~60% utilization so a node failure + compaction + growth fit.
  30 TB / 0.60 = 50 TB provisioned → 50 TB / 2 TB = 25 nodes.

Throughput sanity check (illustrative):
  1,000,000 ops/sec, N=3, W=2/R=2 → each op is ~2–3 replica ops
  ≈ 2–3 million internal replica ops/sec across the cluster
  25 nodes → ~80k–120k replica ops/sec/node → within reach of SSD-backed LSM nodes.
```

| Quantity | Value | Note |
|---|---|---|
| Logical data | 10 TB | keys × avg value |
| Replication overhead | +20 TB (2×) | (N−1) extra copies |
| Physical data | 30 TB | logical × RF |
| Nodes at 100% | 15 | no headroom — do not run here |
| Nodes at 60% target | ~25 | absorbs failure + compaction + growth |

**Tradeoff: Storage Cost vs Durability/Availability.** RF=3 triples storage and write bandwidth versus RF=1, but RF=1 loses data on any node failure. The overhead *is* the durability. **Do not present these node counts as fact** — they hinge on the value-size and utilization assumptions above; the method (logical → ×RF → ÷usable → ÷utilization) is what matters in an interview.

---

### A32. When a Dynamo-style KV store is the wrong choice

| Situation | Why KV store fails | Use instead |
|---|---|---|
| Range / sorted scans ("all orders Jan–Mar", leaderboards) | Keys are hashed and scattered; no ordering | Range-partitioned store: HBase, Bigtable, CockroachDB; or an ordered index |
| Multi-key ACID transactions (transfer money A→B) | No cross-key atomicity in classic Dynamo | Spanner, CockroachDB, or a relational DB |
| Rich ad-hoc queries / secondary indexes / analytics | No query planner, no joins | Relational DB (Postgres) or a search/OLAP engine (Elasticsearch, ClickHouse) |
| Strong global linearizability required | AP model reconciles conflicts after the fact | CP store (Spanner, etcd for small config) |
| Small data that fits one box comfortably | Operational complexity isn't justified | Single Postgres/MySQL (A4) |

**The senior signal:** proactively saying "a KV store is the wrong tool here" is often the strongest answer. Naming the *specific* missing capability (range scan, cross-key transaction, secondary index) and the right replacement shows you understand the model's boundaries, not just its mechanics.

---

## Bonus — Senior Questions

### AB1. "We'll need to list all keys for a user soon"

Flag it immediately, because it changes the partitioning key. Pure `hash(key)` scatters a user's keys across the whole ring, so "list all keys for user X" becomes a full-cluster scan — the anti-pattern from A32.

```
Options:
1. Composite key with the user as the partition key, item as a sort/cluster key:
     partition = user_id   (co-locates the user's items on one preference list)
     sort      = item_id   (ordered within the partition → range scan works)
   This is exactly Cassandra's partition-key + clustering-key model, or
   DynamoDB's partition key + sort key.

2. Maintain a secondary index key:  index:user:{id} → [list of item keys]
   (extra write to keep in sync; risks the two diverging).
```

**Tradeoff: Point-Lookup Distribution vs Range Locality.** Making `user_id` the partition key gives cheap per-user listing/range scans but re-introduces hot-partition risk if one user is huge (a "celebrity" partition). Pure key hashing distributes perfectly but can't list. The composite-key model (partition key = grouping dimension, sort key = ordered within) is the standard reconciliation — and it's why "pure KV" quietly becomes "wide-column."

---

### AB2. A single super-hot read key saturating its replicas

`config:global` at 500k reads/sec is a hot *key*, not a hot *partition* — vnodes and quorums can't split a single key across nodes. Options, roughly in order of reach:

```
1. Client-side / local L1 cache: every service caches the value in-process with a short TTL
   (1–5s). 500k reads/sec collapse to ~1 refresh per service per TTL. Biggest win, cheapest.
2. Widen replication for that key only: raise N for the hot key so more nodes can serve reads
   (read with R=1 across many replicas).
3. Read-only replica fan-out / dedicated cache tier (Redis/Memcached) in front for that key.
4. Key splitting for reads: config:global:0..K, writes fan out to all K, reads pick one at random
   → spreads read load across K preference lists.
```

| Option | Read distribution | Write cost | Staleness |
|---|---|---|---|
| L1 in-process cache | Perfect (per service) | none | up to TTL |
| Wider N for the key | Across more replicas | higher (more copies) | consistent |
| Front cache tier | Across cache nodes | invalidation needed | up to TTL |
| Key splitting | Across K partitions | fan-out ×K | consistent |

**Tradeoff: Staleness vs Origin Load.** Caching (options 1, 3) trades a few seconds of staleness for a massive load drop — almost always right for a config value. Splitting/widening (2, 4) keeps freshness but adds write cost. For read-mostly config, the L1 cache is the senior answer.

---

### AB3. Raising RF from 3 to 5 on a live cluster

```
Step 1 — Pre-check capacity:
  New physical data = logical × 5 (was × 3). Confirm every node has headroom
  for +2 copies' worth of its share BEFORE starting (A31 math). If not, add nodes first.

Step 2 — Change the replication factor in config:
  e.g. ALTER KEYSPACE ... WITH REPLICATION = { ..., 'dc1': 5 };
  This changes where NEW writes go immediately, but existing data is NOT yet on the 2 new replicas.

Step 3 — Run anti-entropy repair to stream existing data to the new replicas:
  nodetool repair (Merkle-tree based, A22), node by node, throttled.

Step 4 — Verify, then only now rely on the higher RF (e.g. move reads to a higher R).
```

```
Risk at each stage:
  - Between Step 2 and Step 4, reads at a quorum computed for N=5 (=3) can HIT the not-yet-
    populated replicas and miss data → temporarily LOWER your read consistency level, or
    keep quorum math on the old N, until repair completes.
  - Repair generates heavy streaming I/O → do it in low-traffic windows, throttled.
  - A node failing mid-repair leaves some ranges under-replicated → don't start if the
    cluster is already degraded.
```

**Tradeoff: Durability vs Migration Risk & Cost.** Higher RF means more durability and read availability but +2 copies of storage and write bandwidth forever, plus a risky live migration. Sequence it so consistency guarantees only tighten *after* the data is actually in place. **Real systems:** this is the standard Cassandra `ALTER KEYSPACE` + `nodetool repair` runbook.

---

### AB4. LWW vs vector clocks — the decision rule

Decide by the *value's merge semantics*, not by taste:

```
Use LWW when:
  - The value is a whole-object "latest state wins" and a lost concurrent write is acceptable
    (user profile blob, cached render, last-known sensor reading, time-series point).
  - You cannot afford per-key version metadata or client-side merge logic.

Use vector clocks (or a CRDT) when:
  - Concurrent writes must all be preserved / merged (shopping cart, set of tags, collaborative doc).
  - A silently lost update is a correctness bug, not a cosmetic one.
  - Prefer a CRDT (A20) over raw vector clocks when the type has a clean merge (counter, set) —
    it removes client-side resolution entirely.
```

| Value type | Concurrent-write loss acceptable? | Pick |
|---|---|---|
| User profile / cache entry / sensor point | Yes | LWW |
| Shopping cart / tag set / friend list | No — must union | CRDT (OR-Set) or vector clocks |
| Counter (likes, views) | No — must sum | CRDT (PN-Counter) |
| Bank balance / anything with invariants | No — needs a transaction | Neither — use a CP store (A32) |

**Tradeoff: Simplicity vs Correctness (restated with a rule).** LWW is stateless and cheap but silently discards concurrent updates; vector clocks/CRDTs preserve them at the cost of metadata and (for VCs) client merge logic. The rule: **if losing a concurrent write is a bug, you cannot use LWW.**

---

## Consistency Configuration — Quick Reference

| Use case | N, W, R | Conflict resolution | Why |
|---|---|---|---|
| Shopping cart (never fail a write) | 3, 1, 1 (sloppy) | CRDT / vector clocks | Availability first; merge concurrent adds |
| User session store | 3, 1, 1 | LWW | Stale-for-seconds is fine; speed wins |
| Read-your-writes user profile | 3, 2, 2 | LWW | Strong-ish, one node can be down |
| Financial ledger | Wrong tool | — | Use a CP/transactional store (A32) |
| Global config (read-mostly) | 3, 2, 1 + L1 cache | LWW | Fast reads; cache absorbs the hot key |
| Time-series metrics | 3, 1, 1, TWCS compaction | LWW | Write-heavy, append-mostly |

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| KV store tradeoff | Give up joins/range/transactions for horizontal scale + predictable key latency |
| `get` returns a list | Concurrent writes → siblings; client passes context back to collapse them |
| Coordinator | Any node takes the request, routes to the preference list, waits for W/R |
| Partitioning | Consistent hashing + vnodes; ~1/N keys move on topology change (sibling folder) |
| Preference list | First N *distinct physical* nodes clockwise; skip same-machine vnodes and shared racks |
| Quorum rule | W + R > N → read/write sets overlap → strong consistency (N=3,W=2,R=2 classic) |
| Sloppy quorum | Count substitute-node writes toward W when a replica is down → availability, loses overlap |
| Hinted handoff | Substitute stores a hint; replays on recovery; dropped after the hint window → need repair |
| LWW | Highest timestamp wins; clock skew can silently drop the causally-latest write |
| Vector clock | {node→counter}; concurrent (both bigger) = real conflict → siblings; else causal → overwrite |
| CRDT | Merge is commutative/associative/idempotent → conflict-free; counters, OR-sets |
| Read repair | On read, push newest version to stale replicas; only fixes keys that are read |
| Merkle tree | Hash tree; compare roots, descend only on mismatch → sync O(differences) not O(data) |
| Gossip | Random-peer epidemic dissemination; no SPOF; O(log N) rounds to converge (SWIM) |
| Phi-accrual | Continuous suspicion score vs node's own jitter; avoids false-positive death on GC pause |
| LSM write path | Commit log append + memtable insert → ack; flush to immutable SSTable later (fast writes) |
| Bloom filter | "no" = definitely absent (skip SSTable); "maybe" = false positive possible; never false negative |
| Compaction | Merge SSTables; knob = write-amp vs read/space-amp (STCS/LCS/TWCS) |
| CAP stances | Dynamo=AP (always writable); Bigtable/HBase=CP; Spanner=CP + TrueTime linearizable |
| Wait for W not N | Skip the slowest replica → cut tail latency; speculative/hedged reads tighten it further |
| Capacity method | logical × RF ÷ per-node-usable ÷ 0.6 utilization = node count (values illustrative) |
| Wrong tool signals | Range scans, cross-key transactions, secondary indexes, strong global linearizability |
| LWW vs VC rule | If losing a concurrent write is a bug, you cannot use LWW |
