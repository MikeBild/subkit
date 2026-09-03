# Machine tokens — swap an API key for a short-lived Bearer token

> **Reading time:** ~5 min
> **Audience:** Engineers writing scripts, scrapers and deploy checks against the engine

**An API key is a long-lived secret. It should travel once an hour, not on every request.** SubKit's own OAuth 2.1 token endpoint implements RFC 8693 token exchange: you hand it a key it already trusts and get back a Bearer token that is accepted everywhere the key is — same principal, tenant, roles, scopes and allow-lists — and that expires within the hour. The key stays on disk; only the token appears in `curl` lines, request logs and process lists.

## The grant

```
POST /v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<your wf_live_… api key>
&subject_token_type=urn:subkit:params:oauth:token-type:api-key
&scope=metrics:read              (optional — a subset of the key's scopes)
&ttl=900                         (optional — seconds, capped at 3600)
```

No `client_id`, no client secret: the API key is the credential. A JSON body with the same fields works too. The endpoint is the one advertised as `token_endpoint` in `/.well-known/oauth-authorization-server`, and `grant_types_supported` there lists the grant.

The response:

```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "expires_in": 900,
  "scope": "metrics:read"
}
```

There is no refresh token. When the token expires, exchange the key again.

One `curl` line does it:

```sh
TOKEN=$(curl -sS -X POST "$SUBKIT_URL/v1/oauth/token" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "subject_token=$(cat /etc/subkit/api-key)" \
  --data-urlencode "subject_token_type=urn:subkit:params:oauth:token-type:api-key" \
  | jq -r .access_token)

curl -sS -H "Authorization: Bearer $TOKEN" "$SUBKIT_URL/metrics"
```

## What the token can do

Exactly what the key can do, or less:

| Rule | Behaviour |
| --- | --- |
| Principal | The key's owner — user or system account — with the key's role. `GET /v1/identity/whoami` answers identically for key and token. |
| Scopes | Default: the key's scopes. `scope=` narrows to a subset; any entry the key lacks is refused with `invalid_scope`. A key with `*` covers every scope. |
| Workflows | `scope=workflow:<id>` entries narrow `allowed_workflows` to those ids; an id outside the key's allow-list is `invalid_scope`. |
| Lifetime | `ttl` seconds, default 900, cap 3600. `ttl=0` or a non-integer is `invalid_request`. |
| Routes | Every route that accepts the key accepts the token: the REST API, `GET /metrics` with a `metrics:read` key, the operator-verify routes (`/v1/status`, `/v1/diagnostics/*`, `/v1/operator/*`), and MCP over Streamable HTTP and stdio. Same permission checks. |
| Audit | Same `actor_type` and `actor_id` as the key. Every audit row written under the token carries `via: token_exchange` in its metadata; the exchange itself writes `api_key.token_exchanged` (scope, TTL, request source — never the key or the token). |
| Revocation | The token is bound to the key row and to the key's version. Revoking, expiring or rotating out the key refuses its tokens on the next request; a revoked key cannot be exchanged (`401 invalid_grant`). No table, no cleanup job: the token is a signed statement, verified on use against the live key row. |

Refusals follow RFC 6749: `invalid_request` (400) for a malformed request or the wrong `subject_token_type`, `invalid_scope` (400) for a wider scope, `invalid_grant` (401) for a key that is unknown, revoked, expired, rotated out or whose owner is disabled, `unsupported_grant_type` (400) for any other grant.

## On the host: `engine --token-exchange`

Scripts on the engine host do not need the HTTP round trip:

```sh
TOKEN=$(engine --token-exchange --key-file /etc/subkit/api-key --scope metrics:read --ttl 600)
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/metrics
```

The key is read from a file — never from an argument, because `argv` is visible to every process on the host. `--scope` may repeat; `--ttl` is 1..3600. The command runs the same checks and writes the same `api_key.token_exchanged` audit row (with `request_source: cli`) as the endpoint, and exits 1 with the OAuth error name on stderr when the exchange is refused. `engine --help` lists it.

## Machine use of a connection

A [connection](../admins/credentials-and-keys.md) (a system SubKit calls on someone's behalf) already holds a short-lived access token that the engine refreshes. A machine caller inside the product — the scheduler, a scraper step, an agent-to-agent call — reads that token through the same credential reader a workflow step uses; there is no second path and nothing to exchange. Token exchange is for callers that arrive at SubKit's own edge with a SubKit API key.

## Where the token lives

Nowhere. It is an HS256 JWT signed with a secret derived from `MASTER_KEY`, carrying the key id, a fingerprint of the key version, the tenant, the subject and the granted scope. Every instance that shares `MASTER_KEY` verifies it; no instance stores it. That is why there was no schema change and why the token survives a restart but not a key revocation.

## See also

- [Input surfaces](input-surfaces.md) — the doors into the engine and the OAuth 2.1 server behind `/mcp`
- [Credentials & keys](../admins/credentials-and-keys.md) — issuing, rotating and revoking API keys
