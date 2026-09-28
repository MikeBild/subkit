---
slug: engine-status-and-capabilities
scope: global
title: Engine Status & Capabilities
description: Mental model for sk's runtime self-inspection — engine status, health, identity, effective permissions, operator health digest, and token/LLM usage — across REST and MCP tools. Consult the sk-ref-status knowledge source for exhaustive field and endpoint detail.
activates_when: [{"kind":"intent_keyword","word":"status"},{"kind":"intent_keyword","word":"health"},{"kind":"intent_keyword","word":"capabilities"},{"kind":"intent_keyword","word":"token budget"},{"kind":"intent_keyword","word":"whoami"}]
side_effects: read
idempotency: none
maturity: stable
tags: [sk-platform-reference, status, health, identity, observability, token-budget]
version: 1
---

# Engine Status & Capabilities

Runtime self-inspection answers four questions without guessing: what is sk's state, who am I, what may I do, and how much have I spent? The same reads are exposed two ways — REST endpoints and MCP tools (underscore names, never dots). Every read is tenant-scoped; self-introspection is gated by authentication only, operational posture needs a permission.

## Key facts

1. **Composite snapshot.** `get_engine_status` (MCP) wraps `GET /v1/status`: connector/skill counts, today/month token spend, monthly budget + remaining, engine `version`, and `llm_provider` health (`{ detected, ok, missing[] }`). If `llm_provider.ok` is false, the first conversation turn will fail — warn before firing it.
2. **Liveness vs. readiness.** `GET /health` is public and minimal (`status`, `service`, `version`) and never checks dependencies. `GET /ready` is public and returns lifecycle/database checks as `pass` or `fail`, with HTTP 503 when either fails. Update availability and schema drift are NOT in public probes; they live behind `audit:read` at `GET /v1/diagnostics/version`.
3. **Identity.** `whoami` (MCP) / `GET /v1/identity/whoami` returns id, kind, tenant, email, `role_name`, `provider`, `base_url`, and raw `scopes`. `scopes` is what the credential *claims* (a ceiling), not the enforced decision.
4. **Effective rights.** For "may I read/write this connector?" call `GET /v1/identity/permissions?resource_type=connector&resource_id=...` — `level` (`none` | `read-only` | `read-write`) is computed from the same `can()` the engine enforces. Never infer write access from `scopes`.
5. **Token spend.** `get_token_budget` answers "how close am I to my monthly cap?" (`budget_tokens: null` = no cap). `get_llm_usage` returns the per-call ledger (`flow`, `model`, tokens, `latency_ms`, `result`) for attributing spend.
6. **What's failing.** `GET /v1/attention` (MCP `get_attention`) is the list of what needs the caller now, one item per thing to act on. `GET /v1/operator/health-digest` (needs `stats:read`) is a deterministic digest of failed runs, pending safe/unsafe patch candidates, and `critical`/`warn` risk signals, headed by that same list. `get_engine_status` deliberately omits this cross-workflow posture.

## Full reference

This skill is intentionally thin. For every field, endpoint, gating permission, and response shape, call:

```
search_knowledge({ query: "<your status or capability question>", tags: ["sk-platform-reference"] })
```

(or `search_knowledge_v2` with the same `tags` filter). The complete status & capabilities reference lives in the knowledge source slug `sk-ref-status`.
