# System Design: Social Feed (Twitter / X)

> **Target:** Senior / Staff engineers (Google, Meta, Amazon, Microsoft, Uber, Stripe).
> **Style:** Interview-grill format — question first, then defended implementation choices.

---

## How to Use This Guide

1. Attempt every question in `questions.md` cold before reading answers.
2. Check `answers.md` — compare your reasoning, note what you missed.
3. Use `deep-dive.md` for senior/architect depth, real-world company implementations, and failure modes.

---

## Learning Path

| Level | Topic | You'll Learn |
|---|---|---|
| 1 | Core Problem | Why displaying a user's home feed is deceptively hard at scale |
| 2 | Data Model | Tweets, Users, Follow graph — storage and sharding |
| 3 | Feed Generation | Fan-out on write vs fan-out on read, and why Twitter uses hybrid |
| 4 | The Celebrity Problem | How accounts with 100M followers break naive fan-out |
| 5 | Timeline Caching | Redis for pre-computed feeds, cache invalidation strategies |
| 6 | Real-Time Updates | WebSocket/SSE for live feed updates without refresh |
| 7 | Ranking & Filtering | Moving from chronological to relevance-based feeds |
| 8 | Production Operations | Capacity planning, failure modes, monitoring, scaling stories |

---

## Files

| File | Purpose |
|---|---|
| [questions.md](./questions.md) | 42 structured questions (8 levels + bonus QB). Attempt cold first. |
| [answers.md](./answers.md) | Every answer with code or comparison table, named tradeoffs, company references. |
| [deep-dive.md](./deep-dive.md) | Beginner → Architect depth, real-world Twitter/Meta implementations, failure modes, cheat sheet. |

---

## Problem Statement

> Design the home timeline feature of a Twitter-like social network. When a user opens the app, they should see recent posts from accounts they follow, sorted by relevance or recency.
>
> **POST /tweet** — publish a new tweet (max 280 chars, optional media)
> **GET /feed** — retrieve the authenticated user's home timeline
> **POST /follow/{userId}** — follow another user
>
> **Key Constraints:**
> - 500M daily active users
> - Average user follows 200 accounts
> - 1% of users are "celebrities" (>100K followers)
> - 0.01% are mega-celebrities (>10M followers)
> - Feed load must complete in < 200ms p99
> - 500M tweets posted per day
> - Read:write ratio = 1000:1 (highly read-heavy)

---

## How a Senior Engineer Thinks About This

The naive approach — "query all tweets from followed users at read time" — collapses instantly. With 200 followees and 500M DAU, every feed load becomes a fan-out-on-read across 200 shards, joining and sorting in real-time. That's 100 billion read operations per day just for timeline loads. The database melts.

The first insight is **pre-computation**: when a user tweets, push that tweet ID into every follower's timeline cache. This flips the work from read-time to write-time. For most users (few followers), this is cheap. But for celebrities with 50M followers, a single tweet triggers 50M write operations — a "fan-out storm" that can take minutes and overwhelm the write path.

The canonical solution is **hybrid fan-out**: 
- For normal users (< 10K followers): fan-out on write — push tweet to followers' cached timelines.
- For celebrities (> 10K followers): fan-out on read — followers fetch celebrity tweets at read time and merge with their pre-computed timeline.

This hybrid approach is exactly what Twitter documented in their engineering blog. The interviewer expects you to arrive here, explain why, and then dive into cache structure (Redis sorted sets), follow graph storage (graph DB or adjacency list in Cassandra), and failure modes (what happens when a celebrity tweets during peak traffic).
