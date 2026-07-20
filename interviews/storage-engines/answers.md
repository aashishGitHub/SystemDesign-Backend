# Answers: Database Storage Engines (LSM-Tree vs B-Tree)

> Keyed to [questions.md](./questions.md). Read questions first — attempt each before coming here.
> Every answer contains code or a comparison table, plus named tradeoffs on decisions that matter.
> Latency/throughput numbers are labeled **illustrative** where given — verify against your own hardware.

---

## Level 1 — Why Storage Engines Matter

### A1. What a storage engine does

A storage engine is the component of a database that decides **how data is physically laid out on disk and in memory, and how it is read back, written, and kept durable**. The query planner decides *what* to fetch; the storage engine decides *how* the bytes are stored, indexed, and recovered after a crash.

Its one job: turn logical operations (`PUT`, `GET`, `SCAN`) into physical I/O that is as cheap as possible for the expected workload, while guaranteeing that acknowledged writes survive failure.

| Layer | Responsibility |
|---|---|
| Query engine | Parse, plan, optimize *what* to read |
| **Storage engine** | Physical layout, indexes, durability, recovery — *how* to read/write |
| OS / filesystem | Page cache, block device access |
| Hardware | The actual bytes on SSD/HDD/RAM |

The same database can swap engines: MySQL runs InnoDB (B-tree) or MyRocks (LSM, built on RocksDB) under the same SQL surface. The engine choice changes performance characteristics, not the API.

---

### A2. Random vs sequential I/O

**Sequential I/O is dramatically cheaper than random I/O.** Reading or writing bytes that are physically contiguous lets the device stream at full bandwidth; jumping to scattered locations pays a per-operation cost (seek time on HDDs, and on SSDs the cost of read/erase/program cycles and lost parallelism).

```
HDD: a seek is mechanical (move the head) — random I/O can be ~100x slower
     than sequential for the same bytes. (illustrative order of magnitude)

SSD: no seek, but random writes still hurt — the flash translation layer must
     do garbage collection (read-erase-rewrite whole blocks), amplifying writes.
     Sequential writes let the FTL work efficiently.
```

| Access pattern | HDD | SSD |
|---|---|---|
| Sequential read/write | Fast (full bandwidth) | Fast |
| Random read | Very slow (seek per op) | Fast-ish (still loses parallelism) |
| Random write | Very slow | Slow-ish + wears the device (GC amplification) |

**This is the single fact that explains the entire B-tree-vs-LSM design space.** LSM-trees exist to convert random writes into sequential ones. B-trees accept some random I/O in exchange for read-friendly, in-place layout.

---

### A3. Why not just keep everything in RAM

Three reasons: **capacity, cost, and durability.**

```
Capacity: datasets routinely exceed RAM. A 10 TB dataset does not fit in a
          256 GB machine. You need a tiered design: hot data in RAM, the rest on disk.

Cost:     RAM costs far more per byte than SSD, which costs more than HDD.
          Keeping cold data on cheaper media is an economic requirement, not a limitation.

Durability: RAM is volatile. Power loss = data gone. Even a pure in-memory database
            (Redis, VoltDB) must write to disk (AOF/snapshots, command log) to survive
            a restart. The storage engine is where durability lives.
```

Even in-memory-first systems have a storage engine underneath for persistence. Redis persists via RDB snapshots and/or the append-only file (AOF). The disk cannot be designed away — it can only be hidden behind caching.

**Tradeoff: Latency vs Durability vs Cost.** More RAM buys latency but costs money and still needs a durable backing store. The storage engine is the machinery that manages the memory/disk boundary.

---

### A4. The read/write/space tradeoff

A storage engine can be tuned to make **reads cheap, writes cheap, or space cheap — but pushing on one axis usually costs you another.** This is formalized as the RUM conjecture (Level 6), and it is the master tradeoff of the whole topic.

| Optimize for | Technique | What it costs |
|---|---|---|
| **Reads** | Keep data sorted and updated in place (B-tree) | Writes become random-ish + full-page WAL; more write amplification |
| **Writes** | Append everything, sort/merge later (LSM) | Reads must check many files; space temporarily bloats before compaction |
| **Space** | Compress, compact aggressively, no redundant copies | More CPU and I/O spent on compaction → hurts write throughput / latency |

Why the tension exists: to make reads fast you need order and locality *now*, which means doing sorting work at write time (expensive writes) or keeping extra index/cache structures (space). To make writes fast you defer the sorting work, which pushes cost onto reads (many files to check) and space (duplicate/obsolete versions until merged). You are always moving work between write-time, read-time, and storage.

---

## Level 2 — B-Tree Fundamentals

### A5. B+tree structure, fanout, and height

A B+tree stores data in fixed-size **pages** (typically 4–16 KB; InnoDB's default page is 16 KB, Postgres's is 8 KB). Internal pages hold keys + child pointers; **leaf pages** hold the actual keys/values (in a B+tree, all values live in the leaves, and leaves are linked for range scans).

- **Fanout** = number of child pointers per page. Because pages are large and keys/pointers are small, fanout is high (hundreds).
- **Height** = number of levels from root to leaf. Because fanout is high, height is tiny.

```
Height ≈ log_fanout(number_of_keys)

100M keys, fanout 500:
  log_500(100,000,000) = ln(1e8) / ln(500) ≈ 18.4 / 6.2 ≈ 2.97
  → ~3 levels of internal nodes + leaves ≈ 3–4 page reads to reach any row
```

| Keys | Fanout 500 → height | Page reads for point lookup |
|---|---|---|
| 250K | ~2 | 2–3 |
| 100M | ~3 | 3–4 |
| 50B | ~4 | 4–5 |

Why height matters: each level is potentially one disk read (unless cached). A 3–4 level tree means **any row is ~3–4 page reads away**, and the upper levels are almost always cached, so most lookups touch disk once (the leaf). This bounded, shallow depth is why B-trees give predictable point-read latency. Postgres and InnoDB both use B+trees for their indexes; InnoDB's primary key is a *clustered* B+tree (the row data lives in the leaf).

---

### A6. B-tree point lookup vs range scan

```
Point lookup GET(key):
  root → binary search within page → follow child pointer
       → next internal page → ... → leaf page → find key. Done in ~height reads.

Range scan SCAN(start, end):
  Descend to the leaf holding `start` (like a point lookup),
  then walk the linked list of leaf pages sequentially until `end`.
  Because leaves are sorted and linked, a range scan is (mostly) sequential I/O.
```

| Operation | B-tree behavior | Cost |
|---|---|---|
| Point lookup | Descend root → leaf | O(height) page reads |
| Range scan | Descend once, then follow leaf links | O(height + range_size) |
| Insert | Descend to leaf, write in place (maybe split) | O(height) + possible split |

The B-tree is good at **both** because its data is kept *fully sorted at all times*. That single invariant serves point lookups (binary descent) and range scans (linked, ordered leaves) equally well. This is exactly why relational databases, which must support arbitrary indexed range predicates (`WHERE created_at BETWEEN ...`), default to B-trees.

---

### A7. In-place updates: read-optimized, write-amplifying

An **in-place update** means: to change a value, the engine finds the page holding it and rewrites that page on disk in the same location.

```
UPDATE user:42 SET name='Bob'
  → find leaf page P containing user:42     (read)
  → modify the 12 bytes for user:42 in P    (in memory)
  → write the ENTIRE page P back to disk     (write, e.g. 8-16 KB for a 12-byte change)
```

