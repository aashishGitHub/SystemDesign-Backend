# Hybrid Semantic Search Engine — Project Requirements

> A minimal, from-scratch hybrid search engine in Go. Built to deeply understand the building blocks behind production semantic search systems like Couchbase Capella's FTS + Vector Search and similar offerings in distributed databases.

---

## 1. Author Context & Motivation

I am a lead engineer with twelve years of full-stack experience, currently working on Couchbase Capella with a focus on its FTS, vector search, and indexing capabilities — primarily from the UI and integration side, with growing involvement in the underlying query patterns and index design choices that those features expose to users.

Working at the consumer side of these features over the past year has surfaced a recurring frustration: I can describe *what* the index does for the user, but I have only a textbook-level grasp of *how* it does it under the hood. When customers ask why their hybrid query is slow, or why recall dropped after a tokenizer change, or whether they should choose a flat vector index or an IVF-quantized one, I find myself reaching for documentation rather than reasoning from first principles.

This project is the cure. I am building, from scratch in Go, a small but real hybrid semantic search engine. The goal is **not** to compete with production systems. The goal is to internalize the data structures, algorithms, and tradeoffs deeply enough that I can hold an opinionated conversation about them — and, eventually, contribute to systems like CockroachDB's specialized indexing efforts.

The project deliberately mirrors the architecture of real systems (Capella's FTS is built on Bleve; pgvector lives inside Postgres; CockroachDB is integrating vector search natively) so that what I learn here is directly transferable.

> **A note on honesty.** This is not a production engine. It will have known limitations and naive choices, all of which I will document explicitly. The point is what I learn building it and what I can defend in conversation — not benchmark-chasing.

---

## 2. Problem Statement

Modern applications increasingly need **two different kinds of search over the same data**:

1. **Lexical search** — "find documents containing these exact words, with statistical relevance scoring." Strong for proper nouns, jargon, IDs, exact-phrase queries. The dominant scoring function is BM25, the modern successor to TF-IDF.

2. **Semantic search** — "find documents whose *meaning* is closest to the query." Texts are converted to high-dimensional embedding vectors via a language model, and similarity is computed by cosine distance, dot product, or L2. Strong for paraphrase, conceptual queries, and queries where the user's words don't match the document's words.

Each has known weaknesses. Lexical search misses paraphrase entirely ("how do I sign in" vs "what's the login URL"). Semantic search has trouble with rare strings (model numbers, code identifiers) because embedding models compress them lossily.

The empirical answer for the last several years has been **hybrid search**: run both, then fuse the results. The fusion step is non-trivial — BM25 and cosine similarity are on different score scales, so naive sum is wrong. Reciprocal Rank Fusion (RRF) and learned-to-rank models are the standard answers.

This project implements that pipeline end-to-end at small scale, with each component built from first principles so the tradeoffs are visible in the code.

---

## 3. Goals & Non-Goals

### Goals

1. Build a working, tested Go library and CLI that ingests a corpus and serves three query types: keyword (BM25), vector (cosine k-NN), and hybrid (RRF over the first two).
2. Demonstrate clear understanding of the relevant data structures: inverted indexes with posting lists, scoring functions, k-NN search, rank fusion.
3. Produce a small benchmark that measures latency at a few corpus sizes and exposes the obvious scaling cliffs.
4. Write the codebase such that every non-trivial decision is documented either inline or in this requirements doc with the alternatives considered and the reason for the choice.
5. Be honest about every limitation. The "Limitations" section is as important as the "Architecture" section.

### Non-Goals (Explicit)

These are real systems concerns I am consciously **not** addressing in this version, with my reasoning:

- **Approximate nearest neighbor (HNSW, IVF, ScaNN).** Implementing these correctly is a multi-week effort and getting it half-right is worse than not doing it at all. Brute-force k-NN is the correct choice for the scope here; the conversation about ANN is what matters in the interview, not a half-implemented HNSW.
- **Embedding generation.** Computing embeddings is the job of a model server (or a Python script using `sentence-transformers`, or an API call to an embedding provider). The engine accepts vectors as input. Conflating embedding generation with indexing is a category error real systems avoid.
- **Distributed sharding / consensus.** Single-process only. The interesting questions about sharding (top-k merge, recall loss, backfill) are systems-design conversations, not code I will write this week.
- **Production-grade concurrency.** A single global RWMutex around the index is the chosen design. Lock-free concurrent indexes are an entire field of research and irrelevant at this scope.
- **Multi-tenancy, auth, security, observability.** All deferred. None are interesting at this scope.
- **Stemming, lemmatization, multi-language tokenization.** The tokenizer is intentionally minimal (lowercase, strip punctuation, split on whitespace). Linguistic sophistication is a known direction for extension; not building it here lets the actual index structure stay the focus.

The discipline of stating non-goals explicitly is, in my experience, the single largest predictor of whether a project ships. I am applying it here.

---

## 4. System Architecture

### High-Level Data Flow

```
                    ┌──────────────────┐
                    │   Corpus (docs)  │
                    │  text + vectors  │
                    └────────┬─────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
       ┌────────────────┐        ┌────────────────┐
       │  Tokenizer     │        │  Vector Store  │
       │  + Inverted    │        │  (flat array)  │
       │  Index Builder │        │                │
       └────────┬───────┘        └───────┬────────┘
                │                        │
                ▼                        ▼
       ┌────────────────┐        ┌────────────────┐
       │  Posting Lists │        │ Brute-force    │
       │  + Doc Stats   │        │ k-NN Searcher  │
       └────────┬───────┘        └───────┬────────┘
                │                        │
                ▼                        ▼
       ┌────────────────┐        ┌────────────────┐
       │  BM25 Scorer   │        │  Cosine        │
       │                │        │  Similarity    │
       └────────┬───────┘        └───────┬────────┘
                │                        │
                │  top-k (text)          │  top-k (vector)
                │                        │
                └────────────┬───────────┘
                             ▼
                    ┌─────────────────┐
                    │  RRF Fusion     │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │  Final Top-K    │
                    └─────────────────┘
```

### Package Boundaries

The Go module is structured as five focused packages, each with one clear responsibility:

| Package | Responsibility | Public API surface |
|---|---|---|
| `pkg/index` | Tokenization, inverted index construction, BM25 scoring | `Index`, `Token`, `PostingList`, `Search(query) []Result` |
| `pkg/vector` | Vector storage, distance functions, k-NN | `Store`, `Cosine`, `KNN(query, k) []Result` |
| `pkg/hybrid` | RRF fusion of two ranked lists | `RRF(lists ...[]Result, k int) []Result` |
| `pkg/store` | Persistence layer (JSON for now) | `Save(path) error`, `Load(path) (*Engine, error)` |
| `cmd/hybridsearch` | CLI demo: index, query, benchmark | — |

The boundaries are chosen so that each package can be tested independently and so that swapping (e.g.) brute-force for IVF later changes one package, not the engine.

### A Note on Why Go

I am building this in Go for two reasons:

1. **Career alignment.** I'm transitioning into systems-level work, and Go is the language of CockroachDB, etcd, Kubernetes, InfluxDB, TiKV, and large parts of Couchbase's tooling. Building muscle here is a direct investment.
2. **Sweet-spot for the scope.** Garbage-collected (so I don't fight memory management on a 5-day clock), but fast enough that benchmarks are meaningful. Strong standard library (`container/heap`, `sort`, `sync`). For production vector search, the GC pause behavior would be a real concern I'd want to engage with — Pebble (CockroachDB's storage engine) has gone to significant lengths around this. Worth knowing about; not worth solving here.

---

## 5. Functional Requirements

### 5.1 Document Ingestion

The engine accepts documents of the following shape:

```go
type Document struct {
    ID       string            // unique identifier
    Text     string            // raw text content
    Vector   []float32         // pre-computed embedding (e.g. 384 or 768 dims)
    Metadata map[string]string // optional, future-use; not indexed in this version
}
```

**Requirements:**
- Documents are added one at a time via `Index.Add(doc Document) error`.
- Adding a document indexes it into both the inverted index and the vector store atomically (under a single write lock).
- Duplicate IDs are rejected with an explicit error. No silent overwrites.
- Empty text is allowed (vector-only document); empty vector is allowed (text-only document); both empty is rejected.
- Vector dimensionality must match across the corpus; the first document's dimension fixes the index dimension. Mismatches return a clear error.

**Out of scope:** batch ingestion, streaming ingestion, async indexing. Single-threaded synchronous writes.

### 5.2 Tokenization

The tokenizer is deliberately minimal. The contract:

```go
type Tokenizer interface {
    Tokenize(text string) []string
}
```

The default implementation:
1. Lowercase the input.
2. Strip non-alphanumeric characters, replacing with spaces.
3. Split on whitespace.
4. Discard tokens of length < 2 (drops single-character noise).
5. (Optional, off by default) Discard a small built-in stopword set.

This is intentionally naive. Real engines use language-specific analyzers, ICU normalization, n-gram tokenizers for fuzzy match, and so on. The naivety is documented and called out in the limitations section. The `Tokenizer` interface allows swapping for testing or future extension.

### 5.3 Inverted Index Construction

For each tokenized term, the index maintains a **posting list**: the set of documents containing that term, plus the term frequency within each document.

```go
type Posting struct {
    DocID     string
    Frequency uint32  // count of this term in this document
}

type PostingList []Posting  // sorted by DocID for merge-join queries

type InvertedIndex struct {
    postings    map[string]PostingList  // term -> posting list
    docLengths  map[string]uint32       // docID -> token count, for BM25 normalization
    avgDocLen   float64                 // for BM25 length normalization
    numDocs     uint32
}
```

**Requirements:**
- Posting lists are kept sorted by `DocID` to enable efficient merge-join during multi-term queries.
- `docLengths` is required for BM25's length normalization term; `avgDocLen` is recomputed incrementally on each `Add`.
- Memory layout favors clarity over compactness. Production engines compress posting lists aggressively (variable-byte encoding, frame-of-reference, roaring bitmaps for doc-id sets). Not in scope; called out as future work.

### 5.4 BM25 Scoring

BM25 scores a document `d` against a multi-term query `q` using:

```
score(d, q) = Σ_{t in q} IDF(t) × ( f(t,d) × (k1 + 1) ) /
                                  ( f(t,d) + k1 × (1 - b + b × |d|/avgdl) )
```

Where:
- `f(t, d)` is the term frequency of `t` in `d`
- `|d|` is the length of `d` in tokens
- `avgdl` is the average document length
- `k1` and `b` are tunable parameters (defaults: `k1 = 1.2`, `b = 0.75`)
- `IDF(t) = log( (N - n(t) + 0.5) / (n(t) + 0.5) + 1 )`, the standard "+1 smoothed" variant that avoids negative IDF for very common terms

**Implementation requirements:**
- Pure function: given an inverted index, a query (as tokenized terms), and parameters, return ranked results.
- For multi-term queries, the union of posting lists is the candidate set; scores are summed per document.
- Top-k extraction uses a min-heap of size k, not a full sort. This is the standard idiom and exactly the kind of detail interviewers probe.

**Edge cases I will explicitly test:**
- Query term not in any document → empty result.
- Query term in *every* document → IDF clamps near zero, doc length normalization still functions.
- Multi-term query where terms have wildly different document frequencies → ensure the rare term dominates correctly.

### 5.5 Vector Store and Brute-Force k-NN

The vector store is a flat array of `(docID, vector)` pairs. No indexing structure beyond that.

```go
type VectorStore struct {
    docIDs  []string
    vectors [][]float32
    dim     int
}
```

**k-NN query:**
1. Compute cosine similarity between query vector and every stored vector.
2. Maintain a min-heap of size k as we iterate, evicting the smallest when a better candidate appears.
3. Return the heap contents sorted descending by similarity.

**Cosine similarity:**
```
cos(a, b) = (a · b) / (||a|| × ||b||)
```

Two implementation notes:
- If we normalize all stored vectors at insertion time, cosine reduces to a dot product at query time — half the arithmetic. I will normalize on insert. This is a real-world optimization that often gets called out.
- Query vector must also be normalized before search; the engine will do this on the caller's behalf.

**Why brute force is the right choice here:**
At a corpus of ~5,000 documents with 128-dimensional vectors, brute force is microseconds per query. ANN's value only emerges at significantly larger scales (typically >100K vectors), and the implementation cost of correct ANN is high. Building brute force first is also the correct engineering order: it's the **ground truth** against which any ANN implementation must be measured for recall. Real ANN benchmarks always include a brute-force baseline for exactly this reason.

### 5.6 Hybrid Query and Reciprocal Rank Fusion

Given two ranked lists (one from BM25, one from vector k-NN), fuse them into a single ranked list.

**RRF formula:**
```
RRF_score(d) = Σ_i  1 / (k + rank_i(d))
```

Where `rank_i(d)` is the 1-indexed rank of document `d` in ranker `i`, and `k` is a tunable constant (literature default: 60).

**Why RRF and not weighted score sum:**

This is one of the key tradeoff conversations I expect from the interview. The naive approach is `α × bm25_score + (1-α) × cosine_score`. It fails because BM25 scores are unbounded and depend on corpus statistics, while cosine is in `[-1, 1]`. You'd have to normalize, and there's no principled normalization that works across queries. RRF sidesteps the problem by working on *ranks* instead of *scores* — rank is an ordinal quantity that's directly comparable across rankers regardless of what scoring function produced it.

The cost: RRF discards score magnitude information. If BM25 is "very confident" about a result, RRF can't express that. Learned-to-rank methods (e.g., LambdaMART, more recently cross-encoder reranking) are the principled fix, at the cost of needing training data. RRF is the unsupervised baseline; reranking is the supervised step on top. This is a real architectural staircase in production systems.

**API:**
```go
func RRF(lists [][]Result, k int) []Result
```

Returns the fused ranking, sorted descending by RRF score.

### 5.7 Persistence

JSON serialization of the entire engine state to a single file. Load reconstructs the engine.

**Why JSON over more efficient formats:**
- Human-readable (debugging during development)
- Standard library (no dependencies)
- Performance is irrelevant at this scope

**What I am explicitly NOT building:**
- Append-only WAL
- Crash recovery
- Incremental persistence
- Memory-mapped on-disk format (real systems use this for indexes that exceed RAM)

All of these are interesting and I will discuss them in the limitations section.

### 5.8 Query API

The top-level engine surface:

```go
type Engine struct { /* ... */ }

func New() *Engine
func (e *Engine) Add(doc Document) error
func (e *Engine) QueryText(text string, k int) []Result
func (e *Engine) QueryVector(vec []float32, k int) []Result
func (e *Engine) QueryHybrid(text string, vec []float32, k int) []Result
func (e *Engine) Save(path string) error
func Load(path string) (*Engine, error)

type Result struct {
    DocID string
    Score float64
    Doc   *Document  // populated on read
}
```

---

## 6. Non-Functional Requirements

### 6.1 Performance Targets

These are honest, achievable targets at the project's scope. Not benchmark-chasing.

| Operation | Corpus Size | Target |
|---|---|---|
| `Add` (single document) | — | < 1ms typical |
| `QueryText` (single-term) | 5,000 docs | < 5ms |
| `QueryText` (5-term query) | 5,000 docs | < 20ms |
| `QueryVector` (k=10, dim=128) | 5,000 docs | < 50ms |
| `QueryHybrid` (text + vector, k=10) | 5,000 docs | < 80ms |

These are not goals to optimize toward. They are sanity floors. If we are wildly off them, something is wrong.

### 6.2 Concurrency Model

A single `sync.RWMutex` on the `Engine`:
- Writes (`Add`, `Save`) take the write lock.
- Reads (all `Query*` methods) take the read lock.

This means writes block all reads and vice versa. For a learning project this is correct. Production engines use copy-on-write, double-buffered indexes, or generational schemes to keep reads non-blocking during writes — a conversation worth having but not code worth writing here.

### 6.3 Testing Requirements

- **Unit tests per package** with hand-crafted small corpora where expected results are computable by hand.
- **Property-based test for cosine similarity**: cos(v, v) = 1; cos(v, -v) = -1; cos invariant under positive scaling.
- **Golden-file test for BM25**: a fixed corpus + query whose ranking is computed by hand and asserted exactly.
- **Integration test**: build a small synthetic corpus, run all three query types, assert the hybrid ranking differs from either single ranking (proves the fusion does something).
- **Benchmark harness** using Go's built-in `testing.B`. Reports latency at corpus sizes of 1K, 5K, and 10K documents.

Coverage target: not a number. Every public method has at least one test; every non-trivial branch (edge cases above) has a targeted test. This is how I write code in production work.

### 6.4 Code Quality

- All public types and functions have doc comments.
- No package depends on more than the standard library and (if absolutely needed) `golang.org/x/exp/...` for any generic utilities. Zero external runtime dependencies.
- Errors are wrapped with `fmt.Errorf("doing X: %w", err)` for traceability; `errors.Is` / `errors.As` used at the call site.
- No `panic` in library code. Panics in `main` only for unrecoverable startup conditions.

---

## 7. Technical Design Decisions

This section is the most important part of this document for interview purposes. Each subsection states a decision, the alternatives considered, and the reason for the choice. These are the tradeoff conversations that distinguish senior thinking from "I built a thing."

### 7.1 Inverted Index in a Hash Map vs Trie vs FST

**Decision:** `map[string]PostingList`.

**Alternatives:**
- **Trie / radix tree.** Enables prefix queries efficiently. Capella's FTS (via Bleve) uses prefix-supporting structures because users want autocomplete and wildcard search.
- **Finite State Transducer (FST).** Lucene's backing structure. Compact, mmap-friendly, sorted iteration cheap.

**Why hash map:** zero prefix-query requirements at this scope, simplest code, fastest exact-match. The cost is documented: no efficient prefix queries, no sorted term iteration. Acknowledged tradeoff.

### 7.2 Posting List Storage: Slice vs Roaring Bitmap

**Decision:** sorted slice of `Posting` structs.

**Alternatives:**
- **Roaring bitmaps** (used heavily in Lucene, Elasticsearch, and AFAIK in some Couchbase paths). Massive compression for doc-id sets, fast union/intersect operations.
- **Variable-byte encoded delta lists**, the classic IR compression.

**Why slice:** corpus is small, memory pressure is irrelevant, and the merge-join algorithm is easier to reason about and test on a slice. The compression conversation is one I'd happily have with an interviewer; I just don't need the code.

### 7.3 BM25 Parameters: Fixed Defaults vs Per-Field Tuning

**Decision:** fixed `k1 = 1.2`, `b = 0.75`. These are the values used in most BM25 implementations I have read (Lucene's defaults, Bleve's defaults).

**Alternatives:**
- Per-field tuning (Lucene supports this; useful when title and body have different statistical properties).
- BM25+ or BM25L variants that fix BM25's bias against long documents.

**Why defaults:** the engine does not support multi-field documents, so per-field tuning is moot. BM25+ would be a fun addition but its delta vs BM25 only matters on certain query/corpus distributions; not worth the complexity in this scope.

### 7.4 Vector Distance Function

**Decision:** cosine similarity (after pre-normalizing all vectors at insertion).

**Alternatives:**
- **L2 (Euclidean).** Standard for image embeddings.
- **Dot product (un-normalized).** What you want when magnitude carries meaning, e.g., some retrieval models.
- **Inner product with maximum inner product search (MIPS) reductions.** Whole research area.

**Why cosine for text:** modern text embedding models (e.g., the OpenAI `text-embedding-3-*` family, Cohere embed models, sentence-transformers' MPNet/MiniLM family) produce vectors where cosine similarity is the expected metric, often with vectors already L2-normalized at output. Matching the model's intended metric is non-negotiable for recall. For image or multi-modal embeddings, L2 might be more appropriate; the design allows swapping by providing a different distance function.

### 7.5 Brute-Force k-NN vs ANN

**Decision:** brute force, with full conversation about ANN in the limitations section.

**Alternatives considered and explicitly rejected for this scope:**
- **HNSW** (Hierarchical Navigable Small World, Malkov & Yashunin). State-of-the-art for in-memory ANN. Logarithmic expected query time. Famously hard to implement correctly, particularly around concurrent updates and deletes. Documented well; many open-source reference implementations exist.
- **IVF-Flat / IVF-PQ.** Cluster vectors with k-means; at query time, search only the nearest few clusters. Lower implementation cost than HNSW but worse recall/latency at the same parameters. Quantization (PQ) gives massive memory savings at a recall cost.
- **LSH (Locality-Sensitive Hashing).** Older approach, generally surpassed by HNSW and IVF for high-dimensional dense vectors.

**The reasoning:** brute force is the correctness reference. Any ANN structure must be measured against it for recall. Without brute force, you cannot evaluate ANN. So even in a production system, brute force is not wasted code — it's part of the test suite.

The interview conversation about ANN is what matters. I will not pretend to have implemented HNSW.

### 7.6 Top-K via Min-Heap vs Full Sort

**Decision:** min-heap of size `k` (`container/heap`).

**Reasoning:** scoring N candidates and sorting all of them is O(N log N). Maintaining a min-heap of size k as we iterate is O(N log k). For k=10 over N=5000, this is a 3x cost reduction in the dominant comparison count, but more importantly it's the *correct* algorithm — the one a database engineer is expected to reach for instinctively. Getting this detail right matters more than the absolute speedup.

### 7.7 Fusion: RRF vs Weighted Sum vs Learned

**Decision:** RRF.

Covered in detail in section 5.6. The short version: RRF works on ranks (unitless, comparable) rather than scores (incomparable across rankers). Weighted sum requires score normalization which has no principled solution. Learned-to-rank is the next step up but requires labeled data.

### 7.8 Persistence: JSON vs gob vs Protobuf vs Custom Binary

**Decision:** JSON.

**Reasoning:** at this scope, persistence speed and size don't matter. Human-readability during development matters. The interesting persistence questions (WAL, mmap, atomic durable writes, recovery) are all out of scope; once any of them is in scope, JSON would be the wrong choice and the discussion would move to formats like Pebble's SSTables or LMDB's mmap'd B-tree.

---

## 8. Project Structure

```
hybridsearch/
├── README.md                      # entry point, project overview, quickstart
├── REQUIREMENTS.md                # this file
├── LICENSE                        # MIT or Apache 2.0
├── go.mod
├── go.sum
│
├── cmd/
│   └── hybridsearch/
│       └── main.go                # CLI: index, query, benchmark subcommands
│
├── pkg/
│   ├── index/
│   │   ├── doc.go                 # package-level documentation
│   │   ├── tokenizer.go           # default tokenizer + Tokenizer interface
│   │   ├── tokenizer_test.go
│   │   ├── inverted.go            # InvertedIndex, Posting, PostingList
│   │   ├── inverted_test.go
│   │   ├── bm25.go                # BM25 scoring function
│   │   └── bm25_test.go
│   │
│   ├── vector/
│   │   ├── doc.go
│   │   ├── distance.go            # cosine, L2, dot product
│   │   ├── distance_test.go
│   │   ├── store.go               # VectorStore, brute-force k-NN
│   │   └── store_test.go
│   │
│   ├── hybrid/
│   │   ├── doc.go
│   │   ├── rrf.go                 # Reciprocal Rank Fusion
│   │   └── rrf_test.go
│   │
│   ├── engine/
│   │   ├── doc.go
│   │   ├── engine.go              # top-level Engine type, unifies index + vector + hybrid
│   │   └── engine_test.go         # integration tests
│   │
│   └── store/
│       ├── doc.go
│       └── jsonstore.go           # Save/Load
│
├── bench/
│   └── bench_test.go              # Go benchmarks at multiple corpus sizes
│
├── internal/
│   └── synthetic/
│       └── corpus.go              # generate test corpora
│
└── docs/
    ├── ARCHITECTURE.md            # architecture diagrams and rationale
    ├── BENCHMARKS.md              # benchmark methodology and results
    └── LIMITATIONS.md             # honest accounting of what's missing
```

Why this layout: `cmd/` for executables, `pkg/` for the public library, `internal/` for things that should not be importable by users. Conventional Go layout. The `docs/` directory is the deliberate signal that this project takes its writing seriously, not as an afterthought.

---

## 9. Implementation Milestones

The implementation is sequenced to ensure the most valuable parts are working first. If anything has to be cut, it's cut from the end of the list, never the middle.

### Milestone 1 — Foundations
- Repo, module, package skeletons, doc comments
- Synthetic corpus generator (5,000 documents with text + 128-dim random unit vectors)
- README skeleton with quickstart

### Milestone 2 — Lexical Path Complete
- Tokenizer with tests
- Inverted index with posting list construction
- BM25 scoring with hand-verified golden tests
- `QueryText` working end-to-end on the synthetic corpus

### Milestone 3 — Vector Path Complete
- Distance functions with property tests
- Vector store with brute-force k-NN
- `QueryVector` working end-to-end

### Milestone 4 — Hybrid Path Complete
- RRF fusion with hand-verified tests
- `QueryHybrid` returning fused results
- Integration test proving hybrid differs from either single path

### Milestone 5 — Persistence + CLI
- JSON save/load
- CLI subcommands: `index`, `query-text`, `query-vector`, `query-hybrid`, `bench`

### Milestone 6 — Benchmarks + Docs
- Benchmark suite measuring latency at corpus sizes 1K, 5K, 10K
- README polished with architecture diagram and quickstart
- LIMITATIONS.md written honestly
- Clean git history; squash messy intermediate commits

**Cut-line policy:** if Milestone 6 is at risk on the final day, cut benchmark variations down to a single corpus size. Never cut documentation. The documentation is half the project's signal.

---

## 10. Benchmarking Methodology

### What we measure

For each of `QueryText`, `QueryVector`, `QueryHybrid`, at corpus sizes of 1K, 5K, and 10K documents:
- Median latency (p50)
- Tail latency (p95, p99)
- Memory consumption of the index (`runtime.MemStats.HeapAlloc` before and after building)

### What we deliberately don't measure

- **Throughput under concurrency.** With a global RWMutex, this is structurally not interesting.
- **Recall vs ground truth.** Brute force *is* ground truth here. Recall measurement matters once we have an ANN structure; right now it would always be 100%.

### Why honest benchmarks matter

Real interview gold: showing benchmark numbers that surface obvious scaling issues, then talking about how production systems address them. If our `QueryText` shows linear scaling with corpus size (it will), that opens the conversation about why production engines achieve sub-linear scaling through skip lists, term-level early termination (WAND, BMW algorithms), and index-time precomputation.

The benchmark exists to surface a conversation, not to set a record.

---

## 11. Honest Limitations

The single most important section of the README. The credibility of the entire project rests on being explicit about what's missing. I would rather call out fifteen real limitations than pretend the project is more than it is.

### Already covered above
- No ANN. Brute force only.
- Single-process, no sharding, no replication.
- Naive tokenizer. No stemming, no language awareness, no n-grams.
- No prefix or wildcard queries.
- No compression on posting lists.
- Single global RWMutex blocks reads during writes.
- JSON persistence. No crash recovery, no WAL.

### Worth calling out separately
- **Filtered vector search not supported.** If a user wants "nearest neighbors of vector V where category = 'docs'", the engine has no good answer. Pre-filter, post-filter, and inline filter each have known recall/latency tradeoffs; this is an active research area. Real systems (pgvector, Pinecone, Weaviate) have all had to make explicit choices here.
- **No deletes.** Adding deletes to an inverted index is straightforward (tombstone the docID). Adding deletes to an ANN graph (especially HNSW) is hard because of dangling edges. The fact that this engine has no deletes is a deliberate avoidance of that hard problem at this scope.
- **No incremental rebuild.** Adding documents updates the index in place. Real systems often do segment-based indexing (Lucene's model): immutable segments + periodic merging. This makes concurrent reads cheap and unlocks crash-safe writes.
- **Embedding model not bundled.** Vectors are supplied by the caller. A real product needs a model server pipeline. Conscious choice — embedding is a separable concern.
- **No score interpretability.** BM25 scores can be inspected; cosine scores can be inspected; RRF scores are unitless. A real product needs to surface explanations for users ("matched these terms; semantic similarity 0.83"). Not here.

---

## 12. Connection to Production Systems

A section that exists to demonstrate that I have thought about how this scaffolding maps to systems I've actually used or want to contribute to.

### Couchbase Capella's FTS and Vector Search

Capella's full-text search is built on **Bleve**, the open-source Go full-text search library that originated at Couchbase. Bleve uses sophisticated structures I deliberately did not replicate here — FSTs for terms, segment-based immutable indexes, scorch as the default index type. Reading Bleve's source after building my naive version is on my list precisely because the contrast surfaces what the production decisions cost in complexity.

Capella's vector search capability (added relatively recently, sometime around 2023–2024 — I should verify the exact GA timeline) integrates vector indexing alongside the FTS engine, enabling hybrid queries at the platform level. The product-side challenge I've been close to is helping users reason about when to use vector vs FTS vs hybrid for their workloads — a conversation that would have been more useful had I understood the internals as deeply then as I will after this project.

### CockroachDB's Specialized Indexing

CockroachDB is integrating vector indexing into the SQL engine itself (the SQL Queries team's Specialized Indexing subteam). The conceptual translation:
- My single-file inverted index → in CockroachDB, the inverted index would live in Pebble (the LSM-tree storage engine), sharded by token across ranges. Posting lists become key-value entries.
- My brute-force vector store → would be replaced by an ANN structure (likely graph-based) integrated with the storage engine, with the *very* hard distributed problems of shard-level top-k aggregation and update propagation.
- My single-process RRF → would happen at the gateway node, after distributed sub-queries return their per-shard candidates.
- The optimizer needs to learn when a hybrid query plan beats either single plan, requiring cost statistics for the index types.

This project does not solve any of that. It does, I hope, give me the vocabulary to discuss it.

### pgvector

The minimalist Postgres extension that brought vector search to the world's most-used relational database. Implements both flat (brute force) and IVF-Flat / HNSW indexes as access methods plugged into Postgres's existing infrastructure. Worth studying as an example of how to add vector capability to an existing engine with minimal disruption to the rest of the system — the philosophical opposite of CockroachDB's path of building vector indexing natively into the SQL layer.

---

## 13. References & Further Reading

I am being careful here to cite only sources I am confident exist. Where I'm not certain of exact bibliographic details, I describe the content and let the reader verify.

- **BM25.** The canonical reference is Robertson and Zaragoza's 2009 monograph *"The Probabilistic Relevance Framework: BM25 and Beyond"* — I'm fairly confident on this title; please verify before citing formally.
- **HNSW.** Malkov and Yashunin, paper introducing Hierarchical Navigable Small World graphs. Author attribution confident; exact title and year should be verified at point of citation.
- **Reciprocal Rank Fusion.** Cormack, Clarke, and Buettcher, SIGIR 2009. I'm fairly confident on the authors; verify exact title before formal citation.
- **Designing Data-Intensive Applications**, Martin Kleppmann. The standard background reading for everything distributed-systems-adjacent.
- **Database Internals**, Alex Petrov. Covers storage engines, B-trees, LSM-trees, distributed databases.
- **Bleve** — github.com/blevesearch/bleve. The Go full-text search library underlying Couchbase FTS.
- **Pebble** — github.com/cockroachdb/pebble. CockroachDB's LSM-tree storage engine.
- **pgvector** — github.com/pgvector/pgvector. Postgres vector extension.

> The above references are starting points. Where any specific citation matters (e.g., in published writing), I will verify the exact bibliographic details directly from the source before relying on them. I do not want to propagate small errors that compound into wrong attributions.

---

## 14. What This Project Is Not Trying to Prove

A closing section, written deliberately to manage interview expectations.

This project is not me claiming to be a database internals engineer. It is me, a twelve-year full-stack engineer with a year of close exposure to Couchbase Capella's semantic search features, doing the kind of bottom-up learning project that I would expect any senior candidate to do when entering a new domain. The artifact's value is not the code — it's the evidence that I can pick up a domain, scope a project honestly, build it cleanly, document it carefully, and reason about its limitations.

If that's the kind of engineer the Specialized Indexing team wants to add to its bench, this project is a useful signal. If not, the project is still net-positive for me — I will come out of it materially closer to being able to contribute to the kind of system I want to work on.

That's the entire story.
