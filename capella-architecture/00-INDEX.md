# Capella Architecture — Reading Map

Purpose: give a UI-specialist team a repeatable way to read the `couchbase-cloud`
monorepo, explain flow of control, and name the patterns. Built as a loop: one
vertical slice per iteration.

Repo under study: `couchbasecloud/couchbase-cloud`
Scale at time of writing: ~9,595 Go files, 50+ binaries under `cmd/`, ~130+
packages under `internal/`.

---

## How to use this

Read in order. `01` is the map. `02` is the first full trace. `03`/`04` are the
extracted patterns (Go, AWS). `05` is the ramp plan you hand to the team.

Every claim carries a `path:line` anchor. Open the file. Do not trust the prose.

---

## Documents

| # | Doc | What it answers |
|---|---|---|
| 01 | [Repo map](01-repo-map.md) | Where does code live, and what are the boundaries? |
| 02 | [Slice 1 — UI to cp-api](02-slice-01-ui-to-cp-api.md) | What actually happens when a React page loads a list? |
| 03 | [Go patterns](03-go-patterns.md) | Name the pattern, cite the file, state the advantage |
| 04 | [AWS concepts](04-aws-concepts.md) | How does this slice get deployed and reached? |
| 05 | [UI → fullstack ramp](05-ui-to-fullstack-ramp.md) | Teaching order, exercises, review checklist |
| 06 | [Slice 2 — cluster provisioning](06-slice-02-cluster-provisioning.md) | What happens in the 20 minutes after "Create Database"? |

---

## Loop tracker

The loop: pick a slice → trace it → name the patterns → write the doc → pick the
next slice. Each slice must produce a `path:line` trace, not a summary.

| # | Slice | Status | Why it matters |
|---|---|---|---|
| 1 | `cp-ui-v3` → `cp-api` (Projects CRUD) | **Done** — [02](02-slice-01-ui-to-cp-api.md) | The canonical request. Every other CP endpoint is a variation. |
| 2 | Cluster provisioning: `cp-api` → `cp-jobs` → AWS → `dp-agent-v3` | **Done** — [06](06-slice-02-cluster-provisioning.md) | Async orchestration: queue, reconciler, plan-then-apply, cross-account AssumeRole. Also covers the CP↔DP seam. |
| 3 | ~~CP ↔ DP seam~~ — **folded into slice 2** (Part 11) | Done | Verifier middleware, agent poll loop, convergence. Deepen later if needed. |
| 4 | `cp-open-api` (public v4) vs `cp-api` (internal v2) | **Next** | OpenAPI codegen, API versioning, Terraform provider contract. |
| 5 | Auth: Auth0/Cognito → session → JWT → RBAC resolver | Todo | The security model end-to-end. |
| 6 | Billing: metering → `cp-jobs` → Stripe | Todo | Product/revenue knowledge. Strong PM-facing context. |
| 7 | Observability: `dp-ingestor` → Prometheus/Thanos → Grafana | Todo | How SLOs are actually measured. |
| 8 | App Services / Sync Gateway | Todo | Mobile product surface. |

Rule for the loop: **do not start a new slice until the current one has a
trace a new joiner can follow without you in the room.**

Second rule, learned in slice 2: **the filesystem beats the docs.** Root
`AGENTS.md` lists a `cp-worker` binary that does not exist — the worker is
`cmd/cp-jobs`. Verify every name before quoting it.

---

## The three sentences that explain the whole product

1. **Capella is a DBaaS.** Customers ask for a Couchbase cluster; Capella builds
   and runs it in AWS/GCP/Azure for them.
2. **Control Plane (CP) is centrally hosted** (Couchbase's own EKS) and holds
   tenant metadata plus orchestration. **Data Plane (DP)** is the customer-facing
   infrastructure where Couchbase Server actually runs.
3. **They only talk through one door**: `cp-internal-api`. DP agents poll it.
   Nothing else crosses the seam.

Source: `docs/agents/architecture.md`.

---

## Domain vocabulary you must not fake

| Term | Meaning |
|---|---|
| CP / DP | Control Plane / Data Plane |
| Tenant / Organization | A Capella customer org. In code the path var is `tenantId`; the UI calls it `organizationId`. **Same thing.** |
| Project | Grouping of clusters inside a tenant. RBAC boundary. |
| Cluster / Database | A provisioned Couchbase Server deployment. UI says "Database". |
| Columnar | Couchbase analytics service |
| App Services | Sync Gateway — mobile backend |
| Goof | The structured error-code system, `internal/goof` |
| Morpher | The function that stamps a user's permissions onto a response |
| Fleet Manager (FM) | Internal support/ops tooling |
| cbclocal | Local dev orchestrator |
| CV | Commit Validation (the PR CI pipeline) |
| Resource container (RC) | A cloud account dedicated to one tenant. IAM roles are named `rc-*`. |
| Circuit breaker | Operator kill-switch stopping jobs of one type for one resource |
| Deploy reason | Why a deployment is running (`NewClusterDeployment`, `Scaling`, `Upgrading`, `TurnOff`, `TurnOn`, `NoOp`, `Rebalancing`) — it changes the plan, the timeouts, and the retry budget |
| Plan | The diff the deployer computes once and persists: `Deploy` / `Replace` / `Destroy` / `GrowDisks` |
| AV-nnnnn | Jira ticket. Appears in code comments as the reason a line exists. |

The `tenantId` vs `organizationId` split is the single most common source of
confusion for new joiners. Say it out loud on day one.

---

## Where the repo already documents itself

Read these before asking anyone:

- `AGENTS.md` (root) — routing index, universal Go rules, banned packages
- `docs/agents/architecture.md` — CP/DP model, API ports, storage, integrations
- `docs/agents/conventions.md` — code style, branch/commit/PR rules
- `docs/agents/build-test-run.md` — build, test, lint, codegen commands
- `cmd/cp-ui-v3/spec/` — frontend architecture specs (`unified-tech-stack.md`,
  `unified-standards.md`, `unified-page-patterns.md`)
- `internal/rbac/README.md` — how roles and resources are generated
- Nearest `AGENTS.md` wins. `cmd/cp-api/AGENTS.md`, `internal/auth/AGENTS.md`, etc.
