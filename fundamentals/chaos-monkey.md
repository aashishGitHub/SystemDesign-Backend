# Chaos Monkey

**Chaos Monkey** is a tool created by Netflix that **randomly kills servers and services in your system** — on purpose — to test if your system can survive failures.

---

## The Core Idea

Real systems fail. Servers crash, networks drop, databases go down. Instead of waiting for that to happen in production at 3am, you **intentionally break things during business hours** so you can fix weaknesses before they become real outages.

---

## How It Works

1. **Randomly picks** a running server/service/container
2. **Kills it** (terminates the process or shuts down the machine)
3. **Watches what happens** — does the system recover automatically? Do users notice?
4. Engineers **fix any problems** discovered

---

## Simple Analogy

> It's like a fire drill. Instead of waiting for a real fire, you pull the alarm yourself so everyone learns how to escape safely.

---

## Why It's Useful

| Problem | Chaos Monkey Finds It |
|---|---|
| Single point of failure | One server dies, whole app goes down |
| No auto-recovery | System doesn't restart crashed services |
| Bad failover logic | Backup doesn't kick in properly |
| Hidden dependencies | Service A fails when B is killed |

---

## The Bigger Picture

Netflix expanded this into **Chaos Engineering** — a whole discipline. The full toolkit is called the **Simian Army**, which includes:

- **Chaos Gorilla** — kills an entire data center zone
- **Latency Monkey** — adds random delays to simulate slow networks
- **Chaos Kong** — takes down an entire AWS region

The principle: **if it can break, break it yourself first** so you're prepared when it breaks for real.
