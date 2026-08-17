# Topic Authoring Guide — How to Build an `interviews/<topic>/` Folder

> **Purpose:** a repeatable spec for writing a system-design topic.
> Every folder should look, read, and teach the same way.
>
> **Who reads the content:** Mid-level engineers prepping HLD interviews for Staff roles.
> **What they do with it:** *speak* it and *draw* it under time pressure. Nothing else.
>
> **Canonical exemplar:** [`interviews/video-streaming/`](../interviews/video-streaming/). Second: [`interviews/ride-sharing/`](../interviews/ride-sharing/).
> **Style model (external):** the Hello Interview Cassandra deep dive — plain headings, analogy first, few but genuinely simple diagrams, and a dedicated "in an interview" section.
> **Companions:** [`RADIO_FRAMEWORK.md`](./RADIO_FRAMEWORK.md) — how to *perform* in the room · [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md) — the primitive→AWS→native mapping · [`../patterns/README.md`](../patterns/README.md) — the reusable sub-problems.

---

## 0. The seven rules that matter most

### Rule 1 — Lead with the central split

Find the topic's organizing insight. Lead with it. Everything else clips onto it.

| Topic | Central split you lead with |
|---|---|
| Video streaming | **Write path** (upload→transcode→store, async) vs **read path** (play→CDN→viewer, latency-bound) |
| Ride sharing | **Three planes**: location ingest · matching · trip tracking |
| KV store | Consistency vs availability, then partitioning, then replication |
| Storage engines | LSM-tree (write-optimized) vs B-tree (read-optimized) |

Say the split in one sentence. If you can't, you're not ready to write the folder.

Diagram 1 *is* that split. So is the simple diagram. So is the master diagram.

### Rule 2 — Write for the mouth, not the page

The reader will say these words out loud to an interviewer. Write sentences they can say.

Short sentences. One idea each. Active voice. Everyday words.

