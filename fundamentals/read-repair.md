# Read Repair

While serving a read that queries multiple replicas anyway, notice if they disagree — and quietly fix the stale ones **in the background**, using the read the client already paid for as free repair work.

---

## The Problem

Replicas drift out of sync — a missed write during a network blip, a hint that never got delivered, a replica that was briefly down. Waiting for a dedicated, full-dataset repair pass (like Merkle-tree anti-entropy) to catch every drift is thorough but slow to converge. Read repair fixes the specific keys that are actually being read, right now, essentially for free.

---

## How It Works

1. A read at quorum (`R` replicas) queries multiple replicas for the same key.
2. The coordinator compares the versions/timestamps it got back.
3. If they disagree, it returns the newest value to the client **and** asynchronously pushes that newest value to the stale replica(s) — the client doesn't wait for this repair step.
4. The stale replica is now caught up, without a separate repair job ever having to specifically target that key.

```
Read K with R=2, replicas queried: [A, C]
  A returns: v3 (newer)
  C returns: v2 (stale)
→ client gets v3 immediately
→ coordinator asynchronously writes v3 to C in the background
→ C is now consistent, no separate repair process needed
```

---

## Analogy

> Proofreading a shared document by comparing two people's copies whenever anyone actually needs to read it, and quietly correcting whichever copy was behind — instead of scheduling a dedicated audit of every copy on a fixed calendar, whether anyone needed to read it or not.

---

## The Subtlety That Trips People Up

Read repair only fixes keys that **get read** — a key nobody queries can stay stale (or divergent) forever, no matter how long you wait. This is exactly why it's a complement to, not a replacement for, **anti-entropy via Merkle trees**: read repair handles the "hot" data your traffic naturally touches, and Merkle-tree comparison sweeps the entire dataset periodically to catch drift in cold or rarely-read keys that read repair would never reach on its own.

---

## Interview Questions

**Q1. Why fix a stale replica during a read instead of always running a background sync job?**
It's opportunistic and free — the coordinator already fetched multiple replicas' versions to satisfy the read quorum, so comparing them costs nothing extra, and the repair write happens off the client's critical path. A dedicated background job would need to scan and compare the *entire* dataset on some schedule, which is far more expensive to run frequently.

**Q2. What's the blind spot of read repair, and what covers it?**
Keys that are never read stay uncorrected indefinitely, since read repair only triggers as a side effect of an actual read request. Anti-entropy via Merkle trees covers this gap — it periodically compares full replica datasets (not just recently-read keys) so cold, rarely-accessed data still eventually converges.

**Q3 (depth). Does read repair happening synchronously vs asynchronously change what consistency guarantee the read itself provides?**
No — the client-facing read guarantee is set by `R` and `W + R > N` at the moment of the read; the background repair push is a *side effect* that improves future reads, not something the current read waits on or depends on for its own correctness. Making repair synchronous (block until the stale replica is fixed) would add latency to every read that finds a mismatch, which most systems deliberately avoid.

**Q4 (senior). A system relies purely on read repair with no separate anti-entropy process — what failure mode should you expect in production?**
Rarely-read "cold" data silently diverges and never self-heals, so a replica that fell behind during some past incident can carry stale data for that cold key set indefinitely — and if that replica is later promoted or relied upon (e.g. after another replica fails), you can serve genuinely wrong data with no warning. This is the concrete argument for always pairing read repair with scheduled Merkle-tree anti-entropy, not treating either as sufficient alone.

---

## Where This Shows Up in This Repo

- [kv-store/deep-dive.md §7 — Anti-Entropy: Read Repair and Merkle Trees](../interviews/kv-store/deep-dive.md#7-anti-entropy-read-repair-and-merkle-trees)
- [merkle-trees.md](./merkle-trees.md) — the scheduled, whole-dataset counterpart to this read-triggered repair
- [hinted-handoff.md](./hinted-handoff.md) — the other half of Dynamo-style anti-entropy: handles the "known gap," while read repair and Merkle trees catch drift with no hint at all
