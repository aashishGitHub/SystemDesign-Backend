# Teach Script: Distributed Caching

> **What this file is:** a demo-first walkthrough of this topic, built with the "piyush-teach" method — cold open on a broken thing, name the stakes, build the boxes one need at a time, then break it on purpose. **Learn mode**: read this once and understand the system; don't just recognize the vocabulary.
> **Not a replacement for:** [`answers.md`](./answers.md) (the full Q&A grill) or [`deep-dive.md`](./deep-dive.md) (production depth). This is the narrated version.
> **Every number and fact below is pulled from this repo's own [`answers.md`](./answers.md)** — nothing here is a new claim.

---

## 1. The symptom

Your Redis cluster restarts for routine, planned maintenance at 3am. Nobody touched the database. Nobody deployed new code. Within ninety seconds, the database is at 100% CPU, every API request is timing out, and the site is effectively down.

**A cache — a thing whose entire job is to make the database's life easier — just took the whole site offline by going away.** That should feel backwards. The database was working fine an hour ago at the exact same traffic level, cache and all. The only thing that changed is that the thing sitting in front of it, protecting it, briefly stopped existing — and the database immediately couldn't survive on its own. If your caching layer can produce this outcome, you haven't built a cache; you've built a single point of failure wearing a cache's clothing.

## 2. Why you should care

