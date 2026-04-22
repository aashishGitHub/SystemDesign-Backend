# Deep Dive: Social Feed (Twitter / X)

> Three-tiered depth: 🟢 Phone Screen → 🟡 Onsite → 🔴 Staff+ deep dive

---

## Table of Contents

1. [Fan-Out Models](#1-fan-out-models)
2. [The Celebrity Problem](#2-the-celebrity-problem)
3. [Timeline Caching](#3-timeline-caching)
4. [Data Model & Sharding](#4-data-model--sharding)
5. [Real-Time Updates](#5-real-time-updates)
6. [Ranking & Relevance](#6-ranking--relevance)
7. [Production Operations](#7-production-operations)
8. [Real-World Case Studies](#8-real-world-case-studies)
9. [Quick Recall Cheat Sheet](#cheat-sheet)

---

## 1. Fan-Out Models

### 🟢 Beginner — The Newsletter Analogy

Imagine you write a newsletter. You have 1,000 subscribers.

**Option A (Fan-out on write):** Every time you write a newsletter, your assistant prints 1,000 copies and hand-delivers one to each subscriber's mailbox. Subscribers just open their mailbox — instant delivery.

**Option B (Fan-out on read):** You keep your newsletter in a file cabinet. When a subscriber wants to read it, they drive to your office, dig through your files, and make a copy. They do this every time they want to check for new content.

Option A is more work for you (print 1,000 copies), but subscribers get instant access.
Option B is easy for you (just file it), but subscribers wait in line at your office.

Twitter uses Option A for most users, but for celebrities with millions of followers, printing millions of copies takes too long — so they switch to Option B.

---

### 🟡 Senior — The Mechanics

**Fan-out on write implementation:**

```python
class FanoutOnWriteService:
    def __init__(self, redis, cassandra, follower_dao):
        self.redis = redis
        self.cassandra = cassandra
        self.follower_dao = follower_dao
    
    async def handle_tweet(self, tweet: Tweet):
        # 1. Persist tweet to Cassandra (source of truth)
        await self.cassandra.execute(
            "INSERT INTO tweets (id, author_id, content, created_at) VALUES (?, ?, ?, ?)",
            [tweet.id, tweet.author_id, tweet.content, tweet.created_at]
        )
        
        # 2. Get all followers (paginated for large follower lists)
        async for batch in self.follower_dao.get_followers_batched(tweet.author_id, batch_size=1000):
            # 3. Fan out to each follower's timeline
            pipeline = self.redis.pipeline()
            for follower_id in batch:
                # ZADD with timestamp as score
                pipeline.zadd(f"timeline:{follower_id}", {str(tweet.id): tweet.created_at.timestamp()})
                # Trim to 800 entries
                pipeline.zremrangebyrank(f"timeline:{follower_id}", 0, -801)
            await pipeline.execute()
```

**Fan-out on read implementation:**

```python
class FanoutOnReadService:
    async def get_feed(self, user_id: str, limit: int = 100) -> list[Tweet]:
        # 1. Get all followees
        followees = await self.follow_dao.get_followees(user_id)
        
        # 2. Query each followee's recent tweets (parallel)
        tasks = [
            self.tweet_dao.get_recent_tweets(followee_id, limit=20)
            for followee_id in followees[:200]  # Cap to avoid explosion
        ]
        results = await asyncio.gather(*tasks)
        
        # 3. Flatten and sort
        all_tweets = [tweet for tweets in results for tweet in tweets]
        all_tweets.sort(key=lambda t: t.created_at, reverse=True)
        
        return all_tweets[:limit]
```

**Comparison table:**

| Aspect | Fan-out on Write | Fan-out on Read |
|---|---|---|
| Write latency | O(followers) | O(1) |
| Read latency | O(1) | O(followees) |
| Best for | Low-follower users | High-follower users |
| Memory usage | High (store per-user timelines) | Low |
| Freshness | Instant | Instant |

---

### 🔴 Architect — Capacity Planning & Failure Modes

**Capacity math for fan-out on write:**

```text
Assumptions:
- 500M DAU
- 10% tweet daily = 50M tweets/day
- Average followers: 500
- Celebrity threshold: 10K followers
- 1% users are celebrities (excluded from write fan-out)

Fan-out writes per day:
= 50M tweets × 99% non-celebrity × 500 avg followers
= 24.75 billion timeline writes/day
= 286K writes/sec sustained

Peak (3x sustained):
= 860K writes/sec

Redis cluster sizing:
- 100K writes/sec per shard (conservative)
- Need 9 shards minimum
- With 3x replication = 27 Redis instances
```

**Failure mode 1: Fan-out worker falling behind**

```yaml
# Prometheus alerting rule
- alert: FanoutQueueBacklog
  expr: kafka_consumer_group_lag{consumer_group="fanout-workers"} > 1000000
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Fan-out workers are 1M+ messages behind"
    runbook: |
      1. Check worker health (CPU, memory, network)
      2. Scale up workers horizontally
      3. If persists, enable circuit breaker to drop low-priority fan-outs
```

**Failure mode 2: Hot partition on celebrity follow**

When a celebrity follows someone, that "someone" suddenly becomes hot — everyone wants to see who the celebrity followed.

```text
Mitigation:
1. Cache follow relationships at edge
2. Rate-limit the "who does X follow" API
3. Async refresh for follower lists
```

**Failure mode 3: Timeline cache stampede**

When Redis node fails, thousands of users hit cold cache simultaneously:

```python
class TimelineCacheWithProtection:
    async def get_timeline(self, user_id: str):
        key = f"timeline:{user_id}"
        lock_key = f"lock:rebuild:{user_id}"
        
        timeline = await self.redis.zrevrange(key, 0, 100)
        if timeline:
            return timeline
        
        # Distributed lock to prevent stampede
        acquired = await self.redis.set(lock_key, "1", nx=True, ex=30)
        if not acquired:
            # Another process is rebuilding, wait and retry
            await asyncio.sleep(0.5)
            return await self.redis.zrevrange(key, 0, 100) or []
        
        try:
            # Rebuild timeline
            timeline = await self.rebuild_timeline(user_id)
            return timeline
        finally:
            await self.redis.delete(lock_key)
```

---

## 2. The Celebrity Problem

### 🟢 Beginner — The Stadium Announcement

Imagine you're at a stadium with 100,000 people. A normal person (you) can whisper to the 5 friends sitting next to you — easy.

But when Taylor Swift (on stage) wants to say something, she needs speakers that reach 100,000 people. Setting up those speakers takes time. If she tries to personally walk up and whisper to each person, the concert would last weeks.

So instead, Taylor speaks into the microphone and everyone listens from their seat. She doesn't come to you — you tune in to her.

In Twitter terms: Taylor (celebrity) doesn't push tweets to your timeline. Your timeline pulls her tweets when you open the app.

---

### 🟡 Senior — Hybrid Fan-Out Implementation

```python
class HybridFanoutService:
    CELEBRITY_THRESHOLD = 10_000
    
    async def handle_tweet(self, tweet: Tweet):
        author = await self.user_dao.get_user(tweet.author_id)
        
        # Persist tweet
        await self.persist_tweet(tweet)
        
        if author.follower_count < self.CELEBRITY_THRESHOLD:
            # Normal user: fan-out on write
            await self.fanout_on_write(tweet)
        else:
            # Celebrity: skip fan-out (readers will pull)
            # Just cache the tweet itself
            await self.cache_tweet(tweet)
    
    async def get_feed(self, user_id: str) -> list[Tweet]:
        # 1. Get pre-computed timeline (non-celebrity tweets)
        timeline_ids = await self.redis.zrevrange(f"timeline:{user_id}", 0, 200)
        
        # 2. Get celebrities this user follows
        celebrity_ids = await self.get_followed_celebrities(user_id)
        
        # 3. Pull recent tweets from each celebrity
        celebrity_tweets = []
        for celeb_id in celebrity_ids:
            recent = await self.get_recent_tweets(celeb_id, limit=10)
            celebrity_tweets.extend(recent)
        
        # 4. Merge and sort
        all_ids = list(timeline_ids) + [t.id for t in celebrity_tweets]
        tweets = await self.hydrate_tweets(all_ids)
        tweets.sort(key=lambda t: t.created_at, reverse=True)
        
        return tweets[:100]
    
    async def get_followed_celebrities(self, user_id: str) -> list[str]:
        # Small set cached per user
        cache_key = f"celebrity_follows:{user_id}"
        cached = await self.redis.smembers(cache_key)
        if cached:
            return list(cached)
        
        # Rebuild from follow graph
        followees = await self.follow_dao.get_followees(user_id)
        celebrities = [f for f in followees if await self.is_celebrity(f)]
        
        await self.redis.sadd(cache_key, *celebrities)
        await self.redis.expire(cache_key, 3600)  # 1 hour TTL
        
        return celebrities
```

**Threshold tuning considerations:**

| Threshold | Fan-out writes/day | Celebrity pull queries/read |
|---|---|---|
| 1K | 2.5B | Few |
| 10K | 25B | 10-20 |
| 100K | 250B | 2-5 |

Higher threshold = more writes, faster reads.
Lower threshold = fewer writes, slower reads (more merging).

**Twitter's choice**: ~10K, adjusted dynamically based on system load.

---

### 🔴 Architect — Edge Cases & Production Incidents

**Edge case: User going viral overnight**

```python
class FollowerCountWatcher:
    """
    Background job that detects follower count milestones
    and transitions users between push/pull models.
    """
    async def check_transitions(self):
        # Query users whose follower count crossed threshold
        users = await self.db.query("""
            SELECT user_id, previous_follower_count, current_follower_count
            FROM user_follower_counts
            WHERE (previous_follower_count < 10000 AND current_follower_count >= 10000)
               OR (previous_follower_count >= 10000 AND current_follower_count < 10000)
        """)
        
        for user in users:
            if user.current_follower_count >= 10000:
                await self.transition_to_celebrity(user.user_id)
            else:
                await self.transition_to_normal(user.user_id)
    
    async def transition_to_celebrity(self, user_id: str):
        # 1. Mark user as celebrity in metadata
        await self.user_dao.set_celebrity(user_id, True)
        
        # 2. Stop fan-out for future tweets (automatic via handle_tweet)
        
        # 3. Update all followers' celebrity_follows cache
        # This is expensive but rare
        async for follower_id in self.get_followers_stream(user_id):
            await self.redis.sadd(f"celebrity_follows:{follower_id}", user_id)
```

**Production incident: World Cup 2014 (Twitter)**

During the 2014 World Cup, tweet volume spiked 10x. Fan-out workers couldn't keep up.

**What happened:**
- Queue depth grew from ~100K to 10M+
- Timeline freshness degraded to 15+ minutes
- Users saw stale feeds, thought tweets were lost

**Mitigation applied:**
1. Switched ALL users to fan-out on read temporarily
2. Served cached timelines without live updates
3. Disabled non-essential features (analytics, ads targeting)

**Post-incident changes:**
- Pre-scale workers for known events
- Circuit breaker auto-enables at queue threshold
- Load shedding tiers defined

---

## 3. Timeline Caching

### 🟢 Beginner — The Personal Newspaper

Your timeline is like having a personal newspaper printed just for you every morning. The printer (Redis) keeps a stack of your recent "issues" (800 tweet IDs).

When a friend writes something (tweets), a helper adds it to your newspaper stack. When you wake up (open the app), you just read from your stack — no waiting for the printing press.

If you don't pick up your newspaper for a week, the old stack is thrown away (TTL expires). Next time you visit, a new stack is printed from scratch (cache warming).

---

### 🟡 Senior — Redis Data Structures

**Timeline as Sorted Set:**

```python
class TimelineCache:
    def __init__(self, redis: Redis):
        self.redis = redis
        self.max_size = 800
        self.ttl = 7 * 24 * 3600  # 7 days
    
    async def add_tweet(self, user_id: str, tweet_id: str, timestamp: float):
        key = f"timeline:{user_id}"
        async with self.redis.pipeline() as pipe:
            # Add tweet with timestamp as score
            pipe.zadd(key, {tweet_id: timestamp})
            # Trim to max size
            pipe.zremrangebyrank(key, 0, -self.max_size - 1)
            # Refresh TTL
            pipe.expire(key, self.ttl)
            await pipe.execute()
    
    async def remove_tweet(self, user_id: str, tweet_id: str):
        await self.redis.zrem(f"timeline:{user_id}", tweet_id)
    
    async def get_feed(self, user_id: str, offset: int = 0, limit: int = 20) -> list[str]:
        return await self.redis.zrevrange(
            f"timeline:{user_id}",
            offset,
            offset + limit - 1
        )
    
    async def get_feed_with_cursor(self, user_id: str, max_timestamp: float, limit: int = 20) -> list[tuple]:
        # For pagination: "give me tweets older than X"
        return await self.redis.zrevrangebyscore(
            f"timeline:{user_id}",
            max_timestamp,
            "-inf",
            start=0,
            num=limit,
            withscores=True
        )
```

**Tweet cache (separate from timeline):**

```python
class TweetCache:
    def __init__(self, redis: Redis):
        self.redis = redis
        self.ttl = 24 * 3600  # 24 hours
    
    async def cache_tweet(self, tweet: Tweet):
        key = f"tweet:{tweet.id}"
        await self.redis.hset(key, mapping={
            "id": tweet.id,
            "author_id": tweet.author_id,
            "content": tweet.content,
            "created_at": tweet.created_at.isoformat(),
            "like_count": tweet.like_count,
            "retweet_count": tweet.retweet_count,
        })
        await self.redis.expire(key, self.ttl)
    
    async def get_tweet(self, tweet_id: str) -> Optional[dict]:
        return await self.redis.hgetall(f"tweet:{tweet_id}")
    
    async def hydrate_tweets(self, tweet_ids: list[str]) -> list[dict]:
        # Batch fetch with MGET
        keys = [f"tweet:{tid}" for tid in tweet_ids]
        results = await asyncio.gather(*[self.redis.hgetall(k) for k in keys])
        
        # Filter out cache misses
        tweets = [r for r in results if r]
        
        # Fetch misses from DB and backfill cache
        missing_ids = [tid for tid, r in zip(tweet_ids, results) if not r]
        if missing_ids:
            db_tweets = await self.db.get_tweets(missing_ids)
            for tweet in db_tweets:
                await self.cache_tweet(tweet)
                tweets.append(self.to_dict(tweet))
        
        return tweets
```

---

### 🔴 Architect — Memory Math & Cluster Sizing

**Memory calculation:**

```text
Users: 500M
Active users (have timeline): 200M (40%)
Timeline entries: 800 per user
Entry size: 8 bytes (tweet ID) + 8 bytes (score) + overhead = 20 bytes
Timeline overhead (sorted set): ~40 bytes per timeline

Per-user timeline: 800 × 20 + 40 = 16 KB
Total timeline memory: 200M × 16 KB = 3.2 TB

Tweet cache:
Active tweets (7 days): 500M/day × 7 = 3.5B tweets
Tweet size in cache: 500 bytes average
Total tweet cache: 3.5B × 500 = 1.75 TB

Grand total: ~5 TB Redis memory
```

**Cluster topology:**

```text
Redis Cluster:
- 50 shards × 3 replicas = 150 instances
- 100 GB per instance
- Total capacity: 5 TB with replication headroom

Sharding: Hash slot based on user_id for timelines
          Hash slot based on tweet_id for tweet cache
```

**Failure scenario: Redis master failover**

```yaml
# Runbook for Redis master failure
1. Sentinel detects master down (5 second timeout)
2. Sentinel promotes replica to master (automatic)
3. Application retries READONLY errors (replica lag)
4. Monitor: redis_master_repl_offset gap

Alert if failover takes > 30 seconds:
- Check network partition
- Check replica disk I/O
- Manual intervention may be required
```

---

## 4. Data Model & Sharding

### 🟢 Beginner — The Filing Cabinet System

Imagine Twitter's data as a massive filing cabinet:

- **Drawer 1 (Tweets)**: Each tweet is a file, organized by who wrote it. All of Taylor Swift's tweets are in one folder.
- **Drawer 2 (Users)**: Each user has a profile card.
- **Drawer 3 (Follows)**: Index cards saying "Alice follows Bob."

When you want Taylor's tweets, you go to her folder. Easy.
When you want your timeline, you check your follow cards, then visit each person's folder. Slow.

That's why we pre-build your timeline (Drawer 4) — a folder just for you with copies of everyone's tweets.

---

### 🟡 Senior — Cassandra Schema

```sql
-- Tweets table: partitioned by author, clustered by time
CREATE TABLE tweets (
    author_id UUID,
    tweet_id TIMEUUID,
    content TEXT,
    media_urls LIST<TEXT>,
    created_at TIMESTAMP,
    like_count INT,
    retweet_count INT,
    is_deleted BOOLEAN,
    PRIMARY KEY (author_id, tweet_id)
) WITH CLUSTERING ORDER BY (tweet_id DESC);

-- Create secondary index for tweet lookup by ID
CREATE TABLE tweets_by_id (
    tweet_id TIMEUUID,
    author_id UUID,
    content TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (tweet_id)
);

-- Follow relationships: two tables for bidirectional lookup
CREATE TABLE follows_by_follower (
    follower_id UUID,
    followee_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE follows_by_followee (
    followee_id UUID,
    follower_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (followee_id, follower_id)
);
```

**Query patterns:**

```python
# Get user's tweets (efficient: single partition)
SELECT * FROM tweets WHERE author_id = ? ORDER BY tweet_id DESC LIMIT 20;

# Get user's followers (efficient: single partition)
SELECT follower_id FROM follows_by_followee WHERE followee_id = ?;

# Get who user follows (efficient: single partition)
SELECT followee_id FROM follows_by_follower WHERE follower_id = ?;

# Anti-pattern: Get tweet by ID (requires secondary table)
# Don't use: SELECT * FROM tweets WHERE tweet_id = ? (scatter query)
SELECT * FROM tweets_by_id WHERE tweet_id = ?;
```

---

### 🔴 Architect — Hot Partition Mitigation

**Problem**: Celebrity's tweets partition is extremely hot.

```text
Elon Musk: 150M followers
When he tweets, 150M users load his profile/tweets
Single partition getting 150M reads = HOT
```

**Solution 1: Read replicas with load balancing**

Cassandra allows reading from replicas. Configure `LOCAL_QUORUM` for writes but `LOCAL_ONE` for reads.

**Solution 2: Bucketed partitioning**

```sql
CREATE TABLE tweets_bucketed (
    author_id UUID,
    bucket INT,  -- 0-99, derived from hash(tweet_id) % 100
    tweet_id TIMEUUID,
    content TEXT,
    PRIMARY KEY ((author_id, bucket), tweet_id)
);
```

Spreads one author's tweets across 100 partitions. Fan out reads across buckets.

**Solution 3: Caching layer**

Celebrity tweets are hot → cache aggressively at edge:

```python
class CelebrityTweetCache:
    async def get_celebrity_tweets(self, author_id: str, limit: int):
        cache_key = f"celeb_tweets:{author_id}"
        
        # Check distributed cache (CDN-level)
        cached = await self.cdn_cache.get(cache_key)
        if cached:
            return cached
        
        tweets = await self.db.get_tweets(author_id, limit)
        
        # Cache with short TTL (tweets change frequently)
        await self.cdn_cache.set(cache_key, tweets, ttl=60)
        
        return tweets
```

---

## 5. Real-Time Updates

### 🟢 Beginner — The Town Crier

In old towns, a town crier would shout news in the square. If you were there, you heard it. If you were home, you'd find out later.

WebSockets are like giving everyone a walkie-talkie. Whenever news happens, the crier broadcasts to all walkie-talkies. You hear it instantly, wherever you are.

Long polling is like repeatedly asking the crier: "Any news? Any news? Any news?" Annoying and wasteful.

---

### 🟡 Senior — WebSocket Architecture

```python
# WebSocket server with Redis Pub/Sub
import asyncio
import aioredis
from fastapi import FastAPI, WebSocket

app = FastAPI()
redis = aioredis.from_url("redis://localhost")

class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, WebSocket] = {}
    
    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        
        # Subscribe to user's feed channel
        pubsub = redis.pubsub()
        await pubsub.subscribe(f"feed:{user_id}")
        
        # Listen for messages
        asyncio.create_task(self.listen_to_feed(user_id, pubsub, websocket))
    
    async def listen_to_feed(self, user_id: str, pubsub, websocket: WebSocket):
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_json(json.loads(message["data"]))
    
    def disconnect(self, user_id: str):
        self.active_connections.pop(user_id, None)

manager = ConnectionManager()

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await manager.connect(user_id, websocket)
    try:
        while True:
            # Keep connection alive with ping/pong
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(user_id)
```

**Fan-out to WebSocket:**

```python
async def fanout_tweet_realtime(tweet):
    followers = await get_online_followers(tweet.author_id)
    
    for follower_id in followers:
        # Publish to user's channel
        await redis.publish(
            f"feed:{follower_id}",
            json.dumps({
                "type": "new_tweet",
                "tweet": tweet.to_dict()
            })
        )
```

---

### 🔴 Architect — Scaling WebSocket Infrastructure

**Connection math:**

```text
DAU: 500M
Concurrent users (10% of DAU): 50M
WebSocket connections per server: 100K (optimized)
Servers needed: 500

With 3x redundancy: 1,500 WebSocket servers
```

**Architecture:**

```text
┌─────────────────────────────────────────────────────────────┐
│                    WebSocket Cluster                        │
└─────────────────────────────────────────────────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    ▼                      ▼                      ▼
┌─────────┐          ┌─────────┐          ┌─────────┐
│ WS Pool │          │ WS Pool │          │ WS Pool │
│ (100    │          │ (100    │          │ (100    │
│ servers)│          │ servers)│          │ servers)│
└─────────┘          └─────────┘          └─────────┘
    │                      │                      │
    └──────────────────────┼──────────────────────┘
                           ▼
                    ┌─────────────┐
                    │   Redis     │
                    │   Pub/Sub   │
                    │   Cluster   │
                    └─────────────┘
                           │
                    ┌──────┴──────┐
                    │   Fan-out   │
                    │   Workers   │
                    └─────────────┘
```

**Failure mode: Redis Pub/Sub partition**

If some WebSocket servers can't connect to Redis:
- Users on those servers stop receiving updates
- No data loss (timeline cache still accurate)
- Users refresh to get latest

**Mitigation:**
- Multi-region Redis with failover
- Fallback to polling if WebSocket disconnects 3x

---

## 6. Ranking & Relevance

### 🟢 Beginner — The Smart Newspaper Editor

Imagine your newspaper editor knows you love sports and hate politics. Instead of putting articles in order they were written, the editor puts sports on page 1 and buries politics in the back.

Twitter's ranking algorithm is that editor. It looks at what you like, who you interact with, and puts interesting tweets first — even if they're a few hours old.

---

### 🟡 Senior — Two-Stage Ranking

```python
class FeedRanker:
    def __init__(self, ml_model):
        self.ml_model = ml_model
    
    async def rank_feed(self, user_id: str, candidates: list[Tweet]) -> list[Tweet]:
        # Stage 1: Lightweight scoring (all candidates)
        scored = [
            (tweet, self.quick_score(tweet, user_id))
            for tweet in candidates
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        
        # Stage 2: ML re-ranking (top N only)
        top_candidates = [t for t, _ in scored[:50]]
        if self.ml_model:
            features = await self.extract_features(user_id, top_candidates)
            ml_scores = self.ml_model.predict(features)
            top_candidates = [
                t for t, _ in sorted(
                    zip(top_candidates, ml_scores),
                    key=lambda x: x[1],
                    reverse=True
                )
            ]
        
        return top_candidates
    
    def quick_score(self, tweet: Tweet, user_id: str) -> float:
        # Time decay: newer = higher score
        age_hours = (datetime.now() - tweet.created_at).total_seconds() / 3600
        time_score = 1 / (1 + age_hours ** 0.5)  # Decay curve
        
        # Engagement score
        engagement = (
            tweet.like_count * 1.0 +
            tweet.retweet_count * 2.0 +
            tweet.reply_count * 1.5
        )
        engagement_score = min(engagement / 1000, 1.0)  # Cap at 1
        
        # Author affinity (cached per user)
        affinity = self.get_author_affinity(user_id, tweet.author_id)
        
        return (
            time_score * 0.4 +
            engagement_score * 0.3 +
            affinity * 0.3
        )
```

**Feature extraction for ML model:**

```python
async def extract_features(self, user_id: str, tweets: list[Tweet]) -> np.ndarray:
    features = []
    for tweet in tweets:
        f = {
            # Tweet features
            "tweet_age_hours": ...,
            "like_count": tweet.like_count,
            "retweet_count": tweet.retweet_count,
            "has_media": int(bool(tweet.media_urls)),
            "content_length": len(tweet.content),
            
            # Author features
            "author_follower_count": ...,
            "author_is_verified": ...,
            
            # User-author interaction features
            "user_liked_author_tweets": ...,
            "user_replied_to_author": ...,
            "mutual_follow": ...,
        }
        features.append(list(f.values()))
    return np.array(features)
```

---

### 🔴 Architect — ML Model Deployment

**Model serving architecture:**

```text
Feed Service
     │
     ▼
┌─────────────────┐
│  Feature Store  │ ← Pre-computed user/author features
│  (Redis)        │
└─────────────────┘
     │
     ▼
┌─────────────────┐
│  Model Serving  │ ← TensorFlow Serving / Triton
│  (gRPC)         │
└─────────────────┘
```

**Latency budget:**

```text
Total feed latency: < 200ms p99

Breakdown:
- Timeline cache read: 5ms
- Celebrity tweet fetch: 30ms (parallel)
- Feature extraction: 20ms
- ML inference (50 tweets): 20ms
- Hydration: 30ms
- Serialization: 5ms
- Network: 20ms
─────────────────────────────
Total: ~130ms (with buffer)
```

**A/B testing infrastructure:**

```python
class ExperimentRouter:
    def get_ranking_variant(self, user_id: str) -> str:
        # Consistent hashing for stable assignment
        bucket = hash(user_id) % 100
        
        if bucket < 1:
            return "holdout"  # 1% never see new features
        elif bucket < 5:
            return "treatment_a"  # New ML model v2
        elif bucket < 10:
            return "treatment_b"  # Engagement-weighted
        else:
            return "control"  # Production
```

---

## 7. Production Operations

### 🟢 Beginner — The Air Traffic Control Tower

Running Twitter is like managing a busy airport. Thousands of planes (tweets) take off every second. Controllers (monitoring) watch for problems. If a storm comes (traffic spike), some flights are delayed (rate limited).

If the tower loses power (outage), planes circle (cache hits) while backup generators start (failover).

---

### 🟡 Senior — Monitoring Dashboard

**Key metrics:**

```yaml
# Grafana dashboard panels
- panel: Feed Latency
  query: histogram_quantile(0.99, rate(feed_latency_bucket[5m]))
  alert: > 200ms

- panel: Fan-out Queue Depth
  query: kafka_consumer_group_lag{group="fanout-workers"}
  alert: > 1M messages

- panel: Timeline Cache Hit Rate
  query: rate(redis_hits[5m]) / (rate(redis_hits[5m]) + rate(redis_misses[5m]))
  alert: < 95%

- panel: WebSocket Connections
  query: sum(websocket_active_connections)
  alert: Drop > 20% in 1 minute

- panel: Tweet Write Latency
  query: histogram_quantile(0.99, rate(tweet_write_latency_bucket[5m]))
  alert: > 100ms
```

---

### 🔴 Architect — Incident Playbooks

**Incident: Fan-out workers 2M messages behind**

```markdown
## Runbook: Fan-out Backlog Critical

### Symptoms
- Fan-out queue depth > 1M
- Timeline freshness degraded > 5 minutes
- User complaints: "tweets not showing"

### Immediate Actions
1. Scale fan-out workers:
   kubectl scale deployment fanout-worker --replicas=200

2. If scaling insufficient, enable circuit breaker:
   curl -X POST ops.internal/circuit-breaker/fanout/open

3. Circuit breaker behavior:
   - Skip fan-out for users with < 100 followers
   - These tweets still stored; users see on refresh

### Resolution Verification
- Queue depth < 100K
- Timeline freshness < 30 seconds
- Close circuit breaker when stable for 15 minutes
```

**Incident: Redis cluster node failure**

```markdown
## Runbook: Redis Cluster Node Down

### Symptoms
- Redis node unreachable
- Increased timeline cache misses in affected slot range
- Feed latency spike p99 > 500ms

### Immediate Actions
1. Verify automatic failover occurred:
   redis-cli -c CLUSTER INFO | grep cluster_state

2. If failover stuck:
   redis-cli -c CLUSTER FAILOVER FORCE

3. Monitor replica catch-up:
   redis-cli -c INFO replication

### Post-Incident
- Add replacement node
- Rebalance cluster slots if needed
- Update capacity buffer (should handle N+1 failures)
```

---

## 8. Real-World Case Studies

### Twitter's Evolution (2010–2020)

**2010**: Pure fan-out on write. Worked fine at 100M users.

**2012**: "Fail whale" incidents during major events. Introduced hybrid model.

**2013**: Deployed FlockDB for graph storage. Open-sourced it.

**2015**: Moved to managed Kafka clusters for fan-out queue.

**2018**: Introduced algorithmic timeline ("Best Tweets First").

**2020**: Real-time event processing with Heron (homebuilt stream processing).

**Key lesson**: Started simple, added complexity only when scale demanded.

---

### Meta's News Feed

**TAO**: Graph-aware caching layer. 99.8% cache hit rate for social graph queries.

**Aggregated feed**: Unlike Twitter's tweet-centric model, Facebook aggregates (groups multiple likes, comments into single story).

**Edge rank**: Original ranking algorithm (Affinity × Weight × Time Decay).

**ML evolution**: Now uses thousands of features, real-time inference.

---

### LinkedIn's Feed

**Hybrid**: Similar to Twitter — push for most, pull for influencers.

**Relevance vs Recency**: Heavily weighted toward relevance (professional content ages slower).

**Follow graph**: Explicitly separates "connect" (mutual) from "follow" (one-way).

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Fan-out on write | Push tweet to followers' timelines at write time |
| Fan-out on read | Pull from followees at read time |
| Hybrid fan-out | Push for <10K followers, pull for celebrities |
| Celebrity threshold | ~10K followers (Twitter heuristic) |
| Timeline cache | Redis Sorted Set, user_id → 800 tweet IDs |
| Tweet cache | Redis Hash, tweet_id → full tweet object |
| Timeline size | 800 entries × 16 bytes = 12.8 KB per user |
| Read:write ratio | 1000:1 — optimize for reads |
| Unfollow handling | Lazy filter at read time |
| Real-time updates | WebSocket + Redis Pub/Sub |
| Celebrity deletion | Mark deleted, filter at read time |
| Cache warming | Rebuild on cache miss (async) |
| Ranking stages | Candidates → quick score → ML top-50 |
| Graceful degradation | Disable fan-out, serve stale cache |
| Sharding key (tweets) | author_id (co-locate user's tweets) |
| Sharding key (follows) | Two tables: by follower, by followee |
| Hot partition fix | Bucketing, read replicas, caching |
| Fan-out throughput | ~300K writes/sec sustained |
| Timeline memory | 200M users × 16 KB = 3.2 TB |
| WebSocket scale | 100K connections per server |
