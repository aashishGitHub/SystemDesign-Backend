# Interview Questions: Collaborative Editing (Google Sheets / Docs)

> Attempt each question cold before reading [answers.md](./answers.md).
> Work level-by-level; later levels assume earlier concepts.
> This is the **Google Sheets** framing (grid + formulas). Text-only editing (Google Docs) is the simpler sub-case — called out where the two diverge. Real-time transport depth lives in [communication-protocols](../communication-protocols/) / [chat-system](../chat-system/) / [sse](../sse/); op ordering & single-writer depth in [consensus](../consensus/).

---

## Level 1 — Fundamentals & Requirements
*Goal: see that a spreadsheet is two problems bolted together — sync and compute — before designing anything.*

**Q1.** Google Sheets is often pitched as "Google Docs for numbers." Name three ways it is fundamentally *harder* than collaborative text editing, and why each matters architecturally.

**Q2.** A collaborative spreadsheet has two distinct planes. Identify them and explain why each has different consistency, latency, and resource characteristics.

**Q3.** What are the functional and non-functional requirements? State the hard guarantees (convergence, no lost acknowledged edits, deterministic recompute) and the scale assumptions you'll design against.

**Q4.** Back-of-the-envelope: estimate edit-ops/sec per document, concurrent editors, cells per sheet, and recompute cost. Which resource dominates — network, memory, or CPU — and what does that tell you about where the bottleneck is?

**Q5.** List the core entities and the minimal protocol set needed to open a document, subscribe to changes, send an edit, and see who else is editing.

---

## Level 2 — The Document Model (Grid, Cells, Formulas)
*Goal: model a sparse grid of cells where a cell is either a value or a formula.*

**Q6.** Design the data model for a sheet. A 26-column × 100k-row sheet is almost entirely empty, yet Sheets supports millions of cells — dense array or sparse map? What is a "cell"?

**Q7.** How do you persist a document so it loads fast *and* survives a crash with no acknowledged edit lost? (snapshot + operation log)

**Q8.** How do you represent a formula internally? Cover parsing to an AST, A1-notation references, relative vs absolute (`A1` vs `$A$1`), and ranges (`SUM(A1:A100)`).

**Q9.** A sheet has 2M populated cells but the user's screen shows ~200. How do you load and render only what's needed? (viewport / lazy load — bridges to the frontend level)

---

## Level 3 — Concurrent Editing & Convergence (OT vs CRDT)
*Goal: make simultaneous edits from many users converge to one identical state everywhere.*

**Q10.** Two users edit the same cell at the same instant. What does "correct" even mean here? Define **convergence** and **intention preservation**, and why last-write-wins alone is not enough.

**Q11.** Explain **Operational Transformation (OT)**. What is the transform function, and why does classic OT rely on a central server imposing a total order on operations?

**Q12.** Explain **CRDTs**. How do they converge without a central sequencer, and what do you pay for that (metadata, tombstones, memory)? When would you pick CRDT over OT?

**Q13.** *(The spreadsheet-specific hard part.)* User A inserts a row above row 5 while user B, concurrently, edits `A7` and writes formula `=SUM(A1:A6)`. Insert/delete of a row or column shifts every address and every reference below it. How do concurrent **structural** edits converge without corrupting references?

**Q14.** *(Failure mode)* A client goes offline for an hour, makes 200 local edits, then reconnects to find the document has moved on. How do you merge without losing the user's work or corrupting the sheet?

---

## Level 4 — The Calculation Engine (Dependency DAG)
*Goal: reactive, deterministic recompute — the plane that makes a spreadsheet ≠ a text doc.*

**Q15.** A user changes `A1`. Cells `B1=A1*2` and `C1=B1+1` depend on it. How do you recompute exactly the affected cells, in the correct order, and nothing more?

**Q16.** How do you build and maintain the dependency graph incrementally as formulas are typed and deleted? What do you store per cell (precedents, dependents)?

**Q17.** A user types `A1 = B1` while `B1 = A1` already exists. How and when do you detect a **circular reference**, and what do you show?

**Q18.** One input cell feeds a subtree of 500k dependent formulas. Recomputing everything on each keystroke is unusable. How do you keep recompute fast? (dirty-marking, minimal/incremental recompute, batching, memoization, volatile functions like `NOW()`/`RAND()`)

**Q19.** *(Key design decision.)* Where does recompute run — on each client, on the server, or both — and how do all collaborators end up agreeing on the computed values? What makes recompute **deterministic**?

---

## Level 5 — System Architecture: Server, Sessions, Persistence
*Goal: the end-to-end backend for one live document, then at scale.*

**Q20.** Draw the end-to-end architecture for editing one document (client ↔ collaboration server ↔ storage). Who is the **sequencer** / source of truth for op order?

**Q21.** All editors of a document must reach the same in-memory server session. How do you route them there (session affinity / document ownership), and why is a **single-writer per document** the common choice?

**Q22.** Detail persistence: snapshot + operation log. How do you durably persist ops, compact the log, and recover the live state after a crash without losing acknowledged edits?

