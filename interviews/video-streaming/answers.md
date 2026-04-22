# Answers: Video Streaming (Netflix / YouTube)

> Keyed to [questions.md](./questions.md). Read questions first.
> Each answer includes either code or a comparison table so you can defend tradeoffs clearly.

---

## Level 1 — Fundamentals & System Components

### A1. Why video can't be served like a JSON response

A 4 GB video file has five fundamental differences from a 10 KB API payload:

| Dimension | JSON API | Video File |
|---|---|---|
| Size | Kilobytes | Gigabytes |
| Access pattern | Entire response needed | Viewer skips, seeks, pauses |
| Delivery | One response, done | Ongoing byte-range stream |
| Concurrency | Many different responses | Same bytes requested by millions |
| Latency tolerance | Must start fast | Must buffer ahead predictably |

Sending a 4 GB file in one response means: clients wait minutes for buffering to begin, any network hiccup restarts the entire stream, no seeking is possible without downloading everything before it, and one popular video crushes your servers because you can't cache it at the network level.

---

### A2. Write path vs read path

| Path | Trigger | Scale Requirement | Latency Requirement |
|---|---|---|---|
| **Write path** | Creator uploads | Low throughput, high data volume | Minutes (async processing is fine) |
| **Read path** | Viewer presses play | Billions of requests/day | Milliseconds (sub-2s to first byte) |

```text
WRITE PATH:
Creator → Upload API → Blob Storage (raw) → Transcoding Queue
       → Encoding Workers → Blob Storage (renditions) → Metadata DB → Ready

READ PATH:
Viewer → CDN Edge → (cache hit: serve segment directly)
               → (cache miss: fetch from Blob Storage, cache, serve)
```

The write path is **throughput-bounded and async**. The read path is **latency-bounded and read-heavy**. Coupling them creates both availability risk (write pipeline failure affects streaming) and performance risk (writes compete with reads).

---

### A3. What causes buffering and how to prevent it

Buffering happens when the download rate falls below the required playback rate.

| Cause | Fix |
|---|---|
| Segment size too large | Use 2–4s segments (smaller = faster recovery) |
| Only one quality level | Adaptive bitrate — switch to lower quality |
| Origin too far from viewer | CDN edge caching close to viewer |
| Segment delivery latency too high | Pre-fetch N segments ahead (buffer pool) |
| TCP slow start on segment requests | HTTP/2 multiplexing, connection reuse |

Empirical rule: a viewer tolerates ~1 second of initial startup delay and ~0.1% buffering ratio before abandoning playback (Netflix/YouTube research).

---

### A4. Latency problem for Tokyo viewer on US origin

Without CDN: each segment request (2–4 seconds of video, ~1-3 MB) travels 10,000 km. Round-trip latency: ~200ms. For 100 segments in a movie: 200ms × 100 = 20 seconds of pure network overhead.

Fix: **CDN edge node in Tokyo**. First viewer triggers a cache miss to US origin (one round-trip per segment). Every subsequent viewer hits the Tokyo edge (sub-5ms). Cache policy: video segments are **immutable** (content never changes, perfect CDN target), so set TTL very long (days/weeks).

```text
Without CDN: Tokyo viewer → US origin (200ms RTT per segment)
With CDN:    Tokyo viewer → Tokyo edge (3ms) → US origin (cache miss, one-time)
```

---

## Level 2 — Video Upload Pipeline

### A5. Why chunk large uploads

| Problem Without Chunking | Solution With Chunking |
|---|---|
| 10 GB in single request, connection drops at 8 GB | Re-upload only the failed chunk |
| Server must hold entire file in memory | Process/stream each chunk |
| Proxy/gateway timeouts (typically 30s-5min) | Each chunk fits in timeout window |
| No upload progress feedback | Report % per chunk |
| Single TCP stream can't saturate uplink | Upload multiple chunks in parallel |

Typical chunk size: 5–25 MB. Each chunk uploads independently. Server assembles them after all chunks are received.

---

### A6. Resumable upload implementation

```text
Step 1: Client requests upload session
  POST /uploads
  Response: { upload_id: "up_abc123", chunk_size: 8MB }

Step 2: Upload chunks with range headers
  PUT /uploads/up_abc123?part=1
  Content-Range: bytes 0-8388607/10738180000
  Response: { etag: "abc", part: 1 }

Step 3: On network failure — query for uploaded parts
  GET /uploads/up_abc123/parts
  Response: { completed_parts: [1, 2, 3, 5], missing: [4, 6, 7...] }

Step 4: Resume — only upload missing chunks
  PUT /uploads/up_abc123?part=4
  ...

Step 5: Complete when all parts received
  POST /uploads/up_abc123/complete
  Body: { parts: [{part: 1, etag: "abc"}, ...] }
```

