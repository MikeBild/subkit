import { describe, expect, test } from "bun:test";
import { conversationToolProvider } from "../../../tools/providers/conversation.ts";
import { buildPendingOutputForTool, resolveToolMode } from "../../tool-policies.ts";
import { getTool, type ToolContext } from "../index.ts";
import {
  applyPackageImportTool,
  exportTenantPackageTool,
  previewPackageImportTool,
} from "../package-portability.ts";

const ctx = { tenant_id: "t", principal: null } as unknown as ToolContext;

function mcpNames(mcpMode: "product" | "authoring" | "admin", readOnly = false): Set<string> {
  return new Set(
    conversationToolProvider
      .list({ surface: "mcp", mcpMode, readOnly })
      .map((d: { name: string }) => d.name),
  );
}

describe("package portability tools", () => {
  test("are registered with their permission and category", () => {
    expect(getTool("export_tenant_package")?.permission?.action).toBe("package:export");
    expect(getTool("preview_package_import")?.permission?.action).toBe("package:import");
    expect(getTool("apply_package_import")?.permission?.action).toBe("package:import");
    expect(exportTenantPackageTool.category).toBe("tenant_write");
    expect(previewPackageImportTool.category).toBe("tenant_read");
    expect(applyPackageImportTool.category).toBe("tenant_write");
  });

  test("carry the permission on the MCP dispatcher path", () => {
    const byName = new Map(
      conversationToolProvider
        .list({ surface: "mcp", mcpMode: "admin" })
        .map((d: { name: string; rbac?: { permission: string } }) => [d.name, d]),
    );
    expect(byName.get("export_tenant_package")?.rbac?.permission).toBe("package:export");
    expect(byName.get("preview_package_import")?.rbac?.permission).toBe("package:import");
    expect(byName.get("apply_package_import")?.rbac?.permission).toBe("package:import");
  });

  test("never reach product mode; writes only where tenant writes are allowed", () => {
    const product = mcpNames("product");
    const authoring = mcpNames("authoring", true);
    const admin = mcpNames("admin");
    for (const name of ["export_tenant_package", "preview_package_import", "apply_package_import"])
      expect(product.has(name)).toBe(false);
    expect(authoring.has("preview_package_import")).toBe(true);
    expect(authoring.has("export_tenant_package")).toBe(false);
    expect(authoring.has("apply_package_import")).toBe(false);
    expect(admin.has("export_tenant_package")).toBe(true);
    expect(admin.has("apply_package_import")).toBe(true);
    expect(mcpNames("admin", true).has("apply_package_import")).toBe(false);
  });

  test("apply always asks before execution; export prepares without asking", () => {
    for (const permission_mode of [null, "auto", "ask"] as const) {
      expect(
        resolveToolMode({
          tool: "apply_package_import",
          category: "tenant_write",
          input: { file_id: "fid_x", expected_plan_digest: "d" },
          overrides: {},
          permission_mode,
        }),
      ).toBe("confirm_before_execution");
    }
    expect(
      resolveToolMode({
        tool: "export_tenant_package",
        category: "tenant_write",
        input: {},
        overrides: {},
        permission_mode: "auto",
      }),
    ).toBe("no_confirm");
    expect(
      buildPendingOutputForTool("apply_package_import", {
        file_id: "fid_x",
        expected_plan_digest: "d",
      }),
    ).toEqual({ file_id: "fid_x", expected_plan_digest: "d" });
  });

  test("reject file ids without the fid_ form before touching storage", async () => {
    const preview = await previewPackageImportTool.execute(ctx, {
      file_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(preview).toMatchObject({ ok: false, error_code: "invalid_file_id" });
  });

  test("writes require an authenticated caller", async () => {
    expect(await exportTenantPackageTool.execute(ctx, {})).toMatchObject({
      ok: false,
      error_code: "authentication_required",
    });
    expect(
      await applyPackageImportTool.execute(ctx, { file_id: "fid_x", expected_plan_digest: "d" }),
    ).toMatchObject({ ok: false, error_code: "authentication_required" });
  });

  test("inputs are strict", () => {
    expect(exportTenantPackageTool.inputSchema.safeParse({ kinds: ["workflow"] }).success).toBe(
      true,
    );
    expect(exportTenantPackageTool.inputSchema.safeParse({ kinds: ["secret"] }).success).toBe(
      false,
    );
    expect(
      exportTenantPackageTool.inputSchema.safeParse({ categories: ["devops", "cloud"] }).success,
    ).toBe(true);
    expect(exportTenantPackageTool.inputSchema.safeParse({ categories: [] }).success).toBe(false);
    expect(exportTenantPackageTool.inputSchema.safeParse({ categories: [""] }).success).toBe(false);
    expect(applyPackageImportTool.inputSchema.safeParse({ file_id: "fid_x" }).success).toBe(false);
  });
});
