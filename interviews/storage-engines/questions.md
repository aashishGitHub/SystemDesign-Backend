# Interview Questions: Database Storage Engines (LSM-Tree vs B-Tree)

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier concepts.

---

## Level 1 — Why Storage Engines Matter
*No prior database internals knowledge required. Start from the hardware.*

**Q1.** What is a storage engine, and what is the single job it does for a database? Explain it without using the words "B-tree" or "LSM."

**Q2.** Why does the difference between *random* I/O and *sequential* I/O matter so much when designing a storage engine? Which one is cheaper, and why?

**Q3.** If memory is so much faster than disk, why can't we just keep the entire database in RAM and stop worrying about storage engines?

**Q4.** Engineers say a storage engine can be read-optimized, write-optimized, or space-optimized, but not all three at once. State this tradeoff in your own words. Why does improving one axis tend to cost you another?

---

## Level 2 — B-Tree Fundamentals
*The default engine of the relational world. Understand it before comparing.*

**Q5.** Describe the structure of a B+tree: pages (nodes), fanout, and height. For 100 million keys with a fanout of 500, roughly how many levels deep is the tree, and why does that number matter for read latency?

**Q6.** How does a B-tree serve a point lookup, and how does it serve a range scan? Why is it good at *both*?

**Q7.** What is an "in-place update"? Explain why it makes B-trees read-optimized but also why it makes writes expensive.

**Q8.** What is a page split? When does it happen, what is "fill factor," and what goes wrong if you run a B-tree index at 100% fill factor under an insert-heavy workload?

**Q9.** A B-tree updates pages in place. If the machine loses power halfway through writing a page, what is the failure mode, and how do the WAL / redo log (and mechanisms like Postgres full-page writes or InnoDB's doublewrite buffer) prevent data loss?

---

## Level 3 — LSM-Tree Write Path
*Write-optimized by design. Trace a single write end to end.*

**Q10.** Walk through the LSM-tree write path from the moment a client issues a write to the moment it is durable. Name each component: WAL/commit log, MemTable, SSTable flush.

**Q11.** What is a MemTable, and why is it almost always a *sorted* in-memory structure (skip list or balanced tree) rather than a plain hash map?

**Q12.** What is an SSTable? Why is it immutable once written, and what does immutability buy you operationally?

**Q13.** Why is the LSM write path described as "append-only," and why does that make writes fast compared to a B-tree? Name the specific I/O pattern that makes it fast.

**Q14.** A process crashes after acknowledging 10,000 writes but before the MemTable has been flushed to an SSTable. Are those writes lost? Walk through exactly what happens on restart. *(failure mode)*

---

## Level 4 — LSM Read Path & Bloom Filters
*Reads are where the LSM pays for its cheap writes.*

**Q15.** Walk through an LSM read for (a) a key that exists in a recent MemTable and (b) a key that does not exist anywhere. Which structures are consulted, and in what order?

**Q16.** Why is a read in an LSM-tree generally more expensive than the equivalent read in a B-tree? Be specific about what the LSM has to do that the B-tree does not.

**Q17.** What is a Bloom filter, and how does it make LSM reads cheaper? Explain precisely why it can produce false positives but *never* false negatives.

**Q18.** What are the sparse (block) index and the block cache, and how does each reduce read cost once a Bloom filter says "this SSTable might contain the key"?

**Q19.** A junior engineer says "LSM reads are O(1) because of Bloom filters." What is the actual worst-case read amplification for a *non-existent* key if Bloom filters are disabled or misconfigured, and why? *(catches a common misconception)*

---

## Level 5 — Compaction
*The background process that makes LSM sustainable — and the one that breaks it.*

**Q20.** What is compaction, and why is it necessary? Describe what happens to reads, to disk usage, and to correctness if compaction never runs.

**Q21.** Compare size-tiered compaction and leveled compaction: how each organizes SSTables, and how each behaves on write amplification, space amplification, and read amplification.

**Q22.** How does a delete work in an LSM-tree? What is a tombstone, why can't the engine delete data immediately, and what problems do tombstones cause (resurrected/zombie records, read cost)? *(failure mode)*

**Q23.** What is a write stall (or write stop)? Explain the exact chain of events by which compaction falling behind causes client writes to slow down or block. *(failure mode)*

---

## Level 6 — Amplification & the RUM Conjecture
*The vocabulary that lets you reason about any storage engine.*

**Q24.** Define read amplification, write amplification, and space amplification. Give the LSM-vs-B-tree comparison on each axis.

**Q25.** State the RUM conjecture. Which two of the three axes does a typical LSM-tree optimize, and which two does a B-tree optimize? What does each sacrifice?

**Q26.** Why does write amplification matter *specifically* for SSDs in a way it does not for spinning disks? What is the long-term operational consequence? *(hardware failure mode)*

**Q27.** A workload is 95% writes and 5% point reads, with heavy continuous ingest. Which engine do you choose and why? Now flip it to 95% reads with occasional range scans — what changes, and why?

---

## Level 7 — Durability & Recovery
*Acknowledged means "survives power loss," or it means nothing.*

**Q28.** What is a write-ahead log, and what does `fsync` actually guarantee? State the durability-vs-latency tradeoff explicitly. What is the risk of `fsync`-per-write, and the risk of never `fsync`-ing?

**Q29.** What is group commit, and why does it increase throughput *without* weakening the durability guarantee?

**Q30.** Walk through crash recovery for a B-tree engine and for an LSM engine. What is a checkpoint, and what role does it play in each?

**Q31.** How does a storage engine let many readers run concurrently while writers are mutating data, without readers ever seeing a half-written state? Explain MVCC and how LSM immutability and B-tree undo/version chains each support snapshot isolation.

---

## Level 8 — Architect-Level Tradeoffs
*Design-review depth. Show the math and the failure modes.*

**Q32.** You must pick a storage engine for a write-heavy time-series ingest system: ~500k writes/sec, ~200-byte records, 90-day retention, mostly recent-range reads. Which engine, and what is the capacity math (disk write bandwidth, storage footprint) you present in the design review?

**Q33.** A production LSM cluster shows periodic write-latency spikes and CPU/disk saturation that correlate with "hot compaction." How do you diagnose it, and what levers do you pull to mitigate it? *(production incident)*

**Q34.** How do you tune compaction differently for a read-heavy analytical workload vs a write-heavy ingest workload? Name the specific compaction strategy for each and the tradeoff you are accepting.

**Q35.** An interviewer assumes LSM is always the right call for "high write throughput." When would you deliberately choose a B-tree engine (Postgres/InnoDB) over an LSM engine *even for a write-heavy workload*? *(catches over-generalization)*

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** Bloom filter sizing: how do bits-per-element and the number of hash functions (`k`) affect the false-positive rate? Roughly how many bits per element buys a ~1% false-positive rate, and what happens if you set `k` too high or too low?

**QB2.** Besides Bloom filters, name two other probabilistic data structures used in databases, what each estimates, and where each shows up. Why use an approximate structure at all?

**QB3.** Your LSM database's on-disk footprint is 2–3× the logical dataset size and won't come down. What is happening, how do you confirm it, and what do you do about it? *(space-amplification incident)*

**QB4.** Postgres and MySQL/InnoDB are both B-tree engines, but they implement MVCC very differently. What is the key difference, and what operational problem does each design create (table bloat vs undo-log growth)?
