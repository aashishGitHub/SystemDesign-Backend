# Topic Authoring Guide — How to Build an `interviews/<topic>/` Folder

> **Purpose:** a repeatable spec for writing a new system-design topic so every folder looks, reads, and teaches the same way.
> **Canonical exemplar:** [`interviews/video-streaming/`](../interviews/video-streaming/). Second reference: [`interviews/ride-sharing/`](../interviews/ride-sharing/).
> **Audience of the content:** Senior / Staff backend engineers prepping HLD + system-design interviews.

---

## 0. The one rule that matters most

**Find the topic's central split (its organizing insight) and lead with it.** Every strong topic hangs off one mental model that everything else clips onto:

| Topic | Central split you lead with |
|---|---|
| Video streaming | **Write path** (upload→transcode→store, async, throughput-bound) vs **read path** (play→CDN→viewer, latency-bound) |
| Ride sharing | **Three planes**: location ingest (write-heavy, ephemeral) · matching (latency-bound) · trip+tracking (durable + real-time) |
| KV store | Consistency/availability tradeoff + partitioning + replication |
| Storage engines | LSM-tree (write-optimized) vs B-tree (read-optimized) — the RUM conjecture |

If you can't name the split in one sentence, you're not ready to write the folder yet. Diagram 1 and the simple-diagram both *are* that split.

---

## 1. Folder anatomy

Every topic folder contains these files (create in this order):

| Order | File | Purpose | Required? |
|---|---|---|---|
| 1 | `README.md` | Front door: target level, how-to-use, learning path, problem statement, "how a senior thinks". | ✅ |
| 2 | `simple-diagram.md` | Bare-minimum mental model + a detailed version with concrete services/protocols. | ✅ |
| 3 | `questions.md` | Leveled, question-first interview grill (L1→L8 + bonus). | ✅ |
| 4 | `answers.md` | One answer per question, each with a table **or** code + a **Key takeaway** line; ends with a cheat sheet. | ✅ |
| 5 | `diagrams.md` | 8–12 interview-ready Mermaid diagrams, each mapped to questions. | ✅ |
| 6 | `deep-dive.md` | Beginner → Senior → Architect depth, failure modes, real-world examples. | ✅ |
| 7 | `conducive-sentences.md` | Plain-English prose retelling of every answer, each section bridging to the next. | optional |

Then update [`interviews/ROADMAP.md`](../interviews/ROADMAP.md): dashboard counts, the topic's status line, and the quick-reference table.

---

## 2. File-by-file spec

### `README.md`
Sections, in order:
1. **Title** — `# System Design: <Topic> (<Real-world examples>)`.
2. **Target + Style** blockquote — who it's for; "Interview-grill format — question first, then defended choices."
3. **How to Use This Guide** — numbered steps that name every file (start with `simple-diagram.md`, attempt `questions.md` cold, check `answers.md`, whiteboard with `diagrams.md`, go deep with `deep-dive.md`).
4. **Learning Path** table — `| Level | Topic | You'll Learn |` matching the question levels.
5. **Files** table — one row per file with a one-line purpose. Mark the start-here file.
6. **Problem Statement** blockquote — the ask + a bulleted **Key Constraints** list with real numbers (scale, latency SLA, availability, durability).
7. **How a Senior Engineer Thinks About This** — 2–4 prose paragraphs that walk the central split and the top 2–3 insights. This is the highest-signal section; write it last, after the answers exist.

### `simple-diagram.md`
Two diagrams, plainest first:
1. **Simple mental model** — a `flowchart` with only the essential boxes, numbered edges telling the story. Follow with:
   - **"The N components to remember"** table (`| Component | Job (one line) |`).
   - **"The one idea that ties it together"** — a single bold paragraph stating the central split.
2. **Detailed diagram** — same flows, now labeled with concrete services (name real tech) and a note that these are *defensible* picks, not gospel. Follow with:
   - A **service cheat-sheet** table (`| Concept | Service | One-line why |`).
   - A **protocols worth naming** bullet list.

