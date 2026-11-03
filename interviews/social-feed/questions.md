# Interview Questions: Social Feed (Twitter / X)

> Attempt each question before reading [answers.md](./answers.md).
> Questions progress from fundamentals to Google Staff-level depth.
>
> **Canonical design:** [system_design_twitter_microblogging_service.md](./system_design_twitter_microblogging_service.md) — 150M DAU, 6K tweets/s, 300K timeline reads/s (~50:1), hybrid fan-out with a 50K-follower celebrity cut-off, Redis packed-list timelines (800 × 20-byte entries), sharded MySQL keyed by Snowflake `tweet_id`, FlockDB-style graph.
> Where an answer changed from the earlier version of this set (500M DAU / 1000:1 / Redis sorted set / Cassandra by `author_id`), the old answer is kept in answers.md under **🗂 Previous version**.
>
> Numbering: Q1–Q42 and QB1–QB6 are unchanged so existing references stay valid. Q43–Q68 are new.

---

## Level 1 — Core Problem (Beginner)
*Understanding why social feeds are hard before jumping to solutions*

**Q1.** A user follows 200 accounts. When they open the app, they want to see recent tweets from those accounts. What's the naive approach, and why does it fail at Twitter's scale (150M DAU, 300K timeline reads/s)?

**Q2.** Twitter serves roughly 50 timeline reads for every tweet written (300K reads/s vs 6K tweets/s). What does this mean for where you should optimize — the tweet write path or the feed read path?

**Q3.** What is the difference between "fan-out on write" and "fan-out on read"? Give a one-sentence definition of each.

**Q4.** If you use fan-out on write, what happens when a user with 50 million followers tweets? Why is this problematic?

**Q5.** What failure mode occurs if you use pure fan-out on read for everyone, including users who follow 1,000 accounts?

---

## Level 2 — Data Model & Storage
*Core entities, sharding decisions, and follow graph representation*

**Q6.** List the core entities for a Twitter-like system. For each, state what fields it contains and what store you'd use.

**Q7.** How would you shard the Tweets table? What's the partition key, and why?

**Q8.** How would you store the follow graph (who follows whom)? Compare a sharded relational adjacency list (FlockDB over MySQL) vs a native graph DB (Neo4j) vs a wide-column store like Cassandra.

**Q9.** If tweets are sharded by `tweet_id`, how do you efficiently answer "all tweets from user X in the last 24 hours"? (And how does the answer change if you shard by `user_id` instead?)

**Q10.** What secondary index or denormalization would you add to support the query "get all followers of user X"?

**Q11.** What goes wrong if you shard the Follow table by follower_id only? What about by followee_id only?

---

## Level 3 — Feed Generation Models
*Fan-out strategies, timelines, and the hybrid approach*

**Q12.** Explain the fan-out on write approach step by step. When user A tweets, what exactly happens?

**Q13.** Explain the fan-out on read approach step by step. When user B loads their feed, what exactly happens?

**Q14.** What is the "hybrid fan-out" model? At what follower count threshold do you switch from push to pull, and why is that number a tunable rather than a law?

**Q15.** In hybrid fan-out, when a user opens their feed, how do you merge pre-computed (pushed) tweets with celebrity tweets (pulled at read time)?

**Q16.** What data structure in Redis would you use to store a user's timeline? Why?

**Q17.** A user's cached timeline in Redis contains tweet IDs. Why store IDs instead of full tweet objects?

**Q18.** How do you handle the case where a user has no cached timeline (cold start or cache eviction)?

---

## Level 4 — The Celebrity Problem
*Handling high-follower accounts without melting the system*

**Q19.** Define the "celebrity problem" in feed systems. What makes accounts with 10M+ followers architecturally different?

**Q20.** If you fan-out Elon Musk's tweet to 150M followers synchronously, how long would it take at 10K writes/sec? Is this acceptable?

**Q21.** How do you detect and classify a user as a "celebrity" dynamically, rather than using a static threshold?

**Q22.** When using hybrid fan-out, where do you store the list of celebrities a user follows, and how do you fetch their recent tweets at read time?

**Q23.** What happens if a celebrity with 50M followers deletes a tweet? How do you propagate that deletion?

