// Audit-contract guard for the reserved `mcp_server.*` and
// `external_provider.*` constants (issue #166 review W2).
//
// `mcp_server.*` constants land their writers with #171 (MCP client
// pool + registry). `external_provider.*` constants stay reserved for
// the first opt-in, connector-shaped external-call writer that lands
// under a per-tenant budget — not for engine-baseline integrations
// (the runtime-independence policy closed #167 / #168 / #174). Until
// those writers exist there is nothing to integration-test, but the
// presence-check below fails-fast if a future cleanup removes the
// reserved entries before the writers have switched to them — which
// would silently allow the writer to mint free-string action values.
//
// When a writer arrives, replace the relevant `it.todo(...)` with a
// real integration test that asserts the writer emits exactly the
// reserved action plus the expected metadata fields.

import { describe, expect, it } from "bun:test";
import { AuditAction } from "../types.ts";

describe("issue #166 W2 — reserved audit-action constants", () => {
  it("reserves the seven mcp_server.* constants", () => {
    expect(AuditAction.MCP_SERVER_REGISTERED).toBe("mcp_server.registered");
    expect(AuditAction.MCP_SERVER_CONFIG_UPDATED).toBe("mcp_server.config_updated");
    expect(AuditAction.MCP_SERVER_DISABLED).toBe("mcp_server.disabled");
    expect(AuditAction.MCP_SERVER_RE_ENABLED).toBe("mcp_server.re_enabled");
    expect(AuditAction.MCP_SERVER_ERRORED).toBe("mcp_server.errored");
    expect(AuditAction.MCP_SERVER_DELETED).toBe("mcp_server.deleted");
    expect(AuditAction.MCP_SERVER_HANDSHAKE_OK).toBe("mcp_server.handshake_ok");
  });

  it("reserves the two external_provider.* constants", () => {
    expect(AuditAction.EXTERNAL_PROVIDER_CALL_SUCCEEDED).toBe("external_provider.call_succeeded");
    expect(AuditAction.EXTERNAL_PROVIDER_CALL_FAILED).toBe("external_provider.call_failed");
  });

  // mcp-server writers land with #171. Each `todo` is a slot for the
  // matching integration test once the writer module exists.
  it.todo("mcp-server registry writer emits MCP_SERVER_REGISTERED on insert (#171)", () => {});
  it.todo("mcp-server registry writer emits MCP_SERVER_CONFIG_UPDATED on update (#171)", () => {});
  it.todo("mcp-server registry writer emits MCP_SERVER_DELETED on delete (#171)", () => {});
  it.todo("mcp-client pool emits MCP_SERVER_HANDSHAKE_OK on successful handshake (#171)", () => {});
  it.todo("mcp-client pool emits MCP_SERVER_ERRORED on handshake failure (#171)", () => {});
  // EXTERNAL_PROVIDER_CALL_* writers are reserved for the first opt-in,
  // connector-shaped external-call site that lands under a per-tenant
  // budget — not for engine-baseline integrations. Engine-baseline
  // proposals (Cohere rerank, Firecrawl, Exa) were dropped under the
  // runtime-independence policy.
  it.todo("connector-shaped external-provider writer emits EXTERNAL_PROVIDER_CALL_SUCCEEDED on ok", () => {});
  it.todo("connector-shaped external-provider writer emits EXTERNAL_PROVIDER_CALL_FAILED on error", () => {});
});
