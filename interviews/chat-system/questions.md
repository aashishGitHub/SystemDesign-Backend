# Interview Questions: WhatsApp / Slack (Chat System)

> Attempt each question before reading [answers.md](./answers.md).

---

## Level 1 — Chat Fundamentals (Beginner)
*For engineers new to real-time messaging systems*

**Q1.** Why can't you use regular HTTP request-response for a chat application? What happens when Alice sends a message to Bob if Bob's phone is just waiting?

**Q2.** What is a WebSocket? How is it different from HTTP? Draw the connection lifecycle (handshake → messages → close).

**Q3.** When Alice sends "Hello" to Bob, what entities need to be stored in the database? Design a simple `messages` table schema.

**Q4.** How do you ensure messages in a conversation appear in the correct order? What field do you sort by, and why is using just a timestamp risky?

**Q5.** What is a "Snowflake ID"? Why is it better than auto-increment or UUID for message IDs in a distributed system?

---

## Level 2 — Real-Time Transport (Junior)
*Understanding WebSocket, Long Polling, and SSE*

**Q6.** Compare WebSocket, Long Polling, and Server-Sent Events (SSE). Which would you choose for a chat app and why?

**Q7.** A chat server has 50,000 WebSocket connections. A user connects from their phone and then opens the web app. How do you handle multiple connections per user?

**Q8.** WebSocket connections can drop (network switch, server restart, mobile backgrounding). How does the client know the connection died? What's a heartbeat/ping-pong mechanism?

**Q9.** After reconnecting, the client needs to catch up on messages received while disconnected. Design the "sync" protocol — what does the client send, what does the server respond?

**Q10.** How do you scale WebSocket servers horizontally? If Alice is connected to Server A and Bob to Server B, how does Alice's message reach Bob?

---

## Level 3 — Message Delivery Guarantees (Mid-Level)
*At-least-once delivery, ordering, acknowledgments*

**Q11.** What does "at-least-once" delivery mean? Why is it easier to achieve than "exactly-once"? What's the user-facing consequence of at-least-once?

**Q12.** Alice sends a message, but her internet cuts out right after. She doesn't know if it was delivered. When she reconnects, she retries. How do you prevent Bob from seeing the message twice?

**Q13.** Explain the three-tick system (WhatsApp): single gray tick (sent), double gray tick (delivered), double blue tick (read). At what point in the flow does each tick appear?

**Q14.** In a 1:1 chat, message ordering is simple — sort by ID. But what if Alice and Bob both send at the exact same millisecond from different timezones? How do you break ties?

**Q15.** A message is "delivered" when it reaches the recipient's device. A message is "read" when the user opens the conversation. How do you track and update these statuses efficiently?

---

## Level 4 — Presence & Typing Indicators (Senior)
*Online/offline status, "last seen", typing notifications*

**Q16.** How do you determine if a user is "online"? What's the threshold (e.g., 30 seconds since last activity)? Where do you store presence state?

**Q17.** User closes the app but doesn't explicitly log out. Their WebSocket closes. How long do you wait before marking them offline? Why not immediately?

**Q18.** Alice opens her chat with Bob. She sees "Bob is typing..." How is this implemented? What are the pitfalls (spamming "typing" events)?

**Q19.** WhatsApp shows "last seen at 3:42 PM." Some users disable this for privacy. How does this privacy setting work technically, and what does the viewer see instead?

**Q20.** Presence is transient data that changes constantly. Why is Redis a good choice for storing it? What Redis data structures would you use?

---

## Level 5 — Group Messaging (Senior)
*Fan-out strategies, group metadata, scalability*

**Q21.** Alice sends a message to a 200-person group. Describe the fan-out process. Why can't you just loop through 200 recipients synchronously?

**Q22.** In a group with 1,000 members, storing who has read each message creates 1,000 status records per message. Groups exchange thousands of messages. How do you scale read receipts for large groups?

**Q23.** WhatsApp groups have a 1,024 member limit. Slack channels can have 100,000+ members. What architectural differences enable Slack's larger groups?

