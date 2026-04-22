# Answers: Distributed Caching

> Keyed to [questions.md](./questions.md). Read questions first.
> Every answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Fundamentals & Motivation

### A1. Why caching improves performance

| Without Cache | With Cache |
|---|---|
| Every request hits database | Repeated requests served from memory |
| Database round-trip: 10-100ms | Cache round-trip: 0.1-5ms |
| Database CPU/IO saturated | Load offloaded to cache tier |

**Latency**: Memory access is ~100x faster than disk/network to database.
**Throughput**: Cache can handle 100K+ ops/sec per node; database handles 1K-10K.

```text
Request → [Cache] → HIT → Return (1ms)
                  → MISS → [Database] → Return + cache (50ms)
```

---

### A2. Cache hit vs cache miss

| Event | Definition | What Happens |
|---|---|---|
| Cache Hit | Requested data exists in cache | Return directly from cache (fast) |
| Cache Miss | Requested data not in cache | Fetch from database, optionally populate cache |

```python
def get_user(user_id: str) -> User:
    # Try cache first
    cached = cache.get(f"user:{user_id}")
    if cached:  # HIT
        return deserialize(cached)
    
    # MISS - fetch from database
    user = db.query("SELECT * FROM users WHERE id = ?", user_id)
    
    # Populate cache for next time
    cache.set(f"user:{user_id}", serialize(user), ttl=300)
    return user
```

---

### A3. Average latency calculation

```
Cache hit ratio: 95%
Cache latency: 1ms
Database latency: 50ms

Average latency = (0.95 × 1ms) + (0.05 × 50ms)
                = 0.95ms + 2.5ms
                = 3.45ms
```

Without cache: 50ms average. With 95% cache hit: 3.45ms — a **14x improvement**.

---

### A4. Cache hit ratio importance

**Cache hit ratio** = (cache hits) / (cache hits + cache misses)

| Hit Ratio | Effective Latency (1ms cache, 50ms DB) | Database Load |
|---|---|---|
| 50% | 25.5ms | 50% of requests |
| 90% | 5.9ms | 10% of requests |
| 95% | 3.45ms | 5% of requests |
| 99% | 1.49ms | 1% of requests |

Even small improvements in hit ratio dramatically reduce both latency and database load. A 95% vs 90% hit ratio cuts database load in **half**.

---

## Level 2 — Caching Strategies

### A5. Cache-aside (lazy loading)

The **application** is responsible for cache management. Cache is a side effect.

```text
READ:
Client → App → Cache? 
               → HIT → return
               → MISS → Database → write to cache → return

WRITE:
Client → App → Database → invalidate/delete cache key
```

```python
# Cache-aside read
def get_product(product_id: str) -> Product:
    key = f"product:{product_id}"
    cached = cache.get(key)
    if cached:
        return cached
    product = db.get_product(product_id)
    cache.set(key, product, ttl=3600)
    return product

# Cache-aside write (delete strategy)
def update_product(product_id: str, data: dict):
    db.update_product(product_id, data)
    cache.delete(f"product:{product_id}")  # Invalidate
```

**Pros**: Simple, cache only contains requested data.
**Cons**: First request always slow (miss), potential stale data.

---

### A6. Write-through caching

Writes go to cache **and** database synchronously. Cache is always up-to-date.

```text
WRITE:
Client → App → Cache → Database → return success
```

```python
def update_product(product_id: str, data: dict):
    product = Product(**data)
    
    # Write to both synchronously
    cache.set(f"product:{product_id}", product)
    db.update_product(product_id, data)
    
    return product
```

| Cache-Aside | Write-Through |
|---|---|
| Cache may be stale | Cache always fresh |
| Write latency = DB only | Write latency = cache + DB |
| Simpler | More complex write path |

**Use write-through when**: consistency is critical (inventory, account balances).

---

### A7. Write-back (write-behind) caching

Writes go to cache only. Database is updated **asynchronously** in the background.

```text
WRITE:
Client → App → Cache → return success
        [Background] → Cache → Database (batched/delayed)
```

| Benefit | Risk |
|---|---|
| Lowest write latency | Data loss if cache crashes before DB sync |
| Batches DB writes (efficiency) | Complex recovery logic |