**Q23.** How do you scale to millions of concurrently-open documents? (stateless gateway + stateful doc-servers, shard by `doc_id`, ownership handoff, idle eviction)

**Q24.** *(Failure mode)* The doc-server holding a live editing session crashes mid-edit. What do the users see, what could be lost, and how do you recover the in-memory op log?

---

## Level 6 — Real-Time Transport, Presence & Fan-out
*Goal: the live wire between clients and server.*

**Q25.** WebSocket, SSE, or long-poll for the edit channel — which and why? How does this compare to the choices in [chat-system](../chat-system/) and [sse](../sse/)?

**Q26.** Presence — live cursors, cell selections, "who's viewing." Why is presence a *different* problem from edits (ephemeral, high-frequency, loss-tolerant), and how do you carry it on its own channel?

**Q27.** The server receives an op and must broadcast it to N other editors in order. How do you guarantee each client applies ops in the right sequence, detect a gap (missed op), and resync?

**Q28.** A user drag-fills 10,000 cells, or pastes a 500×500 block, or types quickly. How do you stop that from flooding the network and the recompute engine? (op coalescing, debounce, compound ops)

---

## Level 7 — Consistency, Versioning & History
*Goal: correctness across time — history, undo, and the consistency contract.*

**Q29.** Version / revision history: how do you let a user browse and restore any past state of the document without storing a full copy per keystroke? (snapshot + delta, named revisions, compaction)

**Q30.** Undo/redo with multiple editors: why is it *not* just "pop the last op off the global stack," and how do you implement per-user undo that reverts *my* change, not my collaborator's? (selective undo via inverse ops + transform)

**Q31.** State the consistency model precisely. What guarantee do you give (strong eventual consistency / convergence)? Do editors get read-your-own-writes, and *when* is an edit considered "committed"?

**Q32.** *(Failure mode)* During a network partition two servers each believe they own the document and both accept edits (split-brain). What happens, and how do you prevent or heal it? (single-writer, lease + fencing token — see [consensus](../consensus/))

---

## Level 8 — Scale, Advanced & Staff-Level
*Goal: the hard edges that separate a senior answer from a staff one.*

**Q33.** A 10M-cell sheet with `ARRAYFORMULA` over whole columns and a pivot table over 1M rows. Where does it hurt (memory, recompute, load time), and how do you keep it usable?

**Q34.** Sharing & access control: view / comment / edit roles, protected ranges, link sharing. Where on the op path do you enforce authorization, and how do you not check the DB on every keystroke?

**Q35.** Import/export & interop (`.xlsx`, `.csv`) and offline-first mobile. What breaks when a foreign file or a long-offline client rejoins, and how do you reconcile?

**Q36.** Two teams collaborate on one document from different continents (~250ms RTT apart). With a single-writer model, someone is always far from the sequencer. What is the latency tradeoff, and what are your options? (see [consensus](../consensus/) leader placement)

**Q37.** Formulas that pull external or volatile data — `NOW()`, `RAND()`, `IMPORTRANGE`, `GOOGLEFINANCE`. These threaten determinism: two clients could compute different results. How do you keep every collaborator consistent?

---

## Level 9 — Frontend Architecture (Architect)
*Goal: the client-side design — local model, optimistic edits, huge-grid rendering, flaky networks.*

**Q38.** Design the client's editing state machine: local document model, the buffer of pending vs acknowledged ops, optimistic apply, and reconciliation when the server's transformed op comes back. (the OT client model)

**Q39.** Render a grid of potentially millions of cells at 60fps. Virtualization/windowing, canvas vs DOM, sticky headers, smooth scroll — what's your rendering strategy and why?

**Q40.** Should the client recompute formulas locally for instant feedback? If yes, how do you guarantee the client's computed values never diverge from the server's authoritative result?

**Q41.** The user is on a flaky mobile network. Handle optimistic UI, offline edits, reconnection & resync (replay unacked ops, fetch missed ops by sequence number), and rollback on conflict.

**Q42.** Render 50 collaborators' live cursors and selections without jank. How do you throttle, interpolate, and clean up presence for users who vanish?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** Comments and discussion threads are anchored to a cell (e.g. "note on C7"). When someone inserts rows above, the anchor must move with the cell. How do anchors survive structural edits?

**QB2.** Charts and pivot tables derive from ranges. How do they update reactively when the underlying cells change, without recomputing the whole chart on every edit?

**QB3.** A malicious or accidental formula — a giant `ARRAYFORMULA`, deep recursion, an `IMPORTRANGE` fan-out — could exhaust the recompute engine. How do you sandbox and bound formula execution?

**QB4.** Google Sheets (OT, server-authoritative) vs Figma (server-authoritative CRDT-ish) vs a peer-to-peer CRDT app (Automerge/Yjs). What architectural choice drives each, and what does each optimize for?

**QB5.** How do you A/B test or roll out a change to the OT transform logic or the calc engine without corrupting live documents mid-session?

**QB6.** Migrating the collaboration model (e.g. OT → CRDT, or a schema change to the op format) across billions of existing documents — how do you do it without downtime or data loss?
