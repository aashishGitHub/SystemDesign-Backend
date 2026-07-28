# Deep Dive: Collaborative Editing (Google Sheets / Docs)

> Each chapter has three depths: 🟢 **Beginner** (analogy + intuition), 🟡 **Senior** (implementation + tradeoffs), 🔴 **Architect** (scale, failure modes, production reality).
> Depth that belongs to a neighbouring topic is cross-linked, not repeated: [consensus](../consensus/) (total order, leader/lease/fencing), [communication-protocols](../communication-protocols/) / [chat-system](../chat-system/) / [sse](../sse/) (transport), [storage-engines](../storage-engines/) (WAL + snapshot + compaction), [file-storage](../file-storage/) (snapshot+delta, versioning).
>
> **Accuracy note:** OT/CRDT theory is standard and checkable; specific claims about *how Google/Figma implement* collaboration are hedged ("verify") — informed illustration, not authoritative internals.

## Table of Contents

1. Two Planes — Why a Spreadsheet is Two Agreement Problems
2. The Document Model & Persistence
3. Convergence: OT vs CRDT
4. The Signature Hard Problem — Structural Ops
5. The Calculation Engine (Dependency DAG)
6. System Architecture — Single-Writer, Sessions, Scale
7. Real-Time Transport & Presence
8. Consistency, History & Undo
9. Failure Modes
10. Frontend Architecture
11. Real-World Case Notes
12. Quick Recall Cheat Sheet

---

## 1. Two Planes — Why a Spreadsheet is Two Agreement Problems

### 🟢 Beginner — Two people, one notebook (with a calculator built in)

Imagine two people writing in the same notebook at the same time. Problem one: they must not scribble over each other — when both write on the same line, the page still has to make sense to everyone. That's the **sync** problem. Now imagine the notebook has a magic property: some cells say "= the sum of those other cells," and whenever you change a number, all the sums update themselves. Problem two: those sums must update in the right order and come out the *same* for both people. That's the **calc** problem. A shared Google Doc only has problem one. A shared Google Sheet has both.

### 🟡 Senior — Sync decides inputs, calc decides outputs

The design's first cut is by *what has to be agreed*:

```text
SYNC PLANE   agree on the RAW cells the users typed      → convergence (OT/CRDT)
CALC PLANE   agree on the DERIVED cells formulas produce → deterministic recompute
```

They are different kinds of agreement. Sync is **conflict resolution** — many writers, one converged state, nobody's edit silently lost. Calc is **dependency propagation** — a pure function from committed inputs to outputs, the same everywhere. The bridge is one-directional in spirit: a sync edit dirties the calc plane, and the calc plane's recomputed cells re-enter the sync plane as ordered derived changes. Conflating them (e.g. trying to "merge" computed values instead of recomputing them from merged inputs) is a classic mistake — you never merge outputs, you merge inputs and recompute.

### 🔴 Architect — The scaling shape is unusual

Most "real-time" systems (chat, feeds, ride-sharing location) are **throughput** problems — huge op rates, mostly stateless workers. Collaborative editing is the opposite: per-document op rate is tiny (~tens/sec even for a busy doc), but each document is a **small, stateful, latency-sensitive session** that must live in memory to be sequenced and recomputed. So the scale challenge is *breadth of state* — holding millions of independent live sessions, each with its own op log tail, dependency graph, and cell values — plus recompute CPU for large sheets, plus getting convergence and determinism *exactly* right because a bug here silently corrupts numbers. You scale across documents (shard by `doc_id`), not within one.

---

## 2. The Document Model & Persistence

### 🟢 Beginner — A menu that's mostly blank

A spreadsheet looks like a giant grid, but almost every cell is empty. Storing an empty grid cell-by-cell would waste enormous space, like printing a phone book of blank pages. So you only write down the cells that actually have something in them.

### 🟡 Senior — Sparse cells, and a formula is source + value