```python
class WriteBackCache:
    def __init__(self):
        self.dirty_keys = set()
    
    def write(self, key: str, value: Any):
        self.cache.set(key, value)
        self.dirty_keys.add(key)
    
    async def flush_to_db(self):  # Background job
        for key in self.dirty_keys:
            value = self.cache.get(key)
            await self.db.write(key, value)
        self.dirty_keys.clear()
```

**Use write-back when**: write throughput matters more than durability (gaming scores, analytics).

---

### A8. Write-around caching

Writes go directly to database, **bypassing** the cache. Cache only populated on read.

```text
WRITE:
Client → App → Database (cache untouched)

READ:
Client → App → Cache MISS → Database → populate cache
```

**Use when**: write-once data that may never be read (logs, audit trails).

---

### A9. Product catalog — cache strategy choice

**Answer: Cache-aside** with TTL-based expiration.

| Factor | Decision |
|---|---|
| Read/write ratio | 1000:1 reads → cache-aside works well |
| Consistency | Stale product info (30s) is acceptable |
| Write simplicity | Don't need write-through complexity |

```python
# Product catalog caching
TTL = 300  # 5 minutes freshness

def get_product(product_id):
    cached = redis.get(f"product:{product_id}")
    if cached:
        return json.loads(cached)
    product = db.get_product(product_id)
    redis.setex(f"product:{product_id}", TTL, json.dumps(product))
    return product
```

---

### A10. User session store — cache strategy choice

**Answer: Write-through** with Redis as primary store.

| Factor | Decision |
|---|---|
| Read/write ratio | Frequent reads AND writes |
| Consistency | Session must always be current |
| Latency needs | Low latency for auth checks |

For sessions, Redis often **is** the primary store (not a cache of DB):

```python
def update_session(session_id: str, data: dict):
    # Redis is the source of truth for sessions
    redis.hset(f"session:{session_id}", mapping=data)
    redis.expire(f"session:{session_id}", 3600)  # 1 hour TTL
```

---

## Level 3 — Eviction Policies

### A11. What is cache eviction

When cache memory is full, old entries must be **evicted** (removed) to make room for new ones.

```text
Cache capacity: 100 entries
Current entries: 100
New write request: need to evict 1 entry first
```

Without eviction, the cache would either:
- Reject new entries (bad)
- Crash from OOM (worse)

---

### A12. LRU (Least Recently Used)

Evict the entry that hasn't been accessed for the longest time.

**Data structure**: Doubly-linked list + Hash map = O(1) access + O(1) eviction.

```python
class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.cache = OrderedDict()  # Python's OrderedDict maintains insertion order
    
    def get(self, key: str):
        if key not in self.cache:
            return None
        self.cache.move_to_end(key)  # Mark as recently used
        return self.cache[key]
    
    def put(self, key: str, value: Any):
        if key in self.cache:
            self.cache.move_to_end(key)
        self.cache[key] = value
        if len(self.cache) > self.capacity:
            self.cache.popitem(last=False)  # Evict least recent
```

---

### A13. LFU (Least Frequently Used)

Evict the entry with the lowest access count.

| Scenario | LRU | LFU |
|---|---|---|
| Popular item accessed 1000x, then idle | Evicted after timeout | Kept (high frequency) |
| New item accessed once | Kept (recent) | Evicted first (low frequency) |

**When LFU is better**: when access patterns are stable and popularity is persistent (e.g., top 100 products).

**When LRU is better**: when access patterns change frequently (e.g., trending topics).

---

### A14. TTL (Time-To-Live)

| Concept | Definition |
|---|---|
| TTL | Fixed time after which entry expires automatically |
| Eviction policy | Removes entries when cache is full |

TTL is **time-based expiration**. Eviction is **space-based removal**.

```python
# TTL: expires after 300 seconds regardless of space
redis.setex("product:123", 300, data)

# Eviction: removed when cache is full and this is LRU
redis.config("maxmemory-policy", "allkeys-lru")
```

Both can happen: an entry can be evicted before TTL, or expire by TTL before eviction.

---

### A15. Cache capacity exceeded

When you have 15GB of hot data and 10GB capacity:

1. Cache operates at capacity, constantly evicting
2. Hit ratio drops as less data fits
3. "Thrashing" if working set is much larger than cache

**Diagnosis**:
```redis
INFO memory
# used_memory: 10.5GB (at limit)
# evicted_keys: 1,234,567 (high eviction rate = thrashing)
```

**Solutions**:
- Increase cache size
- Improve cache key granularity (cache smaller objects)
- Accept lower hit ratio and size database tier accordingly

---