State is stored server-side (Redis or DB) with TTL (e.g., 7 days). This is the TUS protocol, and it's also how AWS S3 Multipart Upload works.

---

### A7. Presigned URLs for direct-to-storage upload

Without presigned URLs: Client → App Server (receives 10 GB) → S3 (re-uploads 10 GB). App server becomes the bottleneck, handles double the bandwidth.

With presigned URLs: App Server generates a short-lived signed URL, Client uploads directly to S3.

```ts
// Server generates presigned URL — client uploads directly
async function createUploadUrl(key: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: process.env.UPLOAD_BUCKET,
    Key: key,
    ContentType: 'video/*',
  });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
}

// API response:
// { upload_url: "https://s3.amazonaws.com/uploads/raw/abc123?X-Amz-Signature=..." }
```

| Benefit | Detail |
|---|---|
| Reduced app server load | App server never touches the bytes |
| Cost reduction | S3 ingress is cheaper than EC2 bandwidth |
| Security | Signed URLs expire, scope upload to specific key |
| Scale | S3 handles parallel uploads from millions of creators |

---

### A8. Triggering the pipeline after upload completes

Use **S3 event notifications → message queue** to decouple upload from processing:

```text
S3: ObjectCreated event → SQS queue → Transcoding consumer

OR:

S3: ObjectCreated event → SNS → Lambda → kicks off Step Functions workflow
```

```json
// S3 event message:
{
  "eventName": "ObjectCreated:CompleteMultipartUpload",
  "s3": {
    "bucket": { "name": "raw-video-uploads" },
    "object": { "key": "raw/creator_456/vid_789.mp4", "size": 10737418240 }
  }
}
```

Never poll S3 for new files — event-driven prevents missed uploads and eliminates constant polling overhead.

---

## Level 3 — Transcoding Pipeline

### A9. What is transcoding and why is it required

Raw video from cameras is enormous (100 GB for 1 hour of 4K), uses proprietary codecs (ProRes, RAW), and cannot be directly streamed by browsers. Transcoding converts it to:
- **Streamable formats**: web-compatible containers (`.mp4`, `.ts`, `.fmp4`)
- **Compressed codecs**: H.264/AVC, H.265/HEVC, AV1 (efficient for bandwidth)
- **Multiple resolutions**: 240p, 360p, 480p, 720p, 1080p, 4K
- **Segmented files**: 2–4s segments for HLS/DASH adaptive streaming

| Without Transcoding | With Transcoding |
|---|---|
| 100 GB ProRes file | 2–8 GB per quality level, segmented |
| Browser can't decode ProRes | H.264 plays in every browser natively |
| One quality — can't adapt | 6+ renditions — switches with bandwidth |
| Single file — can't seek without downloading | Segments — seek to any point instantly |

---

### A10. Parallel transcoding

A 1-hour video at 30 FPS = 108,000 frames. Sequential transcoding processes frames one-at-a-time. Parallel approach:

```text
Strategy 1: Parallel renditions
  Transcode 240p, 360p, 720p, 1080p simultaneously on 4 workers → 4x faster

Strategy 2: Segment parallel (GOP-parallel)
  Split video into 30-second chunks (GOPs — Group of Pictures)
  Transcode each chunk on a separate worker
  Stitch chunks back once all complete
  60 chunks × parallel = 60x speed-up

Strategy 3: Both (Netflix/YouTube approach)
  Split AND parallelize per rendition
  For 60 chunks × 6 renditions = 360 parallel tasks
  ~15-minute total with 50 workers
```

```text
AWS MediaConvert, FFmpeg on EC2, or Zencoder:
  Job: transcode raw/vid_789.mp4
    ├── Task: 240p, chunk 1-30  → worker 1
    ├── Task: 360p, chunk 1-30  → worker 2
    ├── Task: 720p, chunk 1-30  → worker 3
    ...360 total tasks → stitched on completion
```

---

### A11. Rendition ladder selection

