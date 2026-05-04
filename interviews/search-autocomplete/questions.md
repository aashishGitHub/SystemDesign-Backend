# Interview Questions: Search Autocomplete / Typeahead

> Attempt all questions before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.
> Speak your answers aloud — interviewers evaluate communication, not just correctness.

---

## Level 1 — Fundamentals & Data Structures
*Goal: establish shared vocabulary and confirm you understand why this problem is hard.*

**Q1.** What is a search autocomplete system? Walk me through exactly what happens from a user typing the letter "a" to seeing 5 suggestions on screen — include every system component.

**Q2.** Why is a hash map (dictionary of all queries → frequency) *not* a sufficient data structure for autocomplete? What does a trie give you that a hash map cannot?

**Q3.** What is the time complexity of prefix lookup in a trie vs a sorted list vs a hash map? When would you choose each?

**Q4.** Define the node structure of a basic trie. What fields does each node contain? What does a leaf node look like vs an internal node?

**Q5.** *(Failure mode)* A junior engineer builds autocomplete with a single in-memory Python trie on one server. Name three specific ways this fails in production at 5,000 req/sec.

---

## Level 2 — Trie Design
*Goal: design a production-quality trie, not a textbook one.*

**Q6.** Walk through inserting the queries `["apple", "app", "application", "apt"]` into a trie one at a time. Draw the resulting node structure and explain what `isEndOfWord` means.

**Q7.** When a user types "app", how does the trie return suggestions? Describe the algorithm step-by-step.

**Q8.** What is the memory usage of a trie node in a production system? List every field and estimate bytes. How does branching factor affect total memory?

**Q9.** How would you compress a trie to reduce memory (DAWG / Patricia trie / radix tree)? What is the tradeoff vs a standard character-indexed trie?

**Q10.** *(Failure mode)* The trie is loaded from disk into memory on server startup. The trie file is 8 GB. What happens during the first 90 seconds after a server restart, and how do you mitigate it?

---

## Level 3 — Top-K Storage & Retrieval
*Goal: solve the performance problem that makes raw trie traversal impractical.*

**Q11.** Why is DFS traversal of a trie to find top-K suggestions too slow at scale? Give concrete numbers: 10M unique prefixes, 5K req/sec, what is the worst-case traversal cost?

**Q12.** Describe the "top-K stored at each node" strategy. What exactly is stored in each prefix node, and how is it used on a query?

**Q13.** When a query's frequency changes (e.g., "earthquakeSF" surges from rank 200 to rank 2), how do you update the top-K lists stored in all ancestor nodes of that query's leaf? What is the worst case?

**Q14.** Should you store the full suggestion string in each node or a pointer/ID to a string table? What are the memory and lookup latency tradeoffs?

**Q15.** You need top-5 suggestions. A user's query grows from "p" → "pr" → "pro" → "prog". Does each keystroke require a fresh trie lookup, or can results be progressively filtered client-side? What are the tradeoffs?

**Q16.** *(Failure mode)* The top-K lists stored in trie nodes become stale because the update pipeline fell 3 hours behind. What do users experience, and how do you design the system to degrade gracefully?

---

## Level 4 — Update Pipeline
*Goal: design the data pipeline that keeps suggestions fresh within the 1-hour SLA.*

**Q17.** Describe the full pipeline from a user completing a search query to that query appearing in autocomplete suggestions for other users. Name each stage and its latency budget.

**Q18.** Compare batch update vs real-time (streaming) trie update. When is batch acceptable, and when is streaming required? What does "1-hour trending SLA" imply about which approach to use?

**Q19.** Design the Kafka topics and Flink/Spark jobs needed to go from raw search log events to frequency-ranked query lists. What are the keys, partitions, and windowing strategy?

**Q20.** How do you prevent a single viral query (e.g., "celebrity death breaking news") from flooding the frequency aggregation pipeline and causing incorrect counts for other queries?

**Q21.** When you rebuild the trie from updated frequency data, how do you deploy the new trie without a read outage? Describe the blue-green or hot-swap strategy.

