# Deep Dive: Database Storage Engines (LSM-Tree vs B-Tree)

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> Numbers marked **illustrative** are order-of-magnitude teaching aids — verify against your own hardware and engine version before quoting them.

---

## Table of Contents

1. [Why Storage Engines Matter: The Memory/Disk Gap](#1-why-storage-engines-matter-the-memorydisk-gap)
2. [The B-Tree: Read-Optimized In-Place Storage](#2-the-b-tree-read-optimized-in-place-storage)
3. [The LSM-Tree Write Path](#3-the-lsm-tree-write-path)
4. [The LSM Read Path](#4-the-lsm-read-path)
5. [Bloom Filters and Friends](#5-bloom-filters-and-friends)
6. [Compaction: Size-Tiered vs Leveled](#6-compaction-size-tiered-vs-leveled)
7. [Tombstones and the Problem of Deletes](#7-tombstones-and-the-problem-of-deletes)
8. [Amplification and the RUM Conjecture](#8-amplification-and-the-rum-conjecture)
9. [Durability: WAL, fsync, and Group Commit](#9-durability-wal-fsync-and-group-commit)
10. [Crash Recovery and Checkpoints](#10-crash-recovery-and-checkpoints)
11. [MVCC and Snapshot Isolation](#11-mvcc-and-snapshot-isolation)
12. [Choosing and Tuning an Engine](#12-choosing-and-tuning-an-engine)
13. [Failure Modes at Scale](#13-failure-modes-at-scale)
14. [Real-World Systems](#14-real-world-systems)
15. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. Why Storage Engines Matter: The Memory/Disk Gap

### 🟢 Beginner — The Desk and the Warehouse

Imagine you work at a desk (RAM) with a giant warehouse next door (disk). Anything on your desk you can grab instantly. Anything in the warehouse takes a walk. The warehouse is enormous and cheap; your desk is tiny and expensive.

Two more facts about the warehouse: (1) walking to a random shelf, grabbing one item, walking back, then doing it again for the next item is slow — lots of walking. But grabbing a whole row of adjacent items in one trip is efficient. (2) If the power goes out, whatever is on your desk vanishes, but the warehouse keeps its contents.

A storage engine is the clerk who decides what to keep on the desk, how to arrange the warehouse so trips are short, and how to make sure nothing important is lost if the lights go out. Every design choice in this topic comes back to these three facts: the desk is fast but small and volatile; the warehouse is big but slow; and walking in straight lines beats zig-zagging.

---

### 🟡 Senior — The Numbers Behind the Gap

The whole field exists because of a latency hierarchy spanning many orders of magnitude:

```
Approximate access latencies (illustrative, order-of-magnitude only):
  L1/L2 cache          ~1 ns
  Main memory (RAM)    ~100 ns
  NVMe SSD read        ~10-100 µs      (~100-1000x slower than RAM)
  SSD random write     slower + wears the device
  HDD seek             ~5-10 ms        (~50,000x+ slower than RAM)
  Network round trip   ~0.5 ms (same DC) to ~100 ms (cross-region)
```

Two consequences drive every engine decision:

1. **Keep the working set and index metadata in RAM; keep bulk data on disk.** B-tree upper levels, LSM MemTables, Bloom filters, and block caches all live in RAM precisely because touching disk is 100–1000× more expensive.
2. **Prefer sequential I/O.** Sequential access streams at device bandwidth; random access pays a per-op penalty (seek on HDD; lost parallelism + FTL garbage collection on SSD).

```
Sequential vs random, why it dominates design:
  B-tree:   accepts some random page I/O to keep data sorted in place (read-friendly).
  LSM-tree: refuses random writes on the hot path — appends sequentially, sorts later.
```

| Property | RAM | SSD | HDD |
|---|---|---|---|
| Latency | ~100 ns | ~10-100 µs | ~5-10 ms |
| Cost/byte | Highest | Middle | Lowest |
| Volatile? | Yes | No | No |
| Random I/O penalty | Negligible | Moderate (+ wear) | Severe (seek) |

---

### 🔴 Architect — Designing to the Storage Hierarchy

At design-review time, translate the workload into where each byte lives and how it moves:

```
Working-set sizing:
  If hot data fits in RAM (block cache / page cache), point reads mostly avoid disk.
  Rule of thumb: size the cache to the working set, not the whole dataset.
    e.g., 10 TB dataset, but 95% of reads hit 200 GB of hot keys →
          provision ~256 GB RAM/node for cache, not 10 TB.

I/O budget:
  Every engine has a disk-bandwidth budget shared by: WAL, flush, compaction, reads.
  Under-budgeting compaction bandwidth is the #1 cause of LSM write stalls (§13).

Media choice:
  LSM on SSD: watch write amplification vs endurance (DWPD) — see §8.
  B-tree on SSD: doublewrite/full-page writes add write volume — budget for it.
  HDD is viable for append-heavy, sequential LSM ingest with big blocks; poor for
  random-read B-tree OLTP.
```

**War story pattern (generic, widely reported):** teams migrate a random-read OLTP database from HDD to SSD and see a step-change in point-read latency — not because the algorithm changed, but because the random-I/O penalty that dominated the B-tree's leaf reads collapsed. The lesson for design reviews: **name the dominant I/O pattern first, then pick media and engine to match it.** The engine and the hardware are one decision, not two.

---

## 2. The B-Tree: Read-Optimized In-Place Storage

### 🟢 Beginner — The Library Card Catalog

A B-tree is like a library's card catalog with dividers. The top drawer says "A–F, G–M, N–S, T–Z." You pick "N–S," which points to a finer drawer "N, O, P…," which points to the shelf with the actual book. Three or four hops and you're holding the book — no matter how many millions of books the library has, because each divider narrows the search enormously.

When a new book arrives, you slot it into the right shelf in order. If the shelf is full, you split it into two half-full shelves and update the divider above. The catalog always stays sorted, so you can also walk a range ("give me every book from N to P") by just reading adjacent shelves in order.

---

### 🟡 Senior — B+Tree Mechanics

A B+tree stores data in fixed-size pages. Internal pages hold separator keys + child pointers; leaf pages hold the data and are linked for scans.

```python
# Conceptual B+tree lookup (illustrative, not a real engine API)
def search(node, key):
    while not node.is_leaf:
        i = upper_bound(node.keys, key)   # binary search within the page
        node = read_page(node.children[i]) # one page read (maybe cached)
    return node.find(key)                 # search the leaf page

# Height ≈ log_fanout(N). Fanout is large because pages are big and keys small.
#   16 KB page, ~ (key+pointer) ~ 32 B → fanout ~ 500 → 100M keys ≈ 3-4 levels
```

Insert with split:

```
insert(key, value):
    leaf = descend_to_leaf(key)
    if leaf.has_room():
        leaf.insert_sorted(key, value)          # in-place, cheap
    else:
        new_leaf = leaf.split()                 # move ~half entries out
        parent.insert_separator(new_leaf)       # may cascade splits upward
    # every modified page is protected by the WAL before it hits disk (§9)
```

| Operation | Cost | Notes |
|---|---|---|
| Point read | O(height) page reads | Upper levels usually cached → ~1 disk read (leaf) |
| Range scan | O(height + range) | Descend once, follow linked leaves sequentially |
| Insert/update | O(height) + maybe split | In-place page rewrite; full-page WAL on first touch |
| Space | Compact, one copy | Some free space (fill factor) + fragmentation |

The defining invariant: **the data is fully sorted, in place, at all times.** That single property is why B-trees serve point reads and range scans equally well — and why writes are comparatively expensive (rewrite a whole page, possibly split, log the full page).

---

### 🔴 Architect — Fill Factor, Right-Edge Hotspots, and Bloat

```
Fill factor tuning:
  Insert-heavy random keys → lower fill factor (leave headroom) → fewer splits.
  Read-mostly / bulk-loaded → high fill factor → denser pages → fewer reads.
  Postgres B-tree index default fill factor ≈ 90%.

Monotonic-key right-edge hotspot:
  Auto-increment / timestamp PK → all inserts land at the rightmost leaf →
  that page + its parents are constantly hot and splitting →
  contention and write amplification concentrate on one edge of the tree.
  Mitigation: hash/randomize the leading key bytes, or use an engine/strategy
  that spreads writes — this is one place LSM's append model is naturally better.

Index/table bloat (Postgres, §11):
  Under heavy UPDATE with lagging autovacuum, dead tuples accumulate → the heap and
  its B-tree indexes grow larger than the live data → scans read dead space → slowdowns.
```

**Production incident pattern (widely documented for Postgres):** a high-update table with autovacuum unable to keep up (or a long-running `idle in transaction` session holding back the vacuum horizon) bloats to several times its live size. Symptoms: growing disk, slower sequential and index scans, and a `pg_stat_user_tables` dead-tuple count that keeps climbing. The fix is operational, not algorithmic: make autovacuum more aggressive, kill long idle transactions, and `VACUUM`/`REINDEX` to reclaim. **Interview point:** a B-tree's in-place model is not automatically space-tight — MVCC turns it into a version-cleanup problem just like the LSM's compaction.

---

## 3. The LSM-Tree Write Path

### 🟢 Beginner — The Notebook and the Filing Cabinet

Imagine a busy receptionist taking messages. Every message, they scribble instantly onto a running notepad (fast, in order of arrival) *and* onto a carbon-copy pad that's stored safely (so nothing is lost if the notepad is knocked off the desk). They don't stop to file each message into the cabinet — that would be too slow.

When the notepad fills up, they sort its messages alphabetically and file the whole batch into the cabinet in one go, as a sealed, sorted folder they never edit again. Then they start a fresh notepad. Later, a back-office clerk periodically merges several old folders into fewer, tidier ones.

That's an LSM-tree: scribble fast (MemTable) with a safety carbon copy (WAL), flush sorted batches to sealed folders (SSTables), and merge folders in the background (compaction).

---

### 🟡 Senior — The Write Path in Code

```python
# Illustrative LSM write path (not a real engine API)
class LSMEngine:
    def put(self, key, value):
        # 1. Durability first: append to the WAL and (optionally) fsync
        self.wal.append(key, value)
        if self.sync_writes:
            self.wal.fsync()                 # durable now (see §9 for the tradeoff)

        # 2. Insert into the sorted in-memory MemTable (e.g., a skip list)
        self.memtable.insert(key, value)     # O(log n), keeps keys ordered

        # 3. Acknowledge: write is durable (WAL) AND queryable (MemTable)
        # 4. When MemTable is full, roll it over
        if self.memtable.size() >= self.flush_threshold:
            self._rotate_and_flush()

    def _rotate_and_flush(self):
        immutable = self.memtable            # freeze current MemTable
        self.memtable = SkipList()           # new writes go here immediately
        sstable = SSTable.write_sorted(immutable.iter_sorted())  # sequential write
        self.levels[0].add(sstable)
        self.wal.discard_segment(immutable.wal_segment)  # WAL for flushed data is safe to drop
```

Every disk touch on this path is **sequential**: the WAL append and the SSTable flush. There are no random in-place page writes. That is the entire reason LSM sustains high ingest.

| Step | Where | I/O pattern | Purpose |
|---|---|---|---|
| WAL append | Disk | Sequential | Durability before ack |
| MemTable insert | RAM | — | Queryable, keeps sort order |
| Flush | Disk | Sequential (one big write) | Persist a sorted, immutable SSTable |
| Compaction | Disk | Sequential read+write | Merge SSTables later (§6) |

---

### 🔴 Architect — MemTable Sizing and the WAL Durability Knob

```
MemTable size tuning:
  Larger MemTable → flushes less often → fewer, bigger L0 SSTables → less compaction
                    churn, but more RAM used and more data to replay on crash.
  Smaller MemTable → flushes often → many small L0 files → more compaction, more read
                    amplification, but faster recovery and less RAM.
  Common practice: a handful of MemTables of tens-to-hundreds of MB (engine/version
  dependent — verify defaults).

WAL durability knob (the key correctness decision):
  sync = true  → fsync per write (or per group, §9). Acked writes survive power loss.
  sync = false → ack before fsync. Higher throughput; crash loses the un-fsynced tail.
  This is a business decision: can you lose the last few ms of writes on a crash?
```

**Production incident pattern:** a team runs an LSM with the WAL in asynchronous mode for throughput, suffers a power loss, and discovers the most recent acknowledged writes are gone — because "acknowledged" meant "in the MemTable," not "fsynced to the WAL." The postmortem lesson is always the same: **decide the durability contract explicitly and configure `sync` to match it** (see A28). For financial or ledger data, sync-per-commit (with group commit for throughput, §9) is non-negotiable; for metrics you may accept a small loss window for speed.

---

## 4. The LSM Read Path

### 🟢 Beginner — Checking the Newest Notepad First

Back to the receptionist. Someone asks, "What's the latest message for Alice?" The receptionist checks the current notepad first (newest info). Not there? Check the folder filed most recently, then older folders, stopping the instant they find an entry for Alice — because the newest entry is the current truth.

To avoid rummaging through every folder, each sealed folder has a sticker on the front listing *roughly* who might be inside (a Bloom filter). If Alice's name definitely isn't on the sticker, skip the whole folder without opening it. That one trick is what keeps "check the newest first, then older" from becoming "open every folder every time."

---

### 🟡 Senior — Read Path with Short-Circuiting

```python
# Illustrative LSM read path
def get(self, key):
    # 1. Newest data first: active + immutable MemTables
    for mt in [self.memtable] + self.immutable_memtables:
        v = mt.get(key)
        if v is not None:
            return None if v.is_tombstone else v   # newest wins; tombstone = deleted

    # 2. SSTables, newest to oldest
    for sst in self.sstables_newest_to_oldest():
        if not sst.bloom.might_contain(key):
            continue                                # skip: definitely not here (no disk I/O)
        block = sst.index.find_block(key)           # sparse index → one block
        data = self.block_cache.get_or_read(sst, block)   # RAM or disk
        v = data.search(key)
        if v is not None:
            return None if v.is_tombstone else v    # first hit is the newest version
    return None                                     # not found anywhere
```

The three cost-reducers, in the order they help:

| Structure | Question it answers | Saves |
|---|---|---|
| Bloom filter | "Might this SSTable contain the key?" | Skips whole SSTables → avoids disk reads |
| Sparse block index | "Which block holds the key?" | Reads one block, not the whole file |
| Block cache | "Do we already have this block in RAM?" | Avoids disk I/O on repeat/hot reads |

Point reads of recent, existing keys are cheap (found early). The structural cost shows up for **non-existent keys** (must consider all levels — Bloom filters rescue this) and **range scans** (must merge across all overlapping SSTables — Bloom filters do *not* help; see §6/§8).

---

### 🔴 Architect — Read Amplification and Range-Scan Merges

```
Point-read worst case (non-existent key):
  Without Bloom filters → probe every overlapping SSTable → read amp = O(#SSTables).
  With well-sized Bloom filters → skip almost all → ~0 real reads on average, but
  false positives still cost the occasional wasted block read.

Range-scan cost (Bloom filters DON'T help):
  SCAN(a, b) must open an iterator over EVERY SSTable whose key range overlaps [a,b]
  and merge them (k-way merge, newest version wins). More overlapping SSTables →
  more streams to merge → slower scans. This is why read-heavy/scan-heavy LSM
  deployments use LEVELED compaction (≤1 SSTable per level → far fewer overlaps).

Levers to bound read cost:
  - Leveled compaction (bounds overlap per key).
  - Bigger, better Bloom filters (more bits/key → fewer false positives).
  - Larger block cache (serve hot blocks from RAM).
  - Reduce SSTable count (larger MemTables, keep compaction caught up).
```

**Production incident pattern:** a workload does frequent range scans over a Cassandra table on size-tiered compaction and suffers slow, variable scan latency. The cause is many overlapping SSTables per read; the fix is switching that table to leveled compaction (accepting higher write amplification) so each key lives in at most one SSTable per level. **Architect takeaway:** you tune the read path mostly through *compaction strategy and Bloom-filter sizing*, not by touching the read code — reads are a downstream consequence of how you chose to organize writes.

---

## 5. Bloom Filters and Friends

### 🟢 Beginner — The Guest List That Never Says "No" Wrongly

A bouncer has a smudged guest list. If your name isn't on it, you're **definitely** not invited — go home (no wasted trip inside). If your name *appears* to be on it, you *might* be invited — the bouncer checks the real list inside to be sure. Because the smudges can only *add* apparent names (never erase a real one), the list never wrongly turns away a real guest — but it can occasionally wave in someone who then turns out not to be on the real list.

That asymmetry — "never a wrong rejection, occasionally a wrong maybe" — is exactly a Bloom filter. It saves the expensive trip inside (a disk read) for names that are definitely not present.

---

### 🟡 Senior — Bloom Filter Implementation and Math

```python
class BloomFilter:
    def __init__(self, m_bits, k_hashes):
        self.bits = bytearray(m_bits // 8)
        self.m = m_bits
        self.k = k_hashes

    def add(self, key):
        for i in range(self.k):
            pos = self._hash(key, i) % self.m
            self.bits[pos // 8] |= (1 << (pos % 8))   # set bit; never cleared

    def might_contain(self, key):
        for i in range(self.k):
            pos = self._hash(key, i) % self.m
            if not (self.bits[pos // 8] & (1 << (pos % 8))):
                return False        # a zero bit ⇒ DEFINITELY not present (no false negatives)
        return True                 # all bits set ⇒ MAYBE (could be a false positive)
```

- **No false negatives:** an added key set all `k` of its bits; bits are never cleared, so those bits are still 1 → `might_contain` cannot return False for a present key.
- **False positives:** an absent key's `k` bits may all have been set by *other* keys → returns True wrongly. Cost = one wasted SSTable probe, not a correctness bug.

```
False-positive probability (standard approximation):
    p ≈ (1 - e^(-k·n/m))^k          # m bits, n elements, k hash functions
Optimal hash count:
    k_opt = (m/n) · ln 2
```

| Bits/element (m/n) | ~Optimal k | ~False-positive p |
|---|---|---|
| ~5 | ~3–4 | ~10% |
| ~10 | ~7 | ~1% |
| ~15 | ~10 | ~0.1% |

**Other probabilistic structures (same "approximate to fit in RAM" idea):**

| Structure | Estimates | Guarantee | Typical use |
|---|---|---|---|
| Bloom filter (1970) | Membership | No false negatives | LSM SSTable skipping |
| HyperLogLog (2007) | Distinct count | Bounded relative error | `COUNT(DISTINCT)`, Redis `PFCOUNT` |
| Count-Min Sketch (2005) | Item frequency | Overestimates only | Heavy hitters, rate tracking |

---

### 🔴 Architect — Tuning Filters and Memory Budget

```
Memory budget:
  Bloom filters live in RAM. Cost ≈ bits_per_key × keys.
    1B keys × 10 bits/key ≈ 10 Gbit ≈ ~1.25 GB RAM per replica just for filters.
  → bits/key is a RAM-vs-read-latency dial; budget it per column family / per level.

Where filters help and where they don't:
  ✓ Point GET of a non-existent or old key → skip SSTables cheaply.
  ✗ Range scans → no benefit (membership ≠ "any key in [a,b]").
  ✗ If almost every GET hits an existing recent key → filters add RAM cost for little
    benefit (the read stops in the MemTable / newest SSTable anyway).

Engine knobs:
  RocksDB: filter_policy = BloomFilter(bits_per_key); optional ribbon filters (newer,
           more space-efficient — verify availability in your version).
  Cassandra: bloom_filter_fp_chance per table (lower fp_chance = more RAM).
```

**Production incident pattern:** a team lowers `bloom_filter_fp_chance` aggressively (or raises RocksDB bits/key) across huge tables to shave read latency, and node memory pressure rises — filters now consume gigabytes of heap/off-heap RAM, triggering GC pauses or cache eviction that *hurts* overall latency. **Architect lesson:** Bloom-filter sizing is a RAM budget decision (the "M" in RUM). Tune fp-rate against the *actual* miss/read pattern and the RAM you can spare, not to the theoretical minimum.

---

## 6. Compaction: Size-Tiered vs Leveled

### 🟢 Beginner — Merging the Filing Folders

The receptionist keeps sealing sorted folders into the cabinet. Over time there are too many folders, and answering "latest message for Alice?" means checking many of them. So a back-office clerk periodically takes several folders, merges them into fewer bigger sorted folders (keeping only the newest note per person, tossing cancelled ones), and shreds the originals.

There are two philosophies. One: wait until you have several *same-sized* folders, then merge them into one bigger folder (less merging work, but more folders to check meanwhile). Two: keep strict shelves where each person appears in at most one folder per shelf, re-merging as folders move down shelves (more merging work, but any lookup checks very few folders). That's size-tiered vs leveled compaction.

---

### 🟡 Senior — The Two Strategies

```
SIZE-TIERED (STCS):
  L0: [s][s][s][s]  ← 4 similar-size SSTables accumulate
        merge → [ SS ]  (one bigger SSTable)
  Bigger tiers form the same way. SSTables in a tier CAN overlap in key range.
  → fewer rewrites (low write amp); more overlap (higher read + space amp).

LEVELED (LCS):
  L0: [a][b][c]                 ← overlapping (just-flushed)
  L1: [.....][.....][.....]     ← non-overlapping, sorted runs, ~10x L0
  L2: [..][..][..][..]...       ← non-overlapping, ~10x L1
  A key is in ≤1 SSTable per level (except L0). Compaction pushes data down,
  rewriting to keep levels non-overlapping.
  → more rewrites (high write amp); little overlap (low read + space amp).
```

```python
# Conceptual k-way merge at the heart of any compaction
def compact(sstables):
    iters = [s.iter_sorted() for s in sstables]     # each SSTable is sorted
    for key, versions in merge_sorted_by_key(iters):
        newest = max(versions, key=lambda v: v.seqno)
        if newest.is_tombstone and tombstone_expired(newest):
            continue                                # drop delete + shadowed data
        if is_obsolete(newest):
            continue                                # drop superseded versions
        yield key, newest                           # write to the new SSTable
```

| Axis | Size-tiered (STCS) | Leveled (LCS) |
|---|---|---|
| Write amplification | Lower | Higher |
| Space amplification | Higher (~2x+ transiently) | Lower |
| Read amplification | Higher | Lower |
| Best for | Write-heavy ingest | Read-heavy / space-sensitive |
| Used by | Cassandra STCS, RocksDB universal (spirit) | LevelDB, RocksDB default, Cassandra LCS |

---

### 🔴 Architect — Compaction as a Bandwidth Budget

```
The invariant you cannot break:
  sustained_ingest_rate ≤ compaction_throughput
Otherwise SSTables accumulate → read amp climbs → the engine stalls writes (§13).

Compaction bandwidth math (illustrative):
  Ingest 100 MB/s logical. Leveled write amp W ≈ 10-30 over a byte's life.
  → compaction must sustain ~ (W-1) × 100 MB/s of read+write bandwidth in the
    background, on top of serving live traffic. Provision disks + compaction
    threads for that, not for 100 MB/s.

Choosing a strategy in a design review:
  Write-heavy ingest, point reads      → size-tiered (minimize write amp)
  Read/scan-heavy or space-constrained → leveled (minimize read + space amp)
  Append-only + TTL (time-series)      → time-window (TWCS): drop whole expired windows
```

**Production incident pattern:** a Cassandra table on leveled compaction under a sudden write surge falls behind — pending compactions climb (`nodetool compactionstats`), L0/read amp rises, and write latency spikes. Teams sometimes make it *worse* by triggering a manual **major compaction**, which rewrites everything at once (huge I/O) and, in size-tiered, can produce one enormous SSTable that then can't be compacted with anything. **Architect lessons:** (1) match compaction strategy to the workload up front; (2) give compaction enough dedicated I/O/threads; (3) treat major compaction as a careful, planned operation, not a routine fix; (4) the real remedy is capping ingest to sustainable levels.

---

## 7. Tombstones and the Problem of Deletes

### 🟢 Beginner — You Can't Erase a Sealed Folder

The filing folders are sealed — you can't reach in and erase a note. So to "delete" Alice's message, the receptionist writes a new note: "Alice's message is cancelled" (a tombstone) onto the current notepad. Anyone looking for Alice sees the cancellation note first (it's newest) and reports "no message." The actual old note is only physically shredded later, when the clerk merges folders — and only after enough time has passed that every branch office has definitely seen the cancellation, so it can't accidentally come back.

---

### 🟡 Senior — Tombstone Lifecycle

```
DELETE(key):
  append a TOMBSTONE record for `key` (a normal write into MemTable → SSTable).

Read (newest-first) sees:
  SSTable_new: key = <TOMBSTONE @ seq 200>   ← found first → return "not found"
  SSTable_old: key = "value" @ seq 100        ← shadowed, never returned

Physical removal happens only when compaction:
  1. merges the tombstone WITH the older data it shadows (they must be in the same
     compaction), AND
  2. the tombstone is past its safety window (e.g., Cassandra gc_grace_seconds).
```

```
Two failure modes:

(1) Zombie / resurrected data (replicated systems):
    If a tombstone is GC'd before every replica has applied it, a replica that
    missed the delete can re-propagate the OLD value during repair/read-repair →
    the deleted row COMES BACK. gc_grace_seconds (default 10 days in Cassandra)
    exists to keep tombstones until anti-entropy repair has propagated them.

(2) Tombstone read overhead:
    Reads must scan PAST tombstones. A range scan over a region churned with
    insert-then-delete (a queue/table used as a work queue) can read thousands of
    tombstones to return a few live rows → slow scans, tombstone warnings, and in
    Cassandra a hard failure threshold (query aborted).
```

| Concern | Cause | Mitigation |
|---|---|---|
| Resurrection | Tombstone GC'd before all replicas saw it | Keep tombstones ≥ repair interval (gc_grace) |
| Slow reads | Many tombstones in scanned range | Avoid queue-like delete patterns; model data differently |
| Space held | Tombstone + shadowed data not yet merged | Ensure compaction actually co-locates them |

---

### 🔴 Architect — The Queue Anti-Pattern and gc_grace

**Production incident pattern (a classic Cassandra footgun):** an application uses a table as a work queue — insert a row, process it, delete it, repeat. Reads that scan the "head" of the queue must skip over all the recently deleted rows' tombstones. As delete volume grows, a `SELECT` that returns 10 live rows may scan tens of thousands of tombstones, blowing past the tombstone warning threshold and eventually the failure threshold, aborting queries. **Fixes:** don't model queues on an LSM this way (use a purpose-built queue, or partition by time and drop whole partitions); if you must, use TTLs + time-window compaction so entire aged partitions expire without per-row tombstones.

```
gc_grace_seconds is a correctness-vs-space tradeoff:
  Too LOW:  tombstones dropped before repair propagates them → resurrection risk.
  Too HIGH: tombstones (and shadowed data) linger → read + space overhead longer.
  Rule: gc_grace_seconds ≥ your repair cadence (so every replica sees the delete first).
```

**Architect takeaway:** deletes in an LSM are *writes*, and their cleanup is a distributed-systems problem (every replica must converge before erasure). Never treat delete as free or instantaneous — model access patterns to avoid mass tombstones, and keep `gc_grace` aligned with your repair schedule.

---

## 8. Amplification and the RUM Conjecture

### 🟢 Beginner — Squeeze the Balloon

Storage-engine design is like squeezing a long balloon. Push in the "reads are slow" end and the air bulges out at the "writes are slow" or "uses too much space" end. You can make any two ends flat, but the third always bulges. There is no way to flatten all three at once — the air (the work) has to go somewhere. Good engineers don't try to beat this; they decide *which end is allowed to bulge* for their particular workload.

---

### 🟡 Senior — The Three Amplifications and RUM

```
Read amplification  = storage reads per logical read
Write amplification = bytes written to storage per logical byte written
Space amplification = bytes on disk per byte of live data
```

The **RUM conjecture** (Athanassoulis et al., EDBT 2016): for **R**ead, **U**pdate, and **M**emory (space) overheads, you can optimize two but must give up on the third.

```
                Read
                 /\
                /  \
   pick two →  / RUM \  ← pay in the third
              /______ \
          Update     Memory(space)

B-tree     : low Read + low Memory  → pays in Update (write amp: full-page writes,
             random I/O, WAL/doublewrite).
LSM (STCS) : low Update             → pays in Read + Memory.
LSM (LCS)  : low Read + low Memory  → pays in Update (high write amp).
```

| Axis | B-tree | LSM (size-tiered) | LSM (leveled) |
|---|---|---|---|
| Read amp | Low | High | Low |
| Write amp | Medium–High (small updates) | Low | High |
| Space amp | Low | High | Low |

Every optimization is a move on this triangle: Bloom filters spend **Memory** to cut **Read**; leveled compaction spends **Update** to cut **Read + Memory**; larger block cache spends **Memory** to cut **Read**.

---

### 🔴 Architect — Write Amplification, SSD Endurance, and Total Cost

```
Total write amplification stacks:
  engine_WAF × device_WAF = flash_bytes_written / logical_bytes
    engine_WAF: LSM leveled ~10-30 (illustrative); B-tree ~2-ish from full-page/doublewrite
    device_WAF: SSD FTL garbage collection, often ~1.5-3x depending on fill/overprovision

SSD endurance budget:
  drive_endurance = capacity_GB × DWPD × 365 × warranty_years   (total bytes writable)
  daily_flash_writes = logical_write_rate × engine_WAF × device_WAF
  → confirm daily_flash_writes × lifetime ≤ drive_endurance, or the fleet wears out early.

Levers to cut write amplification:
  - Size-tiered instead of leveled (less rewriting) — trades read+space.
  - Key-value separation: store large values outside the LSM so they aren't rewritten
    on every compaction (RocksDB BlobDB; the WiscKey design). Big win for large values.
  - Larger MemTables / fewer, bigger SSTables → fewer compaction passes.
```

**Production incident pattern:** a large write-heavy fleet on leveled compaction sees SSDs approaching their rated endurance far ahead of schedule — the stacked engine × device write amplification wrote several times more to flash than the logical ingest implied. **Facebook's MyRocks migration** (RocksDB under MySQL, publicly discussed) was motivated substantially by RocksDB's lower space *and* write amplification vs InnoDB for their workload — a concrete example of choosing an engine by its position on the RUM triangle. **Architect takeaway:** write amplification is not academic — it is a line item in both storage cost and hardware-replacement cost, and it belongs in the capacity model.

---

## 9. Durability: WAL, fsync, and Group Commit

### 🟢 Beginner — Carbon Copy Before You Say "Done"

A dispatcher takes an order over the phone. Before saying "got it," they write the order on a carbon-copy pad that survives even if the desk is flipped over. Only after the copy is safely made do they tell the customer "done." If they said "done" first and *then* wrote it down, a sudden disaster could lose an order they already promised.

Two dispatchers can be smart: instead of each running to the safe separately, they wait a heartbeat, gather several orders, and file them all in one trip — everyone still gets a real "safely stored" guarantee, but the trips are shared. That shared trip is group commit.

---

### 🟡 Senior — What fsync Actually Guarantees

```
write(fd, data):    copies data into the OS page cache. NOT durable — power loss loses it.
fsync(fd):          forces the file's cached data to the storage device. Durable*.
   * caveat: the drive may hold data in a volatile write cache unless it honors
     flush/FUA. Enterprise deployments disable the volatile cache or use
     power-loss-protected (capacitor/battery-backed) drives.

Golden rule (Write-Ahead Logging): append the change to the WAL and fsync it
BEFORE acknowledging the client (for sync durability) and before writing data pages
in place (for torn-page safety, §10).
```

```python
# The durability decision in one place
def commit(txn):
    wal.append(txn.records)          # sequential
    if durability == "sync":
        wal.fsync()                  # wait for the device → durable, slower
    ack(txn)                         # only now tell the client "committed"
    # if durability == "async": ack before fsync → faster, small loss window on crash
```

| Mode | Guarantee | Cost |
|---|---|---|
| `fsync` per commit | Every acked write survives power loss | Bounded by device fsync latency |
| Group commit (sync) | Same durability, shared fsync | Slightly higher latency, much higher throughput |
| Async / batched (no per-commit fsync) | Loses un-fsynced tail on crash | Fastest |

Engine knobs (verify per version): Postgres `synchronous_commit`, MySQL `innodb_flush_log_at_trx_commit`, RocksDB `WriteOptions.sync`.

---

### 🔴 Architect — Group Commit and the Durability Contract

```
Why group commit is a free lunch (almost):
  N concurrent commits, per-commit fsync → N × fsync_latency total device flushes.
  Group commit batches them → 1 fsync serves all N → throughput scales with concurrency,
  and EVERY commit still waited for a real fsync (durability intact).
  The only cost: a single commit may wait a few ms to join the batch.

Set the durability contract per data class:
  Ledger / payments / orders   → sync commit (+ group commit for throughput). No loss.
  User-generated content        → sync commit typically.
  Metrics / logs / telemetry    → async acceptable; a few ms of loss on crash is fine
                                   in exchange for much higher ingest.
```

**Production incident pattern:** a service is configured for maximum throughput with `innodb_flush_log_at_trx_commit=2` (or a WAL in async mode) — writes are acked from the OS cache, not the disk. A power event (not just a process crash) loses the last window of "committed" transactions, violating a durability promise the product implicitly made. **Architect lesson:** `=2`/async survives a *process* crash but **not a power loss**; only per-commit (or group) `fsync` survives power loss. Choose the level deliberately, document it, and use group commit to recover the throughput you were tempted to buy by weakening durability.

---

## 10. Crash Recovery and Checkpoints

### 🟢 Beginner — Rebuilding From the Carbon Copies

The lights go out and come back. The current notepad is gone (it was on the volatile desk), but the carbon-copy pad in the safe survived. The receptionist rebuilds the lost notepad by re-reading the carbon copies made since the last time they filed everything into the cabinet. Sealed folders in the cabinet were already safe, so there's nothing to redo for those. A "checkpoint" is simply the last moment they knew everything up to that point was safely filed — recovery only has to replay from there, not from the beginning of time.

---

### 🟡 Senior — Two Recovery Models

```
LSM recovery (simple, thanks to immutability):
  1. Flushed SSTables are immutable & durable → nothing to recover there.
  2. Find WAL segments not yet captured by a flushed SSTable.
  3. Replay them into a fresh MemTable → in-memory state restored.
  4. Resume. (A "checkpoint" ≈ a successful MemTable→SSTable flush; its WAL can drop.)

B-tree recovery (ARIES-style redo/undo):
  1. Start from the last checkpoint (dirty pages flushed, WAL position recorded).
  2. REDO all WAL records after it → reapply every change (repeat history).
  3. UNDO changes of transactions uncommitted at crash → leave only committed state.
  4. Repair torn pages via full-page images / doublewrite (§2, §9).
```

| | B-tree | LSM |
|---|---|---|
| Already safe at crash | Pages up to last checkpoint | All flushed SSTables |
| Work on recovery | Redo committed + undo uncommitted | Replay un-flushed WAL into MemTable |
| Torn-page handling | Full-page image / doublewrite | N/A (files are whole-or-nothing) |
| Recovery time bound | WAL since last checkpoint | WAL since last flush |
| Relative complexity | Higher | Lower |

Checkpoint frequency is the universal recovery-time dial: frequent checkpoints/flushes → less WAL to replay → faster recovery, but more steady-state I/O.

---

### 🔴 Architect — Recovery Time and Checkpoint Tuning

```
Recovery time ≈ (bytes of WAL to replay) / (replay throughput)

  Bigger MemTables / rarer checkpoints → more WAL to replay → longer recovery.
  Frequent flushes/checkpoints → faster recovery → more compaction/IO churn.
  → this is an availability (MTTR) vs steady-state-throughput tradeoff.

Set recovery targets from SLOs:
  If a node must rejoin within, say, 2 minutes, cap WAL-since-checkpoint so replay
  fits that budget on your hardware. Test it: kill -9 under load and measure real
  recovery time (chaos test, §13).
```

**Production incident pattern:** a database tuned for peak throughput uses very large MemTables/infrequent checkpoints; after an unclean shutdown, startup takes far longer than expected because there is a large WAL to replay, extending an outage. **Architect lesson:** recovery time is a design parameter, not an afterthought — checkpoint/flush frequency trades steady-state I/O for MTTR, and the LSM's immutable-SSTable model gives it a structurally simpler, often faster recovery than a B-tree's redo/undo (a genuine operational advantage worth stating in a review).

---

## 11. MVCC and Snapshot Isolation

### 🟢 Beginner — Photos, Not Live Edits

Imagine a shared document where, instead of everyone editing the same page (and seeing each other's half-finished sentences), each reader is handed a **photo** of the document as it looked the instant they started reading. Writers keep making new versions, but your photo never changes under you — you see a clean, consistent snapshot from start to finish. Old photos nobody is looking at anymore get thrown away later to save space. That's multi-version concurrency control: many versions coexist, each reader pinned to a consistent snapshot, and a janitor cleans up the versions no one needs.

---

### 🟡 Senior — MVCC Across Engines

```
Core idea: never overwrite in place; keep multiple versions tagged with a
version/timestamp. A reader picks a snapshot and sees only versions ≤ its snapshot.
→ readers don't block writers; writers don't block readers; no half-written reads.
```

| Engine | Old versions stored | Snapshot read | Cleanup | Failure if cleanup lags |
|---|---|---|---|---|
| **LSM (RocksDB/Cassandra)** | Newer SSTables (each cell has a seqno/timestamp) | Ignore versions with seqno > snapshot | Compaction drops obsolete versions | Space + read amp (obsolete versions) |
| **Postgres** | In the heap (each tuple has xmin/xmax) | Show tuples visible to the snapshot | VACUUM removes dead tuples | Table/index **bloat** |
| **InnoDB** | Undo log (rollback segments) | Reconstruct via undo chain walk | Purge thread frees undo | **Undo growth** from long readers |

```
LSM snapshot (natural fit): immutability means a snapshot is just "don't look at
sequence numbers above N." Nothing is mutated under the reader; old SSTables pinned
by an open snapshot simply aren't deleted until the snapshot closes.
```

The unifying insight: **MVCC everywhere creates obsolete versions that must be reclaimed** — LSM via compaction, Postgres via VACUUM, InnoDB via undo purge. It's the same cleanup problem in three costumes.

---

### 🔴 Architect — Long Transactions and the Cleanup Horizon

```
The shared danger: a long-running reader/transaction pins old versions.
  Postgres: a long or idle-in-transaction session holds back the VACUUM "xmin horizon"
            → dead tuples across the DB can't be reclaimed → global bloat.
  InnoDB:   a long-running read pins undo it might need → undo log / history list grows.
  LSM:      a long-held snapshot/iterator keeps old SSTables from being deleted after
            compaction → disk usage stays high.

Operational rules:
  - Cap transaction/statement duration; alert on idle-in-transaction (Postgres).
  - Monitor: dead tuples & autovacuum lag (Postgres); history list length (InnoDB);
    live-vs-total SST size & num-snapshots (RocksDB).
  - Don't hold read snapshots open across long-running analytics on an OLTP store.
```

**Production incident pattern:** a forgotten `BEGIN;` in a psql session (or a stuck analytics job) sits idle-in-transaction for hours on a busy Postgres primary. Autovacuum runs but cannot remove dead tuples newer than that session's snapshot, so the whole database bloats and query latency climbs — until someone finds and kills the session. **Architect lesson:** MVCC's concurrency benefit comes with a cleanup contract; a single long-lived reader can globally sabotage cleanup on *any* MVCC engine. Bound transaction lifetimes and monitor the cleanup horizon.

---

## 12. Choosing and Tuning an Engine

### 🟢 Beginner — Right Tool for the Job

You wouldn't use a race car to move furniture or a moving truck to win a race. An LSM-tree is the moving truck: it hauls huge volumes of incoming writes efficiently. A B-tree is the race car: it darts to any specific record and runs ordered laps (range scans) with steady, predictable timing. The skill isn't loving one vehicle — it's matching the vehicle to the trip.

---

### 🟡 Senior — Decision Matrix

```
Ask, in order:
  1. What dominates — writes or reads?         writes → lean LSM; reads → lean B-tree
  2. Are the writes tiny+random or large+seq?  tiny random → LSM shines;
                                               large/seq → B-tree gap shrinks
  3. Range scans / rich queries / joins?       yes → B-tree (or leveled LSM for scans)
  4. Transactions, secondary indexes, FKs?     yes → mature B-tree engine
  5. Predictable tail latency required?         yes → B-tree (no compaction spikes)
  6. Space efficiency critical?                 B-tree steady; LSM leveled ~good, STCS worse
```

| Requirement | Engine | Why |
|---|---|---|
| High-rate small writes, point reads | LSM (size-tiered) | Sequential appends, low write amp |
| Read-heavy + range scans | B-tree | One cached descent + native ordered scans |
| Read-heavy but must be LSM | LSM (leveled) + big Bloom filters + block cache | Bounds read amp |
| Time-series + TTL | LSM (time-window compaction) | Cheap whole-window expiry |
| OLTP: transactions, joins, secondary indexes | B-tree (Postgres/InnoDB) | Mature transactional MVCC + planner |
| Predictable p99 | B-tree | No background compaction stalls |

---

### 🔴 Architect — Capacity Math for a Write-Heavy Ingest

```
Workload: 500,000 writes/sec, 200 B/record, 90-day retention, recent-range reads.
Choice: LSM (Cassandra/ScyllaDB or RocksDB-based) + size-tiered or time-window compaction.

WRITE BANDWIDTH:
  logical = 500k × 200 B = 100 MB/s
  device write BW ≈ logical × (WAL 1 + flush 1 + compaction W)
    W ≈ 10 (leveled, illustrative) → ≈ 100 MB/s × 12 ≈ 1.2 GB/s to provision

STORAGE FOOTPRINT:
  daily logical = 100 MB/s × 86,400 ≈ 8.64 TB/day
  90 days       ≈ 778 TB logical
  × space amp (~1.5) ≈ 1.1 PB
  × RF (3)           ≈ 3.3 PB
  ÷ utilization (0.6) ≈ 5.5 PB provisioned → ÷ per-node usable = node count

SSD ENDURANCE:
  ~1.2 GB/s × 86,400 ≈ ~104 TB/day to flash (pre device-amp)
  check vs Σ(capacity × DWPD) across the fleet over drive lifetime
```

**The headline move in the review:** provision for **amplified** write bandwidth and **replicated, space-amplified** footprint, not the logical numbers. Under-provisioning compaction throughput → write stalls (§13). Use TTL + time-window compaction so aged data drops as whole files. **This is the difference between a candidate who says "use LSM for writes" and one who sizes the cluster.**

---

## 13. Failure Modes at Scale

### 🟢 Beginner — The Chain of Dominoes

In storage engines, one thing rarely breaks alone. Writes outrun cleanup, cleanup falls behind, files pile up, reads slow down, and the system throttles new writes to protect itself — one domino knocking the next. Knowing storage-engine failure modes means knowing which domino falls first so you can catch it early.

---

### 🟡 Senior — Common Failure Scenarios

```
Failure 1: Write stall (compaction can't keep up)
  Cause: sustained ingest > compaction throughput → L0 files / pending bytes pile up
  Symptom: sawtooth write-latency spikes; "stopping writes" in logs
  Detect: L0 file count, pending_compaction_bytes (RocksDB); nodetool compactionstats
  Fix: more compaction threads/BW, faster disks, cap ingest, tune triggers

Failure 2: Tombstone flood
  Cause: insert-then-delete (queue) pattern → reads scan thousands of tombstones
  Symptom: slow range scans; tombstone warnings; queries aborted at the threshold
  Detect: droppable tombstone ratio; tombstone-per-read metrics
  Fix: don't model queues on LSM; TTL + time-window compaction; remodel access

Failure 3: Space amplification runaway
  Cause: size-tiered overlap, lagging compaction, pinned snapshots, un-GC'd tombstones
  Symptom: on-disk size = 2-3x logical and not falling
  Detect: live-vs-total SST size; du vs logical; num-snapshots
  Fix: leveled compaction, catch up compaction, release snapshots, TTL windows

Failure 4: Durability gap on power loss
  Cause: async/batched WAL (ack before fsync) → un-fsynced tail lost on power loss
  Symptom: "committed" writes missing after an unclean power event
  Detect: audit durability config vs the promised contract
  Fix: sync commit + group commit for the data classes that require it

Failure 5: B-tree bloat / undo growth (MVCC cleanup lag)
  Cause: lagging VACUUM (Postgres) or long readers pinning undo (InnoDB)
  Symptom: disk growth, slowing scans (PG); growing history list (InnoDB)
  Detect: dead-tuple count + autovacuum lag; InnoDB history list length
  Fix: tune autovacuum, kill long/idle-in-transaction sessions
```

---

### 🔴 Architect — Chaos Tests for Storage Engines

```
Chaos test 1: Kill -9 under write load
  Action: hard-kill the process at peak ingest.
  Observe: on restart, all ACKED writes present (if sync WAL); recovery within SLO.
  Pass: zero acknowledged-write loss; recovery time ≤ MTTR budget.

Chaos test 2: Power-loss simulation (pull the plug / cut VM power)
  Action: cut power (not a clean shutdown) mid-write.
  Observe: with sync commit → no acked loss; with async → measure the loss window.
  Pass: loss behavior matches the documented durability contract exactly.

Chaos test 3: Ingest > compaction (induce a stall)
  Action: drive writes above sustainable compaction throughput.
  Observe: engine throttles writes gracefully; no crash, no unbounded read amp.
  Pass: write stalls engage as designed; system recovers when ingest drops.

Chaos test 4: Disk-full during compaction
  Action: fill the volume while compaction is running.
  Observe: engine should refuse writes / degrade safely, not corrupt data.
  Pass: no corruption; clear errors; recovery after space is freed.

Chaos test 5: Long-running reader (MVCC cleanup)
  Action: hold a snapshot/transaction open for hours under write load.
  Observe: quantify bloat/undo/pinned-SSTable growth; verify monitoring fires.
  Pass: alerts trigger before space/latency SLOs are breached.
```

**Interview point:** the root cause of the flagship LSM failure (write stall) is always the same inequality — **ingest rate exceeded compaction throughput.** Everything else is a symptom. Design so sustainable ingest ≤ compaction throughput, and provision headroom for surges.

---

## 14. Real-World Systems

### 🟢 Beginner — Same Two Ideas, Many Products

Almost every database is one of these two shapes underneath — a B-tree (update in place, read-friendly) or an LSM-tree (append and merge, write-friendly) — plus policies layered on top (how aggressively to compact, how big the Bloom filters are, how durable each write must be). Learn the two shapes and you can reason about almost any storage system you meet.

---

### 🟡 Senior — System-by-System

**B-tree family:**

```
PostgreSQL:
  - B+tree indexes; heap tables (rows in an unordered heap, indexes point in).
  - WAL for durability; full_page_writes for torn-page safety.
  - MVCC keeps old versions IN THE HEAP → VACUUM/autovacuum reclaims → bloat risk.
  - Great for: transactions, joins, rich queries, range scans.

MySQL / InnoDB:
  - Clustered B+tree: table rows stored in primary-key order in the leaves.
  - Redo log (WAL) + undo log; doublewrite buffer for torn-page safety.
  - MVCC keeps old versions in the UNDO LOG → purge reclaims → undo-growth risk.
  - Default page 16 KB.
```

**LSM family:**

```
LevelDB (Google):
  - The compact reference LSM: MemTable (skip list) → SSTables, leveled compaction.
  - Single-process embedded KV library; basis for many systems.

RocksDB (Meta, fork of LevelDB):
  - Production LSM engine: column families, leveled + universal compaction, tunable
    Bloom filters, block cache, WAL, snapshots. Embedded in many databases.
  - MyRocks = RocksDB under MySQL (chosen for space + write efficiency at Meta).

Apache Cassandra / ScyllaDB:
  - Commit log (WAL) → MemTable → SSTables; STCS / LCS / TWCS compaction.
  - Tombstones + gc_grace_seconds; Bloom filters per SSTable.
  - ScyllaDB = C++ reimplementation of Cassandra (shard-per-core), same LSM model.

HBase / Google Bigtable:
  - Bigtable (2006 paper) originated the MemTable + SSTable design.
  - HBase: WAL (HLog) → MemStore → HFiles (SSTables) on HDFS; compaction merges HFiles.
```

| System | Engine shape | Compaction / cleanup | Notable trait |
|---|---|---|---|
| PostgreSQL | B+tree + heap | VACUUM (dead tuples) | Rich SQL, MVCC in heap |
| MySQL/InnoDB | Clustered B+tree | Undo purge | Rows in PK order, doublewrite |
| RocksDB | LSM | Leveled/universal | Embeddable, highly tunable |
| Cassandra/ScyllaDB | LSM | STCS/LCS/TWCS | Distributed, tombstones+gc_grace |
| HBase/Bigtable | LSM | HFile compaction | Origin of MemTable/SSTable terms |

---

### 🔴 Architect — Why Each System Made Its Choice

```
Facebook → MyRocks (RocksDB) under MySQL:
  Motivation (publicly discussed): InnoDB's space AND write amplification were too high
  for their write-heavy, space-sensitive workload. RocksDB's LSM cut both. A textbook
  "moved along the RUM triangle for our workload" decision — they traded some read
  overhead for much better space + write efficiency.

Cassandra/ScyllaDB → LSM for write-scalable, masterless storage:
  Append-only writes + per-node SSTables suit high-ingest, horizontally scaled,
  eventually-consistent workloads. The cost is tombstone management and compaction
  operational load — real, and a frequent source of incidents (§7, §13).

PostgreSQL/InnoDB → B-tree for transactional, query-rich OLTP:
  In-place B-trees give low read amp, native range scans, and mature transactional
  MVCC — at the cost of write amplification (full-page writes / doublewrite) and a
  cleanup burden (VACUUM / undo purge).

Bigtable → SSTable model at Google scale:
  The 2006 Bigtable paper established MemTable + immutable SSTable + compaction as the
  scalable-storage blueprint that LevelDB, RocksDB, Cassandra, and HBase all inherit.
```

**Interview-ready synthesis:** every one of these choices is explainable in RUM terms plus the workload's read/write/scan mix and durability needs. A staff-level answer names the engine, the amplification axis it optimizes, the axis it sacrifices, and the operational cost that sacrifice creates (compaction stalls, tombstones, bloat, undo growth). **Avoid "X is faster than Y."** The correct frame is always "X trades _this_ axis for _that_ axis, which fits _this_ workload."

---

## Quick Recall Cheat Sheet

> Close this file. Try to answer these from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Why engines exist | RAM fast/small/volatile; disk slow/big; sequential ≫ random I/O |
| B-tree shape | Sorted pages, high fanout → height ~3–4; one bounded descent per read |
| B-tree writes | In-place page rewrite (+ full-page WAL/doublewrite) → write amplification |
| Page split / fill factor | Full page + insert → split; 100% fill under inserts → constant splitting |
| Right-edge hotspot | Monotonic key → all inserts at rightmost leaf → contention |
| LSM write path | WAL append + MemTable insert → ack; flush MemTable → immutable SSTable |
| MemTable | Sorted in-memory (skip list) → ordered flush + range scans |
| SSTable | Sorted, immutable file: data + sparse block index + Bloom filter |
| LSM read path | MemTable → SSTables newest-first; Bloom skips, sparse index locates, cache serves |
| Bloom filter | No false negatives (bits never cleared); tunable false positives; ~10 bits/elem ≈ 1% |
| Bloom optimal k | k = (m/n)·ln2; too high or too low both raise false positives |
| Read amp worst case | Non-existent key w/o Bloom → probe every overlapping SSTable; scans get no Bloom help |
| Compaction | Merge SSTables, drop obsolete/expired tombstones; without it reads+space explode |
| STCS vs LCS | Size-tiered: low write amp, high read/space; Leveled: low read/space, high write amp |
| TWCS | Time-window compaction: drop whole expired windows; for append-only TTL data |
| Tombstone | Delete marker; keep ≥ repair interval (gc_grace) or deleted data resurrects |
| Write stall | Ingest > compaction → too many L0 files → engine throttles/blocks writes |
| RUM conjecture | Read/Update/Memory: optimize two, pay in the third |
| 3 amplifications | Read (reads/logical read), Write (bytes/logical byte), Space (disk/live data) |
| Write amp on SSD | engine_WAF × device_WAF → flash wear → shorter SSD life; a cost line item |
| Key-value separation | Store big values outside the LSM (BlobDB/WiscKey) → cut write amplification |
| WAL + fsync | write = page cache; fsync = durable; sync=safe/slow, async=fast/loss window |
| Group commit | Batch many commits into one fsync → throughput up, durability intact |
| Async ≠ power-safe | innodb=2 / async WAL survive process crash, NOT power loss |
| Crash recovery | B-tree: redo+undo from checkpoint; LSM: replay WAL into fresh MemTable |
| Checkpoint | Bounds WAL replay → recovery time; frequency trades MTTR vs steady I/O |
| MVCC | Versioned rows + snapshot; readers don't block writers; needs cleanup |
| Postgres vs InnoDB MVCC | PG: versions in heap → bloat/VACUUM; InnoDB: versions in undo → undo growth |
| Long reader danger | One long transaction stalls cleanup on ANY MVCC engine → bloat/undo/pinned SSTables |
| HyperLogLog / Count-Min | Approximate distinct-count / frequency in tiny RAM (accuracy vs memory) |
| Engine choice rule | Write/point-heavy → LSM; read/scan/txn-heavy → B-tree |
| "Write-heavy" is not enough | Write SHAPE (small-random vs large-seq) + read/scan/txn mix decide LSM vs B-tree |
| Capacity math move | Provision for amplified write BW + replicated, space-amplified footprint |
| Real systems | B-tree: Postgres, InnoDB. LSM: RocksDB/LevelDB, Cassandra/Scylla, HBase/Bigtable |