| Rendition | Bitrate | Use Case |
|---|---|---|
| 240p | 200-400 Kbps | Very slow mobile, 3G |
| 360p | 400-800 Kbps | Standard mobile |
| 480p | 800-1500 Kbps | Good mobile/tablet |
| 720p (HD) | 1.5-4 Mbps | Tablet/desktop |
| 1080p (FHD) | 4-8 Mbps | Desktop, TV |
| 1440p (2K) | 8-16 Mbps | High-end displays |
| 2160p (4K) | 15-40 Mbps | 4K TV |

Netflix uses a **per-title encoding** strategy: comedy shows compress 3x better than action movies at the same perceived quality. ML models determine the optimal bitrate per scene, reducing bandwidth 30-40% with equal visual quality (called "Dynamic Optimizer").

---

### A12. Handling transcoding job crashes

Use **idempotent, checkpointed jobs** with a message queue:

```text
Message queue: SQS with visibility timeout (30 min)
Transcoding worker:
  1. Poll queue, receive job {video_id, chunk_range, rendition}
  2. Process chunk
  3. Write output to S3 with deterministic path:
     transcoded/{video_id}/720p/chunk_042.ts
  4. Update DB: chunk 42 of 720p = DONE
  5. Delete message from queue

On crash:
  Visibility timeout expires → message reappears in queue
  Another worker picks it up
  Worker checks S3: chunk_042.ts already exists (idempotent)
  Skips re-encoding, acknowledges message → no duplicate work
```

| Design Choice | Why |
|---|---|
| Deterministic S3 path | Idempotency — re-run is safe |
| Separate message per chunk | Small failure unit — only lost chunk retries |
| Visibility timeout > max chunk duration | Prevents premature requeue while still processing |
| DB progress tracking | Coordination service knows when all chunks done |

---

## Level 4 — Adaptive Bitrate Streaming

### A13. What is ABR and why it beats fixed-quality

Adaptive Bitrate Streaming (ABR) is the mechanism where the player continuously selects the video quality that matches current network bandwidth, without buffering.

```text
Fixed quality:  Stream 1080p → bandwidth drops below 4 Mbps → BUFFER SPINNER
ABR:            Streaming 1080p → bandwidth drops → player switches to 480p → continues smoothly
```

| Metric | Fixed Quality | ABR |
|---|---|---|
| Startup time | Slow (wait for large segment) | Fast (start with small 360p segment) |
| Buffering probability | High (single quality for all networks) | Low (degrades gracefully) |
| Bandwidth efficiency | Wastes bandwidth on slow networks | Matches exactly what network supports |
| User experience | Frustrating spinner or low quality forever | Smooth with quality fluctuations |

ABR is why Netflix can have 200M concurrent streams — most downgrade below 1080p, massively reducing bandwidth.

---

### A14. HLS manifest file structure

