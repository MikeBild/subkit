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

  // The reserved constants above are the only assertions in this file.
  // The writers that will eventually emit each action are tracked on
  // their owning issues (#171 for mcp_server.*; per-connector issues
  // for external_provider.*). #178 round-3 S3.
});