```text
cells: Map<(row_id, col_id) -> Cell>
Cell  = { kind: VALUE | FORMULA,
          raw:      "42" | "=SUM(A1:A10)",   // what the user typed
          computed: 42,                       // what the calc engine produced
          format:   {...} }
```

A formula keeps **both** its source (`raw`) and its last computed value (`computed`) — recompute overwrites only `computed`. Cells are keyed by **stable identities** (`row_id`, `col_id`), not display coordinates, so inserting a row doesn't rewrite a million map keys (Ch. 4). Persistence is the [storage-engines](../storage-engines/) pattern:

```text
SNAPSHOT  full state @ rev R   (periodic checkpoint)
OP LOG    every op with rev > R (append-only WAL, ordered, durable)
state @ R = snapshot ≤ R + replay ops since
```

### 🔴 Architect — One mechanism, four uses

The snapshot+op-log gives you **durability** (append before ACK → no lost edit), **fast load** (snapshot + short tail, not full history), **crash recovery** (replay after last snapshot), and **version history** (replay to any rev) — all from one structure. The knob is compaction/retention: snapshot frequently to bound recovery time, but keep enough history (coarsened over age — fine-grained recent, hourly/daily old) for the "restore to last Tuesday" feature. Restore is *append the inverse diff as new ops*, never a destructive overwrite, so restoring is itself collaborative-safe and undoable.

---

## 3. Convergence: OT vs CRDT

### 🟢 Beginner — Two ways to never lose an edit

Two people edit at once; how do you avoid one clobbering the other? **Way one (OT):** everyone sends their little *change* to a referee, who lines the changes up in an order and adjusts each one so it still makes sense after the others — "you meant to insert at position 2, but someone added a letter before it, so really position 3." **Way two (CRDT):** tag every piece of data with a globally-unique label so that no matter what order changes arrive, merging them always lands in the same place, with no referee needed.

### 🟡 Senior — The transform function vs the merge function

OT is defined by its **transform**: `transform(op1, op2)` rewrites `op1` so it can apply *after* `op2` and still preserve intent, satisfying the convergence property

```text
apply(apply(s, op1), transform(op2, op1)) == apply(apply(s, op2), transform(op1, op2))
```

With a **central server imposing a total order**, each client only transforms against a *linear* history — tractable and provably convergent (the Jupiter client-server model, mid-1990s — verify specifics). Peer-to-peer OT (transform against a partial order) is famously hard; several published OT algorithms were later shown to have subtle convergence bugs (verify).

CRDTs move the cleverness into the data type: elements carry stable unique IDs, deletes leave **tombstones**, and merges are commutative/associative/idempotent, so order doesn't matter and no coordinator is needed. The cost is metadata — per-element IDs and tombstones — which for a million-cell sheet is real memory.

| | OT | CRDT |
|---|---|---|
| Needs central sequencer | Practically yes | No |
| Per-element metadata | Low | Higher (IDs, tombstones) |
| Sweet spot | Server-authoritative apps | Local-first / P2P / offline |

### 🔴 Architect — Why server-authoritative apps lean OT

If you already run an authoritative server (you do — you need it for calc, auth, persistence anyway), the total order is free, and OT's low per-op metadata wins for huge element counts. Google Docs/Sheets are publicly described as OT-based, server-authoritative (verify internals). Local-first tools (Automerge by Martin Kleppmann et al.; Yjs by Kevin Jahns) choose CRDTs because they must converge with *no* server and survive long partitions. The interesting middle is Figma, whose public engineering blog describes a **server-authoritative, CRDT-inspired** model with last-writer-wins per object property (not text OT, not full CRDT) — chosen because design objects merge more simply than character sequences (verify against their post). The lesson: the convergence mechanism follows the *topology* (is there an authoritative server?) and the *data shape* (characters vs cells vs objects), not fashion.

---

## 4. The Signature Hard Problem — Structural Ops

### 🟢 Beginner — Insert a row, and every address below moves

