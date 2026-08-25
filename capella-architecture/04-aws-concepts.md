# 04 — AWS & Infra Concepts in Slice 1

Scope: everything between a customer's browser and the Couchbase document that
holds their project — the control plane's own deployment.

**The data-plane/provisioning AWS surface is in
[doc 06, "New AWS concepts introduced in this slice"](06-slice-02-cluster-provisioning.md#new-aws-concepts-introduced-in-this-slice):**
cross-account STS `AssumeRole`, one-ASG-per-node, SQS FIFO message groups and
visibility timeouts, service quotas, EC2 IMDS, launch templates, EBS grow-only,
instance-store LVM caching, KMS/BYOK, VPC peering and private endpoints.

Every claim is anchored to Terraform or a deploy script.

---

## The picture

```
                                browser
                                   |
                      TLS (ACM cert, validated by DNS)
                                   |
        +--------------------------+---------------------------+
        |                                                      |
   static assets                                          API calls
        |                                                      |
   Route53 A ALIAS                                        Route53 -> cp-api domain
        |                                                      |
   CloudFront distribution                                     |
     - cache policy (ttl 0/3600/86400, brotli+gzip)            |
     - Lambda@Edge x3 (see below)                              |
        |                                                      |
   S3 bucket (PRIVATE, reached only via OAI)              nginx Ingress Controller
     - SSE enabled                                          - TLS via cert-manager
     - public access fully blocked                          - CORS, timeouts, body size
                                                            - backend-protocol HTTPS
                                                                   |
                                                            k8s Service cp-api :443
                                                                   |
                                                            Deployment cp-api (EKS)
                                                              - ConfigMap: env vars
                                                              - Secret: from Secrets Manager
                                                              - ServiceAccount (IRSA)
                                                              - PodDisruptionBudget
                                                                   |
                                              +--------------------+--------------------+
                                              |                    |                    |
                                       Couchbase Server      Secrets Manager      AWS SDK clients
                                       (CP metadata)         (creds at boot)      (S3/KMS/SQS/STS/
                                                                                  Athena/Bedrock/ACM-PCA)
```

---

## 1. The UI is static assets on S3 + CloudFront — not a server

`terraform/modules/elixir-ui-cdn/`

### S3 (`s3.tf`)

```hcl
resource "aws_s3_bucket" "ui" { bucket = var.bucket_name }
resource "aws_s3_bucket_website_configuration" "ui" { ... }
resource "aws_s3_bucket_server_side_encryption_configuration" "ui" { ... }
resource "aws_s3_bucket_public_access_block" "ui" {
  block_public_policy     = true
  restrict_public_buckets = true
}
data "aws_iam_policy_document" "ui" { ... resources = ["${aws_s3_bucket.ui.arn}/*"] ... }
resource "aws_s3_bucket_policy" "ui" { policy = data.aws_iam_policy_document.ui.json }
```

**Concept: the bucket is private.** Public access is fully blocked. The only
principal allowed to read is the CloudFront **Origin Access Identity**:

```hcl
resource "aws_cloudfront_origin_access_identity" "default" {}   # cloudfront.tf:1
...
s3_origin_config { origin_access_identity = aws_cloudfront_origin_access_identity.default.cloudfront_access_identity_path }
```

**Why it matters:** a public S3 website bucket bypasses CloudFront entirely — no
WAF, no edge logic, no cache, and no way to enforce HTTPS. Private bucket + OAI
means CloudFront is the *only* front door. This is the single most common S3
misconfiguration in the industry; here it is done correctly and you can read why.

Note the second, narrower statement scoped to `${bucket}/manifests/*` — Module
Federation remote manifests are exposed separately from the app bundle.

### CloudFront (`cloudfront.tf`)

```hcl
resource "aws_cloudfront_cache_policy" "ui" {
  default_ttl = 3600     # 1 hour
  max_ttl     = 86400    # 1 day
  min_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config       { cookie_behavior       = "none" }
    headers_config       { header_behavior       = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}
```

**Concept: cache key design.** Cookies, headers, and query strings are all
excluded from the cache key. That maximises the hit rate — every viewer shares
one cached object. It is only safe because the assets are **impersonal**: the
bundle is identical for everyone, and all personalisation happens client-side
after the JWT is read from storage.

Get this wrong in either direction and you have a real incident: include too
little and you serve one user's data to another; include too much and your hit
rate collapses.

```hcl
default_root_object    = "index.html"
compress               = true
viewer_protocol_policy = "redirect-to-https"
allowed_methods = ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"]
cached_methods  = ["GET","HEAD"]
```

Only GET/HEAD are cached; the rest pass through.

### Lambda@Edge — three functions, three trigger points

`cloudfront.tf:49-67`, `lambda.tf`, `templates/*.js`. All `nodejs18.x`.

| Function | Event | Job |
|---|---|---|
| `password_wall` | `viewer-request` | Gate non-prod environments. Conditional: `for_each = var.password_wall_enabled ? [...] : []` |
| `v3_router` | `origin-request` | SPA fallback rewrite |
| `security_headers` | `origin-response` | Inject security headers, `include_body = false` |

**Understand the four CloudFront trigger points** — this is core CDN knowledge:

```
viewer-request  -> [cache lookup] -> origin-request  -> ORIGIN
viewer-response <- [cache store ] <- origin-response <-
```

`viewer-request` runs on **every** request, cache hit or miss. `origin-request`
runs only on a **cache miss**. So:

- The password wall must be `viewer-request` — it has to gate cached responses too.
- The router rewrite is `origin-request` — the result is cacheable, so run it once.
- Security headers are `origin-response` — added once and cached with the object.

Putting the router on `viewer-request` would still work but would burn a Lambda
invocation on every cache hit. That placement decision is the lesson.

`templates/v3-router-lambda.js`, in full:

```js
const { request } = event.Records[0].cf;
const parsedPath = path.parse(request.uri);
if (parsedPath.ext === '') {
  request.uri = request.uri.replace(/^\/v3(\/.*)?$/, "/v3/index.html");
}
callback(null, request);
```

**Concept: SPA fallback at the edge.** `/v3/project/databases` is a client-side
route — no such S3 key exists. "No file extension" ⇒ rewrite to
`/v3/index.html`; React Router then reads `window.location`. The extension check
is what stops `/v3/main.a1b2c3.js` being rewritten.

This is also the server-side half of the Module Federation split: the `/v3`
prefix here pairs with `basename: process.env.V3_ONLY ? '/' : '/v3'` in
`cmd/cp-ui-v3/src/main.tsx`.

### Ordered cache behaviour — the domain-verification carve-out

```hcl
ordered_cache_behavior {
  path_pattern           = "/.well-known/microsoft-identity-association.json"
  viewer_protocol_policy = "https-only"
}
```

The comment states the reason: this path must stay reachable **even behind the
password wall**, because that is how Azure verifies domain ownership.

**Concept:** `ordered_cache_behavior` blocks are evaluated in order before
`default_cache_behavior`. Path-pattern precedence is how you exempt one route
from global edge logic. Real-world detail you will not find in a tutorial.

### ACM + Route53 — DNS-validated TLS

`acm.tf`
```hcl
resource "aws_acm_certificate" "cert" {
  domain_name       = var.domain_root
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_acm_certificate_validation" "cert" {
  validation_record_fqdns = [for record in aws_route53_record.cert : record.fqdn]
}
```

`route53.tf`
```hcl
resource "aws_route53_record" "ui" {
  type = "A"
  alias {
    name    = aws_cloudfront_distribution.ui.domain_name
    zone_id = aws_cloudfront_distribution.ui.hosted_zone_id
  }
}
resource "aws_route53_record" "cert" { for_each = { for dvo in aws_acm_certificate.cert.domain_validation_options : ... } }
```

Three concepts in ten lines:

1. **DNS validation, not email.** ACM emits `domain_validation_options`; Terraform
   writes them as Route53 records; `aws_acm_certificate_validation` blocks until
   ACM sees them. Fully automated issuance *and* renewal.
2. **A-record ALIAS, not CNAME.** ALIAS works at a zone apex (`CNAME` cannot) and
   costs nothing to resolve. AWS-specific, and a common interview question.
3. **`create_before_destroy`.** A cert rotation must not leave a window with no
   valid cert. Terraform's default is destroy-then-create; that would cause an
   outage.

### Deploy pipeline

`cmd/cp-ui-v3/deploy/deploy-cdn.sh`

```bash
for v in CF_DISTRIBUTION BUCKET_NAME API_URL CONTROL_PLANE_ENV ...; do
  [ -z "$val" ] && { echo "ERROR: ${v} variable is missing." >&2; exit 1; }
done

AWS_ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text)
CONTAINER_REGISTRY="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${CONTAINER_REGISTRY}/avengers/cp-ui-v3:${IMAGE_TAG}"

aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${CONTAINER_REGISTRY}"
docker pull "${IMAGE}"
docker run --detach --name "cp-ui-v3-${IMAGE_TAG}" --env "CP_API_URL=https://${API_URL}" ... "${IMAGE}"
# then copy built assets out of the container and sync to S3, invalidate CF
```

Five practices worth naming:

1. **Fail fast on missing config**, with the variable name in the error. Not a
   nil-pointer three minutes into a deploy.
2. **`sts get-caller-identity`** to discover the account id — the script is
   account-agnostic and therefore identical in dev/stage/prod.
3. **The artefact is a container image, built once.** The same image is run in
   each environment; only env vars differ. `IMAGE_TAG` defaults to
   `git rev-parse --short=8 HEAD`, matching the ECR tagging convention.
   *Build once, deploy many* — the image is the unit of promotion.
4. **`trap cleanup EXIT INT TERM`** removes the container and temp dir on any
   exit path, including Ctrl-C.
5. **Exit-code + readiness check** after `docker run --detach`, printing
   `docker logs` on failure. Detached mode hides startup errors; this recovers
   them.

Env vars injected at deploy time, not build time: `CP_API_URL`,
`CONTROL_PLANE_ENV`, `DATADOG_CLIENT_ID`, `GITHUB_CLIENT_ID`,
`GOOGLE_CLIENT_ID`, `STRIPE_PUBLIC_KEY`, `AZURE_CLIENTS_ID`, `GTM_ID`,
`LD_CLIENT_ID`, `RELEASE`. All **public** identifiers — no secrets in a browser
bundle, which is why this is safe.

---

## 2. `cp-api` runs on EKS behind an nginx Ingress

`terraform/modules/api/` — resources listed in its generated `README.md`
(terraform-docs, config at `.terraform-docs.yaml`).

Kubernetes resources: `kubernetes_deployment.cp_api`, `kubernetes_service.cp_api`,
`kubernetes_ingress_v1.cp_api`, `kubernetes_ingress_v1.cp_api_internal`,
`kubernetes_config_map.cp_api_env_vars`, `kubernetes_config_map.cp_api_indexes`,
`kubernetes_config_map.cp_api_auditevent_indexes`,
`kubernetes_secret.cp_api_secrets_auth`, `kubernetes_service_account.cp_api`,
`kubernetes_pod_disruption_budget_v1.cp_api_pdb`,
`kubernetes_cluster_role.prometheus` + binding.

Note: the module uses the `kubernetes` provider directly (2.25.2), not Helm, for
`cp-api`. `helm/charts` exists for other components.

### Public ingress (`service.tf:23`)

```hcl
annotations = {
  "kubernetes.io/ingress.class"                           = "nginx"
  "nginx.ingress.kubernetes.io/proxy-next-upstream-tries" = "1"
  "nginx.ingress.kubernetes.io/proxy-read-timeout"        = "1800"
  "nginx.ingress.kubernetes.io/proxy-body-size"           = "10m"
  "nginx.ingress.kubernetes.io/backend-protocol"          = "HTTPS"
  "cert-manager.io/cluster-issuer"                        = local.env_set[var.env_opt].ingress_cert_issuer_val
  "nginx.ingress.kubernetes.io/server-snippet"            = file("${path.module}/nginx-server-snippet.conf")
  "nginx.ingress.kubernetes.io/configuration-snippet"     = templatefile(..., { CORS_LOCALHOST_STATUS = "enabled", CP_UI_DOMAIN = ... })
}
spec { tls { secret_name = "cp-api-tls" ... } }
```

Concepts:

- **ingress-nginx, not AWS ALB Ingress.** A Deployment inside the cluster is the
  load balancer. Trade-off: portability across AWS/GCP/Azure and richer config
  (snippets, upstream control) in exchange for running and scaling it yourself.
  Given Capella is multi-cloud, portability wins. Terraform has a matching
  `terraform/modules/ingress-nginx`.
- **`proxy-body-size = 10m` mirrors `v2/decoder.go`'s 10MB `io.LimitReader`.**
  Defence in depth: the proxy rejects oversized bodies before a pod allocates
  memory, and the app enforces the same bound independently. The decoder comment
  even references the NGINX default. **Limits must agree across layers** — if the
  proxy allowed 100m the app cap would produce confusing 400s instead of a clean
  413.
- **`proxy-read-timeout = 1800`** (30 min). Some CP operations are genuinely long.
  Pairs with `goof.GatewayTimeout()` / 504 in `Goofify`.
- **`proxy-next-upstream-tries = 1`** — do **not** retry on another pod. Correct
  for non-idempotent writes: a silent retry could double-create.
- **`backend-protocol = HTTPS`** — TLS all the way to the pod. Encryption in
  transit inside the cluster, not just at the edge.
- **cert-manager `cluster-issuer`** — certificates issued and renewed in-cluster
  (ACME/Let's Encrypt or an internal CA per environment), stored in the
  `cp-api-tls` Secret. The k8s-native counterpart to ACM.
- **CORS via `configuration-snippet`**, templated with `CP_UI_DOMAIN`. Browser
  origin policy is enforced at the proxy *and* in Go
  (`middleware.CrossOrigin`, `cmd/cp-api/middleware/cors.go`).

### Internal ingress — mTLS (`service.tf:64`)

```hcl
annotations = {
  "nginx.ingress.kubernetes.io/backend-protocol"       = "HTTPS"
  "nginx.ingress.kubernetes.io/auth-tls-secret"        = "${var.namespace}/controlplane-certificates"
  "nginx.ingress.kubernetes.io/auth-tls-verify-client" = "on"
  "nginx.ingress.kubernetes.io/auth-tls-verify-depth"  = "1"
}
spec { tls { secret_name = "controlplane-certificates" hosts = [ ...internal_cp_api_domain ] } }
```

**Concept: mutual TLS.** The *client* must present a certificate signed by the CA
in `controlplane-certificates`. `verify-depth = 1` means directly signed — no
intermediate chains, so a leaf compromise cannot be laundered through a sub-CA.

Same Service, same pods, **two ingresses with different hostnames and different
authentication**. The internal hostname is not reachable without a client cert.
That is how the control plane's internal surface is separated from the public one
without a second deployment.

Compare the three auth tiers now visible:

| Surface | Authentication | Where enforced |
|---|---|---|
| Public API | TLS + JWT | cert-manager TLS; `middleware.JWTAuthenticationMiddleware` |
| Internal CP | mTLS (client cert) | nginx `auth-tls-verify-client` |
| `/internal/support/**` | static token | `middleware.TokenAuth` (`handler.go:213`) |

### Secrets — never in the repo

`secrets-auth.tf` reads ~20+ `data "aws_secretsmanager_secret"` values:
`jwt_secret`, `cp_api_couchbase_user` / `_password`,
`auth0_m2m_application_client_secret`, `auth0_web_application_client_secret`,
`github_social_sign_in_client_secret`, `google_social_sign_in_client_secret`,
`azure_vnet_peering_client_secret`, `stripe`-related, `jira_username`/`token`,
`launch_darkly_sdk_key`, `iq_integration_{anthropic,openai,google}_api_key`,
`cp_thanos_query_v2_password`, `omnistrate_password`, `docsbot_couchbase_*`.

**Concepts:**

- Secrets Manager is the source of truth. Terraform **reads** (`data`, not
  `resource`) and projects them into a k8s `Secret`. Rotating in Secrets Manager
  does not require a code change.
- `kubernetes_service_account.cp_api` exists so the pod can assume an IAM role
  via **IRSA** (IAM Roles for Service Accounts) — the pod gets short-lived
  credentials from STS instead of a long-lived key. Matching module:
  `terraform/modules/oidc-roles`.
- The repo tracks `acceptable_secrets.md` — an allowlist for the secret scanner.
  Read it before your PR fails a scan.

### Availability

- `kubernetes_pod_disruption_budget_v1.cp_api_pdb` — caps voluntary disruption
  (node drains, cluster upgrades) so a rolling node replacement cannot take all
  replicas at once. **PDBs guard voluntary disruption only**; they do not help
  with a node crash. That is what replicas across AZs are for.
- `data.aws_eips.cp_worker_node_eip` (`main.tf:1-11`), selected by
  `tag:Environment = var.cloud_id` and `tag:Name = worker_node_eip` — stable
  Elastic IPs for outbound traffic, so a customer or third party can allowlist a
  fixed set of source IPs.

**Concept: tag-based resource discovery.** Terraform finds the EIPs by tag rather
than hardcoded id, which keeps the module reusable across accounts. The cost is
that a mistagged resource is a silent, confusing failure. Tags are infrastructure
API surface — treat them as such.

- `kubernetes_cluster_role.prometheus` + binding — Prometheus needs RBAC to scrape
  pod metrics. Metrics are wired in at deploy time, not bolted on.

### Config as ConfigMaps

`kubernetes_config_map.cp_api_env_vars`, `..._indexes`, `..._auditevent_indexes`.

The index ConfigMaps are notable: **Couchbase index definitions are shipped as
part of the deployment.** Query performance is version-controlled and reviewed,
not applied by hand in a console. Slice 2 should follow how they are applied.

---

## 3. The AWS SDK surface inside `cp-api`

From the imports at `cmd/cp-api/server/server.go:17-30`:

**SDK v2:** `config`, `athena`, `bedrockruntime`, `kms`, `s3`, `secretsmanager`
**SDK v1 (still present):** `session`, `acmpca`, `secretsmanager`, `sqs`

Wrapped in-house under `internal/aws/`: `acmpca`, `route53`, `s3`, `sts`,
`v2/account`, `v2/iam`, `v2/kms`, `v2/secretsmanager`, `v2/ssm`, `v2/sts`.

What each is for, and the concept it teaches:

| Service | Use | Concept |
|---|---|---|
| **KMS** | Envelope encryption, BYOK/CMEK | Customer-managed keys — the customer can revoke access to their own data |
| **Secrets Manager** | Credentials at boot | Never in image or repo |
| **SSM Parameter Store** | Config | Cheaper than Secrets Manager for non-secret config |
| **STS** | `AssumeRole` into customer accounts | **Cross-account access** — the core DBaaS trust model |
| **S3** | Backups, exports, logs | — |
| **SQS** | Job queueing | Async decoupling (central to slice 2) |
| **ACM PCA** | Private CA | Issues the certs behind the mTLS above |
| **Route53** | DNS for provisioned clusters | Programmatic DNS |
| **Athena** | Query data in S3 | Serverless analytics over billing/usage data |
| **Bedrock Runtime** | LLM inference | Powers Capella iQ |
| **IAM** | Roles/policies for DP resources | Least privilege, generated per tenant |

**The single most important AWS concept in Capella: cross-account `AssumeRole`.**
The customer's data plane lives in *their* AWS account or in a Couchbase-managed
account dedicated to them. `cp-worker` does not hold customer credentials; it
assumes a role with an external-id trust policy. Read `internal/aws/v2/sts` and
`internal/aws/v2/account` before slice 2.

**Two SDK versions coexisting** is a real-world fact, not a mistake. v1 is EOL
and gets removed opportunistically. Do not add new v1 usage.

---

## 4. Cloud accounts and environments

From `docs/agents/architecture.md`:

| Env | AWS account | Notes |
|---|---|---|
| dev | `dbaas-test-0005` | `AWS_PROFILE=dbaas-test-0005-temp` |
| stage | `dbaas-stage-0001` | |
| prod | `dbaas-prod-0001` | |

GCP dev project `cbc-dev-bbf356999fa41d60`; Azure dev tenant
`couchbasetest1.onmicrosoft.com`. Region is typically `us-east-1`.

API hostnames (from `cmd/cp-ui-v3/package.json` scripts):

| Target | Host |
|---|---|
| dev | `api.dev.nonprod-project-avengers.com` |
| sandbox | `api.sbx-NN.sandbox.nonprod-project-avengers.com` |
| prod | `api.cloud.couchbase.com` |
| local | `http://localhost:8080` |

**Concept: account-level blast-radius isolation.** Separate AWS accounts (not
just separate VPCs) mean IAM, service quotas, and billing are all isolated. A
runaway job in dev cannot exhaust a prod quota. Sandboxes (`SBX`) are ephemeral
per-engineer environments — `terraform/modules/sandbox-operator`,
`cmd/sandbox-operator`.

`terraform/live/` holds per-environment state; `terraform/modules/` holds the
reusable code. Standard and correct: modules are versioned code, `live` is the
instantiation.

---

## 5. Observability

From `docs/agents/architecture.md` and the terraform modules:

| Concern | Stack |
|---|---|
| Logs | DataDog (prod); structured via `internal/log` |
| Metrics | Prometheus → **Thanos** → Grafana |
| Metric definitions | `internal/metrics/curated/*.yaml` |
| Alerting | PagerDuty, via Terraform-managed Prometheus alerting rules |
| Frontend logs | `@datadog/browser-logs`; Coralogix in dev only |
| Tracing | `dd-trace-go`, incl. the continuous profiler (imported in `server.go`) |

Terraform modules present: `prometheus`, `thanos`, `thanos-query-v2`,
`thanos-query-frontend-v2`, `thanos-plg`, `grafana`, `restricted-grafana`,
`datadog`, `datadog_monitor`, `datadog_slo`, `pagerduty-service`, `coralogix`,
`coralogix-alerts`, `coralogix-dashboards`, `alertmanager`, `firehose`.

**Why Thanos:** Prometheus is single-node and its local retention is short. Thanos
ships blocks to object storage and provides a global query view across many
Prometheus instances. That is what makes long-range and cross-cluster queries
possible in a multi-region control plane.

**Note `datadog_slo` as a Terraform resource.** SLOs are code, reviewed in PRs.
That is the reliability practice worth copying.

Two frontend observability decisions worth calling out:

- `cmd/cp-ui-v3/src/main.tsx` imports Coralogix **dynamically**, guarded by
  `shouldLoadCoralogix()`, to keep it out of the prod bundle. Observability has a
  bundle-size cost and it was measured.
- `cmd/cp-ui-v3/src/sync/request.ts:19-25` logs only **500s** to Datadog, and
  only in production/preview. Log what is actionable; a 404 is usually not.

**Route redaction** (`cmd/cp-api/server/handler.go:23`, ticket AV-23846): a map of
regexes used to censor customer information out of traces and logs. The comment
states the reason plainly — reputational and contractual damage. Endpoints opt in
via `endpoint.RedactRoute`, and `endpoint.SuppressMonitoring` registers a route
as "variable" so high-cardinality path segments do not explode metric labels.

**Concept: cardinality control.** A metric label containing a UUID creates one
time series per resource and will take down your metrics backend. That is what
`variableRoutes` prevents.

---

## 6. What a UI engineer should take away

1. **Static UI ≠ a server.** S3 + CloudFront + Lambda@Edge. Your build artefact
   is a set of files behind a CDN, and the SPA fallback is a 12-line edge
   function.
2. **Cache keys are a design decision** with a security dimension. Excluding
   cookies is what makes the CDN cheap; it is safe only because the bundle is
   impersonal.
3. **Edge trigger placement is a cost/behaviour trade-off.** `viewer-request`
   runs always; `origin-request` only on a miss.
4. **TLS is automated twice**, differently: ACM+Route53 DNS validation at the
   edge, cert-manager inside the cluster.
5. **Limits must agree across layers** — nginx `10m`, Go `io.LimitReader` 10MB.
   Mismatched limits produce confusing errors and real vulnerabilities.
6. **Auth is topology, not a function call.** Three tiers (JWT / mTLS / static
   token) enforced at three different layers, and which one applies is decided by
   *where* the route is registered.
7. **Nothing sensitive is in the repo or the image.** Secrets Manager at boot;
   IRSA for AWS access; only public client ids reach the browser.
8. **Cross-account `AssumeRole` is the DBaaS trust model.** Fully traced in
   [doc 06, Part 9](06-slice-02-cluster-provisioning.md#part-9--cross-account-access-the-dbaas-trust-model).
9. **Everything is code**: infrastructure, index definitions, alert rules, SLOs,
   error messages. If it is operationally important here, it is in a PR.
