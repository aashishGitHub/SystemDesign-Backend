# Deep Dive: Search Autocomplete / Typeahead

> Three reading depths per section:
> - 🟢 **Beginner** — intuitive analogies, no jargon
> - 🟡 **Senior** — implementation mechanics, code, tradeoff tables
> - 🔴 **Architect** — failure modes, capacity math, production decisions
>
> ⚠️ Capacity numbers throughout are **illustrative order-of-magnitude** estimates for reasoning,
> not exact figures — they depend on language, encoding, and data distribution. The arithmetic is
> shown so you can re-run it with your own inputs.

---

## Table of Contents

1. [What Autocomplete Is: The Read Path End-to-End](#1-what-autocomplete-is-the-read-path-end-to-end)
2. [Trie Fundamentals: Why Not a Hash Map](#2-trie-fundamentals-why-not-a-hash-map)
3. [Trie Design: Nodes, Memory, and Compression](#3-trie-design-nodes-memory-and-compression)
4. [Top-K Stored at Each Node](#4-top-k-stored-at-each-node)
5. [The Update Pipeline: Batch vs Streaming (Kafka + Flink)](#5-the-update-pipeline-batch-vs-streaming-kafka--flink)
6. [Hot-Swap Deploy and Trie Versioning](#6-hot-swap-deploy-and-trie-versioning)
7. [Scaling Out: Sharding vs Replication](#7-scaling-out-sharding-vs-replication)
8. [The Redis Prefix Cache: Eviction and Stampede](#8-the-redis-prefix-cache-eviction-and-stampede)
9. [Personalization and Serve-Time Filtering (Takedowns)](#9-personalization-and-serve-time-filtering-takedowns)
10. [Operations, Failure Cascades, and Capacity Math](#10-operations-failure-cascades-and-capacity-math)
11. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. What Autocomplete Is: The Read Path End-to-End

### 🟢 Beginner — The Helpful Librarian

You walk up to a librarian and start saying "I'm looking for a book about ap…" and before you
finish, she says: "Apple farming? Apples in cooking? Application development?" She isn't reading
every book on every shelf while you wait — that would take hours. She has already memorized the
five most-requested books for every way a request can start, and she blurts them out the instant
she hears the first few sounds.

That is autocomplete. The whole trick is that the answers are **prepared in advance**. Nobody
computes anything expensive while your cursor is blinking. The system just walks to a spot that
says "ap" and reads off a list somebody prepared earlier.

The one rule that governs everything: it has to feel **instant** — under about a tenth of a second —
or it feels broken and people ignore it.

---

### 🟡 Senior — Every Hop From Keystroke to Dropdown

Autocomplete returns the top-K most likely **completions** of a prefix, ranked by
popularity/relevance, within a tight latency budget (usually **< 100 ms** end-to-end so it feels
instant while typing).

```
Typing "a" → 5 suggestions:

1. Browser debounces keystrokes (~100–300 ms) so it doesn't fire on every char
2. GET /autocomplete?q=a  → nearest edge / API gateway
3. Gateway → autocomplete service (auth, rate limit)
4. Service checks Redis prefix cache  → HIT: return top-5 immediately
                                      → MISS: query the trie service
5. Trie service walks to the node for "a", reads its precomputed top-5 list
6. (Optional) blend with the user's personal history + apply safety filter
7. Response (5 strings) → browser renders dropdown
```

The entire design is under **latency pressure**. Every hop must be cheap, which is *why* results are
**precomputed** (top-K stored at nodes, §4) rather than computed per request. The only variable
work per request is a walk of length L (the prefix length) plus a list read — both tiny.

| Stage | Typical time | Notes |
|---|---|---|
| Debounce wait | ~100–300 ms | Client-side; not server time, but dominates *perceived* latency |
| Edge/gateway RTT | ~10–20 ms | Geographic; minimized by regional PoPs |
| Redis cache GET | ~1 ms | Serves the head of the distribution |
| Trie walk (on miss) | ~1–5 ms | O(L), independent of corpus size |
| Blend + filter | ~1–3 ms | Personalization re-rank + denylist |
| **Server total** | **~5–25 ms** | Comfortably under a 100 ms P99 budget |

---

### 🔴 Architect — Where the Latency Budget Actually Goes

Autocomplete is one of the rare systems where the **client-side debounce dominates perceived
latency** and the server work is nearly free — *by design*. If your server work is not nearly free,
you have skipped precomputation somewhere.

```
Budget decomposition for a 100 ms P99 "feels instant" target:

  Debounce           150 ms   ← intentionally spent to suppress request volume
  Network RTT     10– 20 ms   ← real, and the main thing multi-region deployment attacks
  Server compute   5– 25 ms   ← should be cache/precompute reads only
  Render            1–  5 ms

  Insight: you do NOT have a 100 ms server budget. Subtract debounce and network and
  you have ~20–30 ms. That is why per-request DFS of a trie subtree (§4) is disqualified:
  it can touch millions of nodes and blow the budget by orders of magnitude.
```

**Design-review talking points:**
- Push work to **build time** (precompute top-K) and **cache time** (Redis head), never request time.
- Autocomplete must **fail soft**: an empty dropdown or a slightly stale suggestion is acceptable;
  an error or a spinner is not. Every downstream dependency needs a fallback that returns *something*.
- The debounce is a **load-shedding primitive**, not just UX polish — dropping from every-keystroke
  to one-request-per-pause cuts QPS by 3–5×.

**Real-world framing (illustrative):** Google publicly describes Search autocomplete as predicting
queries you're likely to type, and treats it as a latency-critical product surface. The exact
internal numbers are not public — treat any specific figure you hear as unverified — but the
architectural principle (precompute + serve, never compute-on-type) is standard across every large
typeahead system, including Elasticsearch's completion suggester, which builds a purpose-built
in-memory FST at index time precisely so query-time work is O(prefix length).

---

## 2. Trie Fundamentals: Why Not a Hash Map

### 🟢 Beginner — The Filing Cabinet vs the Family Tree

Imagine you want every word starting with "cat". 

A **hash map** is like a filing cabinet where every word is filed by a scrambled code. "cat",
"category", and "cathedral" are scattered into three totally unrelated drawers. To find everything
starting with "cat" you'd have to open *every drawer in the building* and check each folder. Fast if
you know the exact word; useless for "starts with."

A **trie** is like a family tree. You walk down: c → a → t, and now you're standing at the "cat"
ancestor. Everyone descended from that spot — category, cathedral, catalog — is right below you. You
found the whole family in three steps, no matter how big the tree is.

---

### 🟡 Senior — The Prefix Relationship Is Structural

A hash map gives **O(1) exact-key** lookup but has **no notion of prefixes** — keys are scattered by
hash, so "find all queries starting with 'app'" requires scanning **every** key: O(N). A **trie**
stores strings by shared prefix along a path, so reaching the "app" node is **O(L)** (L = prefix
length) and everything in that subtree is exactly the set of completions. The trie **encodes the
prefix relationship in its structure**; the hash map destroys it.

| Structure | Prefix lookup | Exact lookup | When to choose |
|---|---|---|---|
| **Trie** | **O(L)**, independent of N | O(L) | Prefix search / autocomplete — the default |
| **Sorted list + binary search** | O(L · log N) to find range start, then scan | O(L · log N) | Small/static datasets; simpler than a trie |
| **Hash map** | **O(N) scan** (can't do prefixes) | O(L) | Exact-match only, never prefix |

The headline property: **trie lookup cost depends on prefix length, not corpus size.** Ten queries
or ten billion, "app" is the same 3 hops. This is the single most important fact to state in an
interview.

```ts
// Minimal, logically-complete trie insert + prefix search
class TrieNode {
  children = new Map<string, TrieNode>();
  isEndOfWord = false;
}

function insert(root: TrieNode, word: string): void {
  let node = root;
  for (const ch of word) {                 // O(word length)
    if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
    node = node.children.get(ch)!;
  }
  node.isEndOfWord = true;                  // mark terminal
}

function findPrefixNode(root: TrieNode, prefix: string): TrieNode | null {
  let node = root;
  for (const ch of prefix) {               // O(prefix length L) — the key property
    const next = node.children.get(ch);
    if (!next) return null;                // trie miss (see §10)
    node = next;
  }
  return node;                             // subtree under here = all completions
}
```

---

### 🔴 Architect — The Complexity Argument in a Design Review

The complexity claim is subtle and interviewers probe it. Be precise:

```
Prefix walk:      O(L)         — L = length of the typed prefix, NOT corpus size N.
Enumerate all
completions:      O(subtree)   — this is the expensive part, and it IS corpus-dependent.

The whole point of "top-K at node" (§4) is to remove the second cost:
  walk = O(L),  read precomputed list = O(1)  →  total O(L), fully corpus-independent.

Without precompute you pay O(L + subtree) per request. For a short prefix like "a" the
subtree can be a large fraction of the entire corpus → this is the disqualifying cost.
```

**Talking point:** the reason autocomplete is a *systems* problem and not a *data-structures*
homework is that the naive correct algorithm (walk + DFS the subtree + heap-select top-K) has cost
that scales **inversely** with usefulness: short prefixes are typed most often *and* have the
biggest subtrees. Precomputation flips that so the hottest prefixes are the cheapest to serve.

---

## 3. Trie Design: Nodes, Memory, and Compression

### 🟢 Beginner — Signposts Along a Road

Picture each letter as a signpost on a road. To spell "app" you pass three signposts: a, then p,
then p. Some signposts are just "keep going" markers (you're mid-word). Others have a little flag on
them that says "a real word ends here." The word "app" has a flag *and* the road keeps going toward
"apple" — so a signpost can be both a finished word and a stop on the way to a longer word. That flag
is why we can't just assume "the end of the road = a word."

---

### 🟡 Senior — Node Anatomy and the Insert Walkthrough

```ts
class TrieNode {
  children: Map<char, TrieNode>; // or fixed array[26/128] for a known alphabet
  isEndOfWord: boolean;          // true if a stored query terminates here
  topK: SuggestionRef[];         // precomputed top-K completions under this node (§4)
  // optional: frequency (if this node is itself a complete query)
}
```

Inserting `["apple", "app", "application", "apt"]` (order does not affect the final structure):

```
        (root)
          │ a
          a
          │ p
          p
        ┌─┴──────────┐
        p★(app)      t★(apt)
        │
        l
        │
        e★(apple)
        │
        (…c-a-t-i-o-n)★(application)
```

`isEndOfWord` (★) marks nodes where a stored query **terminates**: `true` at `app`, `apt`, `apple`,
`application`; `false` at shared prefix nodes (`a`, `ap`, `appl`). "app" being a word **and** a
prefix of "apple" is exactly why you need an explicit flag rather than "leaf = word."

- **Internal node:** has children, `isEndOfWord=false` — a prefix, not itself a query.
- **Leaf / end node:** `isEndOfWord=true`; may have no children (`apt`) or children (`app`).

Memory per node (illustrative; language/encoding dependent):

| Field | ~Bytes | Note |
|---|---|---|
| `children` map (overhead + entries) | ~50–150 | **Dominant cost** — a hashmap per node is expensive |
| `isEndOfWord` | 1 | often padded to word boundary |
| `topK` (5 × 4-byte IDs) | ~20 | store IDs, not strings (§4) |
| object/GC header | ~16 | managed runtime overhead |

So **~100–200 bytes/node** in a managed runtime. **Branching factor** matters enormously: a fixed
`array[26]` of pointers is fast but wastes space on sparse nodes (26 × 8 = 208 bytes even for one
child); a `Map` is compact for sparse nodes but adds per-entry overhead.

---

### 🔴 Architect — Compression and the Cold-Start Failure

| Technique | Idea | Tradeoff |
|---|---|---|
| **Radix / Patricia trie** | Merge chains of single-child nodes into one edge holding a substring | Far fewer nodes; slightly more complex insert/split logic |
| **DAWG** (directed acyclic word graph) | Also **share common suffixes** (merge equivalent subtrees) | Minimal memory; **hard to mutate** (near read-only); can't easily store per-node top-K |
| **Double-array trie** | Compact array encoding of transitions | Very cache-friendly, memory-lean; complex to build/update |
| **FST** (finite-state transducer) | Shared prefixes *and* suffixes with output values on edges | Used by Lucene/Elasticsearch completion suggester; built offline, immutable |

Named tradeoff: **memory vs. update flexibility.** The smallest structures (DAWG, FST,
double-array) are effectively **immutable** — which is *fine*, because production autocomplete builds
a compact **read-only** structure offline and **hot-swaps** it (§6) rather than mutating in place.

**The 8 GB cold-start failure (real class of incident):**

```
Trie snapshot is 8 GB, loaded into memory on server startup.

First 90 seconds after a restart:
  - Object-graph deserialization of 8 GB → server can't serve (or serves cold/empty)
  - If a rolling deploy restarts many replicas near-simultaneously → capacity dip cascades

Mitigations:
  1. Rolling restarts (never all at once) so healthy replicas absorb traffic
  2. Readiness probes: keep the node OUT of the load balancer until the trie is loaded
  3. mmap the snapshot (flat, mmap-able format) → paged in lazily, no 90 s blocking load
  4. Warm standby / pre-warmed instances swapped in
  5. Snapshot format = flat structure, NOT an object graph → load is a memcpy, not a parse
```

**Design-review talking point:** the choice of trie representation is really a choice about your
*deploy* story. If you pick a mutable object-graph trie, you've signed up for slow cold starts and
GC pressure; if you pick a flat mmap-able immutable structure, cold start is nearly free but every
update is a full rebuild. Large systems pick the latter and invest in the build pipeline (§5).

---

## 4. Top-K Stored at Each Node

### 🟢 Beginner — The Pre-Written Cheat Sheet

Back to the librarian. She could, every time you say "ap", sprint through the whole "ap" section
counting how popular each book is, then hand you the top five. That's exhausting and slow.

Instead, once a night, she writes a little sticky note at every shelf marker: at the "ap" marker the
note lists the five most popular "ap" books, already ranked. During the day she just reads the
sticky note. Answering is now "walk to the marker, read the note" — instant, no counting.

The cost: she has to write a lot of sticky notes, and they're a little out of date until she
rewrites them tonight. That's the whole bargain of autocomplete: **spend memory and freshness to buy
speed.**

---

### 🟡 Senior — Precompute the List, Read It in O(1)

Each prefix node stores its **precomputed top-K completions** (as string IDs + score), computed
offline from frequency data. On query you walk to the node (O(L)) and return its list (O(1)) — **no
traversal.** This trades **memory** (top-K × every node) for **query speed** (constant-time read),
and is the central optimization of production autocomplete.

```ts
// Building top-K at every node, bottom-up (offline build job).
// Each node's top-K = merge of its children's top-K, plus itself if it's a word.
function buildTopK(node: TrieNode, K = 5): SuggestionRef[] {
  const candidates: SuggestionRef[] = [];
  if (node.isEndOfWord) candidates.push(node.selfRef);   // this node is itself a query
  for (const child of node.children.values()) {
    candidates.push(...buildTopK(child, K));              // children already reduced to their top-K
  }
  // keep only the K highest by score (partial sort / heap)
  candidates.sort((a, b) => b.score - a.score);
  node.topK = candidates.slice(0, K);
  return node.topK;
}
```

Because each child already returns *only its own* top-K, a parent never merges more than
`(branching factor × K + 1)` candidates — the build is linear in node count, not in subtree size at
every level.

**Query time:**
```
1. findPrefixNode("app")   → O(L), L=3
2. return node.topK.slice(0, 5)   → O(1)
```

**Full string vs. ID pointer** in each node's list:

| | Full string per node | ID → shared string table |
|---|---|---|
| Memory | Duplicated across every ancestor's top-K → huge | Stored once; nodes hold 4-byte IDs |
| Lookup latency | Zero indirection | One extra table lookup (cheap, cache-friendly) |

Named tradeoff: **memory vs. one indirection.** A popular query appears in the top-K of *all its
prefixes* (`e`, `ea`, `ear`, … for "earthquake"), so deduping via a string table is a large win.
Store **IDs**.

---

### 🔴 Architect — Propagation Cost and Graceful Staleness

**When a query surges** (e.g., "earthquakeSF" jumps from rank 200 to rank 2), its new score must
propagate into the top-K list of **every ancestor prefix node** along its path: `e, ea, ear, …,
earthquakeSF`.

```
Worst case per surging query: O(L) ancestor lists to re-evaluate
  (L = query length), each a cheap bounded top-K merge (branching × K candidates).

Batch/offline rebuild: you don't do this incrementally at all — top-K is recomputed
  during the periodic rebuild (§5). Incremental O(L) propagation is only needed for
  real-time trending, and even then it's O(L) ancestors, never the whole trie.
```

**Staleness is a feature, not a bug — if you design for it.** Suppose the update pipeline falls
3 hours behind:

```
User-visible effect: outdated RANKINGS — new/trending queries missing, recently-popular
  items ranked too low. This is DEGRADED, not broken: old suggestions are still valid.

Graceful design:
  - Serve stale suggestions (better than none) — fail soft
  - Alert on pipeline lag (freshness SLO), not on "trie changed"
  - Trie is immutable + versioned → a stuck pipeline can never CORRUPT the served copy,
    it can only let it AGE. Ageing is safe; corruption is not.
```

**Design-review talking point:** the top-K-at-node decision couples three properties — query speed
(great), memory (worse: K × every node), and freshness (worse: lists are only as fresh as the last
build). Name all three. A candidate who says "precompute top-K" without acknowledging the memory and
freshness cost hasn't thought past the happy path.

**Real-world framing:** Elasticsearch's completion suggester deliberately builds an in-memory FST
and does **not** support arbitrary query-time re-ranking of the whole corpus for exactly this
reason — it precomputes weights at index time so the query is a cheap FST traversal. When you need
fresher ranking you re-index (their equivalent of a rebuild + swap).

---

## 5. The Update Pipeline: Batch vs Streaming (Kafka + Flink)

### 🟢 Beginner — The Nightly Restock vs the Live Ticker

How do popular searches get *into* the suggestions? Two rhythms:

- **Batch (nightly restock):** every so often — say every 30 minutes — someone tallies up what
  everyone searched, re-ranks the lists, and posts fresh sticky notes. Simple, reliable, a little
  behind.
- **Streaming (live ticker):** a running tally updates second-by-second, so a breaking-news search
  shows up almost immediately. Powerful, but much more machinery to keep running.

Which you need depends on one question: *how fresh must "trending" be?* If "within the hour" is fine,
frequent restocking wins. If "breaking news in seconds" matters, you need the live ticker.

---

### 🟡 Senior — The Pipeline and the Kafka/Flink Shape

```
User search  → search-log event
  → Kafka (ingest)                                             [~seconds]
  → Stream processor (Flink/Spark) aggregates counts by query, windowed  [seconds–minutes]
  → Ranked frequency table (per query, per region)             [minutes]
  → Trie build job (recompute top-K at nodes) OR incremental   [minutes]
  → New trie snapshot published → hot-swapped into replicas    [minutes]
  → Redis prefix cache invalidated / refreshed                 [seconds]
Total: well within a 1-hour trending SLA
```

Batch vs streaming:

| | Batch (rebuild every N min/hours) | Streaming (continuous) |
|---|---|---|
| Freshness | Minutes–hours | Seconds–minutes |
| Complexity | Low (offline job) | High (stateful stream jobs, incremental trie updates) |
| Failure blast radius | Small (rerun the job) | Larger (stateful recovery, checkpoints) |
| Use when | Suggestions change slowly | Trending / breaking-news matters |

A **"1-hour trending SLA"** sits in between: a **frequent batch rebuild** (e.g., every 15–30 min)
usually satisfies it without full streaming complexity. State the SLA-driven choice explicitly
rather than reflexively reaching for streaming.

Kafka + Flink design:

```
Topic `search-events`:
  key       = query string  → all events for a query land on the same partition
              (correct per-query counts)
  partitions= hash(query)
  retention = short (hours/days) but long enough to replay for backfill

Flink job:
  keyBy(query)
    → windowed count (15-min tumbling for periodic; sliding for trending)
    → emit (query, count, window) to `query-frequencies`

Ranking job:
  aggregate windows → compute per-prefix top-K → write ranked table the trie-builder reads
```

Partitioning by query keeps counting **accurate and parallel**; windowing bounds the "trending"
horizon.

---

### 🔴 Architect — Hot Keys, Skew, and the 2 AM Flink Crash

**A single viral query can wreck the aggregation.** Partition-by-query sends all of one hot query's
events to **one** partition → a **hot partition**. Fixes:

```
1. Local pre-aggregation / combiners: count locally per task before the shuffle, so the
   hot key ships AGGREGATED counts, not millions of raw events. (Biggest win.)
2. Approximate counting: Count-Min Sketch / HyperLogLog to bound memory for heavy hitters.
3. Sample/rate-limit ultra-high-frequency keys — you don't need an exact count to know
   something is #1.
```

**Capacity sanity check (illustrative):**
```
Assume 100,000 searches/sec globally, avg event ~200 bytes.
  Kafka ingest ≈ 100k × 200 B = 20 MB/s  → trivial for a partitioned topic.

A viral query at 10% of all traffic = 10k events/sec to ONE partition.
  Without combiners: 10k msgs/s hammer one Flink task → backpressure → lag.
  With combiners flushing every 1 s: that task emits ~1 aggregated record/s per source.
  → hot-key load drops by ~4 orders of magnitude.
```

**The 2 AM incident (canonical failure):**
```
Flink job crashes at 02:00. Trie not updated for 6 hours. Major news event at 03:00.

User experience: type the breaking-news query → no / irrelevant suggestions
  (it's not in the stale trie). DEGRADED, not down — existing suggestions still work.

Incident response:
  1. DETECT: freshness-lag alert (pipeline watermark / trie-age SLO) should have PAGED at
     ~30–60 min lag — well before 6 h. First fix is the MISSING ALERT.
  2. MITIGATE: restart Flink from its last checkpoint (exactly-once state), or fail over to
     a standby job. If state is lost, backfill from Kafka retention (that's why retention
     must exceed max expected recovery time).
  3. BACKFILL: replay retained events to catch up.
  4. COMMUNICATE: note degraded trending on status.
  5. POST-MORTEM: add job HA (checkpointing + standby), freshness-lag paging, and a manual
     "inject trending query" break-glass tool for exactly this scenario.
```

**Design-review talking point:** the pipeline's SLO is **freshness lag**, and it must be paged on
directly. Many teams monitor "is the job running?" — but a job can be *running and stuck* (backpressured).
Alert on the **age of the newest data reflected in the served trie**, measured end-to-end.

---

## 6. Hot-Swap Deploy and Trie Versioning

### 🟢 Beginner — Swapping the Menu Without Closing the Kitchen

A restaurant wants a new menu. It could close for an hour to swap them — but customers are eating
right now. Instead, the staff print all the new menus in the back, stack them ready, and then in one
quick motion swap the pile at the host stand. Diners never notice; there's no closed sign.

And they keep the last few old menus in a drawer — if the new menu has a typo (a dish priced at $0),
they can slap the old one back in seconds instead of reprinting.

---

### 🟡 Senior — The Atomic Pointer Swap

Build the new trie **off to the side**, then atomically switch reads to it:

```
1. Builder produces trie snapshot v(n+1) → object store
2. Each serving replica downloads v(n+1) into memory (still serving v(n))
3. Atomic pointer swap:  activeTrie = v(n+1)   // single reference assignment
4. Old v(n) freed after in-flight requests drain
```

```ts
// The swap is a single reference assignment — inherently atomic for readers.
class TrieServer {
  private activeTrie: Trie;               // readers dereference this per request

  async deploy(snapshotUrl: string) {
    const next = await Trie.loadFromSnapshot(snapshotUrl); // load while serving old
    this.activeTrie = next;               // atomic swap; new requests see v(n+1)
    // old trie is GC'd once in-flight requests holding a reference drain
  }

  query(prefix: string) {
    const trie = this.activeTrie;         // snapshot the pointer for THIS request
    return trie.topKFor(prefix);          // consistent view even if a swap happens mid-request
  }
}
```

Because the switch is a **pointer swap to an already-loaded immutable structure**, there is **zero
read downtime.** Roll it out replica-by-replica.

| | In-place mutation | Hot-swap immutable snapshot |
|---|---|---|
| Read outage during update | Locking / partial states possible | **None** (atomic pointer swap) |
| Rollback | Hard (must reverse mutations) | **Trivial** (swap pointer back to v(n)) |
| Memory during swap | 1× | ~2× briefly (old + new resident) |
| Consistency | Readers may see half-applied update | Readers always see one complete version |

---

### 🔴 Architect — Versioning, Rollback RTO, and Canary

**Keep the last N snapshots** (e.g., 5) in the object store. This buys three things:

```
1. Fast rollback: a bad build (e.g., a filtering regression serving offensive suggestions)
   is reverted by swapping the active pointer to the previous good snapshot.
   Rollback RTO: pointer swap ≈ seconds per replica; whole fleet in < ~2 min.
   Immediate stopgap while rolling back: the serve-time denylist (§9).

2. Canary: deploy v(n+1) to 1–5% of replicas, watch metrics (empty-rate, CTR, latency),
   promote or roll back. New builds are the highest-risk change in the system.

3. A/B of ranking changes: run two snapshots side by side, compare CTR-by-position.

Memory budget note: 2× resident during swap. If a snapshot is 20 GB, a replica briefly
  needs ~40 GB. Size hosts for the swap peak, not the steady state — a common capacity miss.
```

**Design-review talking points:**
- Snapshots must be **immutable and versioned with a build ID + timestamp** embedded *inside* the
  snapshot, so a serving replica (and cache entries, §8) can report exactly which version they hold.
- State an explicit **rollback RTO** (e.g., < 5 min) — "we can roll back" is not an answer;
  "swap the pointer to snapshot N-1, fleet-wide in under 2 minutes, denylist as immediate stopgap" is.
- The riskiest moment in this whole system is **shipping a new trie**. Treat every build like a
  code deploy: canary, monitor, keep the last-known-good one hot for instant revert.

---

## 7. Scaling Out: Sharding vs Replication

### 🟢 Beginner — More Copies vs Splitting the Library

One librarian can't help a thousand people at once, and the library might be too big for one building.

- **Replication (more copies):** hire more librarians, each with a full copy of all the sticky
  notes. Handles more people at once, and if one is out sick, others cover. Works only if one person
  *can* memorize the whole library.
- **Sharding (split the library):** the library is too big for one head — so split it. One librarian
  handles A–F, another G–M, and so on. Now no single person needs to know everything.

Real systems do both: split the library **and** put several librarians on each section.

---

### 🟡 Senior — Two Directions, Two Problems

| Direction | Solves | Choose when |
|---|---|---|
| **Replication** (full copy per server) | Throughput + HA | The trie **fits** in one server's memory; you just need more QPS/redundancy |
| **Sharding** (split trie across servers) | Memory (trie too big for one box) | The trie **doesn't fit** in one server |

They're not exclusive: **shard for memory, replicate each shard for QPS/HA.** Start with replication
(simpler); shard only when memory-bound.

Sharding a trie across, say, 5 servers:

| Strategy | How | Hotspot risk |
|---|---|---|
| **First-character** | shard by first letter (a–e, f–j, …) | **Severe skew** — far more queries start with 's' than 'z' |
| **Prefix-range** | balanced ranges tuned to traffic (split hot ranges finer) | Better balance; needs a routing map + rebalancing |
| **Consistent hashing on prefix** | hash(prefix) → shard | Even distribution, but **breaks prefix locality** (adjacent prefixes scatter) |

```
Common answer: route by a SHORT prefix (first 1–3 chars) via a BALANCED prefix-range map,
keeping each prefix's subtree on ONE shard so a lookup hits a single server. Rebalance hot
ranges. Name the first-character skew risk explicitly — it's the trap in this question.
```

Why prefix locality matters: if the subtree for "sea" is split across shards, answering "sea"
requires scatter-gather across shards and merging top-K — more hops, higher tail latency. Keeping a
subtree whole means one shard fully answers one prefix.

---

### 🔴 Architect — Quantifying First-Char Skew and the Split-Brain Cache

**First-character skew is not hypothetical.** English query initials are wildly non-uniform.

```
Illustrative distribution of query first letters (order-of-magnitude, NOT measured):
  's', 'c', 'a', 'p'  → each a large share (say ~8–12% each)
  'x', 'z', 'q'       → each tiny (< 1%)

Shard by first letter across 5 servers with naive a–e / f–j / … buckets:
  The bucket containing 's' + 'p' could hold ~20%+ of traffic;
  the bucket with 'v','w','x','y','z' might hold ~5%.
  → up to ~4× load imbalance → the hot shard is your P99, the cold shard is idle.

Fix: prefix-RANGE map tuned to measured traffic — split the hot ranges finer
  ('sa'–'sm' on one shard, 'sn'–'sz' on another) and merge cold ranges.
  This needs a routing table + a rebalancing procedure, which is the real cost.
```

**Split-brain cache failure (illustrative incident class):** a Redis cache cluster suffers a
partition; half is stale by 4 hours, half is current, and you can't tell which is which.

```
User-visible impact: INCONSISTENT suggestions depending on which half a request hits —
  freshness flip-flops (violates monotonic reads), unpredictably.

Detect:  embed the trie build/version (timestamp or build ID) in every cached entry, or a
         per-shard `trie_version` key; alert when shards disagree.
Resolve: fence the minority / restore quorum, FLUSH the stale half, let it refill from the
         current trie; prefer serving from the trie (source of truth) until caches reconcile.
Design:  tag cache entries with the trie version so a service can DETECT AND REJECT
         stale-version entries rather than trusting the cache blindly.
```

**Design-review talking point:** the "which strategy shards a trie" question is really testing
whether you know that **hash-based sharding destroys the very locality that makes a trie useful.**
The correct instinct is range-based-on-a-short-prefix, and the correct caveat is skew — you must say
both.

---

## 8. The Redis Prefix Cache: Eviction and Stampede

### 🟢 Beginner — The Notepad by the Front Desk

Most people ask for the same handful of things. So the librarian keeps a small notepad right at the
front desk with the answers to the most common requests. Ninety-plus percent of the time the answer
is already on the notepad — she doesn't even walk to the shelves. Only the rare, unusual request
sends her into the stacks.

The notepad is small, so old jottings get erased to make room. The trick is erasing the *right*
ones: keep the popular answers, let the rare one-offs go.

---

### 🟡 Senior — What Redis Stores and How

Most keystrokes are for **popular prefixes** (the heavy head of the distribution), so a cache serves
the majority of traffic from memory in ~1 ms, slashing P99 and offloading the trie servers.

```
# Model A: one sorted set PER PREFIX, top-K by frequency score
ZADD ac:sea 9500 "seattle weather" 9000 "search" 8000 "seahawks"
ZREVRANGE ac:sea 0 4 WITHSCORES        # top-5 for "sea", highest score first

# Model B: single sorted set, lexicographic ranges (all scores equal)
ZADD queries 0 "seattle" 0 "search" 0 "seahawks"
ZRANGEBYLEX queries "[sea" "[sea\xff"  # all members with prefix "sea"
```

| | Model A: ZSET per prefix | Model B: one ZSET + ZRANGEBYLEX |
|---|---|---|
| Ranking | Precomputed top-K per prefix (mirror of §4) | Lexicographic only; rank client-side |
| Key count | Many keys (one per cached prefix) | One (or few) keys |
| Query | `ZREVRANGE ac:<prefix> 0 K-1` → O(log N + K) | `ZRANGEBYLEX` → O(log N + M), M = matches |
| Best for | **Ranked autocomplete** (the usual pick) | Compact prefix membership, small alphabets |

Model A mirrors "top-K at node" and is the usual choice for ranked autocomplete. `ZREVRANGE` reads
highest-score-first (frequency); `ZRANGEBYLEX` requires all scores equal and returns
lexicographically ordered members within a prefix range.

---

### 🔴 Architect — LRU Long-Tail Churn and Cache Stampede

**LRU evicts the long tail repeatedly.** A rare prefix is fetched, evicted before it's reused,
fetched again → constant misses for the tail while the head stays hot.

```
Fixes:
  - LFU (frequency-aware): genuinely popular-but-bursty items survive.
  - Segmented / two-tier LRU: protect a "hot" segment from tail scans.
  - Admission control (TinyLFU): a one-off tail request is DENIED admission so it can't
    evict a useful hot item.
  - Accept tail misses: they fall through to the fast trie (O(L)) anyway. Size the cache
    for the HEAD, not the whole corpus.

Named tradeoff: hit ratio for the head vs. churn for the tail.
```

**Cache stampede (thundering herd):** a hot prefix's cache entry expires → many concurrent requests
miss and hit the trie/backend simultaneously.

```ts
// Single-flight: only ONE backend fetch per key; others wait or serve stale.
async function getWithSingleFlight(key: string) {
  const cached = await cache.get(key);
  if (cached) return cached;

  if (await lock.tryAcquire(key)) {          // exactly one winner refills
    try {
      const fresh = await trie.topKFor(key);
      await cache.set(key, fresh, TTL);
      return fresh;
    } finally { await lock.release(key); }
  }
  return await serveStaleOrWaitBriefly(key); // losers don't hammer the backend
}
```

```
Other prevention techniques:
  - Probabilistic early expiry (XFetch): refresh BEFORE TTL with a probability that rises
    as expiry nears → entries refresh STAGGERED instead of all at the same instant.
  - stale-while-revalidate: serve the stale value immediately, refresh asynchronously.
```

**Capacity sanity check (illustrative):**
```
Cache the top ~1M prefixes. Each ZSET entry (Model A, top-5) ≈ a few hundred bytes.
  1M prefixes × ~300 B ≈ 300 MB — trivially fits one Redis node's memory.
  If head hit rate = 92%, then at 5k req/s only ~400 req/s reach the trie tier
  → the trie fleet is sized for the tail + misses, not full traffic.

Stampede blast radius: 1 hot prefix expiring at 5k req/s WITHOUT single-flight = up to
  5k concurrent trie lookups for one key in the same instant. With single-flight = 1.
```

**Design-review talking point:** name **both** stampede and long-tail-churn — they're different
problems with different fixes (stampede = single-flight/early-expiry; churn = admission control/LFU).
Candidates who only say "add a cache" miss that the cache *policy* is where the production pain is.

---

## 9. Personalization and Serve-Time Filtering (Takedowns)

### 🟢 Beginner — The Librarian Who Knows You (a Little) and the Banned-Books List

Two extra touches:

- **Personalization:** the librarian remembers you were just reading about Python, so when you type
  "p" she nudges "Python" a bit higher. But if she *only* ever suggested Python for everything
  forever, she'd be annoying and useless — so she keeps it a gentle nudge on top of the normal
  popular list, and forgets old interests over time.
- **The banned list:** some things must never be suggested — offensive terms, or something a court
  ordered removed. There are two places to enforce this: leave them off the sticky notes when
  writing them (slow to change), *or* keep a "never say these" card at the desk she checks before
  every answer (changeable in seconds). For emergencies, you need the desk card.

---

### 🟡 Senior — Blending and Two Enforcement Points

Blend **global top-K** with the user's **recent searches**, as a re-rank:

```ts
// Personalization is a RE-RANK on top of the global set → degrades to global if
// personal data is missing.
function score(s: Suggestion, u: UserSignals): number {
  return W_GLOBAL   * s.globalScore
       + W_PERSONAL * u.personalScore(s)        // capped weight
       + W_RECENCY  * recencyDecay(u.lastSeen(s)); // old interests fade
}
```

Personal history is per-user, privacy-sensitive data kept in a fast KV store (or partly on-device);
blending happens at the service layer. Keep it a re-rank so unavailable personal data just falls back
to global.

**When personalization turns harmful:** over-biasing (one past "Python tutorial" dominating *all*
future suggestions) creates a **filter bubble** and **stale intent**. Fixes: **recency decay**, a
**cap on personal weight**, and always blending in global results so the user isn't trapped.

Filtering profane / illegal / legally-mandated (DMCA/takedown) queries — two enforcement points:

| Point | How | Tradeoff |
|---|---|---|
| **Build-time (offline)** | Exclude blocklisted/regex-matched queries when building the trie | Cheap at query time; **slow to update** (needs a rebuild) — useless for emergencies |
| **Serve-time (runtime)** | Filter every response against a fast denylist (Redis set / bloom filter) | **Instant global updates**; adds per-request cost; must be applied everywhere |

Use **both**: build-time for the bulk, serve-time for emergency/legal takedowns. Named tradeoff:
**update latency vs. per-request cost.**

---

### 🔴 Architect — The 15-Minute Legal Takedown (Break-Glass)

A legal team demands: remove "celebrity leaked photos" from autocomplete **within 15 minutes
globally.** Build-time filtering alone can't — a rebuild is too slow. Rely on the **serve-time
denylist:**

```
1. Add the term (+ normalized forms / variants / common misspellings) to the runtime denylist
   (Redis set / config).
2. Propagate the denylist change to ALL serving replicas + edge within seconds (pub/sub).
3. Every response is filtered against the denylist → the query is suppressed globally, now.
4. Invalidate any cached Redis entries containing it (so the cache can't resurrect it).
5. Queue it for permanent removal in the next trie build (belt and suspenders).

Confirm coverage: track propagation ACKs from every replica/edge so you can PROVE global
suppression happened inside the 15-min window — legal will ask for evidence.
```

```ts
// Serve-time filter: applied to EVERY response, after blend, before return.
function applyDenylist(suggestions: Suggestion[], denylist: Set<string>): Suggestion[] {
  return suggestions.filter(s => !denylist.has(normalize(s.text)));
  // normalize(): lowercase, strip punctuation/diacritics, collapse whitespace,
  // so "C.e.l.e.b" style evasions are also caught.
}
```

**Design-review talking points:**
- The serve-time enforcement point is your **break-glass control** — it must exist *before* you need
  it. You cannot bolt it on during an incident.
- **Normalization is where these fail.** A denylist of exact strings is trivially evaded (spacing,
  homoglyphs, misspellings). The filter must normalize both the denylist entries and the candidate
  suggestions.
- Personalization must **never** bypass the denylist. Filter is the *last* step, after blending —
  otherwise a personalized suggestion can leak a taken-down term.
- Privacy: personal history is regulated data (GDPR/CCPA-class). Keep it per-user, honor deletion,
  and prefer on-device or short-retention storage where possible.

**Real-world framing:** search engines are routinely subject to legal removal requests (e.g.,
"right to be forgotten"-type rulings in the EU require de-listing on request). The exact mechanics
are proprietary, so treat specifics as unverified — but architecturally, any serious autocomplete
system needs a fast, auditable, globally-propagating serve-time suppression path, because a rebuild
cycle is far too slow for a legal deadline.

---

## 10. Operations, Failure Cascades, and Capacity Math

### 🟢 Beginner — The Alarm Panel

A well-run autocomplete has an alarm panel with a few clear lights: Is it fast? Is it erroring? Is
the notepad (cache) working? Are the suggestions fresh? Is traffic weird right now? When a light goes
red, you know where to look before users complain. The best systems also degrade gracefully — under
a huge crowd, they'd rather show slightly worse suggestions to everyone than crash for anyone.

---

### 🟡 Senior — Metrics, Trie Misses, and Spike Load-Shedding

Five metrics to alert on:

| Metric | Example threshold |
|---|---|
| **P99 latency** | alert if > 100 ms for 5 min |
| **Error rate** (5xx / timeouts) | alert if > 0.5% |
| **Cache hit ratio** | alert if < 90% (drop signals cache/routing issue) |
| **Trie freshness / pipeline lag** | alert if trie age > 60 min (SLA breach) |
| **QPS anomaly** | alert on sudden spike/drop |

Bonus: **suggestion empty-rate** (fraction of requests returning 0 suggestions) catches trie-miss
and filtering regressions early.

**Trie misses** (typed prefix not present — new phrase, typo):

```
- Fuzzy fallback: edit-distance / n-gram matching ("did you mean")
- Backoff: drop the last char(s), suggest for the shorter valid prefix
- Empty + graceful UX: show nothing rather than wrong guesses (empty dropdown is fine)
- Log the miss → feeds the pipeline so genuinely new popular phrases enter the next build
UX: ideally a helpful fuzzy suggestion; at worst an empty dropdown — NEVER an error.
```

**Spike (100× in 90 s — a live sporting event just ended):**

```
Cascade: QPS spike → cache-miss surge on new trending prefixes → trie/backends overload
  → latency ↑ → timeouts → client retries → RETRY STORM → wider overload.

Circuit-breaker / load-shed strategies:
  1. Rate limit / load shed at the gateway — cap QPS per client/region, shed excess with a
     fast empty/cached response instead of queueing.
  2. Circuit breaker to the trie service — on rising errors, trip open and SERVE STALE CACHE
     (fail soft) instead of hammering an overloaded backend.
  3. Serve degraded results — cached/global top-K only (skip personalization + real-time
     trending) to cut per-request cost; scale replicas out; add jitter+backoff to client
     retries to break the storm.
```

---

### 🔴 Architect — Full Capacity Math and the End-to-End Design

**Capacity math — 10M unique prefixes, top-5 per node** (illustrative; show the arithmetic):

```
(a) NODE COUNT
    ~10M unique queries, avg ~15–20 chars, heavy prefix sharing.
    Upper bound (no sharing): 10M × 18 = 180M nodes.
    With heavy prefix sharing, real count is lower but same order → ~10^8 nodes
    (call it ~100–200M). Sharing reduces the constant, not the order of magnitude.

(b) MEMORY PER NODE
    children map + flags + 5 × 4-byte IDs + object header ≈ ~100 bytes (see §3).

(c) CLUSTER MEMORY
    200M nodes × 100 B ≈ 20 GB for nodes.
    + shared string table: 10M strings × ~30 B ≈ 300 MB.
    → ~20 GB, round to "tens of GB."
    Does NOT fit comfortably on one commodity box with headroom + 2× swap peak (§6)
    → SHARD (or use a compact double-array/FST to fit fewer, denser nodes).

(d) SERVERS AT 5K REQ/S
    Lookups are O(L), microsecond-scale → one replica handles MANY THOUSANDS of QPS.
    CPU is NOT the constraint; MEMORY and HA are.
    So: shard for the ~tens-of-GB footprint (say 2–3 shards) × ≥2–3 replicas each for
    HA/headroom ⇒ ~6–9 trie servers, plus the Redis cache tier.
    JUSTIFY BY MEMORY + REDUNDANCY, not raw QPS. (The trap answer sizes by QPS.)
```

**Full end-to-end design (say this in ~90 seconds):**

```
READ PATH:
  Browser (debounce) → CDN/edge → API gateway (auth, rate limit) → autocomplete service
  → Redis prefix cache (head of distribution)
  → on miss: sharded + replicated trie (route by short prefix, §7)
  → blend personal history (§9) → serve-time denylist (§9) → response.
  Budget < 100 ms P99, mostly cache/precomputed.

WRITE / UPDATE PATH:
  search logs → Kafka → Flink windowed aggregation (keyBy query; local combiners for hot
  keys; approx counting) → per-prefix top-K ranking → offline trie build (compact, immutable
  snapshot) → hot-swap into replicas (pointer swap, §6) → invalidate Redis.
  Frequent batches for the trending SLA; streaming layer for breaking news.

PERSONALIZATION: per-user history in a fast KV store; re-rank global results with decayed
  weights; degrade to global if unavailable.

FILTERING: build-time exclusion for the bulk + serve-time denylist for emergency/legal
  takedowns (propagate in seconds).

MULTI-REGION: replicas + caches per region for latency; regional frequency tables (local
  trends) + global fallback; trie snapshots replicated to each region; short DNS/edge TTL
  for failover. Version + retain the last N snapshots for fast rollback.
```

**Unprompted senior signals** (raise these without being asked):
- **CTR-by-position feedback loop:** measure click-through rate per suggestion position; feed it back
  into ranking weights so suggestions optimize for what users actually pick, not raw frequency.
- **Rollback plan for a bad build:** revert the active pointer to the previous snapshot in minutes;
  serve-time denylist as the immediate stopgap; state an explicit RTO (< 5 min).
- **Snapshot versioning:** keep the last ~5 builds for < 2-min rollback, canary, and A/B.

**Real-world framing:** Twitter/X-style "trending" surfaces and Google Trends both illustrate the
two-rhythm model — a fast streaming path for breaking spikes plus a slower aggregation for stable
ranking. The exact internal architectures aren't public (treat specifics as unverified), but the
pattern — precompute + serve on the read path, Kafka/stream-processor aggregation on the write path,
immutable snapshot + hot-swap for deploys — is the industry-standard shape for typeahead at scale.

---

## Quick Recall Cheat Sheet

> Close this file. Answer from memory. Open if stuck.

| Concept | One-Line Recall |
|---|---|
| Trie lookup | O(L) in prefix length, **independent of corpus size** — 10 or 10B queries, "app" is 3 hops |
| Why not hash map | Hash scatters keys → no prefix relationship → O(N) scan for a prefix |
| `isEndOfWord` | Distinguishes "app" (a word) from "app" (a prefix of "apple") — leaf ≠ word |
| Top-K at node | Precompute completions per prefix → O(1) read, no subtree DFS; costs memory + freshness |
| DFS is disqualified | Short prefix = biggest subtree = most traffic → cost scales inversely with usefulness |
| ID vs string in node | Store IDs into a shared string table → dedupe (a query sits in all its prefixes' lists) |
| Surge propagation | New score updates O(L) ancestor lists (batch rebuild does it wholesale) |
| Radix / DAWG / FST | Compress single-child chains / shared suffixes; smallest = effectively read-only |
| Cold start (8 GB trie) | mmap flat snapshot + rolling restart + readiness probe; never blocking-parse an object graph |
| Redis Model A | `ZADD` scores, `ZREVRANGE ac:<prefix> 0 K-1` → top-K by frequency (the usual pick) |
| Redis Model B | `ZRANGEBYLEX queries "[sea" "[sea\xff"` → lexicographic prefix range (equal scores) |
| Cache long-tail | LRU churns the tail → use LFU / TinyLFU **admission control**; size cache for the head |
| Cache stampede | Single-flight mutex + probabilistic early expiry (XFetch) + stale-while-revalidate |
| Update pipeline | logs → Kafka (key=query) → Flink windowed counts → rebuild top-K → hot-swap → invalidate cache |
| Batch vs stream | Batch (15–30 min) for a 1-hour SLA; streaming only for second-level breaking-news trending |
| Hot key in pipeline | Local combiners + approx counting (Count-Min/HLL) so one viral query can't skew or lag |
| Hot-swap deploy | Load new immutable trie, **atomic pointer swap** → zero read outage; needs ~2× memory during swap |
| Snapshot versioning | Keep last ~5 builds → rollback RTO < ~2 min, canary, A/B; embed build ID for cache tagging |
| Shard vs replicate | Shard for **memory**, replicate for **QPS/HA**; do both |
| First-char shard | Skewed ('s'/'c'/'a'/'p' ≫ 'x'/'z'/'q') → up to ~4× imbalance → use balanced prefix-range routing |
| Hash-shard a trie | **Breaks prefix locality** → scatter-gather per query → avoid; range-on-short-prefix instead |
| Personalization | Re-rank on top of global; cap personal weight + recency decay → no filter bubble |
| Serve-time denylist | Break-glass takedown; pub/sub propagates in seconds; normalize to defeat evasion; filter last |
| Trie miss | Fuzzy / backoff to shorter prefix / empty dropdown — never an error; log for next build |
| Spike load-shed | Gateway rate-limit + circuit-break to stale cache + drop personalization; jitter client retries |
| Capacity | ~10^8 nodes × ~100 B ≈ tens of GB → shard; bound by **memory + HA**, not QPS |
| Server count logic | O(L) lookups → CPU isn't the limit; size by memory footprint × replicas for HA (~6–9 + cache) |
| Freshness SLO | Alert on **trie age** (end-to-end lag), not "is the job running" — a job can run and be stuck |
| Fail soft | Stale/empty/degraded beats error/spinner; every dependency needs a return-something fallback |
| CTR feedback loop | Click-through by position feeds ranking weights → optimize for picks, not raw frequency |