- **Why read-optimized:** data stays sorted and in one canonical place. A reader always finds the current value in exactly one location with no merging. No obsolete versions to skip.
- **Why writes are expensive:**
  1. **Write amplification** — changing a few bytes forces rewriting a whole page (8–16 KB).
  2. **Random writes** — the page to rewrite can be anywhere on disk; consecutive logical updates hit scattered physical pages.
  3. **Full-page WAL cost** — to survive a torn write, the WAL often logs the *entire* page image on first modification after a checkpoint (Postgres `full_page_writes`), doubling write volume.

**Tradeoff: Read simplicity vs Write amplification.** In-place updates give you a single, always-current, always-sorted copy (great reads) at the cost of turning small logical writes into large, scattered physical writes (expensive writes). LSM-trees make the opposite bet.

---

### A8. Page splits and fill factor

A **page split** happens when you insert into a leaf page that is already full. The engine allocates a new page, moves ~half the entries into it, updates the parent's pointers (which may cascade a split upward), and links the new leaf in.

```
Insert into full page P:
  P: [10,20,30,40] (full)   insert 25
  → split: P=[10,20]  Pnew=[25,30,40]
  → parent gains a pointer to Pnew (may itself split → cascade)
```

**Fill factor** = the percentage of each page the engine fills when building/rebuilding the index, deliberately leaving free space for future inserts. Postgres uses a default fill factor around 90% for B-tree indexes (100% is the default for heap tables, which do not split the same way).

```
Fill factor 100% (index, insert-heavy):
  every page is packed → the very next insert into any page forces a split
  → constant splitting → page fragmentation, extra WAL, random writes
  → index bloat and degraded write throughput

Lower fill factor (e.g., 70-90%):
  leaves headroom → inserts land in existing free space → fewer splits
  → but wastes some space and slightly hurts scan density
```

**Tradeoff: Space efficiency vs Split frequency.** A high fill factor packs data tightly (good for read-mostly / bulk-loaded indexes) but causes frequent, expensive splits under inserts. A lower fill factor trades some space for fewer splits under write load. **Failure mode:** 100% fill factor on a monotonically-increasing key (e.g., an auto-increment or timestamp PK) still concentrates all inserts at the right edge — the classic B-tree "right-hand hotspot."

---

### A9. Torn pages and how the WAL prevents data loss

**The failure mode:** a page is 8–16 KB but the disk writes in smaller sectors (e.g., 512 B or 4 KB) atomically. If power is lost mid-write, you get a **torn page** — part old, part new, corrupt and unreadable.

```
Writing 16 KB page P (4 sectors), power lost after 2 sectors:
  P on disk = [new][new][old][old]  ← corrupt, checksum fails, row unreadable
```

**How the WAL (write-ahead log) prevents loss:** the golden rule is **log before you write the data page**. The change is first appended to a sequential log and `fsync`ed; only later is the actual page written in place. On recovery, the engine replays the log to reconstruct any page whose write was interrupted.

```
Write protocol (WAL / redo):
  1. Append change record to WAL (sequential), fsync it → NOW durable
  2. Acknowledge the client
  3. Later (checkpoint/background): write the modified page in place

Recovery:
  1. Find last checkpoint
  2. Redo all WAL records after it → reconstruct correct page contents
```

Two specific torn-page defenses:
- **Postgres `full_page_writes`:** the first modification of a page after a checkpoint logs the *entire page image* to the WAL, so recovery can restore a torn page wholesale.
- **InnoDB doublewrite buffer:** pages are first written to a sequential doublewrite area, then to their final location. If the final write tears, InnoDB recovers the clean copy from the doublewrite buffer.

**Tradeoff: Durability vs Write volume.** Full-page logging and doublewrite buffering guarantee torn-page safety but roughly double the bytes written for the first change to each page after a checkpoint. This is a real, named component of a B-tree's write amplification.

---

## Level 3 — LSM-Tree Write Path

### A10. The LSM write path, end to end

