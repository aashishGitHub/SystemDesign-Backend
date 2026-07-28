# System Design: Collaborative Editing (Google Sheets / Docs)

> **Target:** Senior / Staff engineers (Google, Meta, Atlassian, Notion, Figma, and anyone building real-time multiplayer).
> **Style:** Interview-grill format — question first, then defended design choices.
> **Framing:** **Google Sheets** (grid + formulas). Collaborative *text* editing (Google Docs) is the simpler sub-case — the calc plane is what makes Sheets genuinely harder, and it's where senior/staff answers separate from the pack.

---

## How to Use This Guide

1. Skim [simple-diagram.md](./simple-diagram.md) first — it names the **central split** (sync plane vs calc plane) in one screen.
2. Attempt every question in [questions.md](./questions.md) cold before reading answers.
3. Check [answers.md](./answers.md) — compare your reasoning; each answer ends with a **Key takeaway** you can say under pressure.
4. Whiteboard from [diagrams.md](./diagrams.md) — start with Diagram 1 (the two-plane architecture).
5. Go deep with [deep-dive.md](./deep-dive.md) — 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, failure modes, and real-world case notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals & Requirements | Why a spreadsheet is *two* problems (sync + calc), not one |
| 2 | Document Model | Sparse grid, stable cell identities, snapshot + op log |
| 3 | Concurrent Editing | Convergence + intention preservation; OT vs CRDT |
| 4 | The Calculation Engine | Dependency DAG, dirty-mark → topo-sort, cycles, determinism |
| 5 | System Architecture | Single-writer doc-servers, sessions, persistence, scale |
| 6 | Transport & Presence | WebSocket edits vs a separate lossy presence channel |
| 7 | Consistency, History & Undo | Strong eventual consistency, version history, selective undo |
| 8 | Scale & Staff-Level | Huge sheets, access control, multi-region, volatile functions |
| 9 | Frontend Architecture (Architect) | Optimistic OT client, virtualized grid, flaky networks |

---

## Files

| File | Purpose |
|---|---|
| [simple-diagram.md](./simple-diagram.md) | **Start here.** Bare-minimum two-plane model + a detailed version with real services/protocols. |
| [questions.md](./questions.md) | 42 structured questions (9 levels) + 6 bonus. Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table; each ends with a **Key takeaway**; ends with a Quick Revision Cheatsheet. |
| [diagrams.md](./diagrams.md) | 11 Mermaid diagrams (start with Diagram 1 — the two-plane split). |
| [deep-dive.md](./deep-dive.md) | 🟢 Beginner → 🟡 Senior → 🔴 Architect depth, real-world Docs/Sheets/Figma notes, failure modes. |

---

## Problem Statement

> Design a collaborative spreadsheet like Google Sheets. Many users open one document and edit a grid of cells simultaneously; cells hold values or formulas; formulas recompute automatically and correctly; everyone sees each other's changes and cursors in real time; the document has version history and per-user undo; users can edit offline and reconcile later.
>
> **WS   /docs/{id}** — open a document: authz, get snapshot + head revision, then stream ordered ops
> **submit(op, base_rev)** — `setCell`, `insertRow`, `deleteCol`, … → server transforms, orders, ACKs, broadcasts
> **presence(cursor/selection)** — separate ephemeral channel
> **GET  /docs/{id}/history** — browse/restore any past revision
> **POST /docs/{id}/export** — `.xlsx` / `.csv`
>
> **Key Constraints:**
> - **Convergence:** all clients that saw the same ops show identical state.
> - **Intention preservation:** a merge never silently discards a user's edit.
> - **Deterministic recompute:** same cell inputs ⇒ same computed values on every client.
> - **Durability:** no acknowledged edit is ever lost (survive server crash).
> - **Latency:** local edit instant (optimistic); remote edit visible in ~100–200ms.
> - **Scale (order-of-magnitude — verify):** ~10⁸ documents; a live doc has 1–10 (up to ~50) editors; sheets up to ~10⁷ cells; per-doc op rate is *tiny* (~tens/sec).

---

## How a Senior Engineer Thinks About This

