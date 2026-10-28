import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { ToolContext } from "../index.ts";
import {
  applyPackageImportTool,
  exportTenantPackageTool,
  previewPackageImportTool,
} from "../package-portability.ts";

let fixture: ConversationTestCtx;
let ctx: ToolContext;

beforeAll(async () => {
  fixture = await createConversationTestCtx("package_tools");
  const principal = {
    id: fixture.user_id,
    tenant_id: fixture.tenant_id,
    kind: "user",
    provider: "local",
    roles: [],
    scopes: [],
  } as unknown as ResolvedPrincipal;
  ctx = {
    db: fixture.testDb.db,
    tenant_id: fixture.tenant_id,
    conversation_id: "00000000-0000-4000-8000-000000000001",
    actor_id: fixture.user_id,
    principal,
    connector_id: null,
    workflow_id: null,
    getDraft: () => createEmptyDraftDocument(),
    setDraft: async () => {},
  } as unknown as ToolContext;
});

afterAll(async () => {
  await fixture?.cleanup();
});

const ZIP_MAGIC = "PK\u0003\u0004";

describe("package tools against a real tenant", () => {
  let fileId: string;
  let planDigest: string;

  test("export returns a file reference, never archive bytes", async () => {
    const result = await exportTenantPackageTool.execute(ctx, {});
    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    const encoded = JSON.stringify(data);
    expect(encoded).not.toContain(ZIP_MAGIC);
    expect(encoded).not.toContain("UEsDB");
    expect(encoded.length).toBeLessThan(4_000);
    const inputFile = data.input_file as { id: string; sha256: string };
    expect(inputFile.id).toMatch(/^fid_[0-9a-f-]{36}$/);
    expect(inputFile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.size_bytes).toBeGreaterThan(0);
    expect(Object.keys(data).sort()).toEqual([
      "content_digest",
      "filename",
      "input_file",
      "items_summary",
      "requires",
      "size_bytes",
    ]);
    fileId = inputFile.id;
  });

  test("preview reads the stored package and returns a compact plan", async () => {
    const result = await previewPackageImportTool.execute(ctx, { file_id: fileId });
    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(JSON.stringify(data)).not.toContain(ZIP_MAGIC);
    expect(typeof data.plan_digest).toBe("string");
    expect(data.summary).toBeDefined();
    expect(Array.isArray(data.items)).toBe(true);
    for (const item of data.items as { action: string }[]) {
      expect(item.action).not.toBe("unchanged");
      expect(item).not.toHaveProperty("local_id");
    }
    planDigest = data.plan_digest as string;
  });

  test("apply refuses a digest that does not match the current plan", async () => {
    const result = await applyPackageImportTool.execute(ctx, {
      file_id: fileId,
      expected_plan_digest: "0".repeat(64),
    });
    expect(result).toMatchObject({
      ok: false,
      error_code: "package_plan_changed",
      next_best_actions: ["preview_package_import"],
    });
    expect(JSON.stringify(result)).not.toContain(planDigest);
  });

  test("apply with the previewed digest imports and reports a summary", async () => {
    const result = await applyPackageImportTool.execute(ctx, {
      file_id: fileId,
      expected_plan_digest: planDigest,
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.plan_digest).toBe(planDigest);
    expect(data.summary).toBeDefined();
    expect(JSON.stringify(data)).not.toContain(ZIP_MAGIC);
  });

  test("an unknown package file is reported clearly", async () => {
    const result = await previewPackageImportTool.execute(ctx, {
      file_id: "fid_00000000-0000-4000-8000-000000000000",
    });
    expect(result).toMatchObject({ ok: false, error_code: "package_archive_not_found" });
  });
});
