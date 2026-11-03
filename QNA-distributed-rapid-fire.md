# QnA — Distributed systems rapid-fire (say each answer in under a minute)

**1. CAP in one line?**
During a network partition you choose consistency or availability. Without a partition, the real trade-off is latency vs consistency (PACELC).

**2. Strong vs eventual consistency — when each?**
Strong: money, inventory, permissions. Eventual: feeds, likes, view counts, search indexes. Read-your-writes is a useful middle ground for UX.

**3. Vertical vs horizontal scaling?**
Vertical is simpler but has a hard ceiling and a single failure point. Horizontal needs stateless services plus partitioned data. Default: stateless app tier behind a load balancer.

**4. Sharding — how to choose a key?**
High cardinality, even distribution, matches the main access pattern (e.g. `userId`). Avoid hot keys (celebrity users) by adding a suffix/salt or caching. Consistent hashing reduces movement when nodes change.

**5. Replication: leader-follower vs leaderless?**
Leader-follower: simple writes; followers can serve stale reads; failover needs leader election. Leaderless (Dynamo-style): quorum reads/writes with R + W > N for overlap; higher availability, conflict resolution needed.

**6. Cache strategies?**
Cache-aside (most common: read miss → load → set), write-through (consistent, slower writes), write-behind (fast, risks loss). Always set TTLs; plan for invalidation; protect against a stampede with request coalescing or jittered TTLs.

**7. CDN — what does it cache, and how do you bust it?**
Static assets (hashed filenames → cache forever) and cacheable API/HTML with `Cache-Control` / `s-maxage` / `stale-while-revalidate`. Bust with versioned URLs or purge APIs.

**8. Queue vs pub/sub vs stream (SQS vs SNS vs Kafka/Kinesis)?**
Queue: one consumer group takes each message (work distribution). Pub/sub: fan-out to many subscribers. Stream: an ordered, replayable log with partitions and consumer offsets.

**9. Delivery semantics?**
At-most-once (may lose), at-least-once (may duplicate — the usual default), exactly-once (really "effectively once" through idempotent consumers + dedupe keys or transactions). Design consumers to be idempotent.

**10. Idempotency key — how?**
The client sends a unique key per logical operation; the server stores key → result and returns the stored result on retry. Essential for payments and any retried POST.

**11. Rate limiting algorithms?**
Token bucket (allows bursts; most common), leaky bucket (smooth output), fixed window (simple, edge bursts), sliding window log or counter (accurate, costs more). Store counters in Redis, key by user/API key/IP, return 429 + `Retry-After`.

**12. SQL vs NoSQL — how do you decide?**
SQL: relations, transactions, ad-hoc queries. NoSQL (document/KV/wide-column): known access patterns, huge scale, flexible schema. Choose by access patterns and consistency needs, not hype.

**13. How does a database index help, and what does it cost?**
B-tree index: O(log n) lookups and range scans. Costs: slower writes, more storage. Composite index column order matters (leftmost prefix).

**14. Distributed transactions?**
Avoid where possible. 2PC blocks if the coordinator fails. A saga is a chain of local transactions with compensating actions. The outbox pattern writes the event in the same DB transaction, and a relay publishes it.

**15. CDC (change data capture) — why?**
Stream database changes (e.g. from the binlog/WAL or DCP) to other systems — search indexes, caches, real-time UIs — without dual writes.

**16. Long polling vs SSE vs WebSocket at scale?**
SSE: one-way, plain HTTP, auto-reconnect, easy to put behind a load balancer. WebSocket: two-way, sticky connections, harder to scale. Both need a fan-out layer (pub/sub) between app servers.

**17. Back-of-envelope must-knows?**
~86,400 s/day (≈10⁵) · 1M requests/day ≈ 12 RPS average · peak ≈ 2–10× average · read from memory ≈ 100 ns, SSD ≈ 100 µs, same-region round trip ≈ 0.5–1 ms, cross-continent ≈ 100+ ms (approximate, order of magnitude).

**18. How do you make a service resilient?**
Timeouts on every call, retries with exponential backoff + jitter (idempotent calls only), circuit breakers, bulkheads, graceful degradation, health checks, multi-AZ.

**19. What do you monitor?**
RED (rate, errors, duration) for services, USE (utilisation, saturation, errors) for resources, SLOs with error budgets, distributed tracing across hops.

**20. Map a typical design to AWS.**
CloudFront (CDN) → ALB/API Gateway → ECS/EKS/Lambda (stateless) → ElastiCache (Redis) → RDS/Aurora (relational) or DynamoDB (KV) → SQS/SNS/Kinesis/MSK (async) → S3 (blobs) → CloudWatch/X-Ray (observability). IAM least privilege, VPC private subnets.
