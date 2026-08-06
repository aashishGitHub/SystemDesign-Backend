# Interview Questions: Consistent Hashing

> Attempt every question before reading [answers.md](./answers.md).
> Work level-by-level — later questions build directly on earlier ones.
>
> **Questions are in plain words on purpose.** Real interviewers ask short, simple questions and then judge the depth of your answer. Don't let the simple wording fool you — the answers in [answers.md](./answers.md) are pitched at senior/staff level, and the follow-up you'd actually get is noted under each one as *"they'll then ask…"*.

---

## Level 1 — The Core Problem
*Start here even if you've never touched a distributed system. Just think about what breaks.*

**Q1.** You have some data spread across a few servers. What goes wrong when you add one more server? Say it in one sentence, without using the word "hashing."

**Q2.** You have 4 cache servers and you pick one with `hash(key) % 4`. You add a 5th. Roughly how many of your keys now live on the wrong server? Show your working.
> *They'll then ask:* why that ratio, and what happens as the cluster gets bigger?

**Q3.** All those keys just moved. What happens in the next few seconds, and why might it take the whole site down?
> *They'll then ask:* how would you size that blast radius before doing it?

**Q4.** Does keeping 3 copies of every key make that moment better or worse?

---

## Level 2 — The Hash Ring
*You know the problem. Now the fix.*

**Q5.** What is a hash ring? Where do the servers sit on it, and where do the keys sit?

**Q6.** Servers sit at positions A=10, B=120, C=230 on a ring numbered 0–359. Who owns a key that hashes to 150? Who owns one that hashes to 80?

**Q7.** A new server D joins at position 180. Who loses data, how much of it, and exactly which keys?
> *They'll then ask:* why is that so much better than the modulo case in Q2?

**Q8.** Why a *circle*? What breaks if you just use a straight line from 0 to the biggest hash?

---

## Level 3 — Virtual Nodes
*The ring alone isn't enough. Three random points on a circle are rarely evenly spaced.*

**Q9.** You put 3 servers on the ring, one position each. Why might one server end up with almost all the data? Give real numbers.

**Q10.** What are virtual nodes (vnodes, or "tokens")? How do they fix Q9?
> *They'll then ask:* what does the lookup code have to change? (Careful — this is a trick.)

**Q11.** Cassandra defaults to 256 vnodes per server. With 6 servers, how many positions are on the ring? Does 256 *guarantee* even load? Yes or no, and why?

**Q12.** What do you give up by using 500 vnodes per server instead of 10? Name each cost.

---

## Level 4 — Servers Joining and Leaving
*A ring that never changes is easy. Production rings change constantly.*

**Q13.** Walk me through what happens, step by step, when a new server joins a live ring. Don't skip the boring parts.
> *They'll then ask:* at which exact moment does the new server start serving reads, and why not earlier?

**Q14.** Now the same thing, but a server is being shut down on purpose for maintenance. What's different from Q13?

**Q15.** A server dies suddenly. Nobody planned for it. What happens to reads and writes for its keys — with replication, and without?

**Q16.** Requests are already in flight when the ring changes. Why is that a problem, and what do you do about it?

---

## Level 5 — Replication
*One copy per key means every key range is a single point of failure.*

**Q17.** How do you keep more than one copy of a key using the ring? What's a "preference list"?
> *They'll then ask:* what's the bug if you just take the next 3 positions clockwise?

**Q18.** Write the quorum rule using N, W and R. With N=3, give me two (W, R) pairs that are safe and one that isn't.

**Q19.** What's a "sloppy" quorum? What do you gain, and what do you quietly give up?

**Q20.** A write arrives but one of the three replicas is unreachable. Explain hinted handoff: where does the data go, and what happens when the dead server comes back?
> *They'll then ask:* the client got a 200 OK — name a way that write can still be lost.

---

## Level 6 — Real Systems
*Every major system made an explicit choice here. Know what they picked.*

**Q21.** In Cassandra, what's a "token"? How does a server get its tokens?

**Q22.** Amazon's Dynamo paper (2007) put this pattern on the map. How does Dynamo stay available when a server fails, without losing data?

**Q23.** Redis Cluster doesn't really use a ring. What does it use instead, and what does it gain and lose by doing that?

**Q24.** How does a CDN use consistent hashing to route a request to an edge server? Which property makes it a good fit here?

---

## Level 7 — What Breaks
*A senior candidate brings these up before being asked.*

**Q25.** What's a "hot key"? Consistent hashing spreads keys evenly — so why doesn't it fix this?

**Q26.** Your cluster is mixed: 5 servers with 32GB and 3 with 128GB. Every server has the same number of vnodes. What goes wrong, and how do you fix it?

**Q27.** What is "ring oscillation"? When does it happen, and why is it so hard to spot?

**Q28.** Your hash function bunches everything into 30% of the ring, leaving 70% empty. What would you *see* in production, and how would you catch it?

---

## Level 8 — Architect-Level Tradeoffs
*Design-review depth, past the textbook answer.*

**Q29.** Consistent hashing vs range-based sharding (HBase, Bigtable, CockroachDB). What's the one real tradeoff? Give a case where each clearly wins.

**Q30.** What is jump consistent hash, and how does it decide where a key goes without storing a ring? Compare its time and space cost to a ring, and name the thing it can't do.

**Q31.** You need to move a live production system from `hash(key) % N` to consistent hashing, with zero downtime. Walk me through it — including the window where a key could be in two places.

**Q32.** An interviewer says "shard by user_id." Before you agree, what three questions do you ask?

---

## Bonus — Questions You Should Raise Unprompted

**QB1.** One user generates 100× the traffic of everyone else, and they're all on one server. Consistent hashing got you here. Now what?

**QB2.** Your single most popular key is too big to fit on one server at all. No amount of ring tweaking helps. Options?

**QB3.** Your team wants to go from 2 copies to 3 on a live cluster. Walk through the steps and what can go wrong at each one.

**QB4.** Same ring, two different jobs: in front of a cache, and in front of a database. What's the one operational difference that actually matters?