LSM = Log-Structured Merge-Tree (O'Neil et al., 1996). The write path is designed so that **every write is a sequential append plus an in-memory insert** — no random disk writes on the hot path.

```
Client PUT(key, value)
  │
  1. Append (key, value) to the WAL / commit log on disk  ── sequential write, fsync
  │
  2. Insert (key, value) into the MemTable (sorted, in-memory)
  │
  3. Acknowledge the client   ← write is durable (in WAL) AND queryable (in MemTable)
  │
  ... time passes, MemTable fills to a threshold ...
  │
  4. MemTable becomes immutable; a new MemTable takes new writes
  5. Flush the immutable MemTable to disk as a sorted SSTable (sequential write)
  6. Once the SSTable is durable, its WAL segment can be discarded
```

Used by RocksDB, LevelDB, Apache Cassandra, HBase, Google Bigtable, and ScyllaDB. The two disk writes on the path — the WAL append and (later) the SSTable flush — are **both sequential**, which is the whole point.

---

### A11. Why the MemTable is a *sorted* structure

The MemTable must support fast inserts *and* produce data in **sorted order** when flushed, because SSTables are sorted files (needed for efficient range scans and merge-based compaction).

```
Requirements:
  - O(log n) insert (high write rate)
  - O(log n) point lookup (reads check the MemTable first)
  - Ordered iteration (flush must emit sorted keys; enables range scans)

A hash map gives O(1) insert/lookup but NO ordered iteration →
  you could not produce a sorted SSTable or serve range scans. Ruled out.
```

The common choice is a **skip list** (used by LevelDB and RocksDB by default) or a balanced tree. A skip list gives O(log n) insert/lookup, ordered iteration, and — importantly — supports lock-free / high-concurrency implementations, which matters under heavy concurrent writes.

| Structure | Insert | Point lookup | Ordered scan | Used by |
|---|---|---|---|---|
| Hash map | O(1) | O(1) | ✗ no order | (not usable as MemTable) |
| Skip list | O(log n) | O(log n) | ✓ | RocksDB, LevelDB default |
| Balanced tree (RB/AVL) | O(log n) | O(log n) | ✓ | some engines |

---

### A12. SSTables and why immutability helps

An **SSTable (Sorted String Table)** is an on-disk file containing key-value pairs **sorted by key**, written once and **never modified in place**. The term comes from Google's Bigtable. An SSTable typically bundles: the sorted data blocks, a sparse block index, and a Bloom filter.

Immutability buys a lot:

```
✓ Crash safety:   a file is either fully written or not; no torn in-place updates.
✓ Concurrency:    readers need no locks — an immutable file can't change under them.
✓ Caching:        blocks/whole files cache cleanly; cache never goes stale.
✓ Simple backups: copying an SSTable is safe; it won't mutate mid-copy.
✓ Sequential writes: flushing is one big sequential write, no random page updates.
```

The cost of immutability: you cannot update or delete in place. Updates become new versions in newer SSTables, and deletes become **tombstones** (A22). Reclaiming space and reconciling versions is deferred to **compaction** (Level 5). This is the LSM's core bargain: cheap, sequential, immutable writes now; merge work later.

---

### A13. Why "append-only" writes are fast

The LSM turns writes into **sequential appends**: the WAL is an append, the MemTable is an in-memory insert, and the eventual SSTable flush is one large sequential write. No random page reads-modify-writes on the hot path.

```
B-tree write:   find the right page (maybe read it), modify in place,
                write it back to a possibly-random disk location (+ full-page WAL).
                → random-ish I/O.

LSM write:      append to WAL (sequential) + in-memory insert. That's it.
                The disk head / SSD FTL sees a clean sequential stream.
                → sequential I/O, which is far cheaper (see A2).
```

The named I/O pattern is **sequential write** (append). This is why LSM engines sustain very high ingest rates: they never pay the random-write penalty at write time. They defer the cost to background compaction, trading write-path latency for background CPU/disk work.

**Tradeoff: Write-path speed vs Background work + read cost.** The write is cheap because the sorting/merging bill is deferred to compaction and the "find the current version" bill is deferred to read time.

---

### A14. Crash before flush — are the writes lost?

**No — the writes survive, because they were in the WAL before being acknowledged.** This is exactly what the WAL exists for.

```
State at crash:
  - 10,000 writes acknowledged
  - All 10,000 are in the WAL on disk (fsynced before ack)
  - All 10,000 are in the MemTable (in RAM) — LOST when the process dies
  - MemTable was NOT yet flushed to an SSTable

On restart (recovery):
  1. Engine finds WAL segments not yet covered by a flushed SSTable
  2. Replays each WAL record, re-inserting into a fresh MemTable
  3. MemTable is rebuilt to its pre-crash state → all 10,000 writes present
  4. Normal operation resumes; the rebuilt MemTable flushes later as usual
```

**The critical caveat:** this only holds if the WAL entry was `fsync`ed *before* the client was acknowledged. If the engine is configured for asynchronous/batched commit (ack before fsync — RocksDB `WAL` with `sync=false`, or MySQL `innodb_flush_log_at_trx_commit=2`), a crash can lose the most recent, un-`fsync`ed writes. That is the durability-vs-latency knob (A28). **Correctly configured, acknowledged LSM writes survive a crash because the WAL is the source of truth, not the MemTable.**

---

## Level 4 — LSM Read Path & Bloom Filters

### A15. LSM read path: existing key vs non-existent key

An LSM read must find the **newest** version of a key, which could be in the MemTable or any SSTable, so it searches **newest to oldest** and stops at the first hit.

```
GET(key):
  1. Check the active MemTable (newest data).           hit? return.
  2. Check immutable MemTables not yet flushed.         hit? return.
  3. Check SSTables, NEWEST first:
        for each SSTable (newest → oldest):
          a. Ask the Bloom filter: "might this key be here?"
                NO  → skip this SSTable entirely (no disk I/O)   ← the big win
                MAYBE → continue
          b. Consult the sparse block index → find the one block
          c. Read that block (from block cache or disk)
          d. Search the block. Found? return (it's the newest version).
  4. Reached the oldest SSTable with no hit → key does not exist.
```

```
(a) Existing key in a recent MemTable/SSTable:
    → found early, stop. Cheap (often no disk I/O).

(b) Non-existent key:
    → must consider EVERY level. Bloom filters let it skip almost all SSTables
      cheaply. Without Bloom filters it would read a block from every SSTable
      only to find nothing — the worst case (A19).
```

The "stop at first hit, newest first" rule is why deletes need tombstones (A22): the delete marker must be found *before* the older live value, or the read would resurrect deleted data.

---

### A16. Why LSM reads are more expensive than B-tree reads

A B-tree keeps a single, current, sorted copy: a read is a bounded descent to *one* leaf (~3–4 page reads, mostly cached). An LSM spreads a key's history across the MemTable and many SSTables at different levels, so a read may have to **check multiple places** and merge/pick the newest.

| | B-tree read | LSM read |
|---|---|---|
| Copies of a key | One canonical, in-place | Possibly many (MemTable + several SSTables) |
| Work per read | Descend to 1 leaf | Check MemTable + probe N SSTables |
| Helper needed | None | Bloom filters + block index to avoid reading every SSTable |
| Worst case | Bounded by height | Bounded by number of SSTables/levels |

Bloom filters and the block index claw most of this cost back — a well-tuned LSM makes point reads of *existing recent* keys nearly as cheap as a B-tree. But structurally the LSM does more work per read because it deferred the "keep one sorted copy" work that the B-tree did at write time. **This is the read/write axis of the RUM tradeoff made concrete (A24, A25).**

---

### A17. Bloom filters: how they cut read cost, and why no false negatives

A **Bloom filter** (Burton Howard Bloom, 1970) is a compact, probabilistic set-membership structure. Per SSTable, it answers "is this key *possibly* in this file?" using a small bit array — so a read can skip SSTables that definitely don't contain the key **without touching disk**.

```
Bit array of m bits, k independent hash functions.

ADD(key):        for each of the k hashes:  set bit[ hash_i(key) % m ] = 1
MIGHT_CONTAIN(key):
                 for each of the k hashes:
                     if bit[ hash_i(key) % m ] == 0:  return DEFINITELY_NOT
                 return MAYBE   (all k bits were set)
```

**Why never a false negative:** when a key was added, all `k` of its bits were set to 1 and bits are **never cleared**. So if the key is truly present, all `k` bits are guaranteed still 1, and the test can never say "not present." A false negative is structurally impossible.

**Why false positives happen:** a key that was *never* added can still have all `k` of its bits set to 1 — because *other* keys collectively set those same bits. The filter then says "MAYBE" for a key that isn't there. That's a false positive: it costs one wasted SSTable probe, not a correctness error (the actual block read finds nothing and moves on).

```
Result for a GET of a non-existent key:
  Bloom filter says DEFINITELY_NOT for (almost) every SSTable → skip, no disk I/O.
  → transforms the "check every SSTable" worst case into ~zero real reads.
```

**Tradeoff: Memory vs False-positive rate.** More bits per element and a well-chosen `k` lower the false-positive rate but cost RAM (Bloom filters are held in memory). See QB1 for sizing.

---

### A18. Sparse block index and block cache

Once a Bloom filter says "MAYBE," the engine still has to find the key inside a potentially large SSTable. Two structures make that cheap.

**Sparse (block) index:** SSTables are stored as sorted **blocks** (e.g., a few KB each). Instead of indexing every key (dense, memory-heavy), the engine keeps **one index entry per block** — the first key of each block. To find a key: binary-search the sparse index to identify the *one* block whose range could contain the key, then read just that block.

```
Sparse index (one entry per block):
  [block0: firstKey="apple"] [block1: firstKey="mango"] [block2: firstKey="zebra"]

GET("orange"):
  binary search → "orange" falls in block1 (mango ≤ orange < zebra)
  → read ONLY block1, scan it. One block read, not the whole SSTable.
```

**Block cache:** recently/frequently read blocks are cached in RAM (RocksDB's block cache, Cassandra's key/row caches, plus the OS page cache). A cache hit means the block probe costs no disk I/O at all.

| Structure | Purpose | Cost saved |
|---|---|---|
| Bloom filter | Skip whole SSTables that lack the key | Avoids reading unneeded SSTables |
| Sparse block index | Find the one block in a chosen SSTable | Avoids scanning the whole SSTable |
| Block cache | Serve hot blocks from RAM | Avoids disk I/O on repeat reads |

**Tradeoff: Index granularity — Memory vs Read work.** A sparser index uses less RAM but forces reading/scanning a larger block; a denser index costs more RAM but pinpoints data faster. Block size is the tuning knob.

---

### A19. The real worst-case read amplification (misconception check)

The claim "LSM reads are O(1) because of Bloom filters" is **wrong**. Bloom filters are a *probabilistic optimization*, not a guarantee. The true worst case, especially for a **non-existent key with Bloom filters disabled or badly sized**, is that the read must probe **every level / every SSTable**.

```
Without Bloom filters, GET(non-existent key):
  MemTable miss → SSTable_1 read a block, miss
               → SSTable_2 read a block, miss
               → ...
               → SSTable_N read a block, miss → "not found"
  Read amplification ≈ number of SSTables that could hold the key.

With size-tiered compaction there can be MANY overlapping SSTables per level,
so the factor can be large. This is the classic LSM read-amplification problem.
```

Even *with* Bloom filters, the false-positive rate means an occasional extra probe, and **range scans get no benefit from Bloom filters at all** (a Bloom filter answers point membership, not "any key in [a,b]"), so a range scan must merge across all overlapping SSTables regardless.

**Correct statement:** Bloom filters make *point* reads of *non-existent* keys cheap on average (skip most SSTables), but the worst case is O(number of overlapping SSTables), and range scans always pay the merge cost. Compaction strategy (leveled vs size-tiered, A21) is what actually bounds read amplification.

---

## Level 5 — Compaction

### A20. What compaction is and why it's necessary

**Compaction** is the background process that reads several SSTables, merges them by key (keeping only the newest version of each key, dropping obsolete versions and expired tombstones), and writes out new, consolidated SSTables — then deletes the inputs.

It is necessary because the LSM write path *only ever appends*. Without compaction:

```
If compaction never runs:
  1. READS degrade:  the number of SSTables grows without bound → every read
     (and especially range scans) must merge across more and more files →
     read amplification climbs until reads are unusably slow.
  2. SPACE explodes: every update and delete leaves obsolete versions and
     tombstones on disk forever → disk fills with garbage (space amplification).
  3. DELETES never take effect on disk: tombstones are never reconciled with the
     data they shadow → deleted data is never physically reclaimed.
```

Compaction is what converts the LSM's cheap-write bargain into a sustainable system: it pays back the deferred sorting/merging debt. The catch is that it consumes CPU, disk I/O, and disk bandwidth *while the system is also serving traffic* — the source of write stalls (A23) and hot-compaction incidents (A33).

---

### A21. Size-tiered vs leveled compaction

Both merge SSTables; they differ in **how they group SSTables to compact**, which flips the amplification tradeoffs.

**Size-tiered compaction (STCS)** — used as Cassandra's historical default, and RocksDB's "universal" style is similar in spirit. When several SSTables of *similar size* accumulate, merge them into one larger SSTable. Sizes grow in tiers.

**Leveled compaction (LCS)** — used by LevelDB, RocksDB's default, and available in Cassandra. Data is organized into levels L0, L1, L2… where each level is ~10× larger than the one above, and **within each level (except L0) SSTables have non-overlapping key ranges**. A key lives in at most one SSTable per level.

```
Size-tiered:                          Leveled:
  many small SSTables merge into        L0: a few overlapping SSTables (just flushed)
  fewer big ones; multiple SSTables     L1: non-overlapping, ~10x L0
  in the same "tier" can overlap        L2: non-overlapping, ~10x L1
  in key range.                         ...   each key in ≤1 SSTable per level
```

| Axis | Size-tiered (STCS) | Leveled (LCS) |
|---|---|---|
| Write amplification | **Lower** (fewer rewrites) | **Higher** (data rewritten as it moves down levels) |
| Space amplification | **Higher** (up to ~2x+; big overlapping SSTables) | **Lower** (non-overlapping levels; less duplication) |
| Read amplification | **Higher** (may check many overlapping SSTables) | **Lower** (≤1 SSTable per level per key) |
| Best for | Write-heavy ingest | Read-heavy / space-sensitive |

**Tradeoff: Write amplification vs Read+Space amplification.** STCS writes less (good for ingest) but leaves more overlapping data around (worse reads and space). LCS keeps reads tight and space low but rewrites data more times as it cascades down levels (higher write amp, more background I/O). This is one axis of the RUM conjecture chosen by config. (A middle ground exists too — RocksDB's universal compaction, and hybrid strategies.)

---

### A22. Deletes, tombstones, and the problems they cause

Because SSTables are immutable, an LSM **cannot erase a key in place**. A delete is written as a **tombstone** — a marker record saying "this key is deleted as of timestamp T." The read path, scanning newest-first, sees the tombstone before any older live value and returns "not found."

```
DELETE(key):
  write a tombstone record for `key` into the MemTable → flushed like any write.

Read sees:  SSTable_new: key=<TOMBSTONE @ t2>   ← found first (newest)
            SSTable_old: key="value" @ t1        ← never reached → correctly "deleted"

The actual value is physically removed only when compaction merges the tombstone
with the older data AND enough time has passed to drop the tombstone safely.
```

Problems tombstones cause:

1. **Resurrected / "zombie" records.** In a replicated system, the tombstone must not be dropped until every replica has seen it. If a tombstone is garbage-collected too early and a replica that missed it later syncs, the *old value comes back to life*. Cassandra guards this with `gc_grace_seconds` (default 10 days) — tombstones are retained at least that long so anti-entropy repair can propagate them. **Failure mode:** dropping tombstones before all replicas converge resurrects deleted data.
2. **Read cost / tombstone build-up.** Tombstones are real records that reads must scan through. A range scan over a region full of tombstones (e.g., a queue table where rows are inserted then deleted) can read thousands of tombstones to return few live rows — a well-known Cassandra anti-pattern that triggers tombstone warnings and can fail queries.

**Tradeoff: Safe deletion vs Read/space overhead.** Retaining tombstones long enough to guarantee correctness across replicas is required, but it keeps dead data (and its read cost) around longer.

---

### A23. Write stalls (write stops)

A **write stall** is when the engine deliberately slows down or blocks client writes because **compaction (or flushing) has fallen behind** and letting writes continue at full speed would blow up read amplification or run the system out of space.

The chain of events:

```
1. Write rate is high → MemTables flush to L0 SSTables rapidly.
2. Compaction can't keep up → L0 (or the pending-compaction backlog) grows.
3. Too many L0 files = read amplification spikes (reads must check all of them).
4. To protect the system, the engine throttles or halts writes:
     RocksDB: slowdown trigger (level0_slowdown_writes_trigger)
              hard stop trigger (level0_stop_writes_trigger)
              also triggered by pending compaction bytes / too many immutable memtables
5. Client write latency spikes or writes block until compaction catches up.
```

```
Symptoms in production:
  - p99 write latency spikes periodically (sawtooth), correlated with compaction
  - "write stall" / "stopping writes" messages in engine logs
  - L0 file count or pending-compaction-bytes climbing before each spike
```

**Tradeoff: Sustained write throughput vs Read latency / space bounds.** The stall is the engine choosing to bound read amplification and disk usage at the cost of write availability. **Mitigations (A33):** more/faster compaction threads, faster storage, rate-limit ingest to sustainable levels, size L0 triggers appropriately, or pick a compaction strategy matched to the workload. The root cause is always **ingest rate exceeding compaction throughput** — you cannot write faster than you can compact indefinitely.

---

## Level 6 — Amplification & the RUM Conjecture

### A24. Read, write, and space amplification defined

These three ratios are the standard vocabulary for comparing storage engines.

| Term | Definition | Rough meaning |
|---|---|---|
| **Read amplification** | Bytes/operations read from storage ÷ bytes the query logically needs | How many extra reads per logical read |
| **Write amplification** | Bytes actually written to storage ÷ bytes the client logically wrote | How many extra writes per logical write |
| **Space amplification** | Bytes stored on disk ÷ bytes of live logical data | How much extra disk the layout costs |

```
LSM vs B-tree, qualitatively:

READ AMP:   B-tree LOW  (descend to one leaf)
            LSM   HIGHER (check MemTable + several SSTables; Bloom filters mitigate)

WRITE AMP:  B-tree HIGHER for small random updates (full-page rewrite + full-page WAL
                   + doublewrite); LSM defers but compaction rewrites data multiple times
            LSM   write-path amp LOW, but total write amp includes compaction
                   (leveled compaction can rewrite each byte ~10-30x over its life — illustrative)
            → Which "wins" depends on workload: LSM wins for many small writes;
              B-tree can win when updates are large/sequential.

SPACE AMP:  B-tree LOWER usually (one in-place copy; some fragmentation/free space)
            LSM   HIGHER transiently (obsolete versions + tombstones until compaction;
                  size-tiered can be ~2x, leveled lower)
```

The exact numbers depend on workload and config; the **ordinal relationships** above are the interview-safe claims. The point: **there is no free lunch — every engine is high on at least one of these axes.**

---

### A25. The RUM conjecture

The **RUM conjecture** (Athanassoulis, Kester, Maas, Stoica, Idreos, Callaghan — "Designing Access Methods: The RUM Conjecture," EDBT 2016) states that for any data structure, the three overheads — **R**ead, **U**pdate, and **M**emory (space) — are in tension: **optimizing for two of them forces you to give up on the third.** You cannot minimize all three simultaneously.

```
                 Read overhead
                     /\
                    /  \
                   /    \
                  / pick \
                 / two,   \
                /  pay the  \
               /   third     \
   Update ────────────────────── Memory (space)
   overhead
```

| Engine | Optimizes (low overhead) | Sacrifices (high overhead) |
|---|---|---|
| **B-tree** | **Read** + **Memory/space** (one compact in-place copy) | **Update** (write amplification: full-page writes, random I/O, WAL) |
| **LSM-tree** | **Update** (cheap sequential appends) + tunable | **Read** (many SSTables) and/or **Memory/space** (obsolete versions, filters, cache) |

The knobs (Bloom filters, block cache, compaction strategy) all move you *around* the triangle, not off it. Adding Bloom filters trades **memory** (RAM for the filters) to lower **read** overhead. Leveled compaction trades **update** overhead (more write amp) for lower **read** and **space** overhead. Every optimization is a trade along RUM. **This is the single most important framing to state out loud in a storage-engine interview.**

---

### A26. Why write amplification hurts SSDs specifically

SSDs have two properties HDDs don't: (1) flash can be written only in whole **pages** but **erased** only in larger **blocks**, and (2) each flash cell tolerates a **limited number of program/erase (P/E) cycles** before it wears out.

```
Consequence:
  - Every logical write can trigger the SSD's flash translation layer (FTL) to
    read-erase-rewrite a whole block (device-level write amplification).
  - Storage-engine write amplification MULTIPLIES with device-level write
    amplification. If the engine writes each byte ~10x (compaction) and the SSD
    amplifies ~2x internally, the flash sees ~20x the logical write volume. (illustrative)
  - More bytes written = P/E cycles consumed faster = the SSD wears out sooner.
```

**Long-term operational consequence:** a write-heavy LSM workload on SSDs can measurably shorten drive lifetime and raise the endurance (DWPD — drive writes per day) rating you must buy. This is a real capacity-planning line item, not a theoretical concern.

**Tradeoff: Ingest throughput vs Device endurance/cost.** Higher write amplification (aggressive leveled compaction, small MemTables that flush often) buys read/space benefits but burns SSD endurance faster. Mitigations: key-value separation (store large values outside the LSM to avoid recompacting them — RocksDB BlobDB / the WiscKey design), tuning compaction to reduce rewrites, or provisioning higher-endurance drives. **Failure mode:** silently exceeding the SSD's rated endurance and hitting elevated wear/failure rates across a fleet.

---

### A27. Choosing an engine by read/write ratio

**95% writes, 5% point reads, heavy ingest → LSM-tree.**

```
Why LSM:
  - Writes are sequential appends → sustains very high ingest.
  - The dominant cost (writes) is exactly what LSM optimizes.
  - The 5% point reads are cheap enough with Bloom filters + block cache.
  - Examples: metrics/time-series ingest, event logs, write-heavy KV.
  → Cassandra, RocksDB/MyRocks, HBase, ScyllaDB.
```

**Flip to 95% reads with occasional range scans → lean B-tree (or a read-tuned LSM).**

```
Why B-tree becomes attractive:
  - Reads dominate; B-tree gives one bounded, cached descent per point read.
  - Range scans are naturally efficient (sorted, linked leaves) — no multi-SSTable merge.
  - Low read amplification and no compaction-induced latency spikes.
  → Postgres, InnoDB.

If you keep an LSM for read-heavy work: switch to LEVELED compaction to cut read
amplification (≤1 SSTable per level) and lean hard on Bloom filters + a big block cache.
```

| Workload | Engine | Key reason |
|---|---|---|
| Write-heavy ingest, point reads | LSM (size-tiered) | Sequential writes, low write amp |
| Read-heavy, range scans | B-tree | One cached descent; native ordered scans |
| Read-heavy but must stay LSM | LSM (leveled) | Bounds read amplification |
| Mixed / OLTP with updates | B-tree | In-place updates, MVCC, predictable latency |

**Tradeoff: Write throughput vs Read latency (the core RUM axis).** Never answer "it depends" here without giving the rule: **write-dominant → LSM; read/scan-dominant → B-tree; if forced to keep an LSM under reads → leveled compaction + Bloom filters.**

---

## Level 7 — Durability & Recovery

### A28. WAL, fsync, and the durability/latency tradeoff

A **write-ahead log (WAL)** is an append-only, sequential on-disk log where a change is recorded **before** it is applied to the main data structures. It is the source of truth for durability and the basis of crash recovery.

**What `fsync` guarantees:** a normal `write()` only copies data into the OS page cache — a power loss can still lose it. `fsync(fd)` forces the OS to flush that file's buffered data to the storage device, so it survives power loss. (Subtlety: the drive may still buffer in a volatile write cache unless it honors flush/FUA; enterprise setups disable the volatile cache or use battery/capacitor-backed cache.)

```
"Written" (in page cache)   ≠  "Durable" (on stable media)
Only fsync (or O_DSYNC/FUA) crosses that line.
```

**The tradeoff:**

```
fsync on EVERY write (sync commit):
  + Strongest durability: every acked write survives power loss.
  - Slowest: each write waits for a device flush (limited by device fsync latency).

NEVER fsync (or ack-before-fsync):
  + Fastest: writes hit only RAM/page cache.
  - Risk: a crash loses the most recent un-fsynced writes (data loss window).

Config knobs (verify current defaults per version):
  RocksDB:   WriteOptions.sync = true|false
  Postgres:  synchronous_commit = on | off | remote_apply | ...
  MySQL:     innodb_flush_log_at_trx_commit = 1 (per-commit) | 2 | 0
```

**Tradeoff: Durability vs Latency/Throughput.** Per-write `fsync` maximizes durability at the cost of latency; deferring/batching `fsync` maximizes throughput at the cost of a bounded data-loss window on crash. **Group commit (A29) is how systems get most of the throughput back without giving up durability.**

---

### A29. Group commit

**Group commit** batches many transactions' log records into **one** `fsync`. Instead of each committing transaction paying its own device flush, the engine collects all commits that arrive within a tiny window (or while a flush is in flight) and flushes them together, then acknowledges them all.

```
Without group commit (10 concurrent commits):
  10 separate fsyncs → 10 × fsync_latency

With group commit:
  batch the 10 log records → 1 fsync → ack all 10
  → throughput scales with concurrency; each commit still waited for a real fsync
```

Why durability is **not** weakened: every transaction in the batch is acknowledged **only after** the shared `fsync` completes. Each commit still waited for a real flush to stable storage — it just shared the flush with others. You get near-`sync`-per-commit durability at far higher throughput.

**Tradeoff: Latency vs Throughput (a favorable one).** A single commit may wait a hair longer to join a batch, but aggregate throughput rises sharply under concurrency, and durability is preserved. This is why group commit is a standard feature in Postgres, InnoDB, and LSM WALs alike.

---

### A30. Crash recovery for B-tree vs LSM, and checkpoints

A **checkpoint** is a consistency point: the engine flushes enough state to disk that recovery need only replay the WAL **from the last checkpoint forward**, not from the beginning of time. Checkpoints bound recovery time and let the engine truncate/recycle old WAL.

**B-tree recovery (redo/undo — the ARIES-style model):**
```
1. Start from the last checkpoint (known-good point; dirty pages flushed by then).
2. REDO: replay all WAL records after the checkpoint so every committed change is
   reflected in the pages (repeats history, including uncommitted changes).
3. UNDO: roll back changes from transactions that were in-flight (not committed) at
   crash, using undo information → leaves only committed state.
   (Torn pages are repaired via full-page images / doublewrite — see A9.)
```

**LSM recovery (replay the WAL into a fresh MemTable):**
```
1. Flushed SSTables are already durable and immutable → nothing to recover there.
2. Find WAL segments whose data was NOT yet captured in a flushed SSTable.
3. Replay those WAL records into a new MemTable, rebuilding lost in-memory state (see A14).
4. Resume. The rebuilt MemTable flushes normally later.
   (A "checkpoint" here corresponds to a successful MemTable→SSTable flush, after which
    the covered WAL segment can be discarded.)
```

| | B-tree recovery | LSM recovery |
|---|---|---|
| What's already safe | Pages up to last checkpoint | All flushed SSTables (immutable) |
| Recovery action | Redo committed + undo uncommitted | Replay un-flushed WAL into a MemTable |
| Complexity | Higher (in-place pages, undo, torn-page repair) | Lower (immutable files + append-only log) |
| "Checkpoint" meaning | Flush dirty pages, mark WAL position | Successful MemTable flush to SSTable |

**Tradeoff: Recovery simplicity is a benefit of immutability.** The LSM's append-only, immutable design makes recovery conceptually simpler (replay a log, no in-place undo, no torn pages) — a real operational advantage of the LSM model.

---

### A31. Concurrent readers, snapshots, and MVCC

The mechanism is **MVCC — Multi-Version Concurrency Control**: instead of overwriting data in place and locking readers out, the engine keeps **multiple versions** of a row/key, each tagged with a version/timestamp. A reader takes a **snapshot** (a version cutoff) and sees only versions valid as of that snapshot — so **readers never block writers and writers never block readers**, and no reader sees a half-written state.

```
MVCC read:
  reader gets snapshot @ t=100
  → for each key, return the newest version with timestamp ≤ 100
  → concurrent writes creating versions at t=101 are invisible to this reader
```

**LSM + MVCC — immutability makes it natural:**
```
- SSTables are immutable and updates create new versions in newer files.
- Each key-value carries a sequence number / timestamp.
- A snapshot = "ignore versions with sequence number > my snapshot number."
- Readers just filter by sequence number; nothing is overwritten under them.
  (RocksDB snapshots and Cassandra's timestamped cells work this way.)
```

**B-tree + MVCC — two industrial designs:**
```
- Postgres: keeps ALL row versions in the heap (each tuple has xmin/xmax transaction
  IDs). A reader sees tuples visible to its snapshot. Dead (no-longer-visible) tuples
  accumulate → VACUUM reclaims them → risk of TABLE BLOAT if VACUUM lags (see QB4).

- InnoDB: keeps the CURRENT row in the clustered B-tree and stores OLD versions in the
  UNDO LOG (rollback segments). A reader reconstructs its snapshot by walking the undo
  chain backward → long-running readers can force undo to grow (see QB4).
```

**Tradeoff: Concurrency vs Cleanup cost.** MVCC gives lock-free snapshot reads (great concurrency) but creates obsolete versions that *must be reclaimed* — LSM via compaction, Postgres via VACUUM, InnoDB via purge of undo. If cleanup lags, you pay in space and read cost. Snapshot isolation is the common isolation level these enable.

---

## Level 8 — Architect-Level Tradeoffs

### A32. Engine choice + capacity math for a write-heavy time-series ingest

**Choice: LSM-tree** (e.g., Cassandra/ScyllaDB, or RocksDB-based). Time-series ingest is append-dominant, writes are the bottleneck, and reads are mostly recent-range — the LSM's sweet spot. Size-tiered compaction (or a time-window compaction strategy) suits append-mostly, TTL'd data.

```
Workload: 500,000 writes/sec, ~200 B/record, 90-day retention, recent-range reads.

--- Ingest bandwidth (logical) ---
  500,000/s × 200 B = 100 MB/s of logical writes.

--- Durable write bandwidth the disks must sustain ---
  WAL append:            ~100 MB/s (one sequential copy)
  SSTable flush:         ~100 MB/s (eventually flushed)
  Compaction rewrites:   each byte rewritten ~W times over its life
                         (W ≈ 10-30 for leveled; lower for size-tiered — illustrative)
  Total device write BW ≈ logical × (1 + 1 + W)
     If W ≈ 10 → ≈ 100 MB/s × 12 ≈ 1.2 GB/s of writes the storage must absorb.
  → provision disks + compaction threads for the AMPLIFIED rate, not the logical rate.

--- Storage footprint ---
  Daily logical: 100 MB/s × 86,400 s ≈ 8.64 TB/day
  90-day retention: 8.64 TB × 90 ≈ 778 TB logical
  × space amplification (say ~1.5x for compaction overhead/obsolete data) ≈ ~1.1 PB
  × replication factor (RF=3 for durability) ≈ ~3.3 PB raw
  ÷ target utilization (60%, headroom for compaction + failure) ≈ ~5.5 PB provisioned
  ÷ per-node usable capacity → node count.

--- SSD endurance (A26) ---
  1.2 GB/s sustained × 86,400 ≈ ~104 TB written/day to flash (before device-level amp).
  Check against drive DWPD rating × capacity to confirm endurance over the drive's life.
```

The headline architect move: **provision for amplified write bandwidth and replicated, space-amplified footprint — not the logical numbers.** Under-provisioning compaction throughput is what produces write stalls (A23, A33). TTL-based expiry + time-window compaction keeps old data cheap to drop.

---

### A33. Diagnosing and mitigating hot-compaction write stalls

**Diagnosis — correlate the spike with compaction state:**
```
1. Confirm the correlation: overlay write p99 latency with compaction activity.
   - RocksDB: LOG file "stalling writes"/"stopping writes"; compaction stats;
     level0 file count; pending_compaction_bytes; num-running-compactions.
   - Cassandra: nodetool compactionstats (pending tasks), tpstats, logs for
     "flushing" / compaction backlog; disk I/O and CPU saturation during spikes.
2. Identify the trigger: too many L0 files? pending-compaction-bytes over threshold?
   too many immutable memtables waiting to flush? disk bandwidth saturated?
3. Root cause is almost always: INGEST RATE > COMPACTION THROUGHPUT.
```

**Mitigations (levers, roughly in order):**
```
- Increase compaction parallelism/bandwidth: more compaction threads, raise the
  compaction rate limiter so compaction keeps up (careful: it competes with reads).
- Faster / more storage: compaction is disk-bound; better SSDs or more nodes add
  compaction headroom.
- Smooth the ingest: rate-limit or batch producers so the sustained write rate is
  below sustainable compaction throughput. You cannot exceed it indefinitely.
- Tune triggers/sizes: larger MemTables (flush less often → fewer, bigger L0 files),
  adjust level0_slowdown/stop triggers and target level sizes.
- Match the strategy to the data: append-only TTL data → time-window compaction;
  write-heavy → size-tiered to cut write amp; read-heavy → leveled but expect more
  compaction I/O.
- Reduce recompacted volume: key-value separation (BlobDB/WiscKey) so large values
  aren't rewritten every compaction.
```

**Tradeoff: Compaction aggressiveness vs Foreground latency.** Giving compaction more resources clears the backlog (fewer stalls) but steals CPU/disk from live reads/writes; throttling it protects foreground latency but risks backlog and eventual stalls. The stable fix is ensuring **sustainable ingest ≤ compaction throughput** and provisioning accordingly.

---

### A34. Tuning compaction: read-heavy vs write-heavy

```
Read-heavy / analytical / space-sensitive → LEVELED compaction:
  - Non-overlapping SSTables per level → a key is in ≤1 SSTable per level
    → LOW read amplification and LOW space amplification.
  - Accept HIGHER write amplification (data rewritten as it cascades down levels).
  - Pair with generous Bloom filters + large block cache.
  - Used by: LevelDB, RocksDB default, Cassandra LCS.

Write-heavy / ingest → SIZE-TIERED compaction:
  - Merge similarly-sized SSTables → FEWER rewrites → LOW write amplification.
  - Accept HIGHER read and space amplification (overlapping SSTables, obsolete data).
  - Used by: Cassandra STCS (historical default), RocksDB universal (similar spirit).

Append-only + TTL (time-series) → TIME-WINDOW compaction:
  - Group SSTables by time window; drop whole expired windows cheaply.
  - Cassandra TWCS is designed for exactly this.
```

| Workload | Strategy | Optimizes | Sacrifices |
|---|---|---|---|
| Read-heavy / analytics | Leveled (LCS) | Read amp, space amp | Write amp (more background I/O) |
| Write-heavy ingest | Size-tiered (STCS) | Write amp | Read amp, space amp |
| Time-series + TTL | Time-window (TWCS) | Cheap expiry, write amp | Not for in-place updates |

**Tradeoff: (the RUM triangle, chosen by config).** Leveled buys read+space at the cost of writes; size-tiered buys writes at the cost of read+space. Naming *which* strategy and *which* axis you're trading is the senior-level answer.

---

### A35. When to choose a B-tree even for write-heavy work

LSM is not automatically right for "high write throughput." Choose a **B-tree engine (Postgres/InnoDB)** even under significant write load when:

```
1. Writes are large or sequential, not tiny scattered updates.
   → B-tree write amplification is worst for small random updates. Large/append-like
     writes amortize page rewrites, shrinking the LSM's advantage.

2. The workload is read-AND-write heavy with range scans / rich queries.
   → LSM read amplification and range-scan merge cost hurt; B-tree serves both sides
     with predictable latency and native ordered scans.

3. You need strong transactional semantics, secondary indexes, joins, foreign keys.
   → Mature B-tree engines (Postgres/InnoDB) have battle-tested MVCC, transactions,
     and a rich query planner. LSM KV stores often push this to the app.

4. Predictable tail latency matters more than peak ingest.
   → LSM compaction causes periodic latency spikes / write stalls (A23). A B-tree has
     no compaction; its latency is steadier (at the cost of lower peak write throughput).

5. The dataset fits comfortably and space efficiency matters.
   → B-trees generally have lower, steadier space amplification (no transient bloat).
```

| Prefer LSM when | Prefer B-tree when |
|---|---|
| Tiny, high-rate, random writes | Large/sequential writes or mixed read/write |
| Point lookups dominate reads | Range scans / complex queries matter |
| Peak ingest is the goal | Predictable tail latency is the goal |
| KV semantics are enough | Transactions, secondary indexes, joins needed |

**Tradeoff: Peak write throughput vs Latency predictability + query richness.** The senior point: **"write-heavy" is not sufficient to pick LSM — the *shape* of the writes (small/random vs large/sequential), the read/scan mix, and the transactional/latency requirements decide it.** Facebook built MyRocks (RocksDB under MySQL) precisely because their write pattern and space efficiency favored LSM; a different write shape would favor InnoDB.

---

## Bonus — Senior Questions

### AB1. Bloom filter sizing

Two parameters govern a Bloom filter: **m** = bits in the array, **n** = elements inserted, **k** = number of hash functions. The standard approximation for the false-positive probability is:

```
p ≈ (1 - e^(-k·n/m))^k

Optimal number of hash functions for a given m/n:
  k_opt = (m/n) · ln 2

Rule-of-thumb sizing (widely cited, verify for your library):
  ~10 bits per element (m/n = 10) with k ≈ 7  →  p ≈ 1%   false positive
  each additional ~ few bits/element roughly cuts p by ~10x
```

| Bits/element (m/n) | ~Optimal k | ~False-positive rate |
|---|---|---|
| ~5 | ~3–4 | ~10% |
| ~10 | ~7 | ~1% |
| ~15 | ~10 | ~0.1% |
| ~20 | ~14 | ~0.01% |

**Why `k` has a sweet spot:**
```
k too LOW:  too few bits set per key → different keys collide on the few checked bits
            → MORE false positives.
k too HIGH: each insert sets many bits → the array saturates to all-1s quickly
            → almost everything tests "MAYBE" → MORE false positives (and slower).
There is an optimal k = (m/n)·ln2 that minimizes p for a given size.
```

**Tradeoff: Memory vs False-positive rate.** More bits/element → fewer false positives → fewer wasted SSTable probes → cheaper reads, but more RAM held for filters. LSM engines let you configure bits-per-key per column family / level (RocksDB `BloomFilter(bits_per_key)`). A false positive costs one wasted block read; a well-sized filter keeps that rare.

---

### AB2. Other probabilistic structures

Approximate structures trade a bounded, tunable error for **massive memory savings** — you accept "close enough" to fit the summary in RAM instead of storing/scanning the exact data.

| Structure | Estimates | Error property | Where it shows up |
|---|---|---|---|
| **Bloom filter** (Bloom, 1970) | Set membership | No false negatives; tunable false positives | LSM SSTable "might contain key?"; skip lookups |
| **HyperLogLog** (Flajolet et al., 2007) | Cardinality (count of distinct items) | Tunable relative error (few % typical) in tiny memory | `COUNT(DISTINCT)` estimation, Redis `PFCOUNT`, unique-visitor counts |
| **Count-Min Sketch** (Cormode & Muthukrishnan, 2005) | Frequency of items (heavy hitters) | Overestimates only (never under) | Top-K / heavy-hitter detection, rate/frequency tracking, streaming analytics |

```
Why approximate at all?
  Exact distinct-count of 1B events needs a set of 1B entries in RAM (huge).
  HyperLogLog estimates it within a few % using kilobytes.
  The database keeps the summary in memory instead of scanning/storing the raw set.
```

**Tradeoff: Accuracy vs Memory.** Each structure sacrifices exactness for a small, bounded, tunable error and a fixed tiny footprint. In storage engines the flagship example is the Bloom filter on SSTables; HLL and Count-Min are more common in query/analytics and streaming layers, but the same "approximate to fit in RAM" principle drives all three.

---

### AB3. Space amplification: disk is 2–3× logical size

**What's happening:** an LSM stores obsolete versions, tombstones, and overlapping SSTables until compaction reclaims them. A 2–3× footprint points to compaction not reclaiming space — the classic **space-amplification** symptom.

```
Likely causes:
  1. Size-tiered compaction: by design keeps large overlapping SSTables; can sit
     around ~2x while waiting for enough same-size tables to merge.
  2. Compaction is behind (ingest > compaction throughput) → obsolete data piling up.
  3. Tombstones/old versions retained (e.g., Cassandra gc_grace_seconds not elapsed,
     or overlapping SSTables prevent a tombstone from meeting the data it shadows).
  4. Long-lived snapshots / open iterators pinning old SSTables so they can't be deleted.
  5. TTL data not yet expired + not compacted away.
```

**Confirm:**
```
  - Compare live/logical bytes vs on-disk bytes (engine stats / du).
  - RocksDB: compaction stats, level sizes, pending_compaction_bytes,
             live-vs-total SST size, num-snapshots.
  - Cassandra: nodetool tablestats (space used live vs total), compactionstats,
               sstable count per table; check droppable tombstone ratio.
```

**Fix:**
```
  - Switch/tune to LEVELED compaction (much lower space amplification than size-tiered).
  - Give compaction more resources so it catches up; trigger a major compaction
    (cautiously — it rewrites everything, heavy I/O, and can create one huge SSTable).
  - Release long-lived snapshots/iterators pinning SSTables.
  - For time-series: use time-window compaction + TTL so whole old files drop cheaply.
  - Ensure tombstone GC settings match replication/repair cadence (don't resurrect data).
```

**Tradeoff: Space vs Write amplification.** Reclaiming space aggressively (leveled, frequent major compaction) costs write amplification and background I/O; deferring it saves writes but bloats disk. You are moving along the RUM triangle again.

---

### AB4. Postgres vs InnoDB MVCC

Both are B-tree engines, but they store old row versions in opposite places, creating opposite operational problems.

| | Postgres | MySQL / InnoDB |
|---|---|---|
| Where current row lives | Heap (unordered), indexes point to it | Clustered B-tree (rows stored in PK order) |
| Where OLD versions live | **In the heap** — every update writes a NEW tuple; old tuples stay until cleaned | **In the undo log** (rollback segments); current row updated in place |
| How a snapshot read works | Skip tuples not visible to the snapshot (xmin/xmax) | Reconstruct the old version by walking the undo chain backward |
| Cleanup mechanism | **VACUUM** (autovacuum) removes dead tuples | **Purge** thread removes undo no longer needed |
| Characteristic failure | **Table/index bloat** if VACUUM lags → disk grows, scans slow | **Undo log growth** from long-running transactions pinning old versions |

```
Postgres consequence:
  An UPDATE = insert a new tuple + mark the old dead. Under heavy update load with
  slow/blocked autovacuum, dead tuples accumulate → the table and its indexes BLOAT
  (physically larger than the live data) → sequential scans and index scans slow down.
  (A long-running transaction also holds back the VACUUM horizon, worsening bloat.)

InnoDB consequence:
  A single long-running read transaction forces InnoDB to keep every old row version
  its snapshot might need → the UNDO LOG / history list grows unbounded → disk pressure
  and slower version reconstruction until that transaction ends.
```

**Tradeoff: Where you pay for MVCC.** Postgres pushes old versions into the main table (fast updates, but bloat + a mandatory VACUUM process); InnoDB keeps the table compact but pays via undo-log growth and undo-walk cost for long readers. **Practical rule:** on Postgres, watch autovacuum and avoid long idle-in-transaction sessions; on InnoDB, avoid long-running transactions that pin undo. Both are the same root cause — MVCC's obsolete versions must be reclaimed, echoing the LSM's compaction problem (A31).

---

## Engine Decision Guide — Quick Reference

### Which storage engine?

| Situation | Best Choice | Reason |
|---|---|---|
| Write-heavy ingest, tiny random writes | LSM (size-tiered) | Sequential appends, low write amp |
| Read-heavy with range scans / rich queries | B-tree (Postgres/InnoDB) | One cached descent; native ordered scans |
| Read-heavy but must stay LSM | LSM (leveled) + Bloom filters | Bounds read amplification |
| Time-series, append-only, TTL | LSM (time-window compaction) | Cheap whole-window expiry |
| Large/sequential writes, mixed workload | B-tree | Write amp advantage shrinks; better queries |
| Transactions, secondary indexes, joins | B-tree | Mature transactional MVCC + planner |
| Predictable tail latency required | B-tree | No compaction spikes / write stalls |

### Which compaction strategy?

| Goal | Strategy | Optimizes | Sacrifices |
|---|---|---|---|
| Low read + space amplification | Leveled (LCS) | Read amp, space amp | Write amp |
| Low write amplification (ingest) | Size-tiered (STCS) | Write amp | Read amp, space amp |
| Cheap expiry of aged data | Time-window (TWCS) | Write amp, easy TTL drop | No in-place updates |

### Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---|---|
| Storage engine job | Turn PUT/GET/SCAN into cheap physical I/O + guarantee durability |
| Random vs sequential I/O | Sequential is far cheaper; LSM converts random writes → sequential |
| B-tree structure | Sorted pages, high fanout → height ~3–4; one bounded descent per read |
| In-place update | Rewrite whole page for a small change → read-optimized, write-amplifying |
| Page split / fill factor | Full page + insert → split; 100% fill under inserts → constant splitting |
| Torn page defense | WAL first; Postgres full_page_writes / InnoDB doublewrite buffer |
| LSM write path | WAL append + MemTable insert → ack; flush MemTable → immutable SSTable |
| MemTable | Sorted in-memory (skip list) → ordered flush + range scans |
| SSTable | Sorted, immutable file (data + sparse index + Bloom filter) |
| LSM read path | MemTable → SSTables newest-first; Bloom filter skips, block index locates |
| Bloom filter | No false negatives (bits never cleared); tunable false positives; ~10 bits/elem ≈ 1% |
| LSM read amp worst case | Non-existent key w/o Bloom filters → probe every overlapping SSTable |
| Compaction | Merge SSTables, drop obsolete/tombstones; without it reads + space explode |
| Size-tiered vs leveled | STCS: low write amp, high read/space; LCS: low read/space, high write amp |
| Tombstone | Delete marker; retained (gc_grace) or deleted data resurrects |
| Write stall | Compaction behind → too many L0 files → engine throttles/blocks writes |
| RUM conjecture | Read/Update/Memory: optimize two, pay in the third |
| Write amp on SSD | Multiplies device wear; shortens SSD life; a capacity line item |
| WAL + fsync | fsync makes writes durable; per-write = safe+slow, batched = fast+loss window |
| Group commit | Batch many commits into one fsync → throughput up, durability intact |
| Crash recovery | B-tree: redo+undo from checkpoint; LSM: replay WAL into fresh MemTable |
| MVCC | Versioned rows + snapshot; readers don't block writers; needs cleanup |
| Postgres vs InnoDB MVCC | Postgres old versions in heap → bloat/VACUUM; InnoDB in undo → undo growth |
| HyperLogLog / Count-Min | Approximate cardinality / frequency in tiny RAM (accuracy vs memory) |
| Engine choice rule | Write/point-heavy → LSM; read/scan/txn-heavy → B-tree |
| Space amplification fix | Leveled compaction, catch up compaction, release snapshots, TTL windows |
