# URL Shortener — Interview Questions

**Format:** Work through these blind (cover the answers file). Speak your answers aloud.  
**Time box:** ~90 seconds per question for L1–L4; ~3–4 minutes for L5–L8.

---

## Level 1 — Fundamentals

**Q1.** Explain what a URL shortener does to someone who has never heard of one. No technical jargon.

**Q2.** Why would a business use a URL shortener instead of just posting the original URL? Give at least 3 distinct reasons.

**Q3.** Walk me through the full lifecycle of a URL shortening request, from the moment a user submits a long URL to the moment they receive a short URL. Be specific about each component involved.

**Q4.** Walk me through a redirect. What happens when a browser visits `https://tinyurl.com/abc1234`? What HTTP status code is returned and why?

**Q5.** What are the two most critical database operations this system needs to support? What access patterns do they have (read-heavy, write-heavy, key-value, range scan)?

**FAILURE MODE Q6.** What happens if two users submit the same long URL at the same time? Should they get the same short code or different ones? What are the tradeoffs of each approach?

---

## Level 2 — Encoding & ID Generation

**Q7.** Compare Base62 encoding vs MD5+truncation for generating short codes. When does each approach fail?

**Q8.** What is a Snowflake ID? How would you use one to generate a short code? What does Twitter's Snowflake ID look like structurally?

**Q9.** What is a "counter service" (also called a range-based ID allocator)? How does it work? What happens if the counter service goes down?

**Q10.** Why is Base62 preferred over Base64 for short URL codes? What specific characters make Base64 problematic?

**Q11.** MD5 produces a 128-bit hash. If you truncate it to the first 43 bits to get a 7-character Base62 code, what is the probability of a collision after 1 million URLs are created? After 100 million?

**FAILURE MODE Q12.** You chose MD5+truncation and your system has been running for 2 years with 50 billion URLs created. A collision is detected: two different long URLs map to the same short code. Walk me through exactly what went wrong and how you would handle it in production.

**Q13.** A Staff engineer proposes using auto-incrementing integers instead of Snowflake IDs. What are two security risks with this approach that would disqualify it for a public URL shortener?

---

## Level 3 — Redirect & HTTP

**Q14.** What is the difference between HTTP 301 and HTTP 302? Which should TinyURL use and why?

**Q15.** A product manager asks: "Why can't we just use 301 redirects? They're cached by browsers and would reduce our server load." What is the technical counter-argument?

**Q16.** A 302 redirect adds one extra round-trip compared to no redirect. Given our SLO of < 10ms P99, what must be true about where the redirect response is generated?

**Q17.** Design the HTTP response headers for a redirect. Include `Cache-Control`, `Location`, and any security headers you'd add.

**FAILURE MODE Q18.** Your redirect service is returning correct 302 responses, but 5% of users are seeing their browser go to the wrong page — they land on a page they visited 3 days ago, not the current destination. What is most likely happening and how do you fix it?

---

## Level 4 — Caching & Read Optimization

**Q19.** Our system has a 100:1 read:write ratio and a 10ms P99 latency SLO. Why is a database query alone (even with indexes) not sufficient for the read path?

**Q20.** Design a Redis cache layer for the redirect service. Include: key structure, TTL strategy, cache-aside vs write-through, and what happens on a cache miss.

**Q21.** What is the "hot key" problem in Redis and how can it affect a URL shortener? Give a concrete example (e.g., a viral tweet with a short link).

**Q22.** A URL expires (its TTL hits zero). Walk me through what should happen in the cache, the database, and when a user visits the expired short URL.

**FAILURE MODE Q23.** Your Redis cluster goes down completely. Walk me through the cascade failure. How much load hits your database? Given 115K redirect req/sec, can your DB handle it? How do you design for this failure?

**Q24.** Should you cache short-code → long-URL mappings at the CDN edge (e.g., Cloudflare)? What are the tradeoffs vs caching only at the application tier (Redis)?

---

## Level 5 — Analytics

**Q25.** You need to track: total clicks per short code, unique visitors (by IP), clicks by country, clicks by device type (mobile/desktop). Design the analytics pipeline without adding latency to the redirect path.

**Q26.** Explain the difference between counting clicks in Redis (`INCR short_code:clicks`) vs streaming to Kafka and processing asynchronously. When would you choose each?

