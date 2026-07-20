# Interview Questions: Distributed Transactions & Consistency

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier concepts.

---

## Level 1 — The Problem
*No distributed-systems background required. Think about what breaks first.*

**Q1.** State what each letter of ACID means in one line, then explain which letter is the hardest to preserve once a transaction spans two databases and why.

**Q2.** An interviewer says "just wrap the order flow in a transaction." Why does that fail when Payment, Inventory, and Order each own a separate database?

**Q3.** What is the "dual-write problem"? Give the exact sequence where writing to a database and then publishing to a message queue leaves the two permanently out of sync.

**Q4.** Your `POST /orders` handler charges the card, then the process crashes before it saves the order row. What has gone wrong, and why can't a simple `try/catch` fix it?

---

## Level 2 — CAP & PACELC
*The single most misquoted theorem in system-design interviews. Get it exactly right.*

**Q5.** State the CAP theorem precisely. Who conjectured it and who proved it, and in what year?

**Q6.** Why is "CAP means pick 2 of 3" wrong? What must always be tolerated in a real distributed system, and what does that leave you actually choosing between?

**Q7.** The "C" in CAP and the "C" in ACID are different things. Define each. Which consistency model does CAP's "C" refer to?

**Q8.** State PACELC. Who formulated it and when? Classify a system that is "PC/EL" and one that is "PA/EL" — name a real system for each.

**Q9.** During a network partition, a shopping-cart service keeps accepting "add to cart" writes on both sides of the partition. Which CAP choice is this, and what is the price you pay when the partition heals?

---

## Level 3 — Consistency Models
*Not all "consistency" is linearizability. Interviewers probe whether you know the spectrum.*

**Q10.** Order these from strongest to weakest and give a one-line definition of each: eventual, linearizable, causal, sequential.

**Q11.** What is linearizability, precisely? What does it guarantee that sequential consistency does not?

**Q12.** Define the four client-centric (session) guarantees: read-your-writes, monotonic reads, monotonic writes, and consistent prefix. Give a user-visible bug that each one prevents.

**Q13.** A user posts a comment and immediately refreshes, but their own comment is missing. Which specific guarantee is violated, and what is the cheapest fix that does not require global linearizability?

**Q14.** When is eventual consistency clearly acceptable, and when is it clearly unacceptable? Give one concrete example of each and state the rule you used to decide.

---

## Level 4 — Two-Phase Commit (2PC)
*The classic atomic-commit protocol. Know its mechanics and exactly how it hurts you.*

**Q15.** Walk through 2PC end to end: the roles, both phases, what each participant durably logs, and when locks are held and released.

**Q16.** The blocking problem: the coordinator crashes after all participants voted "yes" but before it sends the decision. What are the participants forced to do, and why can't they decide on their own?

**Q17.** Why does 2PC hurt availability and latency? Name the two specific costs and tie each to a system-design metric.

**Q18.** What does 3PC add over 2PC, and why is it rarely used in practice? Name the assumption it makes that breaks in real networks.

**Q19.** What single change to 2PC's coordinator makes it production-viable, and which real system applies exactly that change?

---

## Level 5 — Saga Pattern
*Long-lived transactions traded for availability. Know what you give up.*

**Q20.** Define the Saga pattern. Who introduced it and when? What replaces "rollback" when a step fails midway?

**Q21.** Compare orchestration vs choreography for a saga. Name the primary tradeoff and one failure mode unique to each.

**Q22.** Sagas have no isolation. Explain the specific anomaly this creates between steps, and name two countermeasures with how each works.

**Q23.** A compensating action must undo `sendConfirmationEmail`. You can't unsend an email. How do you design compensations for non-compensatable actions?

**Q24.** Why must both forward saga steps and compensating actions be idempotent? Give the exact failure that occurs if a compensation runs twice and isn't idempotent.

---

## Level 6 — Reliable Messaging & Idempotency
*The dual-write problem solved for real, plus "exactly once" demystified.*

**Q25.** Describe the transactional outbox pattern. Show precisely why it makes the DB write and the event atomic when a naive dual-write cannot.

**Q26.** What is Change Data Capture (CDC), and how does log-tailing (e.g., Debezium reading the WAL/binlog) relate to the outbox pattern? When would you pick CDC over a polling relay?

**Q27.** "Exactly-once delivery is impossible, but exactly-once processing is achievable." Explain the distinction and the two-part recipe that makes end-to-end processing "effectively once."

**Q28.** Design an idempotency-key mechanism for `POST /payments` so a client retry never double-charges. What do you store, when do you store it, and what do you return on a duplicate?

**Q29.** How does Kafka provide exactly-once semantics (EOS)? Name the two mechanisms and what `isolation.level=read_committed` does for the consumer.

---

## Level 7 — Isolation & Concurrency Control
*Where "consistency" gets concrete: anomalies, isolation levels, and how engines enforce them.*

**Q30.** Define the four ANSI isolation levels and the anomaly each one newly prevents: dirty read, non-repeatable read, phantom.

**Q31.** What is snapshot isolation (SI)? Which classic anomaly does it still permit, and give a concrete two-transaction example of that anomaly.

**Q32.** Optimistic (CAS/version) vs pessimistic (locking) concurrency control: name the tradeoff and state which workload each one wins on. Show a correct compare-and-swap update.

**Q33.** What is MVCC and what problem does it solve that lock-based readers cannot? Name three production databases that use it.

**Q34.** A common trap: PostgreSQL's `REPEATABLE READ` and Oracle's `SERIALIZABLE` are not what their ANSI names imply. What are they actually, and what does PostgreSQL's true `SERIALIZABLE` add on top?

---

## Level 8 — Architect-Level Tradeoffs
*Show design-review depth beyond the textbook.*

**Q35.** The senior move is often to avoid distributed transactions entirely. How do you redesign service boundaries so a would-be cross-service transaction becomes a single local one? What principle guides where the boundary goes?

**Q36.** How does Google Spanner provide externally-consistent (linearizable) distributed transactions? Name the two building blocks and what commit-wait is for.

**Q37.** How does Percolator get snapshot-isolation cross-row transactions on top of Bigtable, which has no multi-row transactions? Name the trick that makes the multi-row commit atomic.

**Q38.** Given a flow, how do you choose between 2PC, Saga, and plain eventual consistency? Give the decision rule and one flow that lands in each bucket.

**Q39.** A staff engineer proposes 2PC across 5 microservices for checkout at 10k req/sec. Estimate the latency and availability impact, and state what you would do instead.

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** Compensations can themselves fail. If step 3 fails and compensating step 1 also fails, what state is the system in, and how do you make the saga eventually converge?

**QB2.** Idempotency keys need a TTL and a store. What breaks if the TTL is too short, and what breaks if the idempotency store is a different database than the one holding the business write?

**QB3.** Two services must agree on "the customer is a fraud risk" before shipping. Is this a transaction problem or a consistency-model problem? Defend your classification and the mechanism you'd use.

**QB4.** Your team wants "strong consistency everywhere" as a blanket policy. Argue the senior counter-position using PACELC, and give the one place where you would still insist on linearizability.

**QB5.** A downstream consumer is not idempotent and you cannot change it. How do you still deliver effectively-once without touching the consumer's code?