Full rules and the ban list are in [§1](#1-house-style--the-sentence-rules). They are not optional polish. They are the house style.

> **The test:** read the paragraph aloud at interview pace. If you stumble, run out of breath, or have to re-read a line, rewrite it.

### Rule 3 — Every diagram must be drawable by hand

A diagram nobody can reproduce with a pen is decoration.

Default every diagram to **Tier D (drawable)**: at most 9 boxes, at most 12 arrows, drawn in 90 seconds, readable in black and white. Rich annotated diagrams are **Tier R (reference)** and are allowed in only three places.

Full spec in [§2](#2-diagram-rules--tier-d-and-tier-r). Use **more** diagrams than feels necessary — at least one per question level.

### Rule 4 — Name the patterns; don't re-explain them

Every topic assembles [`patterns/`](../patterns/README.md) — recurring sub-problems that already have write-ups.

- The README carries a **Patterns in play** table (see [§5](#5-file-by-file-spec)).
- An answer that hits a pattern links to the exact section. It does not re-derive it. Example: *"this is rung 1 of the contention ladder — a conditional write,"* linking `[contention ladder](../../patterns/dealing-with-contention.md#4-rung-1-conditional--atomic-writes)`. Paths in this guide are relative to `interviews/<topic>/`, where they'll live.
- Need a sub-problem that isn't in `patterns/` yet? Add it to the gap list in [`patterns/README.md`](../patterns/README.md#gaps--recurring-sub-problems-not-yet-written-up). Don't bury the only copy inside one topic.

**Repo-wide: cross-link, don't duplicate.** Concept depth lives in `fundamentals/`. Sub-problem depth lives in `patterns/`. System depth lives in `interviews/`.

### Rule 5 — Every tech choice is primitive → AWS → native

The repo is AWS-annotated, not AWS-only. For each component, say three things in this order:

```
1. the PRIMITIVE   — the property you need, and the number that forces it
2. the AWS SERVICE — the managed implementation (the fluency signal)
3. the NATIVE/OSS  — the swap, which proves it isn't lock-in
```

> *"I need an at-least-once queue with a visibility timeout and a DLQ. A transcode takes ~4 minutes. A worker crash must not lose the job. On AWS that's SQS. Self-hosted it's RabbitMQ, or Kafka if I also need replay."*

Note the shape: short sentences, number in the middle, service name last.

Mapping tables and per-service gotchas live in [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md). Pull from there. Don't invent a new table per topic. Primitive-first ordering is deliberate — the same sentence still works at Google or Meta, where an AWS catalog scores nothing.

### Rule 6 — Deep material stays marked as deep-dive

Depth is welcome. Unmarked depth is not.

**Default home:** [`deep-dive.md`](#deep-divemd). Anything you would *not* say in a 45-minute interview belongs there.

**If deep material must appear in another file**, wrap it in a marked, collapsed block so the main line of reading stays simple:

````markdown
<details>
<summary>🔴 <b>deep-dive</b> — how the compaction scheduler actually picks SSTables</summary>

...the deep content...

</details>

````

Rules for the marker:
1. The word **`deep-dive`** appears in every such summary line. Grep-able on purpose.
2. The block is **collapsed by default**. A first-pass reader skips it and loses nothing.
3. It never carries load-bearing content. If an answer *needs* it, the answer is wrong — say the short version inline.
4. `README.md`, `simple-diagram.md`, and `questions.md` carry **no** deep blocks at all. They are the shallow end.

Inside `deep-dive.md`, mark every section with its depth tier: 🟢 beginner · 🟡 senior · 🔴 staff/architect. See [§5](#deep-divemd).

### Rule 7 — Cut depth, never coverage

Most topics start from a real source: a vendor doc, a paper, an engineering blog. You are not summarizing it. You are **compressing it into what survives an interview**.

Cut the detail under a subsystem. Never cut the subsystem.

A reader must not discover mid-interview that a whole part of the system was missing from their notes. Depth is negotiable. Coverage is not.

The full method — nine moves and a worksheet — is in [§3](#3-simplifying-a-source-doc--the-compression-method).

---

## 1. House style — the sentence rules

This governs every `.md` file in a topic folder.

### 1.1 Sentences

| Rule | Do | Don't |
|---|---|---|
| One idea per sentence | "The CDN caches the segment. The next viewer gets it in 20 ms." | "The CDN caches the segment, meaning that subsequent viewers, provided they hit the same edge, will be served in roughly 20 ms." |
| Aim for ≤ 15 words. Hard cap 20 | "Writes go to the leader. Reads can go anywhere." | — |
| Active voice, named actor | "The worker acks the message." | "The message is acked." |
| Answer first, reason second | "Use a queue. A transcode takes 4 minutes. An HTTP request can't wait." | "Because transcoding is a long-running operation, it follows that…" |
| Full stops over commas | Two short sentences | One sentence with three clauses |
| Max 3 sentences per paragraph | — | Wall of text |

### 1.2 Words

Replace these on sight:

| Don't write | Write |
|---|---|
| leverage, utilize | use |
| facilitate, enable | let |
| in order to | to |
| subsequently | then |
| thereby, hence | so |
| is able to | can |
| a number of | some, or the actual number |
| prior to | before |
| in the event that | if |
| it should be noted that | *(delete it)* |
| performant | fast, or the p99 number |

### 1.3 Jargon

Gloss every term on first use in a file. Once. In brackets. Then use it freely.

> "We need a **quorum** (enough replicas agreeing) before we ack the write."

Never introduce two new terms in one sentence.

### 1.4 Numbers beat adjectives

"Very fast" says nothing. "p99 is 200 ms" says everything.

Every claim of scale, speed, or size carries the number and where it came from. See [§7](#7-accuracy-rules-non-negotiable) for how to hedge numbers honestly.

### 1.5 Headings

Plain and descriptive. "How replication works", not "The dance of the replicas".

A reader scanning only your headings should get the outline of the topic.

### 1.6 Analogy first, mechanics second

When a concept is new, open with one everyday analogy. One sentence. Then the mechanics.

> "A Bloom filter is a bouncer with a bad memory. It can say 'definitely not on the list'. It can never say 'definitely on the list'."

Keep the analogy short. Don't extend it past its usefulness.

---

## 2. Diagram rules — Tier D and Tier R

**Use more diagrams than feels necessary.** A diagram every two screens is a good rhythm. Minimum: one per question level, plus Diagram 1, plus the master diagram.

### 2.1 Tier D — drawable (the default)

Tier D is what you actually draw on a whiteboard. Every diagram is Tier D unless explicitly marked otherwise.

Constraints — all of them, not most:

| Constraint | Limit |
|---|---|
| Boxes | ≤ 9 |
| Arrows | ≤ 12 |
| Words per box label | ≤ 4 |
| Words per arrow label | ≤ 5 |
| Shapes used | 5 max — box, cylinder, stadium, diamond, queue |
| Time to draw by hand | ≤ 90 seconds |
| Colour | **must be readable with none** |
| Nesting | ≤ 2 subgraphs, no nesting inside a subgraph |

On colour: colour helps the reader on screen. It must never *carry* meaning, because a whiteboard marker is black. If removing colour makes the diagram ambiguous, the diagram is wrong.

### 2.2 Every Tier D diagram carries two companions

This is the part that makes a diagram teachable instead of just visible.

**1. Draw order** — the strokes, numbered, in the order your hand makes them.

**2. Say while drawing** — one short spoken line per stroke.

````markdown
```mermaid
<the Tier D diagram>
```

**Draw order (~60s)**
1. Two stick figures far left and far right. Label them Creator and Viewer.
2. Box top-middle: "Upload API". Arrow from Creator.
3. Cylinder under it: "Blob store". Arrow down.
4. Box right of the cylinder: "Transcoder". Arrow across.
5. Cylinder: "Segments". Arrow down.
6. Box far right: "CDN". Arrow from Segments, then to Viewer.

**Say while drawing**
1. "A creator uploads. A viewer watches. Two different problems."
2. "The upload hits an API. The API doesn't touch the bytes."
3. "The raw file lands in blob storage."
4. "That fires a transcode job. This part is slow and async."
5. "Out come segments, at several qualities."
6. "The CDN serves those segments. This part must be fast."
````

Keep the spoken lines under 12 words each. They are a script, not captions.

### 2.3 The pen version (required in `simple-diagram.md`)

Mermaid renders. Pens don't. For the first diagram of `simple-diagram.md`, also include the ASCII sketch — literally the shape your hand makes:

```text
 Creator ──▶ [Upload API] ──▶ (raw blob)
                                  │
                                  ▼
                            [Transcoder]
                                  │
                                  ▼
                            (segments) ──▶ [CDN] ──▶ Viewer
```

Five to ten lines. No box-drawing art beyond this. It exists to prove the diagram survives a whiteboard.

### 2.4 Tier R — reference (allowed in exactly three places)

Tier R is annotated and dense: real service names, protocols, TTLs, colour by meaning.

Allowed **only** in:
1. The **detailed** second half of `simple-diagram.md`.
2. `deep-dive.md`.
3. The one-page master diagram ([§5.1](#51-the-one-page-master-diagram)).

Every Tier R diagram is tagged, directly above the fence:

```markdown
> **Tier R — reference only. Don't draw this in the room. Draw Diagram 1 and talk to it.**
```

Anywhere else, Tier R is a bug.

### 2.5 Diagram type by content

| Content | Type |
|---|---|
| Architecture, dataflow | `flowchart` |
| Protocol, handshake, retry loop | `sequenceDiagram` |
| Lifecycle, status machine | `stateDiagram-v2` |

Mix them. A topic with eleven flowcharts and nothing else is under-thought.

---

## 3. Simplifying a source doc — the compression method

Most topics start from a real source. A vendor doc, a paper, an engineering blog.

Your job is not to summarize it. Your job is to compress it into what survives an interview (Rule 7).

### 3.1 The worked comparison — study these two pages

| Role | Page |
|---|---|
| **The source** | [Apache Cassandra — Dynamo architecture](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html) |
| **The compression** | [Hello Interview — Cassandra](https://www.hellointerview.com/learn/system-design/deep-dives/cassandra) |

Read them side by side once. The difference in shape is the whole lesson.

| | Apache doc | Hello Interview |
|---|---|---|
| Organised by | implementation module | what a candidate says |
| Opens with | partitioning internals | the data model you'd type |
| New terms introduced | many (~60) | far fewer (~20) |
| Diagrams | 2 | ~5 |
| Worked examples | 0 | 2 (Discord, Ticketmaster) |
| "When to use it" section | none | yes |
| Reader assumed | distributed-systems background | knows SQL |

> ⚠️ These counts are approximate, from one reading of each page. They show the *direction* of the change, not exact figures. Don't quote them as data (§7).

Both pages cover the same system. One documents it. The other prepares you to *defend* it.

### 3.2 The nine moves

**Move 1 — Re-order from "how it's built" to "how you'd use it."**

The Apache doc opens with partitioning internals. The interview version opens with the data model — the thing you actually type.

Build order is not learning order. Lead with what the reader touches.

**Move 2 — Sort every concept into explain / name / cut. Write the list down.**

Three tiers, not two:

| Tier | Treatment | Why it exists |
|---|---|---|
| **Explain** | A diagram and a paragraph. You can derive it. | This is what you'd draw. |
| **Name** | One sentence. The word, no mechanics. | Buys you a follow-up you can survive. |
| **Cut** | Never appears. | It would cost time and win nothing. |

Cassandra, as sorted by the interview version:

- **Explain** — consistent hashing, replication strategy, tunable consistency, the LSM write path, query routing, gossip.
- **Name** — Bloom filters, vector clocks, compaction, Merkle trees. Said once, mechanics skipped.
- **Cut** — transient replication, seed-node config, sub-range vs incremental repair, the 2.x/3.x token allocator, JIRA references.

The test for *cut*: **would you ever say this out loud in 45 minutes?** Production knobs are operator surface, not interview surface.

The **name** tier is the one people miss. It's cheap and it's armour.

**Move 3 — Cut depth, never coverage.**

This is what makes "high level yet complete" possible.

Every subsystem in the source still appears in the compression: partitioning, replication, consistency, routing, storage, gossip, failure detection. What shrank is the detail under each pin. Nothing vanished from the map.

Run the coverage check explicitly. List the source's top-level sections. Tick each one off against your topic folder.

**Move 4 — Teach the formula, name two instances, drop the catalog.**

The Apache doc enumerates nine consistency levels. The interview version teaches `W + R > RF`, then names the two you'd actually pick.

The formula is portable. The catalog is lookup.

Same move applies to isolation levels, EC2 instance families, Redis eviction policies, HTTP status codes.

**Move 5 — Replace a warning with a failure story.**

A warning is forgettable. A story is not.

> Source: "large partitions degrade performance."
>
> Compression: Discord keys messages by `(channel_id, message_id)`. A busy channel becomes one huge partition. So they add a 10-day bucket to the partition key.

Every constraint you want remembered gets three beats: **naive design → the number that breaks it → the fix.**

That structure is already the answer to a follow-up question. Write constraints this way and you get the answer for free.

**Move 6 — Bridge from what the reader already knows.**

"Partition key and clustering key work like DynamoDB's partition and sort key." "Relational says normalize. Cassandra says denormalize."

The source defines from first principles because it can't assume a reader. You can. Anchor to SQL, to a familiar service, or to daily life ([§1.6](#16-analogy-first-mechanics-second)).

**Move 7 — Trade jargon for diagrams.**

The source carries many terms and two diagrams. The compression inverts that.

**The more terms a section introduces, the more it needs a picture.** A diagram replaces a paragraph. It doesn't decorate one.

If a section introduces three new terms and has no diagram, that's the section to draw next.

**Move 8 — Drop version history and provenance — except the one line that compresses.**

Cut: 2.x vs 3.x token allocators, "experimental in 4.0", the Chord citation, JIRA links.

Keep: *"Cassandra takes partitioning and membership from Dynamo, and the storage engine from Bigtable."*

That one sentence compresses the whole architecture. Provenance earns space only when it's a shortcut.

**Move 9 — Add the section the source can't have.**

A vendor doc documents the system. You document **the decision to use the system**.

When to reach for it. Where it breaks. What you'd swap to.

That's the `<Topic> in an Interview` README section ([§5](#5-file-by-file-spec)). It has no counterpart in the source. It's the highest-value thing you add.

### 3.3 The compression worksheet

Fill this in before writing a topic that has a source doc.

```text
SOURCE:         <url>
CENTRAL SPLIT:  <one sentence — Rule 1>

EXPLAIN (5–8 max — each one gets a Tier D diagram)
  1. …
  2. …

NAME ONLY (say the word, one sentence, no mechanics)
  - …

CUT (operator knobs, version history, experimental features, citations)
  - …

FAILURE STORIES (naive design → the number that breaks it → the fix)
  1. …

BRIDGES (new thing → thing the reader already knows)
  - … is like …

COVERAGE CHECK (every top-level section of the source appears somewhere)
  [ ] …   [ ] …   [ ] …

THE SECTION THE SOURCE CAN'T HAVE
  When to use:      …
  Where it breaks:  …
```

If **EXPLAIN** has more than eight rows, you haven't compressed. You've reformatted.

If **CUT** is empty, you haven't read the source properly.

---

## 4. Folder anatomy

Every topic folder contains these files. Create in this order:

| Order | File | Purpose | Required? |
|---|---|---|---|
| 1 | `README.md` | Front door: level, how to use, problem, patterns, "in an interview". | ✅ |
| 2 | `simple-diagram.md` | The drawable mental model, plus a detailed reference version. | ✅ |
| 3 | `questions.md` | Leveled, question-first grill (L1→L8 + bonus). | ✅ |
| 4 | `answers.md` | One answer per question. Table or code. **Key takeaway** line. Cheat sheet at the end. | ✅ |
| 5 | `diagrams.md` | 12–16 Tier D diagrams, each mapped to questions — plus the master diagram last. | ✅ |
| 6 | `deep-dive.md` | 🟢🟡🔴 depth, failure modes, real-world examples. All deep material lives here. | ✅ |
| 7 | `conducive-sentences.md` | Plain-English retelling of every answer, each section bridging to the next. | optional |

Then update [`interviews/ROADMAP.md`](../interviews/ROADMAP.md): dashboard counts, status line, quick-reference table. Also add a row to the reverse index in [`patterns/README.md`](../patterns/README.md).

**Where each layer's depth belongs**, so files don't duplicate each other:

```
fundamentals/<concept>.md   one concept, 2 min          quorum, lease, fencing, WAL, Bloom filter
patterns/<sub-problem>.md   one recurring sub-problem   contention ladder, saga, scaling reads
interviews/<topic>/         one whole system            ← THIS SPEC
docs/AWS_SERVICE_MAP.md     primitive → AWS → native    the shared tech vocabulary
docs/RADIO_FRAMEWORK.md     how to perform in the room  R·A·D·I·O timeboxing + estimation
```

---

## 5. File-by-file spec

### `README.md`

Sections, in order:

1. **Title** — `# System Design: <Topic> (<Real-world examples>)`.
2. **Target + Style** blockquote — who it's for. "Interview-grill format — question first, then defended choices."
3. **How to Use This Guide** — numbered steps naming every file. Start with `simple-diagram.md`. Attempt `questions.md` cold. Check `answers.md`. Whiteboard from `diagrams.md`. Go deep with `deep-dive.md`. Revise from the master diagram.
4. **Learning Path** table — `| Level | Topic | You'll Learn |`, matching the question levels.
5. **Files** table — one row per file, one line each. Mark the start-here file.
6. **Problem Statement** blockquote — the ask, then a bulleted **Key Constraints** list with real numbers (scale, latency SLA, availability, durability).
7. **Patterns in play** table — which [`patterns/`](../patterns/README.md) this topic assembles. **●** central, **○** present. Link the pattern file *and* the levels where it appears. Keep it consistent with the reverse index:

   ```markdown
   | Pattern | Role | Where it shows up here |
   |---|---|---|
   | [Dealing with Contention](../../patterns/dealing-with-contention.md) | ● central | L4 Q18–Q24 — the no-oversell guard |
   | [Multi-Step Processes](../../patterns/multi-step-processes.md) | ● central | L5 Q25–Q31 — fulfillment saga + outbox |
   | [Scaling Reads](../../patterns/scaling-reads.md) | ○ present | L3 Q12–Q17 — browse path caching |
   ```

8. **`<Topic>` in an Interview** — *required*. Three sub-sections, all short:

   ```markdown
   ### When to reach for this design
   - bullet, one line each, the trigger phrase an interviewer says

   ### Where it breaks down (know the limits)
   - bullet, one line each, the honest limitation and what you'd swap to

   ### The five sentences that score
   1. …  ← the exact lines to say, ≤ 15 words each
   ```

   This is modelled on the Hello Interview "X in an Interview" section. It separates strategy from mechanics, and it's the part a reader uses on the morning of the loop.

9. **How a Senior Engineer Thinks About This** — 2–4 short paragraphs walking the central split and the top 2–3 insights. Highest-signal section. Write it **last**, after the answers exist.

No `deep-dive` blocks in this file (Rule 6).

### `simple-diagram.md`

Two diagrams, plainest first.

**1. Simple mental model — Tier D.** A `flowchart` with only the essential boxes. Numbered edges telling one story. Then, in order:
   - **The pen version** — the ASCII sketch ([§2.3](#23-the-pen-version-required-in-simple-diagrammd)).
   - **Draw order** and **Say while drawing** ([§2.2](#22-every-tier-d-diagram-carries-two-companions)).
   - **"The N components to remember"** table — `| Component | Job (one line) |`.
   - **"The one idea that ties it together"** — one bold paragraph stating the central split. Three sentences max.

**2. Detailed diagram — Tier R.** Same flows, now with concrete services and protocols. Tag it per [§2.4](#24-tier-r--reference-allowed-in-exactly-three-places). Note that the picks are *defensible*, not gospel. Then:
   - A **service cheat-sheet** table — four columns, primitive first (Rule 5). Exemplar: [`interviews/video-streaming/simple-diagram.md`](../interviews/video-streaming/simple-diagram.md).

     ```markdown
     | Concept | Primitive (say this first) | AWS service | Native / OSS | One-line why |
     |---|---|---|---|---|
     | Big-file upload | resumable multipart upload, bytes bypass the API | **S3 Multipart + presigned URL** | MinIO | Parallel parts; app server out of the data path |
     | Work queues | at-least-once queue, per-message retry + DLQ | **SQS** (one per job type) | RabbitMQ | Small failure unit; one poison job can't block others |
     ```

     Pull rows from [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md) so the vocabulary stays consistent. Push genuinely new rows back into that file.
   - An **AWS gotchas for this topic** list, 2–5 bullets. The quota and failure-mode traps for the services just named. Example: "SQS visibility timeout must exceed p99 job duration." Pull from `AWS_SERVICE_MAP.md` §3.
   - A **protocols worth naming** list.

### `questions.md`

- Header blockquote: "Attempt all questions before reading answers.md · work level-by-level · speak answers aloud."
- **8 levels**. Each `## Level N — <Name>` with an italic *Goal:* line. Level 1 = fundamentals. Level 8 = architect/staff.
- Questions numbered `**Q1.**`, `**Q2.**`… continuously across levels.
- Keep each question to one or two short sentences. A question you have to parse twice tests reading, not design.
- Include **failure-mode questions** — mark `*(Failure mode)*`. "X crashes at 2 AM. What do users see? What do you do?"
- End with **Bonus — questions a senior raises unprompted** (`**QB1.**`…).

No `deep-dive` blocks in this file (Rule 6).

### `answers.md`

- Header: "Keyed to questions.md. Each answer includes either code or a comparison table."
- One `### AN. <short title>` per question. Same numbering as `questions.md`.
- **Open every answer with the one-sentence answer.** Then the reasoning. Then the table or code. An interviewer hears the first sentence and knows if you're right.
- Every answer has a **comparison table or a code/pseudocode block**. Table for tradeoffs, code for mechanics. Never prose-only.
- Every answer ends with a bold **Key takeaway:** line. One sentence, ≤ 20 words. This is the thing to say under pressure.
- Pattern instances **link** the pattern section rather than re-deriving it (Rule 4).
- Deep material goes in a collapsed `deep-dive` block (Rule 6), or into `deep-dive.md`.
- Ends with a **⚡ Quick Revision Cheatsheet** with five sub-sections:
  - **Scale numbers** — back-of-envelope, math shown.
  - **Key technology choices** — `| Component | Primitive / why | AWS | Native / OSS |`.
  - **Patterns used** — one line each, linked. Mirrors the README table.
  - **Canonical tradeoffs to memorize** — `A vs B: upside vs upside`.
  - **Common interview mistakes to avoid** — including the topic's AWS traps.

### `diagrams.md`

- Header with a "start with Diagram 1" note, a **Reference** line linking `answers.md` / `simple-diagram.md`, and a **Cross-links** line to related topics.
- **12–16 diagrams.** All Tier D. Diagram 1 is always the central split. At least one diagram per question level.
- Each diagram block is:
  1. `## Diagram N — <Title>`
  2. A `> **When to use:**` blockquote naming the exact question numbers it serves.
  3. The ```mermaid block (Tier D constraints, [§2.1](#21-tier-d--drawable-the-default)).
  4. **Draw order** and **Say while drawing** ([§2.2](#22-every-tier-d-diagram-carries-two-companions)).
  5. A **What the interviewer is checking:** list — 3–4 bullets on the *signal*, not the content.
- Mix diagram types ([§2.5](#25-diagram-type-by-content)).
- Then a **Quick Interview Reference**: scale numbers, a domain quick-ref table, canonical tradeoffs, common mistakes.
- **Finally — required — the one-page master diagram.** See [§5.1](#51-the-one-page-master-diagram).

### `deep-dive.md`

This file is the home for all depth. Open it with a banner:

```markdown
> **deep-dive** — everything here is beyond a 45-minute interview answer.
> Read it to be un-rattleable in follow-ups, not to recite it.
```

- Progression per section: 🟢 beginner → 🟡 senior → 🔴 staff/architect. Every section carries all three.
- 🟢 uses a daily-life analogy, no jargon ([§1.6](#16-analogy-first-mechanics-second)).
- 🟡 has at least one code block and one comparison table.
- 🔴 has capacity math, a quantified failure mode, or a production config decision.
- Real-world implementations, quantified failure modes, production tradeoffs.
- Closing cheat sheet, ≥ 15 rows.

The sentence rules ([§1](#1-house-style--the-sentence-rules)) still apply here. Depth is in the *content*, never in the sentence length.

---

### 5.1 The One-Page Master Diagram

*(final section of `diagrams.md`)*

**The problem it solves.** The night before an interview you won't re-read eleven diagrams and forty answers. You want **one artifact that rebuilds the whole topic from one screen**: the split, the components, the AWS names, the patterns, the numbers, the two failure modes that carry the signal.

This is the one Tier R diagram in `diagrams.md`. Tag it as such.

**Rules that make it work:**

1. **One screen, one diagram.** If it doesn't fit on a laptop screen at readable zoom, it's a normal diagram, not the master. Cut anything not load-bearing.
2. **It's a recall harness, not a new diagram.** Every box points at knowledge already written. Annotate boxes with the AWS service and the number that justifies it.
3. **Layer it by the central split.** Draw the split as subgraphs or lanes, so the geometry itself carries the insight.
4. **Number the flow, and narrate it at two speeds.** Numbered edges tell the main journey end to end. Ship *both* tiers: a **60-second narration** (one ≤15-word line per edge, ~120 words total) and a **3-minute walkthrough** (the same edges with reasoning). A master diagram you can't narrate in 60 seconds is decoration.

   Budget at roughly **130 words per minute** of speech. Count the words — the label must be true.
5. **Mark the hard parts.** Use the failure palette (`#fee2e2`/`#dc2626`) on the 2–3 boxes where the real difficulty lives.
6. **Pattern + AWS annotations inline** — e.g. `Hold Service<br/>[contention: rung 1]<br/>ElastiCache SETNX+TTL`.
7. **Ship a Tier D reduction with it.** Directly below the master, add the 6-box version you'd actually draw. The master is for your eyes; the reduction is for the whiteboard.

**Required structure:**

````markdown
## 🎯 The One-Page Master Diagram — Everything on One Screen

> **When to use:** final revision, 10 minutes before the interview. If you can
> narrate this end-to-end and name the tradeoff at each red box, you're ready.

### The central split in one sentence
**<the split, bolded, one sentence>**

> **Tier R — reference only. Don't draw this one. Draw the reduction below it.**

```mermaid
<the single master flowchart — lanes by the central split, numbered flow,
 AWS + pattern annotations on boxes, red on the hard parts>
```

### The Tier D reduction — what you actually draw
```mermaid
<the same system in ≤ 9 boxes, no colour needed>
```

### The 60-second narration

*(the whole system, one short line per numbered box — say this end to end)*

1. …  ← one line per numbered edge, **≤ 15 words**, no reasoning attached

### The 3-minute walkthrough

*(the same flow with the reasoning attached — this is what you say during the architecture block, while drawing)*

1. …  ← the same numbered edges, now with the *why*, the tradeoff, and the number

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
> <one bold sentence — the thing that proves you understand this system>
````

**Exemplars:** [`interviews/payment-system/diagrams.md`](../interviews/payment-system/diagrams.md) and [`interviews/video-streaming/diagrams.md`](../interviews/video-streaming/diagrams.md).

> **Why last and not first?** Writing it needs everything else to exist. Reading it is the reverse — it's the first thing you open when revising. Authoring order and reading order are deliberately opposite.

### 5.2 Optional — The 30-Minute Spoken Transcript

**The problem it solves.** The 60-second narration proves you can *summarize*, and the 3-minute walkthrough proves you can explain. It doesn't prove you can *perform* 30 minutes under pressure — hold the RADIO budget, narrate while drawing, field a deep-dive, land the close.

Add this only to a topic you're actively rehearsing. It's a training artifact, not a documentation requirement.

**Rules that make it work:**

1. **Timestamped blocks mirroring RADIO's split** ([`RADIO_FRAMEWORK.md`](./RADIO_FRAMEWORK.md) §0), scaled to ~30 min: Requirements 2–5, Architecture (drawn live) ~10, Data model ~3, API ~3, Deep dive 8–10, Close ~1.
2. **One spoken sentence per numbered edge** of the master diagram's Tier D reduction, in the same order. This is what you say while your hand draws.
3. **First person, spoken register, short sentences.** "I'll…", "So here…", "The reason is…". If you wouldn't say it out loud, rewrite it. [§1](#1-house-style--the-sentence-rules) applies twice as hard here.
4. **Never re-derive numbers.** Every figure already exists in `answers.md`. Quote it and state the decision it drives.
5. **Pick the two hardest parts** for the deep-dive block. Each gets bottleneck → options → pick → failure mode, spoken.
6. **Close on the master diagram's "if you only remember one thing"** line.
7. **End with a one-line practice tip** — read aloud, on a timer, until the *structure* is internal. Then an interruption can't break you.

**Required structure** (append after the master diagram, still inside `diagrams.md`):

```markdown
### 🎤 30-Minute Interview Transcript — What to Actually Say

> Read this OUT LOUD while drawing the Tier D reduction live. Timestamps are a
> budget, not a stopwatch — the ORDER (R→A→D→I→O→Close) is what must hold.

#### [00:00–0X:XX] Open — restate the problem and scope it
#### [0X:XX–0X:XX] Size the problem in your head
#### [0X:XX–0X:XX] Draw the architecture live, narrating each piece
#### [0X:XX–0X:XX] Data model — say this fast
#### [0X:XX–0X:XX] API — the handful of endpoints that matter
#### [0X:XX–0X:XX] Deep dive — pick the two hardest parts
#### [0X:XX–30:00] Close with the one-line thesis
> 💡 **Practice tip:** …
```

**Exemplar:** [`interviews/food-delivery/diagrams.md`](../interviews/food-delivery/diagrams.md) — the transcript at the very end. *(It predates the current §5.1 spec, so its final diagram lacks the numbers/patterns/failures tables. Use it as the transcript exemplar only.)*

---

## 6. Mermaid conventions

Keep diagrams renderable and consistent.

**Node shapes** — five, and no more in a Tier D diagram:

| Shape | Syntax | Means |
|---|---|---|
| Box | `["name"]` | service / process |
| Cylinder | `[("name")]` | datastore |
| Stadium | `(["name"])` | external actor / user |
| Diamond | `{"name"}` | decision |
| Queue | `[["name"]]` | queue / stream / bus |

Tier R may also use `{{"hexagon"}}` for an event or topic.

**Colour palette** (`style NODE fill:#hex,stroke:#hex`) — meaning, not decoration. And never the *only* carrier of meaning ([§2.1](#21-tier-d--drawable-the-default)):

| Meaning | fill | stroke |
|---|---|---|
| Write / throughput / async | `#fed7aa` | `#ea580c` |
| Read / fast / good outcome | `#dcfce7` | `#16a34a` |
| Decision / cache / hot-path gate | `#fef9c3` | `#ca8a04` |
| Failure / danger / hot data | `#fee2e2` | `#dc2626` |
| Durable store / database | `#dbeafe` | `#1d4ed8` |
| Callout / note | `#e0e7ff` | `#4338ca` |

**Gotchas that break rendering:**
- Quote any label with multiple lines or special characters: `NODE["line one<br/>line two"]`.
- Use `<br/>` for line breaks inside quoted labels.
- Escape `>` as `&gt;` inside labels, e.g. `"speed &gt; 50 m/s?"`. Otherwise it closes the shape.
- In `subgraph NAME["Label"]`, put `direction TB` on the first line inside.
- Don't use `end` as a node id. Reserved.
- `stateDiagram-v2` transition labels are single-line free text after the colon. No `<br/>`.
- Preview every diagram before calling the topic done.

---

## 7. Accuracy rules (non-negotiable)

These govern all content.

1. **Flag uncertainty.** "I'm not certain, but…" / "verify against current docs." Never state a guess as fact.
2. **No invented sources.** No fake paper titles, authors, URLs, or blogs. If you can't name a verifiable source, say so.
3. **Label statistics.** Prefix estimates with "approximately". Mark capacity figures (e.g. "~50K sockets/server") as order-of-magnitude planning numbers to verify, not hard limits.
4. **No invented APIs.** Don't fabricate function, library, or command names. If unsure, say "verify in current docs" — e.g. note that Redis `GEORADIUS` is legacy vs `GEOSEARCH`.
5. **Vendor claims must be verifiable.** OK: "Uber open-sourced H3." "Netflix Open Connect embeds servers in ISPs." Avoid internal codenames you can't confirm.
6. **Numbers derive from stated constraints** where possible — "1M drivers ÷ 4s = 250K writes/s" — so the math is checkable, not asserted.
7. **AWS specifics get extra scepticism.** Names, quotas, and limits change, and many quotas are per-account adjustable:
   - Treat every AWS limit as an order-of-magnitude planning number. Mark it `⚠️ verify`, the convention in [`AWS_SERVICE_MAP.md`](./AWS_SERVICE_MAP.md).
   - **Never invent a service or parameter name.** Unsure it exists? Say "verify in current AWS docs."
   - Flag possibly-deprecated or renamed services rather than leading with them.
   - Don't imply a guarantee AWS doesn't give. The "What AWS Does *Not* Give You" list in `AWS_SERVICE_MAP.md` §4 exists because these claims get made carelessly — exactly-once, cross-service transactions, global ordering, strong cross-region reads.

When honesty and helpfulness conflict, choose honesty.

---

## 8. New-topic checklist

Copy this into a scratch note when starting a topic.

```text
STRUCTURE
[ ] Named the central split in one sentence (drives Diagram 1 + simple-diagram + README + master)
[ ] Named the PATTERNS this topic assembles (patterns/README.md reverse index) — central vs present
[ ] Pulled real constraints (scale, latency SLA, availability, durability) into the problem statement

COMPRESSION (Rule 7 — if this topic has a source doc)
[ ] Filled the §3.3 worksheet before writing anything
[ ] Every concept sorted explain / name / cut — the list is written down, not implied
[ ] EXPLAIN has ≤ 8 rows; each one has its own Tier D diagram
[ ] NAME tier is non-empty (the cheap armour for follow-ups)
[ ] CUT is non-empty — operator knobs, version history, experimental features are gone
[ ] COVERAGE CHECK done: every top-level section of the source appears somewhere in the folder
[ ] Each remembered constraint is a failure story: naive design → number that breaks it → fix
[ ] Each new concept bridges to something the reader already knows
[ ] Any section introducing 3+ new terms has a diagram

STYLE (Rule 2)
[ ] Read every file aloud — no sentence made me stumble or run out of breath
[ ] Sentences ≤ 15 words, one idea each, active voice, actor named
[ ] Ban list swept: leverage / utilize / facilitate / in order to / subsequently / thereby / performant
[ ] Every jargon term glossed once, in brackets, on first use in that file
[ ] Every answer opens with the one-sentence answer, before the reasoning
[ ] Headings are plain and descriptive; the heading list alone outlines the topic

DIAGRAMS (Rule 3)
[ ] diagrams.md has 12–16 diagrams; ≥ 1 per question level; Diagram 1 = the split
[ ] EVERY diagram is Tier D unless tagged Tier R (≤9 boxes, ≤12 arrows, ≤4-word labels, 90s to draw)
[ ] Every Tier D diagram has "Draw order" + "Say while drawing"
[ ] No diagram depends on colour to be understood
[ ] simple-diagram.md has the ASCII "pen version" of Diagram 1
[ ] Tier R appears ONLY in: detailed simple-diagram, deep-dive.md, master diagram — and is tagged
[ ] Diagram types are mixed (flowchart / sequence / state), not all flowcharts
[ ] Mermaid: labels quoted, `>` escaped, `direction TB` in subgraphs, previewed and renders

DEEP-DIVE MARKING (Rule 6)
[ ] All depth lives in deep-dive.md; it opens with the `> **deep-dive**` banner
[ ] deep-dive.md sections all carry 🟢 / 🟡 / 🔴 tiers
[ ] Any deep passage outside deep-dive.md is in a collapsed <details> block whose summary says "deep-dive"
[ ] README.md, simple-diagram.md, questions.md contain ZERO deep-dive blocks
[ ] No collapsed deep-dive block is load-bearing — the short answer stands alone

CONTENT
[ ] questions.md: 8 levels, continuous numbering, italic goals, failure-mode Qs, bonus QBs
[ ] answers.md: every Q answered, each with table OR code, each ends with **Key takeaway**
[ ] answers.md: pattern instances LINK to patterns/ instead of re-deriving
[ ] answers.md: ⚡ cheat sheet (scale · tech w/ primitive+AWS+native · patterns · tradeoffs · mistakes)
[ ] simple-diagram.md: simple model + pen version + components table + "one idea" + detailed + protocols
[ ] simple-diagram.md: 4-column service cheat-sheet (Primitive | AWS | Native/OSS | Why) + AWS gotchas
[ ] README.md: how-to-use names every file; files table; learning path; Patterns-in-play table
[ ] README.md: "<Topic> in an Interview" — when to use / where it breaks / five sentences that score
[ ] README.md: senior-thinking section written LAST
[ ] deep-dive.md: 🟢 analogy · 🟡 code+table · 🔴 capacity math or failure mode · ≥15-row cheat sheet

FINISH
[ ] Master diagram (§5.1): one screen · Tier D reduction below it · numbered flow · AWS+pattern
    annotations · red on hard parts · narration + 5 numbers + patterns + 3 failures + "one thing"
[ ] (Optional, if rehearsing) §5.2 transcript added — timestamped R→A→D→I→O, numbers reused
[ ] Cross-links between related topics + down into patterns/ and fundamentals/
[ ] New AWS rows pushed back to docs/AWS_SERVICE_MAP.md
[ ] New recurring sub-problem added to the patterns/README.md gap list
[ ] ROADMAP.md updated (dashboard counts + status line + quick-ref row)
[ ] Accuracy pass: hedged numbers, no invented sources/APIs, AWS limits marked ⚠️ verify
```

---

## 9. Quality bar — self-review before calling it done

Ask these out loud.

- **Can I read any page of this aloud without stumbling?** If not, the sentences are too long (Rule 2).
- **Can I draw every Tier D diagram from memory in 90 seconds, with a pen?** If not, it has too many boxes (Rule 3).
- **Can a candidate whiteboard the whole system from `diagrams.md` alone?** If not, a diagram is missing.
- **Can they rebuild the topic from the master diagram in 90 seconds?** Needing a second file means it isn't doing its job.
- **Does every answer give something defensible to *say*, not just facts to know?** The Key takeaway is that sentence.
- **Is the central split obvious in the first screen of the README and Diagram 1?**
- **Is every service name preceded by the primitive it implements?** A bare service name is a name-drop (Rule 5).
- **Does the folder route to `patterns/` instead of re-deriving ladders?** The same contention/saga reasoning in three folders belongs in a pattern file.
- **Is every deep passage marked and collapsed?** A first-pass reader must be able to skip all of it and still pass (Rule 6).
- **Does every subsystem in the source appear somewhere here?** Thin is fine. Missing is not (Rule 7).
- **Could I have written this without reading the source?** If yes, you reformatted a summary. Go back to the source.
- **Would this survive a fact-check?** No unverifiable numbers as fact, no invented citations, no unmarked AWS quotas.
- **Do the failure-mode questions have real incident-response answers?** Not hand-waving.

---

## 10. Order of operations

0. **If the topic has a source doc, read it and fill the compression worksheet** ([§3.3](#33-the-compression-worksheet)). Sort every concept into explain / name / cut *before* writing a word. This decides the whole folder.
1. **Name the central split and the patterns in play.** One sentence plus the reverse-index row. Everything hangs off this.
2. Draft `questions.md`. It defines scope and levels. Its levels should track your EXPLAIN list.
3. Write `simple-diagram.md`. It forces you to commit to the split. Fill the 4-column primitive/AWS/native cheat-sheet here first — later files reuse it.
4. Write `answers.md`. The substance. Key takeaways crystallize each point. Link out to `patterns/`.
5. Write `diagrams.md` diagrams 1–N. Diagram 1 = the split. All Tier D, each with draw order and spoken lines.
6. Write `deep-dive.md`. Move any depth that leaked into steps 3–5 in here.
7. Write `README.md` — especially "in an Interview" and "How a Senior Engineer Thinks".
8. **Write the One-Page Master Diagram last** (§5.1). It compresses everything above, so it can only be written once the rest exists. It's also the first thing you'll read when revising.
9. (Optional) `conducive-sentences.md` prose pass, or the §5.2 transcript if you're rehearsing this topic.
10. Update `ROADMAP.md` and cross-links. Push new AWS rows to `AWS_SERVICE_MAP.md` and new sub-problems to the `patterns/` gap list. Accuracy pass. Preview all Mermaid.
11. **Read-aloud pass.** Last thing, always. Fix every sentence that made you stumble.
