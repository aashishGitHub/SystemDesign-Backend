# Answers: Collaborative Editing (Google Sheets / Docs)

> Keyed to [questions.md](./questions.md). Read the question first, then compare.
> Every answer has a code block or comparison table so you can defend the tradeoff out loud.
> Depth that lives elsewhere is cross-linked, not duplicated: [consensus](../consensus/) (total order, leader/single-writer, leases), [communication-protocols](../communication-protocols/) + [chat-system](../chat-system/) + [sse](../sse/) (WebSocket vs SSE, delivery guarantees), [storage-engines](../storage-engines/) (WAL + snapshot + compaction), [file-storage](../file-storage/) (snapshot+delta, versioning), [distributed-caching](../distributed-caching/) (hot doc state).
>
> **Accuracy note:** OT/CRDT theory below is standard and checkable; specific *internal* claims about how Google or Figma implement collaboration are hedged and marked "verify" — treat them as informed illustrations, not authoritative fact.

---

## Level 1 — Fundamentals & Requirements

### A1. Why a collaborative spreadsheet is harder than collaborative text

| Dimension | Collaborative text (Docs) | Collaborative spreadsheet (Sheets) | Why it's harder |
|---|---|---|---|
| Address space | 1-D sequence of characters | **2-D grid** (`row × col`) + named ranges | An op must survive shifts in *two* axes, not one |
| Derived state | None — what you type is what's stored | **A calc engine** — formulas produce values from other cells | A whole second plane (dependency DAG + recompute) that text has no analog for |
| Structural edits | Insert/delete characters | **Insert/delete rows & columns** shift *every* address and *every* formula reference below | One structural op rewrites the meaning of thousands of other cells/formulas at once |
| Correctness bar | Converge to same character sequence | Converge to same cells **and** same *computed* results, deterministically | A merge that yields a wrong *number* is a silent data-integrity bug, not just a typo |

**Key takeaway:** Text editing is "agree on one string"; a spreadsheet is "agree on the inputs (sync plane) *and* agree on the outputs a formula DAG derives from them (calc plane)" — and row/column inserts perturb both planes simultaneously.

---

### A2. The two planes

| Plane | Workload | Consistency | Latency need | Bottleneck resource |
|---|---|---|---|---|
| **Sync** (concurrent edits → converge) | Small ordered ops, bursty | **Strong eventual / convergence** — everyone ends identical | Local echo instant; remote ops in ~100ms | Network round-trips + correctness of transform |
| **Calc** (formula DAG → recompute) | CPU-bound graph walk on each input change | **Deterministic** — same inputs ⇒ same outputs on every client | Recompute in one frame for small edits | CPU + memory (graph + values) |

They meet at the seam: a sync-plane edit (`set A1 = 5`) dirties the calc plane; the calc plane's recomputed cells are themselves ordered changes that flow *back* through the sync plane to other clients.

**Key takeaway:** Two planes, two different guarantees — sync is about *conflict resolution*, calc is about *dependency propagation*; keep them conceptually separate even inside one server.

---

### A3. Requirements

```text
Functional
  - Multiple users edit one document concurrently, see each other's changes live (~real-time)
  - Cells hold values or formulas; formulas recompute automatically and correctly
  - Presence: live cursors, selections, who's here
  - Revision history: view + restore any past state
  - Per-user undo/redo; sharing & permissions (view/comment/edit); offline edit + later merge
  - Import/export .xlsx/.csv

Non-functional (the hard guarantees)
  - CONVERGENCE: all replicas that have seen the same set of ops show identical state
  - INTENTION PRESERVATION: the merged result reflects what each user meant (not just a valid state)
  - DURABILITY: no ACKed edit is ever lost (survive server crash)
  - DETERMINISTIC RECOMPUTE: same cell inputs ⇒ same computed values everywhere
  - LATENCY: local edit feels instant (optimistic); remote edit visible in ~100–200ms
  - AVAILABILITY: a user can keep editing offline and reconcile on reconnect

Scale assumptions (order-of-magnitude — verify)
  - ~10^8 documents; most idle, a small fraction live at once
  - A live doc: typically 1–10 editors, busy ones up to ~50 (soft cap)
  - Sheet size up to ~10^7 cells (Google's documented per-sheet cell cap — verify current)
```

**Key takeaway:** The non-functional list *is* the design — convergence + determinism + no-lost-ACKed-edit are the three things every later decision defends.

---

### A4. Back-of-the-envelope — and what dominates

```text
Per document (the surprise: it's TINY):
  A fast human types ~5 chars/s, but ops are coalesced → ~1–5 ops/s per active editor
  A busy doc with 10 active editors → ~50 ops/s   ← trivial network/CPU per doc

So the challenge is NOT per-doc throughput. It is:
  (1) FAN-OUT OF STATE: millions of documents open simultaneously, each a small
      stateful in-memory session (op log tail + cell state) that must live SOMEWHERE.
        1M live docs × ~1–10 MB live state = 1–10 TB RAM across the doc-server fleet
  (2) RECOMPUTE CPU: one edit to an input feeding a 500k-cell subtree = 500k cell
      evaluations. CPU-bound, and it must finish fast enough to feel live.
  (3) CORRECTNESS: convergence + determinism — a bug here silently corrupts data.
```

**Key takeaway:** Unlike chat or feeds (a *throughput* problem), collaborative editing per-document is low-throughput — the scaling problem is holding **millions of small stateful sessions** + **recompute CPU** + **convergence correctness**, not QPS.

---

### A5. Core entities & minimal protocol

```text
Entities
  Document   { id, owner_id, type(sheet/doc), current_revision, snapshot_ref }
  Sheet      { doc_id, index, name, dims }                 // a doc has ≥1 sheet (tab)
  Cell       { addr(row,col), kind(value|formula), raw, computed?, format }
  Operation  { doc_id, base_rev, client_id, seq, payload } // setCell, insertRow, ...
  Revision   { doc_id, rev, op, ts, author }               // the op log
  Presence   { doc_id, user_id, cursor, selection, color } // ephemeral
  ACL        { doc_id, principal, role(viewer|commenter|editor) }

Protocol (over one WebSocket)
  → OPEN(doc_id)                       server: check ACL, return snapshot + head_rev
  → SUBSCRIBE                          server streams ops with rev > head_rev
  → SUBMIT(op, base_rev)               server: transform, assign rev, ACK, broadcast
  ← ACK(client_seq → assigned_rev)
  ← OP(rev, transformed_op)            other clients' ops, in order
  ↔ PRESENCE(cursor/selection)         separate lossy channel
```

