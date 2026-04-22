# Answers: Social Feed (Twitter / X)

> Keyed to [questions.md](./questions.md). Read questions first.
> Every answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Core Problem

### A1. Naive approach and why it fails

**Naive approach**: When user opens feed, query all tweets from their 200 followees, sort by timestamp, return top 100.

```sql
SELECT * FROM tweets 
WHERE author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
ORDER BY created_at DESC
LIMIT 100;
```

**Why it fails**:
- 500M DAU × 10 feed loads/day = 5B feed loads/day
- Each load fans out to 200 followees
- That's 1 trillion row scans per day
- The IN clause across 200 shards is catastrophically slow
- p99 latency would be 10+ seconds, not 200ms

---

### A2. Read-heavy system optimization

With 1000:1 read-to-write ratio:
- 500M tweets/day = 5,800 writes/sec
- 500B feed reads/day = 5.8M reads/sec

**Optimize for reads**: Pre-compute results at write time. Store materialized timelines. Trade write complexity for read simplicity.

| Ratio | Optimize | Strategy |
|---|---|---|
| 1000:1 read-heavy | Reads | Pre-compute, cache, denormalize |
| 1:1 balanced | Both | Index carefully, cache hot paths |
| 1:1000 write-heavy | Writes | Append-only logs, batch processing |

---

### A3. Fan-out on write vs fan-out on read

| Model | Definition |
|---|---|
| **Fan-out on write** | When user tweets, push tweet ID to all followers' timelines immediately |
| **Fan-out on read** | When user loads feed, pull tweets from all followees at request time |

```text
Fan-out on WRITE:
  User A tweets → Push to 1000 followers' timelines (write-time work)
  User B loads feed → Read pre-computed timeline (fast)

Fan-out on READ:
  User A tweets → Store tweet (fast)
  User B loads feed → Query 200 followees' tweets, merge, sort (read-time work)
```

---

### A4. Celebrity tweet fan-out storm

If a user with 50M followers tweets using fan-out on write:

```text
50,000,000 followers × 1 write per follower = 50M writes
At 100K writes/sec throughput = 500 seconds = 8.3 minutes
```