### `questions.md`
- Header blockquote: "Attempt all questions before reading answers.md · work level-by-level · speak answers aloud."
- **8 levels**, each `## Level N — <Name>` with an italic *Goal:* line. Level 1 = fundamentals, Level 8 = architect/staff.
- Questions numbered `**Q1.**`, `**Q2.**`… continuously across levels.
- Include **failure-mode questions** (`*(Failure mode)*` or a dedicated failure-mode Q per level) — "X crashes at 2 AM, what do users see and what's your response?"
- End with **Bonus — questions a senior raises unprompted** (`**QB1.**`…) — the ownership-signal questions.

### `answers.md`
- Header: "Keyed to questions.md. Each answer includes either code or a comparison table."
- One `### AN. <short title>` per question, **same numbering as questions.md**.
- Every answer has **a comparison table or a code/pseudocode block** (prefer a table for tradeoffs, code for mechanics) — never prose-only.
- Every answer ends with a bold **Key takeaway:** one-sentence line — the thing to remember under pressure.
- Ends with a **⚡ Quick Revision Cheatsheet** containing four sub-sections:
  - **Scale numbers** (back-of-envelope, with the math shown)
  - **Key technology choices** (`| Component | Choice | Why |`)
  - **Canonical tradeoffs to memorize** (bulleted `A vs B: upside vs upside`)
  - **Common interview mistakes to avoid** (bulleted)

### `diagrams.md`
- Header with a "start with Diagram 1" note + a **Reference** line linking `answers.md`/`simple-diagram.md` + a **Cross-links** line to related topic folders.
- **8–12 diagrams.** Diagram 1 is always the central split. Each diagram block is:
  1. `## Diagram N — <Title>`
  2. A `> **When to use:**` blockquote naming the exact question numbers it serves.
  3. The ```mermaid block.
  4. A **What the interviewer is checking:** bullet list (3–4 bullets on the *signal*, not just the content).
- Mix diagram types to fit the content: `flowchart` for architecture/dataflow, `sequenceDiagram` for protocols/handshakes/offer-loops, `stateDiagram-v2` for lifecycles/state machines.
- End with a **Quick Interview Reference**: scale-numbers table, a domain quick-ref table, canonical tradeoffs, common mistakes.

### `deep-dive.md`
- Beginner → Senior → Architect progression using depth tiers 🟢 (fundamentals) / 🟡 (senior) / 🔴 (staff/architect).
- Real-world implementations, quantified failure modes, production tradeoffs, and a closing cheat sheet.

---

## 3. Mermaid conventions

Keep diagrams renderable and consistent.

**Node shapes:** `["box"]` service/process · `[("cylinder")]` datastore · `{"diamond"}` decision · `{{"hexagon"}}` event/topic · `[["subroutine"]]` queue/stream/bus · `(["stadium"])` external actor.

**Color palette** (via `style NODE fill:#hex,stroke:#hex`) — use meaning, not decoration:

| Meaning | fill | stroke |
|---|---|---|
| Write / throughput / async | `#fed7aa` | `#ea580c` |
| Read / fast / good outcome | `#dcfce7` | `#16a34a` |
| Decision / cache / hot-path gate | `#fef9c3` | `#ca8a04` |
| Failure / danger / hot data | `#fee2e2` | `#dc2626` |
| Durable store / database | `#dbeafe` | `#1d4ed8` |
| Callout / note | `#e0e7ff` | `#4338ca` |

**Gotchas that break rendering:**
- Put multi-line and special-character labels in **quotes**: `NODE["line one<br/>line two"]`.
- Use `<br/>` for line breaks inside quoted labels.
- Escape `>` as `&gt;` inside labels (e.g. `"speed &gt; 50 m/s?"`) so it doesn't close a `{}`/shape.
- In `subgraph NAME["Label"]`, set `direction TB` on the first line inside.
- Don't use `end` as a node id (reserved).
- `stateDiagram-v2` transition labels are single-line free text after the colon — no `<br/>`.

