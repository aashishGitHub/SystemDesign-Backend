# System Design: Personalized Recommendation Engine

> **Target:** Aspiring Senior Fullstack Engineers at Walmart, Google, Amazon, or similar cloud-scale companies.
> **Style:** Interview-grill format — every concept is introduced as a question first, then answered. Read questions cold before looking at answers.

---

## How to Use This Guide

1. **First pass — attempt every question yourself** before reading the answer. Write your answer in a scratch doc. Even a wrong answer builds the mental model faster than passive reading.
2. **Second pass — read the answers**, compare to yours, note what you missed.
3. **Third pass — close everything** and try to whiteboard the full system from memory.

---

## Learning Path

The questions and answers are split into **9 levels**. Each level builds directly on the previous one. Do not skip levels.

| Level | Topic | You'll Learn |
|-------|-------|-------------|
| 1 | Requirements & API Design | What the system actually needs to do |
| 2 | Ingestion Pipeline | How to absorb 500k events/sec without crashing |
| 3 | Stream Processing | Kafka consumers, partitioning, ordering guarantees |
| 4 | Embeddings & ML Pipeline | What embeddings are, how user taste is modeled |
| 5 | Recommendation Algorithms | Collaborative filtering, content-based, KNN |
| 6 | Score Fusion | How two ranking signals become one list |
| 7 | Read Path & Caching | Redis, cache invalidation, thundering herd |
| 8 | Storage Design | Which database for which job, and why |
| 9 | Observability & Scale | Metrics, p99, failure modes, backpressure |

---

## Files

| File | Purpose |
|------|---------|
| [questions.md](./questions.md) | All 46 interview questions, organized by level. Read these first. |
| [answers.md](./answers.md) | Full answers to every question, with code examples and analogies. |
| [deep-dive.md](./deep-dive.md) | In-depth explanations of every concept — beginner to architect level. Real-world examples, failure modes, production tradeoffs, and a full system diagram with a quick-recall cheat sheet at the end. |

---

## The Problem Statement

> Design a service that ingests user interaction events on an e-commerce platform and provides personalized product recommendations.
>
> **POST /events** — ingest `{ user_id, item_id, event_type, timestamp }` and enqueue for processing
> **GET /recommendations?user_id=[id]&limit=[n]** — return top-n recommended item_ids
>
> **Key Constraints:**
> - Event ingestion handles **hundreds of thousands of events per second**
> - Recommendations reflect recent behavior within **seconds to minutes**
> - Personalization combines **collaborative filtering** + **content-based filtering**
> - Scale to **millions of active users** and **tens of millions of items**
> - Separate storage: raw events, embeddings, user profiles, item metadata
> - Expose metrics: ingestion lag, embedding update latency, recommendation p99, error rates

---

## How a Senior Engineer Thinks About This

A senior engineer breaks this problem into two completely separate pipelines immediately:

```
WRITE PATH  →  POST /events  →  [ingest fast, process async]
READ PATH   →  GET /recs     →  [serve fast, pre-compute heavy work]
```

Everything downstream is about making the write path **durable** and the read path **fast**.