**Problems**:
- Tweet appears in feeds 8 minutes late for some followers
- Fan-out workers saturated, slowing all other tweets
- Memory queues overflow, causing backpressure
- Uneven follower delivery (early followers see it, late ones don't for minutes)

---

### A5. Pure fan-out on read failure

When user follows 1,000 accounts:

```text
- Query 1000 users' recent tweets
- Scattered across ~1000 shards
- Each query: ~5ms
- Total: 5 seconds (unacceptable)
- Plus sorting and merging 10,000+ tweets
```

**Result**: p99 latency > 5 seconds, users rage-quit the app.

---

## Level 2 — Data Model & Storage

### A6. Core entities

| Entity | Fields | Storage |
|---|---|---|
| **User** | id, username, display_name, follower_count, is_celebrity | PostgreSQL (OLTP) |
| **Tweet** | id, author_id, content, media_urls, created_at, reply_to | Cassandra (write-optimized, sharded by author_id) |
| **Follow** | follower_id, followee_id, created_at | Cassandra or Redis (fast fan-out lookup) |
| **Timeline** | user_id → list of tweet_ids (sorted by time) | Redis Sorted Set |
| **TweetCache** | tweet_id → full tweet object | Redis Hash |

---

### A7. Tweet table sharding

**Partition key**: `author_id`

```text
Shard = hash(author_id) % num_shards
```

**Why author_id**:
- Tweets by same user co-located (efficient "get user's tweets")
- Fan-out workers read all tweets by one user from one shard
- Write amplification avoided (each tweet written once)

**Not tweet_id**: Would scatter one user's tweets across shards, making profile pages slow.

---

### A8. Follow graph storage comparison

| Option | Pros | Cons | Use When |
|---|---|---|---|
| **Relational (PostgreSQL)** | ACID, familiar | Doesn't scale to billions of edges | < 10M users |
| **Graph DB (Neo4j)** | Traversal optimized | Hard to shard | Deep graph queries needed |
| **Wide-column (Cassandra)** | Scales horizontally, fast range queries | No joins | Twitter-scale (billions of edges) |

**Twitter's choice**: Cassandra-style with two tables:
```
follows_by_follower: (follower_id, followee_id) → for "who do I follow?"
follows_by_followee: (followee_id, follower_id) → for "who follows me?"
```

---

### A9. Querying tweets by user in time range

With tweets sharded by `author_id`, query is local to one shard:

```sql
-- Cassandra CQL
SELECT * FROM tweets 
WHERE author_id = ?
AND created_at > ? AND created_at < ?
ORDER BY created_at DESC
LIMIT 100;
```

**Clustering key**: `created_at DESC` for efficient range scans within a partition.

---

### A10. Getting all followers of user X

Create a denormalized table:

```sql
-- follows_by_followee table
CREATE TABLE follows_by_followee (
    followee_id UUID,
    follower_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (followee_id, created_at, follower_id)
);
```

Query: `SELECT follower_id FROM follows_by_followee WHERE followee_id = ?`

This is the fan-out lookup table — "give me everyone who follows this user."

---

### A11. Follow table sharding problems

| Shard By | Query "Who do I follow?" | Query "Who follows me?" |
|---|---|---|
| follower_id only | ✅ Fast (local) | ❌ Scatter-gather across all shards |
| followee_id only | ❌ Scatter-gather | ✅ Fast (local) |
| Both (two tables) | ✅ Fast | ✅ Fast |

**Solution**: Maintain two copies of the relationship (write amplification for read efficiency).

---

## Level 3 — Feed Generation Models

### A12. Fan-out on write step by step

```text
1. User A posts tweet T
2. Tweet Service stores T in Tweets table (shard by A's user_id)
3. Fan-out Service queries follows_by_followee for all of A's followers
4. For each follower F:
   4a. Add T's ID to F's timeline in Redis (ZADD with timestamp as score)
   4b. Trim timeline to max 800 entries (ZREMRANGEBYRANK)
5. Tweet available in followers' feeds immediately on next load
```

```python
# Fan-out worker pseudocode
def fanout_tweet(tweet):
    followers = get_followers(tweet.author_id)
    for follower_id in followers:
        redis.zadd(f"timeline:{follower_id}", {tweet.id: tweet.created_at})
        redis.zremrangebyrank(f"timeline:{follower_id}", 0, -801)  # Keep last 800
```

---

### A13. Fan-out on read step by step

```text
1. User B opens feed
2. Feed Service queries follows_by_follower for all of B's followees
3. For each followee, query their recent tweets (last 24h or last 20 tweets)
4. Merge all tweets into one list
5. Sort by timestamp (or ranking score)
6. Return top 100
```

```python
def get_feed_fan_out_read(user_id):
    followees = get_followees(user_id)
    all_tweets = []
    for followee_id in followees:
        tweets = get_recent_tweets(followee_id, limit=20)
        all_tweets.extend(tweets)
    all_tweets.sort(key=lambda t: t.created_at, reverse=True)
    return all_tweets[:100]
```

---

### A14. Hybrid fan-out model

| User Type | Follower Count | Strategy |
|---|---|---|
| Normal user | < 10K | Fan-out on write |
| Celebrity | >= 10K | Fan-out on read |

**Twitter's actual threshold**: ~10K followers (varies).

```text
When normal user tweets:
  → Push to all followers' timelines (fast, cheap)

When celebrity tweets:
  → Store in celebrity's tweet list only (no fan-out)
  → Followers pull celebrity tweets at read time
```

---

### A15. Merging pushed and pulled tweets

```python
def get_feed_hybrid(user_id):
    # 1. Get pre-computed timeline (pushed tweets from non-celebrities)
    pushed_tweet_ids = redis.zrevrange(f"timeline:{user_id}", 0, 200)
    
    # 2. Get celebrities this user follows
    celebrities = get_followed_celebrities(user_id)
    
    # 3. Fetch recent tweets from each celebrity
    celebrity_tweets = []
    for celeb_id in celebrities:
        tweets = get_recent_tweets(celeb_id, limit=10)
        celebrity_tweets.extend(tweets)
    
    # 4. Merge and sort
    all_tweet_ids = pushed_tweet_ids + [t.id for t in celebrity_tweets]
    all_tweets = hydrate_tweets(all_tweet_ids)
    all_tweets.sort(key=lambda t: t.created_at, reverse=True)
    
    return all_tweets[:100]
```

---

### A16. Redis data structure for timeline

**Redis Sorted Set (ZSET)**:

```bash
# Add tweet to timeline (score = timestamp)
ZADD timeline:user123 1640000000 tweet456

# Get top 100 tweets (most recent first)
ZREVRANGE timeline:user123 0 99

# Remove old tweets (keep only 800)
ZREMRANGEBYRANK timeline:user123 0 -801

# Remove specific tweet (deletion)
ZREM timeline:user123 tweet456
```

**Why Sorted Set**: O(log N) insert, O(log N + M) range query, automatic sorting by score (timestamp).

---

### A17. Storing tweet IDs vs full objects

| Store | Memory per Timeline | Total for 500M users |
|---|---|---|
| Full tweet objects (1KB × 800) | 800 KB | 400 TB |
| Tweet IDs only (8 bytes × 800) | 6.4 KB | 3.2 TB |

**Store IDs**: 125x less memory. Hydrate full tweets from Tweet Cache on read.

---

### A18. Cold start / cache miss handling

```python
def get_feed(user_id):
    timeline = redis.zrevrange(f"timeline:{user_id}", 0, 100)
    
    if not timeline:  # Cache miss
        # Rebuild from source of truth
        followees = get_followees(user_id)
        tweets = []
        for followee_id in followees[:50]:  # Limit fan-out
            tweets.extend(get_recent_tweets(followee_id, limit=20))
        tweets.sort(key=lambda t: t.created_at, reverse=True)
        
        # Repopulate cache asynchronously
        async_rebuild_timeline(user_id, tweets)
        
        return tweets[:100]
    
    return hydrate_tweets(timeline)
```

---

## Level 4 — The Celebrity Problem

### A19. Celebrity problem definition

**Problem**: Accounts with millions of followers make fan-out on write impractical.

| Account | Followers | Fan-out writes per tweet |
|---|---|---|
| Normal user | 500 | 500 |
| Micro-celebrity | 50K | 50,000 |
| Celebrity | 5M | 5,000,000 |
| Mega-celebrity | 100M | 100,000,000 |

**At 100M writes**: Queue depth explodes, workers saturate, latency spikes, timeline freshness degrades for everyone.

---

### A20. Celebrity tweet fan-out time

```text
150M followers
÷ 10K writes/sec (optimistic per worker)
= 15,000 seconds
= 4.2 hours per tweet

With 100 parallel workers:
= 150 seconds = 2.5 minutes
```

**Not acceptable**: User expects tweet to appear instantly. Other users' tweets are delayed while celebrity fan-out hogs resources.

---

### A21. Dynamic celebrity classification

**Static threshold** (simple): `is_celebrity = follower_count > 10000`

**Dynamic classification** (better):

```python
def classify_user(user_id):
    follower_count = get_follower_count(user_id)
    tweet_rate = get_tweets_per_day(user_id)
    
    # High-volume celebrity: many followers + tweets often
    fanout_cost = follower_count * tweet_rate
    
    if fanout_cost > THRESHOLD:  # e.g., 100K fanouts/day
        return "celebrity"  # Use pull model
    return "normal"  # Use push model
```

Store classification in user metadata; recompute daily.

---

### A22. Celebrity tweet fetch at read time

```python
# Store list of celebrities user follows (small set, cached)
CELEB_FOLLOWS_KEY = "celeb_follows:{user_id}"

def get_followed_celebrities(user_id):
    celeb_ids = redis.smembers(f"celeb_follows:{user_id}")
    return celeb_ids

def get_celebrity_tweets(user_id):
    celeb_ids = get_followed_celebrities(user_id)
    tweets = []
    for celeb_id in celeb_ids:
        # Each celebrity's tweets indexed by author_id
        recent = cassandra.execute(
            "SELECT * FROM tweets WHERE author_id = ? ORDER BY created_at DESC LIMIT 10",
            [celeb_id]
        )
        tweets.extend(recent)
    return tweets
```

---

### A23. Celebrity tweet deletion propagation

**Fan-out on write deletion**: Must remove from all followers' timelines (same cost as posting).

**Better approach for celebrities**:
1. Mark tweet as `deleted=true` in Tweets table
2. When feed is loaded, filter out deleted tweets after hydration
3. Periodically clean up stale tweet IDs from timelines (async background job)

```python
def hydrate_tweets(tweet_ids):
    tweets = tweet_cache.mget(tweet_ids)
    return [t for t in tweets if t and not t.deleted]  # Filter deleted
```

---

### A24. User going viral overnight

```python
def handle_follower_milestone(user_id, old_count, new_count):
    CELEBRITY_THRESHOLD = 10000
    
    if old_count < CELEBRITY_THRESHOLD and new_count >= CELEBRITY_THRESHOLD:
        # Transition to celebrity model
        mark_as_celebrity(user_id)
        
        # Stop future fan-out on write
        # Existing timeline entries remain (eventually expire)
        
        # Update all followers' celeb_follows lists
        async_job(update_followers_celeb_list, user_id, "add")
```

Transition is asynchronous; no immediate timeline rebuild required.

---

## Level 5 — Timeline Caching

### A25. Redis Sorted Set operations

```bash
# Data structure: ZSET with score = Unix timestamp

# Add tweet to timeline
ZADD timeline:user123 1704067200 tweet789
# O(log N)

# Remove tweet (delete or unfollow)
ZREM timeline:user123 tweet789
# O(log N)

# Fetch top N most recent
ZREVRANGE timeline:user123 0 99
# O(log N + M) where M = 100

# Fetch with scores (for pagination cursor)
ZREVRANGE timeline:user123 0 99 WITHSCORES

# Trim to keep only last 800
ZREMRANGEBYRANK timeline:user123 0 -801
# O(log N + K) where K = elements removed
```

---

### A26. Timeline cache size

| Items | Bytes per ID | Total | 500M users |
|---|---|---|---|
| 100 | 8 | 800 B | 400 GB |
| 800 | 8 | 6.4 KB | 3.2 TB |
| 10,000 | 8 | 80 KB | 40 TB |

**Sweet spot**: 800 items. Covers ~1 week of content for average user. 3.2 TB fits in a Redis cluster.

---

### A27. Unfollow timeline update

**Option 1 — Synchronous removal** (expensive):
```python
def unfollow(follower_id, followee_id):
    # Remove from follow graph
    remove_follow(follower_id, followee_id)
    
    # Remove all followee's tweets from follower's timeline
    followee_tweets = get_recent_tweet_ids(followee_id, limit=100)
    for tweet_id in followee_tweets:
        redis.zrem(f"timeline:{follower_id}", tweet_id)
```

**Option 2 — Lazy removal** (preferred):
```python
def unfollow(follower_id, followee_id):
    remove_follow(follower_id, followee_id)
    # Don't touch timeline
    
def get_feed(user_id):
    tweet_ids = redis.zrevrange(f"timeline:{user_id}", 0, 200)
    tweets = hydrate_tweets(tweet_ids)
    followees = set(get_followees(user_id))
    # Filter out unfollowed authors
    return [t for t in tweets if t.author_id in followees]
```

---

### A28. Cache eviction policy

| Policy | Behavior | Use Case |
|---|---|---|
| **TTL** | Expire after 7 days of no updates | Inactive users |
| **LRU** | Evict least recently accessed | Memory pressure |
| **No eviction** | Never evict, trim old entries | Active users |

**Strategy**: 
- Trim each timeline to 800 entries on every insert
- Set TTL of 7 days on timeline key (refreshed on any access)
- Rely on Redis LRU for global memory management

---

### A29. Cache warming

**When to warm**:
- User hasn't logged in for >7 days (timeline expired)
- New user signup (empty timeline)
- After cache failure/recovery
- User changes from celebrity → normal (needs push model)

```python
def warm_timeline(user_id):
    followees = get_followees(user_id)
    all_tweets = []
    for followee_id in followees[:100]:  # Limit to avoid overload
        tweets = get_recent_tweets(followee_id, limit=20)
        all_tweets.extend(tweets)
    
    all_tweets.sort(key=lambda t: t.created_at, reverse=True)
    
    pipeline = redis.pipeline()
    for tweet in all_tweets[:800]:
        pipeline.zadd(f"timeline:{user_id}", {tweet.id: tweet.created_at})
    pipeline.execute()
```

---

### A30. Timeline cache vs Tweet cache

| Cache | Key | Value | Purpose |
|---|---|---|---|
| Timeline cache | `timeline:{user_id}` | Sorted Set of tweet IDs | User's personalized feed |
| Tweet cache | `tweet:{tweet_id}` | Full tweet object (JSON) | Avoid DB lookup per tweet |

```text
Feed read flow:
1. Get tweet IDs from timeline cache
2. Hydrate: for each ID, get full tweet from tweet cache
3. Return hydrated tweets sorted
```

**Tweet cache hit rate**: Near 100% for recent tweets (hot data).

---

## Level 6 — Real-Time Updates

### A31. Real-time tweet delivery

```text
1. User A tweets
2. Fan-out Service pushes to followers' timelines (Redis)
3. For each online follower with open WebSocket:
   3a. Publish to user's WebSocket channel
   3b. Client receives new tweet, prepends to UI
```

```python
# Using Redis Pub/Sub for real-time
def fanout_tweet(tweet):
    followers = get_followers(tweet.author_id)
    for follower_id in followers:
        # Update timeline cache
        redis.zadd(f"timeline:{follower_id}", {tweet.id: tweet.created_at})
        # Notify online clients
        redis.publish(f"feed:{follower_id}", json.dumps(tweet))
```

---

### A32. WebSocket vs SSE vs Long Polling

| Method | Direction | Overhead | Best For |
|---|---|---|---|
| WebSocket | Bidirectional | Low (persistent) | Chat, real-time feeds |
| SSE | Server → Client | Low | Notifications, feeds |
| Long Polling | Simulated push | High (new request per update) | Legacy, fallback |

**For feed updates**: SSE is sufficient (server-to-client only). WebSocket if you need bidirectional (e.g., typing indicators, read receipts).

---

### A33. Scaling WebSocket connections

```text
10M concurrent users × 1 WebSocket each = 10M connections

Single server handles ~100K connections (with tuning)
→ Need 100+ WebSocket servers

Session affinity: User must connect to same server for duration
Use consistent hashing: server = hash(user_id) % num_servers
```

Architecture:
```text
Client → Load Balancer (sticky by user_id) → WebSocket Server → Redis Pub/Sub
```

---

### A34. Thundering herd on celebrity tweet

**Problem**: Celebrity tweets → 1M online followers → 1M WebSocket pushes simultaneously.

**Solutions**:

| Strategy | How |
|---|---|
| **Jittered delivery** | Add random delay (0-5s) per user |
| **Batch notifications** | Group updates, send every 1s |
| **Rate limit per celebrity** | Max 100K pushes/second |
| **Degrade to poll** | Under load, skip push, let users poll |

```python
def notify_followers_gradual(tweet, followers):
    for i, batch in enumerate(chunk(followers, 10000)):
        delay = i * 0.5  # 500ms between batches
        schedule_notification(batch, tweet, delay)
```

---

## Level 7 — Ranking & Filtering

### A35. Tweet ranking signals

| Signal | Type | Weight |
|---|---|---|
| Recency | Time decay | High |
| Author engagement | Your history with author (likes, replies) | High |
| Tweet engagement | Total likes, retweets, replies | Medium |
| Author relationship | Close friend vs acquaintance | Medium |
| Content type | Photo/video vs text | Low |
| Negative signals | Muted words, flagged content | Negative |

```python
def score_tweet(tweet, user):
    base = time_decay(tweet.created_at)  # 0.0–1.0
    engagement = author_engagement_score(user, tweet.author_id)  # 0.0–1.0
    viral = min(tweet.like_count / 1000, 1.0)  # Cap at 1.0
    return base * 0.5 + engagement * 0.3 + viral * 0.2
```

---

### A36. Low-latency ranking

**Full ML model per tweet**: 500 tweets × 10ms = 5 seconds. ❌

**Two-stage approach**:
1. **Candidate generation**: Get top 500 from timeline (O(1) from cache)
2. **Lightweight scoring**: Score 500 tweets with simple heuristics (<1ms each)
3. **Optional re-rank**: Top 50 through ML model (50 × 2ms = 100ms)

```python
def rank_feed(user_id):
    candidates = get_timeline(user_id, limit=500)  # Stage 1
    scored = [(t, quick_score(t, user_id)) for t in candidates]  # Stage 2
    scored.sort(key=lambda x: x[1], reverse=True)
    top_50 = scored[:50]
    reranked = ml_model.rerank(top_50, user_id)  # Stage 3 (optional)
    return reranked
```

---

### A37. A/B testing ranking algorithms

```python
def get_feed(user_id):
    experiment = get_user_experiment(user_id)
    
    if experiment == "control":
        return rank_chronological(user_id)
    elif experiment == "treatment_a":
        return rank_engagement_weighted(user_id)
    elif experiment == "treatment_b":
        return rank_ml_model_v2(user_id)
```

**Guardrails**:
- Start with 1% of users
- Define success metrics (time spent, engagement rate)
- Automatic rollback if negative signals spike
- Use holdout group for long-term measurement

---

### A38. Content moderation in feed pipeline

| Timing | What | Examples |
|---|---|---|
| **Write time** | Block egregiously violating content | Spam, CSAM, known malware links |
| **Read time** | Filter context-sensitive content | User's mute list, geo-restrictions |
| **Async** | Deep review, account actions | ML classification, human review |

```text
Tweet created
    │
    ├─ Sync: Spam filter, keyword blocklist → Block or allow
    │
    ├─ Async: ML classifiers → Flag for review
    │
    └─ Read time: Check viewer's mute list, filter flagged content
```

---

## Level 8 — Production Operations

### A39. Tweet storage estimation

```text
500M tweets/day × 1 KB = 500 GB/day
7-day hot storage: 500 GB × 7 = 3.5 TB

With replication factor 3: 10.5 TB hot storage

Cold storage (1 year): 500 GB × 365 = 182.5 TB
→ Move to S3/blob after 7 days
```

---

### A40. Key monitoring metrics

| Metric | Why |
|---|---|
| **Feed latency p99** | Core user experience SLO |
| **Fan-out queue depth** | Backlog indicates capacity issues |
| **Timeline cache hit rate** | Misses = expensive rebuilds |
| **Tweet cache hit rate** | Misses = DB pressure |
| **Fan-out worker lag** | Freshness of pushed timelines |
| **WebSocket connection count** | Capacity for real-time updates |
| **Error rate by endpoint** | Overall health signal |

---

### A41. Circuit breaker for fan-out

```python
class FanoutCircuitBreaker:
    def __init__(self):
        self.queue_depth_threshold = 1_000_000
        self.state = "closed"  # closed, open, half-open
    
    def should_fanout(self, tweet):
        if self.state == "open":
            # Drop low-priority fan-outs, keep celebrities
            return tweet.author.follower_count < 1000
        
        current_depth = get_queue_depth()
        if current_depth > self.queue_depth_threshold:
            self.state = "open"
            alert("Fan-out circuit breaker opened")
            return False
        
        return True
```

**Graceful degradation**: When circuit opens, only fan out for high-follower accounts (ironic reversal — they're the ones users care about most).

---

### A42. Graceful degradation design

| Load Level | Strategy |
|---|---|
| Normal | Full fan-out, real-time updates |
| High | Delay non-celebrity fan-out, batch WebSocket pushes |
| Critical | Disable fan-out, serve cached timelines, disable real-time |
| Emergency | Static "maintenance" page |

```python
def tweet_handler(tweet):
    load_level = get_system_load()
    
    if load_level == "critical":
        # Just store tweet, no fan-out
        store_tweet(tweet)
        return
    
    if load_level == "high":
        if tweet.author.follower_count < 1000:
            queue_delayed_fanout(tweet, delay=60)  # 1 min delay
            return
    
    # Normal operation
    store_tweet(tweet)
    fanout_tweet(tweet)
```

---

## Bonus Answers

### QB1. Protected (private) accounts

- Don't fan out to non-followers (obviously)
- Store `is_protected` flag with tweet
- At read time, verify viewer is a follower before including
- Protected tweets never appear in public search/trending

---

### QB2. Retweets and quote tweets

| Type | Storage | Fan-out |
|---|---|---|
| Retweet | Reference to original tweet_id | Fan-out the reference |
| Quote tweet | New tweet with embedded reference | Fan-out as regular tweet |

Retweets are lightweight (just a reference). Quote tweets are full tweets with an embedded link.

---

### QB3. Bursty write handling (Super Bowl)

- Pre-provision extra fan-out workers before known events
- Implement backpressure: if queue > threshold, throttle non-celebrity tweets
- Use Kafka with high partition count for parallelism
- Shed load if necessary: skip fan-out for inactive users

---

### QB4. Social graph hotspot (FlockDB / TAO)

**Problem**: Celebrities are hot keys — everyone queries their followers/following.

**FlockDB (Twitter)**: Distributed graph store built on MySQL shards. Handles adjacency list fan-out with read replicas for hot nodes.

**TAO (Meta)**: Graph-aware caching layer. Caches hot edges in memory. Persistent store behind cache.

---

### QB5. Cross-device consistency

- All likes/actions go through central API → single source of truth
- WebSocket pushes action acknowledgments to all devices
- On app open, sync state from server (pull latest)
- Use vector clocks or timestamps for conflict resolution

---

### QB6. Mute feature implementation

```python
# Store muted users for each user
MUTED_KEY = "muted:{user_id}"

def mute_user(user_id, muted_user_id):
    redis.sadd(f"muted:{user_id}", muted_user_id)

def get_feed(user_id):
    tweets = get_timeline(user_id)
    muted = redis.smembers(f"muted:{user_id}")
    return [t for t in tweets if t.author_id not in muted]
```

**No timeline modification needed** — filter at read time. Mute list is small (usually <100), so O(1) lookup per tweet.

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Fan-out on write | Push tweet to followers' timelines at write time |
| Fan-out on read | Pull from followees at read time |
| Hybrid fan-out | Push for normal users, pull for celebrities |
| Celebrity threshold | ~10K followers (Twitter's heuristic) |
| Timeline cache | Redis Sorted Set keyed by user_id, scored by timestamp |
| Tweet cache | Redis Hash keyed by tweet_id, stores full object |
| Timeline size | 800 tweet IDs (~6.4 KB per user) |
| Read:write ratio | 1000:1 (optimize for reads) |
| Unfollow handling | Lazy filter at read time, not eager deletion |
| Real-time updates | WebSocket or SSE per user + Redis Pub/Sub |
| Ranking stages | Candidate generation → lightweight scoring → ML re-rank |
| Celebrity tweet deletion | Mark deleted, filter at read time |
| Cache warming | Rebuild timeline for inactive/new users on demand |
| Circuit breaker | Open when queue depth explodes, skip low-priority fan-out |
| Graceful degradation | Disable fan-out, serve stale cache, batch notifications |
