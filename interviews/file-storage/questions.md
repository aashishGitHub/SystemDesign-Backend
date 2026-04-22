# Interview Questions: Google Drive / Dropbox (File Sync & Storage)

> Attempt each question before reading [answers.md](./answers.md).

---

## Level 1 — File Storage Fundamentals (Beginner)
*For engineers new to cloud storage systems*

**Q1.** If you were building a simple file storage service, why would you separate "metadata" (file name, size, permissions) from "content" (actual bytes)? What database would you use for each?

**Q2.** A user uploads profile.jpg. Then they rename it to avatar.jpg. Then they share it with a friend. Which of these operations touches the actual file bytes, and which only touches metadata?

**Q3.** What is blob storage (like S3)? Why is it better for storing large files than a traditional database like MySQL?

**Q4.** A file upload fails halfway through a 2 GB upload because the user's internet disconnects. With a naive implementation, they have to start over. What's the general approach to make uploads resumable?

**Q5.** You need to generate a unique identifier for each uploaded file. What are the options? Why is using the file's content hash (SHA-256 of the bytes) better than a random UUID?

---

## Level 2 — Upload Pipeline (Junior)
*Understanding how files get from client to storage*

**Q6.** Explain the "chunked upload" process step-by-step. Why split a large file into chunks (e.g., 4 MB each) instead of uploading it as one blob?

**Q7.** What is a "presigned URL" (like S3 presigned URLs)? Why do most production systems have the client upload directly to blob storage with a presigned URL instead of streaming through the API server?

**Q8.** A user starts uploading a 10 GB file as 4 MB chunks. After uploading 1000 chunks, how does the server know all chunks arrived and in correct order? What's the "finalize upload" step?

**Q9.** Two engineers debate: "We should compute the SHA-256 hash on the client before upload" vs "We should compute it on the server after upload." Who is right, and why?

**Q10.** What happens if a user uploads a corrupted file (network bit flip)? How do you detect and prevent storing corrupted data?

---

## Level 3 — Content-Addressable Storage (Mid-Level)
*Deduplication and storage efficiency*

**Q11.** User A uploads a 4 GB movie. User B uploads the same movie (same bytes). How does content-addressable storage ensure you only store one copy? What's the storage key for the file?

**Q12.** What is a "chunk manifest"? When a user downloads a file, how does the server know which chunks to combine and in what order?

**Q13.** You're using fixed 4 MB chunks. User A uploads a 100 MB document. User B inserts one sentence at the beginning of the same document. How many chunks differ between the two versions? Why is this a problem?

**Q14.** What is "content-defined chunking" (CDC) or "rolling hash chunking" (like Rabin fingerprinting)? How does it solve the problem from Q13?

**Q15.** A chunk is shared by 1 million users' files. How do you safely delete it when one user deletes their file? What's reference counting, and what can go wrong?

---

## Level 4 — Sync Protocol (Senior)
*Keeping files in sync across devices*

**Q16.** A user edits a file on their laptop (offline). Meanwhile, another user edits the same file on the web. When the laptop comes online, what are the options for resolving this conflict? Why is "last write wins" dangerous?

**Q17.** Design the `/sync/changes` API. The client has a "cursor" representing the last known server state. What does the server return? What information is needed per change (file created, modified, deleted, moved)?

**Q18.** The desktop client needs to detect when the user creates, edits, moves, or deletes a file locally. How does it do this on Windows, macOS, and Linux? What are the pitfalls?

**Q19.** A user has 100,000 files and hasn't synced in 30 days. When they reconnect, they need to catch up. How do you prevent this from overwhelming the server? What's "sync batching"?

**Q20.** The client has local file X with hash H1. The server has file X with hash H2. Neither is a subset of the other (both were modified). Walk through the conflict resolution flow.

---

## Level 5 — Sharing & Permissions (Senior)
*File sharing, ACLs, and permission models*

**Q21.** A user shares a folder with 3 colleagues. Each colleague gets different permissions: Alice can view, Bob can comment, Carol can edit. Where is this permission data stored? How do you check permission for a download request efficiently?

**Q22.** Inside a shared folder, Alice creates a subfolder and puts a document in it. Does Carol automatically get edit access to the document? What's "permission inheritance" and how is it implemented?

