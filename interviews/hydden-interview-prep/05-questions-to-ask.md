# Questions to Ask Hydden

## Introduction

Asking thoughtful questions shows:
- You've done your research
- You're thinking critically about the role and company
- You're evaluating them (not just being evaluated)
- You understand their technical challenges

**Guideline**: Prepare 3-5 questions per category, ask 2-3 during the interview based on who you're talking to.

---

## Product & Technology Questions

### Discovery Engine & Architecture

**Q1: "How does Hydden's discovery engine handle legacy systems that don't expose APIs?"**

*Why ask this*: Shows you understand the technical challenge. Legacy systems are explicitly mentioned in their pitch.

*What you're listening for*:
- Do they use log parsing, database queries, or installed agents?
- How do they handle systems that are completely closed?
- Innovation in their approach vs competitors

---

**Q2: "For identity correlation across systems - if John Doe exists as john.doe@company.com in Azure AD, jdoe in Active Directory, and JDOE on a mainframe - what's your approach to mapping these as the same person?"**

*Why ask this*: Core technical problem. Shows you've thought about the hard parts.

*What you're listening for*:
- Automated correlation (email matching, employee ID)
- Machine learning approaches
- Manual mapping capabilities for edge cases
- How they handle confidence scores

---

**Q3: "You mentioned discovering 70,000 users across multiple Active Directories multiple times per day. How do you prevent overwhelming the AD controllers with discovery queries?"**

*Why ask this*: Shows you think about production impact and operational constraints.

*What you're listening for*:
- Rate limiting strategies
- Incremental discovery (delta detection)
- Read-only queries, efficient LDAP filters
- Operational awareness

---

**Q4: "How does Hydden's data model preserve historical state for forensic analysis? Is it event-sourced, snapshot-based, or something else?"**

*Why ask this*: Historical state is a key differentiator they mentioned.

*What you're listening for*:
- Technical approach (time-series DB, immutable logs, snapshots)
- Retention policies (how far back can you query?)
- Query performance for historical analysis

---

**Q5: "What's the architecture for real-time anomaly detection on identity behavior? How quickly can Hydden detect and alert on privilege escalation?"**

*Why ask this*: Bridges your SSE real-time expertise to their monitoring needs.

*What you're listening for*:
- Real-time vs batch processing
- Latency targets (seconds? minutes?)
- ML models or rule-based detection

---

### Integration & Deployment

**Q6: "You advertise 15-minute deployment. What does that deployment look like? Is it an agent install, a SaaS API integration, or hybrid?"**

*Why ask this*: Deployment speed is a key differentiator. Understand the reality.

