# Interview Questions: Personalized Recommendation Engine

> **Instructions:** Attempt each question before reading [answers.md](./answers.md). Answers are keyed by the same Q-number.
> Work through levels in order — later questions assume knowledge from earlier ones.

---

## Level 1 — Requirements & API Design
*No prior system design knowledge required. Think like a product engineer.*

**Q1.** You have two endpoints: `POST /events` and `GET /recommendations`. Which one is a write path and which is a read path? Why does that distinction matter for how you design them?

**Q2.** The spec says POST /events should "enqueue for processing." What does "enqueue" mean, and why doesn't it say "save to a database"?

**Q3.** What fields does a user event carry: `{ user_id, item_id, event_type, timestamp }`. Which field is most important for personalizing recommendations, and why?

**Q4.** The spec says "eventual ordering." What does eventual mean here? Is it a problem if events arrive slightly out of order?

**Q5.** Why would you put an API Gateway in front of your services? What does it give you that a raw HTTP server does not?

---

## Level 2 — Ingestion Pipeline
*You know HTTP and APIs. Now you need to handle 500,000 requests per second.*

**Q6.** Your `POST /events` service needs to handle 500,000 events per second. If you write each event directly to a database on every request, what goes wrong?

**Q7.** What is a message queue, and how does it solve the problem from Q6? Name a specific technology.

**Q8.** Why is **Kafka** a better choice than a simple queue like RabbitMQ or SQS for this specific system?

**Q9.** When Kafka receives an event from your API, your app service immediately returns `200 OK` to the client — even though the event hasn't been processed yet. Is this acceptable? What guarantee are you making to the client?

**Q10.** What is a **Kafka topic**, and how many topics would you create for this system? What would you name them?

---

## Level 3 — Stream Processing
*Kafka has your events. Now what consumes them and in what order?*

**Q11.** Kafka topics have **partitions**. What is a partition, and how do you decide how to partition the events topic? What's your partition key?

**Q12.** If you partition by `user_id`, what ordering guarantee do you get? What ordering do you *not* get?

**Q13.** What is a **Kafka consumer group**? Why is it essential for scaling your event processing workers horizontally?

**Q14.** Your Kafka consumer crashes mid-batch. How does Kafka know which events to replay? What is a consumer **offset**?

**Q15.** What is a **dead letter queue (DLQ)**, and when would you route an event there instead of retrying?

---

## Level 4 — Embeddings & the ML Pipeline
*Events are streaming in. Now you need to turn raw events into machine-understandable taste profiles.*

**Q16.** What is an **embedding**? Explain it without using the word "vector." Then explain it as a vector.

**Q17.** What is the difference between an **item embedding** and a **user embedding**? You have one per item and one per user — where do they each come from?

**Q18.** A raw event is `{ user_id: 42, item_id: 5501, event_type: "purchase", timestamp: ... }`. This is not an embedding. Walk through the steps to turn this event into an **update to user 42's taste profile**.

**Q19.** Every time a new event arrives for user 42, you could: (a) recompute the entire user embedding from all their history, or (b) incrementally update the existing embedding. What are the tradeoffs? Which meets the "seconds to minutes" freshness requirement?

**Q20.** What is **Exponential Moving Average (EMA)** and why is it a good fit for incrementally updating a user embedding? Write the formula.

**Q21.** At tens of millions of items, should you use a general-purpose database (like MongoDB) for storing and querying embeddings, or a **purpose-built vector store** like Pinecone, Qdrant, or Weaviate? What is the key capability difference?

---

## Level 5 — Recommendation Algorithms
*You have embeddings. Now you need to turn them into a ranked list of items.*

**Q22.** What is **collaborative filtering**? Give an intuitive, non-technical explanation first, then the technical one.

**Q23.** What is **KNN (K-Nearest Neighbors)** in the context of vector search? When you call `pinecone.query(userVector, topK=50)`, what is Pinecone doing geometrically?

**Q24.** What is **content-based filtering** and how is it different from collaborative filtering? What data does it use?

