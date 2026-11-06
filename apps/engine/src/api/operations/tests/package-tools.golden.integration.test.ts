import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { toFileId } from "../../../api/files-schemas.ts";
import type { ToolContext } from "../../../conversations/tools/index.ts";
import { applyPackageImportTool } from "../../../conversations/tools/package-portability.ts";
import { auditLog } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import {
  loadStoredPackageArchive,
  previewPackageImport,
  storePackageArchive,
} from "../../../identity/index.ts";
import { makeToolCtx } from "../../../test-helpers/seed.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";

const GOLDEN_PATH = new URL("./fixtures/package-tools.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let source: HttpTestServer;
let target: HttpTestServer;
let archiveFileId: string;
let widerFileId: string;
let brokenFileId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(source.tenantId, "<source-tenant>")
    .replaceAll(target.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, "<sha256>")
    .replace(/"(size_bytes|size_bytes_bucket)":\d+/g, '"$1":"<size>"')
    .replace(/"(sha256_prefix)":"[0-9a-f]+"/g, '"$1":"<prefix>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function toolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return makeToolCtx({
    db: target.db,
    tenant_id: target.tenantId,
    actor_id: target.userId,
    principal: makeTestPrincipal({
      id: target.userId,
      tenant_id: target.tenantId,
      roles: ["admin"],
    }),
    ...overrides,
  });
}

async function planDigest(fileId: string): Promise<string> {
  const stored = await loadStoredPackageArchive(target.db, target.tenantId, fileId);
  return (await previewPackageImport(target.db, target.tenantId, stored.bytes)).plan_digest;
}

async function importAudit(): Promise<string[]> {
  const rows = await target.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, target.tenantId), eq(auditLog.action, "data.imported")));
  return rows
    .map((row) => scrub(row).replaceAll(target.userId, "<admin>").replace(UUID, "<id>"))
    .sort();
}

beforeAll(async () => {
  source = await createHttpTestServer("operations_package_tools_source");
  target = await createHttpTestServer("operations_package_tools_target");
  const headers = { authorization: `Bearer ${source.apiKey}`, "content-type": "application/json" };
  const seedSkill = async (title: string) => {
    const res = await fetch(`${source.baseUrl}/v1/skills`, {
      method: "POST",
      headers,
      body: JSON.stringify({ scope: "global", title, body: "Answer briefly." }),
    });
    if (res.status !== 201) throw new Error(`skill seed failed: ${res.status}`);
  };
  const exportArchive = async (filename: string) => {
    const exported = await fetch(`${source.baseUrl}/v1/packages/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kinds: ["skill"] }),
    });
    const { file_id } = (await exported.json()) as { file_id: string };
    const download = await fetch(`${source.baseUrl}/v1/packages/archives/${file_id}`, {
      headers: { authorization: `Bearer ${source.apiKey}` },
    });
    return storePackageArchive(target.db, {
      tenant_id: target.tenantId,
      actor_id: target.userId,
      filename,
      bytes: new Uint8Array(await download.arrayBuffer()),
    });
  };
  await seedSkill("Package Tool Tone");
  archiveFileId = await exportArchive("golden.subkit-package.zip");
  await seedSkill("Package Tool Format");
  widerFileId = await exportArchive("wider.subkit-package.zip");
  brokenFileId = await storePackageArchive(target.db, {
    tenant_id: target.tenantId,
    actor_id: target.userId,
    filename: "broken.subkit-package.zip",
    bytes: new TextEncoder().encode("not a zip archive"),
  });
}, 120_000);

afterAll(async () => {
  await source?.cleanup();
  await target?.cleanup();
}, 60_000);

describe("apply_package_import keeps its descriptor and results", () => {
  test("descriptor", () => {
    record("tool.descriptor", {
      keys: Object.keys(applyPackageImportTool).sort(),
      name: applyPackageImportTool.name,
      description: applyPackageImportTool.description,
      category: applyPackageImportTool.category,
      permission: applyPackageImportTool.permission,
      authoring_only: applyPackageImportTool.authoring_only,
      accepts_attachment_file_id: applyPackageImportTool.accepts_attachment_file_id,
      strict: applyPackageImportTool.strict,
      input: z.toJSONSchema(applyPackageImportTool.inputSchema),
    });
  });

  test("refusals", async () => {
    const digest = await planDigest(archiveFileId);
    const fid = toFileId(archiveFileId);
    record(
      "tool.no-principal",
      await applyPackageImportTool.execute(toolCtx({ principal: null }), {
        file_id: "nope",
        expected_plan_digest: digest,
      }),
    );
    record(
      "tool.invalid-file-id",
      await applyPackageImportTool.execute(toolCtx(), {
        file_id: "nope",
        expected_plan_digest: digest,
      }),
    );
    record(
      "tool.missing",
      await applyPackageImportTool.execute(toolCtx(), {
        file_id: toFileId(MISSING),
        expected_plan_digest: digest,
      }),
    );
    record(
      "tool.broken",
      await applyPackageImportTool.execute(toolCtx(), {
        file_id: toFileId(brokenFileId),
        expected_plan_digest: digest,
      }),
    );
    record(
      "tool.stale",
      await applyPackageImportTool.execute(toolCtx(), {
        file_id: fid,
        expected_plan_digest: "0".repeat(64),
      }),
    );
  });

  test("applies over MCP and again over chat", async () => {
    const fid = toFileId(archiveFileId);
    record(
      "tool.apply.mcp",
      await applyPackageImportTool.execute(toolCtx({ direct_mcp_invocation: true }), {
        file_id: fid,
        expected_plan_digest: await planDigest(archiveFileId),
      }),
    );
    record(
      "tool.apply.chat",
      await applyPackageImportTool.execute(toolCtx(), {
        file_id: toFileId(widerFileId),
        expected_plan_digest: await planDigest(widerFileId),
      }),
    );
    record(
      "tool.apply.unchanged",
      await applyPackageImportTool.execute(toolCtx(), {
        file_id: fid,
        expected_plan_digest: await planDigest(archiveFileId),
      }),
    );
    record("tool.audit", await importAudit());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
