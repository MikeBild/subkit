# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] – 2026-07-04

First public release.

- **Engine** — self-hostable workflow engine: versioned workflow definitions,
  deterministic execution with step-level auditing, multi-tenant RBAC,
  encrypted credential storage, OAuth2 flows, inbound webhooks, scheduler,
  and self-healing patch candidates behind human approval.
- **AI-assisted authoring** — describe an outcome in natural language; the
  engine drafts a grounded workflow, dry-runs it against recorded previews,
  and commits only on explicit approval. Execution never re-decides control
  flow at runtime.
- **Connectors** — a template catalog across HTTP, GraphQL, PostgreSQL, and
  S3 drivers, with endpoint discovery, docs ingestion, and vendor-drift
  sweeps.
- **Surfaces** — `sk` CLI (REPL + admin), REST API with generated OpenAPI,
  MCP server for AI clients, chat adapters, and inbound webhooks.
- **Operations** — structured logs, metrics, traces, token-budget
  accounting, immutable audit trail, signed release binaries, and Docker
  images.