**Q25.** The spec requires both collaborative AND content-based filtering. Why would neither alone be sufficient? Give a concrete failure case for each.

**Q26.** Where does item metadata (name, category, description, price range) live, and what type of search index do you build on top of it for content-based filtering?

---

## Level 6 — Score Fusion
*You have two ranked lists of items from two different systems. How do you merge them into one?*

**Q27.** Your collaborative filter returns `[(item_9, 0.94), (item_3, 0.91), ...]` and your content-based filter returns `[(item_3, 8200), (item_9, 7800), ...]`. Why can't you just add the scores together and re-rank?

**Q28.** What is **Reciprocal Rank Fusion (RRF)**? Write the formula and explain each term. Why does it work even when score scales are completely different?

**Q29.** Walk through a concrete RRF example: item_9 is ranked #1 by collaborative and #2 by content. Item_3 is ranked #2 by collaborative and #1 by content. Using k=60, which item wins? Show the math.

**Q30.** When would you use a **weighted sum** instead of RRF? What would have to be true about your system for weighted sum to be better?

---

## Level 7 — Read Path & Caching
*The recommendation pipeline is expensive. How do you serve GET /recommendations fast?*

**Q31.** Where does Redis sit in the GET `/recommendations` path? What is the key and what is the value stored in Redis?

**Q32.** A user generates a new purchase event. Their user vector in Pinecone just updated. The Redis cache still has their old recommendations. What are your options for handling this staleness?

**Q33.** Explain **TTL-based (lazy) cache invalidation** vs **eager cache invalidation (delete on write)**. When would you use each in this system?

**Q34.** What is the **thundering herd problem** and specifically when does it occur in this system? How do you prevent it using Redis?

**Q35.** A new user signs up and makes their first purchase. They have no history, no user embedding, and no cached recommendations. What does the system return? How do you handle the **cold start problem**?

---

## Level 8 — Storage Design
*The spec mandates "separate storage for raw events, computed embeddings, user profiles, and item metadata." Where does each live?*

**Q36.** Fill in this table — for each data type, name appropriate storage and justify why:

| Data | Candidate Storage | Why |
|------|------------------|-----|
| Raw events (append-only log) | ? | ? |
| User embeddings (vector KNN queries) | ? | ? |
| User profiles (read by user_id) | ? | ? |
| Item metadata (FTS + filtering) | ? | ? |
| Recommendation cache | ? | ? |

---

## Level 9 — Observability & Scale
*A senior engineer doesn't just build the system — they know how to tell when it's broken.*

**Q37.** **Ingestion lag**: How do you measure the delay between an event being posted and it being processed by the Kafka consumer? What exact timestamps do you diff?

**Q38.** **Embedding update latency**: How do you measure how long it takes from event arrival to the user's Pinecone vector being updated? What makes this tricky to instrument?

**Q39.** What is **p99 latency** and why is it more important than average latency for a recommendation API? Give a concrete example of why average can lie.

**Q40.** Name the tool stack you would use end-to-end: what collects metrics, what stores them, what visualizes them? Describe one dashboard panel you'd create for each of the four required metrics.

**Q41.** Your Kafka consumer lag is growing — events are accumulating faster than they're being consumed. What are your three options to recover, and what are the tradeoffs of each?

**Q42.** What is **backpressure** and how does Kafka handle it natively? What happens when the producer (your API service) writes faster than the consumer (your embedding worker) can process?

---

## Bonus — Senior-Level Architecture Questions
*These go beyond the spec. A senior candidate brings these up unprompted.*

**Q43.** How would you handle **seasonality** — e.g., Black Friday causes a 50x traffic spike? What scales automatically vs what needs pre-warming?

**Q44.** How do you A/B test two recommendation algorithms (e.g., RRF vs weighted sum)? What metric determines the winner?

**Q45.** An item gets taken out of stock. It currently appears in 50,000 users' cached recommendation lists in Redis. How do you remove it efficiently?

**Q46.** How do you prevent **filter bubbles** — where the system keeps recommending only what the user already knows, never discovering new categories?
