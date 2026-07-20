# Grill Me Questions and Answers, 
## If you are an AI, always work as a worktree


## Q1: A presigned URL is signed with HMAC. When a client sends that URL directly to S3, what two things does S3 verify to decide whether to allow the request?

### Answer:
1. **Signature validity** — S3 recomputes the HMAC signature using the embedded parameters (method, bucket, object key, expiry timestamp) and its own copy of the IAM secret key. If the recomputed signature matches the one in the URL → request is authentic and untampered.

2. **Expiry timestamp** — S3 checks `X-Amz-Expires` / `X-Amz-Date` embedded in the URL against the current time. If expired → rejected, even if the signature is perfectly valid.

### Why "Auth and RBAC" is incorrect:
- "Auth" is too vague — the mechanism is **signature recomputation**, not a session lookup or token validation.
- **RBAC is evaluated at signing time, not at request time.** When your server calls `generatePresignedUrl()`, AWS checks whether *your server's IAM role* has `s3:GetObject` / `s3:PutObject` permission. That check already happened. When S3 receives the client's request, it doesn't re-run IAM policy evaluation — it just trusts the signature.

### Key Insight:
Presigned URLs delegate authority at generation time. The signature is proof that someone with sufficient IAM permissions blessed this specific operation on this specific object within this time window.

---

## Q2: If a presigned URL leaks (e.g., logged in a browser history or shared accidentally), you can't revoke it before it expires. Given that constraint, name **two design decisions** you'd make at URL generation time to minimize blast radius of a leak.

### Answer:
1. **Short expiry times** — Keep `X-Amz-Expires` as short as possible (e.g., 1–5 minutes for uploads, 15–30 minutes for downloads). This limits the window during which a leaked URL can be abused.

2. **Object-scoped URLs** — Generate URLs for specific objects (e.g., `/users/42/avatar.jpg`) rather than wildcards or prefixes. This ensures that a leaked URL only grants access to a single resource, not an entire bucket or folder.

### Additional Mitigations:
- **IP whitelisting** — Restrict presigned URLs to specific client IPs (if predictable).
- **Audit logging** — Enable S3 access logs to detect unusual activity (e.g., multiple downloads from different IPs).
- **Use CDN** — Place a CDN in front of S3 and configure it to respect presigned URLs. This adds another layer of control and monitoring.

---

## Q3: What is the Multipart Upload process?

### Answer:
Multipart upload is a process that allows large files to be uploaded to S3 in smaller parts (chunks), which are then reassembled into a single object by S3. This improves reliability and performance for large file uploads.

### Steps in the Multipart Upload Process:
1. **Initiate the upload** — The client sends a request to S3 to start a multipart upload. S3 responds with an `UploadId` that uniquely identifies the upload session.

2. **Upload parts** — The file is split into smaller parts (e.g., 5 MB chunks). Each part is uploaded independently using the `UploadId` and a part number. These uploads can happen in parallel to improve speed.

3. **Complete the upload** — After all parts are uploaded, the client sends a `CompleteMultipartUpload` request to S3, including the `UploadId` and a list of part numbers with their corresponding ETags (checksums). S3 assembles the parts into the final object.

### Key Benefits:
- **Resumable uploads** — If an upload fails, only the failed part needs to be retried, not the entire file.
- **Parallelism** — Parts can be uploaded in parallel, reducing overall upload time.
- **Large file support** — Files larger than 5 GB must use multipart upload; files up to 5 TB are supported.

### Key Properties:
| Property | Detail |
|---|---|
| **Minimum part size** | 5 MB (except the last part, which can be smaller) |
| **Maximum file size** | 5 TB |
| **ETag validation** | Each part is validated with an ETag checksum to ensure integrity |
| **Abort capability** | Incomplete uploads can be aborted to free up storage |

### When to use in interviews:
- **Uploading large files** — Always mention multipart upload for files >5 GB.
- **Resilience** — Highlight resumable uploads for unreliable networks.
- **Performance** — Emphasize parallel uploads for faster transfer speeds.

---

## Q4: A circuit breaker has three states. Name them, describe what each state does, and what triggers each transition.

### Answer:

