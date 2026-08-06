# Write-Ahead Log (WAL)

Before you change anything in memory or in the real data structure, you first append a record of that change to a sequential, durable log file. If the process crashes mid-write, you replay the log on restart to get back to where you were.

---

## The Problem

In-memory state is fast but vanishes on crash. Updating the real on-disk data structure (a B-Tree page, an LSM MemTable) durably on every single write is slow — random writes, page splits, fsync overhead. The WAL gives you the durability of "on disk" with the speed of "append-only sequential write," and defers the expensive structural update.

---

## How It Works

1. Client sends a write.
2. Append the write to the WAL (sequential disk write, cheap) and `fsync` it.
3. **Only after** the WAL append is durable, apply the write to the actual in-memory structure (MemTable, B-Tree page, etc.) and ack the client.
4. On crash: replay the WAL from the last known-durable point forward to reconstruct any in-memory state that was lost.

```
Write "SET x=5":
  1. append to WAL:  [LSN 1042] SET x=5     ← fsync, durable now
  2. apply to MemTable: x=5                  ← can be lost on crash, WAL has it
  3. ack client

Crash before step 2 finishes?
  → restart, replay WAL from LSN 1042 → MemTable rebuilt → no data lost
```

---

## Analogy

> A pilot's checklist read aloud and logged before each action, not after. If the plane loses power mid-procedure, whoever takes over reads the log and knows exactly which steps were already confirmed — nothing has to be guessed or redone from scratch.

---

## The Subtlety That Trips People Up

The WAL only protects **durability**, not consistency of the in-memory structure by itself — you still need the "apply" step to be idempotent, because after a crash you might replay a log entry whose effect was *partially* applied before the crash. Real engines handle this with sequence numbers (LSNs) so replay can detect "already applied" and skip it.

Also: `fsync` on every single write is itself a latency cost. Group commit (batching multiple writes into one fsync) is the standard way to keep WAL durability without paying per-write disk-flush latency.

---

## Interview Questions

**Q1. Why append to a log before updating the "real" structure, instead of just updating the real structure directly?**
A structural update (B-Tree page rewrite, tree rebalancing) is a random, multi-step disk operation — if it's interrupted mid-way, the structure can be left corrupted. A sequential log append is a single, cheap, atomic-enough operation; it lets you defer the expensive structural work while still being crash-safe, because you can always replay from the log.

**Q2. What happens if the process crashes between the WAL append and the in-memory apply?**
Nothing is lost: on restart, the recovery process replays the WAL from the last checkpoint, reapplying entries the in-memory structure never got. The client was only acked *after* the WAL append succeeded, so from the client's point of view the write's durability was never in question.

**Q3 (depth). Why does `fsync` matter here — isn't "written to the log" enough?**
"Written" can mean it's sitting in the OS page cache, which is lost on a power failure (not just a process crash). `fsync` forces the log page to physical disk. Skipping `fsync` for performance is a real, named tradeoff — some systems offer an `async` durability mode that trades a small window of data loss for much higher write throughput; you should always be able to say which mode a given "commit" acknowledgment implies.

**Q4 (senior). A WAL grows forever if you never touch it again — how do systems bound its size?**
Checkpointing (or in LSM-tree terms, flushing the MemTable to an SSTable): once the in-memory structure built from a log segment is durably persisted elsewhere, that segment of the WAL is no longer needed for recovery and can be truncated or deleted. This is exactly the problem [segmented log](./segmented-log.md) and [high-water mark](./high-water-mark.md) solve — a monolithic log file can't be partially deleted, but a set of rolled segments can be.

---

## Where This Shows Up in This Repo

- [storage-engines/deep-dive.md §3 — The LSM-Tree Write Path](../interviews/storage-engines/deep-dive.md#3-the-lsm-tree-write-path) — "🔴 Architect — MemTable Sizing and the WAL Durability Knob"
- [consensus/deep-dive.md §2 — The Replicated State Machine and the Log](../interviews/consensus/deep-dive.md#2-the-replicated-state-machine-and-the-log) — the replicated log is a WAL shared across nodes, not just across a crash
