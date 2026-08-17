# Revision Sheet Spec — Compressing a Topic Folder into `<topic>-v2.md`

> **Purpose:** turn a finished `interviews/<topic>/` folder into **one file you can read in 10 minutes** on the morning of the interview.
>
> **This is not** [`instructions-simplified.md`](./instructions-simplified.md). That spec *builds* a folder. This one *compresses* one you already built.
>
> **Exemplars:** [`patterns/scaling-reads-v2.md`](../patterns/scaling-reads-v2.md) · [`patterns/scaling-writes-v2.md`](../patterns/scaling-writes-v2.md).
> **Inherits:** house style, Tier D diagram rules, and the accuracy rules from [`instructions-simplified.md`](./instructions-simplified.md). Nothing here overrides them.

---

## 0. Why this is a separate spec

The two jobs look similar. They aren't.

| | `instructions-simplified.md` | **This spec** |
|---|---|---|
| Input | Someone else's doc, or nothing | **Our own folder**, 1–3k lines |
| Output | A 7-file folder | **One file** |
| Reader | Learning the topic over weeks | Revising it in 10 minutes |
| Goal | Complete and teachable | Sayable and drawable |
| New facts allowed? | Yes — you're researching | **No.** See §1 |

`instructions-simplified.md` §3 compresses an *external source* into a folder. This spec compresses *the folder* into a sheet. Same instinct, different direction.

---

## 1. The contract

**Input:** a topic folder that already passes `instructions-simplified.md`.

**Output:** exactly one file — `interviews/<topic>/<topic>-v2.md`. Same folder, beside the others.

Four hard rules:

1. **The `-v2` file contains no new facts.** Every claim already exists in v1. If you learn something while writing it, **fix v1 first**, then pull it forward. Two files disagreeing is worse than one file being long.
2. **Every section links back** — `→ [v1 §N](./answers.md#…)` or the relevant file. The sheet is an index as well as a summary.
3. **Budget: 400–550 lines.** Over 600 means you reformatted instead of compressing.
4. **It must stand alone.** If you need a second file open in the room, it failed.

**Naming:** `<topic>-v2.md`, matching the `patterns/` convention (`scaling-reads-v2.md`).

---

## 2. The folder compression worksheet

Fill this in before writing. It decides the whole file.

```text
TOPIC:          <name>
SOURCE FOLDER:  interviews/<topic>/   (___ lines across ___ files)
CENTRAL SPLIT:  <one sentence — lift it from v1's README, don't reinvent it>

EXPLAIN (6–10 — each gets a section, most get a Tier D diagram)
  1. …

NAME ONLY (the word, one sentence, no mechanics)
  - …

CUT (say where it went — v1 keeps it, you're not deleting anything)
  - …

DIAGRAMS TO KEEP (of v1's N, which survive? usually 6–8)
  - Diagram 1 always. Then the ones that carry a hard part.

IMAGES TO WIRE IN (see §5)
  - <file>.jpg → which section

FAILURE STORIES (naive → the number that breaks it → the fix)
  1. …

THE QUESTIONS THAT MATTER (of v1's N, pick 8)
  - the ones an interviewer actually asks

COVERAGE CHECK (every v1 top-level section appears somewhere)
  [ ] …  [ ] …  [ ] …
```

Two tripwires, same as the parent spec:

- **EXPLAIN over 10 rows** → you haven't compressed.
- **CUT empty** → you haven't read v1 properly.

**Coverage check is the important one.** Thin is fine. Missing is not. You must never discover mid-interview that a whole subsystem was left out of your notes.

---

## 3. Required structure of `<topic>-v2.md`

In this order. Both exemplars follow it exactly.

### 1. Header

> Paths in the templates below are relative to `interviews/<topic>/`, where the file lives — not to `docs/`.

```markdown
# <Topic> — Quick Revision

> **What this is:** the 10-minute version. Built for the morning of the interview.
> **Deep version:** [`README.md`](./README.md) — every section here links back.
> **Script to read aloud:** [`diagrams.md`](./diagrams.md) — the **🎤 30-Minute Interview Transcript** at the very end.
> **Interviewer signal:** "…" · "…" · "…"
```

Link the *file*, not a `#anchor` — the transcript heading starts with an emoji, and renderers disagree on how to slug that. If the topic has no transcript yet, write it before you link to it (§6).

Then two or three short sentences on why the topic is hard. Not a summary — the *shape* of the difficulty.

### 2. The one-sentence split
A `## The one-sentence split` heading, then the split in bold, then two or three lines on why it's the split. Lift it from v1's README. Don't reinvent it.

Optionally a small contrast table if the split is a versus (reads vs writes, sync vs calc).

### 3. Diagram 1 — the split
The only diagram that gets the full treatment:
- Tier D mermaid (≤ 9 boxes, ≤ 12 arrows)
- **The pen version** — ASCII
- **Draw order** — numbered strokes
- **Say while drawing** — one spoken line per stroke, ≤ 12 words each