1. **Closed (normal)** — Requests flow through to the downstream service. The circuit breaker counts failures silently. Transitions to **Open** when the failure rate exceeds a threshold (e.g., >50% errors in a 10-second window, or 5 consecutive failures).

2. **Open (tripped)** — All requests are immediately rejected (fail-fast) without touching the downstream service. A timer starts. Transitions to **Half-Open** after a configured timeout (e.g., 30 seconds), giving the downstream service time to recover.

3. **Half-Open (probing)** — A limited number of probe requests are allowed through. If they succeed → transitions back to **Closed**. If they fail → snaps back to **Open** and resets the timer.

### State Transition Diagram:
```
Closed ──(failure threshold exceeded)──► Open
Open   ──(timeout expires)────────────► Half-Open
Half-Open ──(probe succeeds)──────────► Closed
Half-Open ──(probe fails)─────────────► Open
```

### Key Insight:
The circuit breaker is a **proxy that short-circuits calls** to a failing dependency. The Half-Open state is critical — it prevents the circuit from staying open forever while also avoiding flooding a recovering service with full traffic immediately.

---

## Q5: A downstream service has a 5% error rate — it's flaky but not fully down. How do you tune your circuit breaker to avoid false trips while still protecting your system?

### Answer:

1. **Use a sliding window, not a counter** — A count-based threshold (e.g., "5 failures") fires on any burst. A **time-based sliding window** (e.g., "50% error rate over the last 10 seconds with a minimum of 20 requests") requires sustained flakiness, not a momentary blip.

2. **Set a minimum request threshold** — Don't trip on low traffic. If only 2 requests came in and both failed, that's 100% error rate but statistically meaningless. Require a minimum volume (e.g., 20 requests in the window) before the rate is considered.

3. **Tune the error rate threshold above the baseline noise** — If your normal error rate is 1%, setting the threshold at 2% will cause constant false trips. Set it at ~3–4× the baseline (e.g., 15–20%) to distinguish flakiness from genuine degradation.

4. **Distinguish error types** — Not all errors should count. 4xx client errors (bad input) are not the downstream's fault. Only count **5xx / timeout / connection refused** as circuit-breaker-relevant failures.

### Key Insight:
A poorly tuned circuit breaker causes more harm than no circuit breaker — it cascades failures into your own service. Tune the window, minimum volume, and error type separately. Libraries like **Resilience4j** (Java) and **opossum** (Node.js) expose all three knobs.

---

## Q6: In the e-commerce recommendation system, name two specific inter-service calls where you'd place a circuit breaker and explain what the fallback would be.

### Answer:

1. **Recommendation API → Embedding Store (vector DB)** — The GET `/recommendations` call queries a vector DB (e.g., Pinecone, Weaviate) for nearest-neighbour embeddings. If the vector DB is slow or down, the circuit opens.
   - **Fallback**: Return pre-computed popular items (globally trending or category-level) cached in Redis. Stale but safe.

2. **Event Ingestion Service → Message Queue (Kafka)** — POST `/events` enqueues to Kafka. If Kafka is overwhelmed or partitions are unavailable, writes start timing out.
   - **Fallback**: Buffer events in a local in-memory queue or write-ahead log (bounded size), then drain to Kafka when the circuit closes. Alternatively, return HTTP 503 with `Retry-After` so clients back off.

### What NOT to do:
- **Don't place a circuit breaker on the database for reads** without a fallback — returning an empty recommendation list is worse than serving stale data.
- **Don't share one circuit breaker across all downstream services** — a trip on the vector DB should not block event ingestion.

### Key Insight:
Every circuit breaker needs a **defined fallback** — open circuit without fallback is just a timeout with extra steps. Define the fallback first, then wire the breaker. In recommendations, **graceful degradation** (popular items → category items → empty with explanation) is more valuable than a hard failure.

### When to use in interviews:
- **Any service with a critical downstream dependency** — mention circuit breaker whenever a service calls another over the network.
- **Resilience & fault tolerance section** — pair with retries (with exponential backoff + jitter) and bulkheads.
- **Differentiate from retries** — retries amplify load on a struggling service; circuit breakers shed load. Use both together: retry inside a closed circuit, stop retrying when the circuit opens.