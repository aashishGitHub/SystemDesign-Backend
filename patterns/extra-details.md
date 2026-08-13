# Patterns: Extra Details

> Companion appendix to the pattern docs in this folder. Mechanics that are worth knowing properly but would unbalance the main doc if inlined — the main doc names the concept in three lines and links here for the depth.

Each entry says which pattern doc it belongs to, so this file can grow across patterns without becoming a junk drawer.

---

## Table of Contents

1. [Index Internals: Covering, Primary, and Clustered](#1-index-internals-covering-primary-and-clustered) — from [`scaling-reads §2`](./scaling-reads.md#2-rung-1-optimize-inside-the-database)

---

## 1. Index Internals: Covering, Primary, and Clustered

> From [`scaling-reads §2 — Optimize Inside the Database`](./scaling-reads.md#2-rung-1-optimize-inside-the-database), which introduces covering indexes in three lines. This is the mechanism underneath them.

<div style="font-size:0.88em; font-style:italic; background:rgba(128,128,128,0.10); border-left:3px solid rgba(128,128,128,0.35); border-radius:4px; padding:0.7em 1.15em; opacity:0.85;">

<p style="margin-top:0;"><strong>In plain terms</strong></p>
<p>These three words look like three kinds of index. They are not. They answer three unrelated questions, and any combination of them can be true at once.</p>
<p>An index normally does not contain the row. It contains the indexed columns and a pointer to where the row lives. So if your query wants a column the index does not hold, the database has to follow that pointer and go fetch the row — once per matching row, each one a separate random read.</p>
<p><strong>Covering</strong> means the index happens to already contain every column this particular query asked for, so that second trip never happens. It is a property of an index <em>relative to one query</em>, not a type of index you create.</p>
<p><strong>Clustered</strong> means the table's rows are physically stored in that index's order — the index leaves are the table. A table can only be sorted one way, so there is at most one.</p>
<p><strong>Primary</strong> just means the index enforcing the primary key. In MySQL that index also happens to be the clustered one; in PostgreSQL it is an ordinary index with no special physical status.</p>
<p style="margin-bottom:0;"><strong>You've got it if you can say:</strong> why the same index can be covering for one query and not for another.</p>

</div>

### 1.1 Three words, three different questions

| Term | The question it answers | Axis |
|---|---|---|
| **Clustered** | How are the rows physically laid out on disk? | Storage layout |
| **Primary** | Which columns / which constraint is this index for? | Which columns |
| **Covering** | Does this index hold everything *one specific query* needs? | Index ↔ query relationship |

The one that catches people: **"covering" is not a kind of index you create.** The same index is covering for `SELECT title` and not covering for `SELECT title, body`. You cannot look at a `CREATE INDEX` statement alone and call it a covering index — only "covering *for this query*".

### 1.2 The mechanism: what covering actually removes

A secondary index does not hold the row. Its leaf entries hold `(indexed columns → pointer to the row)`. So an ordinary indexed read is **two** steps:

```
SELECT title FROM posts WHERE user_id = 42          -- index on (user_id)

  step 1   walk the index B-tree to user_id = 42        ← cheap, sequential-ish
           the leaf hands back 20 pointers
  step 2   follow each pointer to fetch the row,        ← 20 RANDOM reads
           because `title` is not in the index            this is the expensive part
```

Step 2 costs one random I/O **per matching row**. Every engine has a name for it:

| Engine | Name for step 2 | What the pointer actually is |
|---|---|---|
| PostgreSQL | heap fetch | `ctid` — physical (page, offset) |
| MySQL / InnoDB | second B-tree traversal | the **primary key value** |
| SQL Server | key lookup / RID lookup | clustering key, or a row ID on a heap |

A covering index deletes step 2 entirely:

```
-- index on (user_id) INCLUDE (title)

  step 1   walk the B-tree; the leaf already has `title`   ← done. no step 2.
```

**The win is not "the index is faster."** It is that N random reads collapse to zero, and N grows with your result set.

You can confirm it in the query plan:

| Engine | The tell |
|---|---|
| PostgreSQL | `Index Only Scan` instead of `Index Scan` |
| MySQL | `Using index` in the `Extra` column |
| SQL Server | no `Key Lookup` operator in the plan |

MySQL's `Extra` column is a classic trap — three similar-looking strings meaning different things:

- **`Using index`** → covering index. What you want.
- **`Using index condition`** → index condition pushdown. A different optimization.
- **`Using where`** → neither; rows are filtered after being read.

### 1.3 Key columns vs INCLUDE columns

These two lists are not interchangeable:

```sql
CREATE INDEX idx ON posts (user_id, created_at) INCLUDE (title);
--                        └── key columns ───┘         └ payload ┘
```

**Key columns** are sorted, stored at *every* level of the B-tree, and can be used to seek, range-scan, and satisfy `ORDER BY`. These are the columns the left-prefix rule governs.

**INCLUDE columns** are stored **only in the leaf level**, unsorted. They cannot be seeked on and cannot provide ordering. They exist for one reason: to make the index covering.

So why not just add `title` as a fourth key column? Keeping it out of the internal nodes keeps those nodes narrow, so the tree stays shallower and each traversal touches fewer pages. It also sidesteps index key-size limits, and on a unique index it does not change what "unique" means.

**Availability differs, which matters if you copy the syntax around.** SQL Server has had `INCLUDE` for a long time, and **PostgreSQL added it in version 11**. I do not believe MySQL/InnoDB supports `INCLUDE` at all — there you make an index covering by adding the column as an ordinary key column. *Verify against current MySQL docs before asserting that in an interview.*

### 1.4 Clustered indexes

A clustered index defines the **physical order of the rows**, and its leaf level *is* the table data. At most one per table, because rows can only be sorted one way.

The consequence worth internalizing: **a clustered index is trivially covering for every possible query on that table**, since its leaves contain all the columns. Which is exactly why "covering" is only an interesting idea for *secondary* indexes.

Engine behaviour diverges sharply here, and this is where most of the confusion comes from:

| Engine | Clustered? | Detail |
|---|---|---|
| **InnoDB (MySQL)** | Always | On the PK if declared, else the first `UNIQUE NOT NULL` index, else a hidden 6-byte row ID. "Primary index" and "clustered index" are the same object |
| **SQL Server** | Optional | PK gets one by default, but you may cluster on something else. No clustered index = a *heap* |
| **PostgreSQL** | **Never** | Tables are always heaps. `CLUSTER` is a **one-time rewrite** in index order — it does *not* maintain that order as rows arrive |
| **Oracle** | Optional | Index-Organized Tables (IOT) are the equivalent concept |

Two consequences that show up in real systems:

**InnoDB PK choice is unusually consequential.** Because the table *is* the PK B-tree, a random UUID primary key scatters inserts across the whole tree and causes page splits and fragmentation, where a monotonic key appends cleanly at the right edge.

**InnoDB secondary indexes store the PK as the row pointer**, not a physical address. So a non-covering secondary lookup is *two* B-tree traversals — secondary index → PK value → clustered index. It also means every secondary index is implicitly covering for any query wanting only the indexed columns plus the PK.

### 1.5 "Primary index" — the muddiest of the three

Worth saying out loud in an interview rather than pretending the term is precise. It gets used two ways:

1. **Textbook / database-theory sense** — the index on the key the file is physically *ordered* by, which makes it essentially a clustered index on the primary key.
2. **Everyday practitioner sense** — simply the index automatically created to enforce the `PRIMARY KEY` constraint.

Those two senses **coincide in InnoDB and diverge in PostgreSQL**, where the PK index is an ordinary unique B-tree sitting beside a heap with no special physical status at all. If someone uses the term without qualifying it, ask which they mean.

### 1.6 The axes are orthogonal — the proof

| Index | Primary? | Clustered? | Covering? |
|---|---|---|---|
| PostgreSQL PK index | ✅ | ❌ (PG has none) | depends on the query |
| InnoDB PK index | ✅ | ✅ | ✅ for everything — it holds all columns |
| SQL Server nonclustered + `INCLUDE` | ❌ | ❌ | ✅ for its target query |
| PostgreSQL index on `(user_id)` | ❌ | ❌ | ✅ only if the query wants nothing but `user_id` |

Every combination is reachable. That is what proves these are three independent properties rather than three competing options.

### 1.7 Three gotchas beyond the definition

**`SELECT *` destroys covering.** Adding one column to the select list silently converts an index-only scan into an index scan plus N heap fetches. This is the strongest concrete argument against `SELECT *` on a hot path.

**PostgreSQL index-only scans can still touch the heap.** PG indexes do not store MVCC visibility information, so the engine checks the *visibility map* first; if a page is not marked all-visible, it must fetch the row anyway just to decide whether it is visible to your transaction. After a bulk load or heavy update — before autovacuum catches up — an "index only" scan can do very real heap fetches. `EXPLAIN (ANALYZE)` reports `Heap Fetches: N`, and a non-zero value there is the tell.

**The cost is the usual read/write trade.** A covering index is wider than a minimal one, so it consumes more disk, more buffer pool, and more write amplification per insert. It is [`scaling-reads §2`](./scaling-reads.md#2-rung-1-optimize-inside-the-database)'s "every index is a write amplifier" in a sharper form: you are buying the elimination of random reads with storage and write throughput.

### 1.8 Interview questions

**Q1. What is a covering index?**
An index that contains every column a given query needs — select list, `WHERE`, `ORDER BY`, `GROUP BY`, join keys — so the engine answers from the index and never fetches the row. The important nuance is that "covering" describes a relationship between an index and *one specific query*, not a type of index: the same index covers `SELECT title` and fails to cover `SELECT title, body`. The win is that the per-row random read to fetch the heap tuple disappears, which is the expensive half of an indexed read.

**Q2. How is a covering index different from a clustered index?**
They are different kinds of property. Clustered is about physical storage — the rows are stored in that index's order, and the index leaves are the table, so there is at most one per table. Covering is about sufficiency for a query. They interact in one neat way: a clustered index is covering for *every* query by definition, because its leaves hold all the columns. So covering is only a meaningful notion for secondary indexes. And they are independent — PostgreSQL has no clustered indexes at all yet has covering ones.

**Q3. In InnoDB, what does a secondary index lookup actually cost?**
Two B-tree traversals, not one. InnoDB secondary indexes store the primary key value as the row pointer rather than a physical address, so the engine walks the secondary index to get a PK, then walks the clustered index with that PK to reach the row. That is also why InnoDB primary keys should be small — every secondary index carries a copy of the PK in every leaf entry — and why a covering secondary index is such a large win there specifically: it removes the second traversal entirely.

**Q4 (depth). Your Postgres plan says `Index Only Scan` but the query is still slow. What do you check?**
`Heap Fetches` in `EXPLAIN (ANALYZE)`. Postgres indexes do not carry MVCC visibility information, so an index-only scan consults the visibility map, and any page not marked all-visible forces a heap fetch anyway to determine tuple visibility. After a bulk load or a heavy update the visibility map is stale, so a nominally index-only scan does real random I/O. The fix is getting autovacuum to mark those pages — the plan node name alone does not tell you the heap was avoided.

### 1.9 Quick recall

| Term | One-line answer |
|---|---|
| **Covering index** | Holds every column *this query* needs → no row fetch. A property of index+query, not an index type |
| **Two-step lookup** | Index gives a pointer; following it to get other columns is one random read *per row* |
| **Plan tell** | PG `Index Only Scan` · MySQL `Using index` · SQL Server no `Key Lookup` |
| **`Using index` vs `Using index condition`** | Covering vs index condition pushdown. Different things |
| **Key vs INCLUDE columns** | Key = sorted, seekable, orderable, all tree levels. INCLUDE = leaf-only payload |
| **`INCLUDE` support** | SQL Server; PostgreSQL 11+. Not MySQL — add it as a key column there *(verify)* |
| **Clustered index** | Rows physically stored in index order; leaves *are* the table; max one per table |
| **Clustered ⇒ covering** | Always — it holds every column. So covering only matters for secondary indexes |
| **InnoDB** | Always clustered; PK index = clustered index; secondary indexes store the **PK** as pointer |
| **InnoDB secondary read** | Two B-tree traversals: secondary → PK → clustered |
| **PostgreSQL** | No clustered indexes. `CLUSTER` is a one-time rewrite, not maintained |
| **Primary index** | Ambiguous: "ordered-by key" (theory) vs "the PK constraint's index" (practice). Ask which |
| **Orthogonal** | Primary / clustered / covering are independent — all combinations exist |
| **`SELECT *`** | Kills covering; one extra column reverts you to N heap fetches |
| **PG `Heap Fetches`** | Index-only scans still hit the heap when the visibility map is stale |

---

## Related

- **Pattern:** [Scaling Reads](./scaling-reads.md) — §2 is where indexing sits in the escalation ladder
- **Topics:** [`storage-engines §2 — The B-Tree`](../interviews/storage-engines/deep-dive.md#2-the-b-tree-read-optimized-in-place-storage) · [`§4 The LSM Read Path`](../interviews/storage-engines/deep-dive.md#4-the-lsm-read-path) · [`sharding-replication`](../interviews/sharding-replication/README.md)
- **Fundamentals:** [bloom-filters](../fundamentals/bloom-filters.md)
