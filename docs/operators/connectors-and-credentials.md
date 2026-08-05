# Connectors & Credentials (operator guide)

**Connect a system once, reuse it everywhere — and the credential is never exposed.**
Operators attach a credential to a connector a single time; every workflow then
references that connector by name. Secrets stay encrypted in the vault, out of
logs, out of LLM context, and out of every response body.

> **Audience:** Operators registering connectors, managing credentials, and
> keeping integrations healthy in production.

This is the operational slice of the connector subsystem: attach and rotate
credentials, test connectivity on demand, invoke an endpoint ad-hoc, and run the
vendor-drift sweep. For the full conceptual model — drivers, templates, the
catalog, schema-version drift — see
[Connectors & Integration](../concepts/connectors.md).

## The onboarding path

```mermaid
flowchart LR
    A[Pick template] --> B[Supply credential]
    B --> V[(Credential Vault<br/>encrypted at rest)]
    B --> C[Probe]
    C -->|ok + latency| D[Reference in a workflow]
    C -->|credential_required| B
    V -.referenced by name.-> D
```

| Step | What you do | What the engine does |
|---|---|---|
| Pick template | Match a vendor or URL to a connector template | Pre-fills driver, auth pattern, endpoints |
| Supply credential | `credentials set` once | Encrypts to vault, returns a reference, never the value |
| Probe | `connectors test` | Authenticates, reports status + latency |
| Reference | Name the connector in a workflow step | Applies the saved credential at run time |

![Connecting a system in the sk terminal: pick the target, enter credentials, test the connection, save](../_tapes/out/operator-onboard.gif)

---

## Authentication and credential management

sk supports the authentication patterns enterprise systems actually use.

| Pattern | Notes |
|---|---|
| API key | `bearer`, `header`, or `query` placement |
| OAuth2 | Authorisation-code and client-credentials flows |
| Basic auth | Username / password |
| AWS SigV4 | Signed requests |
| Custom header | Arbitrary scheme |

**OAuth2 is fully managed.** Configure the connector once; the engine handles
token refresh, expiry detection, and rotation automatically. No workflow ever
manages token lifecycle.

**Secrets live only in the Credential Vault** — encrypted at rest, never logged,
never exposed outside the engine. Workflows and steps reference credentials by
name, not by value. The full vault model and master-key rotation procedure are in
[Credentials & Keys](../admins/credentials-and-keys.md).

**Secrets are never collected in chat.** When onboarding runs through an AI client
over MCP, sk refuses to accept a credential as plain conversation text. A
secret-shaped prompt is declined and the operator is routed to the secure flow
instead — a scoped portal-setup link where the value is typed into a masked field,
or the managed OAuth authorization flow. The credential goes straight into the
encrypted vault outside the chat transcript; the AI client only learns that the
connector is now authorized. This means a token can never leak into a conversation
history, a tool argument, or a log — regardless of which surface drove the
onboarding. Even on a local CLI/web surface, where an operator _may_ type a secret
into a masked form, the answer is redacted (`***redacted***`) before it is persisted
or replayed to the model, and any credential slot in a tool argument is scrubbed at
the same boundary — the raw value only ever exists in memory on its way to the
encrypted vault.

**The portal-setup link needs no sign-in.** The link itself is the authorization:
a single-use grant token minted from your chat session, valid for a few minutes
and burned on submit — so the page never asks you to log in to sk. What the form
does ask for is the credential issued by the external service the connector
targets (its API key, token, or password), because that secret exists only on
the external service's side and cannot be derived from any sk or SSO identity.

**End-User Credentials** extend this for multi-user scenarios: an individual user
supplies their own credentials, and the platform acts as that user when executing
on their behalf — proper delegation, not credential sharing.

Attach a credential from the CLI:

```bash
sk credentials set <CONNECTOR_ID> --mode bearer --token sk_live_…
#   modes: bearer | header | query | basic | aws_sigv4 | none
sk credentials list <CONNECTOR_ID>
```

Cloudflare and Firebase/Firestore are built in:

```bash
# Cloudflare: use a newly created, least-privilege API token.
sk connectors create --template cloudflare --name cloudflare-prod
sk credentials set <CONNECTOR_ID> --mode bearer --token '<NEW_SCOPED_TOKEN>'

# Firebase: store the Google OAuth client once per tenant/template, then authorize the connector.
sk connector-templates set-oauth --slug firebase \
  --client-id '<GOOGLE_OAUTH_CLIENT_ID>' \
  --client-secret '<GOOGLE_OAUTH_CLIENT_SECRET>'
sk connectors create --template firebase --name firebase-prod
sk auth --connector-id <CONNECTOR_ID>
```

Revoke any Cloudflare token that has appeared in chat, logs, shell history, or source control.
Firebase ID tokens are also accepted as short-lived Bearer credentials for end-user flows; a
service-account JSON key is not an OAuth client secret.

## Connecting a remote MCP server

A remote Model Context Protocol server is a connector like any other — driver
`mcp`. There is no separate MCP-server registry to learn: the same create,
patch, enable, disable, and delete commands apply, the secret goes in the same
vault, and it shows up in the same catalog under the `mcp` driver.

