# Interview Questions: Social Feed (Twitter / X)

> Attempt each question before reading [answers.md](./answers.md).
> Questions progress from fundamentals to Google Staff-level depth.

---

## Level 1 — Core Problem (Beginner)
*Understanding why social feeds are hard before jumping to solutions*

**Q1.** A user follows 200 accounts. When they open the app, they want to see recent tweets from those accounts. What's the naive approach, and why does it fail at Twitter's scale (500M DAU)?

**Q2.** Twitter has a 1000:1 read-to-write ratio. What does this mean for where you should optimize — the tweet write path or the feed read path?

**Q3.** What is the difference between "fan-out on write" and "fan-out on read"? Give a one-sentence definition of each.

**Q4.** If you use fan-out on write, what happens when a user with 50 million followers tweets? Why is this problematic?

**Q5.** What failure mode occurs if you use pure fan-out on read for everyone, including users who follow 1,000 accounts?

---

## Level 2 — Data Model & Storage
*Core entities, sharding decisions, and follow graph representation*

**Q6.** List the core entities for a Twitter-like system. For each, state what fields it contains and what database type you'd use.

**Q7.** How would you shard the Tweets table? What's the partition key, and why?

**Q8.** How would you store the follow graph (who follows whom)? Compare storing it in a relational DB vs a graph DB vs an adjacency list in a wide-column store like Cassandra.

**Q9.** If you shard tweets by user_id, how do you efficiently query "all tweets from user X in the last 24 hours"?

**Q10.** What secondary index or denormalization would you add to support the query "get all followers of user X"?

**Q11.** What goes wrong if you shard the Follow table by follower_id only? What about by followee_id only?

---

## Level 3 — Feed Generation Models
*Fan-out strategies, timelines, and the hybrid approach*

**Q12.** Explain the fan-out on write approach step by step. When user A tweets, what exactly happens?

**Q13.** Explain the fan-out on read approach step by step. When user B loads their feed, what exactly happens?

**Q14.** What is the "hybrid fan-out" model that Twitter uses? At what follower count threshold do you switch from push to pull?

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

**Q39.** Estimate the storage needed for Twitter's tweet table assuming 500M tweets/day, 7-day retention for hot storage, and average tweet size of 1 KB.

**Q40.** What are the key metrics you'd monitor for the feed system? Name at least 5 with why each matters.

**Q41.** A fan-out worker falls behind and the queue depth grows unboundedly. What's your circuit breaker strategy?

**Q42.** Twitter experienced a "fail whale" outage when a celebrity tweet overwhelmed the fan-out system. How would you design the system to gracefully degrade instead of fail completely?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** How do you handle tweets from protected (private) accounts in the fan-out model? What changes?

**QB2.** What's the impact of "quote tweets" and "retweets" on the feed pipeline? Are they stored differently from regular tweets?

**QB3.** How do you handle the "bursty write" pattern during major events (Super Bowl, elections) when tweet volume spikes 10x?

**QB4.** What's the "social graph hotspot" problem, and how do services like FlockDB (Twitter) or TAO (Meta) solve it?

**QB5.** How do you ensure feed consistency across devices? If I like a tweet on my phone, should my laptop show it as liked immediately?

**QB6.** How would you implement a "mute" feature (hide tweets from a user without unfollowing) with minimal impact on the feed pipeline?