**Q23.** A user generates a "shareable link" that anyone with the link can view. A week later, they revoke the link. How do you implement link-based sharing with revocation?

**Q24.** Two users share a folder with each other. User A is in timezone UTC+0, User B in UTC+8. User A deletes a file at 9 AM UTC. User B, offline, edits the same file at 10 AM UTC. When B comes online, what happens?

**Q25.** A company admin wants to see all files shared externally from their organization. How do you support this "data governance" query at scale?

---

## Level 6 — Offline Support & Mobile (Senior)
*Handling disconnected clients and mobile constraints*

**Q26.** The desktop app supports "offline mode." List the 3-5 main operations the client must support offline, and what data it caches locally.

**Q27.** When the client comes back online after offline edits, it pushes changes to the server. The server may reject some (conflicts). Design the `POST /sync/commit` API request and response.

**Q28.** A mobile app syncs files, but the phone has limited storage. How do you implement "files on demand" where the file appears in the file list but isn't downloaded until opened?

**Q29.** The mobile app is syncing a large upload. The user switches to another app. On iOS, your app gets suspended. How do you handle resumable upload across app suspensions?

**Q30.** A user has 50 GB of files on their laptop, but only 10 GB of local storage available. How does "smart sync" or "selective sync" work? Who decides which files to keep locally?

---

## Level 7 — Scale & Performance (Staff)
*Handling 500M users and 500 PB of storage*

**Q31.** You have 500 petabytes of chunks stored in S3. Many chunks are only referenced by files that were deleted years ago. How do you implement garbage collection for orphaned chunks safely?

**Q32.** A user opens a folder with 10,000 files. The `list folder` API must return in < 200ms. How do you design the metadata database schema and indexes for fast folder listing?

**Q33.** Every time a file is uploaded, the server computes its SHA-256 hash. At 10,000 uploads per second, that's a lot of CPU. How do you offload hash computation?

**Q34.** You shard metadata by user_id. User A shares a folder with User B. Now a single API request (User B listing shared files) needs data from multiple shards. How do you handle cross-shard queries?

**Q35.** A popular creator shares a large video file with 1 million followers. They all try to download it at the same time. How do you handle this thundering herd?

---

## Level 8 — Production Operations (Architect)
*Running this system reliably at Google scale*

**Q36.** A new API server version has a bug that corrupts file metadata for 0.1% of uploads. It was in production for 6 hours before being detected. How do you detect this failure, roll back, and remediate?

**Q37.** S3 has an outage in us-east-1. You have multi-region blob storage. Walk through the failover process. What happens to in-progress uploads?

**Q38.** The sync service is falling behind — clients are timing out waiting for `/sync/changes`. What metrics would you look at? What's your incident response?

**Q39.** A malicious user uploads 10 million 1-byte files to consume metadata storage. File count costs more than bytes. How do you implement fair usage quotas that account for this?

**Q40.** You need to migrate 500 PB of data from one blob storage provider to another (e.g., GCS to S3). The system must stay online. How do you do this without downtime?

**Q41.** Users report that files are "corrupted" after download. You suspect silent data corruption in blob storage. How do you detect and recover from bit rot?

**Q42.** Design the monitoring dashboard for the file storage system. What are the 10 most important metrics to alert on?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** "Before we design the API, let's talk about chunking strategy. Fixed-size chunks are simple but don't dedup well across similar files. Should we use content-defined chunking like Dropbox does?"

**QB2.** "For conflict resolution, we have two philosophies: Google Docs-style operational transformation (real-time merge) vs. Dropbox-style forking (conflicted copy). Which fits our use case?"

**QB3.** "We should discuss the failure mode where a client crashes mid-sync. It pushed some changes but didn't receive acknowledgment. On restart, it doesn't know what succeeded. How do we make commit idempotent?"

**QB4.** "The metadata database is our bottleneck. Have you considered using a hierarchical key-value store like FoundationDB or CockroachDB with path-based keys instead of PostgreSQL?"

**QB5.** "What about versioning? Every edit creates a new version. Google Drive keeps 100 versions by default. At our scale, that's 100x storage. What's our retention policy and compaction strategy?"

**QB6.** "Let's think about security. A disgruntled employee at our company could access raw S3 buckets and read any user's files. How do we implement client-side encryption (zero-knowledge) while supporting sharing?"
