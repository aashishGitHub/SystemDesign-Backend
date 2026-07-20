# System Design: Video Streaming (Netflix / YouTube)

> **Target:** Senior / Staff backend engineers (Google, Meta, Amazon, Microsoft, Netflix, Uber).
> **Style:** Interview-grill format — question first, then defended design choices.

---

## How to Use This Guide

1. Attempt each question in `questions.md` without opening answers.
2. Check your reasoning in `answers.md`.
3. **New to the topic?** Read `conducive-sentences.md` — it re-tells every answer as plain-English prose you can read top-to-bottom, with each concept flowing into the next.
4. Use `deep-dive.md` to practice senior/staff depth, failure modes, and production tradeoffs.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Fundamentals | What video streaming is, why it's hard, core components |
| 2 | Upload Pipeline | Chunked upload, resumable upload, presigned URLs |
| 3 | Transcoding Pipeline | Codec selection, multi-resolution renditions, async processing |
| 4 | Adaptive Bitrate Streaming | HLS/DASH protocol mechanics, manifest files, segment delivery |
| 5 | CDN & Video Delivery | Edge caching for video, byte-range requests, multi-CDN |
| 6 | Storage & Metadata | Blob storage architecture, metadata DB, content deduplication |
| 7 | Watch History & Resume | Idempotent progress tracking, at-scale patterns |
| 8 | Architect Deep-Dives | DRM, live streaming, global delivery, failure modes |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 34 structured interview questions (8 levels + bonus). |
| [answers.md](./answers.md) | Answers keyed to each question, with code/table per answer. |
| [conducive-sentences.md](./conducive-sentences.md) | Plain-English prose version of every answer. Read to *understand*; each section ends with a "So, the connection is…" bridge to the next concept. |
| [deep-dive.md](./deep-dive.md) | Beginner → Senior → Architect depth, real-world examples, failure modes. |
| [diagrams.md](./diagrams.md) | 12 interview-ready Mermaid diagrams (start with Diagram 1 — the write/read path split), each with a "what the interviewer is checking" list. |

---

## Problem Statement

> Design a video streaming platform like Netflix or YouTube that allows creators to upload videos and viewers to stream them on-demand.
>
> The system must support:
> - creators uploading large video files (up to 50 GB)
> - processing each video into multiple resolutions and bitrates
> - serving video to 200 million concurrent viewers globally with smooth playback
> - adaptive streaming that adjusts quality based on network conditions
> - storing and resuming watch progress across devices

**Key Constraints:**
- **Upload size:** up to 50 GB per video file
- **Concurrent viewers:** 200 million globally
- **Playback start latency:** < 2 seconds (time to first byte)
- **Global availability:** serve from the edge nearest to viewer
- **Storage:** millions of videos, each stored at 4–8 quality levels
- **Durability:** content must never be lost (11 nines on blob storage)

---

## How a Senior Engineer Thinks About This

A strong design separates the **write path** (upload → transcode → store) from the **read path** (stream → CDN → viewer). These have completely different scaling requirements. The write path is throughput-heavy and async — a video upload triggers a durable processing pipeline. The read path is latency-critical and read-heavy — it must serve billions of byte-range requests per day from the edge.

Next, they recognize that **video delivery is not like API delivery**. Files are enormous (2–8 GB per video in a single quality), clients need specific byte ranges (not whole files), and the same content is requested by millions of viewers. This forces CDN-first architecture where content lives at the edge, not in origin.

Finally, they think about **adaptive bitrate streaming (ABR)** as the core reliability mechanism. Rather than streaming one large file, content is split into 2–10 second segments at multiple quality levels. The player switches quality dynamically based on bandwidth — degraded playback at 240p beats a buffering spinner at 1080p. Understanding HLS/DASH manifests and segment delivery is what separates candidates who've thought about video from those who assume it's "just file download."