HLS (HTTP Live Streaming, Apple's standard) uses `.m3u8` text files to describe what segments exist and at what quality.

```m3u8
# Master manifest (tells player what quality levels exist)
#EXTM3U

#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
/hls/video_789/360p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
/hls/video_789/720p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
/hls/video_789/1080p/index.m3u8
```

```m3u8
# Per-quality playlist (tells player what segments exist)
#EXTM3U
#EXT-X-TARGETDURATION:4

#EXTINF:4.0,
/hls/video_789/720p/seg_001.ts
#EXTINF:4.0,
/hls/video_789/720p/seg_002.ts
...
#EXTINF:3.8,
/hls/video_789/720p/seg_1800.ts
#EXT-X-ENDLIST
```

Player workflow:
1. Fetch master manifest → learn available qualities
2. Fetch per-quality playlist → learn segment URLs
3. Measure bandwidth → select appropriate quality
4. Fetch segments in sequence → play
5. Continuously re-measure bandwidth → switch quality if needed

---

### A15. Player quality switching decision

Players implement a **bitrate adaptation algorithm** (ABR algorithm):

```text
Common algorithms:
  BOLA (Netflix): buffer-based — switch down if buffer < 10s, switch up if buffer > 30s
  MPC (Model Predictive Control): throughput estimate + buffer level combined
  
Decision inputs:
  - Current download speed (measured on last 3 segments)
  - Buffer level (seconds ahead of playhead)
  - Available quality levels from manifest

Decision logic (simplified):
  download_speed = 2.5 Mbps (measured)
  buffer = 15s (current buffer)
  
  if buffer < 8s: switch DOWN regardless of speed
  elif download_speed * 0.8 >= rendition_bitrate: switch UP
  else: switch DOWN one level
```

The 0.8 safety factor prevents thrashing (switching up too aggressively then immediately back down).

---

### A16. CMAF segments and short segment duration

**CMAF** (Common Media Application Format) is a unified container format supported by both HLS and DASH, eliminating the need to encode twice.

```text
Segment duration tradeoffs:
  Long segments (10s): 
    + Fewer requests (lower overhead)
    - Latency for live streaming (next segment not ready for 10s)
    - Bad seek resolution (skipping anywhere within 10s = imprecise)
    - Slow quality switch (must finish 10s before switching)
  
  Short segments (2–4s):
    + Fast quality switching
    + Better seek precision
    + Lower latency for live (<5s behind live with 2s segments)
    - More requests (more small HTTP requests)
    - More files to store and cache
```

Netflix moved from 10s to 4s segments in 2016. YouTube uses 2s for live. The short segment approach also enables **Low-Latency HLS (LL-HLS)** which achieves <2s live latency using partial segments.

---

## Level 5 — CDN & Video Delivery

### A17. Why standard CDN config is wrong for video

Standard CDN: `Cache-Control: max-age=3600` — evict everything after 1 hour.

Problem for video:

| Issue | Detail |
|---|---|
| Segments are immutable | Segment `seg_001.ts` for video 789 never changes — TTL should be infinite |
| Cache eviction causes origin hammers | Popular segments re-fetched constantly without long TTL |
| Manifest files DO change | Master manifest is static, but for live streaming, segment playlist updates every 2s |
| Byte-range requests need special config | CDN must support partial object caching |

Correct CDN cache policy for video:

```text
Video segments (.ts, .m4s):        Cache-Control: max-age=31536000, immutable
                                    (never expire — content-addressed by URL)

Master manifest (master.m3u8):     Cache-Control: max-age=3600
                                    (changes rarely — new quality added)

Segment playlist (index.m3u8):     Cache-Control: no-cache          (live)
                                    Cache-Control: max-age=3600      (VOD)

Thumbnail images:                   Cache-Control: max-age=86400
```

---

### A18. Byte-range requests and video seeking

When a viewer seeks to 1h 23m in a 2-hour movie, they need a specific portion of a file, not the whole thing.

```http
GET /videos/movie_456/1080p/seg_1492.ts HTTP/1.1
Range: bytes=0-4194303

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-4194303/8388608
Content-Length: 4194304
```

| Why It Matters | Detail |
|---|---|
| Instant seeking | Watch segment 1,492 without downloading segments 1–1,491 |
| Resumable playback | Resume mid-segment if interrupted |
| Parallel download | Download multiple segments in parallel |
| CDN partial caching | CDN can cache specific byte ranges independently |

With HLS/DASH, seeking already works at segment granularity (each segment = 2–4s). Byte-range requests are still used within a segment for format-level seeks and HTTP/2 efficiency.

---

### A19. Netflix Open Connect vs Standard CDN

| Aspect | Standard CDN (CloudFront, Fastly) | Netflix Open Connect |
|---|---|---|
| Infrastructure | Shared CDN PoPs | Netflix-owned servers installed in ISP data centers |
| Cost | Pay-per-GB egress | Hardware cost upfront, near-zero ongoing egress |
| Placement | Major PoPs in cities | Inside ISP networks — eliminates last-mile latency |
| Control | Limited customization | Full control over cache policy, prefetching |
| Cache fill | Pull (on demand) | **Proactive push** — popular content pre-loaded nightly |
| Scale | Elastic, auto-scales | Fixed capacity per appliance |

Netflix's key insight: ISPs want to reduce peak traffic. Netflix installs appliances inside ISP infrastructure for free — ISP saves bandwidth, Netflix saves cost. About 95% of Netflix traffic is served from Open Connect without leaving the consumer's ISP network.

---

### A20. Thunder herd on viral segment

When 10 million viewers request the same segment simultaneously (new episode drops):

```text
Without protection:
  10M requests → CDN miss → 10M requests hit origin S3 → S3 throttles → 429 errors
  → CDN serves errors to viewers → playback failure

With protection:

  Layer 1: CDN request coalescing
    CDN receives 10M simultaneous requests for seg_001.ts
    CDN collapses into ONE request to origin
    Origin sends one copy to CDN
    CDN fans out to 10M waiting viewers

  Layer 2: Pre-warming
    Before new season drops:
    Netflix proactively pushes popular episodes to OCA appliances overnight
    (or in the 30 minutes before premiere time)
    CDN is already warm when viewers click play

  Layer 3: S3 read replication
    If origin is S3, enable S3 Transfer Acceleration
    Add CloudFront in front of S3 as second caching layer
```

CDN request coalescing (also called "request collapsing") is the key mechanism. Without it, popular content events would be impossible to serve.

---

## Level 6 — Storage Architecture & Content Deduplication

### A21. Blob storage structure for video files

```text
S3 bucket layout:
  raw-uploads/
    {creator_id}/{upload_id}.mp4            ← original upload (kept for re-encode)

  transcoded/
    {video_id}/
      metadata.json                         ← rendition manifest
      master.m3u8                           ← HLS master playlist
      240p/
        index.m3u8                          ← quality-level playlist
        seg_001.ts, seg_002.ts ... seg_N.ts ← video segments
      720p/
        index.m3u8
        seg_001.ts ... seg_N.ts
      1080p/
        ...

  thumbnails/
    {video_id}/
      thumb_00:01:00.jpg
      thumb_00:05:00.jpg
      ...

  subtitles/
    {video_id}/
      en.vtt
      es.vtt
```

| Design Decision | Reason |
|---|---|
| Content-addressed segment names | Segments are immutable — deterministic names = easy CDN caching |
| Separate raw from transcoded | Allows re-encode without losing original |
| video_id as top-level key | Simple deletion, ACL, and CDN invalidation |

---

### A22. Content deduplication

Two strategies:

**Exact deduplication (byte-level):**
```ts
// Hash the file before upload
const sha256 = await computeSHA256(videoFile);
const existing = await db.query(
  'SELECT video_id FROM videos WHERE content_hash = $1', [sha256]
);
if (existing) return existing.video_id; // return existing video, skip upload
```

**Near-duplicate/perceptual deduplication (video fingerprinting):**
- **Audio fingerprint**: hash of audio waveform (used by YouTube Content ID)
- **Visual hash**: perceptual hash (pHash) of keyframes — matches even if bitrate/resolution differs
- Netflix uses more sophisticated techniques involving machine-learning embeddings

```text
YouTube Content ID:
  1. Rights holders upload reference files
  2. YouTube generates audio + video fingerprint
  3. Every upload is fingerprinted and compared
  4. Match → copyright action (block, monetize, track)
```

Exact dedup is for identical bytes (same file uploaded twice). Perceptual dedup is for copyright enforcement.

---

### A23. Why metadata lives separately from blob storage

| Dimension | Blob Storage (S3) | Relational/Document DB |
|---|---|---|
| What it stores | Raw bytes (segments, manifests) | Structured metadata (title, tags, creator, status, views) |
| Query capability | None — only GET by key | Full SQL/query: `WHERE genre = 'comedy' ORDER BY views DESC` |
| Access pattern | High-throughput sequential reads | Low-latency point lookups and indexes |
| Cost per GB | Very cheap ($0.023/GB/month on S3) | Expensive ($0.115/GB on RDS) |
| Mutability | Immutable objects (content never changes) | Heavily updated (views, comments, status changes) |

```text
Metadata DB (PostgreSQL or DynamoDB):
  videos: id, creator_id, title, description, status, duration, views, tags, created_at
  renditions: video_id, quality, bitrate, segment_count, s3_prefix, status

Blob Storage (S3):
  Actual bytes of every segment, manifest, thumbnail, subtitle file
```

---

### A24. Video deletion with CDN caches

Deletion is hard because content is cached globally on hundreds of CDN edge nodes.

```text
Step 1: Soft-delete in metadata DB
  UPDATE videos SET status = 'deleted', deleted_at = NOW() WHERE id = $1
  → API starts returning 404 for this video immediately
  → But CDN still serves old segments to ongoing streams

Step 2: CDN cache invalidation
  Issue invalidation requests to CDN for:
    - /hls/video_789/*  (all segments)
    - /thumbnails/video_789/*
  Cost: CDN charges per-path invalidation (expensive for millions of segments)
  Alternative: use short TTL on manifests (1 min) — segments still served until TTL, playlist goes 404

Step 3: S3 object deletion
  After CDN TTL expires (confirm with CDN access logs):
    aws s3 rm s3://transcoded/video_789/ --recursive

Step 4: Raw file deletion
  raw-uploads/creator_456/vid_789.mp4 → delete after grace period
```

For legal takedowns: CDN invalidation must happen immediately. For creator deletions: CDN TTL expiry is usually acceptable.

---

## Level 7 — Watch History & Resume Position

### A25. Cross-device resume position

Resume position is stored centrally and fetched at playback start.

```text
Client (mobile) → reports progress every 5s → Progress Service → DB

Client (TV app) → GET /watch-progress/movie_456
               ← { position_seconds: 4523, total_seconds: 7200, device: "mobile" }
               → Player seeks to 4523s before first play
```

```ts
// Client reports progress
POST /watch-progress
// Body derived from player state
{
  video_id: "movie_456",
  position_seconds: 4523,
  total_seconds: 7200,
  client_ts: 1711800000  // client clock for ordering
}

// Server: upsert with "latest wins" logic
UPDATE watch_progress
SET position_seconds = GREATEST(position_seconds, $2),
    updated_at = NOW()
WHERE user_id = $1 AND video_id = $3
AND client_ts <= $4  // reject older updates
```

---

### A26. Watch progress write throughput

```text
Scale math:
  200M concurrent viewers
  Progress reported every 5 seconds
  200,000,000 / 5 = 40,000,000 writes/second = 40M writes/s

One PostgreSQL primary: ~10k-50k writes/s → cannot handle this directly
```

| Strategy | How It Helps |
|---|---|
| Write to Redis first (hot store) | Redis handles millions of writes/s, async flush to DB |
| Batch writes | Aggregate 30s of updates per user into one DB write |
| Sharded writes | Hash user_id across 100s of DB shards |
| Eventual consistency | Progress doesn't need to be durable on every 5s tick |

```text
Netflix approach (inferred from engineering blog):
  Client → Kafka (durable event log, 40M/s easily)
         → Stream processor (aggregates, deduplicates, picks latest)
         → DB write every 30 seconds per user (40M/30 = 1.3M writes/s)
         → DB sharded by user_id across 100+ shards = 13k writes/s per shard
```

---

### A27. Idempotency for watch progress

Network retries can cause duplicate progress reports. Without idempotency, a retry could set position back.

```ts
// Idempotency via "latest position wins" with client timestamp
async function recordProgress(userId: string, videoId: string, positionSec: number, clientTs: number) {
  await db.query(`
    INSERT INTO watch_progress (user_id, video_id, position_seconds, client_ts)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, video_id)
    DO UPDATE SET
      position_seconds = CASE
        WHEN excluded.client_ts > watch_progress.client_ts THEN excluded.position_seconds
        ELSE watch_progress.position_seconds
      END,
      client_ts = GREATEST(watch_progress.client_ts, excluded.client_ts)
  `, [userId, videoId, positionSec, clientTs]);
}
```