---

## 4. Accuracy rules (non-negotiable — these govern all content)

1. **Flag uncertainty.** "I am not certain, but…" / "verify against current docs." Never state a guess as fact.
2. **No invented sources.** No fake paper titles, authors, URLs, or blog references. If you can't name a verifiable source, say so.
3. **Label statistics.** Prefix estimates with "approximately"; explicitly mark capacity-planning figures (e.g. "~50K sockets/server") as order-of-magnitude planning numbers to verify, not hard limits.
4. **No invented APIs.** Don't fabricate function/library/command names. If unsure a call exists, say "verify in current docs" (e.g. note when a command like Redis `GEORADIUS` is legacy vs `GEOSEARCH`).
5. **Vendor claims must be verifiable.** OK: "Uber open-sourced H3," "Netflix Open Connect embeds servers in ISPs." Avoid internal codenames you can't confirm. Keep examples generic (Dynamo/Spanner/Cassandra/FAANG) unless a specific claim is verifiable.
6. **Numbers derive from the stated problem constraints** where possible (e.g. "1M drivers ÷ 4s = 250K writes/s"), so the math is checkable rather than asserted.

When honesty and helpfulness conflict, choose honesty.

---

## 5. New-topic checklist

Copy this into a scratch note when starting a topic:

```text
[ ] Named the central split in one sentence (drives Diagram 1 + simple-diagram + README senior section)
[ ] Pulled real constraints (scale, latency SLA, availability, durability) into the problem statement
[ ] questions.md: 8 levels, continuous Q-numbering, italic level goals, failure-mode Qs, bonus QBs
[ ] answers.md: every Q answered, each with table OR code, each ends with **Key takeaway**
[ ] answers.md: ⚡ cheat sheet (scale numbers · tech choices · tradeoffs · mistakes)
[ ] simple-diagram.md: simple model + components table + "one idea" + detailed model + service cheat-sheet + protocols
[ ] diagrams.md: Diagram 1 = the split; 8–12 diagrams; each has "when to use" (Q refs) + "what interviewer checks"; ends with Quick Interview Reference
[ ] diagrams.md: mermaid colors carry meaning; labels quoted; `>` escaped; renders cleanly (preview it)
[ ] deep-dive.md: 🟢🟡🔴 depth tiers, failure modes, real examples
[ ] README.md: how-to-use names every file; files table; learning path; senior-thinking section written LAST
[ ] Cross-links added between related topic folders
[ ] ROADMAP.md updated (dashboard counts + status line + quick-ref row)
[ ] Accuracy pass: hedged uncertain numbers, no invented sources/APIs, vendor claims verifiable
```

---

## 6. Quality bar (self-review before calling it done)

- **Can a candidate whiteboard the whole system from `diagrams.md` alone?** If not, a diagram is missing.
- **Does every answer give something defensible to *say*, not just facts to know?** The Key takeaway is that sentence.
- **Is the central split obvious within the first screen of the README and Diagram 1?**
- **Would the accuracy rules survive a fact-check?** No unverifiable numbers stated as fact, no invented citations.
- **Do the failure-mode questions have real incident-response answers**, not hand-waving?

---

## 7. Order of operations (recommended)

1. Draft `questions.md` (defines scope and levels).
2. Write `simple-diagram.md` (forces you to name the central split).
3. Write `answers.md` (the substance; Key takeaways crystallize each point).
4. Write `diagrams.md` (visualize what the answers describe; Diagram 1 = the split).
5. Write `deep-dive.md` (depth beyond the happy path).
6. Write `README.md` last — especially "How a Senior Engineer Thinks," which is a summary of everything above.
7. (Optional) `conducive-sentences.md` prose pass.
8. Update `ROADMAP.md` + cross-links. Accuracy pass. Preview all Mermaid.