If you're on row 7 and someone inserts a new row above you, you're now on row 8. Every formula that pointed at "row 7" now has to point at "row 8" instead — automatically, for everyone, at the same time. Multiply that by two people doing it at once and you see why this is the tricky part.

### 🟡 Senior — Transform references by their relation to the boundary

A row/column insert or delete shifts **addresses** (sync plane) *and* **references inside formulas** (calc plane) simultaneously. When two structural/edit ops are concurrent, the transform must adjust by how each reference relates to the insert point:

```text
insertRow(above = 5), concurrent setCell(A7, "=SUM(A1:A6)")   [both based on pre-insert]
  target A7            → A8      (below the insert → shifts down)
  ref A1:A6 SPANS row 5 → A1:A7  (range grows to include the new row — intent preserved)
  a ref entirely above 5 → unchanged
  a ref entirely below 5 → shifts down
```

The enabling trick is **stable identities**: store `(row_id, col_id)` and reference cells by id, computing display coordinates from id order. Insert adds an id; existing cells don't move; the "transform a million addresses" problem collapses to "insert one id + adjust the few refs whose boundary relation changed."

### 🔴 Architect — This is where correctness quietly dies

Naive implementations get the *common* cases right and the *boundary* cases (a reference that starts-before/ends-inside the insert, a delete of a row a concurrent formula references, two concurrent inserts at the same index) subtly wrong — producing a formula that points one row off, or a `#REF!` that shouldn't be there. Because the result is a *plausible wrong number*, not a crash, it can go unnoticed. Serious implementations pin down every boundary rule and test convergence exhaustively (property-based tests that apply random concurrent op pairs in both orders and assert identical results). Comment anchors, chart source ranges, protected ranges, and named ranges must *all* ride the same stable-identity mechanism, or they drift after structural edits.

---

## 5. The Calculation Engine (Dependency DAG)

### 🟢 Beginner — Dominoes, not a rescan

When you change one number, you don't recheck the entire sheet. You only knock over the "dominoes" that depend on that number — the cells whose formulas mention it, then the cells that mention *those*, and so on. Everything else is left alone.

### 🟡 Senior — Dirty-mark → topological sort → minimal recompute

```text
precedents[cell] = cells this formula reads   (from the AST)
dependents[cell] = reverse index (who reads this cell)

On change to X:
  dirty = transitive dependents of X            (walk reverse edges)
  order = topological_sort(dirty)               (a cell after its precedents)
  for c in order: c.computed = eval(c.ast); if unchanged → stop propagating (short-circuit)
```

Keep both edge directions and update them incrementally on each formula edit. Collapse ranges (`A1:A100`, and especially whole-column `A:A`) into **interval nodes** so one reference isn't a thousand edges. Quarantine **volatile** functions (`NOW()`, `RAND()`, `TODAY()`) — they're always dirty and must recompute on a controlled tick, not on every unrelated edit.

### 🔴 Architect — Determinism is the whole ballgame

Because clients recompute optimistically for instant feedback while the server recomputes authoritatively, the two **must** agree bit-for-bit, or users watch numbers flicker and "correct themselves." Determinism requires identical function semantics, fixed IEEE-754 floating-point behavior, locale-independent parsing/formatting, and — critically — **server-resolved volatile/external inputs**: the server samples `NOW()`/`RAND()` and fetches `IMPORTRANGE`/`GOOGLEFINANCE` once per revision and ships the fixed values, so every client computes over the same inputs (and external fetches get a single authz + rate-limit choke point). Cycles (`A1=B1`, `B1=A1`) are caught **when the edge is added** (DFS reachability), yielding `#CIRCULAR` rather than an infinite loop; intentional cycles need explicit bounded iterative-calc mode (verify current behavior).

---

## 6. System Architecture — Single-Writer, Sessions, Scale

### 🟢 Beginner — One referee per game

Every open document has exactly one "referee" server that decides the order of moves. Everyone editing that document talks to that one referee, so there's never an argument about what happened first.

### 🟡 Senior — Stateless gateways + `doc_id`-sharded stateful doc-servers

