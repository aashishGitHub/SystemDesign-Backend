# Topic Authoring Guide — How to Build an `interviews/<topic>/` Folder

> **Purpose:** a repeatable spec for writing a new system-design topic so every folder looks, reads, and teaches the same way.
> **Canonical exemplar:** [`interviews/video-streaming/`](../interviews/video-streaming/). Second reference: [`interviews/ride-sharing/`](../interviews/ride-sharing/).
> **Audience of the content:** Senior / Staff backend engineers prepping HLD + system-design interviews.
> **Companions:** [`RADIO_FRAMEWORK.md`](./RADIO_FRAMEWORK.md) — how to *perform* in the room · [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md) — the primitive→AWS→native mapping every topic must use · [`../patterns/README.md`](../patterns/README.md) — the reusable sub-problems every topic must declare.

---

## 0. The three rules that matter most

### Rule 1 — Lead with the central split

**Find the topic's central split (its organizing insight) and lead with it.** Every strong topic hangs off one mental model that everything else clips onto:

| Topic | Central split you lead with |
|---|---|
| Video streaming | **Write path** (upload→transcode→store, async, throughput-bound) vs **read path** (play→CDN→viewer, latency-bound) |
| Ride sharing | **Three planes**: location ingest (write-heavy, ephemeral) · matching (latency-bound) · trip+tracking (durable + real-time) |
| KV store | Consistency/availability tradeoff + partitioning + replication |
| Storage engines | LSM-tree (write-optimized) vs B-tree (read-optimized) — the RUM conjecture |

If you can't name the split in one sentence, you're not ready to write the folder yet. Diagram 1 and the simple-diagram both *are* that split.

### Rule 2 — Name the patterns; don't re-explain them

Every topic is an assembly of [`patterns/`](../patterns/README.md) — recurring sub-problems that already have their own write-ups. The folder must **declare which patterns it uses and link into them**, rather than re-deriving the same ladder for the fifth time.

- The README carries a **Patterns in play** table (see §2).
- Answers that hit a pattern link to the exact pattern section instead of duplicating it — e.g. *"this is rung 1 of the contention ladder — a conditional write,"* linking `[contention ladder](../../patterns/dealing-with-contention.md#4-rung-1-conditional--atomic-writes)` (paths in this guide's examples are written **relative to `interviews/<topic>/`**, which is where they'll live).
- If the topic needs a recurring sub-problem that **isn't** in `patterns/` yet, add it to the gap list in [`patterns/README.md`](../patterns/README.md#gaps--recurring-sub-problems-not-yet-written-up) rather than burying the only copy of that reasoning inside one topic.

**Convention, repo-wide: cross-link, don't duplicate.** Concept depth lives in `fundamentals/`, sub-problem depth in `patterns/`, system depth in `interviews/`.

### Rule 3 — Every tech choice is primitive → AWS → native

The repo is **AWS-annotated, not AWS-only**. For each component you name, state three things in this order:

```
1. the PRIMITIVE   — the property you actually need, and the number that forces it
2. the AWS SERVICE — the managed implementation (this is the fluency signal)
3. the NATIVE/OSS  — the swap, which proves it isn't a lock-in decision
```

> *"I need an at-least-once work queue with a visibility timeout and a DLQ, because a transcode takes ~4 min and a worker crash must not lose the job. On AWS that's SQS; self-hosted it's RabbitMQ, or Kafka if I also need replay."*

Full mapping tables, per-service gotchas, and the "what AWS does *not* give you" list live in [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md). Pull from there rather than inventing a new table per topic. Primitive-first ordering is deliberate: it keeps the same sentence usable in a Google or Meta interview, where an AWS catalog scores nothing.

---

## 1. Folder anatomy

Every topic folder contains these files (create in this order):

| Order | File | Purpose | Required? |
|---|---|---|---|
| 1 | `README.md` | Front door: target level, how-to-use, learning path, problem statement, "how a senior thinks". | ✅ |
| 2 | `simple-diagram.md` | Bare-minimum mental model + a detailed version with concrete services/protocols. | ✅ |
| 3 | `questions.md` | Leveled, question-first interview grill (L1→L8 + bonus). | ✅ |
| 4 | `answers.md` | One answer per question, each with a table **or** code + a **Key takeaway** line; ends with a cheat sheet. | ✅ |
| 5 | `diagrams.md` | 8–12 interview-ready Mermaid diagrams, each mapped to questions — **plus the one-page master diagram as the final section** (§2.1). | ✅ |
| 6 | `deep-dive.md` | Beginner → Senior → Architect depth, failure modes, real-world examples. | ✅ |
| 7 | `conducive-sentences.md` | Plain-English prose retelling of every answer, each section bridging to the next. | optional |