### A16. Single user pushing out others — LRU problem

**Problem**: LRU evicts based on recency, not value. A bot refreshing 100x pushes out other users' data.

**Solutions**:

| Solution | How |
|---|---|
| LFU | Frequent items stay even if not recent |
| Segmented LRU | Hot/warm/cold segments, new items start in cold |
| Per-user quotas | Limit cache entries per user |

Redis `volatile-lfu` and `allkeys-lfu` policies help here.

---

## Level 4 — Redis Deep Dive

### A17. Redis data structures by use case

| Use Case | Data Structure | Why |
|---|---|---|
| User sessions | `HASH` | Store multiple fields (user_id, last_active, etc.) |
| Leaderboards | `SORTED SET (ZSET)` | Score-based ranking with O(log N) operations |
| Rate limiting | `STRING` with `INCR` | Atomic increment, TTL for window reset |
| Activity feed | `LIST` | Push/pop from ends, trim to N items |

```redis
# Session (HASH)
HSET session:abc123 user_id 42 last_active 1711900000
EXPIRE session:abc123 3600

# Leaderboard (SORTED SET)
ZADD leaderboard 1500 "player:42"
ZREVRANGE leaderboard 0 9 WITHSCORES  # Top 10

# Rate limit (STRING)
INCR ratelimit:user:42
EXPIRE ratelimit:user:42 60  # 60-second window

# Activity feed (LIST)
LPUSH feed:user:42 "liked post 123"
LTRIM feed:user:42 0 99  # Keep last 100
```

---

### A18. EXPIRE vs EXPIREAT

| Command | Behavior |
|---|---|
| `EXPIRE key 300` | Expires 300 seconds from now (relative) |
| `EXPIREAT key 1711900000` | Expires at Unix timestamp (absolute) |

**Use EXPIRE**: most cases, simple TTL from current time.
**Use EXPIREAT**: synchronized expiration (e.g., all caches expire at midnight).

---

### A19. Redis Cluster key distribution

Redis Cluster uses **hash slots** (16384 total). Each key is assigned to a slot:

```
slot = CRC16(key) mod 16384
```

Each node owns a range of slots:
```text
Node 1: slots 0-5460
Node 2: slots 5461-10922
Node 3: slots 10923-16383
```

```redis
CLUSTER KEYSLOT "user:123"  # Returns slot number
```

**Hash tags**: `{user:123}:profile` and `{user:123}:settings` hash the same → same node.

---

### A20. Redis deployment modes

| Mode | Description | Use Case |
|---|---|---|
| Standalone | Single node | Development, small datasets |
| Sentinel | Master + replicas + Sentinel monitors | HA without sharding |
| Cluster | Multiple masters, each owning hash slots | HA + horizontal scaling |

```text
Sentinel:           Cluster:
┌─────────┐         ┌────────┐  ┌────────┐  ┌────────┐
│ Master  │         │Master 1│  │Master 2│  │Master 3│
└────┬────┘         └───┬────┘  └───┬────┘  └───┬────┘
     │                  │           │           │
┌────┴────┐  ┌────┐ ┌───┴──┐   ┌───┴──┐   ┌───┴──┐
│Replica 1│  │Rep 2│ │Rep 1a│   │Rep 2a│   │Rep 3a│
└─────────┘  └────┘ └──────┘   └──────┘   └──────┘
```

---

### A21. Redis time complexity

| Command | Complexity |
|---|---|
| `GET key` | O(1) |
| `SET key value` | O(1) |
| `HGET hash field` | O(1) |
| `ZADD zset score member` | O(log N) |
| `ZRANGE zset 0 9` | O(log N + M) where M = items returned |
| `KEYS pattern` | O(N) — **never use in production** |

---

### A22. Redis persistence and crash recovery

| Persistence | How It Works | Data Loss on Crash |
|---|---|---|
| None | No persistence | All data lost |
| RDB | Periodic snapshots to disk | Data since last snapshot |
| AOF | Log every write operation | Depends on fsync setting |
| RDB + AOF | Both | Minimal (AOF for recovery) |

```redis
# RDB: snapshot every 60 seconds if 1000+ keys changed
save 60 1000

# AOF: fsync every second (good balance)
appendonly yes
appendfsync everysec
```

---

## Level 5 — Cache Invalidation

### A23. Why cache invalidation is hard