**Key takeaway:** The whole system is a loop — client submits an op based on a revision, the server transforms + orders + ACKs it, and streams everyone the ordered ops; snapshot on open bounds how much you replay.

---

## Level 2 — The Document Model

### A6. Grid data model — sparse, not dense

```text
A 26-col × 100k-row sheet = 2.6M cells, but a real sheet fills maybe 1%.
Dense 2-D array → wastes memory on empty cells and makes row-insert O(cells).

Use a SPARSE map keyed by address:
  cells: Map<(row,col) -> Cell>
  Cell  = { kind: VALUE | FORMULA,
            raw:  "42" | "=SUM(A1:A10)",
            computed: 42,            // filled by the calc engine for formulas
            format: {...} }

Addressing: store STABLE cell identities, not just (row,col) integers, so a
row-insert doesn't have to rewrite a million keys (see A13).
```

| Choice | Reason |
|---|---|
| Sparse map | Sheets are mostly empty; store only populated cells |
| `raw` vs `computed` split | A formula keeps its source *and* its last value; recompute overwrites `computed` only |
| Stable row/col identity | Structural ops (insert/delete) move cells without rewriting every address |
| Money/precision as typed values | Keep numeric type + precision explicit; never guess from display |

**Key takeaway:** Model the grid as a **sparse map of cells with stable identities**, splitting a formula's `raw` source from its `computed` value — dense arrays make both memory and row-insert blow up.

---

### A7. Persistence — snapshot + operation log

```text
Two artifacts per document (same idea as a DB's checkpoint + WAL):
  SNAPSHOT   full document state at revision R      (periodic)
  OP LOG     every op with rev > R, append-only      (durable, ordered)

Load(doc)  = latest snapshot + replay ops after it
Recover    = same — a crash loses nothing that was appended + fsync'd

Compaction: every N ops (or T minutes) write a fresh snapshot, then the op log
before it can be truncated/archived (keep enough for version history — Level 7).
```

This is the [storage-engines](../storage-engines/) WAL+checkpoint pattern and the [file-storage](../file-storage/) snapshot+delta pattern applied to a document.

**Key takeaway:** Persist an **append-only op log** for durability (fast, ordered) plus **periodic snapshots** to bound replay time — the document is "snapshot + ops since," exactly like a WAL-backed database.

---

### A8. Formula representation

```text
Parse the formula string into an AST once, on edit — not on every recompute:

  "=SUM(A1:A10) * B$2"
        │
        ▼  parse
   Mul(
     Func("SUM", [ Range(A1, A10) ]),
     Ref(col=B, row=2, row_absolute=true)     // B$2: row locked, col relative
   )

Per formula cell, also extract PRECEDENTS (cells it reads):
  A1..A10, B2   → feed the dependency graph (A16)

References:
  A1     relative   — shifts when the formula is copied/moved
  $A$1   absolute   — never shifts
  A$1 / $A1  mixed
  A1:A10 range      — expands to a set (or stays a range node for whole-column perf)
```

**Key takeaway:** Compile each formula to an **AST once on edit** and extract its precedents; the AST is what you evaluate and the precedents are what wire it into the dependency DAG — relative vs absolute references are exactly the bits that decide what shifts on structural edits.

---

### A9. Loading/rendering only what's needed

```text
Open:  fetch snapshot metadata + the VIEWPORT region (e.g. rows 1–60, cols A–L)
       + document dims + formats for that region.
Scroll: fetch the newly-visible region on demand (windowed / lazy).
Never:  ship 10M cells to the client up front.

Server keeps the whole doc in memory (it must recompute); the CLIENT only ever
holds a window + a margin. This is the grid analog of byte-range video fetch.
```

**Key takeaway:** The server is authoritative over the whole sheet, but the client lazily loads and renders only the **viewport (+ margin)** — you never ship or draw millions of cells.

---

## Level 3 — Concurrent Editing & Convergence

### A10. What "correct" means: convergence + intention preservation

| Property | Definition | Why LWW alone fails |
|---|---|---|
| **Convergence** | All replicas that applied the same op set are byte-identical | LWW converges but... |
| **Intention preservation** | The result reflects what each user *meant* | ...it silently *discards* the loser's edit — if A sets `A1=5` and B types `=SUM(B:B)` into `A1`, one intent vanishes with no merge |
| **Causality** | Ops apply respecting happened-before | Ignoring it reorders dependent edits and corrupts formulas |

For the *same cell*, some conflict is unavoidable — last-writer-wins on the **value** is acceptable (a cell holds one thing). The real work is *different* edits (different cells, structural shifts) that must all survive.

**Key takeaway:** "Correct" = **convergence + intention preservation** — every client ends identical *and* nobody's edit silently disappears; LWW gives you the first but throws away the second, which is why you need OT or CRDT.

---

### A11. Operational Transformation (OT)

```text
Idea: don't send state, send OPERATIONS, and TRANSFORM an incoming op against
any concurrent op it didn't account for, so applying them in different orders
still converges.

Classic example (text, positions):
  Base doc: "ac"
  User A:  insert('b', pos=1)   → "abc"
  User B:  insert('x', pos=2)   → "acx"      (concurrent, based on same "ac")

  Server orders A then B. B's op was based on "ac", but A already shifted things:
  transform(B_op against A_op): B's pos 2 → 3   → apply to "abc" → "abxc"  ✅
  Both clients converge to "abxc".

  transform(op1, op2) → op1'  is the whole ballgame; it must satisfy:
     apply(apply(s, op1), transform(op2, op1)) == apply(apply(s, op2), transform(op1, op2))
```