**Q22.** *(Failure mode)* The Flink streaming job crashes at 2:00 AM. The trie has not been updated for 6 hours. A major news event happened at 3:00 AM. Describe exactly what users experience and your incident response plan.

---

## Level 5 — Distributed Scale
*Goal: scale beyond one server.*

**Q23.** A single server cannot hold the full trie in memory and serve 5K req/sec with < 100ms P99. What are the two architectural directions (replication vs sharding) and when do you choose each?

**Q24.** How would you shard a trie across 5 servers? Describe at least two partition strategies (prefix-range vs first-character vs consistent hashing) and their hotspot risks.

**Q25.** Why does a Redis cache in front of the trie dramatically improve P99 latency? What exact data structure does Redis store for autocomplete, and how is it queried?

**Q26.** Walk through the complete read path for a typeahead request at scale: user types "sea", describe every hop from browser to response, with latency at each hop.

**Q27.** What is the cache eviction strategy for autocomplete prefix caches? LRU is standard — but what problem does LRU cause for long-tail prefixes, and how do you fix it?

**Q28.** *(Failure mode)* Your Redis cache cluster suffers a split-brain partition. Half the cache is stale by 4 hours, half is current. You have no way to tell which is which. What is the user-visible impact and how do you detect and resolve this?

---

## Level 6 — Personalization & Filtering
*Goal: blend global and personal signals safely.*

**Q29.** How do you combine global top-K suggestions with a user's recent personal search history? What data does this require, and where is it stored?

**Q30.** If a user recently searched for "Python tutorial", should autocomplete strongly bias toward Python-related suggestions for all future queries? Where does personalization become harmful to user experience?

**Q31.** How do you filter profane, hateful, or legally mandated (DMCA takedown) queries from appearing in autocomplete suggestions? Name two different enforcement points in the system and the tradeoff of each.

**Q32.** *(Failure mode)* A legal team requests an emergency takedown: the query "celebrity leaked photos" must be removed from autocomplete within 15 minutes globally. Walk through exactly how your system handles this with your current architecture.

---

## Level 7 — Operations & Failure Modes
*Goal: prove you have operated or designed production systems.*

**Q33.** How do you monitor an autocomplete system in production? Name 5 specific metrics you would alert on, with threshold values.

**Q34.** What is a cache stampede (thundering herd) in the context of autocomplete, and how do you prevent it? Describe the mutex/lock-based pattern and probabilistic early expiry.

**Q35.** The trie covers 10M unique prefixes, but users type prefixes not in the trie (e.g., brand new phrases, typos). How does the system handle "trie misses"? What is the fallback, and what is the user experience?

**Q36.** *(Failure mode)* Queries spike 100× in 90 seconds because a live sporting event just ended. Your trie update pipeline cannot keep up. Describe the failure cascade and three specific circuit-breaker or load-shedding strategies.

---

## Level 8 — Architect-Level
*Goal: demonstrate end-to-end ownership and production judgment.*

**Q37.** Walk through the full end-to-end system design for search autocomplete at Google scale: read path, write path, personalization layer, filtering, multi-region deployment. This should take 15 minutes. Cover every component.

**Q38.** *(Capacity math)* The trie covers 10M unique prefixes. Each trie node stores a top-5 suggestion list. Estimate: (a) total number of trie nodes, (b) memory per node, (c) total cluster memory, (d) number of servers needed at 5K req/sec.

---

## Bonus — Unprompted Senior Questions

These are questions a strong candidate raises *without being asked*, signaling ownership thinking.

**BQ1.** "I'd want to measure autocomplete suggestion clickthrough rate (CTR) by position — does position-1 get selected 60% of the time? This data feeds back into ranking weights." *(Analytics feedback loop question — almost nobody volunteers this.)*

**BQ2.** "What's the rollback plan if the new trie has a bug that serves offensive suggestions due to a filtering regression? How fast can we roll back to the previous trie snapshot, and what is the recovery time objective?" *(Operational readiness question.)*

**BQ3.** "Should we version the trie snapshots? If we keep the last 5 trie builds, we can roll back to any of them in under 2 minutes if a bad build ships." *(Data versioning question — demonstrates production scar tissue.)*