| Design | Why |
|---|---|
| Use client timestamp | Client clock knows the order of progress reports |
| `GREATEST` for position | Always keep latest, never roll back |
| UPSERT pattern | Insert first time, update existing |

---

### A28. Per-title completion analytics at scale

```text
Naive: SELECT COUNT(*) FROM watch_progress WHERE video_id=$1 AND position_seconds/total_seconds >= 0.7
Problem: full table scan at 10B rows = slow

Solutions:
```

| Approach | How It Works | Tradeoff |
|---|---|---|
| Pre-aggregated counter | Increment `completed_count` when user crosses 70% | Fast reads, one write per completion per user |
| Lambda architecture | Kafka stream → Spark batch job → aggregate table | Accurate but 1-hour delay |
| Approximate HyperLogLog | Redis `PFADD` per video when user crosses 70% | ±0.81% error, O(1) storage |
| Materialized view | DB materialized view refreshed every hour | Simple, not real-time |

Netflix's approach: real-time Kafka stream of progress events → Flink stream processor → rolling window completion counts → stored in read-optimized Cassandra rows keyed by video_id.

---

## Level 8 — Architect-Level Tradeoffs

### A29. DRM integration

DRM (Digital Rights Management) encrypts content so only authorized clients can decrypt and play it.

```text
Without DRM: Video segments are plain bytes — anyone who captures CDN URLs can download and redistribute
With DRM:    Segments are encrypted, decryption key only released after license validation

Architecture:
  1. During transcoding: encrypt segments with content encryption key (CEK)
     - Store CEK in Key Management Service, NOT in S3
  2. Segment in S3/CDN: encrypted bytes (useless without key)
  3. At play time:
     Player → License Server (authenticated request)
     License Server: verify user has entitlement
     License Server → returns CEK for this video (short-lived)
     Player → decrypts segments locally → plays video

DRM systems:
  Widevine (Chrome, Android)
  FairPlay (Safari, iOS, Apple TV)
  PlayReady (Edge, Windows)
  → Multi-DRM: one video encrypted once (CMAF), licensed via different DRM per platform
```

