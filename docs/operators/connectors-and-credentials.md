# Connectors & Credentials (operator guide)

> **Audience:** Operators registering connectors, managing credentials, and
> keeping integrations healthy in production.

This is the operational slice of the connector subsystem: how to attach and
rotate credentials, test connectivity on demand, invoke an endpoint ad-hoc, and
run the vendor-drift sweep. For the full conceptual model — drivers, templates,
the catalog, schema-version drift — see
[Connectors & Integration](../concepts/connectors.md).

---

## Authentication and credential management

sk supports the authentication patterns enterprise systems actually use: API key, OAuth2 (authorisation-code and client-credentials flows), basic auth, and custom header schemes.

OAuth2 flows are managed entirely by the platform. The engine handles token refresh, expiry detection, and token rotation automatically. An operator configures an OAuth2 connector once; the platform handles re-authentication as tokens expire. No workflow needs to manage token lifecycle.

All secrets live in the Credential Vault — encrypted at rest, never logged, never exposed outside the engine. Workflows and steps reference credentials by name, not by value. The full vault model and master-key rotation procedure are in [Credentials & Keys](../admins/credentials-and-keys.md).

End-User Credentials extend this for multi-user scenarios: an individual user supplies their own credentials for a connector, and the platform acts as that user when executing on their behalf — proper delegation, not credential sharing.

Attach a credential from the CLI:

```bash
sk connectors credentials set <CONNECTOR_ID> --mode bearer --token sk_live_…
#   modes: bearer | header | query | basic | aws_sigv4 | none
sk connectors credentials list <CONNECTOR_ID>
```

## Health and validation

Every connector can be tested independently of any workflow. The engine validates the connection, authenticates with the configured credentials, and reports the result along with connection latency. Connector tests and workflow request steps share the same underlying request execution path, so a successful test reflects the same transport a workflow will use.

```bash
sk connectors test <CONNECTOR_ID>   # re-probe connectivity
```

A draft connector that does not yet have a saved credential cannot be probed: the probe path returns a structured `credential_required` envelope rather than silently sending an unauthenticated request.

## Ad-hoc invocation

Once a connector is persisted, you can invoke any endpoint against it for sampling, pagination validation, or response-shape inspection — without authoring a workflow. The conversational `call_connector` tool and the matching `POST /v1/connectors/{id}/call` route apply the saved credential, emit a `connector.invoked` audit row, and return status, headers, body, latency, and a truncation flag.

```bash
curl -X POST "$SK_BASE_URL/v1/connectors/$CONNECTOR_ID/call" \
  -H "Authorization: Bearer $SK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "method": "GET", "path": "/v2/droplets", "query": { "per_page": 10 } }'
```

Driver coverage for `call_connector` is HTTP and GraphQL; Postgres / S3 / SQL Server / file-transfer drivers return a structured `driver_not_supported_for_call_connector` envelope pointing at workflow authoring instead.

## Keeping a fleet healthy

Drift is detected from actual execution results, not periodic polling — a connector that worked last month surfaces drift the moment a real run encounters a changed response shape. That drift feeds the operator-reviewed repair loop described in [Self-healing](./self-healing.md). To proactively re-verify templates against live vendor APIs, run the vendor-drift sweep documented in [Connectors & Integration → Vendor-drift Sweep](../concepts/connectors.md#vendor-drift-sweep).

---

## Further reading

- [Connectors & Integration](../concepts/connectors.md) — the full conceptual model and route surface.
- [Credentials & Keys](../admins/credentials-and-keys.md) — the credential vault and rotation.
- [Self-healing](./self-healing.md) — how connector drift becomes an operator-reviewed Patch Candidate.
