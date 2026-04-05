Design Gurus Logo
How would you design a multi‑model (graph+document) data service?
Most products need flexible documents and rich relationships at the same time. A multimodel data service gives you both by exposing one logical API that supports graph traversal and document retrieval with consistent performance and guardrails. For a system design interview this topic is a perfect way to show you can balance modeling clarity with operational reality inside a scalable architecture.

Why It Matters
A single model rarely fits all access patterns. Feed ranking wants graph walks. Profile and catalog pages want document reads and partial updates. Building a multimodel service helps you avoid awkward schema hacks, keeps latency predictable for both patterns, and reduces duplication. It also provides one security model and one tenant boundary across your distributed systems estate, which interviewers love to see.

How It Works Step by Step
1. Define the logical data model Start with a small set of first class entities such as User, Product, Post. Represent each entity as a document with a stable primary key and version. Represent relationships such as follows, purchased, liked as graph edges with typed labels. Keep a registry that maps document types to graph vertex types and captures versioned schemas for both. The registry drives validation and code generation.

2. Choose a storage strategy You have two broad routes. Route A is a unified multimodel database that stores JSON like documents and graph data in one cluster. This reduces integration work but ties you to a single vendor and set of trade offs. Route B is polyglot storage behind one service. Use a document store for entities and a graph store for relationships. The service hides the split and presents one logical API.

3. Design the write path Applications call a single write endpoint. The service validates the document against the schema registry, writes the document, and records an outbox event in the same transaction. A change capture worker consumes the outbox and upserts graph vertices and edges. Use idempotency keys to make the worker safe on retries. Keep a pointer from each graph vertex back to the document id so cross lookups are cheap.

4. Build the query planner Expose a high level API such as GraphQL or a resource based API that supports filters, projections, and traversals. The planner inspects the query and routes subparts to the right engine. Examples a. Fetch a profile document with a projection goes to the document store only. b. Find friends of friends with a minimum mutual count goes to the graph store and returns a list of ids that the planner then joins with documents. c. Hybrid queries run a traversal, then do a batched document fetch, then optional ranking. Streaming joins and pagination keep memory in check.

5. Index for both worlds Create compound secondary indexes in the document store for top filters and sorts such as status, tenant, update time. In the graph store index vertices by type and tenant and maintain adjacency indexes for hot relations. For supernodes cache neighbor lists in memory and shard logical neighbors across multiple physical vertices to avoid hot spots.

6. Partition and replicate Pick a tenant first partition key for both engines so cross model operations stay colocated. Within a tenant pick consistent hashing on entity id for documents. For the graph choose a partitioning strategy that preserves locality such as edge cut with community based placement. Use leader follower replication with quorum writes for durability. Accept eventual consistency across the two engines and design compensations for rare races.

7. Cache the right layers Use a read through cache for documents with short time to live based on update rate. Cache graph neighborhoods such as first and second degree ids for hot users. Invalidate caches through change streams from the outbox so staleness is bounded. For expensive hybrid queries precompute top N results per user and refresh on a schedule.

8. Secure and isolate tenants Enforce row level checks in both engines using a tenant id carried in the auth token and propagated via tracing headers. Use field level access control at the service layer for sensitive attributes. Encrypt at rest. Rotate keys per tenant when possible. Require signed writes with idempotency tokens to stop replay.

9. Observe and control quality Trace every hybrid request end to end with a shared correlation id. Publish p50 p95 p99 for pure document reads, pure graph traversals, and hybrids. Track per tenant saturation, hot partitions, and queue lag for the outbox worker. Add data quality expectations such as every persisted relationship must reference an existing document and no vertex should have dangling pointers.

10. Operate and evolve Support backward compatible schema changes through the registry. When adding a new edge type, deploy the schema, then backfill the graph using a batch job that reads documents, emits outbox entries, and upserts edges with the same idempotency keys. Keep runbooks for dual write recovery and reindexing.

