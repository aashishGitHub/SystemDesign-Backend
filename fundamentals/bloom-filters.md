# Bloom Filters

A **Bloom filter** is a bit array + a few hash functions that answers one question cheaply: *"have I possibly seen this before?"* It can say **"definitely no"** or **"maybe yes"** — never a false "no".

---

## The Problem

Checking "is this URL already crawled?" or "does this key exist?" against a real set of billions of items means a disk seek or a network hop per check. A Bloom filter answers the same question from a few bits in RAM, and only forwards the "maybe" cases to the expensive check.

---

## How It Works

1. Start with an `m`-bit array, all zeros, and `k` independent hash functions.
2. **Insert(x):** compute `k` hash values of `x`, set those `k` bit positions to 1.
3. **Query(x):** compute the same `k` positions. If **any** is still 0 → `x` was **definitely never inserted**. If **all** are 1 → `x` was **probably inserted** (could be a false positive from hash collisions with other items).

```
insert("url-A"): hash1→bit3, hash2→bit7, hash3→bit9   → set bits 3,7,9
query("url-B"):  hash1→bit3, hash2→bit7, hash3→bit9   → all 1 → "maybe seen"
                 (false positive: url-B was never inserted, its bits just
                  happen to already be set by other items)
```

---

## Analogy

> A bouncer with a bad memory for faces but a perfect memory for "definitely never been here." If your face rings zero bells, you're new. If it rings all the bells, the bouncer *assumes* you've been here — but might be wrong, since bells get shared.

---

## The Subtlety That Trips People Up

**You cannot delete from a standard Bloom filter.** Clearing a bit to "remove" an item can un-set a bit another item also relies on, turning that item into a false negative — which a Bloom filter is never allowed to produce. Deletable variants exist (**Counting Bloom Filter**: a small counter per slot instead of a bit) at the cost of more memory.

The false-positive rate is tunable, not fixed: `p ≈ (1 − e^(−kn/m))^k`. More bits (`m`) or a better-tuned `k` for a given `n` items lowers it — this is the number an interviewer expects you to reason about, not just gesture at.

---

## Interview Questions

**Q1. Why is there no false negative but there is a false positive?**
Insertion only ever sets bits to 1, never clears them, so a bit an item set stays set forever — meaning the item's own bits will always be found on lookup. A false positive happens because *other* items' insertions can accidentally set the exact same bits.

**Q2. Given `n` items and a target false-positive rate `p`, how do you size `m` and `k`?**
`m = -(n·ln p) / (ln 2)²` bits, and optimal `k = (m/n)·ln 2` hash functions. An interviewer wants to see you know the filter's size and hash count are *derived from the false-positive budget*, not guessed.

**Q3. Your crawler's Bloom filter says "seen" for a URL you know is new — what happened, and does it matter?**
It's a false positive — some combination of other URLs already set all of this URL's bit positions. It means the crawler will skip re-fetching a genuinely new URL. Whether it matters depends on the cost of a missed page vs. the cost of re-checking; usually you accept it and periodically reconcile against ground truth (e.g. the real "visited" store).

**Q4. Why put a Bloom filter in front of an SSTable lookup instead of just reading the SSTable?**
An LSM-tree read can touch many on-disk SSTables that don't contain the key at all — each is a wasted disk seek. A per-SSTable Bloom filter turns "does this file possibly have the key" into an in-memory check, so you only pay the disk cost for files that might actually have it.

**Q5 (senior). Would you ever choose a bigger false-positive rate on purpose?**
Yes — it's a memory/latency tradeoff, not a correctness one, as long as downstream logic tolerates "maybe." A tighter `p` costs more RAM per node; if the fallback path (DB lookup, disk read) is cheap and rare-hit is fine, a looser filter frees memory for something else. State the tradeoff explicitly rather than defaulting to "as low as possible."

---

## Where This Shows Up in This Repo

- [web-crawler/deep-dive.md §3 — URL Deduplication with Bloom Filters](../interviews/web-crawler/deep-dive.md#3-url-deduplication-with-bloom-filters)
- [storage-engines/deep-dive.md §5 — Bloom Filters and Friends](../interviews/storage-engines/deep-dive.md#5-bloom-filters-and-friends) (SSTable read-path skip)