```text
client ──WS──▶ gateway (stateless: authz on open, route by doc_id)
                   │ resolve owner (consistent hash + lease in etcd/ZK)
                   ▼
              doc-server that OWNS doc_id (stateful, single writer)
                   ├─ sequencer: total order + OT transform
                   ├─ in-memory doc: cells + op-log tail
                   └─ calc engine
                   │ append op (durable) BEFORE ack
                   ▼
              op log (WAL) + periodic snapshot + metadata/ACL DB
```

**Single-writer per document** is the key move: one in-memory owner makes op ordering a trivial append — no per-op distributed consensus, no clock sync, no cross-node transform race — and recompute needs the whole doc in one place anyway. Per-doc load is tiny, so one owner never bottlenecks; you scale across *many* docs. This mirrors [ride-sharing](../ride-sharing/)'s WebSocket session affinity and [consensus](../consensus/)'s "one leader per shard decides, keep agreement off the hot path."

### 🔴 Architect — Idle eviction and the memory math

Live RAM must scale with **active** docs, not total docs. A document with no editors flushes a snapshot and unloads; reopening reloads snapshot+tail. With ~1M live docs at ~1–10MB live state each, that's ~1–10TB across the fleet (order-of-magnitude — verify) — sized by *concurrency*, not the 10^8 total documents. Rebalancing (adding a doc-server) drains ownership: flush + hand off the lease for a subset of `doc_id`s. A truly enormous single document (rare) can partition by sheet/tab across owners, but that reintroduces cross-owner coordination for cross-sheet formulas, so it's a last resort.

---

## 7. Real-Time Transport & Presence

### 🟢 Beginner — A phone call, plus a laser pointer

Edits are like a phone call where both people can talk and must hear everything — you can't miss a word. Cursors are like a laser pointer wiggling on the screen — nice to see, but if it stutters for a moment, nobody cares. You wouldn't run both over the same "don't-miss-a-word" channel.

### 🟡 Senior — WebSocket for edits, a separate throttled channel for presence

Edits are bidirectional and must never be lost or reordered → **WebSocket** (SSE receive-only + POST is a fallback where WebSocket is blocked; long-poll is last resort — the [sse](../sse/) / [communication-protocols](../communication-protocols/) tradeoff). Presence (cursors, selections) is **ephemeral, high-frequency, and loss-tolerant** — carry it on its own channel, throttled to ~10/s, dropped freely under load, expired via heartbeat+TTL, and rendered on an overlay layer so a cursor move never repaints cells. Every broadcast edit carries a **monotonic revision**; clients apply in order, detect gaps (`rev > last+1`), request the missing range, and fall back to a snapshot resync if too far behind.

### 🔴 Architect — Never let presence backpressure edits

The failure to avoid: a flood of cursor updates (someone dragging wildly, 50 collaborators) consuming the same queue/threads as edits and *delaying a durable op*. Physically separate the paths, give presence a bounded lossy buffer, and shed presence load first. Batching also protects the edit path: a drag-fill or paste is **one compound op**, not 10k `setCell`s, which keeps both the network and the recompute engine sane (one batched recompute over the union of dirtied cells).

---

## 8. Consistency, History & Undo

### 🟢 Beginner — Everyone ends up seeing the same thing

The promise isn't "instantly identical everywhere" — it's "once the dust settles and everyone has seen the same edits, everyone's screen matches." And you can always rewind to how the document looked at any moment in the past.

### 🟡 Senior — Strong eventual consistency + selective per-user undo

The contract is **strong eventual consistency (convergence)** with a per-document total order: your own edits are read-your-writes optimistically, an edit is "committed" once durably logged + ACKed, and computed values are a deterministic function of committed cells. Undo is the subtle one — a global "pop the last op" would undo a *collaborator's* edit. Correct undo is **selective and per-user**: invert *your* op, transform the inverse against every op that landed after it, and submit that as a new op (itself redoable):