**Q24.** A previously normal user suddenly goes viral and gains 10M followers overnight. How does your system handle this transition from push to pull model?

---

## Level 5 — Timeline Caching
*Redis structures, cache warming, invalidation, and consistency*

**Q25.** What Redis data type would you use for a user's timeline cache? Explain the operations: add tweet, remove tweet, fetch top N.

**Q26.** How large is a cached timeline? Should you store the last 100 tweet IDs, 800, or all of them? What's the memory math?

**Q27.** A user unfollows someone. How do you update their cached timeline? Is it synchronous or asynchronous?

**Q28.** What cache eviction policy do you use for timelines? LRU? TTL? What happens to a user who hasn't logged in for 30 days?

**Q29.** What is "cache warming"? When would you proactively warm a user's timeline cache?

**Q30.** Explain the difference between "timeline cache" (per-user) and "tweet cache" (per-tweet). Why do you need both?

---

## Level 6 — Real-Time Updates
*Live feed without refresh — WebSockets, SSE, polling*

**Q31.** A user has the app open. Someone they follow tweets. How do you show that tweet in real-time without the user refreshing?

**Q32.** Compare WebSockets, Server-Sent Events (SSE), and long polling for real-time feed updates. Which would you use and why?

**Q33.** How do you scale WebSocket connections to 10M concurrent users? Where does session affinity come in?

**Q34.** What's the "thundering herd" problem when a celebrity tweets and 1M of their online followers all need a push notification simultaneously?

---

## Level 7 — Ranking & Filtering
*Beyond chronological: relevance, ML models, content moderation*

**Q35.** Twitter moved from chronological to ranked feeds ("Best Tweets First"). What signals would you use to rank tweets?

**Q36.** You have 500 tweets in a user's timeline. You need to rank them in <50ms. Do you run a full ML model per tweet, or use a simpler approach?

**Q37.** How do you A/B test a new ranking algorithm without breaking user experience for the test group?

**Q38.** Where does content moderation fit into the feed pipeline? At write time, read time, or both?

---

## Level 8 — Production Operations (Architect / Staff)
*Capacity planning, failure modes, monitoring, scaling stories*

**Q39.** Estimate the storage needed for the tweet table at 6,000 tweets/s average and 500 bytes per row — per day, per year, and for a 7-day hot tier.

**Q40.** What are the key metrics you'd monitor for the feed system? Name at least 5 with why each matters.

**Q41.** A fan-out worker falls behind and the queue depth grows unboundedly. What's your circuit breaker strategy?

**Q42.** Twitter experienced a "fail whale" outage when a celebrity tweet overwhelmed the fan-out system. How would you design the system to gracefully degrade instead of fail completely?

---

## Level 9 — Interview Framing & Consistency Semantics
*How to run the 45 minutes, and which "consistency" you actually mean*

**Q43.** You have 45 minutes for "Design Twitter." How do you split the time, and what must be on the whiteboard at the end of each block?

**Q44.** "Consistency" means different things in ACID and in CAP. Define both, then say which parts of a microblogging service need which.

**Q45.** The non-functional targets are: p99 feed read < 200 ms, delivery to followers within 5 s, no acknowledged tweet ever lost, and a 50M-follower post must not stall ordinary users. Map each target to the component that enforces it.

---

## Level 10 — Capacity Math
*The arithmetic that forces the architecture*

**Q46.** At 6,000 tweets/s and 500 average followers, how many timeline-cache writes per second does pure push cost? How do the celebrity cut-off (>50K followers) and skipping inactive users (no login in 30 days) bring it to 600,000/s? Which of those inputs is an assumption you'd want to verify?

**Q47.** 3,000 images/s at an average 200 KB across stored variants — what is the bandwidth and daily storage, and what does that number force about the media path?

**Q48.** Compare pure push, pure pull and hybrid on: cache writes/s, cache lookups per feed read, and illustrative p99. Derive the "6 lookups per read" for hybrid. Which pattern has the lowest *total* cache ops/s?

---

## Level 11 — API, IDs & Schema Decisions
*Contracts, time-ordered IDs, and defending each storage choice*

**Q49.** `POST /tweets` returns `202 Accepted` even though the tweet row is already committed. Is 202 right, or should it be 201? Defend your choice.