Course image
Grokking the Advanced System Design Interview
Grokking the System Design Interview. This course covers the most important system design questions for building distributed and scalable systems.
4.1
Course image
Grokking System Design Fundamentals
Grokking System Design Fundamentals is designed to equip software engineers with the essential knowledge and skills required to design large complex systems.
4.6
Real World Example
Think of a social commerce app. Product and user profiles live as documents for quick page loads and partial updates. The social graph tracks follows, trust edges, and co views. When a user opens the home feed the service runs a traversal to find candidate products liked by close connections, joins with product documents to fetch price and stock, then ranks and returns a page. When a product updates its price the document store write emits an outbox event. The worker updates projections and refreshes any cached candidate lists. This design keeps fan out fast while preserving clean data ownership.

Common Pitfalls or Trade offs
Dual write anomalies Writing to both engines directly from the app leads to hard to debug divergence. Always funnel writes through one transaction plus outbox.

Cross model joins that explode Unbounded traversals that return large id lists create heavy fan out. Require limits and cut off strategies. Consider server side sampling and time budgets. Celebrity nodes and hot partitions Large degree vertices cause skew. Use neighbor sharding, sampled caches, and background computation of top N to smooth load. Index bloat Over indexing slows writes and increases cost. Audit index usage and remove rarely used ones. Leaky tenant boundaries If tenant id is not part of every key and every filter, cross tenant data can leak. Propagate tenant context everywhere and test with fuzzed tokens. Vendor lock in A unified engine is simple but may cap scale or feature depth. A polyglot design is flexible but increases operational work.

Interview Tip
Interviewers often ask how you keep the two models in sync without two phase commit. A crisp answer is to explain the outbox pattern. You write the document and outbox together, then a durable worker updates the graph with idempotent upserts. You describe how to handle retries, duplicate events, and replay after a crash. Add how you keep read paths predictable by using traversal first then batched document fetches with strict limits.

Key Takeaways
One logical API with two physical models gives clean modeling and fast access patterns
Outbox plus idempotent workers keep document and graph in sync without distributed transactions
Partition by tenant first to keep cross model operations colocated
Cache documents and hot graph neighborhoods with explicit invalidation from change streams
Keep hybrid queries bounded with limits, pagination, and precomputation
Table of Comparison
Approach	Strengths	Weaknesses	When to choose
Multimodel service over document plus graph	Best of breed engines, clear modeling, independent scaling, flexible indexing	Integration work, eventual consistency between engines, more ops	Large scale products with both traversal and rich document reads
Single document store only	Simple to operate, mature tooling, easy horizontal scale	Deep graph queries are slow or complex, joins require manual work	Catalog, content, or profile heavy systems with limited traversal
Single graph store only	Native traversals, community detection, path queries	Document projections and partial updates are awkward, large blobs inflate memory	Relationship heavy features with light document needs
Unified multimodel database	One cluster, single query language, simpler security	Vendor limits on scale or features, fewer knobs for each model	Small to medium teams that value simplicity over absolute scale
FAQs
Q1 What is a multimodel data service?
It is a single logical service that lets clients query and update both document shaped entities and graph relationships while hiding the underlying engines.

Q2 How do you keep documents and edges consistent without two phase commit?
Use an outbox pattern. Persist the document and an outbox record in one transaction. A worker reads the outbox, updates the graph with idempotent operations, and records success, which allows safe replay.

Q3 What query shapes benefit most from the graph side?
Friend of friend, mutual connections, short path, community based candidate generation, and any ranking feature that depends on local neighborhoods.

Q4 How do you scale traversals for celebrity nodes?
Split heavy vertices into multiple logical shards, cache top neighbors, add server side limits, and run background jobs that precompute personalized candidates.

Q5 Is a unified multimodel database always simpler?
It simplifies integration but may restrict performance tuning and feature depth. For high scale or specialized queries many teams prefer best of breed engines behind one service.

Q6 How do you test tenant isolation end to end?
Carry tenant id in auth tokens, attach it to every key and filter, run automated checks that try cross tenant reads and writes, and verify encryption keys are scoped per tenant.

Further Learning
Level up your skills with targeted practice. Start with the core modeling and trade offs in Grokking System Design Fundamentals. Then deepen your mastery of data paths, caching, and scale patterns in Grokking Scalable Systems for Interviews. Both courses include hands on patterns that pair well with a multimodel service design.

TAGS
System Design Interview
System Design Fundamentals
CONTRIBUTOR
Design Gurus Team
-
GET YOUR FREE