This is one of the most common real production incidents behind a "why is the site down" page, and it happens to systems that were caching *correctly* in every other respect — good hit ratios, sensible TTLs, the works. Whoever owns the caching layer at any read-heavy service (and per this repo's own numbers, most services are read-heavy) eventually owns this exact incident, because it's not a bug in the cache — it's a gap in what the *database* was ever provisioned to handle without it.

## 3. What / Why / How

1. **What is a cache actually doing** between the app and the database?
2. **Why does an absent cache do more than just "slow things down"** — why does it actively crash the database instead of just making it busier?
3. **How do you build a caching layer that's fast when healthy and never worse than having no cache at all when it isn't?**

## 4. Umbrella words — kill them before using them

**"Cache."** Decompose it into the numbers that make it worth building at all: a cache hit costs **~1ms**, a database round trip costs **~50ms** — a real, concrete 50x gap, not a vibe. And the payoff of hit ratio is **non-linear**, worth stating exactly: at 90% hits, average latency is ~5.9ms; at 95%, ~3.45ms; at 99%, ~1.49ms. Going from 95% to 99% doesn't look dramatic on paper — until you notice it **cuts the database's load in half**, because the database only ever sees the miss traffic.

**"Consistency" / "keeping the cache correct."** This word hides four *genuinely different* failure mechanisms that interviews constantly blur together, and telling them apart is the actual skill: a **stampede** (many requests miss the *same* key at the *same* instant), **penetration** (requests for a key that doesn't exist *anywhere*, so caching the real answer is impossible because there is no real answer), an **avalanche** (many *different* keys, all set to expire at the same moment, expire together), and **breakdown** (one single, extremely popular key expires). Four different shapes, four different fixes — reaching for "just add a mutex" fixes exactly one of these four.

**"Invalidation."** Decompose into the three real strategies — TTL-based (simple, bounded staleness), event-driven (near real-time, needs to know every derived key), write-through (immediate, more complex write path) — and one sharp, easy-to-miss detail underneath all three: on a write, do you **update** the cache entry or **delete** it? Updating has a real, provable race (a slow reader can overwrite a fresh value with a stale one it read earlier); deleting doesn't, because the next reader just re-fetches the current truth.

## 5. The boxes — built one need at a time

**The app needs to answer reads far faster than the database can at 1M requests/sec** — a database round trip costs tens of milliseconds; an in-memory answer costs about one. So you put something in front of the database that can answer from memory. That's the **cache**.

```
[ Request ] ──▶ [ Cache? ] ──HIT──▶ return (≈1ms)
                    │
                   MISS
                    ▼
              [ Database ] ──▶ populate cache ──▶ return (≈50ms)
```

**Gap: who's responsible for deciding what's in the cache?** The simplest, most common answer is **cache-aside**: the application checks the cache, and only on a miss does it go to the database and populate the cache for next time. Nothing gets cached that was never actually requested — a nice property, but it means the *first* request for anything is always a miss.

**Gap: a popular cache key just expired, and a thousand requests arrive in the same instant.** Every single one of those thousand requests sees a miss, at the same moment, for the *same* key. Without a guard, all thousand independently query the database for the identical answer, which none of them needed to do 999 times over. That's a **stampede** — not really extra load, *wasted* load: the database is computing the same answer a thousand times when it only needed to compute it once. The fix is a **single-flight lock**: the first request to see the miss acquires a short-lived lock and does the real fetch; every other request either waits briefly for that lock to release (then reads the now-populated cache) or is told to retry shortly — the database gets **one** query, not a thousand.

**Gap: what if the key doesn't exist in the database at all** — someone repeatedly requesting `user:999999999999`? This isn't a stampede; it's **penetration**. Every request is a *guaranteed*, permanent miss, because there is no real answer to cache — the single-flight lock from above doesn't help, because there's nothing productive happening inside that lock either. The fix has to be different: cache the **absence** itself — store a short-TTL "not found" marker — so a repeated request for a nonexistent key gets a fast cached "no" instead of hitting the database every single time.

**Gap: many keys were all given the same nice round TTL** (an hour, or "midnight") — and now they all expire at the same moment, producing a stampede at the scale of the *whole cache*, not one key. That's an **avalanche**. The fix: add random jitter to every TTL, so the population of expiries spreads out over time instead of clustering into one spike.

**Gap: what about the single most popular key on the entire platform** — the equivalent of the home-page banner — expiring? Even with jitter elsewhere, one extremely hot key expiring still concentrates a real stampede onto one row or one query. That's **breakdown**, and the fix is specific to hot keys: don't let this one expire on the normal schedule at all — refresh it in the background before it's ever close to expiring, rather than relying on the same TTL discipline as everything else.

**Now — the gap that produces the symptom from section 1.** Every fix above assumes the cache *itself* is up, and only individual keys (or a subset of them) are missing. What happens when the **entire cache tier disappears** — a planned restart, a crash, a full flush? Every key, for every user, is simultaneously a miss. This isn't a thousand concurrent requests for one key anymore — it's **all of your production traffic, for every key, hitting the database at once**, at full volume, and none of the fixes above apply, because they all operate on individual keys or subsets — none of them address "the whole cache tier is gone."

```
Cache healthy:  Requests ──▶ 95%+ served from cache ──▶ DB sees ~5% of traffic
Cache absent:   Requests ──▶ 100% miss, no exceptions ──▶ DB sees 100% of traffic, instantly
```

**The fix has to live at the database, not the cache.** The database must be explicitly capacity-planned (or protected) for a cold-cache event: a **fail-open pattern** so a cache error doesn't turn into a request failure — it just costs a database round trip instead — combined with something that actively protects the database from receiving its full, un-cached load all at once, like a rate limiter or a circuit breaker in front of it. Without that, a cache whose entire purpose was to protect the database from load becomes, the moment it disappears, the single biggest threat to that same database.

Say the data flow back in one breath, because you'll need to repeat this exact sentence later: **the application checks the cache first and only queries the database on a miss; a missing key is handled per its own failure shape — a single-flight lock for a stampede, a cached "not found" for penetration, jittered TTLs for an avalanche, a never-expiring hot key for breakdown — but a missing *cache tier entirely* is a database-capacity problem that has to be planned for at the database, because none of the per-key fixes apply when there is no cache left to have a key in.**

## 6. What to ignore — where your attention should and shouldn't go

**Copy it, never think about it:** the exact Redis command syntax (`SETEX`, `EXPIRE` vs `EXPIREAT`, `INCR`), the specific 16,384 hash-slot number in Redis Cluster, the exact Prometheus alert YAML for hit-ratio monitoring — useful to know exists, not worth memorizing the spelling of.

**Understand once, then trust it:** the internal data structures behind LRU (doubly-linked list + hash map, O(1) both ways) and LFU — know *when* each wins (LRU for changing access patterns, LFU for stable popularity) without re-deriving the implementation each time; Redis's persistence options (RDB snapshots vs AOF append-log) — know the durability-vs-recovery-time tradeoff exists, you don't need to reimplement either.

**This is the actual idea — think hard here:** (1) on invalidation, **delete, don't update** — updating a cache entry on write has a provable race where a slow reader's stale value can overwrite a fresh one written after it started reading; deleting is safe because the next reader is forced to go get the current truth; (2) the four failure modes — stampede, penetration, avalanche, breakdown — are genuinely different mechanisms, and confusing them (reaching for a mutex to fix penetration, or jitter to fix breakdown) is the actual interview trap; (3) every caching strategy (cache-aside, write-through, write-back) is a different point on the same trade: you are always buying speed by selling some amount of staleness, and the right choice depends on the data, not a global policy; (4) the absence of the whole cache tier is a *database*-capacity question, and it's the one failure mode none of the per-key techniques above can touch.

## 7. The build — the smallest thing that actually shows the mechanism

No real Redis cluster here — this repo's own sizing math (A39) needs ten real nodes at 1M ops/sec, and standing that up locally would teach you `docker compose`, not the mechanism. The one idea from bucket three that's actually about *coordination*, not infrastructure — the single-flight lock that turns a stampede into one database query — is something you can watch happen with real threads, right now:

```python
# save as stampede_demo.py, run with: python3 stampede_demo.py
import threading
import time

db_query_count = 0
count_lock = threading.Lock()

def slow_db_fetch(key):
    """Stands in for a real, somewhat slow database query."""
    global db_query_count
    with count_lock:
        db_query_count += 1
    time.sleep(0.05)
    return f"value-for-{key}"

def naive_get(cache, key):
    """No coordination: every concurrent miss queries the database directly."""
    if key in cache:
        return cache[key]
    value = slow_db_fetch(key)
    cache[key] = value
    return value

refill_locks = {}
refill_locks_guard = threading.Lock()

def single_flight_get(cache, key):
    """Only the FIRST miss queries the database; everyone else waits
    for the lock, then reads the now-populated cache."""
    if key in cache:
        return cache[key]
    with refill_locks_guard:
        lock = refill_locks.setdefault(key, threading.Lock())
    with lock:
        if key in cache:            # someone else already refilled it while we waited
            return cache[key]
        value = slow_db_fetch(key)
        cache[key] = value
        return value

def simulate_stampede(get_fn, concurrent_requests=200):
    cache = {}
    threads = [threading.Thread(target=get_fn, args=(cache, "popular_product:123"))
               for _ in range(concurrent_requests)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

db_query_count = 0
simulate_stampede(naive_get)
print(f"Naive:         200 concurrent misses on the SAME key -> {db_query_count} database queries")

db_query_count = 0
simulate_stampede(single_flight_get)
print(f"Single-flight: 200 concurrent misses on the SAME key -> {db_query_count} database queries")
```

Run it. Two hundred threads miss the exact same key at the exact same moment. The naive version queries the database **200 times** — the stampede, reproduced on your own machine in real time. The single-flight version queries it **exactly once**. The other 199 threads all read the answer the first thread already wrote, instead of independently asking the database the same question.

## 8. The sabotage — break it on purpose, twice

**Sabotage 1 (run it).** Change `concurrent_requests` from `200` to `2000` and rerun. The naive version's database query count scales up linearly with however many requests happen to arrive during the miss — 2000 in, 2000 queries out. The single-flight version's count **stays at exactly 1**, no matter how many threads pile up on the lock, because the mechanism doesn't care how many waiters there are — only how many of them get to actually touch the database. That's the whole argument: single-flight isn't "handles a stampede better," it makes the stampede's *size* irrelevant.

**Sabotage 2 (walk it in your head, no code needed).** Now imagine the entire `cache = {}` dictionary is deleted from the simulation — not one key missing, the whole cache gone, permanently, mid-run. Walk it: every one of the 200 threads sees a miss (there's nothing to hit), and — critically — the single-flight lock **still only protects one key at a time**. With a real production workload hitting thousands of *distinct* keys simultaneously, each key gets its own lock, each lock still only prevents duplicate work *for that one key*, and the database still receives one real query *per distinct key*, all at once. If your traffic touches 50,000 distinct keys a second in steady state, an absent cache means the database receives 50,000 queries a second the moment the cache disappears — single-flight locking doesn't reduce that number at all, because there's no duplication to collapse when every key is genuinely different. **This is exactly why section 5's last fix has to live at the database, not in cleverer per-key cache logic** — no amount of stampede protection helps when the problem isn't duplicate requests for the same key, it's the total absence of any caching at all.

## 9. One-sentence recap

Same words as before, on purpose: **the application checks the cache first and only queries the database on a miss; a missing key is handled per its own failure shape — a single-flight lock for a stampede, a cached "not found" for penetration, jittered TTLs for an avalanche, a never-expiring hot key for breakdown — but a missing cache tier entirely is a database-capacity problem that has to be planned for at the database, because none of the per-key fixes apply when there is no cache left to have a key in.**

## 10. What transfers

Swap Redis for Memcached, or a distributed cache for an in-process one (Caffeine, Guava), and this lesson is unchanged — the exact command syntax and client library are the incidental, swappable pieces. What transfers to **every** system with a cache in front of a database, regardless of vendor: delete-not-update as the safe invalidation primitive; the four named failure modes as genuinely distinct problems needing distinct fixes, not one universal "add caching resilience" gesture; every caching strategy as a deliberate trade of staleness for speed, chosen per data type rather than applied globally; and — the one that produces real outages when it's skipped — **capacity-planning the database for the cache's absence**, because a cache's entire value proposition inverts the moment it goes away if nothing downstream was ever sized to survive that.

---

## Recall check — answer these without scrolling up

1. **Describe the data flow in one sentence.** *(If you can't reproduce the section 9 sentence in your own words, reread section 5.)*
2. **What is each box's job, and what breaks if you delete it?**
   - *Model answers:* delete the single-flight lock → a popular key's expiry becomes a full stampede, every concurrent miss hitting the database independently for the same answer. Delete negative caching (the "not found" marker) → a penetration attack (or just a buggy client repeatedly requesting a bad ID) costs a real database query on every single attempt, forever. Delete database capacity planning for a cold cache → a routine, planned cache restart takes the whole site down, exactly like section 1.
3. **What would you look at first if this got slow, or wrong, in production?** *(Model answer: hit ratio first — a sudden drop from, say, 95% to 60% points at a capacity, TTL, or traffic-pattern change; then eviction rate, because a high eviction rate under a stable hit ratio usually means the cache is undersized for its working set; then whether the failure is on one key [breakdown/stampede], many keys expiring together [avalanche], or the whole tier [the section 1 incident] — because that's what decides which fix applies.)*

If you answered all three cold, go read `answers.md` anyway — this script deliberately skipped multi-layer (L1/L2/CDN) cache architecture, Redis Cluster sizing math, and the double-delete pattern (A15, A34–A39) because piling every idea into one narrative would bury the four that actually matter. Those are the natural next read.