**Q50.** Why does `GET /feed` paginate with `max_id` + `limit` instead of SQL `OFFSET`? What does the cursor look like and how do you fetch *newer* tweets?

**Q51.** Why is media uploaded through a separate `POST /media` that returns a `media_id` with `expires_in_sec: 86400`, rather than inline in `POST /tweets`?

**Q52.** Draw the Snowflake 64-bit ID layout. How many years, workers and IDs per millisecond does it support? Why choose it over UUIDv4 or a single auto-increment?

**Q53.** What breaks a Snowflake generator in production (clock, worker id, sequence), and how do you guard each?

**Q54.** Defend each row of the decision table: sharded MySQL over Cassandra/HBase for tweets; packed Redis list over uncached SQL; Snowflake over UUID; FlockDB-style MySQL adjacency over Neo4j; decoupled media upload over inline multipart.

---

## Level 12 — Write Path Durability
*Ordering, delivery semantics, and idempotency of the fan-out pipeline*

**Q55.** The write path is: mint ID → INSERT into MySQL → produce to Kafka → return 202. What happens if the process dies after the INSERT commits but before the Kafka produce? How do you fix it? What if the *client* retries?

**Q56.** In the reference sequence diagram the fan-out worker acks the Kafka batch *before* writing to Redis. What delivery semantic does that give you, and what should the order be?

**Q57.** `LPUSH` is not idempotent but `ZADD` is. With at-least-once fan-out into a Redis list, what goes wrong and how do you handle it?

**Q58.** Why skip fan-out for users who haven't logged in for 30 days? What happens on the read path when one of them returns?

---

## Level 13 — Media Pipeline & CDN
*Keeping multi-megabyte blobs off the 500-byte tweet path*

**Q59.** Walk through how an image gets from the author's phone to a follower's screen. Which systems never see the image bytes?

**Q60.** The blob origin returns `Cache-Control: max-age=1728000` (20 days). Why is such a long TTL safe, and how do you take down a deleted or illegal image that is cached at the edge?

**Q61.** Walk the edge-cache entry lifecycle: ABSENT → WARMING → FRESH → STALE. What triggers each transition, and what does `304 Not Modified` buy you?

---

## Level 14 — Failure Modes & Runbooks
*What breaks, the blast radius, and the exact mitigation*

**Q62.** A bot farm floods `POST /tweets`. Where and how do you throttle, and what does the client see?

**Q63.** The client times out at 2 s, but the API sets a 1 s deadline on the MySQL insert and returns `504`. Why must the server deadline be shorter than the client timeout? What is ambiguous about that 504?

**Q64.** A MySQL tweet-shard primary stalls. Walk the runbook. What does semi-synchronous replication guarantee about acknowledged tweets?

**Q65.** A Redis timeline shard dies. Why does that threaten MySQL, and how do the circuit breaker, replica ring, and Kafka-driven re-warm contain it? When do you return `503`?

**Q66.** The illustrative latency waterfall is ~22 ms (push hit), ~28 ms (hybrid merge), ~134 ms (cold rebuild). Where does the time go, and what does that tell you about what to optimize?

---

## Level 15 — Architecture Decision Rules
*Choosing the feed architecture from the workload, not from habit*

**Q67.** Walk the decision flowchart: when is direct SQL pull enough, when do you pick pull-from-cache, when hybrid, when pure push? Defend each branch with a number.

**Q68.** Give the whole design in 60 seconds — the numbers, the stores, the fan-out strategy, and the one failure you'd watch first.

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** How do you handle tweets from protected (private) accounts in the fan-out model? What changes?

**QB2.** What's the impact of "quote tweets" and "retweets" on the feed pipeline? Are they stored differently from regular tweets?

**QB3.** How do you handle the "bursty write" pattern during major events (Super Bowl, elections) when tweet volume spikes 10x?

**QB4.** What's the "social graph hotspot" problem, and how do services like FlockDB (Twitter) or TAO (Meta) solve it?

**QB5.** How do you ensure feed consistency across devices? If I like a tweet on my phone, should my laptop show it as liked immediately?

**QB6.** How would you implement a "mute" feature (hide tweets from a user without unfollowing) with minimal impact on the feed pipeline?
