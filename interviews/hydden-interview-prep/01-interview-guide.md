# Hydden Interview Guide - Comprehensive Preparation

## Table of Contents
1. [About Hydden](#about-hydden)
2. [Identity Security Market Landscape](#identity-security-market-landscape)
3. [Your Experience → Hydden's Mission](#your-experience--hyddens-mission)
4. [Identity Security Concepts](#identity-security-concepts)
5. [Why You're a Great Fit](#why-youre-a-great-fit)

---

## About Hydden

### Core Mission
**Hydden treats identity security as a data and visibility problem, not just an access-control problem.**

### The Problem They Solve

**Current State of Identity Security:**
- Organizations focus on adding more "gates" (PAM, MFA, IAM) instead of understanding where identities live and how they behave
- Identities are scattered across cloud, on-prem, edge, IoT, and legacy systems
- Existing tools only cover fragments of the identity landscape
- Enterprises have invested heavily in PAM/IGA, but only **15-20% of capabilities are actually deployed**
- This creates critical gaps where real identity threats hide

**Why This Is Urgent Now:**
- **Attacker's perspective**: They see a graph of accounts and relationships across systems, not siloed products
- **Tool sprawl problem**: Multiple MFA, PAM, IGA tools create "identity debt" and fragmented data
- **Visibility gap**: Hard to see end-to-end attack paths or explain breaches to boards
- **Legacy systems**: Still mission-critical but never designed for cloud-first, hybrid, multicloud environments

### Hydden's Approach

**Identity Visibility as "Connective Tissue":**
- Discovers identities **everywhere** (not just cloud, not just human)
- Correlates identities across disconnected systems
- Surfaces the most important risks so security teams know exactly where to act
- Works **with** existing tools, doesn't replace them

**Technical Differentiators:**
1. **Rapid Deployment**: ~15 minutes to deploy (vs months for traditional PAM/IGA)
2. **Universal Coverage**: Connects to "anything" - hybrid/multicloud, on-prem, legacy
3. **Continuous Discovery**: Runs multiple times per day at scale (e.g., 70,000 users across many ADs)
4. **Historical State**: Data model preserves history for forensic investigations ("what accounts belonged to this person on date X?")

**Non-Human Identity Treatment:**
- Service accounts, machine identities, API keys are **first-class citizens**
- Automatically discovers and maps them back to human owners
- Models behavior to detect anomalies
- Reduces time to respond or neutralize threats

### Strategic Position

**Founder Background:**
- Come from leading identity vendors
- Witnessed major incidents firsthand (SolarWinds, Colonial Pipeline)
- Practitioner-driven design based on real-world failures

**Market Viewpoint:**
- Industry must move away from purely compliance-driven IGA
- Focus on comprehensive visibility of "every identity everywhere"
- Without this, organizations remain "sitting ducks"
- Breaking down silos across identity tools and infrastructures

**North Star:**
- Give SecOps fine-grained, forensic insight across the entire identity attack surface
- Not just generating more alerts - providing actionable intelligence

---

## Identity Security Market Landscape

### The Identity Security Stack

```
┌─────────────────────────────────────────────────────────┐
│  TRADITIONAL APPROACH (Siloed)                          │
├─────────────────────────────────────────────────────────┤
│  IAM Layer    │ Authentication + Basic Authorization    │
│  PAM Layer    │ Privileged Access Management (Admins)   │
│  IGA Layer    │ Governance, Compliance, Reviews         │
│  CIEM Layer   │ Cloud Entitlements (AWS, Azure, GCP)    │
└─────────────────────────────────────────────────────────┘
                         ⬇
                  HYDDEN'S APPROACH
                         ⬇
┌─────────────────────────────────────────────────────────┐
│  IDENTITY VISIBILITY AS CONNECTIVE TISSUE               │
├─────────────────────────────────────────────────────────┤
│  • Discovers ALL identities across ALL systems          │
│  • Correlates across silos (human + non-human)          │
│  • Maps attack paths through identity graph             │
│  • Continuous monitoring + historical forensics         │
│  • Works WITH existing IAM/PAM/IGA tools                │
└─────────────────────────────────────────────────────────┘
```

### Key Concepts Explained

#### IAM (Identity & Access Management)
**What**: Foundation layer for "who you are" and "what you can do"
- **Authentication**: Verifying identity (passwords, MFA, SSO)
- **Authorization**: Granting permissions based on identity
- **Examples**: Okta, Azure AD, Auth0
- **Limitation**: Focuses on authentication flow, limited visibility into actual access patterns

#### PAM (Privileged Access Management)
**What**: Securing high-privilege accounts and access
- **Focus**: Admin accounts, root access, service accounts with elevated permissions
- **Functions**: Password vaulting, session recording, just-in-time access
- **Examples**: CyberArk, BeyondTrust, Delinea
- **Limitation**: Only covers ~5% of identities (the privileged ones), misses 95% of attack surface

#### IGA (Identity Governance & Administration)
**What**: Compliance-focused access management
- **Focus**: Who has what access, why, and is it appropriate?
- **Functions**: Access certifications, reviews, joiner/mover/leaver workflows
- **Examples**: SailPoint, Saviynt, Oracle Identity Governance
- **Limitation**: Often deployed for compliance checkboxes, **80-85% of capabilities unused** (Hydden's key insight)

#### CIEM (Cloud Infrastructure Entitlement Management)
**What**: Managing permissions in cloud environments
- **Focus**: AWS IAM roles, Azure AD, GCP permissions, multi-cloud entitlements
- **Functions**: Permission discovery, least privilege enforcement, policy violations
- **Examples**: Wiz, Orca, Ermetic
- **Limitation**: Cloud-only, doesn't cover on-prem or legacy systems

### The Identity Visibility Gap (Hydden's Sweet Spot)

**What Traditional Tools Miss:**
1. **Non-human identities**: Service accounts, API keys, OAuth tokens, machine identities
2. **Legacy systems**: Mainframes, custom databases, industrial control systems
3. **Shadow IT**: SaaS apps and cloud resources outside IT control
4. **Cross-system relationships**: Identity correlations across disconnected systems
5. **Attack path visibility**: How attackers can hop from Account A → Resource B
6. **Historical forensics**: "Who had access to what on April 15th?" (breach investigation)

**Hydden's Value Add:**
- **Comprehensive discovery**: Finds identities traditional tools miss
- **Relationship mapping**: Understands identity graphs and privilege chains
- **Continuous monitoring**: Multiple scans per day (not quarterly reviews)
- **Works with existing investments**: Doesn't replace PAM/IGA, enhances them
- **Rapid deployment**: 15 minutes vs 6-12 months

---

## Your Experience → Hydden's Mission

### Direct Technical Parallels

#### 1. Real-Time Event Architecture → Continuous Identity Monitoring

**Your SSE Work:**
- Replaced polling (3600 requests/hour) with real-time push
- Eliminated empty requests, provided near-instant updates
- Built for continuous operation, not periodic checks

**Hydden Connection:**
- Identity discovery runs **multiple times per day** (not quarterly scans)
- Continuous monitoring of identity behavior and changes
- Real-time detection of privilege escalations or anomalous access
- Same philosophy: push-based visibility instead of pull-based polling

**Interview Talking Point:**
> "In my SSE work, I moved from periodic polling to continuous real-time updates. This same shift is what Hydden does for identity security - instead of quarterly access reviews or periodic scans, you're continuously discovering and monitoring identities across all systems. My experience designing systems that efficiently handle constant state changes directly applies to identity behavior monitoring."

#### 2. RBAC-Aware Event Broadcasting → Identity-Aware Access Decisions

**Your SSE Work:**
- Per-event RBAC checks at broadcast time (not connection time)
- Events filtered based on user's resource-level permissions
- Dynamic permission changes handled gracefully (self-correcting on next event)
- Zero permission leakage across tenant boundaries

**Hydden Connection:**
- Understanding who has access to what resources
- Resource-level visibility and authorization
- Dynamic permission state (permissions change, Hydden detects it)
- Identity-aware event routing (similar to your RBAC-filtered delivery)

**Interview Talking Point:**
> "I implemented RBAC-aware event broadcasting where we check permissions per-event, not per-connection. This means if a user's permissions change while their connection is active, the system self-corrects on the next event. This runtime authorization model is exactly what identity security requires - you need to continuously evaluate who can access what, not just check permissions once and cache the result."

#### 3. Event Bus Architecture → Cross-System Identity Correlation

**Your SSE Work:**
- NATS-based Event Bus for distributing events across multiple API instances
- Every instance receives every event (fan-out pattern)
- No sticky sessions required - user tabs can connect to different instances
- Distributed system coordination at scale

**Hydden Connection:**
- Identities scattered across disconnected systems (AD, AWS, Azure, legacy DBs)
- Need to correlate "john.doe@company.com" across 20+ identity sources
- Events from any system must propagate to unified identity view
- Distributed discovery agents feeding centralized correlation engine

**Interview Talking Point:**
> "I built a distributed Event Bus using NATS that fans out events to all API instances simultaneously. This solves the same problem Hydden faces - identities exist in multiple disconnected systems, and changes in one place need to be correlated with the unified identity view. My experience with distributed event propagation and system-to-system communication directly maps to identity correlation challenges."

#### 4. Scaling to 10K Connections → Identity Discovery at Enterprise Scale

**Your SSE Work:**
- Detailed memory calculations: ~5.5KB per connection (goroutine + map overhead)
- 10,000 connections = ~55MB RAM
- Per-user connection limits + backpressure handling
- Non-blocking delivery (slow clients don't block fast producers)

**Hydden Connection:**
- Discovering 70,000 users across multiple Active Directories
- Multiple discovery cycles per day at enterprise scale
- Managing state for hundreds of thousands of identities
- Handling slow/unresponsive identity sources without blocking others

**Interview Talking Point:**
> "I designed the SSE system with detailed scaling analysis - calculating memory per connection, planning for 10K concurrent users, implementing backpressure so slow clients don't block fast producers. Hydden faces similar scaling challenges: discovering 70K users multiple times per day, handling slow legacy systems, managing state for hundreds of thousands of identities. My approach to capacity planning and graceful degradation directly applies."

#### 5. Multi-Tenant Isolation → Identity Segmentation

**Your SSE Work:**
- Org-scoped SSE endpoints (`/v2/organizations/{orgId}/sse/stream`)
- TenantID-based event filtering
- Zero cross-tenant data leakage
- Connection lifecycle tied to tenant context

**Hydden Connection:**
- Different organizations, projects, teams have different identity scopes
- Users should only see identities they're authorized to see
- Multi-tenant SaaS platform serving multiple customers
- Identity data segmentation and isolation requirements

**Interview Talking Point:**
> "I implemented strict multi-tenant isolation where each SSE connection is scoped to a specific organization, with tenant-based event filtering in the broker. Hydden needs similar isolation - different customers, different identity scopes, strict data boundaries. My experience building secure multi-tenant architectures with zero data leakage directly applies to identity segmentation challenges."

#### 6. Historical State Tracking → Forensic Identity Analysis

**Your SSE Work:**
- Architecture preserves historical state
- Can answer: "What accounts belonged to this user on a specific date?"
- Forensic capability for breach investigations
- Time-series data model

**Hydden Connection:**
- Key differentiator: "What access did John have on April 15th when the breach occurred?"
- Identity state changes over time (promotions, role changes, departures)
- Compliance audits require historical access records
- Forensic investigations need point-in-time snapshots

**Interview Talking Point:**
> "Our SSE design preserves historical state, enabling forensic queries like 'what permissions did this user have on a specific past date?' This is explicitly mentioned in Hydden's value proposition - the ability to answer identity questions historically for breach investigations. My experience designing systems with time-series state tracking directly supports this capability."

### Golang Expertise Applied to Identity Discovery

#### Concurrency Patterns
**Your Experience:**
- Goroutines for concurrent connection handling
- Channels for event propagation (not mutexes)
- "Share memory by communicating" philosophy

**Hydden Application:**
- Concurrent scanning of 20+ identity sources
- Parallel discovery across different systems
- Aggregating results from distributed discovery agents

#### Memory Management
**Your Experience:**
- Calculated overhead per connection
- Planned for resource limits
- Implemented connection caps and backpressure

**Hydden Application:**
- Managing state for hundreds of thousands of identities
- Efficient graph data structures for identity relationships
- Resource planning for continuous discovery at scale

#### Graceful Shutdown
**Your Experience:**
- Listen for K8s SIGTERM
- Proactively sever SSE connections
- Clean shutdown without blocking deployments

**Hydden Application:**
- Discovery agents that can be safely restarted
- In-progress scans that fail gracefully
- Zero-downtime deployments for identity platform

---

## Identity Security Concepts

### The Identity Attack Surface

```
HUMAN IDENTITIES
├── Employees (full-time, contractors)
├── Partners & Vendors (external access)
├── Former employees (should be deprovisioned)
└── Service accounts owned by humans

NON-HUMAN IDENTITIES (Often Forgotten)
├── Service Accounts (app-to-app, service-to-service)
├── API Keys & Tokens (OAuth, JWT, static keys)
├── Machine Identities (certificates, SSH keys)
├── Cloud IAM Roles (AWS roles, Azure managed identities)
└── IoT Device Credentials

LEGACY & SHADOW
├── Mainframe accounts
├── Custom database users
├── Industrial control systems
└── SaaS apps outside IT control
```

### Common Identity Security Gaps

1. **Non-Human Identity Sprawl**
   - Service accounts often outlive their purpose
   - API keys shared across teams, never rotated
   - No clear ownership: "Whose service account is this?"

2. **Privilege Creep**
   - Users accumulate permissions over time
   - Promoted to new role, old permissions never removed
   - "Just in case" permissions that violate least privilege

3. **Orphaned Accounts**
   - Former employees still in some systems
   - Contractors' access not revoked after project ends
   - No centralized offboarding across all systems

4. **Cross-System Visibility Gap**
   - User has limited access in AD but admin in AWS
   - No unified view of total privilege across systems
   - Attack paths through identity hopping

5. **Legacy System Blindness**
   - Mainframes, custom DBs excluded from IAM/PAM
   - "Too hard to integrate" systems create security gaps
   - Often the most critical (and vulnerable) systems

### Identity Attack Patterns (What Hydden Detects)

#### Privilege Escalation
**Attack**: Gain higher privileges than intended
- Exploiting misconfigured permissions
- Leveraging service accounts with excessive rights
- Finding "privilege chains" (Role A can assume Role B, which can...)

**Hydden Detection**: Maps privilege relationships, alerts on unusual permission changes

#### Lateral Movement
**Attack**: Move from initial compromised account to other systems
- Using stolen credentials to access connected systems
- Leveraging trust relationships between accounts/systems
- Hopping through service accounts

**Hydden Detection**: Identity graph shows all possible paths, detects unusual access patterns

#### Persistence
**Attack**: Maintain access even after initial entry point is closed
- Creating hidden service accounts
- Generating long-lived API keys
- Backdoor accounts in overlooked systems

**Hydden Detection**: Comprehensive discovery finds all accounts, including hidden ones

### Why Traditional Tools Fall Short

**PAM Limitation**: Only covers ~5% of identities (privileged accounts)
- Misses 95% of attack surface (regular users, service accounts)
- Deployed for compliance, not comprehensive coverage
- Doesn't see relationships between identities

**IGA Limitation**: 80-85% of capabilities unused (per Hydden)
- Deployed for audit compliance, not active monitoring
- Quarterly reviews (too infrequent for modern threats)
- Complex, heavyweight, takes months to deploy

**CIEM Limitation**: Cloud-only
- Doesn't see on-prem identities
- Misses legacy systems entirely
- No correlation with traditional AD/LDAP

**The Gap**: No one tool sees **every identity everywhere** with their relationships and behaviors.

**Hydden's Answer**: Be the connective tissue that discovers all identities and surfaces the most critical risks.

---

## Why You're a Great Fit

### Technical Skills Alignment

| Requirement | Your Experience | Evidence |
|-------------|-----------------|----------|
| **Golang Expertise** | Production Golang at Couchbase | SSE implementation, concurrency patterns, channels |
| **Distributed Systems** | Event Bus with NATS | Multi-instance coordination, fan-out patterns |
| **Real-Time Architecture** | SSE replacing polling | Long-lived connections, instant updates, heartbeat |
| **Authorization/RBAC** | Per-event permission checks | Resource-level access, dynamic permission handling |
| **Scaling Mindset** | 10K connection capacity planning | Memory calculations, backpressure, graceful degradation |
| **Security-First** | Multi-tenant isolation, audit logging | Zero data leakage, forensic capabilities |

### Domain Knowledge

**You Already Understand:**
- Identity and access challenges (RBAC implementation)
- Real-time monitoring vs periodic polling (SSE vs old system)
- Discovery and visibility problems (finding all connected clients)
- Scale challenges (70K users ≈ your 10K connections challenge)
- Distributed system coordination (Event Bus ≈ identity correlation)

### Problem-Solving Approach

**Your SSE Project Shows:**
1. **Systems thinking**: Replaced point solution (polling) with architectural change (real-time push)
2. **Pragmatic design**: Used NATS instead of building custom message bus
3. **Operational awareness**: Graceful shutdown, heartbeat monitoring, fallback strategies
4. **Security mindset**: RBAC per-event, tenant isolation, audit logging
5. **Performance focus**: Memory calculations, backpressure handling, connection limits

**Hydden Needs**: Same systems-thinking approach to identity security

### Cultural Fit

**Founder Background**: From leading identity vendors, seen major breaches
**Your Background**: From database company, seen production systems at scale

**Shared Values:**
- Practitioner-driven (you've lived the polling pain, they've lived identity breaches)
- Focus on real-world impact (not just compliance checkboxes)
- Technical depth (15-min deployment requires solid engineering)
- Solve hard problems (identity visibility ≈ your real-time push architecture)

---

## Key Preparation Points

### What They'll Look For

1. **Can you build production Golang systems?**
   - Yes: SSE broker, Event Bus, 10K connections
   
2. **Do you understand distributed systems?**
   - Yes: Multi-instance coordination, NATS, graceful degradation
   
3. **Can you think about security and authorization?**
   - Yes: RBAC implementation, tenant isolation, permission checks
   
4. **Do you have a scaling mindset?**
   - Yes: Memory calculations, capacity planning, backpressure
   
5. **Do you understand the identity domain?**
   - Getting there: RBAC experience, studying IAM/PAM/IGA concepts

### Your Core Message

> "I've built real-time distributed systems in Golang that handle authorization at scale. My SSE architecture maps directly to identity monitoring challenges: continuous discovery instead of polling, per-event permission checks instead of static authorization, distributed coordination for multi-system visibility. I'm excited to apply my systems expertise to solving identity security - a domain I've touched through RBAC work and am eager to go deeper on."

### Questions to Expect

**"Tell me about your SSE project."**
→ Use Story 1 from 03-experience-stories.md

**"How does this relate to identity security?"**
→ "Real-time identity monitoring has the same challenges: continuous state changes, authorization per-event, distributed sources, scaling to enterprise size. The patterns I used - event streaming, RBAC filtering, distributed coordination - directly apply to discovering and monitoring identities across hybrid environments."

**"What do you know about identity security?"**
→ Walk through IAM/PAM/IGA concepts, then Hydden's differentiator (comprehensive visibility as connective tissue)

**"Why Hydden?"**
→ "I'm drawn to hard technical problems with real-world impact. Identity security is critical infrastructure, and Hydden's approach - comprehensive visibility instead of more gates - resonates with my experience replacing inefficient polling with systematic real-time push. The technical challenges of discovering identities everywhere, at scale, in 15 minutes deployment time - that's exactly the kind of problem I want to solve."

---

## Next Steps

1. Review [02-technical-qa.md](./02-technical-qa.md) for specific technical questions
2. Practice stories from [03-experience-stories.md](./03-experience-stories.md)
3. Memorize key facts from [04-cheat-sheet.md](./04-cheat-sheet.md)
4. Prepare questions from [05-questions-to-ask.md](./05-questions-to-ask.md)
5. Work through system design scenarios in [06-system-design-scenarios.md](./06-system-design-scenarios.md)

**You've got this!** Your technical background is a strong match, and your SSE experience provides concrete examples of solving similar problems at scale.
