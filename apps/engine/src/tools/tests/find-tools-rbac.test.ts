import { describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/types.ts";
import { dispatchTool } from "../dispatcher.ts";
import { getUnifiedRegistry } from "../index.ts";
import { makeStubDb, makeTestPrincipal, usePolicyFixture } from "./_helpers.ts";

usePolicyFixture();

const CASES = [
  { name: "find_workflow", permission: "workflow:read" },
  { name: "find_user", permission: "identity:read" },
  { name: "find_role", permission: "rbac:read" },
  { name: "find_skill", permission: "skill:read" },
  { name: "find_connector", permission: "connector:read" },
  { name: "find_task", permission: "task:read" },
  { name: "list_workflows", permission: "workflow:read" },
  { name: "list_users", permission: "identity:read" },
  { name: "list_skills", permission: "skill:read" },
] as const;

async function dispatch(name: string, scopes: string[]) {
  const { db, capture } = makeStubDb();
  const principal = makeTestPrincipal({ roles: ["admin"], scopes });
  const envelope = await dispatchTool(
    { registry: getUnifiedRegistry(), db, principal, mcpMode: "admin", readOnly: false },
    { surface: "mcp", name, args: { query: "orders" } },
  );
  const denied = capture.inserts.filter((row) => row.action === AuditAction.POLICY_DENIED);
  return { envelope, denied };
}

describe("find_* tools gate on their read permission over MCP", () => {
  for (const c of CASES) {
    test(`${c.name} carries ${c.permission} on its MCP descriptor`, () => {
      const entry = getUnifiedRegistry().get(c.name, { surface: "mcp", mcpMode: "admin" });
      expect(entry?.descriptor.rbac?.permission).toBe(c.permission);
    });

    test(`${c.name} is denied under a metrics:read-only ceiling`, async () => {
      const { envelope, denied } = await dispatch(c.name, ["metrics:read"]);
      expect(envelope.status).toBe("error");
      if (envelope.status === "error") expect(envelope.error_code).toBe("policy_denied");
      expect(denied.length).toBe(1);
    });

    test(`${c.name} passes the gate for an admin`, async () => {
      const { envelope, denied } = await dispatch(c.name, []);
      if (envelope.status === "error") expect(envelope.error_code).not.toBe("policy_denied");
      expect(denied.length).toBe(0);
    });
  }
});
