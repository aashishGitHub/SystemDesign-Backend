# High-Water Mark

The offset (or index) up to which a log has been **replicated to enough replicas to be considered safe to expose** — everything up to it is visible to readers; everything past it is not yet guaranteed durable.

---

## The Problem

A leader can append a write to its own log instantly, but that write isn't safe until it's also on other replicas — if the leader dies right after, an un-replicated entry can be lost, and any reader who already saw it would be reading data that just vanished. The high-water mark is the line that says "past this point, it's real; before it, don't show it to anyone yet."

---

## How It Works

1. The leader appends new writes to its local log — these entries exist locally but are **not yet exposed**.
2. Followers pull (or receive) new entries and ack how far they've replicated.
3. The leader tracks the **minimum acked offset across the required replica set** (a quorum, or all in-sync replicas depending on the system) — that minimum is the new high-water mark.
4. Only entries **at or below** the high-water mark are returned to consumers/readers. Entries above it exist on disk but are invisible until enough replicas catch up.

```
Leader log:        [0][1][2][3][4][5]
Replica A acked:    up to 4
Replica B acked:    up to 3   ← the straggler
Replica C acked:    up to 5

High-water mark = min(4, 3, 5) = 3
→ consumers can read offsets 0-3. Offsets 4-5 exist but are not yet visible.
```

---

## Analogy

> A tide marker on a beach. Anything below the mark is guaranteed to have been underwater long enough to count; anything above it just got wet and might still get swept back before it's "official."

---

## The Subtlety That Trips People Up

The high-water mark is about **visibility**, not about what's durably on disk. Data above the mark is already written locally on the leader — it's just not exposed, because it hasn't been confirmed safe elsewhere yet. This is distinct from a consensus **commit index** (Raft), which marks what's been applied to the replicated state machine — the two concepts are close cousins but not identical: a high-water mark can be maintained without a full consensus protocol underneath it (e.g. Kafka's ISR-based replication is not Raft).

A slow or lagging replica can stall the high-water mark for the whole partition if it's still counted as "required" — which is exactly why systems distinguish **in-sync replicas (ISR)** from replicas that have fallen too far behind and get temporarily dropped from the requirement.

---

## Interview Questions

**Q1. Why not just let consumers read whatever the leader has written, immediately?**
Because the leader's newest writes aren't guaranteed durable yet — if the leader crashes before replicating them, those entries disappear, and any consumer who already read and acted on them now has data that never really existed. The high-water mark trades a small visibility delay for the guarantee that anything you can read will never be un-written.

**Q2. What happens to the high-water mark if one follower goes completely silent?**
If that follower is still counted among the required replicas, the high-water mark stops advancing entirely — new writes pile up as "written but invisible" forever. This is why systems maintain a dynamic in-sync replica set: a follower that falls too far behind (or stops acking within a timeout) gets dropped from the ISR, so the high-water mark can keep advancing on the remaining healthy replicas.

**Q3 (depth). How is the high-water mark different from Raft's commit index?**
They serve the same purpose — "how far is it safe to expose/apply" — but the commit index in Raft specifically requires a **majority** ack under the Raft protocol's leader-election and term rules, whereas a high-water mark (as in Kafka) can be defined against any configured replica set (like "all ISR members") without running a full consensus algorithm. The commit index is the consensus-flavored version of the same underlying idea.

**Q4 (senior). A follower's local log has entries past the high-water mark when a new leader is elected and its high-water mark is lower — what happens to those extra entries?**
They get truncated. Any entry that was never confirmed by enough replicas to cross the high-water mark was never "committed" in the safety sense, so a follower holding uncommitted entries past the new leader's high-water mark must discard them to stay consistent with the new leader's log — otherwise replicas could permanently disagree on history.

---

## Where This Shows Up in This Repo

- [segmented-log.md](./segmented-log.md) — the log structure the high-water mark walks across
- [consensus/deep-dive.md §7 — Raft Log Replication and Commit](../interviews/consensus/deep-dive.md#7-raft-log-replication-and-commit) — "🟡 Senior — AppendEntries and the Commit Index" is the consensus-flavored version of this same idea
