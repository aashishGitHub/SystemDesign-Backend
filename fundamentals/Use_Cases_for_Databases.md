# Use Cases for Databases — Classification & When Each Qualifies

Picking a database is **two independent questions**, not one:

1. **What *shape* is my data, and how do I read it?** → picks the **family** (relational, key-value, document, wide-column, graph, …). This is §1.
2. **What must happen when the network breaks (or when it's fine)?** → picks the **consistency behaviour** (CAP / PACELC). This is §2–§3.

> **The two-question rule to remember:** *Data model chooses the **family**; CAP/PACELC chooses the **engine + how it behaves under failure**.* A "document database" isn't one choice — MongoDB (AP-leaning) and Couchbase behave differently under a partition. You must answer **both** questions.

- *In plain words:* first decide **what kind of container** fits your data (a spreadsheet? a dictionary? a network of friends?), then decide **how paranoid** it should be about correctness when servers can't talk to each other.

> ⚠️ **Don't say "SQL vs NoSQL."** That's a beginner tell. Name the **family** and the **specific property** you need ("I need a wide-column store for 100K writes/s with tunable quorum"), and name the **PACELC behaviour** you're choosing.

>
> **How to use this in the repo:** this elaborates *§1 Core Database* and *§11 CAP / PACELC* in [`key-technologies-notes.md`](../key-technologies-notes.md). Concept depth: [`interviews/storage-engines/`](../interviews/storage-engines/) (LSM vs B-tree — the physical layer *under* every DB), [`interviews/kv-store/`](../interviews/kv-store/) (Dynamo-style AP), [`interviews/distributed-transactions/`](../interviews/distributed-transactions/) (consistency models), [`interviews/sharding-replication/`](../interviews/sharding-replication/).
>
> **Companion docs:** [`Use_Cases_for_Redundancy_and_Replication.md`](./Use_Cases_for_Redundancy_and_Replication.md) (how a DB stays correct when machines die) and [`Use_Cases_for_Caching.md`](./Use_Cases_for_Caching.md) (how it stays fast). This doc answers *which* DB to reach for in the first place.
>
> ⚠️ **Accuracy note:** CAP/PACELC labels below follow **Daniel Abadi's PACELC** framing (2012) and the common textbook placements. **Most modern databases are *tunable*** — DynamoDB and Cassandra can be made more consistent per-request, MongoDB's behaviour depends on write/read concern, etc. Treat the labels as *defaults / design intent*, and verify a specific version's config before quoting.

---

## 1. Classification by Data Model — *"what shape is my data?"*

Each family below: **what it is (plain words) → when it qualifies → example engines → real system**.

| Family | In plain words | Qualifies when… | Example engines | Real system |
|---|---|---|---|---|
| **Relational (RDBMS)** | A **spreadsheet with enforced rules** — fixed columns, relationships, transactions. | You need **ACID transactions, joins, strong structure** (money, orders). Default choice until proven otherwise. | Postgres, MySQL | e-commerce orders, banking ledger |
| **Key-Value** | A **dictionary**: give a key, get a blob. Nothing fancy, very fast. | Lookups are **always by a single key**; you want extreme speed/scale. | Redis, DynamoDB, Riak | sessions, shopping cart, feature flags |
| **Document** | A **folder of JSON files** — nested, flexible, no fixed schema. | Data is **self-contained objects** with varying fields; you read a whole object at once. | MongoDB, Couchbase, Firestore | product catalog, user profiles, CMS |
| **Wide-Column** | A **giant sparse table** partitioned by row key; each row can have billions of columns. | **Huge write volume**, time-ordered rows, tunable consistency. | Cassandra, HBase, ScyllaDB, Bigtable | chat messages, event logs, IoT feeds |
| **Graph** | A **network of nodes + edges** — relationships are first-class. | Your queries are **"who is connected to whom, how many hops"**. | Neo4j, Neptune, JanusGraph | social graph, fraud rings, recommendations |
| **Time-Series** | A **log indexed by timestamp**, optimized for "last N minutes / downsample". | Data is **append-only measurements over time**. | InfluxDB, TimescaleDB, Prometheus | metrics/monitoring, sensor data |
| **Search / Inverted-index** | A **book's index** — word → list of docs, for fast text/faceted search. | You need **full-text, fuzzy, or faceted** queries (not exact-key lookups). | Elasticsearch, OpenSearch, Solr | product search, log search |
| **In-Memory** | Data lives in **RAM** — fastest, but volatile. | You need **sub-ms** access and can rebuild/lose the data. | Redis, Memcached | rate-limit counters, leaderboards, cache |
| **Blob / Object** | A **warehouse for big files**; the DB only holds a pointer. | You store **large unstructured binaries** (images, video). | S3, GCS, Azure Blob | media, backups, data-lake files |
| **NewSQL / Distributed SQL** | **Relational + horizontal scale + strong consistency** — the "have it all" tier (pays latency). | You need **SQL and global scale and strong consistency** at once. | Spanner, CockroachDB, YugabyteDB, TiDB | global inventory, multi-region fintech |
| **Vector** | Stores **embeddings** and finds "nearest meaning" by similarity. | **AI / semantic search / RAG** over embeddings. | Pinecone, Milvus, Weaviate, pgvector | semantic search, recommendations, LLM retrieval |

> 🎯 **Recall shortcut:** *by-key → KV; by-object → Document; by-relationship → Graph; by-time → Time-series; by-text → Search; by-similarity → Vector; by-transaction → Relational; by-write-volume → Wide-column; SQL-at-global-scale → NewSQL.*

---

## 2. Classification by CAP — *"what happens during a network partition?"*

**CAP:** during a **network partition** (nodes can't talk), you must pick **one**:

- **CP (Consistency + Partition-tolerance):** refuse to answer if you can't be sure it's correct → **reject/timeout** rather than serve stale. *Stays correct, sacrifices availability.*
  - *In plain words:* *"if I'm not certain, I'd rather say nothing than say something wrong."*
  - **CP engines:** HBase/Bigtable, MongoDB (majority config), ZooKeeper, etcd, Spanner, CockroachDB, traditional RDBMS with synchronous replication.
- **AP (Availability + Partition-tolerance):** keep answering from whatever node you can reach → replicas may diverge, reconcile later. *Stays up, sacrifices freshness.*
  - *In plain words:* *"always give an answer, even if it might be slightly out of date."*
  - **AP engines:** Cassandra, DynamoDB (default), Riak, Voldemort.
- **"CA" is a trap:** a single-node database is called "CA," but that only means it **doesn't tolerate partitions at all** — irrelevant for a distributed system, where partitions *will* happen. So real distributed choices are **CP or AP**.

> ⚠️ **Kill this misconception:** CAP is **not** "pick 2 of 3." When there's **no** partition you get **both** C and A. CAP only forces the choice **during** a partition. That's exactly the gap PACELC fills ↓.

---

## 3. Classification by PACELC — *the fuller rule (and where each DB qualifies)*

**PACELC** (Daniel Abadi, 2012) adds the missing half: *what do you trade off when everything is **normal**?*

> **if (P)artition → choose (A)vailability or (C)onsistency; (E)lse → choose (L)atency or (C)onsistency.**

So every DB gets **two letters**. Reading the label:

- **Spanner = PC / EC** → during a partition it picks **C**onsistency; and **E**lse (normal) it *still* picks **C**onsistency over **L**atency. **⇒ always strongly consistent, and it pays latency for it** (TrueTime "commit-wait"). *This is the answer to the "what does PC/EC mean" question that started this.*
- **DynamoDB / Cassandra = PA / EL** → partition → stay **A**vailable; normal → favor **L**atency over consistency. **⇒ fast and always-on, eventually consistent.**

| Database | Family | CAP | PACELC | Behaviour in one line |
|---|---|---|---|---|
| **Google Spanner** | NewSQL | CP | **PC/EC** | Always strongly consistent worldwide; pays latency (commit-wait). |
| **CockroachDB / YugabyteDB** | NewSQL | CP | **PC/EC** | Spanner-like strong consistency without Google's clocks. |
| **HBase / Bigtable** | Wide-column | CP | **PC/EC** | Strong per-row consistency; unavailable region during partition. |
| **ZooKeeper / etcd** | Coordination (consensus) | CP | **PC/EC** | Correct config/leader election; a minority partition can't serve. |
| **Traditional RDBMS (sync replication)** | Relational | CP | **PC/EC** | Postgres/MySQL with a sync standby: no stale reads, waits for the replica. |
| **MongoDB** (majority concern) | Document | CP-ish | **PA/EC** | Favors availability in a partition; consistent otherwise (config-dependent). |
| **PNUTS (Yahoo)** | — | CP | **PC/EL** | The rare corner: consistent under partition, but favors latency normally. |
| **Cassandra** | Wide-column | AP | **PA/EL** | Always writable, tunable quorum; eventual by default. |
| **DynamoDB** (default) | Key-value | AP | **PA/EL** | Always-on; optional strongly-consistent reads flip it toward PC per-request. |
| **Riak / Voldemort** | Key-value | AP | **PA/EL** | Dynamo-style leaderless; merges conflicts later. |

> 🔗 **Connect the dots to the consistency gradient:** in the e-commerce design, **browse** sits on **AP/EL** stores (Cassandra/Dynamo/cache — speed), while **checkout** sits on **CP/EC** stores (RDBMS/NewSQL — never oversell). *The same product uses different PACELC points for different paths.* (See [`Use_Cases_for_Redundancy_and_Replication.md`](./Use_Cases_for_Redundancy_and_Replication.md) and the e-commerce RADIO walkthrough.)

---

## 4. Decision Guide — *pick a database in 4 questions* (for PRDs & interviews)

1. **What's the access pattern / data shape?** (§1) — by-key → KV; nested object → Document; relationships → Graph; text → Search; timestamps → Time-series; transactions+joins → Relational; massive writes → Wide-column; embeddings → Vector.
2. **Do I need multi-row/multi-key ACID transactions?** *Yes* → Relational or NewSQL. *No* → a NoSQL family is on the table.
3. **What's my partition behaviour (CAP)?** *Must never serve wrong/stale (money, inventory)* → **CP**. *Must never reject a write (cart, chat, likes)* → **AP**.
4. **Normal-case trade-off (the E in PACELC)?** *Need lowest latency / global writes* → **EL** (Dynamo/Cassandra). *Need strong consistency always* → **EC** (Spanner/CockroachDB/sync RDBMS) — and **budget for the extra latency**.

> 📝 **PRD sentence template:** *"Access is **{pattern}**, so we use a **{family}** database (**{engine}**). Correctness bar is **{CP/AP}** with **{EL/EC}** normal-case behaviour, because **{reason}**."*
>
> *Filled example (checkout):* "Access is transactional by order id, so we use a **relational/NewSQL** DB (**Postgres**, or **CockroachDB** if we need multi-region). Bar is **CP / EC** because overselling or double-charging is unacceptable — we accept the added write latency."
>
> *Filled example (chat):* "Access is by conversation key at 100K writes/s, so a **wide-column** store (**Cassandra**). Bar is **AP / EL** because a message must always be acceptable even if a datacenter is cut off; we reconcile with quorum + read-repair."

---

## 5. Jargon Decoder — the DB words behind the labels

| Term | In plain words |
|---|---|
| **ACID** | Transactions that are **A**tomic (all-or-nothing), **C**onsistent (rules hold), **I**solated (don't interfere), **D**urable (survive crash). The relational promise. |
| **BASE** | The NoSQL opposite: **B**asically **A**vailable, **S**oft-state, **E**ventually consistent. Trades strict correctness for availability. |
| **Linearizable / strong** | Every read sees the **latest** committed write — the system behaves like a single copy. The "C" in PC/EC. |
| **Eventual consistency** | Replicas **converge if writes stop**; meanwhile you may read stale. The "L" in PA/EL. |
| **Tunable consistency** | You choose per-request (e.g. Cassandra/Dynamo `ONE` vs `QUORUM`) — which is why one DB can sit at different PACELC points. |
| **MVCC** | Multi-Version Concurrency Control — readers see a snapshot, writers don't block readers (Postgres). |
| **LSM-tree vs B-tree** | The **physical engine** under the DB: LSM = write-optimized (Cassandra/RocksDB), B-tree = read-optimized (Postgres/InnoDB). See [`interviews/storage-engines/`](../interviews/storage-engines/). |
| **Sharding vs Replication** | Sharding = **split** data across nodes (scale). Replication = **copy** data across nodes (durability/HA). Different axes — most systems do both. |

---

## Interview Recall Card (memorize these)

- **Two questions, always:** data **shape** (family) *and* failure **behaviour** (CAP/PACELC). Never just "SQL vs NoSQL."
- **CAP = partition-time choice:** CP (correct, may reject) vs AP (available, may be stale). "CA" = single-node, not a real distributed option.
- **PACELC = two letters:** partition → A or C; **E**lse → **L**atency or **C**onsistency. **Spanner = PC/EC (consistency always, pays latency); Dynamo/Cassandra = PA/EL (fast, eventual).**
- **Money/inventory → CP/EC** (Relational or NewSQL). **Cart/chat/likes → AP/EL** (KV or wide-column).
- **NewSQL (Spanner/CockroachDB) = "SQL + global scale + strong consistency"** — the thing once thought impossible; the price is latency.
- **Most engines are tunable** — the label is the default/intent, not a hard law. State the config you're assuming.
