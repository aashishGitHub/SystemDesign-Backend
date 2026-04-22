# Interview Questions: Distributed Caching

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.

---

## Level 1 — Fundamentals & Motivation
*Goal: verify you understand why caching exists and its basic mechanics.*

**Q1.** Why does caching improve system performance? Explain in terms of latency and throughput.

**Q2.** What is the difference between a cache hit and a cache miss? What happens to the request in each case?

**Q3.** Your database query takes 50ms. With a cache hit ratio of 95% and cache latency of 1ms, what is the average read latency?

**Q4.** What is the "cache hit ratio" and why is it the most important metric for cache effectiveness?

---

## Level 2 — Caching Strategies
*Goal: choose the correct read/write caching pattern per workload.*

**Q5.** What is cache-aside (lazy loading) and how does it work? Draw the read and write flows.

**Q6.** What is write-through caching? When would you choose it over cache-aside?

**Q7.** What is write-back (write-behind) caching? What is its main benefit and main risk?

**Q8.** What is write-around caching? When is it useful?

**Q9.** You have a product catalog that is read 1000x more than written. Which caching strategy do you choose and why?

**Q10.** You have a user session store with frequent reads and writes. Which caching strategy do you choose and why?

---

## Level 3 — Eviction Policies
*Goal: understand how caches decide what to remove when full.*

**Q11.** What is cache eviction and why is it necessary?

**Q12.** Explain LRU (Least Recently Used) eviction. What data structure efficiently implements it?

**Q13.** Explain LFU (Least Frequently Used) eviction. When is it better than LRU?

**Q14.** What is TTL (Time-To-Live) and how does it differ from eviction policies?

**Q15.** You have a cache with 10GB capacity and 15GB of hot data. What happens, and how do you decide what to evict?

**Q16.** A single user refreshes a page 100 times, pushing out other users' data from the cache. Which eviction policy caused this, and how do you fix it?

---

## Level 4 — Redis Deep Dive
*Goal: master Redis as the canonical distributed cache.*

**Q17.** What Redis data structures would you use for: (a) user sessions, (b) leaderboards, (c) rate limiting counters, (d) recent activity feed?

**Q18.** What is the difference between Redis `EXPIRE` and `EXPIREAT`? When do you use each?

**Q19.** How does Redis Cluster distribute keys across nodes? What is a hash slot?

**Q20.** What is the difference between Redis standalone, Sentinel, and Cluster modes?

**Q21.** You run `GET key` and `SET key value` in Redis. What is the time complexity of each?

**Q22.** What happens to cached data when a Redis node crashes? How do RDB snapshots and AOF persistence differ?

---

## Level 5 — Cache Invalidation
*Goal: keep cache and database consistent.*

**Q23.** "There are only two hard things in computer science: cache invalidation and naming things." Why is cache invalidation hard?

**Q24.** What are the three main approaches to cache invalidation? Compare TTL-based, event-driven, and write-through invalidation.

**Q25.** A user updates their profile. 5 seconds later, they see the old version. What went wrong and how do you fix it?

**Q26.** You use cache-aside. When updating a record, should you update the cache or delete the cache key? What's the race condition in each approach?

**Q27.** What is the "double-delete" pattern and when is it used?

---

## Level 6 — Cache Failure Modes
*Goal: prevent and mitigate cache-related outages.*

**Q28.** What is cache stampede (thundering herd)? Give a concrete scenario where it happens.

**Q29.** What are three techniques to prevent cache stampede?

**Q30.** What is cache penetration? How does it differ from a normal cache miss?

**Q31.** How do you prevent cache penetration for non-existent keys?

**Q32.** What is cache avalanche? How do you prevent it?

**Q33.** What is cache breakdown (hot key problem)? How do you mitigate it?

---

## Level 7 — Multi-Layer Caching
*Goal: design caching across multiple tiers.*

**Q34.** What is a multi-layer cache architecture? Describe L1, L2, and L3 caches in a typical web application.

**Q35.** Where does CDN caching fit in a multi-layer cache strategy?

**Q36.** What is an in-process cache (local cache)? When do you use it vs a distributed cache?

**Q37.** You have an L1 local cache and L2 Redis cache. A write happens. In what order do you invalidate, and why?

**Q38.** What is cache coherence in a multi-node application with local caches? How do you maintain it?

---

## Level 8 — Architect / Production Operations
*Goal: design cache infrastructure for scale and reliability.*

**Q39.** How do you size a Redis cluster for 1M reads/sec with 100GB of data?

**Q40.** What metrics should you monitor for a production cache? List at least 6.

**Q41.** What is cache warming? When and how do you do it?

**Q42.** Your cache hit ratio drops from 95% to 60% overnight. What are the possible causes and how do you diagnose?

**Q43.** You're designing a caching layer for an e-commerce checkout flow. Walk through your complete design — which data to cache, which strategy, invalidation approach, and failure handling.

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** How do you handle cache consistency in a microservices architecture where multiple services share cached data?

**QB2.** What is the impact of serialization format (JSON vs Protobuf vs MessagePack) on cache performance?

**QB3.** How do you prevent a cache from becoming a single point of failure?

**QB4.** What is read-through caching (as opposed to cache-aside) and when would you implement it at the cache layer vs application layer?

**QB5.** How does consistent hashing apply to distributed cache node routing?
