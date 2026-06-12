import { describe, expect, test } from "bun:test";
import type { SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchAdminListSlash } from "../repl/slash/handlers/admin-lists.ts";

function buildCtx(client: Partial<SlashHandlerContext["client"]>): SlashHandlerContext {
  return {
    client: client as SlashHandlerContext["client"],
    profile: {} as SlashHandlerContext["profile"],
    session: {} as SlashHandlerContext["session"],
    setConversationId: () => {},
    allowedPermissions: [],
  };
}

describe("dispatchAdminListSlash", () => {
  test("returns undefined for unknown names — caller falls through", async () => {
    const result = await dispatchAdminListSlash("not-a-real-admin-slash", buildCtx({}));
    expect(result).toBeUndefined();
  });

  test("/connectors empty list returns the canonical banner", async () => {
    const ctx = buildCtx({
      listConnectors: () => Promise.resolve({ items: [], total: 0 }),
    });
    const result = await dispatchAdminListSlash("connectors", ctx);
    expect(result).toBe("no connectors");
  });

  test("/connectors renders rows from the typed openapi shape (R9-W1)", async () => {
    const ctx = buildCtx({
      listConnectors: () =>
        Promise.resolve({
          items: [
            {
              id: "c1abcd1234ef",
              tenant_id: "t-test",
              slug: "stripe-prod",
              display_name: "Stripe Production",
              driver: "http",
              environment: "prod",
              auth_type: "bearer",
              base_url: null,
              dsn: null,
              config: {},
              operator_quirks: {} as Record<string, unknown>,
              template_slug: null,
              template_name: null,
              template_source: null,
              template_version: null,
              template_snapshot: null,
              created_at: "2025-01-01",
              updated_at: "2025-01-01",
            },
          ],
          total: 1,
        }),
    });
    const result = await dispatchAdminListSlash("connectors", ctx);
    expect(result).toContain("connectors");
    expect(result).toContain("c1abcd12");
    expect(result).toContain("Stripe Production");
    expect(result).toContain("stripe-prod");
    // Ground-truth cardinality: the footer names the exact total.
    expect(result).toContain("1 total");
  });

  test("/workflows empty list returns the canonical banner", async () => {
    const ctx = buildCtx({
      listWorkflows: () => Promise.resolve({ items: [], total: 0 }),
    });
    const result = await dispatchAdminListSlash("workflows", ctx);
    expect(result).toBe("no workflows");
  });

  test("/executions and /runs both reach the same handler branch", async () => {
    const ctx = buildCtx({
      listExecutions: () => Promise.resolve({ items: [], total: 0 }),
    });
    expect(await dispatchAdminListSlash("executions", ctx)).toBe("no executions");
    expect(await dispatchAdminListSlash("runs", ctx)).toBe("no executions");
  });
});