1. **Distributed state**: Cache and DB are separate systems, can diverge
2. **Race conditions**: Concurrent read/write can restore stale data
3. **Timing**: How long is "stale enough" vs "fresh enough"?
4. **Cascading invalidation**: Update user → invalidate user cache, user's posts cache, followers' feed cache...

---

### A24. Three invalidation approaches

| Approach | How | Freshness | Complexity |
|---|---|---|---|
| TTL-based | Keys expire after fixed time | Eventual (TTL window) | Simple |
| Event-driven | Publish invalidation events on write | Near real-time | Medium |
| Write-through | Cache updated atomically with DB | Immediate | Complex |

```python
# TTL-based (simplest)
cache.setex(key, 300, value)  # Stale up to 5 min

# Event-driven
def update_product(product_id, data):
    db.update(product_id, data)
    pubsub.publish("cache_invalidate", f"product:{product_id}")

# Write-through
def update_product(product_id, data):
    db.update(product_id, data)
    cache.set(f"product:{product_id}", data)  # Atomic intent
```

---

### A25. User sees old profile after update

**Cause**: Cache-aside with async invalidation. User reads from cached stale data.

**Fixes**:

| Fix | How |
|---|---|
| Read-your-own-writes | After write, read from DB for that user's session |
| Synchronous invalidation | Delete cache before returning from write |
| Write-through | Cache and DB updated together |

```python
def update_profile(user_id, data):
    db.update_user(user_id, data)
    cache.delete(f"user:{user_id}")  # Invalidate BEFORE returning
    session.last_write_ts = now()    # Track for read-your-own-writes

def get_profile(user_id):
    if session.last_write_ts > now() - 5:  # Recent write
        return db.get_user(user_id)  # Bypass cache
    return cache_aside_get(user_id)
```

---

### A26. Update cache vs delete cache key

| Strategy | Race Condition | Example |
|---|---|---|
| Update cache | Thread 1 reads old, Thread 2 writes new, Thread 1 writes old to cache | Stale data restored |
| Delete cache | Thread 1 deletes, Thread 2 reads (miss, gets new from DB) | Safe |

```text
UPDATE STRATEGY RACE:
T1: Read DB (old)
                    T2: Write DB (new)
                    T2: Update cache (new)
T1: Update cache (old) ← STALE DATA!

DELETE STRATEGY:
T1: Write DB (new)
T1: Delete cache
T2: Read cache (miss)
T2: Read DB (new) ← CORRECT
```

**Best practice**: Delete cache key on write, don't update.

---

### A27. Double-delete pattern

Delete cache **before** and **after** the database write:

```python
def update_product(product_id, data):
    cache.delete(f"product:{product_id}")  # First delete
    db.update_product(product_id, data)
    time.sleep(0.5)  # Wait for in-flight reads to complete
    cache.delete(f"product:{product_id}")  # Second delete
```

**Why**: Handles the race where a read starts before the write and repopulates cache with stale data after the write completes.

---

## Level 6 — Cache Failure Modes

### A28. Cache stampede (thundering herd)

**Definition**: Many requests simultaneously miss the cache and hit the database.

**Scenario**:
1. Popular cache key expires
2. 1000 concurrent requests all get cache miss
3. All 1000 request the same data from database
4. Database overwhelmed

```text
Key "popular_product:123" expires
   │
   ├─► Request 1: MISS → DB query
   ├─► Request 2: MISS → DB query
   ├─► Request 3: MISS → DB query
   ...
   └─► Request 1000: MISS → DB query
       
Database: 1000 identical queries at once 💥
```

---

### A29. Cache stampede prevention techniques

| Technique | How It Works |
|---|---|
| Lock/Mutex | First request acquires lock, others wait |
| Probabilistic early expiration | Randomly refresh before TTL |
| Background refresh | Async refresh before expiration |

```python
# Mutex approach
def get_with_mutex(key: str):
    value = cache.get(key)
    if value:
        return value
    
    lock_key = f"lock:{key}"
    if cache.set(lock_key, "1", nx=True, ex=5):  # Acquire lock
        try:
            value = db.fetch(key)
            cache.setex(key, 300, value)
        finally:
            cache.delete(lock_key)
        return value
    else:
        time.sleep(0.05)  # Wait and retry
        return get_with_mutex(key)
```

---

### A30. Cache penetration

**Definition**: Requests for keys that **don't exist** in database, bypassing cache every time.

