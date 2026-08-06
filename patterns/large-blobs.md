# Pattern: Handling Large Blobs

> **Interviewer signal:** "users upload videos", "profile pictures", "file sharing", "attachments", "a 5GB backup", "resume an interrupted upload".

Any object big enough that streaming it through your application servers is the wrong architecture. The whole pattern reduces to one rule — **metadata goes through your API, bytes do not** — plus the machinery that makes that rule survive clients on hotel wifi.

📖 Source outline: [hellointerview.com — Handling Large Blobs](https://www.hellointerview.com/learn/system-design/patterns/large-blobs) (prose paywalled; depth below is this repo's own).

> This repo already has an **S3 presigned-URL grilling doc** worth reading alongside this: [`blob-storage/s3-grill-me-answers.md`](../blob-storage/s3-grill-me-answers.md) — Q1 covers exactly what S3 verifies on a presigned request, Q2 covers minimizing blast radius when a URL leaks.

---

## Table of Contents

1. [The Problem: Don't Proxy Bytes](#1-the-problem-dont-proxy-bytes)
2. [Presigned URLs](#2-presigned-urls)
3. [The Simple Upload Flow](#3-the-simple-upload-flow)
4. [State Synchronization: The Bug Everyone Ships](#4-state-synchronization-the-bug-everyone-ships)
5. [Multipart & Resumable Uploads](#5-multipart--resumable-uploads)
6. [Chunking, Content-Addressable Storage, and Dedup](#6-chunking-content-addressable-storage-and-dedup)
7. [The Download Path](#7-the-download-path)
8. [Metadata Is the Real Database Problem](#8-metadata-is-the-real-database-problem)
9. [Abuse, Limits, and Security](#9-abuse-limits-and-security)
10. [Storage Tiers, Lifecycle, and Cost](#10-storage-tiers-lifecycle-and-cost)
11. [Deletion Is Harder Than It Looks](#11-deletion-is-harder-than-it-looks)
12. [Cloud Provider Terminology](#12-cloud-provider-terminology)
13. [Decision Framework](#13-decision-framework)
14. [Where This Shows Up in This Repo](#14-where-this-shows-up-in-this-repo)
15. [Real-World Cases](#15-real-world-cases)
16. [Interview Questions](#16-interview-questions)
17. [Quick Recall Cheat Sheet](#quick-recall-cheat-sheet)

---

## 1. The Problem: Don't Proxy Bytes

```
❌  client ──5GB──► API server ──5GB──► object storage
✅  client ──metadata──► API server        (small, fast, stateless)
    client ──────5GB──────────────────► object storage (direct)
```

Everything wrong with the first line:

| Problem | Detail |
|---|---|
| **Memory / disk pressure** | Naive frameworks buffer the whole body. Even streaming, you hold a connection for minutes |
| **Request timeouts** | Load balancers and gateways have idle/total timeouts (often 30–60s). A slow 5GB upload just dies |
| **Hard payload caps** | API gateways commonly cap request bodies around 10MB, and serverless functions have their own low limits. You cannot raise these past a point |
| **Wrong scaling axis** | You now scale API servers by *bandwidth-seconds*, not CPU. One user on slow wifi occupies a worker for 20 minutes |
| **Double bandwidth cost** | You pay ingress and egress for the same bytes, for no benefit |
| **Deploys kill uploads** | A rolling restart severs every in-flight transfer |
| **All-or-nothing** | Fail at 99% and the client starts over from zero |

Object storage (S3, GCS, Azure Blob, R2) already solves durability, throughput, and scale for bytes. Your application's job is the **metadata, authorization, and lifecycle** — never the transport.

The corollary that generalizes: **your API server should handle small structured data; specialized infrastructure should handle bulk data.** Same reasoning as putting a CDN in front of static assets or a search engine in front of full-text queries.

---

## 2. Presigned URLs

A presigned URL is a normal object-storage URL with an **HMAC signature and an expiry** encoded into the query string. The storage service verifies the signature was produced by a holder of a valid secret key and that it hasn't expired — no session, no identity lookup, no call back to your service.

```
PUT https://bucket.s3.amazonaws.com/uploads/a1b2c3.mp4
      ?X-Amz-Algorithm=AWS4-HMAC-SHA256
      &X-Amz-Credential=…
      &X-Amz-Date=20260805T…
      &X-Amz-Expires=900                ← 15 minutes
      &X-Amz-SignedHeaders=host
      &X-Amz-Signature=4f3a…            ← HMAC over method + key + expiry + headers
```

What this buys: the client uploads directly, your servers never see a byte, and the bucket stays completely private with **no public write access**. The signature scopes the grant to one **method**, one **object key**, and a **time window**.

The properties that get probed in interviews:

- **It is a bearer credential.** Anyone holding the URL can use it until it expires. Treat it like a short-lived token: don't log it, don't put it in a redirect chain that gets recorded, keep expiry tight (minutes, not days).
- **You cannot revoke it** before expiry — which is precisely why expiry should be short and the grant narrow. That's the whole point of Q2 in [`s3-grill-me-answers.md`](../blob-storage/s3-grill-me-answers.md).
- **You can constrain more than the key.** A presigned URL can require a specific `Content-Type`, and a **presigned POST policy** can enforce a `content-length-range`, so a client physically cannot upload a 10GB file when your limit is 100MB. This is the correct answer to "how do you enforce size limits if the bytes never reach your server?"
- **You cannot inspect the content before it lands.** Validation, virus scanning, and transcoding are necessarily *post-upload* steps triggered by an event.
- **One URL per object.** Generating them is cheap and requires no round trip to the storage service — it's a local HMAC computation.

---

## 3. The Simple Upload Flow

```
1. POST /files  {filename, size, content_type}
      → server authorizes, checks quota, validates size/type
      → INSERT metadata row: status = 'PENDING', key = 'uploads/<uuid>'
      → returns { file_id, upload_url (presigned PUT, 15 min) }

2. PUT <upload_url>  [bytes]              ← client → object storage, direct
      → 200 + ETag

3a. POST /files/{id}/complete             ← client tells us
        → verify object exists (HEAD), size and checksum match
        → UPDATE status = 'AVAILABLE'
   OR
3b. Object-storage event notification      ← storage tells us (preferred)
        → S3 Event / GCS Pub/Sub notification → queue → worker
        → UPDATE status = 'AVAILABLE', kick off post-processing
```

**Prefer 3b, and say why:** the client is untrusted and unreliable — it can crash, lose connectivity, or close the tab between steps 2 and 3a. A storage-side event fires regardless of what the client does, which makes completion a fact observed by your infrastructure rather than a claim made by a client. Keep 3a as a latency optimization (the user sees "done" immediately) but never as the *only* path.

Download is the mirror image: `GET /files/{id}` returns a short-lived presigned GET URL (or a CDN URL), and the client fetches bytes directly.

---

## 4. State Synchronization: The Bug Everyone Ships

Two systems — your database and the object store — with no transaction between them. That's the [dual-write problem](./multi-step-processes.md#8-the-dual-write-problem-and-the-outbox) again, and it produces four states, two of which are wrong:

| DB | Object | Meaning | Fix |
|---|---|---|---|
| `AVAILABLE` | exists | ✅ correct | — |
| `PENDING` | absent | ✅ upload never happened | expire the row after the URL's lifetime |
| `PENDING` | **exists** | ❌ upload succeeded, completion never recorded | Event notification (3b) repairs it; a **reconciler** catches the rest |
| `AVAILABLE` | **absent** | ❌ worst case — a broken file the UI promises works | Verify with `HEAD` before marking available; audit job |

So the pattern needs two background jobs, and mentioning them unprompted is a strong signal:

1. **Reconciler / sweeper** — find `PENDING` rows older than the URL expiry, `HEAD` the object, and either promote them (object exists) or mark them abandoned and delete the row.
2. **Orphan collector** — find objects with no metadata row (client uploaded with a URL for a row that was rolled back, or a multipart upload that was never completed) and delete them. **Unfinished multipart uploads keep their already-uploaded parts and you are billed for them**, invisibly, forever — the fix is a bucket lifecycle rule to abort incomplete multipart uploads after N days. That detail lands well because it's a real bill people have paid.

Ordering rule that prevents the worst state: **create the metadata row before issuing the upload URL, and only mark it available after verifying the object exists.** Never the reverse.

→ [`file-storage §2 Sync Protocol`](../interviews/file-storage/deep-dive.md#2-sync-protocol) · [`§7 Production Operations`](../interviews/file-storage/deep-dive.md#7-production-operations)

---

## 5. Multipart & Resumable Uploads

**The question this answers: "the upload fails at 99% — now what?"** With a single `PUT`, you restart 5GB. With multipart, you retry one 5MB part.

S3-style multipart, which is the model to know:

```
1. CreateMultipartUpload(key)          → uploadId
2. for each part i (1…N), in PARALLEL:
      UploadPart(uploadId, partNumber=i, bytes)  → ETag_i
      (retry an individual part on failure — nothing else is affected)
3. CompleteMultipartUpload(uploadId, [(1, ETag_1), (2, ETag_2), …])
      → storage assembles the object server-side
   or AbortMultipartUpload(uploadId) to discard
```

Constraints worth remembering (verify current numbers in the provider docs — these are the long-standing S3 values): parts are **5MB minimum** except the last, **10,000 parts maximum**, and part size × 10,000 sets your maximum object size, so part size is a design choice driven by file size.

What multipart gives you beyond retry:

| Benefit | Why |
|---|---|
| **Parallelism** | Multiple parts in flight saturates the client's uplink; a single TCP stream often can't, especially on high-latency links |
| **Resumability** | List already-uploaded parts and send only what's missing, even after an app restart |
| **Per-part integrity** | Each part has its own checksum, so corruption is localized and retryable |
| **Progress** | Real progress reporting, part by part |

**Resumable vs multipart** — worth distinguishing: multipart is parallel independent parts assembled at the end; a *resumable session* (GCS resumable uploads, the `tus` protocol, Azure block blobs) is a sequential stream with a server-tracked offset the client can query after a disconnect (`"how many bytes do you have?"` → continue from there). Multipart suits large files and fast networks; resumable sessions suit flaky mobile connections. Both solve "don't restart from zero".

The client-side detail that completes the answer: **persist the `uploadId` and completed part list locally** (IndexedDB, app storage), or a page refresh loses the ability to resume even though the server would happily allow it.

→ [`file-storage §1 Chunked Upload & Content-Addressable Storage`](../interviews/file-storage/deep-dive.md#1-chunked-upload--content-addressable-storage) · [`video-streaming §2 The Upload Pipeline`](../interviews/video-streaming/deep-dive.md#2-the-upload-pipeline)

---

## 6. Chunking, Content-Addressable Storage, and Dedup

Once you're chunking anyway, addressing chunks **by their hash** unlocks several properties at once:

```
file → split into chunks → SHA-256 each chunk → store at key = hash
                                                 ↓
metadata:  file_id → [hash_a, hash_b, hash_c, …]  (an ordered manifest)
```

- **Deduplication for free.** Identical chunks hash identically, so the same content is stored once no matter how many users upload it. The famous consequence: the second person to upload a popular file uploads nothing at all — the client hashes locally, asks "do you have these chunks?", and sends only the misses.
- **Integrity for free.** The key *is* the checksum. Re-hash on read and you detect corruption without extra bookkeeping.
- **Immutability.** Content can never change under a hash, which makes chunks trivially cacheable forever.
- **Efficient sync.** Editing 1MB of a 1GB file re-uploads only the affected chunks, and the manifest changes. Content-defined chunking (rolling-hash boundaries à la rsync) keeps the change localized even when bytes are *inserted*, where fixed-size chunking would shift every subsequent boundary and invalidate everything after the edit. That distinction is a good depth signal.

The costs: a hash-lookup index that becomes large and hot, cross-user dedup raises a **side-channel privacy concern** (a client can probe whether specific content already exists — real systems mitigate with per-user dedup scope or by requiring proof of possession), and deletion becomes reference-counted (see [§11](#11-deletion-is-harder-than-it-looks)).

→ [`file-storage §5 Deduplication & Storage Efficiency`](../interviews/file-storage/deep-dive.md#5-deduplication--storage-efficiency) · [`fundamentals/checksum.md`](../fundamentals/checksum.md) · [`fundamentals/merkle-trees.md`](../fundamentals/merkle-trees.md) (the same hashing idea, composed into a tree for efficient diffing)

---

## 7. The Download Path

Downloads are usually the higher-volume, higher-cost side. Four layers:

**1. Direct from storage via presigned GET.** Baseline: private bucket, short-lived URL, no bytes through your API.

**2. CDN in front.** Essential for anything read repeatedly — an edge hit avoids both the origin fetch and the ocean crossing, and object-storage egress is typically more expensive than CDN egress, so it's a cost win too. For **private** content at the edge you need edge-level auth: **signed URLs** (per-object, precise) or **signed cookies** (one grant covering many objects — right for a video's hundreds of segments, where signing each one is impractical).

**3. HTTP Range requests** — the mechanism behind resume, parallel download, and video seek:

```
GET /video.mp4
Range: bytes=1048576-2097151

HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 1048576-2097151/524288000
```

Without `Accept-Ranges`, a user who loses connection at 90% restarts from zero, and seeking in a video would require downloading everything before the target. This is why "can the client resume a *download*?" has the same shape of answer as resuming an upload.

**4. Segment, don't stream one big file** — for video, the file is pre-split into a few-second segments with a manifest (HLS `.m3u8` / DASH `.mpd`) at multiple bitrates, so the player switches quality mid-playback based on measured throughput. That's adaptive bitrate, and it's why video is a different problem from file download: you optimize *time-to-first-frame* and *rebuffer ratio* rather than total throughput.

→ [`cdn-edge §8 Video Delivery: HLS, Byte-Range, and ABR`](../interviews/cdn-edge/deep-dive.md#8-video-delivery-hls-byte-range-and-abr) · [`video-streaming §4 Adaptive Bitrate`](../interviews/video-streaming/deep-dive.md#4-adaptive-bitrate-streaming-hlsdash) · [`§5 CDN & Global Video Delivery`](../interviews/video-streaming/deep-dive.md#5-cdn--global-video-delivery) · [`cdn-edge §3 Cache-Control`](../interviews/cdn-edge/deep-dive.md#3-cache-control-ttl-etag-and-vary)

---

## 8. Metadata Is the Real Database Problem

The blobs are the easy part — object storage scales for you. **The metadata is where the system design actually lives**, and at billions of files it's a bigger problem than the bytes.

```sql
files(
  file_id, owner_id, parent_folder_id, name,
  storage_key, size_bytes, content_type,
  checksum, status, version, created_at, deleted_at
)
```

What makes it hard:

- **Object storage isn't queryable.** "List this user's files sorted by date" cannot be answered by the bucket at scale — `LIST` is slow, prefix-only, and paginated. Every query pattern must be served by your metadata store.
- **Shard key is the whole decision.** Shard by `owner_id`/`user_id` and a user's listing hits one shard; shard by `file_id` and every listing scatters. This is the [scaling-writes shard-key](./scaling-writes.md#7-rung-5-partitioning-and-sharding) discussion applied here.
- **Hierarchy is expensive.** Folder trees mean recursive queries; materialized paths (`/a/b/c`) make subtree reads cheap and *renames* expensive (rewrite every descendant), while parent pointers do the opposite. Pick based on which is more frequent.
- **Versioning multiplies rows** and needs its own retention policy.
- **Soft deletes** (`deleted_at`) are mandatory for undo/trash, and mean every query needs the predicate — and an index that includes it.

→ [`file-storage §4 Metadata Storage at Scale`](../interviews/file-storage/deep-dive.md#4-metadata-storage-at-scale) · [`§3 Conflict Resolution`](../interviews/file-storage/deep-dive.md#3-conflict-resolution) (two devices edit offline — the sync half of this problem)

---

## 9. Abuse, Limits, and Security

Since bytes bypass your servers, every control must be applied **at URL-generation time or after the object lands**:

| Control | Mechanism |
|---|---|
| **Size limit** | Presigned POST policy with `content-length-range`; storage rejects oversized uploads itself |
| **Content type** | Bind `Content-Type` into the signature |
| **Short expiry** | Minutes. Limits the window for a leaked URL |
| **Authorization** | Enforced in *your* API before you issue the URL. The URL itself carries no identity |
| **Quota** | Checked at issue time, and re-verified on completion using the real object size (the client's declared size is untrusted) |
| **Rate limit** | Cap URL issuance per user per window — see [`rate-limiting`](../interviews/rate-limiting/README.md) |
| **Malware scan** | Async, post-upload, triggered by the event notification. Keep status `SCANNING` until it passes; never serve unscanned user content |
| **Never trust the filename** | Path traversal, script extensions, and unicode tricks. Generate your own storage key (a UUID) and keep the display name as pure metadata |
| **Serve safely** | `Content-Disposition: attachment` and/or a separate cookieless origin domain, so an uploaded HTML/SVG file can't execute in your app's origin. This is a genuine XSS vector people miss |
| **Bucket hygiene** | Block all public access; encryption at rest; versioning to survive malicious overwrite; access logging |

The verification step is the one to name explicitly: **on completion, `HEAD` the object and compare actual size and checksum against what the client declared.** A client that says "10MB" and uploads 10GB, or uploads different content than it claimed, must fail here.

---

## 10. Storage Tiers, Lifecycle, and Cost

Cost is a first-class design constraint for blobs, and interviewers at senior level expect you to raise it.

| Tier | Access | Retrieval | Use |
|---|---|---|---|
| Standard / hot | Instant | — | Active data |
| Infrequent access | Instant | Per-GB retrieval fee | Older but occasionally read |
| Archive (Glacier-class) | Minutes to hours | Fee + delay | Compliance, backups |
| Deep archive | Hours | Higher fee, longer delay | Legal retention |

Lifecycle rules automate transitions ("after 30 days → IA, after 90 → archive"). Two traps: **minimum storage duration charges** mean moving objects too early costs *more* than leaving them, and small objects in cheap tiers can be dominated by per-object overhead and per-request fees. Tiering millions of tiny files is often a net loss.

**Egress usually dominates the bill**, not storage — which is the financial argument for a CDN (cheaper egress, plus cache hits that avoid origin egress entirely) and for not proxying bytes through your compute tier, where you'd pay twice for the same bytes.

→ [`video-streaming §6 Storage Architecture`](../interviews/video-streaming/deep-dive.md#6-storage-architecture) · [`cdn-edge §10 Capacity Math`](../interviews/cdn-edge/deep-dive.md#10-architect-level-design-and-capacity-math)

---

## 11. Deletion Is Harder Than It Looks

- **Soft delete first.** Users expect undo, and support needs to recover mistakes. `deleted_at` + a trash retention window, with hard deletion as a background job.
- **Dedup makes deletion reference-counted.** If chunk `abc123` is shared by 400 users' files, deleting one file must *not* delete the chunk. You need a reference count or a mark-and-sweep GC, and the refcount update races with concurrent uploads referencing the same chunk — so the safe order is *increment before writing the manifest, decrement after removing it*, with a grace period before physical deletion.
- **Deletion must propagate to caches and CDN.** A purged object still served from an edge cache is a privacy incident, not just staleness. Signed-URL expiry plus explicit purge, and short TTLs for private content.
- **Compliance deletion is a stronger claim.** "Delete my data" under GDPR-style rules must cover backups, replicas, derived thumbnails/transcodes, and search indexes. Crypto-shredding — encrypt each user's objects with a per-user key and destroy the key — is the practical technique when purging every backup is infeasible.

---

## 12. Cloud Provider Terminology

| Concept | AWS | GCP | Azure |
|---|---|---|---|
| Object store | S3 | Cloud Storage (GCS) | Blob Storage |
| Container | Bucket | Bucket | Container |
| Time-limited URL | Presigned URL | Signed URL | SAS token / URL |
| Chunked upload | Multipart upload | Resumable upload | Block blob (Put Block / Put Block List) |
| Event on write | S3 Event Notification → SQS/SNS/Lambda | Pub/Sub notification | Event Grid |
| Archive tier | Glacier / Deep Archive | Nearline / Coldline / Archive | Cool / Cold / Archive |
| CDN | CloudFront | Cloud CDN | Azure CDN / Front Door |
| Edge auth | Signed URL / signed cookie | Signed URL / signed cookie | SAS |

Knowing the *mapping* rather than one vendor's vocabulary reads as experience — and lets you answer regardless of which cloud the interviewer thinks in.

---

## 13. Decision Framework

```
How big is the object?
├─ < ~1MB (avatars, thumbnails, small JSON)
│     ► Through the API is fine. Presigned URLs add a round trip
│       and operational complexity for no gain.
│
└─ Larger
   │
   ├─ ALWAYS: presigned URL, bytes direct to object storage.
   │          Metadata row created BEFORE the URL is issued.
   │          Completion driven by a STORAGE EVENT, not the client.
   │
   ├─ > ~100MB, or clients on unreliable networks?
   │     ► MULTIPART / RESUMABLE upload
   │       (+ persist uploadId & part list client-side)
   │       (+ lifecycle rule to abort incomplete uploads — you're billed for parts)
   │
   ├─ Same content uploaded by many users, or files edited repeatedly?
   │     ► CONTENT-ADDRESSABLE CHUNKS (hash = key)
   │       → free dedup + integrity + incremental sync
   │       → but deletion becomes reference-counted
   │
   ├─ Read repeatedly, or users geographically spread?
   │     ► CDN. Private content → signed URLs (per object)
   │                              or signed cookies (many objects, e.g. video segments)
   │
   ├─ Is it media that gets played rather than downloaded?
   │     ► SEGMENT + MANIFEST (HLS/DASH), multiple bitrates, ABR.
   │       Optimize time-to-first-frame and rebuffer ratio, not throughput.
   │
   └─ Always, regardless:
        • enforce size at signing time (content-length-range), verify on completion
        • generate your own storage key; never trust the filename
        • async malware scan before the object is servable
        • reconciler for PENDING rows + orphan collector for stray objects
        • lifecycle tiering, and remember egress usually dominates the bill
```

---

## 14. Where This Shows Up in This Repo

| System | How the pattern appears | Go read |
|---|---|---|
| **S3 grill-me** | Presigned URL internals: what S3 verifies, and blast-radius control when a URL leaks | [`blob-storage/s3-grill-me-answers.md`](../blob-storage/s3-grill-me-answers.md) |
| **File storage (Dropbox)** | The home topic: chunked upload + content-addressable storage, sync protocol, conflict resolution, metadata at scale, dedup | [`§1`](../interviews/file-storage/deep-dive.md#1-chunked-upload--content-addressable-storage) · [`§2 Sync`](../interviews/file-storage/deep-dive.md#2-sync-protocol) · [`§3 Conflicts`](../interviews/file-storage/deep-dive.md#3-conflict-resolution) · [`§4 Metadata`](../interviews/file-storage/deep-dive.md#4-metadata-storage-at-scale) · [`§5 Dedup`](../interviews/file-storage/deep-dive.md#5-deduplication--storage-efficiency) · [`§7 Ops`](../interviews/file-storage/deep-dive.md#7-production-operations) |
| **Video streaming** | Upload pipeline, transcoding ladder, ABR segmenting, storage tiers, DRM | [`§2 Upload`](../interviews/video-streaming/deep-dive.md#2-the-upload-pipeline) · [`§3 Transcoding`](../interviews/video-streaming/deep-dive.md#3-transcoding-architecture) · [`§4 ABR`](../interviews/video-streaming/deep-dive.md#4-adaptive-bitrate-streaming-hlsdash) · [`§6 Storage`](../interviews/video-streaming/deep-dive.md#6-storage-architecture) · [`§8 DRM`](../interviews/video-streaming/deep-dive.md#8-content-protection-drm) |
| **CDN & edge** | Byte-range delivery, cache-control for large objects, capacity/cost math | [`§8 HLS & Byte-Range`](../interviews/cdn-edge/deep-dive.md#8-video-delivery-hls-byte-range-and-abr) · [`§3`](../interviews/cdn-edge/deep-dive.md#3-cache-control-ttl-etag-and-vary) · [`§10 Capacity Math`](../interviews/cdn-edge/deep-dive.md#10-architect-level-design-and-capacity-math) |
| **Web crawler** | Storing billions of fetched pages as blobs, with content-hash dedup | [`§9 Content Processing and Blob Storage`](../interviews/web-crawler/deep-dive.md#9-content-processing-and-blob-storage) · [`§4 SimHash near-duplicates`](../interviews/web-crawler/deep-dive.md#4-near-duplicate-content-simhash-and-shingling) |
| **Chat system** | Media attachments: the same presigned-URL flow embedded in a messaging product | [`§2 Message Delivery`](../interviews/chat-system/deep-dive.md#2-message-delivery--ordering) |
| **File change notification** | Telling other devices a new version landed — where this pattern meets real-time updates | [`file-storage §6`](../interviews/file-storage/deep-dive.md#6-real-time-notifications) |
| **Fundamentals** | The integrity primitives underneath chunk addressing | [checksum](../fundamentals/checksum.md) · [merkle-trees](../fundamentals/merkle-trees.md) |

---

## 15. Real-World Cases

| Case | What's done | Lesson |
|---|---|---|
| **Dropbox** | Fixed/variable-size chunking, content-addressable storage, cross-user dedup, delta sync | The canonical implementation of §6. Uploading a file someone else already has can transfer almost nothing |
| **YouTube / Netflix** | Upload → transcode into a bitrate ladder → segment → distribute to edge caches | The blob you store is never the blob you serve. Derivation is a [multi-step process](./multi-step-processes.md) |
| **Instagram / WhatsApp media** | Client-side compression before upload; multiple pre-rendered sizes | The cheapest bytes are the ones never uploaded. Push work to the client |
| **Google Drive / Photos** | Resumable upload sessions designed for flaky mobile links | Mobile-first products choose resumable-with-offset over parallel multipart |
| **Docker registries / package repos** | Layers addressed by digest, shared across images | Content addressing is the industry-standard answer for immutable shared artifacts |
| **Backup products** | Deduplicated chunk store + reference counting + lifecycle to archive tiers | Deletion complexity is the real cost of dedup, and it's where these systems have bugs |
| **The leaked-presigned-URL incident class** | URLs logged in analytics, browser history, or shared in tickets, then reused | Short expiry and narrow scope are the mitigation; revocation isn't available |

---

## 16. Interview Questions

**Q1. Why not just upload through your API server?**
Because you'd be scaling your application tier by bandwidth-seconds instead of CPU. A 5GB upload occupies a worker and a connection for minutes, load balancer and gateway timeouts will kill it, API gateways typically cap request bodies in the tens of megabytes, and every deploy severs in-flight transfers. You also pay ingress and egress for the same bytes for no benefit, and a failure at 99% restarts the whole thing. Object storage already provides durability and throughput for bytes, so the split is: metadata, authorization, and lifecycle through my API; bytes direct to storage via a presigned URL.

**Q2. How does a presigned URL work, and is it secure?**
It's a normal storage URL with an HMAC signature and expiry in the query string, computed from my secret key over the method, object key, expiry, and signed headers. The storage service verifies the signature and that it hasn't expired — no identity lookup, no callback to my service. It's secure in the sense that the bucket stays fully private and the grant is narrowly scoped to one method, one key, and a short window. But it is a **bearer credential**: anyone holding it can use it, and I cannot revoke it before expiry. So keep expiry to minutes, never log the URL, and treat a leak as inevitable — which is why the scope is narrow in the first place.

**Q3. The upload fails at 99%. What happens?**
With a single `PUT`, the client restarts from zero, which is unacceptable for large files. With multipart, the file is split into parts uploaded independently, so I retry the one failed 5MB part and keep everything else. Multipart also gives me parallelism, which matters because a single TCP stream frequently can't saturate a client's uplink on high-latency links, per-part checksums so corruption is localized, and real progress reporting. For flaky mobile connections a resumable session — where the server tracks a byte offset the client can query after a disconnect — is often a better fit than parallel parts. Either way, the client must persist the upload ID and completed-part list locally, or a page refresh loses resumability even though the server would allow it.

**Q4 (depth). The client uploads successfully and then crashes before telling you. What state are you in?**
Inconsistent: the object exists but my database still says `PENDING`, which is the dual-write problem — two systems, no transaction between them. The primary fix is to not depend on the client for completion: subscribe to the object store's event notification, so the upload being finished is a fact my infrastructure observes rather than a claim a client makes. I keep the client-side completion call as a latency optimization so the UI updates immediately, but never as the only path. Then a reconciler sweeps `PENDING` rows older than the URL expiry, does a `HEAD` on the object, and either promotes them or marks them abandoned. And the ordering rule matters: create the metadata row before issuing the URL and only mark it available after verifying the object exists, so I never reach the worst state — `AVAILABLE` with no object, where the UI promises a file that will 404.

**Q5 (depth). Your limit is 100MB. The bytes never touch your server. How do you enforce it?**
At signing time, using a presigned POST policy with a `content-length-range` condition, so the storage service itself rejects anything outside the range — the enforcement happens where the bytes actually arrive. I'd bind `Content-Type` into the signature the same way. Then I verify again on completion: `HEAD` the object and compare real size and checksum against what the client declared, because the declared size is untrusted input and quota accounting must use the actual value. For multipart there's a subtlety — per-part limits don't bound the total by themselves — so the completion check plus a quota decrement on the verified size is what actually holds the line. And I'd rate-limit URL issuance per user so someone can't mint thousands of upload grants.

**Q6 (depth). Explain content-addressable storage and what it buys you.**
Chunk the file, hash each chunk, and use the hash as the storage key, with metadata holding an ordered manifest of hashes. That single decision gives dedup — identical content hashes identically so it's stored once, and a client can ask "do you have these hashes?" and upload only the misses, which is why the second person to upload a popular file uploads almost nothing. It gives integrity, because the key *is* the checksum, so re-hashing on read detects corruption with no extra bookkeeping. It gives immutability, so chunks are cacheable forever. And it gives efficient sync: editing part of a large file re-uploads only affected chunks. The important refinement is content-defined chunking with a rolling hash rather than fixed offsets — with fixed-size chunks, *inserting* bytes shifts every subsequent boundary and invalidates the rest of the file, while content-defined boundaries keep the change local. The costs are a large hot hash index, a privacy side channel where a client can probe whether content already exists, and reference-counted deletion.

**Q7 (senior). How do you serve private content through a CDN?**
Two mechanisms, chosen by granularity. Signed URLs give a per-object, time-limited grant validated at the edge — precise, but you must sign each object. Signed cookies grant access to a path or set of objects with one credential, which is the right choice for video, where a single playback session touches hundreds of segments and signing each one is impractical. Either way the origin bucket stays private and only the CDN can fetch from it, using origin access controls rather than public reads. The parts people miss: cache keys must not include the signature, or every unique URL becomes a distinct cache entry and hit rate collapses; and revocation is weak, so keep expiry short, because a purged-but-cached private object being served from an edge is a privacy incident rather than mere staleness.

**Q8 (senior). Deduplication is on. A user deletes their file. What do you delete?**
Probably nothing physical, immediately. Metadata gets a soft delete so the user can undo and support can recover, and the chunks are shared — if a chunk is referenced by 400 other files, deleting it would corrupt all of them. So chunk deletion is reference-counted or mark-and-sweep: decrement on manifest removal and physically delete only at zero, after a grace period. The race matters: another user may be uploading a file referencing the same chunk while the refcount hits zero, so the safe order is increment before writing the new manifest and decrement after removing the old one, with the grace period covering the window. Then deletion has to propagate to CDN and caches, since a purged private object still served from an edge is a privacy problem. And for compliance-grade deletion I'd use crypto-shredding — per-user encryption keys, destroy the key — because genuinely purging every backup, replica, thumbnail, and search index is often infeasible.

**Q9 (senior). Where does the real scaling difficulty live in a Dropbox-style system?**
Not the blobs — object storage absorbs those. It's the **metadata**, because the bucket isn't queryable: "list this user's files by date" can't be answered by a `LIST` at scale, since it's prefix-only, slow, and paginated, so every access pattern has to be served by my own store. At billions of files that means sharding, and the shard key is the whole decision: shard by owner and a user's listing hits one shard, shard by file ID and every listing scatters. Hierarchy adds another axis — materialized paths make subtree reads cheap and renames expensive, parent pointers do the reverse, so I pick based on which operation is more frequent. Versioning multiplies row count and needs a retention policy, and soft deletes mean every query carries a predicate that the indexes must include. The bytes are a solved problem; the file system semantics on top are not.

**Q10 (staff). Design the upload path for a video platform, end to end.**
The upload itself is the easy part: metadata row, presigned multipart upload, bytes direct to object storage, completion driven by a storage event. What makes it a video platform is that **the object I store is never the object I serve**, so the storage event kicks off a pipeline — probe the file, then transcode into a bitrate ladder, segment each rendition into a few-second chunks, generate HLS/DASH manifests, extract thumbnails, and run content-safety and copyright checks. That's a [multi-step process](./multi-step-processes.md) with expensive steps, so it needs per-step checkpointing so a failure at the 1080p rendition doesn't rerun 4K, idempotent steps keyed by (video, rendition) so retries don't duplicate work, and a persisted state machine plus a sweeper for stuck jobs. I'd transcode in parallel per rendition and per segment, publishing progressively so the video becomes watchable at 480p before the 4K rendition finishes — which is a real product win. Serving is CDN-first with signed cookies for a playback session, since one session hits hundreds of segment URLs. On cost: I'd tier the original master to archive storage after publishing, because it's rarely read again but must be kept for re-encodes, and I'd expect egress to dominate the bill, which is what justifies the CDN economically as well as for latency.

**Q11 (staff). What's the most commonly missed operational failure in this pattern?**
Two, and both are silent. The first is **incomplete multipart uploads**: when a client abandons an upload, the already-uploaded parts persist and you're billed for storage that no object references and no console view naturally surfaces — the fix is a bucket lifecycle rule to abort incomplete uploads after a few days, and it's a bill plenty of teams have paid before noticing. The second is **uploaded content served from your own origin**, where a user uploads an HTML or SVG file that then executes JavaScript in your application's origin, giving them access to session cookies — a genuine stored-XSS vector. The mitigations are serving user content from a separate cookieless domain, forcing `Content-Disposition: attachment` where appropriate, and never trusting the client-supplied filename or extension, since I generate my own storage key anyway. I'd also add that "never serve unscanned user content" needs to be enforced by the state machine — the object stays in `SCANNING` and unservable until the async scan passes — rather than by remembering to check.

---

## Quick Recall Cheat Sheet

| Term | One-line answer |
|---|---|
| **The one rule** | Metadata through your API; **bytes never through your API** |
| **Why not proxy** | Bandwidth-seconds scaling, LB timeouts, gateway body caps, double egress cost, deploys kill uploads |
| **Presigned URL** | Storage URL + HMAC signature + expiry, scoped to one method and one key |
| **What storage verifies** | The signature and the expiry — nothing about *who* the caller is |
| **It's a bearer token** | Can't be revoked before expiry → short TTL, narrow scope, never log it |
| **Size enforcement** | Presigned POST policy `content-length-range` at signing + verify actual size on completion |
| **Completion signal** | **Storage event notification**, not the client's word. Client callback is only a UX optimization |
| **Order of operations** | Metadata row → issue URL → upload → verify object exists → mark available |
| **Worst state** | `AVAILABLE` in DB, object absent. Prevented by verify-before-promote |
| **Reconciler** | Sweeps `PENDING` rows past expiry: `HEAD` → promote or abandon |
| **Orphan collector** | Deletes objects with no metadata row |
| **Multipart** | Create → parallel UploadPart (5MB min, 10,000 max) → Complete with ETags |
| **Fail at 99%** | Retry one part, not the whole file. Plus parallelism, per-part checksums, real progress |
| **Resumable session** | Server-tracked byte offset the client queries after a disconnect (GCS/tus). Better on flaky mobile |
| **Client must persist** | `uploadId` + completed parts, or a refresh loses resumability |
| **Hidden bill** | Incomplete multipart parts are stored and charged → lifecycle rule to abort them |
| **Content-addressable** | Key = hash of chunk → free dedup, free integrity, immutability, delta sync |
| **Content-defined chunking** | Rolling-hash boundaries survive byte *insertions*; fixed-size chunking doesn't |
| **Dedup privacy** | A client can probe whether content exists — scope dedup or require proof of possession |
| **Range requests** | `Range:` → `206 Partial Content` + `Accept-Ranges`. Powers resume, parallel download, video seek |
| **Signed URL vs cookie** | URL = one object, precise. Cookie = many objects, right for video segments |
| **Cache-key warning** | Never include the signature in the CDN cache key |
| **Video ≠ download** | Segment + manifest (HLS/DASH) + bitrate ladder; optimize first-frame and rebuffer, not throughput |
| **Metadata is the hard part** | Buckets aren't queryable — every access pattern needs your own store |
| **Metadata shard key** | Shard by owner → listings hit one shard. By file ID → every listing scatters |
| **Paths vs parent pointers** | Materialized paths: cheap subtree reads, expensive renames. Parent pointers: the reverse |
| **Never trust filename** | Generate your own key (UUID); keep the display name as metadata only |
| **Stored XSS vector** | Serve user content from a separate cookieless domain; `Content-Disposition: attachment` |
| **Malware scan** | Async post-upload, gated by a `SCANNING` state — never serve unscanned content |
| **Tiering traps** | Minimum storage duration charges; per-object overhead makes tiering tiny files a net loss |
| **Cost reality** | **Egress usually dominates** — the financial case for a CDN, not just a latency one |
| **Deletion with dedup** | Reference-counted or mark-and-sweep; increment before, decrement after, plus a grace period |
| **Compliance deletion** | Crypto-shredding (per-user key, destroy it) when purging every backup is infeasible |
| **Small files (<~1MB)** | Just go through the API — presigned URLs add a round trip for no gain |

---

## Related

- **Patterns:** [Long-Running Tasks](./long-running-tasks.md) (post-upload processing) · [Multi-Step Processes](./multi-step-processes.md) (the transcode pipeline, and the dual-write bug in §4) · [Scaling Reads](./scaling-reads.md) (CDN and cache layers) · [Real-Time Updates](./realtime-updates.md) (notifying other devices a new version exists)
- **Fundamentals:** [checksum](../fundamentals/checksum.md) · [merkle-trees](../fundamentals/merkle-trees.md)
- **Topics:** [`file-storage`](../interviews/file-storage/README.md) · [`video-streaming`](../interviews/video-streaming/README.md) · [`cdn-edge`](../interviews/cdn-edge/README.md) · [`blob-storage/s3-grill-me-answers.md`](../blob-storage/s3-grill-me-answers.md)
