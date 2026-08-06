# Vector Clocks

A per-key map of `{node: counter}` attached to every write. Comparing two vector clocks tells you whether one write **happened-before** another, or whether they're **concurrent** (genuinely conflicting, neither caused the other) — something a single timestamp can never tell you.

---

## The Problem

Last-write-wins (LWW) by wall-clock timestamp silently drops data whenever two writes race, because clocks across machines are never perfectly synchronized — "later timestamp" doesn't reliably mean "actually happened later." Vector clocks replace "which timestamp is bigger" with "did one write actually descend from the other, or did they happen independently, unaware of each other."

---

## How It Works

1. Every write to a key carries a vector clock: one counter per node that has ever written that key.
2. A node writing increments **its own** counter in the vector before attaching it.
3. To compare two vectors `a` and `b`: if every entry in `a` is ≥ the corresponding entry in `b` (and at least one is strictly greater), `a` **descends from** `b` — `a` wins, no conflict. If neither vector dominates the other (each has some entry bigger than the other's), the writes are **concurrent** — a real conflict that must be surfaced, not silently resolved.

```
a = {N1: 2, N2: 1}
b = {N1: 1, N2: 1}
→ a's N1 (2) ≥ b's N1 (1), a's N2 (1) ≥ b's N2 (1), a strictly bigger somewhere
→ a descends from b → a wins, b is stale, no conflict

a = {N1: 2, N2: 0}
b = {N1: 0, N2: 1}
→ a bigger on N1, b bigger on N2 — neither dominates
→ CONCURRENT: both are kept as sibling versions, app must resolve
```

---

## Analogy

> Two co-authors editing a shared document, each keeping a private tally of "how many of my own edits has the other seen." If one author's tally shows they've seen all of the other's edits plus made more, their version clearly supersedes. If each author has edits the other hasn't seen, you can't just pick one — you genuinely have two drafts that need merging.

---

## The Subtlety That Trips People Up

Detecting a conflict is not the same as **resolving** it — vector clocks tell you *that* two writes are concurrent, they say nothing about *what the merged result should be*. That's an application-level decision (union the sets, ask the user, apply a CRDT merge rule), and the classic failure mode is a naive union-merge: if concurrent writes are "add pen" and "remove book," a plain union can **resurrect a deleted item**, because the removal never saw the concurrent add and a union only ever adds, never subtracts something the other side didn't know was gone.

---

## Interview Questions

**Q1. Why can't a single timestamp tell you whether two writes conflict?**
Clocks on different machines drift and are never perfectly synchronized, so "which timestamp is numerically larger" doesn't reliably correspond to "which write actually happened after seeing the other." Two writes with identical logical causality could get any timestamp ordering depending on clock skew — the timestamp carries no information about what each writer had actually observed.

**Q2. What does it mean, precisely, for two vector clocks to be "concurrent"?**
Neither vector's set of counters dominates the other's — each has at least one node-counter strictly greater than the other's corresponding entry. That means neither write's author had seen the other's write at the time they made theirs; they happened independently, with no causal relationship, so neither can be said to legitimately supersede the other.

**Q3 (depth). Vector clocks grow with the number of distinct coordinators that have ever written a key — why does that matter operationally?**
Every additional coordinator/node that writes a key adds a permanent entry to that key's vector clock, and the metadata size grows unbounded over the system's lifetime unless pruned — Dynamo-style systems cap and prune old/inactive node entries to bound this, trading a small amount of theoretical precision for a fixed metadata overhead per key.

**Q4 (senior). Why does the union-merge conflict resolution reintroduce a deleted item, and how do you fix it?**
A concurrent "remove X" only removed X from the side that saw it — it has no way to also cancel out a concurrent "add X" made by a writer that never observed the removal, so a plain set-union of both siblings keeps X. The fix is either an **OR-Set CRDT**, where removes carry the specific add-tags they observed (so only *seen* adds are actually removed, and a concurrent unseen add survives on purpose, correctly), or explicit tombstones with their own versions instead of raw set subtraction.

**Q5 (staff). When would you choose LWW over vector clocks despite the silent-lost-update risk?**
When the write rate per key is high, the metadata cost of tracking per-node vectors is unacceptable, and losing an occasional concurrent write is genuinely tolerable for that data (e.g. a "last seen" timestamp, a view counter with independent reconciliation). Vector clocks are the right default when losing a write is a real bug — but they aren't free, and defaulting to them everywhere is itself a design smell if the domain doesn't need the guarantee.

---

## Where This Shows Up in This Repo

- [kv-store/deep-dive.md §6 — Conflict Resolution: LWW, Vector Clocks, CRDTs](../interviews/kv-store/deep-dive.md#6-conflict-resolution-lww-vector-clocks-crdts) — comparison code, the resurrected-cart-item failure mode, and the LWW/vector-clock/CRDT tradeoff table
- [sharding-replication/deep-dive.md §4 — Consistency Under Replication Lag](../interviews/sharding-replication/deep-dive.md#4-consistency-under-replication-lag)