| Normal Miss | Penetration |
|---|---|
| Key exists in DB, not in cache yet | Key doesn't exist in DB |
| Cache populated after first miss | Cache never populated |
| Self-healing | Attack vector |

**Example attack**: Request `user:999999999999` (non-existent) repeatedly → every request hits database.

---

### A31. Preventing cache penetration

| Technique | How It Works |
|---|---|
| Cache null values | Store `NULL` or sentinel for non-existent keys |
| Bloom filter | Check membership before DB query |
| Request validation | Validate key format before lookup |

```python
# Cache null values
def get_user(user_id: str):
    cached = cache.get(f"user:{user_id}")
    if cached == "NULL_MARKER":
        return None  # Known non-existent
    if cached:
        return cached
    
    user = db.get_user(user_id)
    if user:
        cache.setex(f"user:{user_id}", 300, user)
    else:
        cache.setex(f"user:{user_id}", 60, "NULL_MARKER")  # Short TTL
    return user
```

---

### A32. Cache avalanche

**Definition**: Many cache keys expire at the **same time**, causing mass database load.

**Cause**: Setting TTL to round numbers (e.g., all product caches expire at midnight).

**Prevention**:
```python
# Add jitter to TTL
import random

base_ttl = 3600  # 1 hour
jitter = random.randint(0, 300)  # +/- 5 minutes
cache.setex(key, base_ttl + jitter, value)
```

Also: staggered cache warming, rate-limited database queries.

---

### A33. Cache breakdown (hot key problem)

**Definition**: A single very popular key expires, causing stampede for that specific key.

| Avalanche | Breakdown |
|---|---|
| Many keys expire together | One hot key expires |
| Distributed load spike | Concentrated on one DB row/query |

**Mitigations**:
- Never expire hot keys (or very long TTL)
- Mutex/lock for hot key refresh
- Replicate hot keys across multiple cache nodes

```python
# Hot key with no expiration + background refresh
def get_hot_product(product_id: str):
    key = f"hot:product:{product_id}"
    value = cache.get(key)
    
    # Background refresh if getting old
    ttl = cache.ttl(key)
    if ttl < 60:  # Less than 1 minute left
        background_refresh.schedule(key)
    
    return value
```

---

## Level 7 — Multi-Layer Caching

### A34. Multi-layer cache architecture

```text
┌─────────────────────────────────────────────┐
│  L1: In-Process Cache (Caffeine, Guava)     │ ← 0.1ms latency
│  - Per-node, not shared                      │
│  - Very fast, limited by instance memory     │
└───────────────────┬─────────────────────────┘
                    │ MISS
┌───────────────────▼─────────────────────────┐
│  L2: Distributed Cache (Redis, Memcached)   │ ← 1-5ms latency
│  - Shared across all nodes                   │
│  - Network hop required                      │
└───────────────────┬─────────────────────────┘
                    │ MISS
┌───────────────────▼─────────────────────────┐
│  L3: CDN Edge Cache (Cloudflare, Fastly)    │ ← Depends on geo
│  - For static/cacheable HTTP responses       │
│  - Closest to user                           │
└───────────────────┬─────────────────────────┘
                    │ MISS
┌───────────────────▼─────────────────────────┐
│  Database                                    │ ← 10-100ms latency
└─────────────────────────────────────────────┘
```

---

### A35. CDN in multi-layer caching

CDN is **L0** — sits between user and your servers.

| Layer | What It Caches | TTL | Invalidation |
|---|---|---|---|
| CDN | HTTP responses, static assets | Minutes-days | Purge API |
| L1 | Hot objects per server | Seconds-minutes | Local TTL |
| L2 | Shared hot objects | Minutes-hours | Pub/sub or TTL |

CDN works best for: static assets, public pages, API responses with `Cache-Control` headers.

---

### A36. In-process vs distributed cache

| Factor | In-Process (L1) | Distributed (L2) |
|---|---|---|
| Latency | ~0.1ms | ~1-5ms (network) |
| Capacity | Limited by instance memory | Dedicated cache nodes |
| Consistency | Per-node (inconsistent across fleet) | Shared (consistent) |
| Failure isolation | Node crash loses cache | Cache survives app restarts |

```java
// L1: In-process (Caffeine)
Cache<String, Product> localCache = Caffeine.newBuilder()
    .maximumSize(10_000)
    .expireAfterWrite(1, TimeUnit.MINUTES)
    .build();

// L2: Distributed (Redis)
RedisClient redis = RedisClient.create("redis://cache:6379");
```

