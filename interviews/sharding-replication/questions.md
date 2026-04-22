# Interview Questions: Database Sharding & Replication

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.

---

## Level 1 — Fundamentals & Motivation
*Goal: verify you understand why a single database node breaks and what scaling knobs exist.*

**Q1.** A single PostgreSQL instance is running out of CPU and disk under 2 billion rows. What are the two categories of scaling available and which one does sharding fall under?

**Q2.** What is the difference between vertical scaling and horizontal scaling, and at what point does vertical scaling become impractical?

**Q3.** What is database sharding? Define it precisely, not colloquially.

**Q4.** If you have a read-heavy workload (10:1 read/write ratio), what is the first thing you add before sharding, and why?

---

## Level 2 — Sharding Strategies
*Goal: choose the correct sharding key and partitioning strategy per workload.*

**Q5.** What are the three main sharding strategies? For each, give one ideal use case and one failure case.

**Q6.** Why is hash-based sharding preferred over range-based sharding for a `user_id` key on a social platform?

**Q7.** What goes wrong if you choose `created_at` (timestamp) as the shard key for an events table with heavy write throughput?

**Q8.** What is a directory-based (lookup) shard router, and what is its main advantage and main weakness over hash-based sharding?

**Q9.** You shard a `posts` table by `user_id`. A celebrity user with 50 million followers writes 10,000 posts per day. What problem does this create and how do you fix it?

**Q10.** What is a compound shard key? When is it used and what are its limitations?

---

## Level 3 — Replication Models
*Goal: understand how data is copied across replicas and what guarantees each model provides.*

**Q11.** Explain leader-follower (primary-replica) replication. What types of operations go where in this model?

**Q12.** What is the difference between synchronous and asynchronous replication? What does each sacrifice?

**Q13.** What is multi-master (multi-primary) replication? When would you choose it over leader-follower, and what new problem does it introduce?

**Q14.** In a leader-follower setup with asynchronous replication, the leader crashes. The follower is promoted. What data is potentially lost and how does this relate to RPO?

**Q15.** What is semi-synchronous replication (used in MySQL)? How does it balance the latency-durability tradeoff?

---

## Level 4 — Consistency, Replication Lag & Anomalies
*Goal: identify what can go wrong with stale reads and how to prevent each anomaly.*

**Q16.** What is replication lag, and how does it cause the "read-your-own-writes" problem? Give a concrete user-visible example.

**Q17.** What are three strategies for ensuring read-your-own-writes consistency without abandoning read replicas entirely?

**Q18.** What is a monotonic read anomaly? How does it happen in a multi-replica setup, and how do you fix it?

**Q19.** A user updates their profile. 200ms later they refresh and see the old version. The replication lag is 500ms. What consistency model are you violating, and what is the cheapest fix?

**Q20.** When must you route reads to the primary (leader) rather than a replica, even under heavy read load on replicas?

---

## Level 5 — Cross-Shard Operations
*Goal: handle queries and transactions that span multiple shards.*

**Q21.** You shard the `orders` table by `user_id`. A business analyst runs: `SELECT COUNT(*) FROM orders WHERE status = 'pending'`. What happens, and what is this called?

**Q22.** What is a distributed join, and why is it expensive in a sharded architecture? What are the two approaches to avoid it?

**Q23.** A payment must debit account A (shard 1) and credit account B (shard 2) atomically. Walk through how Two-Phase Commit (2PC) works here and why it is problematic at scale.

**Q24.** What is the Saga pattern and when is it preferred over 2PC for cross-shard transactions? Name the two Saga variants.

---

## Level 6 — Hot Shards, Re-sharding & Migrations
*Goal: handle growth problems that appear after initial sharding.*

**Q25.** What is a hot shard? Give two different root causes and a specific mitigation strategy for each.

**Q26.** You hash-sharded to 8 shards. Two years later you need 16 shards. Walk through an online re-sharding process with zero downtime.

**Q27.** What is consistent hashing and why does it reduce data movement during re-sharding compared to naive `hash(key) % N`?

**Q28.** What goes wrong if you split a hot shard by creating a new shard and doing a bulk copy without a dual-write phase?

---

## Level 7 — Advanced Patterns
*Goal: connect sharding and replication to real system design patterns.*

**Q29.** What is CQRS (Command Query Responsibility Segregation) and how does it complement a sharded database architecture?

**Q30.** What is Change Data Capture (CDC), how does it work, and in which situations is it preferable to application-level dual-writing?

**Q31.** In a globally distributed system (US, EU, APAC), how does geo-partitioning work and what consistency guarantee does it sacrifice?

**Q32.** Spanner and CockroachDB claim to offer globally consistent, horizontally scalable SQL. What mechanism enables this, and what is the latency cost?

---

## Level 8 — Architect / Design Review
*Goal: make defensible system-wide decisions under production constraints.*

**Q33.** You are designing the data layer for a fintech platform expecting 100M users and 1M transactions/day. Walk through your complete sharding and replication decision — including key choice, number of shards, replication mode, and consistency tier per operation type.

**Q34.** During a design review, a teammate proposes: "We'll shard all tables by `user_id` for consistency." What are the specific problems with applying one shard key universally, and how do you counter this proposal?

**Q35.** Your production cluster has 12 shards. Shard 7 is at 90% disk capacity. The on-call engineer suggests "just delete old data." What is the proper capacity resolution path, and what monitoring should have caught this earlier?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** How do you maintain foreign key integrity and referential consistency when two related records live on different shards?

**QB2.** Your ORM automatically issues `SELECT *` queries on every read. You shard by `user_id` but want to query posts by `created_at` range. What infrastructure changes are needed to avoid full scatter-gather on every query?

**QB3.** How do major databases handle sharding differently: compare PostgreSQL (Citus), MySQL (Vitess), Cassandra, and DynamoDB in terms of how they partition and route data?

**QB4.** What is the "thundering herd" problem in replication and when does it occur after a leader failover?