Why a central server: with a single sequencer, each client only transforms against a **linear** history (the server's revision order), which is far simpler and provably convergent — this is the Jupiter/Google-Docs model *(publicly described as OT-based; internals — verify)*. Peer-to-peer OT (transform against a partial order) is notoriously hard to get right.

**Key takeaway:** OT sends **operations** and **transforms** each against concurrent ones so any apply-order converges; anchoring it to a **single server-imposed total order** turns an intractable N-way problem into a tractable linear one — which is why Docs/Sheets are server-authoritative.

---

### A12. CRDTs — and OT vs CRDT

| | **OT** | **CRDT** |
|---|---|---|
| Convergence via | Transform ops against a total order | Commutative/idempotent merges + unique IDs; order-independent by construction |
| Needs central sequencer? | Practically yes (server-authoritative) | **No** — converges peer-to-peer / offline-first |
| Metadata cost | Low (ops are small) | Higher — stable unique IDs per element, **tombstones** for deletes |
| Best for | Server-authoritative, server-mediated apps (Docs/Sheets) | P2P, local-first, no-server or high-partition apps |
| Real examples | Google Docs/Sheets *(verify internals)* | Yjs, Automerge; Figma uses a server-authoritative CRDT-ish per-property model *(verify)* |

Pick **OT** when you already have an authoritative server and want minimal per-element overhead (spreadsheets: millions of cells → tombstone/ID overhead matters). Pick **CRDT** when you need offline-first / peer-to-peer convergence without a coordinator.

**Key takeaway:** OT = "transform against a server order, cheap metadata"; CRDT = "merge in any order, no coordinator, but pay in per-element IDs/tombstones" — server-authoritative Sheets leans OT; local-first apps lean CRDT.

---

### A13. The hard part — concurrent structural edits (insert/delete row/col)

```text
This is what makes Sheets ≠ Docs. One structural op remaps EVERY address below it
AND every reference inside every formula.

  A: insertRow(above=5)        // everything at row ≥5 shifts down by 1
  B (concurrent): setCell(A7, "=SUM(A1:A6)")   // based on pre-insert grid

Server orders A then B. transform(B against A):
  - B's target A7 → A8   (row 7 was pushed to 8 by the insert)
  - B's formula refs: A1:A6 span the insert point (row 5) → becomes A1:A7
                       (the range grows to include the new row, matching intent)

Two techniques that make this sane:
  1) STABLE IDENTITIES: give each row/column a stable internal id; a "cell address"
     is (row_id, col_id), not (5, 1). Insert adds an id; existing cells don't move.
     Display coordinates are computed from id order → address transform becomes a
     lookup, not a rewrite of a million keys.
  2) REFERENCE TRANSFORM RULES: formulas store refs as (row_id,col_id) too; an
     insert/delete adjusts only refs whose position relation to the insert changed,
     with explicit rules for refs that START, END, or SPAN the boundary.
```

**Key takeaway:** Structural ops are the spreadsheet's signature hard problem — solve it with **stable row/column identities** (so an insert doesn't rewrite a million addresses) plus **explicit reference-transform rules** for refs that start/end/span the insert point; this is where naive OT implementations produce silently-wrong formulas.

---

### A14. Offline for an hour, then reconnect

```text
Client kept: last acked server rev (R0) + an ordered buffer of local ops made offline.

On reconnect:
  1. Ask server for the current head revision and the ops since R0 (or a fresh
     snapshot if the log was compacted past R0).
  2. TRANSFORM each buffered local op against the stream of remote ops it never saw
     (server-order), in sequence — exactly OT, just a big batch.
  3. Submit the transformed local ops; server assigns them fresh revisions and
     broadcasts. Client's optimistic state is reconciled to the server's.
  4. Recompute formulas over the merged result.

Edge cases:
  - Local op targets a row a remote user deleted → transform maps it to a tombstone
    / no-op (or re-anchors), never a crash.
  - Divergence too large / snapshot gap → fall back to 3-way merge against snapshot,
    and if truly unmergeable, surface a conflict copy rather than lose work.
```

**Key takeaway:** Offline merge is just **batched OT** — replay the missed remote ops, transform every buffered local op against them, resubmit — with tombstone/re-anchor handling and, as a last resort, a conflict copy so a user's hour of work is never silently dropped.

---

## Level 4 — The Calculation Engine

### A15. Recompute in the right order, minimally

```text
Cells:  A1 = 5        B1 = A1*2      C1 = B1+1     D1 = 99 (independent)
Graph:  A1 → B1 → C1                 D1 (no deps)

User changes A1:
  1. DIRTY-MARK the transitive dependents of A1: {B1, C1}   (walk forward edges)
  2. TOPOLOGICAL SORT the dirty set: [B1, C1]  (a cell recomputes only after its
     precedents are done)
  3. RECOMPUTE in that order; D1 is untouched.

  dirty = descendants(changed_cell)         // reverse index: precedent → dependents
  for cell in topo_sort(dirty):
      cell.computed = eval(cell.ast, read=lambda ref: ref.computed)
```

**Key takeaway:** Recompute = **dirty-mark the transitive dependents → topological-sort them → evaluate in order**; you touch only the affected subtree, never the whole sheet, and topo order guarantees a cell sees fresh inputs.

---

### A16. Building & maintaining the dependency graph

```text
Two adjacency maps, updated incrementally on every formula edit:
  precedents[cell]  = { cells this formula READS }      // from the AST (A8)
  dependents[cell]  = { cells whose formula reads this }// reverse index

Edit a formula:
  old = precedents[cell]
  new = extract_refs(new_ast)
  for p in old - new:  dependents[p].remove(cell)   // detach stale edges
  for p in new - old:  dependents[p].add(cell)      // attach new edges
  precedents[cell] = new

Ranges (A1:A100) as a single node/interval avoid 100 edges; whole-column refs
(A:A) especially — otherwise a column reference explodes the graph.
```

**Key takeaway:** Keep **forward (precedents) and reverse (dependents) edges** and update them incrementally on each formula edit; the reverse index is what makes "who depends on the cell I just changed?" an O(dependents) lookup instead of a full scan — and collapse ranges to interval nodes so `A:A` doesn't create a million edges.

---

### A17. Circular reference detection

```text
A1 = B1 and B1 = A1  →  a cycle; no fixed point → error, not infinite loop.

Detect when the edge is ADDED (cheapest): before adding edge (cell → precedent),
check whether `cell` is already reachable FROM `precedent` (a path back).

  fun would_create_cycle(cell, new_precedent):
      # is there already a path new_precedent --...--> cell ?
      return dfs_reachable(from=new_precedent, target=cell)

  if any new_precedent would_create_cycle → reject formula, mark cell #REF!/#CIRCULAR

Alternatively, detect during topo-sort (a back-edge / node that can't be ordered);
Sheets also allows an *opt-in* iterative-calc mode (bounded iterations) for
intentional cycles — verify current behavior.
```

