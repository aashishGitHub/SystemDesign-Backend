# Grill Me Questions and Answers

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