The first move is to recognize that a collaborative spreadsheet is **two agreement problems bolted together**, and to say so out loud. The **sync plane** makes everyone agree on the *raw* cells users typed — the classic concurrent-editing problem, solved by Operational Transformation or CRDTs so that edits **converge** and nobody's change is silently lost. The **calc plane** makes everyone agree on the *derived* cells that formulas produce — a dependency DAG that must **reactively recompute** the affected cells, in the right order, and land on the same numbers everywhere. A collaborative text editor (Google Docs) has only the sync plane; naming the calc plane, and keeping the two conceptually separate, is the single highest-signal thing a candidate does here. You never merge computed outputs — you merge inputs on the sync plane and *recompute* outputs on the calc plane.

The second insight is that the two planes collide at one specific, brutal place: **structural operations**. Inserting or deleting a row or column shifts every cell address *and* rewrites every formula reference below it — in both planes at once. This is what makes Sheets fundamentally harder than Docs, where an edit only ever perturbs a 1-D character position. The senior answer is **stable row/column identities** (address a cell by `(row_id, col_id)`, not by its display coordinates) plus explicit transform rules for references that start-before, end-inside, or span the insert boundary. This is exactly where naive implementations produce a *plausible wrong number* — a silent data-integrity bug that's worse than a crash — so it deserves property-based convergence tests, not hand-waving.

The third idea is that the scaling shape is **unusual**, and getting it right signals real experience. Most real-time systems (chat, feeds, location) are throughput problems — enormous op rates over mostly stateless workers. Collaborative editing is the opposite: per-document op rate is tiny (tens/sec even for a busy doc), but each document is a **small, stateful, latency-sensitive session** that must live in memory to be sequenced and recomputed. So you scale *across* documents, not within one: **stateless gateways** route by `doc_id` to **stateful doc-servers**, each the **single writer** for the documents it owns. A single in-memory owner turns op ordering into a trivial append — no per-op consensus, no clock sync — and recompute needs the whole sheet in one place anyway. Idle documents flush a snapshot and unload, so live memory scales with *active* documents, not the 10⁸ total.

Finally, a senior candidate defends the guarantees precisely and knows where they break. Durability comes from one rule — **append the op to the log before you ACK it** — so a crash can lose only edits that were never acknowledged, which clients simply resubmit idempotently. Safety of the single-writer model under a network partition comes from a **lease plus a fencing token**: storage rejects appends from a stale ownership epoch, so a partitioned old owner physically cannot double-write an unmergeable log (the [consensus](../consensus/) leader-lease pattern). Consistency across clients is **strong eventual consistency with a per-document total order** and read-your-own-writes. And because clients recompute optimistically for instant feedback while the server recomputes authoritatively, the calc engine must be **deterministic** — identical function semantics, IEEE-754 floating-point, locale-independence, and server-resolved volatile/external inputs (`NOW()`, `RAND()`, `IMPORTRANGE`) — or collaborators watch their numbers flicker and correct themselves.

---

## Related Topics

This topic sits at the intersection of several patterns already in this repo — it reuses their depth rather than duplicating it:

- **[consensus](../consensus/)** — total order, leader election, **leases + fencing tokens** for single-writer safety, keeping agreement off the hot path. *The "who decides op order, safely" half.*
- **[communication-protocols](../communication-protocols/)** / **[chat-system](../chat-system/)** / **[sse](../sse/)** — WebSocket vs SSE vs polling, delivery guarantees, session affinity at scale, presence. *The real-time transport half.*
- **[storage-engines](../storage-engines/)** — WAL + checkpoint/snapshot + compaction; the exact durability pattern the op log uses.
- **[file-storage](../file-storage/)** — snapshot + delta, versioning, conflict resolution on sync; the document-persistence cousin.
- **[distributed-caching](../distributed-caching/)** — hot in-memory doc state, eviction of idle documents.
- **[ride-sharing](../ride-sharing/)** — WebSocket session affinity and hot-vs-durable state separation, reused for doc-server ownership.
- **[distributed-transactions](../distributed-transactions/)** — the multi-writer / global-collaboration tradeoffs when you consider moving off single-writer.

> **Note on accuracy:** OT/CRDT theory here is standard and checkable. Specific claims about how Google Docs/Sheets or Figma implement collaboration internally are hedged and marked "verify" — treat them as informed illustration, not authoritative internals.