**Key takeaway:** Detect cycles **when the dependency edge is added** (DFS: is the target already reachable from the new precedent?) and reject with a `#CIRCULAR` error — a spreadsheet has no fixed point for a cycle, so you must catch it before recompute, not loop forever.

---

### A18. Making recompute fast

| Technique | What it does |
|---|---|
| **Dirty-marking** | Recompute only the transitive dependents of what changed, never the whole sheet (A15) |
| **Incremental / minimal recompute** | If a recomputed value didn't change, stop propagating to *its* dependents (short-circuit) |
| **Batching / coalescing** | A drag-fill or paste is many ops → recompute once at the end, not per cell (A28) |
| **Range/interval nodes** | Treat `SUM(A1:A1000)` as one dependency, not 1000 edges |
| **Memoization** | Pure functions over unchanged inputs return cached results |
| **Volatile isolation** | `NOW()`, `RAND()`, `TODAY()` are *always* dirty — track them separately and recompute on a controlled tick, not on every unrelated edit |
| **Parallelism** | Independent branches of the DAG (no path between them) can recompute on different cores |

**Key takeaway:** Fast recompute is **"do the least work"** — dirty-mark to the affected subtree, short-circuit when a value is unchanged, batch multi-cell edits, and quarantine volatile functions so they don't force a full-sheet recompute on every keystroke.

---

### A19. Where recompute runs + determinism

| Option | Pro | Con |
|---|---|---|
| **Client-only** | Instant feedback, no server CPU | Clients can diverge (different function impls, floating-point, locale, volatile fns) |
| **Server-only** | One authoritative result | A round-trip before you see any number — feels laggy |
| **Both (client optimistic + server authoritative)** | Instant *and* consistent | Must guarantee client == server, else visible flicker/correction |

The common answer: **client recomputes optimistically for instant feedback; the server is authoritative** and its result wins. This only works if recompute is **deterministic**:

```text
Determinism requires, on client AND server:
  - identical function semantics + evaluation order
  - fixed floating-point behavior (IEEE-754, defined rounding)
  - locale-independent parsing/formatting of the raw value
  - volatile inputs (NOW/RAND/external) resolved by the SERVER and shipped as
    fixed values, so both sides compute over the same inputs (see A37)
```

**Key takeaway:** Recompute **optimistically on the client, authoritatively on the server**, and make evaluation **deterministic** (same functions, IEEE-754, locale-free, server-fixed volatile inputs) so the two never disagree — otherwise users see numbers flicker and "correct themselves."

---

## Level 5 — System Architecture

### A20. End-to-end architecture for one document

```text
 Clients ──WebSocket──▶ Gateway (authz, route by doc_id) ──▶ Doc-Server (owner of doc_id)
                                                               ├─ Sequencer: total order + OT transform
                                                               ├─ In-memory doc: cells + op-log tail
                                                               ├─ Calc engine: incremental recompute
                                                               └─ Presence fan-out (separate)
 Doc-Server ──append op──▶ Op log / WAL (durable)
 Doc-Server ──periodic──▶ Snapshot store
 Gateway    ──on open───▶ Metadata + ACL DB
```

The **Doc-Server that owns the doc_id is the sequencer and the source of truth** for op order and live state; storage is the source of truth for *durability*.

**Key takeaway:** One document = one owning **Doc-Server** that sequences ops, holds live state, and drives recompute; the gateway just authenticates and routes by `doc_id`, and the op log/snapshots provide durability behind it.

---

### A21. Routing all editors to one server + single-writer

```text
Route:  doc_id → (consistent hash / lookup) → owning Doc-Server
        A client OPENs doc_id; gateway resolves the owner; if none, one is elected
        and takes a LEASE on doc_id (see A32). All editors of that doc land there.

Why single-writer per doc:
  - A single in-memory owner gives a TRIVIAL total order (append order) — no
    per-op distributed consensus, no clock sync, no cross-node transform race.
  - Recompute needs the whole doc in one place anyway (formulas span the sheet).
  - Per-doc load is tiny (A4), so one owner is plenty; scale is across MANY docs.
```

This mirrors [ride-sharing](../ride-sharing/)'s WebSocket session affinity and [consensus](../consensus/)'s "keep agreement off the hot path — one leader per shard decides."

**Key takeaway:** Pin every editor of a document to **one owning Doc-Server (single-writer)** via `doc_id` routing + a lease — a single in-memory owner makes op ordering a trivial append instead of a per-op consensus problem, and per-doc load is small enough that one owner never bottlenecks.

---

### A22. Persistence, compaction, crash-safe ACK

```text
Write path for an op:
  1. Sequencer assigns rev R.
  2. APPEND op to the durable op log (fsync / quorum-ack) BEFORE ACKing the client.
  3. Only then ACK(client_seq → R) and broadcast to others.
     → guarantees: no ACKed edit can be lost (it's durable before the ACK)

Compaction:
  every N ops or T minutes → write snapshot@R, then op log before R can be archived
  (retain enough history for version history — Level 7)

Recovery (server restart / crash):
  load latest snapshot → replay op log after it → back to last durable rev.
  In-flight-but-unACKed ops are simply resubmitted by clients (idempotent by
  (client_id, client_seq)).
```

**Key takeaway:** **Durably append the op before you ACK it** — that single ordering rule is what guarantees no acknowledged edit is ever lost; snapshots bound replay time, and client-side `(client_id, seq)` idempotency makes resubmission after a crash safe.

---

### A23. Scaling to millions of concurrent documents

```text
- STATELESS gateways (scale horizontally behind an LB) — terminate WS, authz, route.
- STATEFUL doc-servers, each OWNING a set of doc_ids (consistent hashing / a
  coordination service like etcd/ZooKeeper holds ownership + leases).
- Idle eviction: a doc with no editors flushes a snapshot and unloads from RAM;
  reopening reloads snapshot+ops. Live RAM ∝ *active* docs, not total docs.
- Rebalancing: adding a doc-server moves some doc_ids (drain: flush + handoff lease).
- Hot doc (many editors): one owner still fine (per-doc op rate is low, A4); if a
  doc is truly enormous, partition by sheet/tab across owners (rare).
```

