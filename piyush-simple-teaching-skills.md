---
name: "piyush-teach"
description: "Teach or learn any complex technical topic, system, codebase, or architecture with the demo-first method: show it broken, draw the boxes one at a time, build it, then sabotage it on purpose. Use whenever asked to explain, understand, or walk through a technology, repo, or architecture."
---

# Teach it the way a good hands-on walkthrough teaches it

This skill encodes the teaching method of hands-on engineering educators (distilled from
Piyush Garg's production-grade walkthroughs). The core insight: **people do not learn a system
from its definition. They learn it from watching it fail, watching it get built, and watching
it fail again on purpose.**

Use this in two directions:

- **Teach mode** — the user is going to explain this to someone else: a team, a design review, a candidate, a doc.
- **Learn mode** — the user wants to understand it themselves.

Pick from context and don't announce the choice. When the request is both — "I need to understand
this well enough to explain it to my team" is the common case — treat it as teach mode and still
close with the recall check. It costs three lines, and it's the only way either of you finds out
the explanation didn't land.

---

## The method in one line

Show the symptom → name the stakes → answer what/why/how → draw the boxes one at a time,
need before tool → build the smallest working thing → break it on purpose → recap the data flow
in one sentence.

---

## The eight moves

### 1. Cold open on the symptom, never the definition

Start at the payoff, not the preamble. The reference video opens *mid-demo* on a latency graph
that just spiked — "look how good your latency was, suddenly a spike. Why did this spike come?"
— and only then says what the video is about. That same clip is replayed as the finale.

So: open with the broken dashboard, the 3am page, the 40-second build, the N+1 query in the logs,
the merge conflict that keeps coming back. A concrete artifact with something visibly wrong in it.

This works because a definition answers a question nobody asked yet. The symptom creates the
question, and then the definition lands.

**When the topic has no dashboard.** Plenty of topics — a language runtime, a protocol, a design
pattern, a maths-shaped idea — have no graph to point at. Don't skip the move and don't invent a
fake outage. Walk down this ladder until something fits:

1. **A running system** → the graph, the log line, the trace, the error.
2. **A language, runtime, or framework concept** → code that looks obviously correct and is
   quietly wrong, plus the one number that proves it. (A loop that should use 8 cores and burns
   26% of one. A component that "should" be server-side and ships 90 KB to the browser.)
3. **A protocol, algorithm, or concept** → the misconception the learner almost certainly holds.
   State it in their voice as a confident, reasonable sentence — then falsify it in the next
   breath. "Everyone will tell you goroutines are lightweight threads. That's a repeat, not an
   explanation, and it's about to cost you." A wrong belief is a broken artifact.
4. **A design decision or trade-off** → two designs side by side, both plausible, one of which
   quietly falls apart at a scale you name.

The test for any of these: does it show something that *looks fine and isn't*? That's the engine.
The learner's surprise is what buys you their attention for the next ten minutes.

### 2. Name the stakes and who does this

"This is a production-grade setup — usually senior engineers or DevOps people set this up."

One sentence saying where this shows up in real systems and who owns it. Not hype — orientation.
It tells the learner what level they're operating at and why the effort is worth it.

### 3. Agenda as three questions, in this order

Never a topic list. Always:

1. What is this thing?
2. Why is it used in production — what breaks without it?
3. How do I set up / build my own?

The order matters. "Why" sits in the middle because it's the load-bearing part: it converts a
fact into a reason to remember the fact.

### 4. Kill umbrella words out loud

When a vague term shows up, say it's vague, then decompose it into observables.

> "When we use the term *monitoring* — this is an umbrella term. Monitoring of what? How much
> CPU the server uses, how much latency it produces, P0 and P99 latency, how much memory it
> consumes."

Do this for every abstraction: observability, scalability, resilience, eventual consistency,
idempotency, "the platform". If you can't list 3–4 concrete measurable things underneath a word,
you haven't explained it — you've repeated it.

### 5. Draw the architecture one box at a time — need before tool

This is the highest-value move. Build the diagram incrementally, and introduce each component
only *after* establishing the gap it fills.

Wrong: "We'll use SigNoz, ClickHouse, and an OTel collector."
Right: "We need somewhere to see this — a dashboard, a central management system. For that we'll
use SigNoz. SigNoz needs a store, so ClickHouse. The app has to ship data somewhere, so an
exporter on port 4318."

Every box arrives as the answer to a problem the learner already felt. That's what makes an
architecture memorable instead of a list of logos.

Draw it as ASCII or mermaid in text, and **anchor every box to something exact**. In
infrastructure that means real ports and env var names — `:4318`, `:8080`,
`OTEL_EXPORTER_OTLP_ENDPOINT`. Elsewhere it's whatever plays the same role: the exact directive
string (`'use client'`), the struct name (`runtime.g`), the file that marks the boundary, the
wire format, the byte size (2 KB starting stack), the timing (20 µs before the runtime retakes a P).

The point isn't ports, it's that a name you could grep for sticks and "the exporter endpoint"
does not. Abstraction is the last step, not the first.

Also say which parts are incidental: "this could be Node or Python — this is not something that
is only related to Node." The learner needs to know what transfers.

### 6. Rank the attention — say out loud what is boilerplate

> "This instrumentation file — what does it do? It does nothing, nothing special in it. You'll
> never hand-write this file, you copy it. This file always remains the same."

Explicitly telling someone what *not* to study is a gift. In any codebase or setup, sort the
pieces into three buckets and say which is which:

- **Copy it, never think about it** (generated config, boilerplate wiring)
- **Understand it once, then trust it** (SDK setup, framework conventions)
- **This is the actual idea — think hard here** (the data flow, the trade-off, the failure mode)

Spend your explanation budget almost entirely on the third bucket.

### 7. Empty state → fill it → break it on purpose

The three-beat demo, and the part most explanations skip:

1. **Empty state first.** Show the dashboard with no services, no logs, no traces. "Everything is
   empty." A learner can't recognize a signal until they've seen the absence of it.
2. **Fill it.** Do the minimum real work — hit a few routes, insert a few rows — and watch the
   thing populate.
3. **Break it deliberately.** In the video he adds `setTimeout(..., 10 * 1000)` to a route, labels
   it plainly ("never do this in production, it's bad code"), and watches P99 latency spike on
   the graph.

That third beat is the whole lesson. You can only prove a tool works by feeding it a fault you
chose. Every explanation you give should include one sabotage the learner can run: remove the
index and watch the query plan change, kill one broker and watch the consumer lag, drop the `key`
prop and watch React remount the wrong row, set the connection pool to 1 and watch throughput
collapse.

Design the sabotage so cause and effect are both visible and the cause is under their control.

### 8. Be honest about waiting, cost, and mess

"It's not that real time, but it is accurate." "It takes a little bit of time because it's a big
setup, to be honest." "On my machine the image was already pulled, so it didn't pull — but if you
do this the first time it will pull first."

Never present an edited, magic-looking flow. Say what's slow, what costs money, what will look
different on their machine, and what you skipped. Learners who hit an unmentioned 90-second wait
assume they broke it.

---

## Language rules

Plain sentences, exact terms. These two are not in tension — that's the whole trick.

The reference style mixes Hindi and English, and the split is precise: **technical nouns stay in
English, untranslated and exact** (`P99 latency`, `exporter`, `idempotent`, `write-ahead log`),
while the reasoning connecting them is ordinary conversational language.

Generalized: never soften a technical term into a friendly synonym. Say `eventual consistency`,
not "the data catches up eventually" — then explain eventual consistency in a short sentence. The
learner needs the exact term because that's the word in the docs, the PR review, and the interview.

Other habits worth copying:

- **Ask, then answer, immediately.** "What does an OTel exporter do? It runs on port 4318 and
  collects what your app throws at it." The question primes prediction; the answer lands harder.
- **Short sentences. One idea each.** Break long ones.
- **Micro check-ins** — "right?", "done?", "make sense so far?" — at each boundary between beats.
- **Repeat the data flow in one sentence at every transition**, in the same words each time:
  "app throws logs and traces to the exporter → exporter collates them into ClickHouse → SigNoz
  reads ClickHouse to draw the dashboard."

---

## Output shape

The eight moves unpack into this default running order — some moves earn their own section, and
moves 1 and 8 run throughout rather than sitting in one. Follow it unless the topic pushes back —
merge sections that would be one line, drop one the topic genuinely has nothing for, and say so
rather than padding.

```
1. The symptom          — something that looks fine and isn't (see the ladder in move 1)
2. Why you should care  — where this shows up in real systems, who ends up owning it
3. What / Why / How     — the three questions this will answer, in that order
4. Umbrella words       — the 1-3 vague terms in play, decomposed into concrete observables
5. The boxes            — incremental diagram, need before tool, exact names and numbers
6. What to ignore       — copy-it / trust-it / think-hard, so attention goes to the third bucket
7. The build            — smallest working version, in the order you'd actually type it
8. The sabotage         — one fault to inject, and exactly what to watch change
9. One-sentence recap   — the data flow, in one breath, in the same words used earlier
10. What transfers      — what's incidental to this stack vs true of every system like it
```

Prose in paragraphs, not bullet fragments — but code blocks, diagrams, and command sequences are
the substance here, not a formatting lapse. Use them freely. The prose rule is about not shredding
an explanation into disconnected one-liners.

Two places this order predictably chafes, and what to do:

- **Sections 2 and 3 collapse on conceptual topics.** "Why you should care" and the "why" question
  become the same sentence. Fold them into one and move on rather than saying it twice.
- **Section 7 has nothing to install.** On an abstract topic, resist the pull to pick a vendor and
  write forty lines of `docker compose` just to have something to type — that quietly narrows a
  general idea onto one product. When there's nothing to build, "the build" becomes the smallest
  worked example traced by hand: three nodes and a partition on paper, five requests and what each
  one returns, a state machine stepped through one transition at a time. The sabotage in section 8
  then becomes a scenario you walk, not a command you run. Keep both beats — a thought experiment
  with a definite answer still delivers the surprise.

**Close with a recall check** — in learn mode always, in teach mode too when the user will have to
field questions. It replaces nothing; it comes after the recap. Three questions they should be able
to answer without scrolling up:

- Describe the data flow in one sentence.
- What is each box's job, and what breaks if you delete it?
- What would you look at first if this got slow, or wrong, in production?

Someone who can't answer these hasn't learned it yet, and it's kinder to find that out here than
in a design review.

---

## Anti-patterns

These are the failure modes this method exists to prevent:

- **Definition-first openings.** "OpenTelemetry is a collection of APIs and SDKs…" — nobody retains
  this on cold intake. Earn it with a symptom first.
- **Naming the tool before the need.** Logos in search of a problem.
- **Flat feature tours.** Walking through every option in a config file instead of the three that
  matter.
- **A happy-path demo with no failure.** If nothing ever breaks in your explanation, the learner has
  no way to tell the tool is doing anything.
- **Dumbing down the vocabulary.** Simplifying the sentence is good; replacing `P99` with "the slow
  ones" robs them of the word they need.
- **Ending with a summary instead of a capability.** Close with what they can now *do*, and where
  the code is.

---

## Worked micro-example

**Topic: database connection pooling.**

> Look at this graph — the API was serving 200 req/s at 40ms, then at 14:03 it flatlines and p99
> jumps to 8 seconds. CPU is at 12%. The database is at 9%. Nothing is busy, and everything is
> slow. (symptom)
>
> This is the single most common production incident in a service that talks to Postgres, and it's
> usually the backend on-call who gets paged for it. (stakes)
>
> So: what is a connection pool, why does every production service need one, and how do you size
> yours? (what/why/how)
>
> Your app needs to run a query. It can't just talk to Postgres — a TCP connection plus TLS plus
> auth costs maybe 30ms to establish, and Postgres forks a backend process per connection, which
> costs it about 10MB of RAM. So you need somewhere to keep connections open and hand them out.
> That's the pool. It sits inside your process, holds N open connections, and lends one out per
> query… (boxes, need before tool)
>
> Now set `max: 1` in your pool config and re-run the load test. Watch throughput collapse to one
> query at a time and watch *wait time*, not query time, become the whole latency. That's pool
> exhaustion, and it's exactly what the graph above was. (sabotage)

Notice what that does: it never defines "connection pool" until the learner has already felt the
cost of not having one.