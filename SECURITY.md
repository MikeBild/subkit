# Security policy

## Reporting a vulnerability

Email **mike@mikebild.com** with details. Do not open a public issue or PR. Allow up to **5 working days** for an initial response and **90 days** for a coordinated disclosure window before any public discussion.

Include in your report:

- Affected component (engine, sk, agent, schemas, deployment scripts, or a specific subsystem under `apps/engine/src/`).
- Affected version (output of `sk --version` / `engine --version`, or commit SHA).
- A minimal reproduction — request payload, environment, and expected vs. actual behavior.
- Any logs or audit-log entries that demonstrate impact (redact secrets first; do not include real credentials).

We will acknowledge receipt, triage privately, ship a fix, and credit the reporter in the release notes unless you ask us not to.

## Supported versions

Only the latest released minor on the current major line receives security fixes. As of this writing that is the **3.x** line. Older majors and pre-release tags are not supported.

## In scope

- The engine HTTP/MCP/webhook surfaces under `apps/engine/src/http`, `apps/engine/src/mcp`, `apps/engine/src/webhooks`.
- The `sk` CLI under `apps/sk/`.
- Engine-side authentication, RBAC, audit logging, credential storage, and OAuth2 flows.
- The deployment scripts under `scripts/release/` and the published Docker images.

## Out of scope

- Reports against third-party dependencies that have a published CVE — please report those upstream.
- Vulnerabilities that require a privileged operator account on the engine host (root, the engine's database role, or `MASTER_KEY` access).
- Findings against demo seed data, sample workflows, or fixture connectors.
- Social-engineering, phishing, or denial-of-service against the public mike@mikebild.com inbox.

## Responsible disclosure

We will work with you on a coordinated disclosure timeline. Do not exfiltrate or modify data beyond what's needed to demonstrate the issue. Do not target other tenants, other operators, or production deployments you are not authorized to test.