**Key takeaway:** **Stateless gateways + stateful, `doc_id`-sharded doc-servers with leases**, and evict idle docs to storage so live memory scales with *active* documents (millions of docs, but only a fraction open at once) rather than total documents.

---

### A24. Doc-server crash mid-edit

```text
What users see: the WebSocket drops; client shows "reconnecting," keeps buffering
local ops optimistically (edits still feel live).

What's at risk: only ops the client didn't get an ACK for. Anything ACKed was
durably logged before the ACK (A22), so it's safe.

Recovery:
  1. Ownership lease for doc_id expires / is revoked (A32); a new doc-server claims it.
  2. New owner loads snapshot + replays op log → last durable rev.
  3. Clients reconnect, send their last-known rev + any unACKed ops.
  4. Server transforms & applies unACKed ops (idempotent by (client_id, seq)),
     re-broadcasts; clients reconcile. Recompute runs over the recovered state.
```

**Key takeaway:** A doc-server crash costs only **unACKed** ops (clients still hold them and resubmit idempotently); a new owner rebuilds live state from snapshot+log, so the failure is a brief reconnect, not data loss.

---

## Level 6 — Real-Time Transport, Presence & Fan-out

### A25. WebSocket vs SSE vs long-poll for the edit channel

| Transport | Server→client push | Client→server | Fit for edits |
|---|---|---|---|
| **WebSocket** | ✅ | ✅ (same socket) | **Best** — edits flow both ways, low overhead, ordered |
| **SSE** | ✅ | ❌ (needs a separate POST channel) | OK for *receiving* ops; awkward for sending — better for read-mostly ([sse](../sse/)) |
| **Long-poll** | ~ (poll) | ✅ (separate) | Fallback only — latency + overhead |

Edits are inherently bidirectional and latency-sensitive, so **WebSocket**. SSE is a fine *fallback for receiving* where WebSocket is blocked (restrictive proxies), paired with HTTP POST for submitting — the [sse](../sse/) / [communication-protocols](../communication-protocols/) tradeoff.

**Key takeaway:** Use **WebSocket** — collaborative editing is bidirectional and latency-sensitive; SSE (receive-only + POST to send) is a reasonable fallback where WebSocket is blocked, and long-poll is last resort.

---

### A26. Presence is a different problem

| | Edits | Presence (cursors/selections) |
|---|---|---|
| Durability | Must never lose an ACKed op | **Disposable** — a stale cursor is worthless |
| Ordering | Strict total order | Latest-wins, order barely matters |
| Frequency | Bursty, coalesced | **High** (every cursor move) |
| On overload | Never drop | **Drop freely** (throttle/sample) |

So carry presence on its **own channel / topic**, throttled (~10/s), best-effort, and expire it on disconnect (heartbeat + TTL). Never let presence traffic block or backpressure the edit path.

**Key takeaway:** Presence is **ephemeral, high-frequency, and loss-tolerant** — the exact opposite of edits — so give it a **separate throttled best-effort channel** with TTL expiry, and never let a flood of cursor moves interfere with the durable edit stream.

---

### A27. Ordered broadcast, gap detection, resync

```text
Every op the server broadcasts carries a monotonically increasing doc revision.
Each client tracks last_applied_rev.

Receive op(rev):
  if rev == last_applied_rev + 1:  apply + recompute; last_applied_rev = rev
  if rev  > last_applied_rev + 1:  GAP → request missing range (last+1 .. rev-1),
                                   buffer op(rev) until the gap is filled
  if rev <= last_applied_rev:      duplicate → ignore (idempotent)

Resync: if the gap is huge or the log was compacted past it → fetch a fresh
snapshot + tail, discard local view, reapply pending local ops via OT.
```

**Key takeaway:** Give every broadcast op a **monotonic revision** and have clients apply strictly in sequence, detect gaps (`rev > last+1`), request the missing range, and fall back to a fresh snapshot if too far behind — ordered application is what keeps convergence intact.

---

### A28. Batching / coalescing floods

```text
Problem: drag-fill 10k cells, paste a 500×500 block, or fast typing → op flood
that would swamp the network, the sequencer, and recompute.

Client-side:
  - COALESCE typing into a cell into one setCell op on commit (not per keystroke).
  - COMPOUND op for bulk edits: fill/paste = ONE op describing the region +
    generator, not 10k setCell ops.
  - DEBOUNCE presence/cursor to ~10/s.

Server + calc:
  - Apply a compound op atomically; recompute ONCE over the union of affected
    dependents, not per cell (A18 batching).
```

**Key takeaway:** Represent bulk edits (fill, paste) as **one compound op** and coalesce keystrokes on commit, so a 10k-cell drag is a single ordered op that triggers **one** batched recompute — not 10k ops and 10k recomputes.

---

## Level 7 — Consistency, Versioning & History

### A29. Version / revision history

```text
You already have the op log — history is (almost) free:
  state@R = snapshot ≤ R  +  replay ops up to R

To browse/restore:
  - Keep periodic snapshots + the op log (don't truncate history you want to keep).
  - "Named versions" = labeled revisions; "See version at 3pm" = replay to that rev.
  - RESTORE = append the inverse-diff as NEW ops (so it's collaborative-safe and
    itself undoable), not a destructive overwrite.

Storage control: coarsen old history (keep hourly/daily snapshots, drop fine-grained
old ops) to bound cost — a tiered retention, like log compaction in
[storage-engines](../storage-engines/).
```

**Key takeaway:** Version history falls out of the **op log + snapshots** — any past state is "snapshot + replay to rev R," and *restore* is applying the diff as new ops (collaboration-safe, undoable), with tiered retention to cap storage.

---

### A30. Collaborative undo/redo

```text
Naive "pop the global last op" is WRONG: it might undo your collaborator's edit,
not yours. Undo must be PER-USER and SELECTIVE.

Per-user undo of my op X (which is now buried under others' ops):
  1. Compute inverse(X)  → X⁻¹.
  2. TRANSFORM X⁻¹ against every op that came AFTER X (server order) so it applies
     correctly to the current state.
  3. Submit the transformed inverse as a NEW op (goes through the normal pipeline,
     gets a rev, broadcasts, is itself redoable).

Each user keeps their own undo stack of their own ops (with the transforms applied).
```

