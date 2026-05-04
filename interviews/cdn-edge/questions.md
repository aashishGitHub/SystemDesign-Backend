# Interview Questions: CDN & Edge Computing (Pattern 6)

> Attempt each question before reading [answers.md](./answers.md).
> Work level-by-level — later questions assume earlier concepts.
> Time-box yourself: 2 minutes per Level 1–3 question, 5 minutes per Level 4–8 question.

---

## Level 1 — Fundamentals
*Who: All candidates — verify you can explain the basics without jargon.*

**Q1.** What problem does a CDN solve, and what is the latency difference between a request served from an edge PoP 10 ms away vs. an origin server 120 ms away? Show the math for a simple HTTPS request.

**Q2.** What is a Point of Presence (PoP)? How many PoPs do major CDNs (Cloudflare, Akamai, Fastly) have, and what does that number actually mean for P99 latency globally?

**Q3.** Explain the difference between a cache hit and a cache miss at a CDN edge. What happens to the user request in each case?

**Q4.** What is the cache hit ratio, and why is a 95% hit ratio target meaningful? If you have 10M req/sec globally with a 95% hit ratio, how many requests reach origin per second?

**Q5.** A junior engineer says "just set all cache TTLs to 1 year — that maximizes performance." What three things go wrong with this strategy?

**Failure mode Q1.** The Fastly CDN went down globally for approximately one hour on June 8, 2021, taking down Amazon, Reddit, Twitch, the Guardian, and the UK Government website. What single-point-of-failure does this expose, and what should a platform architect have done differently?

---

## Level 2 — Routing & PoP Selection
*Who: Senior engineers — understand how a browser request reaches the nearest edge server.*

**Q6.** Explain Anycast BGP routing. How does it allow thousands of CDN edge servers globally to share a single IP address, and how does IP routing find the nearest one?

**Q7.** What is GeoDNS? How does it differ from Anycast? Give a concrete example of when GeoDNS routes differently than Anycast.

**Q8.** What is latency-based DNS routing (as offered by AWS Route 53)? How does it differ from simple GeoDNS, and when does it matter?

**Q9.** A user in Nairobi, Kenya makes an HTTPS request to your CDN. Walk through every DNS and TCP step from browser to CDN edge to origin cache fill. Identify exactly where latency is introduced.

**Q10.** What is DNS TTL and what are the consequences of setting it too low (e.g., 30 seconds) vs. too high (e.g., 300 seconds) for CDN routing? What value do most CDNs use and why?

**Failure mode Q2.** A BGP route leak causes all traffic destined for a CDN's Anycast prefix to be misrouted through a small ISP in Eastern Europe, dramatically increasing latency globally. What CDN defense mechanisms exist against BGP route leaks? (Reference: Cloudflare BGP incident 2019.)

---

## Level 3 — Cache Strategy
*Who: Senior engineers — get Cache-Control headers right under pressure.*

**Q11.** What is the difference between a Push CDN and a Pull CDN? Give a concrete scenario where each is the better choice.

**Q12.** Explain each of these Cache-Control directives and give the correct use case for each:
- `max-age=31536000`
- `s-maxage=3600`
- `no-cache`
- `no-store`
- `stale-while-revalidate=60`
- `private`

**Q13.** What is the difference between `max-age` and `s-maxage`? Why would you set `s-maxage` higher than `max-age` for a CDN-served page?

**Q14.** What TTL strategy would you use for each of the following content types? Justify each choice:
- JavaScript/CSS bundles with content-hash filenames (`app.a3f9bc12.js`)
- HTML pages (`/products/42`)
- API responses (`GET /api/v1/feed`)
- HLS video segments (`segment_1080p_001.ts`)
- User profile images

**Q15.** What is the `Vary` header? Give an example of a response that correctly uses `Vary: Accept-Encoding` and explain what goes wrong if you set `Vary: Cookie` on a CDN-cached resource.

**Q16.** What is URL normalization and query string stripping for CDN cache key optimization? Give an example where failing to normalize results in a poor cache hit ratio.

**Failure mode Q3.** A CDN is configured with `Cache-Control: public, max-age=3600` on an endpoint that returns personalized data (e.g., `/api/user/profile`). Describe exactly what goes wrong and what the correct Cache-Control header should be.

---

## Level 4 — Invalidation & Purging
*Who: Senior engineers — handle content updates without serving stale data.*

**Q17.** What are the three methods of CDN cache invalidation? Compare them on propagation speed, precision, and operational complexity.

**Q18.** What is a surrogate key (also called a cache tag)? Show the HTTP response header syntax and explain how you would use it to purge all product pages for product ID 9876 without purging any other content.

**Q19.** A content update is published. Your CDN has 250 PoPs globally and you must propagate the purge to all of them within 30 seconds. Walk through the mechanics of how a CDN achieves this — what makes it hard and what are the edge cases?

**Q20.** What is the difference between `no-cache` and invalidation? A developer says "just set `no-cache` everywhere and you don't need to worry about purging." What are the cost and performance implications of this advice?

**Q21.** What is stale-while-revalidate and how does it reduce the latency impact of cache expiry? Write the exact Cache-Control header and explain what happens step-by-step when a cache entry expires under this policy.

**Failure mode Q4.** After a cache purge is issued, CDN PoP A propagates the purge in 2 seconds. CDN PoP B (in a different region) takes 45 seconds due to network partitioning. During those 45 seconds, describe the failure modes a user in PoP B's region experiences, and how you design around this window.