```text
undo(my op X):
  X⁻¹ = inverse(X)
  X⁻¹' = transform X⁻¹ against all ops after X (server order)
  submit X⁻¹' as a NEW op   → gets a rev, broadcasts, is redoable
```

### 🔴 Architect — History cost control

Keeping every op forever is expensive at 10^8 docs. Tier retention: fine-grained recent ops, coarser (hourly→daily snapshots, dropped intermediate ops) as history ages — enough to restore meaningfully without unbounded storage. Named/labeled revisions are just tagged revs. Restoring is appending the diff as new ops, so a restore during live collaboration doesn't fight with in-flight edits — it's just more ops through the same pipeline.

---

## 9. Failure Modes

### 🔴 Doc-server crash mid-edit
- **Symptom:** WebSocket drops; clients show "reconnecting," keep editing optimistically.
- **At risk:** only *unACKed* ops (ACKed ops were durably logged before the ACK).
- **Recovery:** lease expires → new owner claims `doc_id` → loads snapshot + replays op log → clients reconnect, resubmit unACKed ops (idempotent by `(client_id, seq)`), reconcile.

### 🔴 Split-brain (two owners during a partition)
- **Symptom risk:** two divergent op logs → unmergeable corruption.
- **Guard:** ownership **lease** + a **fencing token** (monotonic epoch) on every durable append; storage rejects a stale epoch, so a partitioned old owner physically can't commit. The [consensus](../consensus/) leader-lease pattern.

### 🔴 Client/server calc divergence
- **Symptom:** a user sees a number that then "corrects itself" when the server's value arrives.
- **Cause:** non-determinism — floating-point, locale, or a volatile/external function computed independently.
- **Guard:** identical (shared/WASM) engine semantics + server-resolved volatile/external inputs (Ch. 5); server value is authoritative and overwrites (should be a no-op).

### 🔴 Structural-op reference corruption
- **Symptom:** after concurrent inserts/deletes, a formula points one row off or shows a wrong `#REF!` — a silent wrong *number*.
- **Guard:** stable identities + exhaustively-tested boundary rules + property-based convergence tests (apply random concurrent op pairs in both orders, assert identical).

### 🔴 Hot / huge document
- **Symptom:** a 10M-cell sheet or a whole-column `ARRAYFORMULA` stalls recompute; open is slow.
- **Guard:** sparse storage, viewport lazy-load, range/interval dependency nodes, materialized+incremental pivots, batched recompute, per-doc CPU isolation, and a hard cell cap.

### 🔴 Abusive formula
- **Symptom:** deep recursion / giant array / `IMPORTRANGE` fan-out exhausts the engine.
- **Guard:** sandboxed evaluation, caps on graph depth/cells/iterations/external fan-out, recompute timeouts, per-doc CPU isolation.

---

## 10. Frontend Architecture

### 🟢 Beginner — Show it now, confirm it later

When you type, the cell updates instantly — the app doesn't wait to hear back from the server. Behind the scenes it remembers "I haven't been told this is official yet," sends it off, and quietly reconciles when confirmation arrives.

### 🟡 Senior — Optimistic OT client + virtualized canvas grid

The client holds **DOC + a PENDING buffer + base_rev** (Diagram 10). Local edits apply optimistically and enter PENDING; remote ops are transformed against PENDING before applying (and PENDING against them); ACKs clear PENDING and advance `base_rev`. Rendering a potentially-million-cell grid needs **virtualization/windowing** (draw only the viewport + margin) on **canvas/WebGL** (one DOM node per cell doesn't scale), with DOM reserved for the active editor input and overlays. Client-side recompute uses the **same deterministic engine** (ideally the server's engine compiled to WASM) so its optimistic values match the authoritative ones.

### 🔴 Architect — Flaky networks are the normal case

Treat disconnection as a first-class state, not an error: keep editing offline, buffer ops, show a subtle "offline / will sync" indicator. On reconnect, fetch missed ops (or a snapshot if compacted past your rev), **batched-OT transform** your pending ops against them, resubmit idempotently, and reconcile. If a pending op can't apply (its target row was deleted), re-anchor or surface a conflict copy — **never silently drop the user's work**. When the server transforms an optimistic op away, animate the correction rather than snapping, so the change is legible.

