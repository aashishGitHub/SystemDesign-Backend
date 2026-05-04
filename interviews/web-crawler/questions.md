# Web Crawler — Interview Questions (38 Questions Across 8 Levels)

**Format:** Questions only. Work through each question aloud before checking `answers.md`.  
**Failure-mode questions** are marked with `[FAILURE MODE]` — these are the ones interviewers use to separate Senior from Staff.  
**Unprompted senior questions** are marked `[UNPROMPTED]` — bring these up yourself to signal depth.

---

## Level 1 — Fundamentals

**Q1.** Walk me through the basic crawl loop end-to-end. Starting from a seed URL, what are the exact steps the crawler takes, and where does each step's output go?

**Q2.** Why do web crawlers use Breadth-First Search (BFS) rather than Depth-First Search (DFS)? Under what specific condition would DFS be catastrophically bad for a production crawler?

**Q3.** What is a "seed URL" and how do you choose the initial seed set? If you had to bootstrap a fresh crawl of the entire web, what would your seed strategy be?

**Q4.** [FAILURE MODE] Your crawler starts with 1 seed URL pointing to a site that has infinite scroll — the page generates a new URL for every scroll position (e.g., `?page=1`, `?page=2`, ... `?page=10000000`). What happens to your crawl frontier, and how do you prevent it?

**Q5.** What is `robots.txt`? Describe exactly how a well-behaved crawler must handle it. What are the fields that matter, and what must you do if `robots.txt` is unreachable (5xx response)?

---

## Level 2 — URL Frontier Design

**Q6.** What is a URL frontier? Why is it more than just a FIFO queue? What data structure would you use to implement it at scale?

**Q7.** Explain the two-level priority queue design for the URL frontier. What is the "front queue" and what is the "back queue"? What properties does each enforce?

**Q8.** How do you assign priority to a URL before it has been crawled? What signals would you use — name at least 4.

**Q9.** What is "freshness scoring" in the context of re-crawl scheduling? How do you model the probability that a page has changed since the last crawl?

**Q10.** [FAILURE MODE] Your URL frontier is stored in Redis as a sorted set keyed by priority score. Your Redis instance receives 50,000 ZADD operations/sec and starts falling behind. Walk through your diagnosis and solution.

**Q11.** How does PageRank factor into crawl priority? Can you use PageRank scores for URLs you haven't crawled yet? What is the bootstrapping problem?

---

## Level 3 — Deduplication

**Q12.** The crawler has seen 5 trillion URLs in its history. You need to check, for every newly discovered URL, whether it has been crawled before. What data structure do you use and why?

**Q13.** Walk me through the math on a Bloom filter for 5 trillion URLs at a 0.1% false positive rate. How many bits do you need? How many hash functions? What is the memory footprint?

**Q14.** What is the cost of a false positive in URL deduplication? What is the cost of a false negative? Which is more dangerous for a web crawler?

**Q15.** [FAILURE MODE] Two different URLs point to the same content: `http://www.example.com/page` and `https://example.com/page?utm_source=google`. How does your system detect this as a duplicate without fetching the second URL?

**Q16.** After fetching a page, you discover its content is nearly identical to a page you crawled last week (same article, different URL, minor text differences). What algorithm detects near-duplicate content? Explain how SimHash works at a high level.

**Q17.** What is URL normalization? Give 5 specific normalizations a production crawler must apply before inserting a URL into the frontier.

---

## Level 4 — Politeness & robots.txt

**Q18.** What does "crawl politeness" mean in practice? Why does it matter for the crawler operator, not just the crawled server?

**Q19.** Your crawler sends 3 requests/sec to `news.ycombinator.com` and receives HTTP 429 with `Retry-After: 60`. What should your crawler do for the next 60 seconds and beyond? Describe the exact state machine.

**Q20.** [FAILURE MODE] You cache `robots.txt` for a domain indefinitely to save fetches. Three months later, the site owner adds a `Disallow: /private/` rule. Your crawler keeps hitting those URLs. What is the correct TTL for `robots.txt` cache entries? What happens if the `robots.txt` fetch returns 304 Not Modified?

**Q21.** How do you implement per-domain rate limiting across 500 distributed crawler workers? What happens if two workers both decide to crawl `nytimes.com` at the same moment?

**Q22.** What is the difference between `crawl-delay` in `robots.txt` and your system's inherent politeness policy? Which takes precedence? What if `crawl-delay` is set to 3600 seconds?

