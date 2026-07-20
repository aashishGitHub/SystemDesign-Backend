# Hydden Interview Cheat Sheet - Quick Reference

## Hydden Key Facts (Memorize These)

### Company Mission
**"Identity security is a data and visibility problem, not just an access-control problem."**

### Core Value Proposition
- **Comprehensive visibility** of every identity everywhere (connective tissue across tools)
- Works **WITH** existing PAM/IGA investments (doesn't replace them)
- **15-minute deployment** (vs 6-12 months for traditional tools)
- **Continuous discovery** multiple times per day (not quarterly reviews)
- **70,000 users** across many Active Directories (scale reference)

### What They Solve
- 80-85% of PAM/IGA capabilities go **undeployed** (gap they fill)
- Identity tool sprawl creates "identity debt" and fragmented data
- No unified view across hybrid/multicloud/legacy environments
- Can't answer: "What access did John have on April 15th?" (forensics)

### Differentiators
1. **Treats non-human identities as first-class** citizens (service accounts, API keys, machine identities)
2. **Preserves historical state** for forensic investigations
3. **Identity graph approach** (sees relationships and attack paths)
4. **Rapid deployment** (15 mins vs months)
5. **Works anywhere** (cloud, on-prem, legacy, IoT)

---

## Identity Security Glossary

### IAM (Identity & Access Management)
**What**: Foundation - "who you are" + "what you can do"  
**Functions**: Authentication (SSO, MFA) + Authorization (permissions)  
**Examples**: Okta, Azure AD, Auth0  
**Limitation**: Focuses on auth flow, limited visibility into actual access patterns

### PAM (Privileged Access Management)
**What**: Securing high-privilege accounts  
**Functions**: Password vaulting, session recording, just-in-time access  
**Examples**: CyberArk, BeyondTrust, Delinea  
**Limitation**: Only covers ~5% of identities (admins), misses 95% of attack surface

### IGA (Identity Governance & Administration)
**What**: Compliance-focused access management  
**Functions**: Access certifications, reviews, joiner/mover/leaver workflows  
**Examples**: SailPoint, Saviynt, Oracle Identity Governance  
**Limitation**: 80-85% of capabilities unused (Hydden's key insight), too slow (quarterly reviews)

### CIEM (Cloud Infrastructure Entitlement Management)
**What**: Managing permissions in cloud environments  
**Functions**: Cloud permission discovery, least privilege, policy violations  
**Examples**: Wiz, Orca, Ermetic  
**Limitation**: Cloud-only, doesn't see on-prem or legacy

### Non-Human Identities
**What**: Service accounts, API keys, OAuth tokens, machine identities, certs, SSH keys  
**Challenge**: No clear owner, long-lived, excessive permissions, hard to discover  
**Hydden's Approach**: First-class treatment, automatic discovery, map to human owners

### Identity Graph
**What**: Graph representation of identities (nodes) and relationships (edges)  
**Purpose**: Understand attack paths, privilege chains, lateral movement  
**Example**: User A → can assume → Service Account B → has admin on → Database C

### Privilege Escalation
**Attack**: Gain higher privileges than intended  
**Method**: Exploit identity relationships (chains of can-assume, inherits-from)  
**Detection**: Map privilege graph, alert on unusual path traversal

---

## Your Experience → Hydden's Needs

| Hydden Need | Your Experience | Evidence |
|-------------|-----------------|----------|
| Real-time identity monitoring | SSE replacing polling | 3600 req/hr → near-zero |
| Identity discovery at scale | 10K concurrent connections | Memory calc, backpressure |
| RBAC-aware visibility | Per-event authorization | Runtime permission checks |
| Distributed systems | Event Bus (NATS) | Multi-instance coordination |
| Non-human identity tracking | Service account connections | Client type identification |
| Historical state analysis | SSE design includes this | "What access on date X?" |
| Golang expertise | Production SSE implementation | Goroutines, channels, concurrency |
| Security-first mindset | Multi-tenant isolation | Zero data leakage |

---

## Your Elevator Pitches

### 30-Second Version
> "I'm a software engineer at Couchbase working on real-time infrastructure. I recently designed and implemented a Server-Sent Events architecture in Golang that replaced polling with real-time push, handling 10K+ concurrent connections with RBAC-aware event delivery. I'm excited about Hydden because my experience with real-time authorization systems and distributed architectures directly aligns with solving identity visibility challenges at scale."

### 2-Minute Version
> "I'm currently at Couchbase Capella working on replacing our high-frequency polling mechanism with real-time Server-Sent Events. We were making ~3600 HTTP requests per user per hour, causing delayed updates and unnecessary server load.
>
> I designed an in-memory broker system in Golang that handles over 10,000 concurrent connections, with RBAC-aware event broadcasting - meaning we check permissions per-event, not per-connection, so users only receive updates for resources they can access. We use a distributed Event Bus with NATS to fan out events across multiple API instances, similar to how identity events need to propagate across distributed systems.
>
> What excites me about Hydden is the direct parallel. My real-time event architecture maps to continuous identity monitoring, my RBAC implementation translates to identity-aware access decisions, and my scaling work - calculating memory per connection, handling backpressure - directly applies to identity discovery at enterprise scale across 70K users.
>
> I'm also passionate about security - our SSE design enforced strict tenant isolation, handled dynamic permission changes, and included forensic capabilities through historical state tracking. I see identity security as the next frontier, and Hydden's approach of providing visibility as 'connective tissue' across existing tools really resonates with how I think about solving hard problems."

---

## Key Talking Points

### 1. Real-Time Systems Expertise
**What I Say:**
> "I built an SSE architecture that eliminated 3600 requests per hour by switching from polling to real-time push - similar to how Hydden provides continuous identity discovery instead of periodic scans."

**Why It Matters:**
- Hydden does continuous discovery (multiple times/day)
- Traditional tools do quarterly reviews
- My experience: periodic → continuous, same transition

### 2. RBAC Domain Knowledge
**What I Say:**
> "I implemented RBAC-aware event broadcasting where authorization checks happen per-event, not per-connection - ensuring users only see resources they have permission to access, which directly maps to identity access visibility."

**Why It Matters:**
- Identity visibility must be role-based
- Different SecOps users see different identity scopes
- Dynamic permission changes need immediate effect

### 3. Scaling Mindset
**What I Say:**
> "I designed for 10K concurrent connections with detailed memory calculations and backpressure handling - the same considerations needed for identity discovery across 70K users and multiple discovery cycles per day."

**Why It Matters:**
- Hydden discovers 70K users multiple times/day
- Need capacity planning, resource management
- I've proven I can design for scale analytically

### 4. Distributed Systems Experience
**What I Say:**
> "I built a distributed Event Bus using NATS that fans out events to all API instances simultaneously. This solves the same problem Hydden faces - identities exist in multiple disconnected systems, and changes need to be correlated into a unified view."

**Why It Matters:**
- Identity correlation across AWS, Azure, AD, legacy
- Events from different systems → unified identity graph
- My Event Bus pattern directly applies

### 5. Security-First Thinking
**What I Say:**
> "Our SSE design enforced tenant-level isolation, handled permission changes during live connections, and included audit logging - all critical for identity security systems."

**Why It Matters:**
- Identity platforms handle sensitive data
- Multi-tenant isolation requirements
- Audit and compliance considerations

---

## Common Identity Attack Patterns

### Privilege Escalation
- **Attack**: Gain admin rights through identity chains
- **Example**: Developer → assume ServiceAccount → admin on Production
- **Detection**: Map identity graph, detect unusual privilege paths

### Lateral Movement
- **Attack**: Use compromised account to access other systems
- **Example**: Phished user → access AWS → steal credentials → access on-prem
- **Detection**: Behavioral analysis, unusual access patterns

### Persistence
- **Attack**: Create hidden accounts for long-term access
- **Example**: Attacker creates service account, generates long-lived API key
- **Detection**: Comprehensive discovery finds all accounts, including hidden

### Identity Sprawl
- **Issue**: Users accumulate permissions over time, never removed
- **Example**: Promoted user keeps old role's permissions
- **Detection**: Continuous monitoring, least privilege analysis

---

## Questions I'll Ask Them

### Product/Technology
1. "How does Hydden's discovery engine handle legacy systems without APIs?"
2. "What's the architecture for correlating identities across disconnected systems?"
3. "How do you handle the identity mapping problem - same person, different usernames?"
4. "What's your approach to detecting privilege escalation paths in real-time?"

### Engineering Culture
1. "What's your tech stack beyond what's mentioned?"
2. "How do you test identity discovery at scale without production data?"
3. "What does the on-call rotation look like for a security-critical product?"
4. "How do you balance security requirements with rapid iteration?"

### Role-Specific
1. "What would my first 90 days look like?"
2. "What's the biggest technical challenge the team is facing right now?"
3. "What identity sources are you adding next to the supported connectors?"

---

## Numbers to Remember

### Your SSE Work
- **3,600** requests/hour per user (before SSE)
- **40+** hooks polling different entities
- **5-120** seconds polling intervals
- **10,000** concurrent connections (target capacity)
- **5.5 KB** memory per connection
- **~55 MB** RAM for 10K connections
- **< 1 second** update latency (vs up to 120s before)

### Hydden Facts
- **70,000** users across multiple AD forests
- **15 minutes** deployment time
- **Multiple times per day** - continuous discovery frequency
- **15-20%** of PAM/IGA capabilities actually deployed (market gap)
- **80-85%** capabilities unused (from interview context)

---

## Technical Terms - Quick Definitions

**SSE (Server-Sent Events)**: HTTP-based protocol for server-to-client push (one-way)

**RBAC (Role-Based Access Control)**: Permission model based on user roles

**Event Bus**: Distributed pub/sub messaging system (NATS in your case)

**Goroutine**: Lightweight thread in Go (2KB initial stack)

**Channel**: Go's communication primitive (share memory by communicating)

**Backpressure**: Handling slow consumers without blocking fast producers

**Fan-out**: One message sent to multiple recipients (broadcast pattern)

**At-most-once delivery**: Message may be lost but never duplicated

**Graceful degradation**: System continues working with reduced capability under stress

---

## Red Flags to Avoid

### Don't Say:
- ❌ "I just followed the design doc" (show ownership)
- ❌ "The team decided..." (use "I" or "We")
- ❌ "I don't know much about identity security" (show you've studied)
- ❌ "SSE was easy to build" (downplay complexity)
- ❌ "I only worked on the backend" (show full-stack understanding)

### Do Say:
- ✅ "I designed the architecture..."
- ✅ "I chose channels over mutexes because..."
- ✅ "I've been studying identity security concepts like PAM, IGA..."
- ✅ "The challenges included scaling, RBAC, graceful shutdown..."
- ✅ "I collaborated with frontend team on event integration..."

---

## Pre-Interview Checklist

**30 Minutes Before:**
- [ ] Review this cheat sheet
- [ ] Practice 30-second elevator pitch
- [ ] Prepare 3 questions to ask them
- [ ] Have water nearby
- [ ] Close unnecessary tabs/apps

**Key Points to Hit:**
1. SSE real-time architecture → identity monitoring
2. RBAC per-event → identity-aware visibility
3. Event Bus distributed coordination → identity correlation
4. Scaling analysis → enterprise identity discovery
5. Passion for security + hard technical problems

---

## If You Get Stuck

### Bridging Template
"That's a great question. In my SSE work, I faced a similar challenge with [X]. The way I approached it was [Y]. I imagine in Hydden's context, the same pattern would apply because [Z]."

### Honesty Template
"I haven't directly worked on [X], but I've solved similar problems in [Y context]. My approach would be [Z]. Is that the right direction?"

### Curiosity Template
"That's an interesting problem. How does Hydden currently handle [X]? I'm curious about your approach."

---

## Remember

1. **You're qualified** - Your SSE work is directly relevant
2. **Be specific** - Use numbers, technical details, concrete examples
3. **Show growth mindset** - "I'm studying identity security concepts..."
4. **Ask questions** - Show genuine curiosity about their challenges
5. **Be yourself** - They're hiring a person, not just skills

**Good luck!** 🚀