DRM adds ~50-200ms license request latency before first playback. Cache the license in the player for the session duration to avoid re-fetching per segment.

---

### A30. Live streaming differences from VOD

| Dimension | VOD (On-Demand) | Live Streaming |
|---|---|---|
| Content availability | Fully available at play time | Generated in real-time |
| Transcoding timing | Before publishing (minutes/hours) | Real-time (~1-2s latency budget) |
| Segment playlist | Fixed list (`.m3u8` with `#EXT-X-ENDLIST`) | Rolling window, no end marker |
| CDN cache policy | Segments: immutable, long TTL | Segments: short TTL, playlist: no-cache |
| Failure impact | Small (retranscode and republish) | Catastrophic (live viewers affected immediately) |
| Storage | S3 (offline storage after ingestion) | Ring buffer in memory, archive to S3 asynchronously |

```text
Live pipeline:
  Encoder (OBS/RTMP) → Ingest Server (SRT/RTMP)
    → Transcoding (real-time FFmpeg, GPU-accelerated)
    → HLS/DASH segmenter (2s segments)
    → Origin CDN (short TTL, pull)
    → Edge CDN → Viewers

Low-latency: LL-HLS with partial segments → <2s delay behind live
Standard: HLS with 6s target latency → 10-30s delay behind live
```