---

## Level 5 — Distributed Architecture

**Q23.** You have 500 crawler worker machines. A URL is discovered: `https://www.nytimes.com/sports/article-123`. How do you decide which worker fetches it? Walk through the consistent hashing assignment step by step.

**Q24.** What is the URL dispatcher component? What are its inputs, outputs, and failure modes?

**Q25.** [FAILURE MODE] Worker shard 17 (responsible for all `nytimes.com` URLs) crashes and loses its in-memory frontier state. It has 50,000 URLs queued for `nytimes.com` that haven't been fetched yet. How do you recover without re-crawling or losing those URLs?

**Q26.** How does your DNS architecture work at 11,600 pages/sec? A naive implementation issues a DNS lookup for every fetch. Calculate the DNS lookup rate and explain why this breaks.

**Q27.** What is DNS negative caching? Why is it dangerous for a crawler that discovers new domains frequently?

---

## Level 6 — Content Processing

**Q28.** Walk through the content processing pipeline after a worker receives an HTTP 200 response with HTML. What are all the steps before the content is written to storage?

**Q29.** How do you handle relative URLs in HTML? Give an example where naive relative-to-absolute conversion fails.

**Q30.** [FAILURE MODE] Your HTML parser encounters a `<meta name="robots" content="noindex, nofollow">` tag. What should your crawler do? What if the page was crawled and indexed two days ago — do you retroactively remove it from the index?

**Q31.** How does Googlebot handle Single Page Applications (SPAs) built with React or Angular that render content only after JavaScript execution? What is the challenge and what is the solution?

**Q32.** You store raw HTML for 1 billion pages/day at 100 KB average. Design the storage layer. What format, what storage system, what compression, and how do you handle the 100 TB/day write throughput?

---

## Level 7 — Re-crawl Strategy

**Q33.** How do you determine when to re-crawl a page? Describe at least 3 signals you would use.

**Q34.** What are HTTP cache headers (`ETag`, `Last-Modified`, `Cache-Control`) and how does a smart crawler use them to reduce redundant full-page fetches?

**Q35.** [FAILURE MODE] A high-priority news site updates 500 articles/hour. Your re-crawl scheduler assigns it a 24-hour recrawl interval. You receive complaints that search results for breaking news are 18 hours stale. How do you redesign the re-crawl scheduler to handle high-churn domains?

**Q36.** Explain the "history of change" model for re-crawl scheduling. If a page changed on 3 of the last 10 crawls, what is its estimated change probability, and how does that translate to a re-crawl interval?

---

## Level 8 — Architect-Level

**Q37.** Draw the full system architecture for a crawler that handles 11,600 pages/sec. Name every component, the data flows between them, and the technology choice for each. You have 10 minutes.

**Q38.** [FAILURE MODE] Your crawler is deployed and starts causing a DDoS-like load on 200 small websites simultaneously because they all happen to be linked from the same high-priority seed page. Their hosting providers send abuse complaints. Walk through the root cause and 3 layers of safeguards you would add to prevent this.

---

## Bonus: Unprompted Senior Questions

These are questions you should **volunteer** during the interview to signal architectural maturity. Raising these unprompted distinguishes Staff-level candidates.

**[UNPROMPTED] SQ1.** "I want to flag that with 5 trillion URLs in the Bloom filter, we'll have a fixed false positive rate of 0.1% — that's 5 billion URLs we'll skip crawling. Is that an acceptable business tradeoff, or should we design a fallback for Bloom filter misses? One option is a secondary exact-check in Bigtable/Spanner for URLs the Bloom filter rejects."

**[UNPROMPTED] SQ2.** "I'm thinking about crawl budget management — not every URL is worth the same. High-PageRank pages deep in a site may be worth crawling even if they're 10 hops from the seed. How do we prevent our crawler from spending 80% of its budget on low-value parameter spam pages from e-commerce sites? I'd propose a per-domain crawl budget cap: no more than N pages/domain/day, where N is proportional to the domain's estimated authority score."

**[UNPROMPTED] SQ3.** "One thing we haven't discussed is the security surface of a crawler. A malicious site could serve a crafted HTML response that causes our HTML parser to allocate gigabytes of memory (e.g., a deeply nested DOM, or an infinite `<meta http-equiv='refresh'>` chain). I'd add: response size limits (cap at 5 MB), parse timeouts (max 2 seconds/page), and sandbox the parser in an isolated process."