**Key takeaway:** Collaborative undo is **selective + per-user**: invert *your* op, **transform the inverse against everything that happened since**, and submit it as a new op — never a global pop, which would undo someone else's work.

---

### A31. Consistency model

| Question | Answer |
|---|---|
| Model | **Strong eventual consistency (convergence)** — replicas with the same op set are identical |
| Read-your-writes | Yes for the editor — optimistic local apply shows your edit immediately |
| When is an edit "committed"? | When the server has **durably logged it and ACKed** (A22) — before that it's optimistic and could be transformed |
| Cross-user ordering | Total order per document (server sequencer); causal within that |
| Computed values | Deterministic function of committed cells (A19) — not separately "committed" |

**Key takeaway:** The contract is **strong eventual consistency with a per-document total order**: your edits are read-your-writes optimistically, "committed" once durably logged + ACKed, and computed values are a deterministic function of committed inputs.

---

### A32. Split-brain — two servers both own the doc

```text
Danger: during a partition, server S1 (old owner) and S2 (new owner) both accept
edits for doc_id → two divergent op logs → unmergeable corruption.

Prevent with SINGLE-WRITER + LEASE + FENCING (this is a [consensus](../consensus/) problem):
  - Ownership is a LEASE from a coordination service (etcd/ZooKeeper/Chubby-like),
    with a TTL. Only the lease holder may sequence ops.
  - Every durable op append carries a FENCING TOKEN (monotonic lease epoch). Storage
    REJECTS appends with a stale token → an old owner that lost its lease during a
    partition cannot write, even if it still thinks it's the owner.
  - New owner only starts after the old lease provably expired (or was revoked).

Heal: the fenced-out server's un-ACKed ops fail their append; those clients
reconnect to the true owner and resubmit (A24).
```

**Key takeaway:** Enforce single-writer with a **lease + fencing token**: storage rejects appends from a stale lease epoch, so a partitioned old owner physically cannot commit — this is the [consensus](../consensus/) leader-lease pattern, and it's what makes "one owner per doc" safe under partitions.

---

## Level 8 — Scale, Advanced & Staff-Level

### A33. Very large sheets (10M cells, ARRAYFORMULA, pivots)

| Pain point | Mitigation |
|---|---|
| Memory (live state) | Sparse storage (A6); page cold regions to disk; hard cell cap (~10M — verify) |
| Load time | Snapshot + viewport lazy-load (A9); stream regions on scroll |
| `ARRAYFORMULA`/whole-column | Range/interval dependency nodes (A16); evaluate as a vectorized op, not N cells |
| Pivot over 1M rows | Precompute/materialize the pivot; recompute incrementally on source change, not per keystroke |
| Recompute spikes | Batch (A28), short-circuit unchanged (A18), parallelize independent DAG branches |

**Key takeaway:** Huge sheets are a **memory + recompute** problem — sparse storage, viewport lazy-load, range/vectorized dependency nodes for whole-column formulas, and materialized+incremental pivots keep a 10M-cell sheet usable.

---

### A34. Access control on the op path

```text
Roles: viewer (read) | commenter (read + comment) | editor (read + edit).
Finer: protected ranges (only some users may edit certain cells), link sharing.

Where enforced:
  - ON OPEN: gateway checks ACL in the metadata DB, mints a short-lived, doc-scoped
    session token carrying {user, role, protected-range rules}.
  - PER OP: the doc-server checks the CACHED session capability in memory — NOT a
    DB round-trip per keystroke. A viewer's submitted op is rejected; an edit into
    a protected range the user can't touch is rejected.
  - Revocation: ACL change → invalidate/short-TTL the session token → re-check on
    next open (bounded staleness).
```

**Key takeaway:** Authorize **once on open** (DB check → cached, doc-scoped capability token) and enforce **per op against the in-memory capability**, never the DB per keystroke — with short TTLs so revocation takes effect quickly.

---

### A35. Import/export & offline interop

```text
Import (.xlsx/.csv):
  Parse in a worker → build the internal cell model + formula ASTs. Foreign formulas
  need function/semantics mapping (Excel vs Sheets differences) → flag unsupported.
  Store as a new document snapshot; large files stage through blob storage.

Export: serialize current computed + raw state to the target format (async job for
big sheets → link/notify when ready — [notification-system](../notification-system/)).

Offline mobile: same as A14 (buffer ops, batched OT merge on reconnect). Risk:
long-offline + heavily-edited doc → large transform; cap offline window / warn,
and keep a conflict copy as the safety net.
```

**Key takeaway:** Import/export is a **parse-and-map** job (mind Excel↔Sheets formula-semantics gaps) staged through blob storage; offline mobile reuses the batched-OT merge (A14) with a capped window and conflict-copy safety net.

---

### A36. Global collaboration, single-writer, and latency

| Option | Effect |
|---|---|
| **Single owner in one region** (default) | Simple + correct; editors far from it eat ~RTT per ACK. Optimistic local apply hides most of it — *your* edits feel instant; *others'* edits arrive a round-trip late |
| **Move owner near the majority** of active editors | Minimizes aggregate latency; migrate the lease when the active set shifts |
| **Regional edge relays** | Nearby edge terminates WS + relays to the owner; cuts connection latency, not the ordering round-trip |
| **Multi-writer / CRDT** | Removes the single far sequencer but adds convergence/merge complexity — a real tradeoff, not a free win |

**Key takeaway:** With single-writer, someone is always far from the sequencer — **optimistic local apply hides it for your own edits**, and you place/migrate the owner near the active majority; going multi-writer (CRDT) trades that latency for merge complexity (see [consensus](../consensus/) leader placement, [distributed-transactions](../distributed-transactions/)).

---

### A37. Volatile & external functions (NOW, RAND, IMPORTRANGE)