### 4. Body sections — 6 to 10
One per EXPLAIN row. Each is:
- A plain heading naming the thing
- Short prose. House-style sentences
- **One** table, diagram, or code block. Not all three
- A `→ [v1 §N](…)` link at the end

Give roughly half of them a diagram. Mix flowchart / sequence / state.

### 5. The decision tree
An ASCII tree. Where the reader lands when the interviewer says "so what would you do?"

### 6. `<Topic> in an Interview`
Required. Three sub-sections:

```markdown
### When to reach for this
- trigger phrases an interviewer says

### Where it breaks down
| Limit | What you say instead |

### The five sentences that score
1. …  ← ≤ 15 words each, the exact words
```

### 7. Real systems
A 4–6 row table. `| Case | What's done | Lesson |`. Plus the hedge line that these are directional, not verified internals.

### 8. The eight questions, answered in one breath
Pick 8 from v1. Two to three sentences each — the *spoken* answer, not the essay.

Open with a collapsed pointer to the full versions:

```markdown
<details>
<summary>🔴 <b>deep-dive</b> — full answers to all N questions live in answers.md</summary>
…one line pointing at v1…
</details>

```

### 9. Cheat sheet
`| Term | One line |`. 25–35 rows. This is the last thing you read before walking in.

### 10. Related
Full-depth link, sibling patterns, related topics.

---

## 4. What good compression looks like

Measured from the two finished exemplars:

| | v1 | v2 | Kept |
|---|---|---|---|
| `scaling-reads` | 589 lines | 553 | 8 diagrams, 8 of 12 questions |
| `scaling-writes` | 525 lines | 508 | 8 diagrams, 8 of 11 questions |

Note the line counts barely move. **Compression here is not about length — it's about what each line does.**

v1 lines explain. v2 lines are things you say, draw, or look up. A v2 file that's half the length but still written as prose has missed the point.

For an `interviews/` topic the ratio is steeper, because a folder is 5–10× a pattern file:

| | v1 folder | v2 target |
|---|---|---|
| `collaborative-editing` | 2,328 lines / 8 files | ~500 lines / 1 file |

---

## 5. Images — index and wiring

**Location:** `interviews/<topic>/images/`. Leave existing files where they are.

**The rule that matters:** an image not referenced by any markdown file does not exist. As of this spec, every image in the repo is an orphan. Fix that when you compress a topic.

**Embed at the point of use:**

```markdown
![Two-plane architecture](images/two_plane_architecture.jpg)
```

**Every `-v2.md` with images carries an index**, near the end:

```markdown
## Image index

| Image | Shows | Section |
|---|---|---|
| `two_plane_architecture.jpg` | Sync plane vs calc plane | The one-sentence split |
| `structural_edit_reference_shift.jpg` | Row insert shifting refs | The signature hard problem |
```

**Images never replace a Tier D diagram.** A rendered JPG can't be drawn with a pen, so it can't be the thing you learn from. The mermaid diagram is what you memorize. The image is the polished version for reading. If a section has an image and no diagram, add the diagram.

Naming: `snake_case.jpg`, describing the content, not the position. `two_plane_architecture.jpg`, never `diagram1.jpg`.

---

## 6. The spoken script

