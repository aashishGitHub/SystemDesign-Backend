# Hinted Handoff

When a write's rightful destination is down, a **substitute node** accepts the write instead and stores it with a note — a "hint" — saying who it really belongs to. When the rightful owner comes back, the substitute hands over the hinted writes and deletes its copy.

---

## The Problem

Under a strict quorum, if enough of a key's preference-list nodes are down, writes simply block — even though other, perfectly healthy nodes exist and could hold the data temporarily. Hinted handoff trades a moment of "not quite where it should be" for keeping the write path available during a failure.

---

## How It Works

1. Coordinator tries to write to a key's preference-list nodes; one (say Node B) is unreachable.
2. The coordinator writes to a substitute node D instead, tagging the write with a hint: `intended_node: NodeB`.
3. D counts toward the write quorum ([sloppy quorum](./quorum.md)) — the write succeeds even though B never saw it.
4. Once gossip reports B is back up, D delivers the hinted write(s) to B and deletes its local copies.
5. If B never comes back before a hint-retention window expires (e.g. ~3 hours in Cassandra), the hint is dropped — anti-entropy repair ([read repair](./read-repair.md), [Merkle trees](./merkle-trees.md)) is the backstop that can still catch the gap later.

```
Preference list for key K: [A, B, C]. B is down.

Strict quorum (W=2):  wait for B → write BLOCKED
Sloppy quorum (W=2):  write to A and D (substitute) → SUCCEEDS
                       D stores value + hint: "belongs to NodeB"
B recovers  →  D delivers hinted write to B  →  D deletes local copy
```

---

## Analogy

> A substitute teacher covers a sick colleague's class and keeps careful notes of what happened each day. When the regular teacher returns, they read the notes and catch up completely — the students never had a day with no teacher at all.

---

## The Subtlety That Trips People Up

Hinted handoff is **best-effort, not a durability guarantee** — hints have a retention TTL, and if the original node is down longer than that window, the hint is simply dropped and the write's presence on that node is never delivered by this mechanism. This is exactly why hinted handoff is always paired with a second, independent repair mechanism (anti-entropy via Merkle trees) that doesn't depend on any node remembering anything — it just compares what replicas actually have, later, regardless of whether a hint ever existed.

---

## Interview Questions

**Q1. How is hinted handoff different from simply blocking the write until the down node recovers?**
Blocking trades availability for strict correctness of the preference list — the write physically cannot complete until the "right" node is reachable. Hinted handoff keeps the write path available by accepting the write anywhere healthy and reconciling the placement later, at the cost of the data briefly not being where the ring says it should be.

**Q2. What happens if a strict-quorum read for key K happens while its data is sitting on a substitute node as a hint?**
The read queries K's actual preference-list nodes ([A, B, C]) — it doesn't know to check the substitute D holding the hint — so it can miss the value D is holding, even though a write technically "succeeded." This is the real cost named directly: sloppy quorum sacrifices the guarantee that a subsequent strict read sees the latest write during the window the hint hasn't been delivered yet.

**Q3 (depth). Why is there a hint retention TTL instead of holding hints forever until delivered?**
An unreachable node might never come back (disk failure, permanent decommission) — holding hints indefinitely for a node that's gone forever would leak unbounded storage on the substitute. The TTL bounds that cost, accepting that very long outages fall through to anti-entropy repair instead of hinted handoff.

**Q4 (senior). Is hinted handoff safe to use for data where losing a write is unacceptable?**
Not on its own — a hint can be lost (its holder crashes before delivering it, or the TTL expires during a long outage), so it's a best-effort optimization for availability, not a durability guarantee. Data where "never lose a write" truly matters needs it backed by anti-entropy repair (Merkle-tree comparison across replicas) as the durable fallback, not hinted handoff alone.

---

## Where This Shows Up in This Repo

- [consistent-hashing/answers.md — A19 Sloppy quorum](../interviews/consistent-hashing/answers.md#a19-sloppy-quorum) and [A20 Hinted handoff](../interviews/consistent-hashing/answers.md#a20-hinted-handoff) — full write-path and delivery-sequence diagrams
- [kv-store/deep-dive.md §5 — Sloppy Quorum and Hinted Handoff](../interviews/kv-store/deep-dive.md#5-sloppy-quorum-and-hinted-handoff)
- [quorum.md](./quorum.md) and [read-repair.md](./read-repair.md) — the mechanism this trades against, and the durable backstop when a hint is lost
