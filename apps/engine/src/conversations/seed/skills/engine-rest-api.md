---
slug: engine-rest-api
scope: global
title: Engine REST API
description: Mental model for sk's /v1 REST surface, plus where to fetch the exhaustive endpoint reference.
activates_when: [{"kind":"intent_keyword","word":"rest"},{"kind":"intent_keyword","word":"api"},{"kind":"intent_keyword","word":"endpoint"},{"kind":"intent_keyword","word":"/v1"},{"kind":"intent_keyword","word":"openapi"},{"kind":"intent_keyword","word":"curl"},{"kind":"intent_keyword","word":"http api"}]
side_effects: read
idempotency: none
maturity: stable
tags: [sk-platform-reference, rest, api, openapi, http]
version: 1
---

# Engine REST API

## Mental model

sk exposes one tenant-scoped HTTP API under the `/v1` prefix. Every route is a Zod-first
contract: the OpenAPI spec is generated from the route definitions, never hand-written. The
same domain operations are reachable two ways — REST (for clients and scripts) and the MCP
tools (for an LLM). They share the same handlers, permissions, and audit trail, so a fact
proven over one surface holds over the other.

## Key facts

- **Auth.** Bearer token on every request: `Authorization: Bearer <token>` (`bearerAuth`).
  Self-introspection (`/v1/status`, `/v1/identity/whoami`, `/v1/identity/permissions`) needs
  only authentication; everything else is permission-checked and audited.
- **Spec is generated.** Raw spec at `GET /openapi.json`; the interactive Scalar reference is
  served at `/docs`. Trust these over any prose — they are emitted from the live route code.
- **Running a workflow is one endpoint.** `POST /v1/executions` with a discriminated `source`
  (`saved` = a committed workflow, `draft` = inline definition, `step` = a single step). The
  optional `x-subkit-environment: dev|prod` header selects the run environment. The MCP
  equivalent is the `run_workflow` tool.
- **Resource families.** `/v1/workflows`, `/v1/executions`, `/v1/connectors` (+
  `/v1/connector-templates`), `/v1/conversations`, `/v1/skills` (+ `/v1/skill-candidates`),
  `/v1/knowledge-sources`, `/v1/patch-candidates`, `/v1/discovery`, `/v1/self-healing`,
  `/v1/rbac`, `/v1/identity` (api-keys, portal-tokens, system-accounts, invites),
  `/v1/webhooks/inbound`, `/v1/schedules`, `/v1/subscriptions`, `/v1/diagnostics`,
  `/v1/stats`, and `/v1/status` + `/v1/health`. Each follows the same list / get / mutate
  shape on `/{id}` sub-paths.
- **MCP tool names are underscore, never dotted** (`run_workflow`, `conversation_start`,
  `search_knowledge`, `get_engine_status`, `whoami`). Any `wf.<slug>` / `conversation.*` form
  seen in older docs prose is wrong.

## For the full reference

This skill is intentionally thin. For the exhaustive endpoint catalog — every path, method,
request/response shape, and required permission — call:

```
search_knowledge({ query: "<what you need, e.g. run a workflow, create a connector>", tags: ["sk-platform-reference"] })
```

(or `search_knowledge_v2` with the same arguments). The complete REST reference lives in the
knowledge source slug `sk-ref-rest-api`. When in doubt about an exact path or field, prefer
the generated `/openapi.json` over any narrative description.
