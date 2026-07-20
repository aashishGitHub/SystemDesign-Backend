# Interview Questions: Distributed Consensus & Coordination

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier concepts.

---

## Level 1 — The Core Problem
*No prior distributed systems knowledge required. Think about what breaks first.*

**Q1.** What problem does distributed consensus solve? State it in one sentence without using the word "consensus."

**Q2.** You run two application servers and want exactly one of them to be the "active" leader. You store a row `is_leader = true` in a shared SQL database and let whichever node sets it first be leader. Name two distinct ways this can still end up with two nodes both believing they are leader.

**Q3.** What is "split-brain," and why is it specifically dangerous for a leader-election or a lock, compared to, say, a read-only cache?

**Q4.** "Just put one coordinator node in charge of all decisions — that guarantees a single source of truth." What is the fatal flaw in this design, and what goes wrong the moment that coordinator has a long GC pause?

---

## Level 2 — The Replicated State Machine Model
*Every coordination problem is really one problem in disguise.*

**Q5.** What is the replicated state machine (RSM) model? Why is an ordered **log** the primitive, rather than replicating the current state directly?

**Q6.** For the RSM model to keep all replicas identical, what property must every command in the log have? Give one example of a command that violates it and how you fix it.

**Q7.** Reframe each of these coordination needs as the same underlying problem: (a) electing one leader, (b) a distributed lock, (c) storing cluster config, (d) tracking group membership.

**Q8.** What goes wrong if two replicas apply the same set of log entries but in a **different order**? Why does agreeing on order matter as much as agreeing on content?

---

## Level 3 — Paxos
*The foundational algorithm. Understand the safety argument, not just the message names.*

**Q9.** In single-decree Paxos, name the three roles and the two phases. What does each phase accomplish?

**Q10.** Why does Paxos require a **majority** quorum specifically (not any two nodes, not all nodes)? State the intersection property that makes it safe.

**Q11.** What is a proposal number (ballot) in Paxos, and what promise does an acceptor make when it responds to a `prepare(n)`? What does this prevent?

**Q12.** Single-decree Paxos agrees on one value. Real systems need a whole log of values. What is Multi-Paxos, and what is the single most important optimization it adds over running basic Paxos per log slot?

---

## Level 4 — Raft
*Designed for understandability. You should be able to whiteboard it.*

**Q13.** Raft was introduced (Ongaro & Ousterhout, 2014) explicitly to be more understandable than Paxos. What is a **term** in Raft, and what two roles does the term number serve?

**Q14.** Walk through Raft leader election: what triggers it, how a candidate wins, and how Raft prevents two leaders in the same term.

**Q15.** Describe Raft log replication end to end: from a client command arriving at the leader to the entry being considered **committed**. When exactly does the leader tell the client "success"?

**Q16.** What is the Log Matching Property in Raft, and how does the `AppendEntries` consistency check (prevLogIndex / prevLogTerm) enforce it? What does the leader do when a follower rejects an `AppendEntries`?

**Q17.** A candidate has a shorter/older log than a follower. Raft's election restriction must stop it from becoming leader. What is the rule, and what disaster does it prevent?

---

## Level 5 — Failure Modes & Theory
*A senior candidate brings up what breaks before the interviewer asks.*

**Q18.** State the FLP impossibility result in plain language. If consensus is "impossible," how do Paxos and Raft exist and work in practice?

**Q19.** What is the Two Generals Problem, and how is the impossibility it describes different from FLP? Which one is about the network and which is about process crashes?

**Q20.** A 5-node Raft cluster splits 3-2 by a network partition. What happens in the majority side? What happens in the minority side? Which one can accept writes?

**Q21.** Why does Raft use **randomized** election timeouts? What specific failure does randomization prevent, and what would happen with a fixed timeout?

**Q22.** Two nodes were both leaders briefly (old leader in a partition, new leader elected on the majority side). Explain how Raft guarantees the old leader's un-replicated writes cannot corrupt the committed log once the partition heals.

---

## Level 6 — Coordination Services
*You rarely implement Raft yourself — you use a service built on it.*

**Q23.** ZooKeeper, etcd, and Consul are all coordination services. For each, name the consensus/atomic-broadcast protocol it uses and one thing it is most commonly used for.

**Q24.** Give the classic **leader-election recipe** using ephemeral sequential nodes (ZooKeeper-style). How does it guarantee exactly one leader, and how does it avoid the "herd effect" where every candidate wakes up on each change?

**Q25.** What is a **session / lease** in a coordination service, and why is it the mechanism that makes automatic failover possible? What happens to a client's ephemeral nodes / held locks when its session expires?

**Q26.** A client acquires a distributed lock from etcd, then suffers a 30-second GC pause. The lease expires, the lock is granted to another client, and then the first client wakes up and proceeds — believing it still holds the lock. Two clients are now in the critical section. How do you make this safe?

---

## Level 7 — Quorum Math & Membership Changes
*The math that decides your cluster size and your failover behavior.*

**Q27.** Write the quorum formula for a cluster of N nodes and the failure-tolerance formula. Fill in the table for N = 3, 4, 5, 6, 7. Why do production clusters almost always use an **odd** number of nodes?

**Q28.** Why is a **2-node** consensus cluster strictly worse than a 1-node "cluster" for write availability? Show the reasoning with the quorum math.

**Q29.** Why can't you change cluster membership by just simultaneously swapping the old node set for the new one? Describe the danger of two disjoint majorities, and how **joint consensus** (or single-node-at-a-time changes) avoids it.

**Q30.** You have a healthy 3-node cluster and want to grow to 5 nodes to tolerate 2 failures. What is the safe order of operations, and at what moment does your fault tolerance actually change? What goes wrong if you add both new nodes at once?

---

## Level 8 — Architect-Level Tradeoffs
*Show design review depth that goes beyond the textbook answer.*

**Q31.** Consensus adds a network round-trip to a majority on every committed write. As an architect, what does "keep consensus off the hot path" mean concretely? Give an example of what you put *through* consensus vs what you deliberately keep *out*.

**Q32.** A naive Raft read must still go through the log (or contact a majority) to be linearizable, which is expensive. Explain **lease reads** and the **read index** optimization. What does each trade away, and what is the risk of a lease read specifically?

**Q33.** How do globally-distributed databases (e.g., Spanner, CockroachDB) use consensus without every write paying a cross-continent round-trip? Describe the per-shard consensus group model and where the leaseholder/leader is placed.

**Q34.** When should you **not** use consensus at all? Name two data/workload profiles where a leaderless / eventually-consistent (e.g., CRDT, Dynamo-style) design is the better choice, and state the specific property you give up.

**Q35.** An interviewer says "we'll use a distributed lock to make sure only one worker processes each job." Name three follow-up questions you must ask before this design is safe, and the failure each question is guarding against.

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** Your etcd/ZooKeeper cluster is healthy but *slow* — commit latency has doubled. Before blaming the network, what are the two most common self-inflicted causes, and how would you confirm each?

**QB2.** Your coordination cluster spans three datacenters for disaster tolerance. Writes have gotten slow. Explain why, and describe the placement strategy (including where a "tiebreaker" node goes) that keeps you partition-tolerant without paying cross-region latency on every commit.

**QB3.** A colleague proposes running the consensus cluster co-located on the same machines as the high-throughput data plane "to save hardware." Why is this dangerous, and what specific resource contention would you call out?

**QB4.** Your leader is elected and healthy, but clients occasionally read stale data right after a leader change. Walk through why this happens and the one thing a new leader must do before it is allowed to serve reads.