Then update [`interviews/ROADMAP.md`](../interviews/ROADMAP.md): dashboard counts, the topic's status line, and the quick-reference table. Also update the reverse index in [`patterns/README.md`](../patterns/README.md) with a row for the new topic.

**Where each layer's depth belongs** (so files don't duplicate each other):

```
fundamentals/<concept>.md   one concept, 2 min          quorum, lease, fencing, WAL, Bloom filter
patterns/<sub-problem>.md   one recurring sub-problem   contention ladder, saga, scaling reads
interviews/<topic>/         one whole system            ← THIS SPEC
docs/AWS_SERVICE_MAP.md     primitive → AWS → native    the shared tech vocabulary
docs/RADIO_FRAMEWORK.md     how to perform in the room  R·A·D·I·O timeboxing + estimation
```

---

## 2. File-by-file spec

### `README.md`
Sections, in order:
1. **Title** — `# System Design: <Topic> (<Real-world examples>)`.
2. **Target + Style** blockquote — who it's for; "Interview-grill format — question first, then defended choices."
3. **How to Use This Guide** — numbered steps that name every file (start with `simple-diagram.md`, attempt `questions.md` cold, check `answers.md`, whiteboard with `diagrams.md`, go deep with `deep-dive.md`, and **revise from the one-page master diagram** at the end of `diagrams.md`).
4. **Learning Path** table — `| Level | Topic | You'll Learn |` matching the question levels.
5. **Files** table — one row per file with a one-line purpose. Mark the start-here file.
6. **Problem Statement** blockquote — the ask + a bulleted **Key Constraints** list with real numbers (scale, latency SLA, availability, durability).
7. **Patterns in play** table — which [`patterns/`](../patterns/README.md) this topic assembles, marking **●** central / **○** present, each linking to the pattern file *and* to the levels/questions where it appears. Keep it consistent with the reverse index in `patterns/README.md`:

   ```markdown
   | Pattern | Role | Where it shows up here |
   |---|---|---|
   | [Dealing with Contention](../../patterns/dealing-with-contention.md) | ● central | L4 Q18–Q24 — the no-oversell guard |
   | [Multi-Step Processes](../../patterns/multi-step-processes.md) | ● central | L5 Q25–Q31 — fulfillment saga + outbox |
   | [Scaling Reads](../../patterns/scaling-reads.md) | ○ present | L3 Q12–Q17 — browse path caching |
   ```
8. **How a Senior Engineer Thinks About This** — 2–4 prose paragraphs that walk the central split and the top 2–3 insights. This is the highest-signal section; write it last, after the answers exist.

### `simple-diagram.md`
Two diagrams, plainest first:
1. **Simple mental model** — a `flowchart` with only the essential boxes, numbered edges telling the story. Follow with:
   - **"The N components to remember"** table (`| Component | Job (one line) |`).
   - **"The one idea that ties it together"** — a single bold paragraph stating the central split.
