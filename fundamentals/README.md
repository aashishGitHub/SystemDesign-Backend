# Fundamentals — Distributed Systems Building Blocks

Twenty single-concept primers, each **brutally short**: one core idea, how it works, an analogy, the one subtlety that trips people up, and 4–5 interview questions with real answers — not just prompts. Every file ends with links to the full-depth topic(s) in [`interviews/`](../interviews/) that use the concept in a real system design.

Read these when you need the concept refreshed in two minutes. Read the linked `interviews/` topic when you need the concept in the context of an actual system.

---

## Data Structures & Integrity

| Topic | One-line hook |
|---|---|
| [Bloom Filters](./bloom-filters.md) | "Definitely no" or "maybe yes" — never a false no, from a few bits in RAM |
| [Checksum](./checksum.md) | A fingerprint that catches byte-identical corruption, nothing more |
| [Merkle Trees](./merkle-trees.md) | Checksums composed recursively so two datasets diff in `O(log n)`, not `O(n)` |
| [Vector Clocks](./vector-clocks.md) | `{node: counter}` that tells you happened-before vs genuinely concurrent |

## Storage & Logs

| Topic | One-line hook |
|---|---|
| [Write-Ahead Log](./write-ahead-log.md) | Log the change before you make it, so a crash mid-update is always recoverable |
| [Segmented Log](./segmented-log.md) | A log as many small immutable files, so deleting old data is a file delete, not a rewrite |
| [High-Water Mark](./high-water-mark.md) | The offset below which the log is safe to expose to readers |

## Coordination & Consensus

| Topic | One-line hook |
|---|---|
| [Quorum](./quorum.md) | Consensus majority vs Dynamo-style tunable `W+R>N` — two different mechanisms, one word |
| [Leader and Follower](./leader-and-follower.md) | One node orders every write, so reads never need conflict resolution |
| [Lease](./lease.md) | A lock with a built-in expiry, so a dead holder can't stall the system forever |
| [Fencing](./fencing.md) | A monotonic token the *resource* checks, so a stale leader's writes get rejected even if it doesn't know it's stale |
| [Split Brain](./split-brain.md) | Two partitions both think they're the leader — the failure quorum + fencing jointly prevent |

## Failure Detection & Membership

| Topic | One-line hook |
|---|---|
| [Heartbeat](./heartbeat.md) | Absence of a signal, not its content, is what "dead" means |
| [Gossip Protocol](./gossip-protocol.md) | Random peer-to-peer exchange spreads cluster state in `O(log N)` rounds, no coordinator |
| [Phi Accrual Failure Detection](./phi-accrual-failure-detection.md) | A continuous suspicion score learned per node, instead of one fixed timeout for everyone |

## Replication & Consistency

| Topic | One-line hook |
|---|---|
| [Consistent Hashing](./consistent-hashing.md) | Adding/removing a node moves ~1/N of keys, not almost all of them — primer only, [full topic here](../interviews/consistent-hashing/README.md) |
| [Hinted Handoff](./hinted-handoff.md) | A substitute node holds your write with a note for who it really belongs to |
| [Read Repair](./read-repair.md) | Fix a stale replica for free, as a side effect of a read that already touched it |
| [CAP Theorem](./cap-theorem.md) | During a partition: consistency or availability, not both — P was never optional |
| [PACELC Theorem](./pacelc-theorem.md) | CAP's forgotten "else" branch: latency vs consistency on every request, partition or not |

---

## How These Relate to `interviews/`

Every file's **"Where This Shows Up in This Repo"** section links to the specific section/answer where the concept is used in a real system — kv-store, consensus, consistent-hashing, sharding-replication, seat-reservation, storage-engines, web-crawler, and distributed-transactions between them cover all twenty. This folder never duplicates that depth — it's the two-minute version that tells you which deep-dive to open next.

If you're building a new topic and it leans on one of these concepts, link back here instead of re-explaining the concept inline — see the root [README.md](../README.md#-how-to-add-a-new-interview-topic) convention: *cross-link, don't duplicate.*

## Other Fundamentals Content

This folder also has longer single-pattern write-ups that predate this index: [circuit-breaker.md](./circuit-breaker.md) (full 🟢🟡🔴 deep dive), [chaos-monkey.md](./chaos-monkey.md), and broader survey docs — [Use_Cases_for_Caching.md](./Use_Cases_for_Caching.md), [Use_Cases_for_Databases.md](./Use_Cases_for_Databases.md), [Use_Cases_for_Proxies.md](./Use_Cases_for_Proxies.md), [Use_Cases_for_Redundancy_and_Replication.md](./Use_Cases_for_Redundancy_and_Replication.md).
