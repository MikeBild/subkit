import { expect, test } from "bun:test";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getContext, type LogContext, withContext } from "../../logging/context.ts";
import { bindStdioPrincipalContext } from "./stdio.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";

function principal(kind: "api_key" | "token_exchange"): ResolvedPrincipal {
  return {
    provider: kind,
    kind: "user",
    id: actorId,
    tenant_id: tenantId,
    roles: ["admin"],
    api_key_id: keyId,
    credential_origin: "cli_oauth_session",
    oauth_client_id: "verified-client",
    auth_source:
      kind === "api_key"
        ? { kind, api_key_id: keyId, credential_version: "verified" }
        : {
            kind,
            api_key_id: keyId,
            credential_version: "verified",
            expires_at: "2026-10-21T00:00:00.000Z",
          },
    ...(kind === "token_exchange" ? { via: "token_exchange" as const } : {}),
  };
}

test("stdio handlers inherit verified API-key and OAuth provenance for each message", async () => {
  const transport = new StdioServerTransport();
  const observed: LogContext[] = [];
  const pending: Promise<void>[] = [];
  transport.onmessage = () => {
    pending.push(
      Promise.resolve().then(() => {
        observed.push(getContext());
      }),
    );
  };
  bindStdioPrincipalContext(transport, principal("api_key"));

  await withContext({ tenant_id: "forged", api_key_id: "forged" }, async () => {
    transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });
    transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
    await Promise.all(pending);
  });

  expect(observed).toHaveLength(2);
  for (const context of observed) {
    expect(context).toMatchObject({
      tenant_id: tenantId,
      actor_id: actorId,
      api_key_id: keyId,
      audit_access_type: "api_key",
      audit_oauth_client_id: "verified-client",
      audit_credential_origin: "cli_oauth_session",
      request_source: "cli",
      audit_origin_source: "mcp",
      audit_execution_source: "mcp",
    });
  }
  expect(observed[0]?.trace_id).not.toBe(observed[1]?.trace_id);
});

test("stdio token exchange retains the verified key and exchange provenance", () => {
  const transport = new StdioServerTransport();
  let observed: LogContext | undefined;
  transport.onmessage = () => {
    observed = getContext();
  };
  bindStdioPrincipalContext(transport, principal("token_exchange"));
  transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });

  expect(observed).toMatchObject({
    tenant_id: tenantId,
    api_key_id: keyId,
    audit_access_type: "token_exchange",
    audit_oauth_client_id: "verified-client",
    audit_credential_origin: "cli_oauth_session",
    auth_via: "token_exchange",
  });
});

test("stdio does not promote an unverified key field or ambient context into audit provenance", () => {
  const transport = new StdioServerTransport();
  let observed: LogContext | undefined;
  transport.onmessage = () => {
    observed = getContext();
  };
  const unverified = principal("api_key");
  delete unverified.auth_source;
  bindStdioPrincipalContext(transport, unverified);

  withContext({ api_key_id: "ambient-key", audit_access_type: "api_key" }, () => {
    transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  expect(observed?.api_key_id).toBeUndefined();
  expect(observed?.audit_access_type).toBeUndefined();
  expect(observed?.audit_oauth_client_id).toBeUndefined();
  expect(observed?.audit_credential_origin).toBeUndefined();
});
