# Deployment & Operations

sk is designed for enterprise deployment. That means it has to be reliable enough to run unattended, observable enough to diagnose problems quickly, and self-correcting enough to handle the inevitable drift that comes from running in a changing environment.

This document explains how sk is deployed, how operators monitor it day-to-day, and how the platform handles failure — from a single connector going down to an external API changing its schema.

---

## Deployment Topology

sk compiles to a single binary. The only stateful dependency is PostgreSQL.

There is no separate message broker to manage, no distributed queue service to operate, and no coordination system to keep in sync. The job queue, the cron scheduler, and the pub/sub event bus all run within the engine process, using PostgreSQL as their durable backing store. This is a deliberate architectural choice: it reduces the operational footprint to a single dependency and eliminates an entire category of distributed systems failure modes.

The standard deployment model is straightforward: one engine service and one PostgreSQL instance. For teams that need higher availability, the engine is horizontally scalable — run multiple instances behind a load balancer. The queue and scheduler subsystems are designed for concurrent execution across multiple engine instances without coordination overhead.

The **Tunnel Agent** is a separate small binary deployed in private networks. When a Connector targets a system behind a firewall or VPN, the Tunnel Agent runs inside that network and opens a persistent outbound WebSocket connection to the engine. No inbound firewall rules are required. The engine routes Connector requests through the open tunnel. The Tunnel Agent is stateless and reconnects automatically on interruption.

---

## Installation

sk ships pre-compiled binaries for macOS (Intel and Apple Silicon), Linux (x64 and ARM64), and Windows (x64). All four apps — `sk`, the `subkit` CLI, the engine, and the Tunnel Agent — are available as standalone binaries.

A one-line install script covers the common cases for bash and PowerShell environments. The engine is also published as a container image for Kubernetes and cloud-native deployments.

Auto-update is supported: binaries check for new versions on startup and can update in place.

---

## Configuration

The engine is configured entirely through environment variables. The core settings are the database connection string, AI provider API keys, authentication mode, and tenant seed configuration.

There is no configuration file format to author or maintain. Environment variables are the operator interface. Secrets — database passwords, API keys — belong in a secrets manager or environment variable injection, never in committed configuration files.

The engine validates its configuration at boot and exits with a descriptive error if required settings are missing or invalid. There is no silent degraded mode from a misconfiguration.

---

## Observability

**Metrics.** The engine exposes a Prometheus-compatible `/metrics` endpoint. Metrics cover every operational concern: request latency by route, execution duration and step counts, error rates and retry counts, queue depth, token usage per tenant, and connection pool statistics. No external metrics system is required for collection — any Prometheus-compatible scraper works.

**Structured Logging.** All engine output is structured JSON on stdout. Every log entry carries a trace ID, tenant ID, request source, and severity level. Logs can be shipped to any standard log aggregation system — Datadog, Grafana Loki, CloudWatch, Elasticsearch — without transformation. The structured format means you can query and alert on log fields directly, not just on log message text.

**Execution Inspection.** Every workflow execution has per-step logs accessible through the API and CLI. Operators can follow a running execution in real time with `sk runs tail <execution-id>`. Failed steps include the full error, the inputs that were passed to the step, and the raw connector response. There is no guesswork about what happened.

**Event Streaming.** A tenant-wide Server-Sent Events stream delivers real-time execution events. External monitoring systems, dashboards, and alerting integrations can subscribe to this stream for custom logic. The SSE stream carries the same events that drive the CLI's live-tail mode.

---

## Resource Limits and Operational Safety

sk enforces limits at multiple levels to protect overall system reliability.

Per-execution and per-step timeouts prevent runaway workflows from consuming resources indefinitely. Per-tenant token budgets cap AI usage costs. Rate limits on API endpoints prevent any single caller from monopolizing capacity. Circuit breakers on connector requests detect when an external system is degraded and fail fast — after a configurable number of consecutive failures, the circuit opens and requests fail immediately until the system recovers. Queue depth caps prevent unbounded work accumulation.

These limits have documented defaults and can be tuned by operators for their specific workloads. They are designed so that no single workflow, tenant, or external system dependency can degrade the platform for others.

When a circuit breaker trips, the audit log records it and the event stream delivers a notification. Operators see the failure before users do.

---

## Self-Healing in Operations

From an operational perspective, self-healing is how sk stays healthy as the external world changes.

External APIs evolve. Fields are renamed. Endpoints move. Error codes change. New required parameters appear. Without a mechanism to detect and respond to these changes, workflows that were working yesterday fail silently or noisily today — and the operator has to diagnose and repair them manually.

When a Connector's external API changes in a way that causes Step failures, the engine detects the discrepancy during normal execution. It does not require a separate health check job or a manual test run. Drift is detected when it matters: when a workflow is trying to do real work and something unexpected comes back.

The operator receives a **Patch Candidate**: a proposed repair with a structured diff showing exactly what changed, a classification of the repair as safe or unsafe based on the scope of the change, and dry-run results validated against recorded execution history. Reviewing and applying the patch is a single operator action.

Self-healing does not apply repairs automatically. The operator decides. But the operator is presented with a ready-to-apply, validated proposal rather than a raw failure to diagnose from scratch. The operational burden of maintaining integrations in a changing API landscape is substantially reduced.

---

## Backup and Recovery

sk's complete state lives in PostgreSQL. A standard PostgreSQL backup strategy — `pg_dump`, WAL archiving, or managed backup from a cloud database service — covers everything: workflows, connectors, credentials, executions, audit log, skills, and knowledge sources.

The engine itself is stateless. It can be stopped, replaced with a new version, and restarted without data loss. All in-flight jobs are durably queued in PostgreSQL and resume automatically on restart. There is no in-memory state that needs to be preserved across restarts.

Workflow versioning provides application-level recovery. Every workflow change creates a new immutable version. If a deployment goes wrong, rolling back to a known-good version is a single command. The history is always available.

---

## What to Read Next

- [AGENTS.md](../AGENTS.md) — the canonical repo-wide contract for contributors: subsystem map, quality gates, and non-negotiables.
- [docs/quickstart/operator.md](quickstart/operator.md) — step-by-step: engine up, admin key minted, first connector registered, in 10 minutes.