**Use L1 for**: Ultra-hot data, read-only reference data.
**Use L2 for**: Shared state, larger datasets, write-through scenarios.

---

### A37. Invalidation order in multi-layer cache

**Invalidate inside-out**: L2 first, then L1.

```python
def update_product(product_id: str, data: dict):
    db.update(product_id, data)
    
    # 1. Invalidate L2 (Redis) - shared across all nodes
    redis.delete(f"product:{product_id}")
    
    # 2. Broadcast L1 invalidation to all nodes
    pubsub.publish("l1_invalidate", f"product:{product_id}")

# Each node subscribes to L1 invalidation
def on_l1_invalidate(key: str):
    local_cache.delete(key)
```

**Why this order**: If you invalidate L1 first, a node might repopulate L1 from stale L2.

---

### A38. Cache coherence in multi-node apps

**Problem**: Node A updates DB and its L1 cache. Node B still has stale L1 cache.

**Solutions**:

| Solution | How |
|---|---|
| Short L1 TTL | ~30s, acceptable staleness |
| Pub/sub invalidation | Broadcast invalidation events |
| No L1 for mutable data | Only cache immutable/reference data in L1 |

```python
# Pub/sub invalidation
class CacheInvalidator:
    def __init__(self):
        self.pubsub = redis.pubsub()
        self.pubsub.subscribe("l1_invalidate")
        threading.Thread(target=self._listen).start()
    
    def _listen(self):
        for message in self.pubsub.listen():
            key = message['data']
            local_cache.delete(key)
```

---

## Level 8 — Architect / Production Operations

### A39. Sizing Redis for 1M reads/sec, 100GB data

**Throughput calculation**:
```
Single Redis node: ~100K ops/sec (varies by operation type)
Required: 1M ops/sec
Nodes needed for throughput: 1M / 100K = 10 nodes minimum
```

**Memory calculation**:
```
Data size: 100GB
Per-node memory: 32GB (leave headroom for overhead)
Nodes needed for data: 100GB / 32GB = ~4 nodes minimum
```

**Final sizing**:
```
Throughput-bound: 10 nodes
Data-bound: 4 nodes
Take maximum: 10 nodes

Add replication (1 replica each): 20 nodes total
Redis Cluster with 10 masters + 10 replicas
```

---

### A40. Cache monitoring metrics

| Metric | Why It Matters |
|---|---|
| Hit ratio | Primary effectiveness measure |
| Latency (p50, p99) | Performance impact |
| Memory usage | Capacity planning |
| Eviction rate | Are you under-provisioned? |
| Connection count | Client pool health |
| Keys count | Data volume |
| Commands/sec | Throughput |
| Network I/O | Bandwidth saturation |

```yaml
# Prometheus alerts
- alert: CacheHitRatioLow
  expr: redis_keyspace_hits / (redis_keyspace_hits + redis_keyspace_misses) < 0.9
  for: 5m
  labels:
    severity: warning

- alert: CacheEvictionHigh
  expr: rate(redis_evicted_keys_total[5m]) > 1000
  for: 5m
  labels:
    severity: warning
```

---

### A41. Cache warming

**Definition**: Pre-populating the cache before traffic hits, to avoid cold-start cache misses.

**When to warm**:
- After deployment (new cache nodes)
- After cache flush/failure
- Before anticipated traffic spike (sale, event)

```python
# Cache warming script
async def warm_cache():
    # Get top 10K most accessed products
    popular_products = db.query("""
        SELECT product_id FROM product_views
        GROUP BY product_id ORDER BY count(*) DESC LIMIT 10000
    """)
    
    for product_id in popular_products:
        product = db.get_product(product_id)
        redis.setex(f"product:{product_id}", 3600, serialize(product))
        await asyncio.sleep(0.001)  # Rate limit to avoid DB spike
```

---

### A42. Debugging hit ratio drop (95% → 60%)

| Possible Cause | Diagnostic |
|---|---|
| Cache capacity reduced | Check `INFO memory`, eviction rate |
| Key TTLs shortened | Review recent config changes |
| Traffic pattern changed | Compare key access distribution |
| Cache flush/restart | Check uptime, recent deployments |
| New feature caching differently | Code review recent changes |
| Attack/bot traffic | Check request sources, key patterns |