```bash
# driver "mcp", base_url = the server endpoint,
# config: { mcp: { transport: "http", auth: { kind: … } } }
sk connectors create --file server.json
sk credentials set <CONNECTOR_ID> --mode bearer --token '<TOKEN>'

sk connectors mcp-inspect <CONNECTOR_ID>    # one handshake: what does it serve?
sk connectors mcp-authorize <CONNECTOR_ID>  # interactive OAuth 2.1, when the server needs it
```

`mcp-inspect` performs a single handshake and reports the remote's negotiated
capabilities, its instructions, and its tool manifest — the fastest way to
confirm a server is reachable and authorised before anyone authors against it.
`mcp-authorize` is for servers that publish their authorization server through
protected-resource metadata rather than declaring an issuer in config; the
generic connector OAuth flow cannot serve those.

Never put a token in `config`. The `mcp.auth` block is refused at the storage
layer if it carries a secret-shaped key — a database `CHECK`, not a convention.

**The operator off switch works on every driver:**

```bash
sk connectors disable <CONNECTOR_ID>
sk connectors enable  <CONNECTOR_ID>
```

Disabling is immediate and honest: an MCP connector's pooled session is evicted
and a Postgres connector's pool is closed on the way out, so nothing keeps
serving past the switch. A disabled connector is also skipped by the reauth
scan — for MCP that scan is a full handshake, and probing a server an operator
deliberately turned off would park it in backoff for no reason.

Four fields are worth knowing when a remote misbehaves, and every one of them
is written by the engine rather than copied from the upstream — a remote's own
error body can echo the credential it just rejected, so it stays in the
engine's logs and never lands in a field you can export or render.
`last_error` is the engine's account of the most recent failed attempt, in the
form `[<error_code>] <sentence>`. `health_state` is the reconciled verdict
(`ok`, `degraded`, `needs_update`, `needs_reauth`) — whether the engine
considers the connector usable at all, which is a different question from the
`enabled` switch. `health_reason` and `health_error_code` say what the last
change of that verdict was. All four are readable on `GET /v1/connectors` and
on the single-connector GET. Repeated handshake failures count in the database
and arm a backoff that survives an engine restart — so a server that has been
refusing for an hour is not handed a full-rate retry just because the process
bounced.

## Health and validation

Every connector can be tested independently of any workflow. The engine validates
the connection, authenticates with the configured credentials, and reports the
result plus connection latency. Connector tests and workflow request steps share
the same request-execution path, so a passing test reflects the exact transport a
workflow will use.

```bash
sk connectors test <CONNECTOR_ID>   # re-probe connectivity
```

A draft connector with no saved credential cannot be probed: the probe path
returns a structured `credential_required` envelope rather than silently sending
an unauthenticated request.

## Ad-hoc invocation

Once a connector is persisted, invoke any endpoint against it — for sampling,
pagination validation, or response-shape inspection — without authoring a
workflow. The conversational `call_connector` tool and the matching
`POST /v1/connectors/{id}/call` route apply the saved credential, emit a
`connector.invoked` audit row, and return status, headers, body, latency, and a
truncation flag.

```bash
curl -X POST "$SK_BASE_URL/v1/connectors/$CONNECTOR_ID/call" \
  -H "Authorization: Bearer $SK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "method": "GET", "path": "/v2/droplets", "query": { "per_page": 10 } }'
```

| Driver | `call_connector` (conversational tool) | `POST /v1/connectors/{id}/call` |
|---|---|---|
| HTTP | Supported | Supported |
| GraphQL | Supported | Supported |
| Postgres / S3 | Supported | Returns `driver_not_supported_for_call_connector` |
| MCP | Not applicable — see below | Not applicable — see below |

An unsupported driver returns a structured `driver_not_supported_for_call_connector`
envelope pointing at workflow authoring, rather than failing opaquely.

MCP connectors are outside this surface by shape, not by omission: a remote tool
takes a name and typed arguments, not a method and a path. Invoke one from a
workflow `request` step carrying an `mcp` block, or from chat, where every tool the
server publishes already appears as `mcp_<connector-slug>__<tool>`. To see what a
server offers without calling anything, use `sk connectors mcp-inspect <ID>`.

## Keeping a fleet healthy

Drift is detected from actual execution results, not periodic polling — a
connector that worked last month surfaces drift the moment a real run hits a
changed response shape. That drift feeds the operator-reviewed repair loop in
[Self-healing](./self-healing.md).

To proactively re-verify templates against live vendor APIs, run the vendor-drift
sweep documented in
[Connectors & Integration → Vendor-drift Sweep](../concepts/connectors.md#vendor-drift-sweep).

---

## Further reading

- [Connectors & Integration](../concepts/connectors.md) — the full conceptual model and route surface.
- [Credentials & Keys](../admins/credentials-and-keys.md) — the credential vault and rotation.
- [Self-healing](./self-healing.md) — how connector drift becomes an operator-reviewed Patch Candidate.
