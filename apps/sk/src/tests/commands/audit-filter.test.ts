import { expect, test } from "bun:test";
import { auditFilterQuery } from "../../commands/audit-filter.ts";

test("sk audit query and export forward the same provenance and identity filters", () => {
  const query = auditFilterQuery({
    actor: "11111111-1111-4111-8111-111111111111",
    "api-key-id": "22222222-2222-4222-8222-222222222222",
    "session-id": "33333333-3333-4333-8333-333333333333",
    "access-type": "mcp_oauth",
    "oauth-client-id": "client-42",
    "request-source": "cli",
    "origin-source": "mcp",
    "execution-source": "queue",
    "correlation-id": "a".repeat(32),
    "resource-type": "knowledge_source",
    "resource-types": "knowledge_source,skill",
    "resource-id": "44444444-4444-4444-8444-444444444444",
    result: "denied",
  });
  expect(query).toEqual({
    actor_id: "11111111-1111-4111-8111-111111111111",
    api_key_id: "22222222-2222-4222-8222-222222222222",
    session_id: "33333333-3333-4333-8333-333333333333",
    access_type: "mcp_oauth",
    oauth_client_id: "client-42",
    request_source: "cli",
    origin_source: "mcp",
    execution_source: "queue",
    correlation_id: "a".repeat(32),
    resource_type: "knowledge_source",
    resource_types: "knowledge_source,skill",
    resource_id: "44444444-4444-4444-8444-444444444444",
    result: "denied",
  });
});
