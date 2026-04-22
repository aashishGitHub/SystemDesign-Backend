# Interview Questions: Consistent Hashing

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier concepts.

---

## Level 1 — The Core Problem
*No prior distributed systems knowledge required. Think about what breaks first.*

**Q1.** What problem is consistent hashing designed to solve? State it in one sentence without using the word "hashing."

**Q2.** You have 4 cache nodes. You assign keys using `hash(key) % 4`. You add a 5th node. What fraction of all keys must now be remapped to a different node? Show the math.

**Q3.** When the cache cluster remaps keys due to a node addition, what immediate downstream effect does this cause, and why is it potentially catastrophic?

**Q4.** What makes the "mass remapping" problem worse if your cache has a replication factor of 1 vs a replication factor of 3?

---

## Level 2 — The Hash Ring Mechanics
*You understand the problem. Now learn how the ring solves it.*

**Q5.** What is a consistent hash ring? Describe how both nodes and keys are placed on it.

**Q6.** Given nodes A (at position 10), B (at position 120), C (at position 230) on a ring of size 0–359, which node owns key K with `hash(K) = 150`? Which node owns key M with `hash(M) = 80`?

**Q7.** A new node D joins the ring at position 180. Which existing node loses part of its key range? What fraction of all keys move, and which specific range?

**Q8.** Why is the hash space modeled as a *ring* (circular) rather than a linear array from 0 to max_hash?

---

## Level 3 — Virtual Nodes
*The ring alone is not enough. Three points on a circle are rarely evenly spaced.*

**Q9.** With only 3 physical nodes placed once each on a ring, what distribution problem can arise? Give a concrete example of skewed placement.

**Q10.** What are virtual nodes (also called vnodes or tokens)? How do they fix the distribution problem from Q9?

**Q11.** Cassandra uses 256 virtual nodes per physical node by default. If you have 6 nodes, how many positions exist on the ring? Does having 256 vnodes per node guarantee perfectly even load distribution? Why or why not?

**Q12.** What are the tradeoffs of using 500 vnodes per node vs 10 vnodes per node? Name and describe each tradeoff explicitly.

---

## Level 4 — Ring Operations: Joins and Departures
*Static rings are easy. Production rings change constantly.*

**Q13.** Walk through every step when a new cache node joins a consistent hash ring that uses virtual nodes. Include: position selection, data transfer, traffic handoff, and ring state update.

**Q14.** Walk through every step when a cache node leaves the ring gracefully (planned maintenance). How is this different from a crash departure?

**Q15.** A node crashes without warning. Its key range is dark. What happens to read and write requests that land on that key range? Describe the behavior with and without replication.

**Q16.** Why do in-flight requests during a ring rebalance require special handling? What is the recommended approach to ensure requests are not lost during node transitions?

---

## Level 5 — Replication on the Ring
*A cache without replication is a single point of failure per key range.*

**Q17.** How do you replicate data across multiple nodes using the hash ring? What is a "preference list" and how is it constructed?

**Q18.** Write the quorum consistency condition using N, W, and R. A cluster has N=3. Give two valid (W, R) pairs that guarantee strong consistency and one pair that does not.

**Q19.** What is a "sloppy quorum"? When is it used, and what availability/consistency tradeoff does it introduce compared to strict quorum?

**Q20.** A write reaches the coordinator. One replica node is unreachable. The coordinator uses hinted handoff. Explain what hinted handoff does, where the hint is stored, and what happens when the original node recovers.

---

## Level 6 — Real Systems: Cassandra, DynamoDB, Redis Cluster
*Every major distributed storage system has made an explicit choice here.*

**Q21.** Apache Cassandra uses consistent hashing with virtual nodes. What is a "token" in Cassandra's terminology, and how does Cassandra assign tokens to nodes?

**Q22.** Amazon's original Dynamo paper (2007) introduced consistent hashing with vnodes to the industry. How does Dynamo handle node failures to maintain availability without sacrificing durability?

**Q23.** Redis Cluster does NOT use consistent hashing in the traditional ring sense. What mechanism does it use instead? What are the exact tradeoffs vs a ring-based approach?

**Q24.** How does Akamai (and CDN providers generally) use consistent hashing to route HTTP requests to edge cache servers? What property of consistent hashing makes it valuable here?

---

## Level 7 — Failure Modes and Edge Cases
*A senior candidate brings up what breaks before the interviewer asks.*

**Q25.** What is a "hot key" (hot partition)? Consistent hashing distributes keys — why does it not solve the hot key problem?

**Q26.** You have a heterogeneous cluster: 5 nodes with 32GB RAM and 3 nodes with 128GB RAM. If all nodes have the same number of virtual nodes, what goes wrong? How do you fix it?

**Q27.** What is "ring oscillation"? Under what conditions does it occur, and what makes it difficult to detect and diagnose?

**Q28.** Your hash function produces outputs that cluster in one 30% arc of the ring, leaving 70% mostly empty. Describe the two observable symptoms and two ways to detect this in production.

---

## Level 8 — Architect-Level Tradeoffs
*Show design review depth that goes beyond the textbook answer.*

**Q29.** Consistent hashing vs range-based sharding (as used in HBase, Bigtable, CockroachDB): name the primary tradeoff between them and give one scenario where each is clearly the better choice.

**Q30.** What is jump consistent hash? Write the algorithm in pseudocode. How does its time and space complexity compare to ring-based consistent hashing, and what is its key limitation?

**Q31.** Your team needs to migrate a production system from `hash(key) % N` modulo hashing to consistent hashing with zero downtime. Walk through the steps — include how you handle keys being in two places during migration.

**Q32.** An interviewer says "shard by user_id." You recognize this implies consistent hashing. What are the three follow-up questions you must ask before committing to any sharding design?

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** One user_id generates 100x normal traffic. Their key range is on a single node. Consistent hashing got you here — what do you do now?

**QB2.** The most popular key in your cache exceeds one node's memory capacity entirely. No amount of ring manipulation helps. What are your options?

**QB3.** Your team wants to increase the replication factor from 2 to 3 on a live production cluster. Walk through the operational steps and the risks at each stage.

**QB4.** How does consistent hashing behave differently when applied to a cache (read-heavy, ephemeral data) vs a database (write-important, durable data)? Name the key operational difference.