---

## Level 5 — Edge Functions
*Who: Senior engineers — know what can and cannot run at the edge.*

**Q22.** What is an edge function (e.g., Cloudflare Workers, Lambda@Edge)? What can it do that a CDN cache rule cannot?

**Q23.** What are the execution constraints of Cloudflare Workers vs Lambda@Edge? Compare on: cold start latency, maximum CPU time, access to origin, data persistence.

**Q24.** Give three concrete use cases where an edge function adds value that a CDN cache rule alone cannot provide. For each, write the request transformation logic in pseudocode or TypeScript.

**Q25.** What is an origin shield (also called a mid-tier cache or shield PoP)? Draw the request flow for a cache miss with and without origin shield. How much does origin shield reduce origin load for a CDN with 250 PoPs?

**Failure mode Q5.** An edge function is deployed that parses a JWT for authentication on every request. The function has a bug: it calls a remote key-fetch endpoint synchronously on every request. What failure mode does this introduce and how do you fix it?

---

## Level 6 — Video Delivery
*Who: Senior engineers working on media/streaming — CDN is the backbone of video delivery.*

**Q26.** Explain HLS (HTTP Live Streaming). What is a manifest file, what is a video segment, and how does the CDN cache each differently?

**Q27.** What are byte-range requests in the context of CDN video delivery? Why do they matter for large video files, and how does CDN caching of byte-range requests work?

**Q28.** A 2-hour 1080p video is split into 6-second HLS segments at 5 Mbps bitrate. Calculate: the number of segments, the size of each segment, and what CDN cache behavior you would set on segments vs. the HLS manifest.

**Q29.** What is Adaptive Bitrate Streaming (ABR)? How does the CDN serve different quality rungs from the same content, and why is it important that the CDN caches each bitrate variant separately?

**Failure mode Q6.** Netflix's Open Connect CDN embeds servers inside ISP networks. What happens if an Open Connect appliance goes offline or becomes stale? How does Netflix's architecture handle this gracefully without exposing users to buffering?

---

## Level 7 — Multi-CDN & Resilience
*Who: Staff/Principal engineers — build for CDN vendor failure.*

**Q30.** Why does Netflix use three CDNs simultaneously (Open Connect, Fastly, and AWS CloudFront) rather than a single CDN? What are the operational costs of this strategy?

**Q31.** How does real-time CDN traffic steering work? What signals does a traffic steering layer use to decide which CDN to route a given user request to?

**Q32.** What is cache poisoning? Give a specific HTTP header manipulation example that causes a CDN to cache a malicious response, and describe both the attack and the mitigation.

**Q33.** How does a CDN perform DDoS mitigation at the edge? Name three mechanisms with their respective threat model.

**Q34.** Explain TLS termination at the CDN edge. What are the security implications of the CDN decrypting traffic, and what is the "CDN as man-in-the-middle" concern for enterprises?

**Failure mode Q7.** A CDN's WAF (Web Application Firewall) has a bug that starts blocking legitimate traffic globally — similar to the Fastly 2021 incident. Your platform serves 10M users. Walk through your incident response runbook: detection, diagnosis, mitigation, and post-mortem actions.

---

## Level 8 — Architect-Level Design
*Who: Staff/Principal engineers — design the complete CDN architecture.*

**Q35.** Design the complete CDN and edge architecture for a platform with: 10M req/sec peak, 500M users in 190 countries, P99 < 50ms for static assets, 95% cache hit ratio, 30-second purge propagation, and 500K req/sec origin capacity. Cover: PoP count and placement, routing strategy, cache key design, TTL strategy, origin shield topology, purge infrastructure, and multi-CDN failover.

**Q36.** A new product feature requires showing each user a personalized homepage with their name, avatar, and recommendation carousel. The page also contains static CSS and JS. How do you architect CDN delivery for this page to maximize cache hit ratio while still personalizing content? Consider: ESI (Edge Side Includes), fragment caching, cookie-based vary, and edge personalization.

**Q37.** Walk through the capacity math: to achieve P99 < 50ms for users globally, how many edge PoPs do you need, where must they be geographically, and what is the minimum bandwidth capacity per PoP? Assume 500M users, average request size 100KB, 10M req/sec peak.

**Failure mode Q8.** A cache stampede (thundering herd) occurs: a popular URL's TTL expires simultaneously across 1,000 concurrent requests at a single PoP. All 1,000 requests miss the cache and hit origin at the same time. Explain the three mechanisms that prevent this from overwhelming origin, with the exact mechanism each CDN uses to implement request collapsing.

---

## Bonus: Questions You Should Ask Unprompted

*Strong candidates raise these without being asked. Each signals a different dimension of seniority.*

**B1.** "Before I design the CDN architecture, I need to understand the content update frequency. How often does each content type change? A JS bundle that changes once per deploy is fundamentally different from an API response that changes per-user per-second — and they require completely different cache strategies."

**B2.** "What is the acceptable blast radius for a stale data bug? If we cache an API response incorrectly and it stays stale for 5 minutes, how many users see wrong data and what is the business impact? That answer determines how aggressively I recommend caching API responses vs. HTML vs. static assets."

**B3.** "Are we required to support signed URLs or token authentication for private content? CDN caching of authenticated content changes the entire architecture: you can no longer use public cache keys, must integrate with your auth layer at the edge, and lose the ability to cache aggressively. This is a major design fork."