```redis
# Diagnostic commands
INFO stats
# evicted_keys - high means capacity issue
# keyspace_hits/misses - calculate hit ratio

INFO memory
# used_memory - compare to maxmemory

DEBUG object popular_key
# Check if hot keys exist
```

---

### A43. E-commerce checkout caching design

**What to cache**:

| Data | Cache Strategy | TTL | Consistency |
|---|---|---|---|
| Product catalog | Cache-aside, L1+L2 | 5 min | Eventual OK |
| Product prices | Cache-aside, L2 only | 1 min | Near real-time |
| Inventory count | Write-through | 0 (real-time) | Strong |
| User cart | Redis as primary | Session-based | Strong |
| Shipping rates | Cache-aside | 1 hour | Eventual OK |

**Failure handling**:
```python
class CheckoutCache:
    def get_product(self, product_id: str) -> Product:
        try:
            cached = redis.get(f"product:{product_id}")
            if cached:
                return cached
        except RedisError:
            pass  # Fail-open: continue to DB
        
        return db.get_product(product_id)
    
    def get_inventory(self, product_id: str) -> int:
        # Inventory must be real-time — no cache fallback
        return db.get_inventory(product_id)
```

**Invalidation**: Event-driven via Kafka for price/inventory changes.

---

## Bonus Answers

### QB1. Cache consistency in microservices

**Challenge**: Services A and B both cache "User" data. Service A updates user, Service B has stale cache.

**Solutions**:
- **Event-driven**: Service A publishes `UserUpdated` event, all services invalidate
- **Shared cache**: Both services use same Redis, coordinated invalidation
- **Short TTL + accept staleness**: Design for eventual consistency

---

### QB2. Serialization format impact

| Format | Size | Speed | Schema |
|---|---|---|---|
| JSON | Large | Slow | Schema-less |
| MessagePack | Medium | Fast | Schema-less |
| Protobuf | Small | Fastest | Schema required |

For 1M ops/sec, Protobuf can save significant CPU and network bandwidth.

---

### QB3. Preventing cache as SPOF

1. **Replication**: Redis Sentinel or Cluster with replicas
2. **Fail-open pattern**: On cache failure, queries go to DB (degraded, not down)
3. **Circuit breaker**: Detect cache failures, stop hammering
4. **Multi-region**: Cache in each region, no cross-region dependency

---

### QB4. Read-through vs cache-aside

| Pattern | Who Fetches from DB on Miss |
|---|---|
| Cache-aside | Application code |
| Read-through | Cache library/proxy |

Read-through encapsulates the fetch logic in the cache layer:

```python
# Read-through (cache handles fetching)
cache = ReadThroughCache(loader=lambda key: db.get(key))
value = cache.get("user:123")  # Transparently fetches if miss
```

---

### QB5. Consistent hashing for cache routing

Same concept as database sharding — distribute keys across cache nodes with minimal redistribution on node add/remove.

```python
# Consistent hashing for cache client
hash_ring = ConsistentHashRing(nodes=["cache1", "cache2", "cache3"])

def get_cache_node(key: str) -> str:
    return hash_ring.get_node(key)

def cache_get(key: str):
    node = get_cache_node(key)
    return redis_clients[node].get(key)
```

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Cache hit ratio | Hits / (Hits + Misses) — most important metric |
| Cache-aside | App manages cache; read: check cache → miss → DB → populate |
| Write-through | Write to cache AND DB synchronously |
| Write-back | Write to cache only, async flush to DB (risk: data loss) |
| Write-around | Write to DB only, cache populated on read |
| LRU | Evict least recently used — good for changing access patterns |
| LFU | Evict least frequently used — good for stable popularity |
| TTL | Time-based expiration, independent of eviction |
| Cache stampede | Mass cache miss → DB overwhelmed |
| Stampede fix | Mutex lock, probabilistic early refresh |
| Cache penetration | Queries for non-existent keys bypass cache |
| Penetration fix | Cache null values, Bloom filter |
| Cache avalanche | Many keys expire simultaneously |
| Avalanche fix | Add TTL jitter |
| Cache breakdown | Single hot key expires |
| Breakdown fix | Never expire hot keys, background refresh |
| L1 cache | In-process, ultra-fast, per-node |
| L2 cache | Distributed (Redis), shared across nodes |
| Invalidation order | L2 first, then L1 |
| Redis Cluster | Hash slots (16384), nodes own slot ranges |
| Double-delete | Delete before AND after DB write |
| Cache warming | Pre-populate cache before traffic |
