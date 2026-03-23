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