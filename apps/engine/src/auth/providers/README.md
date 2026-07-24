# Auth providers

`AuthProviderRegistry` walks enabled adapters in order and returns the first
resolved principal. The registry is assembled from the single
`auth.providers` list. Product code recognizes protocols, never vendor names.

Supported protocols:

| Protocol | Adapter | Purpose |
|---|---|---|
| `api_key` | `api-key.ts` | User and machine API keys |
| `oidc` | `oidc.ts` | Authorization-code + PKCE and session cookies |

`portal_token` remains an always-on product credential and `mcp_oauth` is
registered when the MCP OAuth server is enabled. They are not interactive
browser providers and therefore are not entries in `auth.providers`.

The same `auth.providers` list drives provider discovery, the generic browser
routes, MCP OAuth login, and bearer verification. Multiple direct OIDC records
may coexist; each client, secret, callback and session belongs to this SubKit
deployment. Provider IDs and labels are deployment choices. The only
browser routes are:

- `GET|POST /v1/identity/login/start`
- `GET /v1/identity/login/callback`
- `POST /v1/identity/logout`

OIDC assertion exchange validates discovered issuer metadata, the configured
client audience and verified email before resolving the SubKit identity.

To add an authentication mechanism, implement one of the existing protocol
adapters or introduce a new protocol deliberately. Do not add vendor-specific
routes, environment variables, config branches, or registry cases.