---

### A31. Detecting transcoding worker crash before metadata notification

```text
Problem:
  Worker: transcodes video, writes 1080p to S3
  Worker: crashes before updating metadata DB to "1080p_ready"
  Metadata DB: still shows "1080p_pending"
  Video is actually ready but system thinks it's not
```

Solutions:

| Strategy | Implementation |
|---|---|
| S3 event notification | S3 ObjectCreated event → directly update metadata or trigger completion checker |
| Idempotent job checker | Cron job: for any video in "pending" > 30 min, check S3 — if files exist, mark ready |
| Outbox pattern | Worker writes to outbox table in same DB transaction as completion update |
| Heartbeat + timeout | Worker sends heartbeat every 30s; no heartbeat in 2 min → job reassigned |

```ts
// S3 event-driven completion detection
s3.on('ObjectCreated', async (event) => {
  const key = event.s3.object.key;
  // key = transcoded/video_789/1080p/seg_final.ts
  const { videoId, quality } = parseKey(key);
  const totalSegments = await getExpectedSegmentCount(videoId, quality);
  const existingSegments = await s3.listObjects({ prefix: `transcoded/${videoId}/${quality}/` });
  if (existingSegments.count === totalSegments) {
    await db.query('UPDATE renditions SET status = $1 WHERE video_id = $2 AND quality = $3',
      ['ready', videoId, quality]);
  }
});
```

---

### A32. Quality variant pruning for long-tail content

```text
Pareto distribution of video views:
  Top 1% of videos → 90% of all views (popular/viral content)
  Bottom 80% of videos → <5% of all views (long-tail)

For long-tail videos:
  Storing 8 quality levels × 1000 segments × 2 MB = 16 GB per video
  For 100M videos in long-tail: 1.6 exabytes just for unused renditions

Netflix's "Title-Aware Encoding":
  At upload time: encode all 8 renditions (not knowing popularity yet)
  After 30 days with <100 views: delete 4K, 1080p, archive only up to 720p
  If video goes viral later: re-encode from stored original (raw upload kept)
```

```text
Storage tier strategy:
  S3 Standard (hot): top 10% by last-30-day views → all renditions
  S3 Infrequent Access (warm): medium-tail → fewer renditions (up to 1080p)
  S3 Glacier (cold): long-tail → only original + 480p fallback
  S3 Glacier Deep Archive: very old content → original only (restore on demand)
```

Total storage cost reduction: Netflix reported 40-50% storage savings via tiered encoding + content lifecycle.

---

## Bonus — Senior Questions

### AB1. Thumbnail and subtitle pipeline

Both run as separate async jobs triggered by the same S3 event as transcoding, but don't block video availability:

```text
S3 ObjectCreated → SNS fanout →
  ├── SQS: Transcoding job workers
  ├── SQS: Thumbnail generator (FFmpeg -ss 01:00 -frames:v 1)
  └── SQS: Subtitle processor (Whisper AI for auto-captions, or burn-in from upload)

Video becomes "streamable" once transcoding completes.
Thumbnails/subtitles can be added post-publish (metadata update, no re-encode).
```

