# Interview Questions: Distributed Key-Value Store (Dynamo-Style)

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier concepts.
> Partitioning details live in [consistent hashing](../consistent-hashing/README.md); single-node storage lives in [storage engines](../storage-engines/README.md). This guide assumes you'll cross-reference them.

---

## Level 1 — Requirements & API
*No distributed-systems background required. Pin down the problem before designing.*

**Q1.** In one sentence, what is a key-value store, and what do you give up compared to a relational database to get its scalability?

**Q2.** Define the minimal API: `get(key)` and `put(key, value)`. What must the return values and error semantics of each look like in a system that can be partitioned?

**Q3.** Before designing anything, which three requirements do you nail down with the interviewer, and why does each one change the architecture? Use the illustrative targets (billions of keys, ~1M ops/sec, 99.9% availability).

**Q4.** A colleague says "just put everything in one big Postgres instance with an index on the key." At what point does that break, and what specifically fails first — reads, writes, or storage?

---

## Level 2 — Partitioning
*Where does a key live? Summarize the ring; don't re-derive it.*

**Q5.** How do you decide which node stores a given key across a cluster of hundreds of nodes? Name the technique and the one-sentence reason it beats `hash(key) % N`.

**Q6.** What is a coordinator node? Walk through what happens from the moment a client's `put` lands on an arbitrary node to the moment replicas are chosen.

**Q7.** Why do virtual nodes matter here specifically for a KV store's rebalancing and failure blast radius? (One paragraph — the ring mechanics are covered in the sibling folder.)

**Q8.** A single partition is receiving 50x the traffic of every other partition. Consistent hashing balanced the *key count* evenly — why didn't it fix this, and what is this failure mode called?

---

## Level 3 — Replication
*One copy per key is a guaranteed data-loss design. How do we make N copies?*

**Q9.** What is the "preference list" for a key, and how is it constructed on the ring? Why must it skip virtual nodes that map to a physical machine already in the list?

**Q10.** Contrast synchronous and asynchronous replication for a `put`. What does each choice cost you in latency, durability, and consistency?

**Q11.** For multi-datacenter durability, how do you place the N replicas so that losing an entire datacenter does not lose data or block writes?

**Q12.** A write is acknowledged to the client, then the coordinator crashes before the value propagates to all replicas. What are the possible states of the data now, and how does the system eventually converge?

---

## Level 4 — Tunable Consistency & Quorums
*The knob that makes one KV store serve both a shopping cart and a bank ledger.*

**Q13.** Write the strong-consistency quorum condition using N, W, and R. Explain in one sentence *why* it works, not just that it does.

**Q14.** With N=3, give two (W, R) pairs that provide strong consistency and two that do not. State the tradeoff each pair optimizes for.

**Q15.** What is a sloppy quorum, and how does it differ from a strict quorum? What consistency guarantee do you lose the moment you enable it?

**Q16.** Hinted handoff: where is the hint stored, what triggers its delivery, and what goes wrong if the intended node stays down longer than the hint retention window?

---

## Level 5 — Conflict Resolution
*Two clients wrote the same key during a partition. Now what?*

**Q17.** Last-write-wins (LWW) resolves conflicts by timestamp. Give the concrete failure scenario caused by clock skew, and name a real system that uses LWW anyway and why that's acceptable for it.

**Q18.** What is a vector clock (version vector)? Show how it distinguishes a *causal* update (safe to overwrite) from a *concurrent* update (a real conflict). Include the compare rule.

**Q19.** When two updates are concurrent, the system can return "siblings." What are siblings, who is responsible for resolving them, and what happens if nobody ever does?

**Q20.** What is a CRDT, and how does it eliminate the sibling problem entirely for certain data types? Give one data type it works cleanly for and one where it does not fit.

---

## Level 6 — Anti-Entropy & Failure Detection
*Replicas drift. Nodes die silently. How does the cluster self-heal?*

**Q21.** What is read repair? When does it run, what does it fix, and why is it not sufficient on its own to keep all replicas consistent?

**Q22.** Explain how Merkle trees make replica synchronization cheap. If two replicas differ in 1,000 keys out of 1 billion, roughly how much data must they exchange to find the differences?

**Q23.** Why use a gossip protocol for cluster membership instead of a central coordinator or a config server? What property of gossip makes it fail-tolerant?

**Q24.** A node is under a long GC pause and stops responding for 8 seconds. A fixed 5-second timeout would declare it dead and trigger rebalancing. How does a phi-accrual failure detector avoid this false positive?

---

## Level 7 — Local Storage Engine
*Zoom into one node. How does it persist its share durably and fast? (Summarize; link to the sibling.)*

**Q25.** Trace the write path for a `put` on a single node: commit log, MemTable, SSTable. Why is this design fast for writes specifically?

**Q26.** Trace the read path for a `get` on a single node when the key may be in the MemTable or spread across several SSTables. Where does the Bloom filter fit, and what exactly does it save you?

**Q27.** What is compaction, and what problem is it solving? Name the tradeoff between write amplification and read/space amplification that compaction strategy controls.

**Q28.** A Bloom filter says "key present" but the key is not actually in the SSTable. What is this called, is the reverse possible, and what is the operational consequence of tuning the filter too small?

---

## Level 8 — Architect Tradeoffs
*Design-review depth. Show you know when this whole model is the wrong answer.*

**Q29.** Compare the Dynamo model (leaderless, AP) with the Bigtable/HBase model (leader-per-tablet, CP) and Spanner (CP with TrueTime). For each, name the CAP stance and the one workload it is clearly best for.

**Q30.** Why does the coordinator wait for only W (or R) responses instead of all N? Tie your answer to tail latency and explain what "hedged" or speculative reads add on top.

**Q31.** Do the capacity math for the illustrative targets: billions of keys at ~1 KB each, RF=3. How many nodes do you need, how much replication overhead, and where is your headroom? Show the arithmetic and label assumptions.

**Q32.** Name three situations where a Dynamo-style KV store is the *wrong* choice, and say what you'd use instead for each.

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** The interviewer asks for `get`/`put` only, but the product team will "definitely need to list all keys for a user soon." How do you respond, and what does that requirement do to your partitioning choice?

**QB2.** One key (`config:global`) is read 500,000 times/sec by every service. It's on three replica nodes and they're saturated. Quorums and vnodes don't help. What are your options?

**QB3.** You need to raise the replication factor from 3 to 5 on a live, multi-terabyte cluster serving peak traffic. Walk through the operational steps and the risk at each stage.

**QB4.** Two engineers argue: one wants LWW for simplicity, the other wants vector clocks for correctness. Give the decision rule that tells you which to pick for a given key/value type, without saying "it depends."
