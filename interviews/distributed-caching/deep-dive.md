# Deep Dive: Distributed Caching

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive mental models
> - 🟡 **Senior** — implementation mechanics + tradeoffs
> - 🔴 **Architect** — failure modes, capacity math, and review-level decisions

---

## Table of Contents

1. [Why Caching Exists](#1-why-caching-exists)
2. [Caching Strategies Deep Dive](#2-caching-strategies-deep-dive)
3. [Eviction Policies and Memory Management](#3-eviction-policies-and-memory-management)
4. [Redis Internals](#4-redis-internals)
5. [Cache Invalidation Patterns](#5-cache-invalidation-patterns)
6. [Failure Modes and Mitigations](#6-failure-modes-and-mitigations)
7. [Multi-Layer Cache Architecture](#7-multi-layer-cache-architecture)
8. [Real-World Company Case Studies](#8-real-world-company-case-studies)
9. [Pattern Recognition — When to Cache](#9-pattern-recognition--when-to-cache)
10. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Caching Exists

### 🟢 Beginner — The Sticky Notes Analogy

Imagine you're an office worker who frequently looks up the same phone numbers. Going to the filing cabinet every time takes 30 seconds. Instead, you write frequently-used numbers on sticky notes on your desk — now it takes 1 second.

Caching is the sticky notes. The filing cabinet is your database. You trade a little desk space (memory) for massive time savings.

```text
Without sticky notes (cache):
  Every lookup → filing cabinet → 30 seconds

With sticky notes (cache):
  Hot lookups → sticky notes → 1 second
  Cold lookups → filing cabinet → 30 seconds
```

---

### 🟡 Senior — The Memory Hierarchy

Caching exploits the **memory hierarchy** — faster storage costs more but is smaller.

| Storage Layer | Latency | Cost per GB | Typical Size |
|---|---|---|---|
| CPU Cache (L1) | 1ns | — | 64KB |
| RAM | 100ns | $10 | 256GB |
| SSD | 100μs | $0.20 | 4TB |
| Network (Redis) | 1ms | — | — |
| Database query | 10-100ms | — | — |

**Key insight**: Moving data closer to computation (up the hierarchy) is almost always worth it for read-heavy workloads.

```python
# Latency comparison
db_latency = 50  # ms
cache_latency = 1  # ms

# At 95% hit ratio
avg_latency = (0.95 * cache_latency) + (0.05 * db_latency)
# = 0.95 + 2.5 = 3.45ms (14x improvement)

# Database load reduction
without_cache = 1_000_000  # queries/sec to DB
with_95_cache = 50_000     # 5% miss rate → 50K queries/sec to DB
# 20x reduction in database load
```

---

### 🔴 Architect — When NOT to Cache

Caching isn't free. It adds complexity, consistency challenges, and operational overhead.

**Skip caching when**:
| Scenario | Why |
|---|---|
| Write-heavy workload | Cache invalidation overhead exceeds benefit |
| Every read is unique | 0% hit ratio — pure overhead |
| Strong consistency required | Cache adds staleness |
| Data changes faster than TTL | Constant invalidation |
| Database is fast enough | Premature optimization |

**Design review red flags**:
- "We'll cache everything" — no selectivity
- No invalidation strategy defined
- No capacity planning for cache
- Cache and DB consistency not addressed

**Capacity planning formula**:
```
Cache size estimate:
  Working set = (hot keys) × (avg key size + avg value size + overhead)
  
Example:
  100K hot products × (50 bytes key + 1KB value + 100 bytes overhead)
  = 100K × 1.15KB ≈ 115MB
  
With 20% headroom: 140MB minimum
```

---

## 2. Caching Strategies Deep Dive

### 🟢 Beginner — The Library Book Analogy

Four ways to manage a personal collection of borrowed library books:

1. **Cache-aside (lazy)**: Only bring home books when you need them. Return when done.
2. **Write-through**: When you get a new edition, place it on your shelf AND notify the library.
3. **Write-back (lazy writing)**: Keep books at home, return to library once a week in batch.
4. **Write-around**: New books go directly to library; you fetch when needed.

---

### 🟡 Senior — Strategy Selection Matrix

```python
def choose_caching_strategy(workload):
    read_write_ratio = workload.reads / workload.writes
    consistency_requirement = workload.consistency  # "strong", "eventual"
    write_latency_tolerance = workload.write_latency_ms
    
    if read_write_ratio > 100 and consistency_requirement == "eventual":
        return "cache-aside"  # Most common
    
    if consistency_requirement == "strong":
        return "write-through"
    
    if write_latency_tolerance < 5 and data_loss_acceptable:
        return "write-back"
    
    if read_write_ratio < 1:  # Write-heavy
        return "write-around"  # Or no cache
```

**Strategy comparison with code**:

```python
# CACHE-ASIDE
class CacheAsidePattern:
    def read(self, key):
        value = cache.get(key)
        if value is None:
            value = db.get(key)
            cache.set(key, value, ttl=300)
        return value
    
    def write(self, key, value):
        db.set(key, value)
        cache.delete(key)  # Invalidate, don't update

# WRITE-THROUGH
class WriteThroughPattern:
    def read(self, key):
        return cache.get(key) or db.get(key)
    
    def write(self, key, value):
        cache.set(key, value)
        db.set(key, value)  # Synchronous

# WRITE-BACK
class WriteBackPattern:
    def __init__(self):
        self.dirty_keys = set()
    
    def write(self, key, value):
        cache.set(key, value)
        self.dirty_keys.add(key)
        # Don't write to DB yet
    
    async def flush(self):  # Background job
        for key in self.dirty_keys:
            db.set(key, cache.get(key))
        self.dirty_keys.clear()
```

---

### 🔴 Architect — Facebook's Memcache Strategy

**Facebook's scale**: 1B+ users, 100M+ requests/sec to cache.

**Their approach — "Look-aside cache"** (variant of cache-aside):

```text
Read path:
  App → Memcache → HIT → return
                 → MISS → MySQL → set in Memcache → return

Write path:
  App → MySQL → delete from Memcache
            (NOT update — avoids race conditions)
```

**Key decisions from Facebook's paper**:

1. **Delete on write, not set**: Prevents race condition where stale write overwrites fresh data
2. **Lease tokens**: Prevent thundering herd on cache miss
3. **Regional pools**: Reduce cross-datacenter traffic
4. **Gutter pools**: Backup cache for failed servers

**Lease token mechanism**:
```python
def get_with_lease(key):
    value = memcache.get(key)
    if value:
        return value
    
    # Request lease (returns token or existing value)
    lease_token = memcache.get_lease(key)
    if lease_token == "RETRY":
        time.sleep(0.01)
        return get_with_lease(key)  # Another client is fetching
    
    # We got the lease — fetch from DB
    value = db.get(key)
    memcache.set_with_lease(key, value, lease_token)
    return value
```

---

## 3. Eviction Policies and Memory Management

### 🟢 Beginner — The Bookshelf Analogy

Your bookshelf holds 100 books. You have 150 books. Which 50 do you store elsewhere?

- **LRU (Least Recently Used)**: Books you haven't touched in months → storage
- **LFU (Least Frequently Used)**: Books you've only read once ever → storage
- **FIFO (First In, First Out)**: Your oldest books → storage
- **Random**: Pick any 50 randomly

Each has tradeoffs depending on your reading habits.

---

### 🟡 Senior — LRU Implementation

LRU requires O(1) access AND O(1) eviction. Solution: Hash map + doubly-linked list.

```python
class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.map = {}  # key → node
        self.head = Node()  # Most recent
        self.tail = Node()  # Least recent
        self.head.next = self.tail
        self.tail.prev = self.head
    
    def get(self, key: str):
        if key not in self.map:
            return None
        node = self.map[key]
        self._move_to_front(node)
        return node.value
    
    def put(self, key: str, value: Any):
        if key in self.map:
            node = self.map[key]
            node.value = value
            self._move_to_front(node)
        else:
            if len(self.map) >= self.capacity:
                self._evict_lru()
            node = Node(key, value)
            self.map[key] = node
            self._add_to_front(node)
    
    def _move_to_front(self, node):
        self._remove(node)
        self._add_to_front(node)
    
    def _evict_lru(self):
        lru = self.tail.prev
        self._remove(lru)
        del self.map[lru.key]
```

**Redis eviction policies**:
```redis
# Configure eviction policy
CONFIG SET maxmemory-policy allkeys-lru

# Available policies:
# noeviction     - return errors on write when full
# allkeys-lru    - evict any key (LRU)
# volatile-lru   - evict keys with TTL (LRU)
# allkeys-lfu    - evict any key (LFU)
# volatile-lfu   - evict keys with TTL (LFU)
# allkeys-random - evict random keys
# volatile-random - evict random keys with TTL
# volatile-ttl   - evict keys with shortest TTL
```

---

### 🔴 Architect — Redis Memory Optimization

**Real incident at Grab**: Redis running out of memory, causing OOM kills.

**Diagnosis**:
```redis
INFO memory
# used_memory_human: 31.8G
# maxmemory_human: 32G
# mem_fragmentation_ratio: 1.42  # High fragmentation!

MEMORY DOCTOR
# Recommendations...
```

**Memory optimization techniques**:

| Technique | Savings | Implementation |
|---|---|---|
| Compression | 40-70% | Compress values (gzip, snappy) |
| Shorter keys | 10-20% | `user:123` → `u:123` |
| Hash encoding | 30-50% | Use Redis hashes for small objects |
| Evict idle | Variable | `OBJECT IDLETIME` + cleanup job |

**Capacity planning formula**:
```
Memory required = 
  (key count × avg key size) + 
  (key count × avg value size) +
  (key count × overhead per key) +
  (fragmentation factor × total)

Example:
  10M keys × 50 bytes key = 500MB
  10M keys × 500 bytes value = 5GB
  10M keys × 70 bytes overhead = 700MB
  Total: 6.2GB × 1.3 fragmentation = 8GB needed
```

**Grafana alert**:
```yaml
- alert: RedisMemoryHigh
  expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Redis memory usage above 85%"
```

---

## 4. Redis Internals

### 🟢 Beginner — Redis as a Swiss Army Knife

Redis isn't just a key-value store. It's like a Swiss Army knife with specialized tools:

- **Strings**: The basic blade — store any value
- **Hashes**: A tiny filing cabinet — store structured objects
- **Lists**: A stack of papers — ordered, push/pop from ends
- **Sets**: A bag of unique marbles — no duplicates
- **Sorted Sets**: Marbles with weights — ranked order

---

### 🟡 Senior — Redis Data Structure Selection

```python
# STRINGS - simple values, counters
redis.set("user:123:name", "Alice")
redis.incr("page:views:home")  # Atomic increment

# HASHES - structured objects (saves memory vs JSON)
redis.hset("user:123", mapping={
    "name": "Alice",
    "email": "alice@example.com",
    "last_login": "2024-03-30"
})
user = redis.hgetall("user:123")

# LISTS - queues, recent items
redis.lpush("feed:user:123", "new_post_456")  # Add to front
redis.ltrim("feed:user:123", 0, 99)  # Keep last 100
recent = redis.lrange("feed:user:123", 0, 9)  # Get last 10

# SETS - unique collections, tags
redis.sadd("post:123:tags", "python", "caching", "redis")
redis.sinter("post:123:tags", "post:456:tags")  # Common tags

# SORTED SETS - leaderboards, priority queues
redis.zadd("leaderboard", {"player:42": 1500, "player:17": 1200})
top_10 = redis.zrevrange("leaderboard", 0, 9, withscores=True)
rank = redis.zrevrank("leaderboard", "player:42")  # 0-indexed rank
```

**Time complexity cheat sheet**:
| Operation | Complexity | Example |
|---|---|---|
| GET/SET | O(1) | Simple key access |
| HGET/HSET | O(1) | Hash field access |
| LPUSH/RPOP | O(1) | List ends |
| LRANGE | O(N) | List range |
| SADD/SISMEMBER | O(1) | Set add/check |
| ZADD/ZRANK | O(log N) | Sorted set |
| ZRANGE | O(log N + M) | Sorted set range |

---

### 🔴 Architect — Redis Cluster Operations

**Redis Cluster topology at scale**:
```text
┌─────────────────────────────────────────────────────────────┐
│                    Redis Cluster (6 nodes)                  │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Master 1   │  │  Master 2   │  │  Master 3   │         │
│  │ slots 0-5460│  │slots 5461-10│  │slots 10923- │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐         │
│  │  Replica 1  │  │  Replica 2  │  │  Replica 3  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

**Cluster administration**:
```redis
# Check cluster health
CLUSTER INFO
CLUSTER NODES

# Resharding (move slots between nodes)
redis-cli --cluster reshard <host>:<port>

# Add new node
redis-cli --cluster add-node <new_host>:<port> <existing_host>:<port>

# Failover (promote replica to master)
CLUSTER FAILOVER
```

**Hash tags for co-location**:
```python
# These keys hash to same slot → same node
redis.set("{user:123}:profile", "...")
redis.set("{user:123}:settings", "...")
redis.set("{user:123}:sessions", "...")

# MGET works across co-located keys
redis.mget("{user:123}:profile", "{user:123}:settings")
```

**Pipeline for reduced latency**:
```python
# Without pipeline: 100 round trips
for i in range(100):
    redis.get(f"key:{i}")  # 100ms total

# With pipeline: 1 round trip
pipe = redis.pipeline()
for i in range(100):
    pipe.get(f"key:{i}")
results = pipe.execute()  # 1ms total
```

---

## 5. Cache Invalidation Patterns

### 🟢 Beginner — The News Feed Analogy

Imagine you have a printed copy of today's news. When does it become "stale"?

- **TTL approach**: The paper self-destructs at midnight. Get a new one tomorrow.
- **Event-driven**: A messenger arrives whenever news updates. You tear up the old page.
- **Write-through**: The printing press sends you a new page instantly when news changes.

Each has different freshness guarantees and operational costs.

---

### 🟡 Senior — Race Conditions in Invalidation

**The classic race condition** (why we delete, not update):

```text
Time →
Thread A (reader):  READ(cache) miss → READ(db) old_value → SET(cache, old_value)
Thread B (writer):                   UPDATE(db, new_value) → SET(cache, new_value)
                                                                   ↑
                                                            Thread A sets old value AFTER this!
Result: Cache has stale data
```

**Solution — delete instead of update**:
```text
Thread A (reader):  READ(cache) miss → READ(db) old_value → SET(cache, old_value)
Thread B (writer):                   UPDATE(db, new_value) → DELETE(cache)
                                                                   ↑
                                   Thread A's SET happens before DELETE — OK!
                                   Next read gets fresh data from DB
```

**Double-delete for extra safety**:
```python
def update_with_double_delete(key: str, value: Any):
    cache.delete(key)          # 1. Invalidate old
    db.update(key, value)      # 2. Update DB
    time.sleep(0.5)            # 3. Wait for in-flight reads
    cache.delete(key)          # 4. Invalidate any stale repopulation
```

---

### 🔴 Architect — Airbnb's Cache Invalidation

**Airbnb's challenge**: Millions of listings, complex search index, eventual consistency acceptable but not "forever stale."

**Their solution — "Delayed Invalidation"**:

```python
class DelayedInvalidation:
    def on_listing_update(self, listing_id: str, update: dict):
        # 1. Update primary database
        db.update_listing(listing_id, update)
        
        # 2. Queue invalidation with delay
        self.invalidation_queue.enqueue(
            key=f"listing:{listing_id}",
            delay_seconds=5,  # Wait for replicas to catch up
            metadata={"version": update["version"]}
        )
    
    def process_invalidation(self, job):
        key = job["key"]
        # Check if newer version already invalidated
        current = cache.get(key)
        if current and current["version"] >= job["metadata"]["version"]:
            return  # Already fresh
        
        cache.delete(key)
```

**Monitoring invalidation health**:
```yaml
- alert: CacheInvalidationLag
  expr: histogram_quantile(0.99, invalidation_delay_seconds) > 10
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Cache invalidation p99 exceeds 10s"

- alert: StaleDataReports
  expr: rate(stale_data_user_reports_total[1h]) > 10
  labels:
    severity: critical
  annotations:
    summary: "Users reporting stale data"
```

---

## 6. Failure Modes and Mitigations

### 🟢 Beginner — The Water Fountain Analogy

**Stampede (thundering herd)**: The office water cooler runs out. 100 people all walk to the vending machine at once. It also runs out.

**Penetration**: People ask for drinks that don't exist. Everyone keeps checking the empty fridge.

**Avalanche**: All the water coolers on the floor run out at exactly 3pm every day (synchronized expiry).

**Breakdown**: The one cooler near the CEO's office (hot spot) runs out, everyone crowds there.

---

### 🟡 Senior — Implementation of Mitigations

**Stampede mitigation — Singleflight pattern**:
```go
// Go's singleflight package
var group singleflight.Group

func getFromCacheOrDB(key string) (interface{}, error) {
    // Only one goroutine fetches, others wait
    v, err, _ := group.Do(key, func() (interface{}, error) {
        // Check cache
        if val := cache.Get(key); val != nil {
            return val, nil
        }
        // Fetch from DB (only 1 request, not 1000)
        val := db.Get(key)
        cache.Set(key, val, ttl)
        return val, nil
    })
    return v, err
}
```

**Penetration mitigation — Bloom filter**:
```python
from pybloom import BloomFilter

# Initialize with all valid IDs
valid_ids = BloomFilter(capacity=100_000_000, error_rate=0.001)
for id in db.get_all_ids():
    valid_ids.add(id)

def get_user(user_id: str):
    # Fast check: is this ID possibly valid?
    if user_id not in valid_ids:
        return None  # Definitely doesn't exist
    
    # Proceed with normal cache-aside
    cached = cache.get(f"user:{user_id}")
    if cached:
        return cached
    
    user = db.get_user(user_id)
    if user:
        cache.set(f"user:{user_id}", user)
    else:
        # Bloom filter false positive, cache null
        cache.set(f"user:{user_id}", "NULL", ttl=60)
    return user
```

**Avalanche mitigation — Jittered TTL**:
```python
import random

def set_with_jitter(key: str, value: Any, base_ttl: int):
    jitter = random.randint(-base_ttl // 10, base_ttl // 10)
    actual_ttl = base_ttl + jitter
    cache.setex(key, actual_ttl, value)

# Example: base 1 hour, actual 54-66 minutes
set_with_jitter("product:123", product_data, 3600)
```

---

### 🔴 Architect — Netflix's EVCache Resilience

**Netflix's cache architecture** handles 30M+ requests/sec with extreme reliability.

**Key resilience patterns**:

1. **Zone-aware replication**: Cache replicated across AWS availability zones
2. **Fallback tiers**: EVCache → fallback EVCache → origin
3. **Circuit breakers**: Stop hammering failed cache
4. **Adaptive timeouts**: Adjust based on latency percentiles

```java
// Netflix Hystrix circuit breaker pattern
@HystrixCommand(
    fallbackMethod = "getFromFallbackCache",
    commandProperties = {
        @HystrixProperty(name = "circuitBreaker.requestVolumeThreshold", value = "20"),
        @HystrixProperty(name = "circuitBreaker.errorThresholdPercentage", value = "50"),
        @HystrixProperty(name = "circuitBreaker.sleepWindowInMilliseconds", value = "5000")
    }
)
public Data getFromCache(String key) {
    return cache.get(key);
}

public Data getFromFallbackCache(String key) {
    return fallbackCache.get(key);  // Different cluster
}
```

**Chaos engineering for cache**:
```yaml
# Chaos Monkey experiments
experiments:
  - name: "Cache node failure"
    type: "terminate_instance"
    target: "evcache-cluster"
    
  - name: "Cache latency injection"
    type: "network_latency"
    target: "evcache-cluster"
    params:
      latency_ms: 500
      
  - name: "Cache partition"
    type: "network_partition"
    target: "evcache-cluster"
```

---

## 7. Multi-Layer Cache Architecture

### 🟢 Beginner — The Information Desk Analogy

Asking for information at an airport:

1. **L0 — CDN**: Information screens everywhere (no waiting)
2. **L1 — Local cache**: The attendant remembers common questions
3. **L2 — Distributed cache**: Attendants share a radio network
4. **L3 — Database**: Calling the airline's main office

Each layer is slower but has more/fresher info. You start nearby and escalate.

---

### 🟡 Senior — Multi-Layer Implementation

```python
class MultiLayerCache:
    def __init__(self):
        self.l1 = LocalCache(max_size=10_000, ttl=60)   # In-process
        self.l2 = RedisCache(cluster="redis:6379")       # Distributed
        
    def get(self, key: str):
        # L1: Check local cache (0.1ms)
        value = self.l1.get(key)
        if value is not None:
            return value
        
        # L2: Check Redis (1-5ms)
        value = self.l2.get(key)
        if value is not None:
            self.l1.set(key, value)  # Populate L1
            return value
        
        # DB: Origin fetch (10-100ms)
        value = self.db.get(key)
        if value is not None:
            self.l2.set(key, value)  # Populate L2
            self.l1.set(key, value)  # Populate L1
        
        return value
    
    def invalidate(self, key: str):
        # Invalidate inside-out (L2 first, then L1)
        self.l2.delete(key)
        self.broadcast_l1_invalidation(key)
    
    def broadcast_l1_invalidation(self, key: str):
        # Tell all app instances to clear their L1
        self.pubsub.publish("l1_invalidate", key)
```

**L1 coherence via pub/sub**:
```python
class L1CacheWithCoherence:
    def __init__(self):
        self.local = {}
        self.subscriber = redis.pubsub()
        self.subscriber.subscribe("l1_invalidate")
        threading.Thread(target=self._listen, daemon=True).start()
    
    def _listen(self):
        for message in self.subscriber.listen():
            if message["type"] == "message":
                key = message["data"].decode()
                self.local.pop(key, None)
```

---

### 🔴 Architect — Uber's Caching Architecture

**Uber's scale**: Millions of concurrent trips, real-time location updates.

**Their multi-layer approach**:

```text
┌─────────────────────────────────────────────────────────────┐
│ CDN (Fastly)                                                │
│ - Static assets, map tiles                                  │
│ - TTL: hours-days                                           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Edge Layer (Datacenter-local cache)                         │
│ - Geospatial queries, fare estimates                        │
│ - TTL: minutes                                              │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Service-level Cache (Redis per service)                     │
│ - User profiles, driver states                              │
│ - TTL: seconds-minutes                                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Source of Truth (Databases)                                 │
│ - Cassandra (trip data)                                     │
│ - MySQL (user/driver data)                                  │
└─────────────────────────────────────────────────────────────┘
```

**Special handling for hot data (surge pricing zones)**:
```python
class HotDataCache:
    def __init__(self):
        self.surge_zones = {}  # Local in-memory
        self.refresh_task = asyncio.create_task(self._refresh_loop())
    
    async def _refresh_loop(self):
        while True:
            # Proactively refresh hot data — never expire
            zones = await self.fetch_surge_zones()
            self.surge_zones = zones
            await asyncio.sleep(5)  # Refresh every 5s
    
    def get_surge(self, zone_id: str) -> float:
        # Always hits local cache, never misses
        return self.surge_zones.get(zone_id, 1.0)
```

---

## 8. Real-World Company Case Studies

### Twitter — Timeline Caching

**Challenge**: 500M tweets/day, personalized timelines for 400M users.

**Solution — Fan-out on write with caching**:
```text
Tweet from user with 10M followers:
1. Write to tweet store
2. Fan-out to follower timelines (async)
3. Each timeline is cached list in Redis

Timeline read:
1. Check Redis for precomputed timeline
2. HIT → return instantly
3. MISS → reconstruct from tweets + following
```

**Key insight**: For celebrities, hybrid approach — fan-out on read for users following celebrities.

---

### Instagram — Cache Infrastructure

**Challenge**: 2B+ users, photos with metadata, exploration feed.

**Solution — Memcached at scale**:
- 10+ Memcached clusters
- TAO-style graph caching (like Facebook)
- Cache for: user info, post metadata, explore candidates

**Operational insight**: Cache hit ratio monitoring is critical. A 1% drop = millions more DB queries.

---

### Pinterest — Hybrid Cache Architecture

**Challenge**: Billions of Pins, personalized home feed.

**Solution**:
```text
L1: Local in-process cache (Guava)
    - Hot user sessions
    - TTL: 30 seconds
    
L2: Memcached cluster
    - User preferences, Pin metadata
    - TTL: 5 minutes
    
L3: Redis
    - Real-time features, rate limiting
    - TTL: varies
```

**Key learning**: Different cache tiers for different consistency requirements.

---

## 9. Pattern Recognition — When to Cache

### Signals You Should Cache

| Signal | Why |
|---|---|
| Read/write ratio > 10:1 | Cache benefits reads more than write invalidation costs |
| Repeated identical queries | High hit potential |
| Slow database queries | High latency savings |
| Database under load | Caching offloads traffic |
| Temporal locality | Same data accessed repeatedly in short window |

### Signals You Should NOT Cache

| Signal | Why |
|---|---|
| Unique queries (analytics) | 0% hit ratio |
| Real-time requirements | Any staleness unacceptable |
| Write-heavy workload | Constant invalidation |
| Tiny data / fast DB | Complexity not worth benefit |

### Decision Flowchart

```text
Is the data read more than written?
│
├─ NO → Is write latency critical?
│         │
│         ├─ YES → Consider write-back (with data loss risk)
│         └─ NO → Don't cache
│
└─ YES → Is staleness acceptable?
            │
            ├─ NO → Write-through or don't cache
            │
            └─ YES → Cache-aside with TTL
                      │
                      └─ Is the working set > cache size?
                            │
                            ├─ YES → Accept lower hit ratio
                            │        or increase cache size
                            └─ NO → Expect 90%+ hit ratio
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Cache hit ratio | Hits / (Hits + Misses) — most important metric |
| Cache-aside | App checks cache → miss → DB → populate cache |
| Write-through | Write to cache AND DB synchronously |
| Write-back | Write to cache only, async flush to DB |
| Write-around | Write to DB only, read populates cache |
| LRU | Evict least recently used — Hash map + linked list |
| LFU | Evict least frequently used — for stable popularity |
| TTL | Time-based expiration, independent of eviction |
| Stampede | Mass cache miss → DB overwhelmed |
| Stampede fix | Singleflight/mutex, probabilistic refresh |
| Penetration | Queries for non-existent keys bypass cache |
| Penetration fix | Cache null values, Bloom filter |
| Avalanche | Many keys expire simultaneously |
| Avalanche fix | Jittered TTL |
| Breakdown | Single hot key expires |
| Breakdown fix | Never expire hot keys, background refresh |
| L1 cache | In-process, sub-ms, per-node |
| L2 cache | Distributed (Redis), 1-5ms, shared |
| Invalidation order | L2 first, then L1 |
| Delete vs update | Delete on write — avoids race condition |
| Double-delete | Delete before AND after DB write |
| Redis Cluster | 16384 hash slots distributed across nodes |
| Hash tags | `{user:123}:profile` co-locates on same node |
| Serialization | Protobuf > MessagePack > JSON (speed/size) |
| Cache warming | Proactively populate before traffic hits |
| Circuit breaker | Stop hammering failed cache, use fallback |
| Eviction policy | allkeys-lru (Redis) — most common choice |
