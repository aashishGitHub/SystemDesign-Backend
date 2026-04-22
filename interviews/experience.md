

System Design Problem
Solve a system design question

--- Start of problem statement ---

Design a service that ingests user interaction events on an e-commerce platform and provides personalized product recommendations.
Endpoints
* POST /events — given a user event (view, click, purchase) with user_id, item_id, event_type, timestamp, enqueue for processing
* GET /recommendations?user_id=[id]&limit=[n] — return top-n recommended item_ids for the given user    
Key Constraints
* Event ingestion must handle high throughput (hundreds of thousands of events per second) with eventual ordering
* Recommendations should reflect recent behavior within seconds to minutes (freshness requirement)
* Personalization must combine collaborative filtering (vector similarity over user embeddings) and content-based filtering (item metadata similarity)
* Scale to millions of active users and tens of millions of items
* Separate storage for raw events, computed embeddings, user profiles, and item metadata
* System must expose metrics for ingestion lag, embedding update latencies, recommendation API p99 latency, and error rates


--- End of problem statement ---


pattern to follow for system design problems: https://www.hellointerview.com/learn/system-design/problem-breakdowns/ticketmaster

