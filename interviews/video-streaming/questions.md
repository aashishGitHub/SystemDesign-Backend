# Interview Questions: Video Streaming (Netflix / YouTube)

> Attempt all questions before reading [answers.md](./answers.md).
> Work level-by-level; later questions assume earlier concepts.

---

## Level 1 — Fundamentals & System Components
*Goal: verify core understanding of what makes video streaming hard.*

**Q1.** Why can't you serve a 4 GB video file the same way you serve a 10 KB JSON API response?

**Q2.** What are the two completely separate paths in a video streaming system, and why must they be designed independently?

**Q3.** What is buffering and why does it happen? What system decisions control it?

**Q4.** A viewer in Tokyo streams a Netflix video hosted in a US data center. What is the latency problem and how do you fix it?

---

## Level 2 — Video Upload Pipeline
*Goal: design a safe, resumable upload path for large files.*

**Q5.** Why must large video uploads be split into chunks? What happens if you don't?

**Q6.** A creator uploads a 10 GB video. The network drops at 8 GB. How does the upload resume without restarting?

**Q7.** What is a presigned URL, and why should video uploads go directly to blob storage rather than through your application server?

**Q8.** After a file is fully uploaded, how does the system know it's ready for the next stage? What event-driven pattern do you use?

---

## Level 3 — Transcoding Pipeline
*Goal: process raw video into streamable multi-resolution renditions.*

**Q9.** What is transcoding, and why must every uploaded video be transcoded before it can be streamed?

**Q10.** A 1-hour raw video takes 3 hours to transcode sequentially. How do you reduce this to 15 minutes?

**Q11.** What resolutions and bitrates should a video be transcoded to, and how do you decide which ones matter?

**Q12.** A transcoding job crashes at the 70% mark. How do you handle retry without reprocessing the first 70%?

---

## Level 4 — Adaptive Bitrate Streaming (ABR)
*Goal: understand HLS/DASH and how quality switching works.*

**Q13.** What is adaptive bitrate streaming (ABR) and why is it better than streaming a single fixed-quality video?

**Q14.** What is an HLS manifest file (`.m3u8`), and what does it contain?

**Q15.** How does a video player decide when to switch from 720p to 360p mid-stream?

**Q16.** What is a CMAF segment and why do modern platforms use 2–4 second segments instead of 10-second ones?

---

## Level 5 — CDN & Video Delivery
*Goal: design efficient, globally-distributed video delivery.*

**Q17.** Why is a standard CDN configuration (cache all objects for 1 hour) insufficient for video streaming?

**Q18.** What is a byte-range request and why is it critical for video seeking?

**Q19.** How does Netflix's Open Connect Appliance (OCA) differ from a standard CDN like CloudFront?

**Q20.** A video goes viral — 10 million viewers request the same first segment simultaneously. What happens at the CDN and at the origin?

---

## Level 6 — Storage Architecture & Content Deduplication
*Goal: design the storage layer for millions of video files efficiently.*

**Q21.** How do you structure blob storage for a video that exists in 8 quality variants × hundreds of segments?

**Q22.** A creator uploads a video that is identical to one already in the system. How do you detect and deduplicate it?

**Q23.** Why is video metadata stored in a relational/document DB while the video files themselves go to blob storage?

**Q24.** How do you handle video deletion — the creator wants it removed, but it may be CDN-cached globally?

---

## Level 7 — Watch History & Resume Position
*Goal: design reliable, idempotent progress tracking at scale.*

**Q25.** A viewer watches 40% of a movie on mobile, then opens the TV app. How does resume position work?

**Q26.** A viewer's player reports progress every 5 seconds. At 200M concurrent viewers, how many writes/second is that — and how do you handle it?

**Q27.** Why must watch progress writes be idempotent, and how do you implement that?

**Q28.** Netflix needs to know, per title, how many users watched at least 70% (for "completed" classification). How do you compute this at scale without scanning every row?

---

## Level 8 — Architect-Level Tradeoffs
*Goal: show deep system thinking beyond the happy path.*

**Q29.** What is DRM (Digital Rights Management), and where in the architecture does it integrate without adding playback latency?

**Q30.** How does live streaming (e.g., a live sports event on YouTube) differ architecturally from on-demand streaming?

**Q31.** A transcoding worker processes a video and writes the output to S3. The worker crashes before notifying the metadata service. How do you detect and recover from this?

**Q32.** At what point does it become cheaper to store fewer quality variants (e.g., only 3 instead of 8) for long-tail content, and how do Netflix/YouTube implement this?

---

## Bonus — Senior Questions You Should Raise Unprompted

**QB1.** How do you thumbnail generation and subtitle pipeline as separate async jobs without blocking video availability?

**QB2.** What is our CDN cache warm-up strategy for newly released high-demand content (a new season dropping at midnight)?

**QB3.** How do we detect and handle malicious uploads (deepfakes, CSAM, copyright violations) before content goes live?

**QB4.** What is the cost tradeoff between storing original raw video versus only keeping transcoded renditions?
