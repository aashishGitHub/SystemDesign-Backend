# Topic Template — How to Build a New Study Topic

> Copy this file when starting a new topic.
> Fill in each section by following the instructions in [TEMPLATE_INSTRUCTIONS.md].
> Every topic folder must have exactly 4 files: README.md, questions.md, answers.md, deep-dive.md

---

## File 1: README.md Template

```markdown
# System Design: [TOPIC NAME]

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.

---

## How to Use This Guide

1. First pass — attempt every question yourself before reading the answer.
2. Second pass — read the answers, compare, note what you missed.
3. Third pass — whiteboard the full system from memory. No notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|-------|-------|-------------|
| 1 | [Level name] | [What] |
| 2 | [Level name] | [What] |
| ... | ... | ... |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | All questions, organized by level. Read first. |
| [answers.md](./answers.md) | Full answers with code examples and tradeoff tables. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations — beginner to architect level. |

---

## The Problem Statement

> [state the interview problem exactly as an interviewer would]

**Key Constraints:**
- [constraint 1]
- [constraint 2]
- [constraint 3]

---

## How a Senior Engineer Thinks About This

[2–3 paragraph framing of the mental model — how to break this problem down at a high level]
```

---

## File 2: questions.md Template

```markdown
# Interview Questions: [TOPIC NAME]

> Attempt each question before reading [answers.md](./answers.md).

---

## Level 1 — [Name] (Beginner)
*[One-line description of who this level targets]*

**Q1.** [Question]
**Q2.** [Question]
...

## Level 2 — [Name]
**Q6.** [Question]
...

## Level N — [Name] (Architect / Staff)
**QN.** [Question]

---

## Bonus — Questions a Senior Brings Up Unprompted
**QB1.** [Question that shows proactive thinking]
```

**Rules for writing questions:**
- Start at "explain this to a non-engineer" level
- End at "how would you handle this at Google scale with 5 nines availability"
- Every question should have one specific defensible answer — no open-ended opinion polls
- Include at least one question about failure modes per level
- Include at least one question that catches a common misconception

---

## File 3: answers.md Template

```markdown
# Answers: [TOPIC NAME]

> Keyed to [questions.md](./questions.md). Read questions first.
> Code examples use TypeScript/JavaScript analogies where helpful.

---

## Level 1 — [Name]

### A1. [Short answer title]

[Answer — 2–4 paragraphs. Code example where relevant.]

---

## Quick Recall Cheat Sheet (bottom of file)

| Concept | One-Line Recall |
|---------|----------------|
| [Concept] | [One sentence that triggers full recall] |
```

**Rules for writing answers:**
- Every answer must have a concrete code snippet OR a comparison table
- Never say "it depends" without immediately specifying what it depends on and which answer to give in each case
- Every tradeoff must be a named tradeoff (e.g., "consistency vs availability", "latency vs throughput")
- End every answers.md with a 10–20 row cheat sheet table

---

## File 4: deep-dive.md Template

```markdown
# Deep Dive: [TOPIC NAME]

> Three reading levels per section:
> 🟢 Beginner — analogy-based, no jargon
> 🟡 Senior — mechanics, code, tradeoffs
> 🔴 Architect — failure modes, capacity math, design review depth

---

## Table of Contents

1. [Section 1 title](#section-1)
2. [Section 2 title](#section-2)
...
N. [Quick Recall Cheat Sheet](#cheat-sheet)

---

## 1. [Section Title]

### 🟢 Beginner — [Analogy Title]
[Real-world analogy first. No jargon.]

---

### 🟡 Senior — [Mechanism Title]
[How it actually works. Code example. Tradeoff table.]

---

### 🔴 Architect — [Production Title]
[Failure modes. Capacity planning math. Config decisions. What to say in a design review.]

---

## Quick Recall Cheat Sheet

| Concept | One-Line Recall |
|---------|----------------|
| [Concept] | [Recall trigger] |
```

**Rules for deep-dive:**
- Every chapter must have all three sections (🟢 🟡 🔴)
- 🟢 must use a non-technical analogy from daily life
- 🟡 must include at least one code block and one comparison table
- 🔴 must include at least one of: capacity math, failure mode analysis, Grafana alert expression, circuit breaker, or chaos engineering scenario
- Final section is always the cheat sheet

---

## Quality Checklist Before Marking a Topic "Done"

Use this before updating ROADMAP.md status to ✅ Done:

**README.md:**
- [ ] Problem stated clearly (copy exact interview phrasing)
- [ ] Constraints listed
- [ ] Learning path table with all levels
- [ ] File index links work
- [ ] "How a Senior thinks about this" section present

**questions.md:**
- [ ] Minimum 30 questions total
- [ ] At least 8 distinct levels
- [ ] Starts at beginner (no prior knowledge), ends at architect (design review depth)
- [ ] Every question has exactly one correct answer direction (not opinion)
- [ ] ≥1 failure mode question per level
- [ ] ≥1 "what goes wrong if you...?" question
- [ ] Bonus section with 3+ "unprompted" senior questions

**answers.md:**
- [ ] Every question answered (A1 → QN, no gaps)
- [ ] Every answer has code OR comparison table
- [ ] No "it depends" without follow-through
- [ ] Real-world company examples named (Netflix, Google, Amazon, etc.)
- [ ] Cheat sheet at bottom with ≥10 rows

**deep-dive.md:**
- [ ] Table of Contents with working links
- [ ] Every section has 🟢 🟡 🔴 subsections
- [ ] 🟢 uses daily-life analogy
- [ ] 🟡 has code block + table
- [ ] 🔴 has capacity math or failure mode analysis
- [ ] Cheat sheet at bottom with ≥15 rows
- [ ] At least one "real production incident" or "what Netflix/Google did" story per major section