```text
Problem: NOW()/RAND()/IMPORTRANGE/GOOGLEFINANCE are non-deterministic — two clients
computing them independently get DIFFERENT values → divergence.

Fix: the SERVER resolves the volatile/external input ONCE and ships it as a fixed
value that both server and all clients compute over:
  - RAND()/NOW(): server samples on a controlled recompute TICK, treats the sampled
    value as the input for that revision → deterministic for everyone that revision.
  - IMPORTRANGE/GOOGLEFINANCE: fetched server-side (also an authz + rate-limit
    boundary), cached with a refresh interval, injected as data — clients never
    fetch externally themselves.
```

**Key takeaway:** Make volatile/external functions deterministic by having the **server resolve them once per revision and ship fixed values**; clients compute over the same inputs, so `NOW()`/`RAND()`/`IMPORTRANGE` can't cause collaborators to diverge (and external fetches get a single authz/rate-limit choke point).

---

## Level 9 — Frontend Architecture (Architect)

### A38. Client editing state machine (the OT client model)

```text
Client holds three things:
  DOC        the current visible state (optimistically includes your pending ops)
  PENDING    ops you've applied locally but the server hasn't ACKed
  base_rev   the last server revision you've incorporated

Local edit:  apply to DOC now (optimistic) → push to PENDING → send(op, base_rev)
Server ACK:  the ACKed op leaves PENDING; base_rev advances
Remote op arrives (rev = base_rev+1):
  TRANSFORM it against every op still in PENDING → apply transformed op to DOC;
  also transform PENDING against it (so future ACKs line up). base_rev++.

Classic model: at most one op "in flight," rest queued — simplifies the transform
(you only ever transform against a linear server history + your pending buffer).
```

**Key takeaway:** The client keeps **DOC + a PENDING buffer + base_rev**, applies edits optimistically, and on each remote op **transforms it against pending (and pending against it)** — this is the OT client loop that makes local edits feel instant while staying convergent with the server.

---

### A39. Rendering a million-cell grid at 60fps

| Concern | Choice |
|---|---|
| Don't render offscreen cells | **Virtualization / windowing** — render only the viewport + a small margin (~hundreds of cells, not millions) |
| Draw cost | **Canvas** (or WebGL) for the cell grid — DOM nodes per cell don't scale; DOM only for overlays (editing input, menus) |
| Scroll smoothness | Recycle/repaint on scroll; decouple scroll from data fetch (A9) |
| Sticky headers / frozen panes | Separate layers composited over the grid |
| Formatting | Precompute style runs; avoid per-cell layout thrash |

**Key takeaway:** **Virtualize the grid (render only the viewport) and draw cells on canvas**, not one DOM node per cell — that's the only way a million-cell sheet scrolls at 60fps; DOM is reserved for the active editor input and overlays.

---

### A40. Client-side calc without divergence

```text
Yes — recompute on the client for instant feedback, but the SERVER is authoritative:
  - Client recompute uses the SAME engine semantics (ship the calc engine to the
    client, e.g. WASM, so functions/rounding/order are byte-identical).
  - Client computes optimistically; when the server's authoritative computed values
    arrive, they OVERWRITE the client's (should be identical → no visible change).
  - Volatile/external inputs come from the server as fixed values (A37) so the
    client never sources non-determinism.
If client and server ever disagree, the server wins and the client corrects — but
determinism (A19) means that should essentially never happen for pure formulas.
```

**Key takeaway:** Recompute on the client with the **same (ideally shared/WASM) deterministic engine** for instant feedback, but let the **server's computed values be authoritative and overwrite** — identical engines + server-fixed volatile inputs mean the overwrite is a no-op, so users never see numbers flicker.

---

### A41. Flaky network — offline, reconnect, resync

```text
While connected:  optimistic apply + PENDING buffer (A38); everything feels instant.
On disconnect:    keep editing; ops accumulate in PENDING/offline buffer; show a
                  subtle "offline / will sync" indicator, not a blocking error.
On reconnect:
  1. Send last base_rev; server returns ops since (or a snapshot if compacted past).
  2. Transform PENDING against the missed remote ops (batched OT, A14); reapply.
  3. Resubmit transformed PENDING (idempotent by (client_id, seq)); reconcile on ACK.
  4. Recompute; if a pending op can't be applied (target deleted), re-anchor or
     surface a conflict — never silently drop.
Rollback: if the server rejects/transforms an optimistic op away, animate the
correction rather than snapping, so the user understands what happened.
```

**Key takeaway:** Treat disconnect as **"keep editing optimistically, buffer, and batched-OT-merge on reconnect"** (replay missed ops, transform pending, resubmit idempotently) — the network dropping should degrade to offline editing, never a lost keystroke.

---

### A42. Rendering 50 live cursors without jank

```text
- Receive presence on the SEPARATE throttled channel (A26); ignore backlog, take
  latest per user.
- Throttle inbound to ~10 updates/s per collaborator; INTERPOLATE cursor motion
  between updates so it looks smooth without more data.
- Render cursors/selections on an OVERLAY layer above the canvas grid, so a cursor
  move never repaints cells.
- TTL/heartbeat: a collaborator who stops sending presence (closed tab, dropped
  socket) is removed after a few seconds — no ghost cursors.
- Stable per-user color/name label; batch label layout.
```

**Key takeaway:** Cursors ride the **throttled presence channel** and render on an **overlay layer with interpolation + TTL cleanup** — take latest-per-user, interpolate for smoothness, and never let a cursor move trigger a grid repaint.

---

## Bonus — Senior-Unprompted

### QB1. Comment anchors surviving structural edits

