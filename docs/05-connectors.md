# Connectors & Integration

Automation is only as valuable as the connectors it can reach. An AI that can propose a perfect workflow but cannot connect to your CRM, your billing platform, or your internal database is not useful to an enterprise.

Connectors are the integration fabric of sk. They represent every external integration boundary the platform can reach — typed, authenticated, monitored, and secured. Understanding Connectors is essential to understanding how sk connects enterprise AI to real integrations.

---

## What a Connector Is

A Connector is a configured, authenticated connection to an external integration boundary. It is not a generic HTTP client, and it is not an ad hoc integration configured per-workflow. A Connector is a first-class platform resource: typed, validated, monitored, and reusable across any number of workflows.

The design separates three concerns that are often conflated. The Driver handles the protocol — how requests are formed, sent, and parsed. The Connector Template provides connector-specific configuration and context — what this particular integration target looks like and how to work with it. The Credential provides secure authentication — the secrets needed to connect. Each layer has a distinct responsibility, and each can evolve independently.

This separation has practical consequences. Multiple Connectors can share the same Template — for example, a production Stripe account and a staging Stripe account can each be a separate Connector built from the same Stripe Template, with different Credentials and different Environment tags. The platform can route workflows to the appropriate account based on execution mode without any workflow-level logic.

---

## The Nine Drivers

Drivers are the protocol layer. Every Connector in sk uses one of nine built-in drivers: `http`, `graphql`, `postgres`, `s3`, `ftp`, `sftp`, `smb`, `mssql`, and `redis`.

The **HTTP driver** handles REST APIs. It manages request construction, response parsing, pagination patterns, and error normalization. When a Step calls an HTTP Connector, the driver handles the protocol details so the workflow step only needs to describe what to call and what to do with the result.

The **GraphQL driver** handles GraphQL APIs. It manages query and mutation construction, variable binding, and schema awareness. Workflows that target GraphQL APIs benefit from the driver's understanding of the schema structure — the AI can propose specific queries rather than generic HTTP calls.

The **PostgreSQL driver** handles direct database connections. It manages query execution, parameterized inputs, and result set handling. This driver enables workflows that read from or write to relational databases directly, without requiring an intermediate API layer. The **MSSQL driver** covers Microsoft SQL Server with the same model.

The **S3 driver** handles object storage. It manages bucket operations, presigned URL generation, and streaming transfers. This covers not just AWS S3 but any S3-compatible object store. The **FTP**, **SFTP**, and **SMB** drivers complete the file-transfer surface for enterprise file-exchange scenarios.

The **Redis driver** handles key-value + pub/sub patterns for cache-backed workflows and lightweight inter-step coordination.

Every Connector in sk uses one of these nine drivers. Custom drivers are not part of the platform.

### GraphQL vs REST: when to pick which

Several major APIs — GitHub, GitLab, Linear, Monday, Shopify — offer both REST and GraphQL endpoints. The built-in template catalogue ships both where appropriate (for example `github` and `github-graphql`). Choose by what the workflow actually does:

- **Deep read traversals** (repository → issues → comments → labels): prefer GraphQL. One query replaces many REST roundtrips; the cost-based rate limit is more forgiving than REST's per-request budget.
- **Write operations** (create an issue, merge a PR, commit a file): prefer REST. GraphQL mutations at these providers are incomplete — organisation-admin mutations often don't exist.
- **Simple CRUD on one resource**: REST is usually shorter to author and debug.

The two connectors can coexist in a tenant — one `github` connector for writes, one `github-graphql` connector for reads — sharing the same credential (a PAT with `repo + read:org` works on both endpoints).

---

## The Connector Template Catalog

Templates are what make the AI's proposals accurate. Without templates, the AI can suggest "use an HTTP connector to call Salesforce" — but it cannot propose the correct authentication pattern, suggest the right endpoints, or explain the connector target's specific behaviors and limitations.

sk ships 90 Connector Templates covering the most common enterprise services: Stripe, Salesforce, HubSpot, GitHub, Jira, Slack, Microsoft Teams, Google services, AWS services, databases, and more.

A Template is more than a configuration skeleton. It includes: the appropriate driver, the authentication configuration for that service (OAuth2 scopes, API key placement, basic auth conventions), links to documentation that the platform will index, setup guidance the AI presents when a user configures the Connector, and example Skill content the AI can draw on when proposing integrations.

Templates are the reason the AI can propose accurate integrations rather than generic API calls. The curated knowledge about each connector target is baked into the template, not assembled from general training data at authoring time.

---

## Authentication and Credential Management

sk supports the authentication patterns that enterprise systems actually use: API key, OAuth2 (both authorization code and client credentials flows), basic auth, and custom header schemes.

OAuth2 flows are managed entirely by the platform. The engine handles token refresh, expiry detection, and token rotation automatically. An operator configures an OAuth2 Connector once; the platform handles re-authentication as tokens expire. No workflow needs to manage token lifecycle.

All secrets are stored in the Credential Vault: encrypted at rest, never logged, and never exposed outside the engine. Workflows and Steps reference Credentials by name, not by value. This means sk can propose, configure, and audit integrations without any secret ever appearing in a workflow definition, a log file, or a conversation transcript.

End-User Credentials extend this model for multi-user scenarios. An individual user can supply their own credentials for a Connector, and the platform will act as that user when executing on their behalf rather than as the tenant operator. This is the right model for workflows that need to act under a specific user's identity — proper delegation, not credential sharing.

---

## Tunnels: Private Network Access

Many enterprise systems are not publicly reachable. They live behind firewalls, inside VPCs, or on-premises. sk's Tunnel mechanism solves this without requiring operators to open inbound firewall rules or expose internal services to the internet.

A small agent binary — the Tunnel Agent — runs inside the private network. It opens an outbound WebSocket connection to the sk engine and registers the internal services it can reach. When a workflow Step needs to call one of those services, the engine routes the request through the open Tunnel connection. From the network's perspective, only an outbound connection was made.

The security model is deliberate. No inbound firewall rules are required. The Tunnel Agent is a proxy only — it forwards requests but makes no authorization decisions. All authorization is handled by the sk engine, using the same RBAC and policy layer that governs every other request. Connections are authenticated and encrypted end-to-end.

---

## Schema Versions and Drift

External APIs change. Fields are renamed, endpoints move, new error codes appear, response shapes evolve. A Connector that worked last month may not work the same way today.

sk tracks schema versions for each Connector endpoint. As the engine executes Steps against a Connector, it observes the response shapes and compares them against the recorded schema. When a discrepancy appears — a field that was present is missing, a type that was a string is now an object — the engine classifies it as drift.

Drift is detected from actual execution results, not from periodic polling. The signal comes from real workflow runs encountering real changes in the connected boundary. When drift is detected, it becomes the trigger for the self-healing process described in the execution document.

---

## Health and Validation

Every Connector can be tested independently of any workflow. The engine validates the connection, authenticates with the configured Credentials, and reports the result along with connection latency. Connector tests and workflow request steps share the same underlying request execution path, so a successful connector test reflects the same transport behavior a workflow will use.

Connector validation is available on demand and during authoring. Operators do not need to wait for a full workflow failure before checking whether a Connector is reachable, authenticated, and returning the expected shape.

---

## What to Read Next

- [docs/06-execution.md](06-execution.md) — how workflows that use Connectors actually run: the execution model, step kinds, triggers, versioning, and self-healing.
