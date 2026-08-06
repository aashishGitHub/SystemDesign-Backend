# Merkle Trees

A tree of checksums: every leaf is a hash of a data block, every parent is a hash of its children's hashes, all the way up to one **root hash** summarizing an entire dataset. Two replicas can compare just the root first, and only walk down into the branches that actually differ.

---

## The Problem

Comparing two large datasets for drift the naive way means transferring and diffing everything, key by key — expensive, and mostly wasted work when only a tiny fraction has actually diverged. A Merkle tree lets two replicas find *exactly which subset* differs by comparing `O(log n)` hashes instead of the entire dataset.

---

## How It Works

1. Split the dataset into fixed-size blocks (e.g. key ranges). Hash each block → leaf nodes.
2. Hash pairs of leaf hashes together → parent nodes. Repeat up the tree → one root hash.
3. Two replicas each build this tree over their local data and compare **root hashes only** first.
4. If roots match → the entire datasets are (almost certainly) identical, done in one comparison.
5. If roots differ → compare the next level down, and recurse **only into the branches whose hashes differ** — ignore identical subtrees entirely.
6. Once you reach the leaf level, you know exactly which data blocks actually diverged — only those need to be transferred and repaired.

```
         Root: h(hAB + hCD)
        /                  \
   hAB = h(hA+hB)      hCD = h(hC+hD)
   /        \            /        \
  hA        hB          hC        hD
  (block A) (block B)   (block C)  (block D)

Replica 1 root != Replica 2 root → mismatch somewhere
Compare hAB, hCD → hAB matches, hCD differs
→ only recurse into C/D subtree → find hC differs, hD matches
→ only block C needs repair — A, B, D never had to be compared or transferred
```

---

## Analogy

> Comparing two 1000-page contracts by first comparing a one-page summary of each half, then only opening the half whose summary doesn't match, then the quarter, then the chapter — narrowing down to the exact paragraph that changed without ever reading the other 999 pages.

---

## The Subtlety That Trips People Up

Merkle-tree comparison finds **that** a block differs, not **what the correct value is** — resolving the discrepancy still requires an actual data exchange for just that block (and a conflict-resolution rule if both sides have genuinely different, concurrently-written data). The tree is a search structure for *where to look*, not a repair mechanism itself; it's typically the trigger that kicks off the actual anti-entropy data transfer.

---

## Interview Questions

**Q1. Why compare root hashes first instead of walking the tree top-down starting from the leaves?**
The root hash is a single number that summarizes the entire dataset — if it matches, you're done in one comparison, with zero further work. Starting from leaves would mean comparing every block regardless of whether most of the dataset is already identical, throwing away the entire benefit of the tree structure.

**Q2. What's the actual cost savings compared to a full dataset comparison?**
A full comparison is `O(n)` in the number of data blocks. A Merkle-tree comparison, once you know the number of *actually differing* blocks `k`, costs roughly `O(k log n)` — you only pay for the specific paths down to the blocks that diverged, ignoring every identical subtree along the way entirely.

**Q3 (depth). Two replicas' Merkle trees both have a valid root hash but were built over different block boundaries — does the comparison still work?**
No — Merkle-tree comparison assumes both sides partition the data into blocks the same way, so corresponding tree levels actually represent the same key ranges. If block boundaries differ, hashes at every level will legitimately mismatch even when the underlying data agrees, forcing a full re-comparison and defeating the purpose. Real systems fix block boundaries to stable ranges (not, say, "the first N keys currently present") specifically to keep trees comparable over time.

**Q4 (senior). When would you run Merkle-tree anti-entropy instead of relying on read repair alone?**
When you need to catch drift in data that's rarely or never read — read repair only fixes what traffic happens to touch, so cold keys can diverge forever without a scheduled, whole-dataset sweep. Merkle-tree comparison is the mechanism that guarantees eventual convergence for the *entire* dataset, not just the actively-accessed portion of it, which is why production Dynamo-style stores run it as a periodic background job (e.g. `nodetool repair` in Cassandra) rather than treating read repair as sufficient on its own.

---

## Where This Shows Up in This Repo

- [kv-store/deep-dive.md §7 — Anti-Entropy: Read Repair and Merkle Trees](../interviews/kv-store/deep-dive.md#7-anti-entropy-read-repair-and-merkle-trees)
- [consistent-hashing/deep-dive.md §7 — Sloppy Quorum and Hinted Handoff](../interviews/consistent-hashing/deep-dive.md#7-sloppy-quorum-and-hinted-handoff) — Merkle trees named as the backstop when a hint's retention window expires
- [checksum.md](./checksum.md) — the leaf-level primitive this tree is built from
- [read-repair.md](./read-repair.md) — the read-triggered counterpart that handles hot data between scheduled Merkle-tree sweeps