```text
Anchor a comment to a cell's STABLE identity (row_id, col_id — A13), not to (row,col).
Insert/delete rows above → the comment's cell keeps its id → the anchor "moves"
for free. If the anchored cell is DELETED → orphan the comment (show "on a deleted
cell") rather than silently dropping or mis-attaching it.
```
**Key takeaway:** Anchor comments to **stable cell identities**, not coordinates, so they ride structural edits automatically — and orphan (don't drop) a comment whose cell is deleted.

---

### QB2. Reactive charts & pivot tables

```text
A chart/pivot is just another DEPENDENT of its source range in the dependency DAG.
Source cells change → chart node marked dirty → recompute the chart's aggregate
ONCE (batched), then push the new derived data to the client to re-render.
Materialize expensive pivots and update incrementally (only the changed groups),
not a full recompute per edit.
```
**Key takeaway:** Model charts/pivots as **dependent nodes in the same DAG** — they dirty and recompute like any formula (batched, incremental for pivots), so reactivity is free from the calc engine.

---

### QB3. Bounding malicious/expensive formulas

```text
- LIMITS: max dependency-graph depth, max cells touched per recompute, max ranges,
  per-doc formula budget; reject/mark #ERROR beyond them.
- SANDBOX: evaluate formulas in a constrained interpreter (no arbitrary code, no
  unbounded loops); iterative-calc capped at N iterations.
- EXTERNAL fetch (IMPORTRANGE) rate-limited + cached server-side (A37), with fan-out
  caps so one doc can't hammer another / an external API.
- TIMEOUT a runaway recompute; isolate per-doc CPU so one sheet can't starve others.
```
**Key takeaway:** Treat formula evaluation as **untrusted code** — sandbox it, cap depth/cells/iterations/external fan-out, and time-out + CPU-isolate per document so one abusive sheet can't take down the engine.

---

### QB4. Sheets (OT) vs Figma (CRDT-ish) vs Automerge/Yjs (CRDT)

| System | Model | Optimizes for |
|---|---|---|
| **Google Sheets/Docs** | Server-authoritative **OT** *(verify internals)* | Central server present, millions of cells → cheap per-op metadata |
| **Figma** | Server-authoritative, **CRDT-ish** last-writer-wins per object property *(verify)* | Design objects (not text runs); simple property merges, server referee |
| **Automerge / Yjs** | Peer **CRDT** | Local-first / offline / P2P convergence with no central coordinator |

**Key takeaway:** The axis is **"is there an authoritative server?"** — yes + huge element counts → OT (cheap ops); local-first/P2P → CRDT (order-free merge, pay in metadata); Figma sits in between with a server refereeing simple per-property merges.

---

### QB5. Rolling out changes to transform/calc logic safely

```text
- VERSION the op format and the transform/engine; a doc records which version it's on.
- Changing transform logic mid-session is dangerous (two clients on different logic
  diverge) → gate by DOCUMENT, drain to a quiescent point, upgrade all sessions of a
  doc together (single-writer makes this a per-doc atomic switch).
- Shadow-compute: run new engine alongside old on real ops, DIFF results offline,
  ship only when diffs are zero.
- Feature-flag by doc cohort; keep the old path for rollback.
```
**Key takeaway:** Version the op/transform/engine, **upgrade a document's sessions together at a quiescent point** (single-writer makes it atomic per doc), and shadow-compute-diff the new logic against the old before flipping — never mix transform versions within one live doc.

---

### QB6. Migrating the collaboration model across billions of docs

```text
- Migrate LAZILY per document, on next open, while idle (no live editors) → no
  downtime, spread over time. A background job sweeps stragglers.
- Dual-read: understand both old and new formats during the transition.
- Migration is itself expressed as ops/a rewrite of the snapshot, checksummed;
  keep the pre-migration snapshot until verified (rollback-able).
- Never big-bang billions of docs; correctness-verify a sample per cohort before
  widening.
```
**Key takeaway:** Migrate **lazily and per-document on open-while-idle** with dual-read + checksummed, reversible rewrites — billions of docs is a slow rolling sweep, never a synchronized big-bang.

---

## ⚡ Quick Revision Cheatsheet

### Scale numbers (order-of-magnitude — verify)

```text
Per active editor:  ~1–5 ops/s (coalesced)           → per-doc op rate is TINY
Busy doc:           ~10 editors → ~50 ops/s            → not a throughput problem
Remote-edit latency target: ~100–200ms                 (local edit: instant/optimistic)
Live server RAM:    1M live docs × ~1–10MB = 1–10 TB    → scale = many stateful sessions
Sheet cap:          ~10^7 cells (Google's documented limit — verify current)
Recompute:          1 input → up to its transitive-dependent subtree (CPU-bound)
```

### Key technology choices

| Component | Choice | Why |
|---|---|---|
| Edit transport | **WebSocket** | Bidirectional, ordered, low-latency |
| Convergence | **OT (server-authoritative)** for Sheets; CRDT for local-first | Server present + huge cell counts → cheap ops |
| Sequencing | **Single-writer doc-server** per `doc_id` + lease | Trivial total order, no per-op consensus |
| Durability | **Op log (WAL) + periodic snapshot** | No ACKed edit lost; bounded replay |
| Recompute | **Incremental calc engine over a dependency DAG** | Dirty-mark → topo-sort → minimal recompute |
| Presence | **Separate throttled best-effort channel** | Ephemeral, loss-tolerant, never blocks edits |
| Ownership safety | **Lease + fencing token** (etcd/ZK) | Prevents split-brain double-write |
| Frontend | **Virtualized canvas grid + optimistic OT client + WASM calc** | 60fps + instant feedback + determinism |

### Canonical tradeoffs to memorize

- **OT vs CRDT:** transform-against-a-server-order (cheap ops, needs coordinator) vs merge-in-any-order (no coordinator, pays in per-element IDs/tombstones).
- **Single-writer vs multi-writer:** trivial ordering + far-editor latency vs local latency + merge complexity.
- **Client calc vs server calc:** instant feedback (divergence risk) vs authoritative (round-trip lag) → do both, deterministic, server wins.
- **Convergence vs intention preservation:** LWW gives the first cheaply but discards edits; OT/CRDT give both.
- **Availability vs consistency offline:** keep editing offline (optimistic) and reconcile via batched OT, with a conflict copy as the last-resort safety net.

### Common interview mistakes to avoid

- Treating it like collaborative *text* and forgetting the **calc engine** — the whole second plane.
- Ignoring **structural ops** (row/col insert shifting every address & reference) — the signature hard problem.
- "Last-write-wins solves conflicts" — it converges but **silently drops edits** (no intention preservation).
- Peer-to-peer OT without a sequencer — intractable; use **single-writer** or a CRDT.
- Mixing **presence with edits** — cursors are lossy/high-frequency and must not block the durable edit path.
- Recomputing the **whole sheet** on every edit instead of dirty-marking the affected subtree.
- Forgetting **determinism** (floating-point, locale, `NOW()`/`RAND()`) → collaborators compute different numbers.
- ACKing an op **before** it's durably logged → a crash loses an "accepted" edit.
- No **fencing token** on ownership → split-brain double-writes an unmergeable log.