2. **Detailed diagram** — same flows, now labeled with concrete services (name real tech) and a note that these are *defensible* picks, not gospel. Follow with:
   - A **service cheat-sheet** table — **four columns, primitive first** (see Rule 3 in §0). Exemplar: [`interviews/video-streaming/simple-diagram.md`](../interviews/video-streaming/simple-diagram.md).

     ```markdown
     | Concept | Primitive (say this first) | AWS service | Native / OSS | One-line why |
     |---|---|---|---|---|
     | Big-file upload | resumable multipart upload, bytes bypass the API | **S3 Multipart + presigned URL** | MinIO | Parallel parts; app server out of the data path |
     | Work queues | at-least-once queue, per-message retry + DLQ | **SQS** (one per job type) | RabbitMQ | Small failure unit, one poison job can't block others |
     ```

     Do **not** invent a new mapping table per topic — pull rows from [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md) so the vocabulary stays consistent, and add any genuinely new row back into that file.
   - An **AWS gotchas for this topic** bullet list (2–5 items) — the quota/failure-mode traps for the services just named (e.g. "DynamoDB per-partition write ceiling → write-shard the hot key"; "SQS visibility timeout must exceed p99 job duration"). Pull from `AWS_SERVICE_MAP.md` §3.
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
- When an answer is an instance of a pattern, **link the pattern section rather than re-deriving it** (Rule 2) — `[contention ladder](../../patterns/dealing-with-contention.md#4-rung-1-conditional--atomic-writes)`. The answer keeps the topic-specific part; the general ladder stays in one place.
- Ends with a **⚡ Quick Revision Cheatsheet** containing five sub-sections:
  - **Scale numbers** (back-of-envelope, with the math shown)
  - **Key technology choices** — `| Component | Primitive / why | AWS | Native / OSS |`. The primitive column is the one you say out loud; the last two are the fluency evidence and the anti-lock-in swap.
  - **Patterns used** (one line each, linked — mirrors the README's Patterns-in-play table)
  - **Canonical tradeoffs to memorize** (bulleted `A vs B: upside vs upside`)
  - **Common interview mistakes to avoid** (bulleted, including the topic's AWS traps)

### `diagrams.md`
- Header with a "start with Diagram 1" note + a **Reference** line linking `answers.md`/`simple-diagram.md` + a **Cross-links** line to related topic folders.
- **8–12 diagrams.** Diagram 1 is always the central split. Each diagram block is:
  1. `## Diagram N — <Title>`
  2. A `> **When to use:**` blockquote naming the exact question numbers it serves.
  3. The ```mermaid block.
  4. A **What the interviewer is checking:** bullet list (3–4 bullets on the *signal*, not just the content).
- Mix diagram types to fit the content: `flowchart` for architecture/dataflow, `sequenceDiagram` for protocols/handshakes/offer-loops, `stateDiagram-v2` for lifecycles/state machines.
- Then a **Quick Interview Reference**: scale-numbers table, a domain quick-ref table, canonical tradeoffs, common mistakes.
- **Finally — and this is required — the one-page master diagram.** See §2.1.

---

### §2.1 The One-Page Master Diagram (final section of `diagrams.md`)

**The problem it solves.** The night before an interview you do not want to re-read eleven diagrams, forty answers, and a deep-dive. You want **one artifact that reconstructs the entire topic from a single screen** — the split, the components, the AWS names, the patterns, the numbers, and the two failure modes that carry the signal.

**Rules that make it work:**

1. **One screen, one diagram.** If it doesn't fit on a laptop screen at readable zoom, it's a normal diagram, not the master. Ruthlessly cut anything that isn't load-bearing.
2. **It is a recall harness, not a new diagram.** Every box should be a *pointer* to knowledge you already wrote. Annotate boxes with the AWS service name and the number that justifies it, so the diagram carries its own defence.
3. **Layer it by the central split** — the same split from Rule 1, drawn as subgraphs/lanes so the geometry itself encodes the organizing insight.
4. **Number the flow.** Numbered edges (`1️⃣`/`1.`) that narrate the primary journey end-to-end. A master diagram you can't narrate in 90 seconds is decoration.
5. **Mark the hard parts.** Use the failure/danger palette (`#fee2e2`/`#dc2626`) on the 2–3 boxes where the real difficulty lives, so your eye goes to the deep-dive material first.
6. **Pattern + AWS annotations inline.** Put the pattern name and AWS service on the box or the edge label (e.g. `Hold Service<br/>[contention: rung 1]<br/>ElastiCache SETNX+TTL`).

**Required structure of the section:**

```markdown
## 🎯 The One-Page Master Diagram — Everything on One Screen

> **When to use:** final revision, 10 minutes before the interview. This one diagram
> reconstructs the whole topic. If you can narrate it end-to-end and name the
> tradeoff at each red box, you're ready.

### The central split in one sentence
**<the split, bolded, one sentence>**

```mermaid
<the single master flowchart — lanes by the central split, numbered flow,
 AWS + pattern annotations on boxes, red on the hard parts>
```

### The 60-second narration
1. …  ← one numbered line per numbered edge, the story you say out loud

### The five numbers that justify the design
| Number | Derivation | Therefore |
|---|---|---|

### The patterns this assembles
| Pattern | Where | The move |
|---|---|---|

### The three things that break (and the mitigation)
| Failure | Blast radius | Mitigation | How you detect it |
|---|---|---|---|

### If you only remember one thing
> <one bold sentence — the thing that, if you say it, proves you understand this system>
```

**Exemplars to copy:** [`interviews/payment-system/diagrams.md`](../interviews/payment-system/diagrams.md) and [`interviews/video-streaming/diagrams.md`](../interviews/video-streaming/diagrams.md) — both end with a built master diagram.

> **Why the last section and not the first?** Writing it requires knowing everything else, exactly like the README's "How a Senior Engineer Thinks" section. Reading it is the reverse — it's the first thing you open when revising. Authoring order and reading order are intentionally opposite.

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
7. **AWS specifics get extra scepticism.** Service names, quotas, and limits change, and many quotas are per-account adjustable. So:
   - Treat every AWS limit as an **order-of-magnitude planning number to verify** — mark it `⚠️ verify` (the convention used in [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md)) rather than stating it flatly.
   - **Never invent a service name or an API/parameter name.** If you're unsure a service or capability exists, say "verify in current AWS docs."
   - Flag services that may be deprecated or renamed rather than leading with them.
   - Don't imply an AWS service provides a guarantee it doesn't — the "What AWS Does *Not* Give You" list in `AWS_SERVICE_MAP.md` §4 is there precisely because these are the claims that get made carelessly (exactly-once, cross-service transactions, global ordering, strong cross-region reads).

When honesty and helpfulness conflict, choose honesty.

---

## 5. New-topic checklist

Copy this into a scratch note when starting a topic:

```text
[ ] Named the central split in one sentence (drives Diagram 1 + simple-diagram + README senior section + master diagram)
[ ] Named the PATTERNS this topic assembles (patterns/README.md reverse index) — central vs present
[ ] Pulled real constraints (scale, latency SLA, availability, durability) into the problem statement
[ ] questions.md: 8 levels, continuous Q-numbering, italic level goals, failure-mode Qs, bonus QBs
[ ] answers.md: every Q answered, each with table OR code, each ends with **Key takeaway**
[ ] answers.md: pattern instances LINK to patterns/ instead of re-deriving the ladder
[ ] answers.md: ⚡ cheat sheet (scale numbers · tech choices w/ primitive+AWS+native · patterns used · tradeoffs · mistakes)
[ ] simple-diagram.md: simple model + components table + "one idea" + detailed model + protocols
[ ] simple-diagram.md: service cheat-sheet is 4-column (Primitive | AWS | Native/OSS | Why) + AWS-gotchas list
[ ] diagrams.md: Diagram 1 = the split; 8–12 diagrams; each has "when to use" (Q refs) + "what interviewer checks"
[ ] diagrams.md: Quick Interview Reference, THEN the 🎯 One-Page Master Diagram as the final section (§2.1)
[ ] Master diagram: one screen · numbered flow · AWS+pattern annotations · red on the hard parts · narration + 5 numbers + patterns + 3 failures + "one thing"
[ ] diagrams.md: mermaid colors carry meaning; labels quoted; `>` escaped; renders cleanly (preview it)
[ ] deep-dive.md: 🟢🟡🔴 depth tiers, failure modes, real examples
[ ] README.md: how-to-use names every file; files table; learning path; Patterns-in-play table; senior-thinking section written LAST
[ ] Cross-links added between related topic folders + down into patterns/ and fundamentals/
[ ] Any NEW AWS mapping row added back to docs/AWS_SERVICE_MAP.md (keep the vocabulary in one place)
[ ] Any recurring sub-problem with no pattern file added to the patterns/README.md gap list
[ ] ROADMAP.md updated (dashboard counts + status line + quick-ref row)
[ ] Accuracy pass: hedged uncertain numbers, no invented sources/APIs, vendor claims verifiable, AWS limits marked ⚠️ verify
```

---

## 6. Quality bar (self-review before calling it done)

- **Can a candidate whiteboard the whole system from `diagrams.md` alone?** If not, a diagram is missing.
- **Can they reconstruct the topic from the one-page master diagram alone in 90 seconds?** That's the real test of the master diagram — if you need a second file, it's not doing its job.
- **Does every answer give something defensible to *say*, not just facts to know?** The Key takeaway is that sentence.
- **Is the central split obvious within the first screen of the README and Diagram 1?**
- **Is every named service preceded by the primitive it implements?** A service name with no property attached is a name-drop, not an answer (Rule 3).
- **Does the folder route to `patterns/` instead of re-deriving ladders?** If the same contention/saga/read-scaling reasoning appears in three topic folders, it belongs in a pattern file.
- **Would the accuracy rules survive a fact-check?** No unverifiable numbers stated as fact, no invented citations, no unmarked AWS quotas.
- **Do the failure-mode questions have real incident-response answers**, not hand-waving?

---

## 7. Order of operations (recommended)

1. **Name the central split and the patterns in play** (one sentence + the reverse-index row). Everything downstream hangs off this.
2. Draft `questions.md` (defines scope and levels).
3. Write `simple-diagram.md` (forces you to commit to the split; fill the 4-column primitive/AWS/native cheat-sheet here first — later files reuse it).
4. Write `answers.md` (the substance; Key takeaways crystallize each point; link out to `patterns/` rather than re-deriving).
5. Write `diagrams.md` diagrams 1–N (visualize what the answers describe; Diagram 1 = the split).
6. Write `deep-dive.md` (depth beyond the happy path).
7. Write `README.md` — especially "How a Senior Engineer Thinks," which is a summary of everything above.
8. **Write the One-Page Master Diagram last of all** (§2.1). It compresses every file above, so it can only be written once they exist — and it's the first thing you'll read when revising.
9. (Optional) `conducive-sentences.md` prose pass.
10. Update `ROADMAP.md` + cross-links; push any new AWS rows to `AWS_SERVICE_MAP.md` and any new sub-problem to the `patterns/` gap list. Accuracy pass. Preview all Mermaid.