*What you're listening for*:
- Actual deployment process
- What the 15 minutes includes (or doesn't include)
- Infrastructure requirements (cloud, on-prem, hybrid)

---

**Q7: "How does Hydden integrate with existing PAM and IGA tools? Is it read-only, bidirectional, or does it provide remediation capabilities?"**

*Why ask this*: "Connective tissue" positioning - understand the integration depth.

*What you're listening for*:
- API integrations with major vendors
- Read-only discovery vs active remediation
- Workflow integration (ticketing, approvals)

---

### Scaling & Performance

**Q8: "What's the largest customer deployment you've handled? How many identities across how many systems?"**

*Why ask this*: Understand the scale they operate at currently.

*What you're listening for*:
- Customer scale examples
- Technical limits encountered
- Future scaling challenges

---

**Q9: "For the identity graph - how do you efficiently query attack paths? If I ask 'Can Identity A reach Resource B?', what's the query performance?"**

*Why ask this*: Graph queries can be expensive. Shows you think about performance.

*What you're listening for*:
- Graph database technology (Neo4j, custom, etc.)
- Query optimization strategies
- Real-time vs pre-computed paths

---

## Engineering Culture Questions

### Tech Stack & Development

**Q10: "What's the tech stack beyond what's publicly mentioned? I saw Golang mentioned - is that the primary backend language?"**

*Why ask this*: Understand what you'll be working with.

*What you're listening for*:
- Backend languages (Golang, Python, Java?)
- Frontend frameworks (React, Vue?)
- Databases (PostgreSQL, Neo4j, time-series?)
- Infrastructure (Kubernetes, AWS, GCP?)

---

**Q11: "How does the team balance security/compliance requirements with rapid iteration? Are there processes that slow you down?"**

*Why ask this*: Security products face unique constraints.

*What you're listening for*:
- Development velocity vs security reviews
- Compliance certifications (SOC 2, ISO 27001)
- Release cadence

---

**Q12: "How do you test identity discovery at scale without access to production customer environments?"**

*Why ask this*: Shows you think about testing challenges.

*What you're listening for*:
- Test environments (synthetic data, customer test envs)
- Chaos engineering / fault injection
- Scale testing strategies

---

**Q13: "What does the on-call rotation look like for a product handling identity security? How do you handle severity-1 incidents?"**

*Why ask this*: Understand operational burden and expectations.

*What you're listening for*:
- On-call frequency and compensation
- Incident response processes
- Work-life balance considerations

---

### Team Structure & Collaboration

**Q14: "How is the engineering team organized? Are there separate teams for discovery, correlation, anomaly detection, and frontend?"**

*Why ask this*: Understand team structure and your likely scope.

*What you're listening for*:
- Team size and structure
- Cross-functional teams vs specialized teams
- Who you'll be working with most closely

---

**Q15: "How do backend engineers collaborate with security researchers and identity experts? Is there a dedicated research team?"**

*Why ask this*: Identity security requires domain expertise + engineering.

*What you're listening for*:
- Cross-functional collaboration
- Access to security/identity expertise
- Learning opportunities

---

**Q16: "What's the code review process like? How do you ensure security best practices in code?"**

*Why ask this*: Shows you care about code quality and security.

*What you're listening for*:
- PR review process
- Security scanning tools
- Knowledge sharing practices

---

## Role-Specific Questions

### First 90 Days

**Q17: "What would my first 90 days look like? What would be my initial project or area of focus?"**

*Why ask this*: Understand onboarding and early expectations.

*What you're listening for*:
- Onboarding process
- Early projects (starter vs critical path)
- Mentorship and ramp-up support

---

**Q18: "Are there areas where my SSE and distributed systems experience would be immediately valuable, or would I be learning entirely new domains first?"**

*Why ask this*: Understand if your experience is directly applicable or tangential.

*What you're listening for*:
- How they see your background fitting in
- Learning curve expectations
- Opportunity to contribute quickly vs longer ramp

---

### Challenges & Growth

**Q19: "What's the biggest technical challenge the team is tackling right now?"**

*Why ask this*: Shows interest in hard problems, reveals team priorities.

*What you're listening for*:
- Current pain points
- Technical debt vs new features
- Opportunity to work on challenging problems

---

**Q20: "Where do you see the biggest gaps in Hydden's current capabilities? What's on the roadmap for the next 6-12 months?"**

*Why ask this*: Understand product direction and growth areas.

*What you're listening for*:
- Product roadmap visibility
- Areas for innovation
- Long-term vision

---

**Q21: "What opportunities exist for growth and learning? Could I eventually work across different parts of the stack or specialize deeply?"**

*Why ask this*: Shows long-term thinking and growth mindset.

*What you're listening for*:
- Career development support
- Specialization vs generalization
- Learning budget, conference attendance

---

### Team Dynamics

**Q22: "What does the team enjoy most about working at Hydden? What keeps people here?"**

*Why ask this*: Understand culture and retention.

*What you're listening for*:
- Genuine enthusiasm vs canned answers
- Cultural values in practice
- Team morale

---

**Q23: "How does the team handle disagreements on technical decisions? Can you give an example?"**

*Why ask this*: Understand decision-making culture.

*What you're listening for*:
- Healthy debate vs top-down decisions
- Data-driven vs opinion-driven
- Psychological safety

---

## Customer & Market Questions

### Customer Challenges

**Q24: "What are the most common identity security gaps you see when onboarding new customers?"**

*Why ask this*: Understand the problem space from customer perspective.

*What you're listening for*:
- Real-world identity security failures
- Customer pain points
- How Hydden solves them

---

**Q25: "You mentioned SolarWinds and Colonial Pipeline incidents shaped your thinking. Are there other recent incidents that influenced Hydden's design?"**

*Why ask this*: Shows you paid attention to their founding story.

*What you're listening for*:
- How they stay current on threats
- Learning from industry incidents
- Practitioner-driven approach

---

### Market Position

**Q26: "How do you position Hydden against established players like CyberArk or SailPoint who might add similar visibility features?"**

*Why ask this*: Understand competitive landscape and defensibility.

*What you're listening for*:
- Sustainable competitive advantages
- Market strategy
- Innovation pace vs incumbents

---

**Q27: "What's the typical customer profile? Are you selling to Fortune 500 enterprises, mid-market, or both?"**

*Why ask this*: Understand customer base and scaling challenges.

*What you're listening for*:
- Customer segments
- Enterprise vs SMB focus
- Implications for product complexity

---

## Founder & Vision Questions

**Q28: "The founders come from leading identity vendors. How does that insider perspective shape what you're building differently?"**

*Why ask this*: Acknowledge their expertise, understand differentiation.

*What you're listening for*:
- Lessons learned from previous companies
- What they're deliberately doing differently
- Vision and passion

---

**Q29: "You describe identity visibility as 'connective tissue' rather than replacing existing tools. Have customers embraced this positioning or do they expect a replacement?"**

*Why ask this*: Understand product-market fit and positioning challenges.

*What you're listening for*:
- Customer expectations vs reality
- Education required
- Market maturity

---

## Practical Questions

### Work Environment

**Q30: "What's the remote work policy? Is the team distributed, hybrid, or in-office?"**

*Why ask this*: Practical work arrangement.

*What you're listening for*:
- Flexibility vs requirements
- Team distribution
- Collaboration tools and practices

---

**Q31: "What tools does the team use for collaboration? Slack, Jira, GitHub, etc.?"**

*Why ask this*: Understand daily workflow.

*What you're listening for*:
- Communication tools
- Project management approach
- Development workflow

---

### Logistics

**Q32: "What's the interview process from here? What can I expect in terms of timeline?"**

*Why ask this*: Practical planning.

*What you're listening for*:
- Interview stages remaining
- Timeline to decision
- What to prepare for next

---

**Q33: "Is there anything about my background or experience you'd like me to clarify or expand on?"**

*Why ask this*: Address any concerns directly.

*What you're listening for*:
- Unspoken concerns
- Opportunity to strengthen your case
- Areas where they need more evidence

---

## Questions to Tailor Based on Interviewer

### If Talking to Engineering Manager:
- Focus on team dynamics, growth, challenges, first 90 days

### If Talking to Founder/CTO:
- Focus on vision, market position, technical differentiation, roadmap

### If Talking to Senior Engineer:
- Focus on tech stack, architecture decisions, day-to-day work, hardest problems

### If Talking to Product:
- Focus on customer challenges, roadmap, integration with existing tools

---

## How to Ask Questions

### Good Framing:
✅ "I was really intrigued by [X] in your pitch. How does..."
✅ "In my SSE work, I faced [Y]. I'm curious how Hydden handles..."
✅ "I've been researching identity security concepts like [Z]. How does Hydden..."

### Avoid:
❌ "What does your company do?" (too basic, shows lack of research)
❌ "What's the salary?" (save for later, wrong signal now)
❌ "Will I have to be on-call?" (sounds like you're avoiding work)

### Instead Frame Practical Questions Positively:
✅ "What does the on-call rotation look like? I'm curious about how you handle incidents for a security-critical product."
✅ "How does the team think about work-life balance while maintaining a production identity security platform?"

---

## After the Interview

### Email Follow-Up Questions (if needed):
- "I've been thinking more about [X] we discussed. Could you elaborate on..."
- "I found this article on [Y] and wondered how Hydden's approach differs..."

Shows continued interest and thoughtfulness.

---

## Remember

1. **Ask 2-3 questions** per interview (don't bombard them)
2. **Listen actively** - your follow-up questions show you're engaged
3. **Take notes** - helps with later rounds and decision-making
4. **It's a conversation** - not an interrogation
5. **Show genuine curiosity** - they want someone excited about the problem

**Good luck!** 🎯
