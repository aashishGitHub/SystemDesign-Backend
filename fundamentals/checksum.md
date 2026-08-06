# Checksum

A small, fixed-size fingerprint computed from a block of data. Recompute it later and compare — if it doesn't match, the data changed (corruption, bit rot, a bug, tampering). It only detects **byte-identical vs not**; it says nothing about *how* different two things are.

---

## The Problem

Disks silently flip bits, networks corrupt packets, and buggy code writes wrong bytes — all without raising an error anywhere. Storing or transmitting a data block's own hash alongside it turns "did this get corrupted?" into a cheap comparison instead of an undetectable failure mode.

---

## How It Works

1. Compute `hash(data)` at write/send time (CRC32 for speed and error-detection strength, MD5/SHA for cryptographic-grade uniqueness) and store or transmit it alongside the data.
2. At read/receive time, recompute the hash from the data actually received.
3. Compare. Match → data is intact (with overwhelming probability). Mismatch → data was corrupted or tampered with somewhere in transit or storage.

```
Write:   data = [bytes...]         checksum = SHA256(data) = "a1b2c3..."
         store both together

Read:    data' = [bytes read back]  checksum' = SHA256(data')
         checksum' == "a1b2c3..." ?  → yes: intact  |  no: CORRUPTED, reject or re-fetch
```

---

## Analogy

> A tamper-evident seal on a package. It doesn't tell you *what's* inside, and it can't fix a broken item — it only tells you, with high confidence, whether the box was opened or damaged since it was sealed.

---

## The Subtlety That Trips People Up

A checksum only catches **byte-identical vs not** — it is the wrong tool for "are these two things *similar*" (near-duplicate detection needs SimHash/shingling instead, because a single changed byte produces a completely different checksum with no relation to the original). And a checksum match is not a cryptographic integrity guarantee unless you specifically chose a cryptographic hash (SHA-256, not CRC32/MD5) — CRC32 is fast and great at catching accidental corruption but trivially forgeable by an adversary; MD5 is broken for security purposes even though it's still fine for accidental-corruption detection.

---

## Interview Questions

**Q1. Why not just re-compare the raw bytes instead of a checksum?**
At scale, re-transmitting or re-reading the full original to compare byte-for-byte defeats the purpose — the checksum is a fixed, small size (a few bytes to a few dozen) regardless of how large the original data is, so verifying integrity costs almost nothing compared to moving the data itself around a second time.

**Q2. When would you pick CRC32 over SHA-256 for a checksum, and vice versa?**
CRC32 is much faster to compute and is designed specifically to catch the kind of random bit-flip errors disks and networks actually produce — the right choice for high-throughput integrity checks where nobody is actively trying to fool the checksum. SHA-256 is slower but resistant to deliberate tampering — the right choice whenever an adversary might want to modify data *and* make the checksum still match.

**Q3 (depth). A crawler uses an exact checksum to deduplicate crawled pages and still stores near-duplicate pages as separate entries — is the checksum broken?**
No — it's working exactly as designed. A checksum can only ever say "byte-identical or not"; two pages that differ by one ad banner or one timestamp are not byte-identical, so they get different checksums even though a human would call them "the same page." Catching that requires a similarity-preserving fingerprint like SimHash layered on top, not a stronger checksum.

**Q4 (senior). How do checksums relate to Merkle trees?**
A Merkle tree is checksums applied recursively: leaf nodes are checksums of data blocks, and every internal node is a checksum of its children's checksums, all the way up to one root hash summarizing an entire dataset. That structure is what lets two replicas compare a single root hash first and only recurse into the subtree that differs — instead of checksumming (or transferring) the entire dataset to find a mismatch.

---

## Where This Shows Up in This Repo

- [web-crawler/deep-dive.md §4 — Near-Duplicate Content: SimHash and Shingling](../interviews/web-crawler/deep-dive.md#4-near-duplicate-content-simhash-and-shingling) — checksum vs SimHash as two different, complementary layers of dedup
- [merkle-trees.md](./merkle-trees.md) — checksums composed recursively into a tree