**Q24.** A group admin removes a member. What happens to that member's access to message history? How do you handle this in the database and client?

**Q25.** In a very active group (10 messages/second), how do you prevent overwhelming a user's phone with notifications? What batching or throttling strategies help?

---

## Level 6 — Media & Attachments (Senior)
*Image/video upload, thumbnails, CDN delivery*

**Q26.** Alice sends a 10 MB photo to a group. Describe the upload flow. Should the image be embedded in the message, or referenced by URL?

**Q27.** Sending a photo should show a "sending" preview immediately on the sender's side. How do you provide instant feedback while the upload is still in progress?

**Q28.** Images should be compressed, thumbnails generated, and multiple resolutions created. Where does this processing happen — client, upload server, or async worker?

**Q29.** Bob is on a slow 3G connection. How do you progressively load media — showing a blurry thumbnail first, then full resolution on tap?

**Q30.** Messages with media reference a CDN URL. If that URL is guessed, anyone could access the media. How do you secure media access?

---

## Level 7 — Offline & Push Notifications (Staff)
*APNs, FCM, message queuing for offline users*

**Q31.** Bob's phone is offline for 8 hours. Alice sends 50 messages. When Bob's phone comes online, how are these messages delivered? Are they all sent as push notifications?

**Q32.** Push notifications have payload size limits (4 KB for APNs). A message can be longer. How do you handle this? What does the notification actually contain?

**Q33.** The user has 10 new messages across 5 conversations. Do you send 10 individual push notifications or batch them? What's the UX tradeoff?

**Q34.** Push tokens (APNs/FCM) can become invalid (user uninstalls app, disables notifications). How do you detect and clean up stale tokens?

**Q35.** A user has both phone and tablet. When they read a message on the phone, the notification on the tablet should disappear. How do you implement this "notification sync"?

---

## Level 8 — Production Operations (Architect)
*Monitoring, failure modes, encryption, compliance*

**Q36.** Your chat system handles 500K messages/second. What metrics would you monitor? List 8-10 key metrics and their alerting thresholds.

**Q37.** A chat server crashes with 50,000 active connections. What happens to in-flight messages? How do clients recover? What's the user experience?

**Q38.** WhatsApp uses end-to-end encryption (E2EE). Explain at a high level how E2EE works for 1:1 chats. What does the server see?

**Q39.** For a group chat with E2EE, every member needs to decrypt the message. If you have 100 members, do you encrypt the message 100 times?

**Q40.** A government requests message content for a criminal investigation. With E2EE, what can your company provide? What's the legal and technical reality?

**Q41.** Users report messages are "delayed" — taking 5+ seconds to appear. Walk through your debugging process from alert to root cause.

**Q42.** You need to migrate from one message database (MySQL) to another (Cassandra) without downtime. The system processes 500K messages/second. How do you do this?

---

## Bonus — Questions a Senior Brings Up Unprompted

**QB1.** "We should discuss the connection routing problem. When Alice sends to Bob, and they're on different servers, how does Alice's server know which server Bob is connected to? I'd use Redis to store user→server mapping, updated on connect/disconnect."

**QB2.** "For message ordering, we need to distinguish sender order vs receiver display order. I'll use Snowflake IDs generated on the server when the message is received, not client timestamps which can drift."

**QB3.** "Group fan-out is a hot topic. For small groups (<100), synchronous delivery is fine. For large groups, I'd use Kafka with a partitioned topic — partition by recipient_id so each consumer handles a subset of users."

**QB4.** "Push notifications are a fallback, not the primary channel. We pay per push, they have rate limits, and they're not guaranteed. WebSocket is primary; push is for waking up the app when it's backgrounded."

**QB5.** "We should talk about anti-spam. Bad actors can flood messages. I'd implement rate limiting per sender (100 messages/minute?), content analysis for known spam patterns, and user reporting flows."

**QB6.** "Message storage for a group creates a hot partition — all messages go to the same conversation_id. I'd use a composite partition key: (conversation_id, time_bucket) so messages are spread across partitions while still allowing range queries."
