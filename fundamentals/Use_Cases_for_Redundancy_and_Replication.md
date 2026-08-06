# Use Cases for Redundancy and Replication

Redundancy and Replication make systems **fault-tolerant** (they keep working when parts break) and **continuously available** (users never see an outage):

- **Redundancy:** Duplicates *hardware, network paths, and application servers* to remove **single points of failure (SPOFs)** — any one component whose death takes the whole system down.
  - *In plain words:* keep a **spare tyre**. If one machine dies, an identical standby is already there to take over.
  - *Example:* two load balancers instead of one; three app servers behind them; two power feeds to the rack.
- **Replication:** Copies *data* across multiple machines or geographic regions so the system keeps running **accurately** even when a server fails.
  - *In plain words:* keep **photocopies of your document in several filing cabinets**. Lose one cabinet, the data still exists elsewhere.
  - *Example:* your orders table lives on a primary database *and* two copies (replicas) in other datacenters.

> **One-line difference to remember:** *Redundancy = spare copies of the **machines**. Replication = spare copies of the **data**.* You then tune **how many** copies and **how fast** they sync using two dials — **RPO** and **RTO** (defined below).

>
> **How to use this in the repo:** this is the **use-case index** for *§12 Replication* in [`key-technologies-notes.md`](../key-technologies-notes.md) (which carries a linked copy of the matrix). Concept depth lives in [`interviews/sharding-replication/`](../interviews/sharding-replication/), [`interviews/consensus/`](../interviews/consensus/) and [`interviews/kv-store/`](../interviews/kv-store/); each system below is cross-linked to its topic folder in the table at the end.
>
> **Companion doc:** [`Use_Cases_for_Caching.md`](./Use_Cases_for_Caching.md) — the same 17 systems, in the same order, answering the *other* half of the data-movement question. **A replica is a copy you are allowed to trust; a cache is a copy you are allowed to lose.** Losing a replica is a **durability** incident; losing a cache is a **capacity** incident. Read a system's two rows together. Third in the series: [`Use_Cases_for_Proxies.md`](./Use_Cases_for_Proxies.md) — *how traffic reaches the system safely* (same 17 systems). Plus [`Use_Cases_for_Databases.md`](./Use_Cases_for_Databases.md).
>
> ⚠️ **Accuracy note (read before quoting):** the specific *system → technology* mappings are **illustrative teaching heuristics**, not verified current architectures. Some are dated or approximate — e.g. FB Messenger historically used **HBase → MyRocks** (not Cassandra); Netflix uses **Cassandra / EVCache** (not CockroachDB); Uber's **Ringpop** is a SWIM-gossip + consistent-hashing *membership* library, not "ring buffers." Trust the **patterns**; verify the **tech** against primary sources.

---

## 1. Core Redundancy & Replication Concepts

```
                   [ Client Request ]
                           │
                           ▼
               [ Primary / Leader Node ]
                 (Processes All Writes)
                      ┌────┴────┐
                      │         │
   Synchronous Replication     Asynchronous Replication
   (RPO = 0, Higher Latency)   (Low Latency, Potential Lag)
                      │         │
                      ▼         ▼
           [ Replica / Follower 1 ]    [ Replica / Follower 2 ]
          (Read-Only / Hot Standby)   (Read-Only / Read Replica)
```

