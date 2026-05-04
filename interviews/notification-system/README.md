# System Design: Notification System (Push, Email, SMS)

> **Target:** Senior / Staff Engineers at Google, Meta, Amazon, Microsoft, Uber, Airbnb
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered.

---

## How to Use This Guide

1. First pass — attempt every question yourself before reading the answer.
2. Second pass — read the answers, compare, note what you missed.
3. Third pass — whiteboard the full system from memory. No notes.

---

## Learning Path

| Level | Topic | You'll Learn |
|-------|-------|-------------|
| 1 | Fundamentals & Requirements | What a notification system actually needs to guarantee |
| 2 | Channel Architecture | How push, email, and SMS differ in delivery model |
| 3 | Core Pipeline Design | Ingestion, routing, queueing, dispatch |
| 4 | Fan-out & Bulk Targeting | Sending to millions of users without blowing up DB |
| 5 | Delivery Guarantees | At-least-once, deduplication, retries, idempotency |
| 6 | Priority & Rate Control | Critical vs promotional tiers, per-user throttling |
| 7 | Failure Modes & Reliability | Provider outages, dead letters, fallback channels |
| 8 | Scale & Multi-Region | 1M/sec throughput, global routing, capacity math |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | All questions, organized by level. Read first. |
| [answers.md](./answers.md) | Full answers with code examples and tradeoff tables. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations — beginner to architect level. |

---

## Problem Statement

> Design a notification system that supports push (mobile + web), email, and SMS.
> The system must handle up to **1 million notifications per second** across two notification tiers:
> - **Critical / time-sensitive**: 1:1 messages, alerts, OTP codes — must arrive within seconds
> - **Promotional / bulk**: marketing campaigns, recommendations — targeting thousands of users simultaneously
>
> The system must support expiration logic, deduplication, and channel failover.

**Key Constraints:**
- Throughput: **1M notifications/sec** at peak
- Latency: critical notifications delivered **< 5 seconds** end-to-end
- Split: **80% critical / 20% promotional** by count; promotional batches can be 10x larger per job
- At-least-once delivery with idempotent sends (no duplicate pushes to user)
- Provider abstraction: swap FCM / APNs / Twilio / SendGrid without rewriting core logic
- User-level preferences: opt-out per channel, quiet hours, frequency caps
- Expiry: promotional messages expire after TTL; critical messages do not

---

## How a Senior Engineer Thinks About This

The first thing a strong candidate does is **split the problem in two**: the write path (accepting and routing notifications) and the read/dispatch path (actually calling the downstream provider). These have wildly different latency and reliability requirements. Mixing them is the most common design mistake.

Next, treat each channel (push, email, SMS) as a **separate dispatch queue** with its own retry logic, rate limits, and provider SLA. Push via APNs costs nothing per message but has strict connection management; SMS via Twilio costs money per message and has strict per-second limits; email via SendGrid has per-day volume quotas and domain reputation to protect. A single "notification queue" that mixes all three will cause cascading failures when one provider degrades.

Finally, the hardest part is **fan-out at scale**: a single "send to users in cohort X" job might target 50 million users. The correct answer is an async fan-out worker that pages through user IDs in small batches, writes per-user records, and dequeues from per-channel workers — never a synchronous expansion of a recipient list in the API request path.
