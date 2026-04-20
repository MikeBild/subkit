---
slug: connector-creation-guidance
scope: global
title: Connector Creation Guidance
description: Generic best-practice guidance for creating HTTP connectors via conversation.
gates_tools: []
version: 1
auto_load: true
trigger_keywords: [connector, api, http, endpoint, base-url, auth, oauth2, bearer, api-key, authentication]
---

# Connector Creation Guidance

## Before creating a connector, confirm these four things

1. **Base URL** — full URL including any environment-specific subdomain or path prefix. Ask if the user has separate staging/production URLs.
2. **Authentication type** — one of: none, API key (header or query), Bearer token, Basic auth, OAuth2. For each type, confirm the exact header/parameter name (e.g. `X-API-Key` vs `Authorization` vs a custom header).
3. **API versioning** — does the API use a version path (`/v1/`, `/v2/`)? This belongs in the base URL, not in each step path.
4. **Rate limits** — does the API have documented rate limits? If so, set `max_retries: 2` or lower and note the Retry-After behaviour.

## Authentication type quick guide

- **API key in header**: `auth_type: header`, credential key = the header name (e.g. `X-API-Key`)
- **API key in query**: `auth_type: query`, credential key = the parameter name
- **Bearer token**: `auth_type: bearer`, credential value = the raw token (no "Bearer " prefix — the driver adds it)
- **OAuth2**: `auth_type: oauth2` — ask for `client_id`, `client_secret`, `token_url`, `scopes`. Use `submit_connector_credential` to store the refresh token.

## Connector config best practices

For HTTP connectors, always set:
- `timeout_ms`: 30000 (30 seconds) for general APIs; 10000 for real-time endpoints
- `max_retries`: 3 for idempotent APIs; 1 for non-idempotent (POST creates)
- `follow_redirects`: true (default) unless the API uses redirects as signals

## After creation

Always run `probe_connector_draft` to verify connectivity before saving. Show the probe result in plain language: "Connected successfully" or "Connection failed: [reason]".