**Q27.** How do you count "unique visitors" at scale? A naive set of IP addresses per short code would use too much memory. What data structure gives you an approximate count in O(1) space?

**Q28.** A business customer wants a real-time dashboard showing click counts updating every second. How does this change your analytics architecture compared to a "good enough in 5 minutes" dashboard?

**FAILURE MODE Q29.** Your Kafka analytics consumer falls 2 hours behind (lag is 50 million events). The redirect path is healthy, but analytics data is stale. Walk me through how you detect this, what the user impact is, and how you recover.

---

## Level 6 — Scale & Sharding

**Q30.** You have 100M new URLs per day. After 5 years, that's 182 billion URL records. A single PostgreSQL instance can hold roughly 10–50 billion rows with good hardware. How do you shard this data?

**Q31.** Compare sharding by short code hash vs sharding by user ID. Which is better for this system and why? What query patterns does each support well?

**Q32.** How do you handle a "shard hotspot" — the case where one shard receives 10× the traffic of others? Give two mitigation strategies.

**Q33.** A new engineer proposes using consistent hashing for the DB shards. When is consistent hashing worth the complexity over simple modulo sharding? What problem does it actually solve?

**FAILURE MODE Q34.** One of your 8 DB shards goes down. 12.5% of all redirects are failing with 500 errors. Walk me through your incident response: what is your immediate mitigation, what is your recovery plan, and what architectural change prevents this in the future?

---

## Level 7 — Abuse & Security

**Q35.** A spammer is creating 10,000 short URLs per minute via the API. How do you detect and stop this? Design a rate-limiting strategy that works at scale.

**Q36.** A short URL points to a phishing site that is stealing credit card numbers. How does your system detect this and what do you do with the URL? Consider both prevention and reactive approaches.

**Q37.** How do you prevent "short code enumeration" — where an attacker systematically visits `tinyurl.com/aaaaaaa`, `tinyurl.com/aaaaaab`, etc., to discover all created URLs?

**Q38.** A large enterprise customer wants their employees to be unable to create short URLs pointing to competitor websites. How do you implement a per-customer URL blacklist/allowlist?

**FAILURE MODE Q39.** A zero-day vulnerability in a popular browser is being exploited through URLs your service has shortened. Law enforcement contacts you at 2 AM. What is your incident response? What systems do you need to have built in advance to respond effectively?

---

## Level 8 — Architect-Level

**Q40.** Design for 99.999% availability (5 nines = 5.26 minutes downtime/year). What does this mean for your architecture across: DB replication, cache redundancy, deployment strategy, and failure detection?

**Q41.** TinyURL wants to expand to 3 geographic regions (US, EU, Asia-Pacific). How do you handle URL creation and redirect in a multi-region setup? What is your consistency model for cross-region replication?

**Q42.** At Google scale (10× our constraints: 1 trillion redirects/day), what breaks first in this architecture? Walk me through the capacity math and identify the top 3 bottlenecks.

**Q43.** A senior PM asks: "Can we guarantee that a short URL created 5 years ago still works today?" What technical and operational challenges does this SLA create? How do you design for it?

**FAILURE MODE Q44.** Bitly had a 2-hour outage in 2016 caused by a cascading database failure. Starting from first principles: what sequence of events could cause a URL shortener's redirect path to go down for 2 hours despite having redundancy? What would you have done differently?

---

## Bonus — Unprompted Senior Questions

These are questions strong candidates ask the interviewer. Asking them signals Staff-level thinking.

**BQ1.** "You mentioned 5-year data retention. What is the delete story? When a URL expires, do we hard-delete it or soft-delete? What happens if a user tries to create a new URL with an expired custom alias — can they reclaim it? If yes, what is the security risk?"

**BQ2.** "For analytics: are we storing raw click events (log-level) or pre-aggregated counts? Raw events give you full flexibility but at 10B events/day you're generating ~1TB of raw data per day. Pre-aggregated counts are cheap but you lose the ability to re-slice by new dimensions later. Which does this company actually need?"

**BQ3.** "The 7-character Base62 code space is 3.5 trillion. At 100M creations/day, we fill it in ~95 years. But the birthday paradox means collision probability gets non-trivial much sooner. At what URL count does collision become a real operational concern, and what is our migration path to 8-character codes when we need it?"