*Read the diagram as a story:* every **write** goes to one boss node (the **Primary/Leader**). It then copies the change to its **followers** — either **synchronously** (wait for them → safe but slower) or **asynchronously** (don't wait → fast but the copies lag). Followers are **read-only**: they answer read queries and stand ready to be promoted if the Primary dies.

### A. System Reliability Metrics — *"how good must it be?"*

These three numbers are the **requirements** you agree on *before* designing. They decide how much replication you actually need.

- **Availability (e.g. 99.999% / "Five Nines"):** the fraction of time the system is up. Five nines = **no more than ~5.26 minutes of downtime per year**. Requires automated failover + multi-region.
  - *In plain words:* "out of a whole year, how many minutes are we allowed to be down?"
  - *Recall:* each extra "nine" is **~10× less downtime**. 99.9% ≈ 8.8 h/yr, 99.99% ≈ 52 min/yr, 99.999% ≈ 5 min/yr.
- **RTO (Recovery Time Objective):** the maximum time the system may stay **down** after a crash before it's back.
  - *In plain words:* **"how fast must we get back up?"**
  - *Example:* RTO = 30 s → you need a **hot standby** that auto-promotes; RTO = 4 h → a nightly backup you restore by hand may be fine.
- **RPO (Recovery Point Objective):** the maximum amount of **data loss** allowed, measured in *time*.
  - *In plain words:* **"how much recent data may we lose?"** RPO = 0 means *zero* loss allowed.
  - *Example:* a bank sets **RPO = 0** (every transaction must survive → synchronous replication). "Nearby Friends" GPS tolerates **RPO ≈ 5 s** (losing a few location pings is fine → async).

> 🎯 **The two dials, connected:** **RPO picks your replication *mode*** (0 → synchronous), and **RTO picks your failover *automation*** (seconds → hot standby that auto-promotes). Say these two numbers first; the rest of the design falls out of them.

### B. Replication Layouts & Strategies — *"who is allowed to write?"*

This is the single biggest architectural fork. It's about **where writes are accepted**.

1. **Single-Leader (a.k.a. Primary-Replica / Master-Slave / Leader-Follower):**
   - **How it works:** *all* writes go to **one** Primary node. Replicas copy the Primary's **log** (its list of changes) and serve **reads**.
   - *In plain words:* **one person writes in the notebook; everyone else photocopies it to answer questions.** No arguments about what's true — there's one author.
   - *Real tech example:* **Postgres/MySQL streaming replication**, DynamoDB single-table primary, most classic web apps.
   - *Pick it when:* reads ≫ writes and you want simplicity + strong ordering (TinyURL, Yelp).
   - **Trade-off:** simple and orderly, but the **single Primary caps your write speed** and is a SPOF until failover promotes a replica.

2. **Multi-Leader (Active-Active):**
   - **How it works:** **several** nodes (often in different datacenters) accept writes **at the same time**, then replicate to each other.
   - *In plain words:* **two managers in two offices both editing the same document** — great until they edit the same line and you must merge.
   - *Real tech example:* multi-region Cassandra/CockroachDB active-active; think **Google Docs offline edits** or **git branches** merging.
   - *Pick it when:* you need **low-latency writes in many regions** and can define merge rules.
   - **Trade-off:** fast global writes, but you **must resolve conflicts** — via **Last-Write-Wins (LWW)** or **CRDTs** (see decoder).

3. **Leaderless Replication (Dynamo-Style):**
   - **How it works:** the client writes to / reads from a **majority of peer nodes** directly, using **Quorum Consensus (W + R > N)**. No single boss.
   - *In plain words:* **ask a majority of your friends what the plan is** — if most agree, trust it. No one person is in charge, so no one's death stops you.
   - *Real tech example:* **Cassandra, AWS DynamoDB, Riak** (FB Messenger-style chat stores).
   - *Pick it when:* you need **maximum write availability** and can tolerate eventual consistency.
   - **Trade-off:** no failover step + survives network faults, but needs background cleanup — **Read Repair** and **Merkle Trees** — to fix replicas that fell behind.

### C. Replication Modes — *"how long does the leader wait before saying 'done'?"*

Same layouts, but *when* does the client hear "success"?

- **Synchronous:** the Primary **waits for replicas to save the data** before telling the client "Success."
  - *In plain words:* **"wait for the courier to confirm delivery before you tell the customer it arrived."** Safe — nothing is lost — but slower.
  - *Guarantee:* **RPO = 0**. *Cost:* higher write latency; a slow replica slows everyone.
- **Asynchronous:** the Primary replies "Success" **immediately** after writing locally, and copies to replicas afterward.
  - *In plain words:* **"tell the customer it's done, courier delivers later."** Fast — but if the Primary crashes before the copy finishes, that write is **lost**.
  - *Guarantee:* low latency; *risk:* small data-loss window (RPO > 0), stale reads on replicas.
- **Semi-Synchronous:** the Primary waits for **at least one** replica to confirm, then replies.
  - *In plain words:* **"wait for just one courier to confirm, not all of them."** The common middle ground — survive one node's death without paying full sync cost.

> 🔗 **Connect the dots (B × C):** *Layout* answers **who writes**; *Mode* answers **how safely**. A bank = single-leader **+ synchronous** (RPO 0). A global social feed = single/multi-leader **+ asynchronous** (speed, staleness OK). A chat store = leaderless **+ quorum** (always writable).

### D. Jargon Decoder — *the scary words in the matrix, in plain English*

Every term that shows up in the 17 systems below, with a one-line meaning, a concrete example, and where it appears:

| Term | In plain words | Technical example | Appears in |
|---|---|---|---|
| **Erasure coding** (Reed-Solomon) | Split a file into data pieces **+ a few "recovery" pieces** (like Sudoku parity) so you can lose some pieces and rebuild. Cheaper than full copies. | 1.5× storage vs 3× for full replication | Dropbox, Pastebin |
| **Quorum (N, W, R)** | You need a **majority to agree**. Write to W nodes, read from R; if **W + R > N** the read always overlaps the latest write. | N=3, W=2, R=2 | FB Messenger, Cassandra/Dynamo |
| **Read Repair** | While reading, if one replica is stale, **fix it on the spot**. | background convergence in Cassandra | FB Messenger, kv-store |
| **Merkle Tree** | A **tree of checksums** to quickly find *which* block differs between two replicas without comparing everything. | anti-entropy sync | Dynamo-style stores |
| **Consensus** (Paxos / Raft) | A **voting protocol** so all nodes agree on one value even if some fail — prevents **split-brain** (two bosses). | etcd, ZooKeeper, Raft locks | Dropbox, TicketMaster |
| **CRDT** | Data types that **merge automatically with no conflict** (e.g. a counter that only goes up, an add-wins set). | collaborative editing, carts | Multi-leader systems |
| **Last-Write-Wins (LWW)** | On conflict, **the newest timestamp wins** — simple, but can silently drop a write if clocks are skewed. | Cassandra default | Multi-leader systems |
| **Hot standby** vs **Read replica** | *Hot standby* = a fully-synced copy **waiting to take over instantly**. *Read replica* = a copy used to **serve read traffic**. | Postgres sync standby vs read replicas | TinyURL, Twitter |
| **Replication factor (RF)** | **How many copies** of each piece of data exist. | Kafka RF=3 = 3 brokers hold each partition | Twitter, Kafka |
| **VIP failover** | A **virtual IP** that instantly reroutes traffic from a dead node to a healthy one. | keepalived / ELB | TinyURL |
| **Consistent hashing (ring)** | A key→node map where **adding/removing a node moves minimal data**. | Dynamo, Ringpop | Uber, kv-store |
| **Redis Sentinel** | Redis's built-in **watchdog** that auto-promotes a replica to primary on failure. | Redis HA | Rate limiter |
| **TAO** | Facebook's **graph cache** sitting in front of MySQL for social reads. | read-through cache | FB NewsFeed |
| **WAL / log shipping** | The leader's **write-ahead log** (ordered list of changes) streamed to replicas to replay. | Postgres WAL | all single-leader |
| **AZ vs Region** | *Availability Zone* = isolated datacenter **within** a region; *Region* = a **geographic** location. | AWS us-east-1a vs us-east-1 | Pastebin, Netflix |
| **Ephemeral state** | Data that's **short-lived and OK to lose** (kept in RAM, not durably stored). | in-memory GPS pings | Nearby Friends |

### E. Decision Guide — *which replication do I pick?* (for PRDs & interviews)

Walk these **four questions** in order; each answer eliminates options:

1. **What's the RPO?** *Zero data loss?* → **synchronous** (single-leader sync or quorum). *Some loss OK?* → **async** (faster).
2. **What's the read:write ratio?** *Reads ≫ writes?* → **single-leader + read replicas** (cheap read scaling). *Writes everywhere / always-on?* → **leaderless quorum** or **multi-leader**.
3. **How low must write latency be, globally?** *Users on many continents writing?* → **multi-leader / active-active** (accept conflict-resolution cost). *One region writes?* → single-leader.
4. **What's the RTO / failover speed?** *Seconds?* → **hot standby + auto-promote** (Sentinel/Raft/VIP). *Minutes-hours OK?* → simpler backup-restore.

> 📝 **PRD sentence template:** *"We target **{availability}** with **RPO = {X}** and **RTO = {Y}**, so we use **{layout} + {mode}** replication, with **{failover mechanism}** for automatic recovery."*
>
> *Filled example (checkout):* "We target 99.99% with **RPO = 0** and **RTO = 30 s**, so we use **single-leader synchronous** replication with a **Raft-elected hot standby** for automatic failover."

---

## 2. Comparative Architectural Summary Matrix

> Read each row as: *pattern (who writes) → mode (how safely) → why it fits this product.*

| # | System | Primary Replication Pattern | Synchronization Mode | Primary Purpose & Key Impact |
|---|---|---|---|---|
| 1 | **TinyURL** | Single-Leader DB + Redis Replicas | Asynchronous | Handles high read volumes; provides instant VIP failover. |
| 2 | **Pastebin** | Multi-AZ Erasure Coding + DB Replicas | Async (Media), Sync (DB) | Guarantees file durability across zones with low storage overhead. |
| 3 | **Instagram** | Primary-Replica + Multi-Region CDN | Asynchronous | Serves timeline and photo reads locally from nearby regional replicas. |
| 4 | **Dropbox** | Erasure Coding + Paxos Consensus | Synchronous (Metadata) | Guarantees strict metadata accuracy and extreme file block durability (99.999999999%). |
| 5 | **FB Messenger** | Leaderless Quorum (Cassandra) | Configurable Quorum (W = 2) | Ensures high cross-datacenter write availability for messaging. |
| 6 | **Twitter** | Kafka Queue (Factor = 3) + Redis Replicas | Asynchronous | Protects timeline updates with durable queue replication. |
| 7 | **YouTube** | Multi-Tier CDN Dynamic Replication | Asynchronous | Replicates viral videos across edge CDN servers based on view counts. |
| 8 | **Netflix** | Multi-Region Active-Active (Cassandra) | Asynchronous (Cross-Region) | Allows evacuation of an entire cloud region without stream interruption. |
| 9 | **Typeahead** | Immutable Trie Read-Replica Swaps | Batch / Snapshot | Serves sub-20ms keypress lookups from RAM clusters without write locks. |
| 10 | **API Rate Limiter** | Redis Sentinel + Local Fallback | Asynchronous | Maintains rate enforcement even when cache shards fail. |
| 11 | **Twitter Search** | Inverted Index Shard Replicas | Asynchronous | Balances heavy search queries across redundant index shards. |
| 12 | **WebCrawler** | Replicated Task Queues + DB Sync | Asynchronous | Automatically re-queues lost fetch tasks if a crawler server dies. |
| 13 | **FB NewsFeed** | TAO Multi-Region Graph Replication | Asynchronous Invalidation | Separates local graph cache reads from primary region database writes. |
| 14 | **Yelp** | Single-Leader DB + Read Replicas | Asynchronous | Scales read throughput for business pages across regional read nodes. |
| 15 | **Nearby Friends** | Ephemeral Memory Ring + Redis Replicas | Asynchronous | Handles high write volume for GPS pings; prioritizes speed over durability. |
| 16 | **Uber Backend** | Active-Active Ring Buffers (Ringpop) | Synchronous In-Memory | Maintains stateful failover for driver streams and trip matching sessions. |
| 17 | **TicketMaster** | Leader-Follower + Raft | Synchronous | Guarantees zero data loss to prevent double-booking during ticket drops. |

### 2b. Replication decisions that aren't in the 17 — *the repo's pattern folders*

The 17 above are *products*. These are the **mechanism** and **discipline** folders — each holds a replication decision the product rows depend on but don't explain, and several are where interviewers go to separate levels.

| Topic | Pattern / Mode | Why it's worth naming |
|---|---|---|
| [consensus](../interviews/consensus/) | Replicated state machine over a Raft/Paxos log · **synchronous, RPO = 0 by definition** | The mechanism rows 4 and 17 delegate to. Sizing: `2f+1` nodes tolerate `f` failures, so you scale consensus **out by sharding into many small groups**, never by growing one. |
| [storage-engines](../interviews/storage-engines/) | **WAL / log shipping** · sync mode = "how long the leader waits for a follower to ack a WAL record" | Replication and crash recovery are the **same mechanism pointed at two destinations**. Corollary: **`fsync` policy sets your real RPO** — acking before your own log is durable loses writes even with a healthy sync replica. |
| [distributed-transactions](../interviews/distributed-transactions/) | No layout of its own; **2PC over Paxos groups** (Spanner) · synchronous where atomicity crosses a boundary | *"2PC over unreplicated participants is a durability lie"* — a prepared participant must survive a crash to honor its promise, so replication is a **precondition for correctness**, not an add-on. |
| [payment-system](../interviews/payment-system/) | Single-leader **sync/semi-sync** on an append-only ledger | The one place **RTO is deliberately looser than RPO**: promoting a lagging replica is *worse* than staying down, because it silently loses committed money. |
| [e-commerce](../interviews/e-commerce/) | **Three layouts in one system** — catalog async replicas, cart leaderless/AP, orders single-leader sync | The canonical "don't pick one strategy for the whole system" case. Rejected cart write = lost revenue → AP. Lost order = legal problem → RPO 0. |
| [consistent-hashing](../interviews/consistent-hashing/) | Not a scheme — the **placement function**; preference list = next `N` distinct nodes on the ring | Answers "*which* N nodes hold this key" so capacity changes move ~`K/N` of the data. Trap: "distinct nodes" must mean **distinct failure domains**, or RF=3 in one rack buys nothing. |
| [collaborative-editing](../interviews/collaborative-editing/) | Single-writer session server per document (leader-per-doc) · op log persisted **before ack** | The **OT-vs-CRDT choice *is* a replication-layout choice**: OT needs a serialization point (single-leader); CRDTs merge without one (multi-leader is safe). |
| [communication-protocols](../interviews/communication-protocols/) | Kafka partition replication + **ISR** · `acks=all` + `min.insync.replicas=2` ≈ semi-sync | The highest-value config trio in messaging. `acks=all` **alone guarantees nothing** — with `min.insync.replicas=1` "all" can mean the leader by itself. And `unclean.leader.election` trades durability for availability. |
| [notification-system](../interviews/notification-system/) | Replicated Kafka (RF=3) + multi-region workers + **provider-level redundancy** · async | Protects a **queue, not a database** — lost messages are **silently** dropped notifications with no error surfaced. Multi-vendor failover is the higher-value redundancy here. |
| [distributed-caching](../interviews/distributed-caching/) | Partition (Redis Cluster) vs fully replicate a hot set · **async** | Unique justification in this repo: **you replicate a cache to protect your database, not the data** — you're guarding against the origin miss-storm, not data loss. |
| [observability](../interviews/observability/) | **Duplicated independent scraping**, deduped at query time — not replication at all · async | Deliberately breaks the pattern: two scrapers of one target give a free redundant copy with no quorum, and it's adequate because **a metric gap isn't a correctness bug**. The real requirement is *not sharing a failure domain with the monitored system*. |
| [recommendation-system](../interviews/recommendation-system/) | Kafka RF=3 + async feed replicas; the **ANN index is rebuilt, not replicated** · async | **Rebuild, don't replicate** derived data — the log is the only thing that truly needs durability, and recomputation fixes corruption as well as loss. |
| [api-design](../interviews/api-design/) | Below this layer — but the **contract must expose** its consequences | *"Replication lag is an API-design problem."* A `201 Created` then a `404` from a read replica is fixed in the contract (return the entity, or pin a version), not with infrastructure. |
| [sse](../interviews/sse/) | Stateless handlers; fan-out replicated via NATS; **connection state deliberately not replicated** · async, at-most-once | A legitimate "we don't replicate" answer — made safe by `Last-Event-ID` + a replay buffer making reconnects cheap. Remove those and it becomes "we drop events." |

---

## 3. System-by-System Architecture Breakdown

> Each entry: **Strategy** (the tech), **How it works** (the mechanics), then **🧠 Plain words + interview hook** (the one line to recall + which core concept it proves).

### 1. TinyURL
- **Strategy:** Single-Leader Database Replication + Redis Cluster Replication.
- **How It Works:** Since TinyURL handles 100 reads for every 1 write, the Primary handles short-link creation while read replicas across regions serve link redirects. If a node dies, automated tools switch traffic to a healthy replica.
- **🧠 Plain words + hook:** *One notebook author (Primary) makes the links; many photocopies (replicas) answer "where does this link go?"* — the textbook **single-leader, read-heavy** case; a lost link can be recreated (loose RPO), but redirects must stay up (low RTO → VIP failover).

### 2. Pastebin
- **Strategy:** Multi-Region Object Storage Replication + Primary-Replica Metadata Database.
- **How It Works:** Raw text pastes are copied across multiple Cloud Availability Zones for high durability (99.999999999%). The metadata database uses asynchronous replication to keep read times fast globally.
- **🧠 Plain words + hook:** *Store the big file cheaply-but-durably (erasure coding across AZs); keep the little "where is it" index fast (async DB replica).* — proves **split the durability bar from the latency bar**: sync where correctness matters, async where speed does.

### 3. Instagram
- **Strategy:** Master-Replica Database Shards + Multi-Region Media Replication + TAO Graph Cache Replication.
- **How It Works:** Photos and videos copy asynchronously across global edge CDNs. User feeds and profiles read from local regional database replicas to reduce latency.
- **🧠 Plain words + hook:** *Put a copy of everything close to the user so reads are local.* — classic **read-locality via regional replicas + CDN**; writes stay central, reads go wide.

### 4. Dropbox
- **Strategy:** Reed-Solomon Erasure Coding Storage + Paxos Metadata Consensus.
- **How It Works:** Binary file chunks use Erasure Coding to lower storage costs (1.5x overhead instead of 3x traditional replication). File folder metadata uses Paxos/Raft consensus replication to guarantee strict file accuracy.
- **🧠 Plain words + hook:** *Cheap durable blocks (Sudoku-parity pieces) + a perfectly-agreed file index (voting).* — proves **erasure coding for cheap durability** and **consensus where the namespace must never lie**.

### 5. Facebook Messenger
- **Strategy:** Multi-Datacenter Cassandra Quorum Replication (N=3, W=2, R=2).
- **How It Works:** Chat messages must never be lost. Writes use leaderless quorum replication across datacenters. Active connection gateways use redundant proxies with fast failover.
- **🧠 Plain words + hook:** *Ask a majority to store each message; if most have it, it's safe.* — the canonical **leaderless quorum (W+R>N)**; always writable even if a datacenter is cut off.

### 6. Twitter
- **Strategy:** Redis Cluster Replication + Sharded Read Replicas + Kafka Queue Replication (Factor = 3).
- **How It Works:** Tweets publish to Kafka queue topics replicated across 3 brokers. Active user home feeds in Redis replicate asynchronously to standby nodes for instant failover.
- **🧠 Plain words + hook:** *Three copies of every queued tweet (RF=3) so no broker's death drops it.* — proves **replication factor on the write-log** turns a broker failure into a non-event.

### 7. YouTube
- **Strategy:** Multi-Tier Video Segment Replication (Origin Storage → Regional Storage → Edge CDN).
- **How It Works:** Viral videos copy to thousands of edge CDN servers close to users. Popularity algorithms dynamically scale a video from 1 origin copy to 1,000+ global copies based on view counts.
- **🧠 Plain words + hook:** *The more people watch it, the more copies drift toward them.* — **popularity-driven replication**: number of replicas is dynamic, not fixed.

### 8. Netflix
- **Strategy:** Global Active-Active Multi-Region Replication (Cassandra / CockroachDB) + EVCache Replication.
- **How It Works:** User viewing history and playback positions copy cross-region. If an entire AWS cloud region fails, Netflix reroutes global traffic to another region in seconds via DNS failover.
- **🧠 Plain words + hook:** *Every region can serve everything, so you can switch off a whole region and users never notice.* — **active-active multi-region** for region-level fault tolerance ("region evacuation").

### 9. Typeahead / Autocomplete
- **Strategy:** In-Memory Trie Read-Replica Clusters + Immutable Snapshot Swaps.
- **How It Works:** Pre-computed prefix search trees load into RAM across hundreds of read-only server instances. Updates deploy as zero-downtime memory snapshot swaps without locking live user queries.
- **🧠 Plain words + hook:** *Build the whole suggestion tree offline, then hot-swap the finished copy.* — **immutable read-replicas + snapshot swap** = no write locks on the hot path → sub-20 ms.

### 10. API Rate Limiter
- **Strategy:** Redis Cluster Replication + Local In-Memory Fallback.
- **How It Works:** Rate-limit counters replicate across Redis nodes. If a Redis cache node fails, local application memory handles rate checking to prevent unthrottled traffic spikes.
- **🧠 Plain words + hook:** *If the shared counter dies, count locally instead of letting everyone through.* — **graceful degradation**: the failure mode is *slightly-loose limits*, never *unlimited traffic*.

### 11. Twitter Search
- **Strategy:** Inverted Search Index Shard Replication.
- **How It Works:** Each search index partition maintains 2-3 active read replicas. Search query proxies direct search traffic to underutilized or healthy index replicas to maintain search speeds.
- **🧠 Plain words + hook:** *Keep 2–3 copies of each slice of the index and send each query to the least-busy one.* — **replicas for read throughput + load balancing**, not just failover.

### 12. WebCrawler
- **Strategy:** Replicated Task Queues + Storage Replication.
- **How It Works:** URL Frontier queues (Kafka/RabbitMQ) log tasks to disk. If a crawler worker server crashes mid-crawl, the lease expires and the task automatically re-queues to another active worker.
- **🧠 Plain words + hook:** *Every to-do is written down and leased; if a worker vanishes, its lease expires and the job comes back.* — **replicated queue + lease** makes worker death a retry, not a lost URL.

### 13. Facebook NewsFeed
- **Strategy:** Multi-Region TAO Graph Cache Replication + Event Store Replication.
- **How It Works:** NewsFeed servers read from TAO graph caches replicated in global regions. Primary region database writes send update events across background pipelines to keep regional caches refreshed.
- **🧠 Plain words + hook:** *Read from a nearby cached copy of the social graph; writes happen centrally and trickle out.* — **cache replication + async invalidation** separates fast local reads from central writes.

### 14. Yelp
- **Strategy:** Single-Leader Database + Read Replicas + Spatial Index Replication.
- **How It Works:** Reviews and business details change rarely. Read-only database replicas serve local business searches in each region, while a single primary node accepts new reviews.
- **🧠 Plain words + hook:** *Data barely changes and is read a lot → just add read replicas.* — the simplest right answer: **single-leader + read replicas** for a read-mostly workload.

### 15. Nearby Friends
- **Strategy:** Ephemeral Memory Mesh + Redis Geospatial Cluster Replication.
- **How It Works:** Location updates (100,000+ writes/sec) use short-lived memory states. GPS updates write to RAM nodes and copy asynchronously; losing 5 seconds of location data is acceptable over system downtime.
- **🧠 Plain words + hook:** *Locations are throwaway — keep them in RAM, copy loosely, and never let durability slow the firehose.* — proves **RPO can be deliberately loose**: choose speed/availability over durability.

### 16. Uber Backend
- **Strategy:** Active-Active Ring Buffers (Ringpop) + Stateful Match Service Redundancy.
- **How It Works:** Driver-rider matching and location streams run on consistent hashing ring buffers. Active driver sessions keep state on primary nodes, with secondary standby nodes receiving live state streams for zero-downtime failover during trips.
- **🧠 Plain words + hook:** *A live trip's state is mirrored to a standby so a node can die mid-ride and nobody notices.* — **stateful hot standby** (not just stateless data replication) for in-flight sessions. *(Ringpop = consistent-hashing membership, per the accuracy note.)*

### 17. TicketMaster
- **Strategy:** Synchronous Primary-Replica Database Pairs + Raft Distributed Reservation Locks.
- **How It Works:** Seat checkouts require zero data loss (RPO = 0). Seat booking writes use synchronous replication and Raft consensus across database nodes to guarantee a concert seat is never double-booked.
- **🧠 Plain words + hook:** *A booked seat must survive any crash, so wait for a replica + a vote before confirming.* — **synchronous + consensus (RPO=0)**; correctness beats latency at the money moment.

---

## Where these systems live in this repo

| # | System | Repo topic folder(s) |
|---|---|---|
| 1 | TinyURL | [url-shortener](../interviews/url-shortener/) |
| 2 | Pastebin | [file-storage](../interviews/file-storage/) |
| 3 | Instagram | [social-feed](../interviews/social-feed/) + [file-storage](../interviews/file-storage/) |
| 4 | Dropbox | [file-storage](../interviews/file-storage/) + [consensus](../interviews/consensus/) |
| 5 | FB Messenger | [chat-system](../interviews/chat-system/) + [kv-store](../interviews/kv-store/) |
| 6 | Twitter | [social-feed](../interviews/social-feed/) + [message-queues](../interviews/message-queues/) |
| 7 | YouTube | [video-streaming](../interviews/video-streaming/) + [cdn-edge](../interviews/cdn-edge/) |
| 8 | Netflix | [video-streaming](../interviews/video-streaming/) + [cdn-edge](../interviews/cdn-edge/) |
| 9 | Typeahead | [search-autocomplete](../interviews/search-autocomplete/) |
| 10 | API Rate Limiter | [rate-limiting](../interviews/rate-limiting/) |
| 11 | Twitter Search | [search-autocomplete](../interviews/search-autocomplete/) |
| 12 | WebCrawler | [web-crawler](../interviews/web-crawler/) + [message-queues](../interviews/message-queues/) |
| 13 | FB NewsFeed | [social-feed](../interviews/social-feed/) |
| 14 | Yelp | *no dedicated folder — geo read-replica pattern in [ride-sharing](../interviews/ride-sharing/); reviews/ranking in [recommendation-system](../interviews/recommendation-system/)* |
| 15 | Nearby Friends | [ride-sharing](../interviews/ride-sharing/) (+ courier-location parallel in [food-delivery](../interviews/food-delivery/)) |
| 16 | Uber Backend | [ride-sharing](../interviews/ride-sharing/) |
| 17 | TicketMaster | [seat-reservation](../interviews/seat-reservation/) + [consensus](../interviews/consensus/) |

| — | *concept home* | [sharding-replication](../interviews/sharding-replication/) — layouts, modes, lag, re-sharding |
| — | *§2b mechanism & discipline folders* | [consensus](../interviews/consensus/) · [storage-engines](../interviews/storage-engines/) · [distributed-transactions](../interviews/distributed-transactions/) · [payment-system](../interviews/payment-system/) · [e-commerce](../interviews/e-commerce/) · [consistent-hashing](../interviews/consistent-hashing/) · [collaborative-editing](../interviews/collaborative-editing/) · [communication-protocols](../interviews/communication-protocols/) · [notification-system](../interviews/notification-system/) · [distributed-caching](../interviews/distributed-caching/) · [observability](../interviews/observability/) · [recommendation-system](../interviews/recommendation-system/) · [api-design](../interviews/api-design/) · [sse](../interviews/sse/) |

> **Every** topic folder's `deep-dive.md` now ends with a **"🔁 Redundancy & Replication — how *this* system does it"** callout that expands its row above, immediately followed by its **"🗄️ Caching Strategy — how *this* system does it"** counterpart from [`Use_Cases_for_Caching.md`](./Use_Cases_for_Caching.md). Read the pair together: *replication = how it stays correct when machines die; caching = how it stays fast when users arrive.* (29 folders, both callouts — [sse](../interviews/sse/) carries them in `sse-deep-dive-qa.md`, which has no `deep-dive.md`.)

---

## Interview Recall Card (memorize these)

- **Redundancy = spare machines. Replication = spare data.** Two dials: **RPO** (data loss allowed) and **RTO** (downtime allowed).
- **Layout = who writes:** single-leader (one boss, read-scale) · multi-leader (many bosses, must merge) · leaderless quorum (vote, always writable).
- **Mode = how safely:** sync (RPO 0, slow) · async (fast, small loss window) · semi-sync (wait for one).
- **RPO 0 ⇒ synchronous. Low RTO ⇒ hot standby + auto-promote.** Bank = single-leader sync; chat = leaderless quorum; global feed = async.
- **Cheap durability = erasure coding** (1.5× vs 3×). **Never-lie index = consensus** (Paxos/Raft). **Fix stale replicas = read-repair + Merkle trees.**
- **When in doubt for a read-mostly system:** single-leader **+ read replicas** (the Yelp/TinyURL answer). Reach for quorum/multi-leader only when write availability or global write latency forces it.