---

### AB2. CDN warm-up for high-demand releases

```text
New season: premiere midnight UTC
  
  T-4h: Update metadata DB — video status = "pre-release" (not playable yet)
  T-2h: Begin pre-warming CDN:
    Request all segments for all episodes from CDN edge nodes in all regions
    CDN populates cache before any viewer requests
    (Netflix OCA: proactive push vs CDN pull on-demand)
  
  T-0: Flip video status = "available" in metadata
  
  Result: First 10M viewers all hit CDN cache — zero origin hammer
```

---

### AB3. Content moderation pipeline

```text
Upload → S3 trigger → Parallel analysis:
  ├── AWS Rekognition / in-house model: detect NSFW frames
  ├── Audio analysis: detect copyrighted material
  ├── Video fingerprint: compare to CSAM hash database (PhotoDNA)
  └── Metadata scan: title/description text moderation

Status transitions:
  uploaded → analyzing → approved (published) / flagged (human review) / rejected
```

---

### AB4. Raw video retention vs rendition-only

| Strategy | Cost | Flexibility |
|---|---|---|
| Keep raw + all renditions | Highest | Re-encode with new codec (AV1), apply new pipeline |
| Keep raw + compressed original only | Medium | Can re-encode any quality but transcoding delay |
| Keep renditions only | Lowest | Cannot re-encode if new codec/quality needed |

YouTube keeps originals. Netflix keeps originals AND re-transcodes their entire catalog every few years as codec efficiency improves (e.g., H.264 → HEVC → AV1 transition).

---

## ⚡ Quick Revision Cheatsheet

### Scale Numbers (back-of-envelope)

```text
200M concurrent viewers × 4 Mbps avg = 800 Tbps CDN egress bandwidth
200M viewers × progress update/5s = 40M writes/s on watch progress
1-hour video, 4s segments = 900 segments per quality level
1-hour video × 8 quality levels × 900 segments × 2 MB avg = ~14 GB per full title
100M title library × 14 GB = 1.4 exabytes (that's why tiered storage matters)
```

### Key Technology Choices

| Component | Choice | Why |
|---|---|---|
| Raw upload storage | S3 Multipart Upload with presigned URLs | Creator uploads directly — app server not in data path |
| Upload chunking | TUS protocol or custom chunks + SQS | Resumable, idempotent |
| Pipeline trigger | S3 → SNS → SQS → workers | Event-driven, decoupled |
| Transcoding | FFmpeg workers / AWS MediaConvert | Industry standard: parallel GOPs |
| Streaming format | HLS + CMAF (H.264/HEVC/AV1) | Universal client support + single encode |
| Video segments storage | S3 Standard → IA → Glacier (tiered) | Cost optimization by popularity |
| CDN | Netflix: Open Connect / Others: CloudFront+Fastly | ISP-embedded cache eliminates last-mile |
| Watch progress store | Kafka → Redis → DB (sharded) | 40M/s writes → batch → durable |
| Metadata DB | PostgreSQL (or DynamoDB at scale) | Structured queries, indexes on genre/title |
| DRM | Widevine + FairPlay + PlayReady (multi-DRM) | Cover all platforms |

### Canonical Tradeoffs to Memorize

- **Short segments (2–4s) vs long (10s):** faster switching + lower live latency vs fewer HTTP requests
- **CDN edge compute vs origin centralization:** lower latency for viewers vs higher complexity
- **Store raw video vs renditions only:** re-encode flexibility vs storage cost
- **Presigned direct-to-S3 vs app-server upload:** app server not in data path vs more control
- **Push CDN (Open Connect) vs pull CDN:** lower latency + predictable cache vs simpler operations
- **Exact dedup (SHA-256) vs perceptual dedup (fingerprint):** cheap + fast vs copyright enforcement

### Common Interview Mistakes to Avoid

- Designing upload to go through app server for a 10 GB file (use presigned S3 URL)
- Forgetting transcoding is async — video is not streamable on upload completion
- Using offset pagination for segment lists (use cursor — immutable files with seq IDs are perfect for keyset)
- Treating watch progress as a simple DB write (40M writes/s requires Kafka + batching)
- Storing video metadata and bytes in the same system (DB for metadata, S3 for bytes)
- Assuming one CDN is enough globally (Netflix uses ISP-embedded OCAs, not typical CDN)
- Forgetting DRM — any interviewer for a streaming company expects you to mention content protection
- Not mentioning the thunder herd problem on popular content first-request cache misses