**It stays where it is:** `diagrams.md`, per [`instructions-simplified.md` §5.2](./instructions-simplified.md#52-optional--the-30-minute-spoken-transcript). Don't move it, don't duplicate it into `-v2.md`.

Two changes to how §5.2 is applied:

**1. It is required for any topic you compress.** If a topic is worth a `-v2.md`, you're rehearsing it, and §5.2's "optional" no longer applies.

**2. Write it at Senior/Principal register.** §5.2 gives the timing structure. The register is what separates a senior transcript from a mid-level one:

| Move | Mid-level says | Senior / Principal says |
|---|---|---|
| **Scope out loud** | starts drawing | "I'll assume a single region and skip auth. Tell me if you'd rather I cover those." |
| **Lead with the tradeoff** | "I'll use Redis here." | "I'm trading freshness for latency here. That's fine for browse, not for checkout." |
| **Name what you defer** | silently omits it | "I'm deliberately not sharding yet. Let me come back to it if the numbers demand it." |
| **Own the risk** | describes the happy path | "The thing that worries me is a cold cache. Here's how I'd detect it before users do." |
| **Cost and operations** | correctness only | "This doubles write cost. At our volume that's the cheaper half of the tradeoff." |
| **Invite challenge** | defends every choice | "Push back if you'd cut it differently — I can defend either." |

The register rule in one line: **a senior narrates decisions, not components.** Every box you draw gets a *because*.

Keep §5.2's other rules — first person, short sentences, one spoken line per numbered edge of the master diagram, numbers reused rather than re-derived.

---

## 7. Checklist

```text
BEFORE WRITING
[ ] Filled the §2 worksheet
[ ] Central split lifted verbatim from v1's README — not reinvented
[ ] EXPLAIN is 6–10 rows; CUT is non-empty
[ ] Picked which of v1's diagrams survive (usually 6–8)
[ ] Listed which images map to which section

STRUCTURE
[ ] All ten sections of §3, in order
[ ] Header links: deep version + the diagrams.md script
[ ] Diagram 1 has pen version + draw order + say-while-drawing
[ ] Every body section ends with a → v1 link
[ ] Decision tree present
[ ] "<Topic> in an Interview": when / where it breaks / five sentences
[ ] Eight questions, two-to-three sentences each
[ ] Cheat sheet, 25–35 rows

CORRECTNESS
[ ] NO new facts — every claim traceable to v1
[ ] COVERAGE: every v1 top-level section appears somewhere
[ ] All Tier D limits hold (≤9 boxes, ≤12 arrows, no colour dependency)
[ ] Every mermaid block renders (preview or mmdc)
[ ] Every → v1 anchor resolves
[ ] Every image embedded and listed in the image index
[ ] 400–550 lines

FINISH
[ ] diagrams.md has a §5.2 transcript, at Senior/Principal register (§6)
[ ] Read the whole file aloud. Nothing made me stumble
```

---

## 8. Worked example — `collaborative-editing`

The heaviest topic in the repo, and the reason this spec exists.

```text
TOPIC:          collaborative-editing (Google Sheets)
SOURCE FOLDER:  2,328 lines / 8 files. answers.md alone is 987.
CENTRAL SPLIT:  A spreadsheet is two agreement problems bolted together —
                the SYNC plane agrees on what users typed, the CALC plane
                agrees on what formulas produced.

EXPLAIN (8)
  1. The two planes                     ← Diagram 1, the split
  2. Document model: sparse grid, snapshot + op log
  3. Convergence: OT vs CRDT
  4. Structural ops — the signature hard problem
  5. The calc engine: dirty-mark → topo-sort
  6. Single-writer doc-servers, and why the scaling shape is unusual
  7. Lease + fencing — single-writer safety
  8. Two channels: durable edits vs lossy presence

NAME ONLY
  - Volatile functions (NOW, RAND, IMPORTRANGE) — server-resolved
  - Selective undo
  - Virtualized grid rendering
  - IEEE-754 determinism

CUT (stays in v1)
  - Level 9 frontend architecture in full   → deep-dive.md
  - The 6 bonus questions                   → questions.md
  - system-design-concepts.md overlap        → duplicate of deep-dive
  - Per-level question numbering             → questions.md

DIAGRAMS TO KEEP (of v1's 11)
  1 two-plane · 3 OT loop · 4 structural shift · 5 calc DAG
  · 7 at scale · 9 lease+fencing · 11 two channels     (7 total)

IMAGES TO WIRE IN (all 10 currently orphaned)
  two_plane_architecture.jpg        → the split
  sparse_grid_data_model.jpg        → document model
  snapshot_and_op_log.jpg           → persistence
  ot_vs_crdt_comparison.jpg         → convergence
  ot_client_server_loop.jpg         → convergence
  structural_edit_reference_shift.jpg → the hard problem
  dependency_dag_recompute.jpg      → calc engine
  system_architecture_scale.jpg     → architecture
  single_writer_lease_fencing.jpg   → safety
  two_channel_transport.jpg         → transport

FAILURE STORIES
  1. Address cells by (row, col) → someone inserts a row → every formula
     below points at the wrong cell → address by stable (row_id, col_id)
  2. Old owner is partitioned, not dead → two writers append to one log →
     lease + fencing token, storage rejects the stale epoch
  3. ACK before the log append → server crashes → an acknowledged edit is
     gone → append first, then ACK; clients resubmit idempotently

COVERAGE CHECK (v1's 9 levels)
  [x] L1 fundamentals   [x] L2 doc model    [x] L3 convergence
  [x] L4 calc engine    [x] L5 architecture [x] L6 transport
  [x] L7 consistency    [x] L8 scale        [x] L9 frontend (thin — named only)
```

**Gaps found while compressing this one — all now closed:**

| Gap | Resolution |
|---|---|
| `diagrams.md` had the master diagram but no transcript | Written, at Senior/Principal register (§6) |
| All 10 images orphaned | Embedded at point of use + an image index in the `-v2` |
| `table.md` empty (0 bytes) and unlinked | Deleted |
| `system-design-concepts.md` unlinked | Kept — it carries comparison matrices `deep-dive.md` doesn't — and linked from the README Files table |

**Result:** [`collaborative-editing-v2.md`](../interviews/collaborative-editing/collaborative-editing-v2.md) — 460 lines from 2,328, 7 Tier D diagrams, all 10 images wired, 8 of 42 questions.

**If you only remember one thing about this topic:** you never merge computed outputs. You merge inputs on the sync plane, then recompute outputs on the calc plane.

---

## 9. Related

- [`instructions-simplified.md`](./instructions-simplified.md) — how to build the folder this spec compresses
- [`RADIO_FRAMEWORK.md`](./RADIO_FRAMEWORK.md) — how to perform in the room; §5.2's timing comes from here
- [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md) — primitive → AWS → native vocabulary
- Exemplars: [`patterns/scaling-reads-v2.md`](../patterns/scaling-reads-v2.md) · [`patterns/scaling-writes-v2.md`](../patterns/scaling-writes-v2.md)