---

## 11. Real-World Case Notes

> Public/observable where possible; internal specifics marked **verify**.

- **Google Docs / Sheets** — publicly described as **OT, server-authoritative** (lineage traces to the Jupiter client-server OT model and Google Wave). Optimistic local apply + server as the ordering authority. Exact modern internals — **verify**.
- **Etherpad / ShareDB** — open-source **OT** implementations you can actually read; ShareDB is a widely-used OT backend library. Good for grounding the client-server OT loop. **Verify** current APIs.
- **Figma** — its public engineering blog ("How Figma's multiplayer technology works") describes a **server-authoritative, CRDT-inspired** model with last-writer-wins per object property — chosen because design objects merge more simply than text runs. **Verify** against the post.
- **Automerge / Yjs** — mature **CRDT** libraries for **local-first / offline / P2P** apps (Automerge associated with Martin Kleppmann's research group; Yjs by Kevin Jahns). The reference point for "no central server."
- **Foundational reading** — OT originates with Ellis & Gibbs' GROVE work (1989, "Concurrency Control in Groupware Systems"); CRDTs with Shapiro, Preguiça, Baquero, Zawirski (2011, "Conflict-free Replicated Data Types"). Cite only if you're confident; otherwise say "the OT/CRDT literature" — **verify titles/authors before quoting**.

---

## 12. Quick Recall Cheat Sheet

```text
CENTRAL SPLIT
  SYNC plane  concurrent edits → CONVERGE (OT/CRDT, server-ordered)
  CALC plane  formula DAG → DETERMINISTIC recompute (dirty→topo→eval)
  Text editing = sync only; the calc plane is what makes Sheets harder.

CONVERGENCE
  correct = convergence + intention preservation (LWW gives only the first)
  OT   = send ops, transform vs server-ordered concurrent ops (cheap, needs coordinator)
  CRDT = order-free merge via unique IDs + tombstones (no coordinator, metadata cost)

THE HARD PART
  row/col insert shifts every address AND every reference → stable (row_id,col_id)
  + explicit start/end/span transform rules; test convergence property-based.

CALC ENGINE
  precedents (read) + dependents (reverse index); dirty-mark → topo-sort → minimal recompute
  short-circuit unchanged; range/interval nodes for A:A; quarantine NOW()/RAND()
  cycles: detect on edge insert (DFS) → #CIRCULAR; determinism = same fns + IEEE754 + server-fixed volatiles

ARCHITECTURE
  stateless gateways (authz+route) + doc_id-sharded stateful doc-servers (SINGLE WRITER)
  single writer = trivial total order; append op BEFORE ack = no lost edit
  snapshot + op log = durability + load + recovery + history (one mechanism)
  idle-evict → live RAM ∝ ACTIVE docs; scale across docs, not within one

TRANSPORT
  edits = WebSocket (ordered, durable); presence = separate throttled lossy channel + TTL
  monotonic revision per op; gap detect (rev>last+1) → request range → snapshot resync

CONSISTENCY / HISTORY
  strong eventual consistency + per-doc total order; read-your-writes; commit = durable+ACK
  undo = selective per-user: invert my op, transform vs later ops, submit as new op

FAILURE MODES
  server crash → lose only unACKed (resubmit idempotently)
  split-brain → lease + fencing token (storage rejects stale epoch)
  calc divergence → identical engine + server-fixed volatile inputs
  structural corruption → stable ids + boundary rules + property tests
  abusive formula → sandbox + caps + timeout + per-doc CPU isolation

FRONTEND
  optimistic OT client: DOC + PENDING + base_rev; transform remote vs pending
  virtualized canvas grid (viewport only); WASM calc for deterministic instant feedback
  offline = keep editing + buffer + batched-OT merge on reconnect; never drop work
```
