import { describe, expect, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { SlashHandlerContext } from "../repl/slash/handler.ts";
import { dispatchAdminListSlash } from "../repl/slash/handlers/admin-lists.ts";

type Schemas = components["schemas"];

type FakeClient = Record<string, (...args: never[]) => Promise<unknown>>;

function buildCtx(client: FakeClient): SlashHandlerContext {
  return {
    client: client as unknown as SlashHandlerContext["client"],
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
      listConnectors: () => Promise.resolve({ items: [], total: 0, categories: [] }),
    });
    const result = await dispatchAdminListSlash("connectors", ctx);
    expect(result).toBe("no connectors");
  });

  test("/connectors renders rows from the typed openapi shape", async () => {
    const connector = {
      id: "c1abcd1234ef",
      tenant_id: "t-test",
      slug: "stripe-prod",
      display_name: "Stripe Production",
      description: null,
      description_source: "human",
      category: "payments",
      category_source: "human",
      driver: "http",
      environment: "prod",
      auth_type: "bearer",
      base_url: null,
      dsn: null,
      config: {},
      operator_quirks: {},
      template_slug: null,
      template_name: null,
      template_source: null,
      template_version: null,
      template_snapshot: null,
      enabled: true,
      last_error: null,
      health_state: "ok",
      health_reason: null,
      health_error_code: null,
      circuit_state: "closed",
      circuit_opened_at: null,
      circuit_failure_count: 0,
      needs_reauth: false,
      auth_failed_at: null,
      auth_failed_reason: null,
      sign_in: null,
      created_at: "2025-01-01",
      updated_at: "2025-01-01",
      last_tested_at: null,
      tools_count: null,
    } satisfies Schemas["Connector"];
    const ctx = buildCtx({
      listConnectors: () => Promise.resolve({ items: [connector], total: 1, categories: [] }),
    });
    const result = await dispatchAdminListSlash("connectors", ctx);
    expect(result).toContain("connectors");
    expect(result).toContain("c1abcd12");
    expect(result).toContain("Stripe Production");
    expect(result).toContain("stripe-prod");
    expect(result).toContain("1 total");
  });

  test("/workflows empty list returns the canonical banner", async () => {
    const ctx = buildCtx({
      listWorkflows: () => Promise.resolve({ items: [], total: 0, categories: [] }),
    });
    const result = await dispatchAdminListSlash("workflows", ctx);
    expect(result).toBe("no workflows");
  });

  test("/executions and /runs both reach the same handler branch", async () => {
    const ctx = buildCtx({
      listExecutions: () => Promise.resolve({ items: [], total: 0, next_cursor: null }),
    });
    expect(await dispatchAdminListSlash("executions", ctx)).toBe("no executions");
    expect(await dispatchAdminListSlash("runs", ctx)).toBe("no executions");
  });

  test("/packages empty list returns the canonical banner", async () => {
    const ctx = buildCtx({ listPackageInstalls: () => Promise.resolve([]) });
    expect(await dispatchAdminListSlash("packages", ctx)).toBe("no package imports");
  });

  test("/packages renders one row per import", async () => {
    const ctx = buildCtx({
      listPackageInstalls: () =>
        Promise.resolve([
          {
            id: "a1b2c3d4e5f6",
            package_id: "tenant-export",
            package_version: "1",
            format: "subkit-package/v1",
            content_digest: "d",
            archive_file_id: null,
            source: {},
            installed_by_type: "user",
            installed_by_id: null,
            summary: {},
            created_at: "2025-01-01",
            updated_at: "2025-01-01",
          },
        ]),
    });
    const result = await dispatchAdminListSlash("packages", ctx);
    expect(result).toContain("package imports");
    expect(result).toContain("a1b2c3d4");
    expect(result).toContain("tenant-export");
    expect(result).toContain("1 found");
  });

  test("/notifications renders channel platform and target from the contract shape", async () => {
    const ctx = buildCtx({
      listNotificationChannels: () =>
        Promise.resolve({
          items: [
            {
              id: "ch123456789",
              tenant_id: "t-test",
              workspace_id: "T0123456",
              channel_id: "C0123456",
              platform: "slack",
              default_severity: "warn",
              rate_limit_per_minute: 30,
              circuit_state: "closed",
              circuit_open_until: null,
              consecutive_failures: 0,
              active: true,
              created_at: "2025-01-01",
              updated_at: "2025-01-01",
            },
          ],
        }),
      listNotificationRules: () =>
        Promise.resolve({
          items: [
            {
              id: "ru123456789",
              tenant_id: "t-test",
              name: "failures",
              event_pattern: "execution.failed",
              workflow_pattern: "*",
              severity: "error",
              request_source_filter: null,
              target_workspace_id: "T0123456",
              target_channel_id: "C0123456",
              active: true,
              created_at: "2025-01-01",
              updated_at: "2025-01-01",
            },
          ],
        }),
    });
    const result = await dispatchAdminListSlash("notifications", ctx);
    expect(result).toContain("channels (1):");
    expect(result).toMatch(/ch123456 {2}slack {17}T0123456\/C0123456/);
    expect(result).toContain("rules (1):");
    expect(result).toContain("ru123456  execution.failed");
    expect(result).toContain("→ T0123456/C0123456");
  });

  test("/notifications falls back to empty lists when either call fails", async () => {
    const ctx = buildCtx({
      listNotificationChannels: () => Promise.reject(new Error("forbidden")),
      listNotificationRules: () => Promise.reject(new Error("forbidden")),
    });
    const result = await dispatchAdminListSlash("notifications", ctx);
    expect(result).toContain("channels (0):");
    expect(result).toContain("rules (0):");
  });

  test("/users shows the user status the contract carries", async () => {
    const ctx = buildCtx({
      listIdentityUsers: () =>
        Promise.resolve({
          items: [
            {
              id: "u1234567890",
              tenant_id: "t-test",
              email: "ops@acme.test",
              display_name: null,
              role: "admin",
              status: "invited",
              oauth_connections: 0,
              created_at: "2025-01-01",
              updated_at: "2025-01-01",
              groups: null,
              identities: [],
            },
          ],
        }),
    });
    const result = await dispatchAdminListSlash("users", ctx);
    expect(result).toMatch(/u1234567 {2}ops@acme\.test {17} {2}invited/);
    expect(result).toContain("1 found");
  });

  test("/apikeys renders an unnamed key with a blank name column", async () => {
    const ctx = buildCtx({
      listApiKeys: () =>
        Promise.resolve({
          items: [{ id: "k1234567890", name: null, prefix: "sk_live_ab" }],
        }),
    });
    const result = await dispatchAdminListSlash("apikeys", ctx);
    expect(result).toMatch(/k1234567 {24}sk_live_ab/);
    expect(result).toContain("1 keys");
  });

  test("/discovery renders label and status, blank label when null", async () => {
    const ctx = buildCtx({
      listDiscoveryRuns: () =>
        Promise.resolve({
          items: [
            { id: "d1234567890", label: "crm import", status: "completed" },
            { id: "d2234567890", label: null, status: "failed" },
          ],
        }),
    });
    const result = await dispatchAdminListSlash("discovery", ctx);
    expect(result).toContain("d1234567  crm import");
    expect(result).toMatch(/d2234567 {24}failed/);
  });

  test("/patch-candidates renders id, workflow and status", async () => {
    const ctx = buildCtx({
      listPatchCandidates: () =>
        Promise.resolve({
          items: [{ id: "pc123456789", workflow_id: "wf123456789", status: "proposed" }],
          total: 1,
          reviewable_total: 1,
        }),
    });
    const result = await dispatchAdminListSlash("patch-candidates", ctx);
    expect(result).toContain("pc123456  wf:wf123456  proposed");
    expect(result).toContain("1 pending");
  });
});
