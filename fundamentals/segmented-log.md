# Segmented Log

Instead of one giant, ever-growing log file, split it into fixed-size (or fixed-duration) chunks called **segments**. Only the newest segment is written to; older segments are immutable and can be deleted or archived as a whole file.

---

## The Problem

A single log file that never stops growing has two operational problems: you can't delete "the old part" of a file without rewriting the whole thing, and reading/indexing a multi-terabyte file is unwieldy. Neither problem exists once the log is a sequence of independent, bounded files.

---

## How It Works

1. Writes append to the **active segment** (e.g. `00000000000000000000.log`).
2. When the active segment hits a size or time threshold, it's **closed/rolled**: it becomes immutable, and a new active segment is created (`00000000000000010485.log`, named by its starting offset).
3. Each segment usually gets its own index file mapping offset → byte position, so reads can jump straight to the right file and position instead of scanning from the start.
4. Retention/cleanup (deleting old data, running compaction) operates on **whole segment files** — delete the file, done. No in-place rewriting of a live file.

```
Log as segments (Kafka partition on disk):
  00000000000000000000.log   [offsets 0 – 10484]     ← closed, eligible for deletion after retention
  00000000000000010485.log   [offsets 10485 – 20999]  ← closed
  00000000000000021000.log   [offsets 21000 – ...]    ← ACTIVE, being written to
```

---

## Analogy

> A daily journal kept as one notebook per month instead of one infinite scroll. Throwing away January's notebook once you no longer need it is one action. Try doing that with a single scroll that has January through December written on it continuously.

---

## The Subtlety That Trips People Up

Segmenting is what makes **retention** and **compaction** tractable operations rather than "rewrite everything" operations — this is the actual reason Kafka partitions, LSM-tree SSTables, and Raft logs are all segmented, not because segmenting speeds up individual reads. The size win is secondary; the real win is that cleanup becomes file deletion, an O(1) filesystem operation, instead of an O(log size) rewrite.

---

## Interview Questions

**Q1. Why not just use one big log file and periodically truncate the front of it?**
Truncating the front of a file still growing at the back means either rewriting the whole file or using sparse-file tricks the OS doesn't uniformly support well at scale. A closed segment can just be `unlink()`'d — an atomic, cheap filesystem operation, regardless of how large the log has grown overall.

**Q2. How does segmenting interact with recovery after a crash?**
Recovery only needs to scan the last segment (or the last two, if a segment boundary landed mid-crash) plus whatever the index says was the last confirmed position — it doesn't need to re-read the entire history. Closed segments are immutable and already known-good, so they're skipped entirely.

**Q3 (depth). Kafka names each segment file by the offset it starts at instead of a timestamp or sequence number — why?**
Because consumers seek by offset, not by time or file order. Naming the file `00000000000000010485.log` for the segment starting at offset 10485 means "find the segment containing offset X" is a binary search over filenames, not a scan through an index describing every segment.

**Q4 (senior). You're compacting a log (keeping only the latest value per key, like Kafka's log compaction or an LSM merge) — why does segmenting matter here specifically?**
Compaction rewrites data into new, smaller segment files and only then deletes the old ones — so a crash mid-compaction leaves the old, complete segments intact and readable; nothing is ever in a half-rewritten state. Without segment boundaries, compacting "part of" a monolithic file safely, with a clean crash-recovery story, is much harder to reason about.

---

## Where This Shows Up in This Repo

- [write-ahead-log.md](./write-ahead-log.md) and [high-water-mark.md](./high-water-mark.md) — the two ideas this one pairs with directly
- [storage-engines/deep-dive.md §6 — Compaction: Size-Tiered vs Leveled](../interviews/storage-engines/deep-dive.md#6-compaction-size-tiered-vs-leveled) — SSTables are the LSM-tree's version of log segments
- [consensus/deep-dive.md §7 — Raft Log Replication and Commit](../interviews/consensus/deep-dive.md#7-raft-log-replication-and-commit) — "🔴 Architect — Backtracking, Snapshots, and Throughput Math" covers bounding an ever-growing replicated log
