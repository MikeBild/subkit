import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, workflows, workflowVersions } from "../../../db/schema/index.ts";
import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../../../test-helpers/determinism/clock.ts";
import {
  type MemoryOffloadStorage,
  useMemoryOffloadStorage,
} from "../../../test-helpers/offload-storage.ts";
import { skillPackageArchive } from "../../../test-helpers/package-archive.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
} from "../../../tests/journeys/setup.ts";
import { walkZipEntries } from "../../../utils/zip-walk.ts";
import { previewPackageImport } from "../apply.ts";
import { readPackageArchive } from "../archive-read.ts";
import { collectTenantPackage } from "../collect.ts";
import { buildPackageArchive, exportTenantPackage } from "../export.ts";
import { sha256Hex } from "../format.ts";
import { loadStoredPackageArchive } from "../registry.ts";
import { MASK_TEXT, SECRETS, type SourceFixture, seedSourceTenant, seedTenant } from "./fixture.ts";

const SOURCE = { instance: "https://source.example.test", engine_version: "0.0.0-test" };

let ctx: JourneyCtx;
let storage: MemoryOffloadStorage;
let tenant_id: string;
let user_id: string;
let fixture: SourceFixture;
let archive: Buffer;

async function inflatedText(bytes: Buffer): Promise<string> {
  const walked = await walkZipEntries(bytes, {
    maxEntries: 1000,
    maxPerEntryBytes: 16 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
  });
  return walked.entries
    .map((entry) => `${entry.path}\n${entry.buffer.toString("utf8")}`)
    .join("\n");
}

beforeAll(async () => {
  ctx = await createJourneyCtx("package-export");
  storage = await useMemoryOffloadStorage();
  ({ tenant_id, user_id } = await seedTenant(ctx, "pkg-export-a"));
  fixture = await seedSourceTenant(ctx.db, tenant_id, user_id);
  const prev = installClock(createDeterministicClock());
  try {
    const result = await exportTenantPackage(ctx.db, {
      tenant_id,
      actor_type: "user",
      actor_id: user_id,
      request_source: "api",
      source: SOURCE,
    });
    archive = (await loadStoredPackageArchive(ctx.db, tenant_id, result.file_id)).bytes;
    expect(sha256Hex(archive)).toBe(result.sha256);
  } finally {
    restoreClock(prev);
  }
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await storage?.restore();
  await ctx?.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("tenant package export", () => {
  test("no secret value and no redaction mask appears in any archive entry", async () => {
    const text = `${archive.toString("latin1")}\n${await inflatedText(archive)}`;
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain(MASK_TEXT);
  });

  test("credentials are named as requirements instead of exported", async () => {
    const { manifest, payloads } = await readPackageArchive(archive);
    const credential = manifest.requires.filter((r) => r.kind === "credential");
    expect(credential.map((r) => r.kind === "credential" && r.connector)).toEqual([
      "acme@dev",
      "warehouse@dev",
    ]);
    const acme = payloads.find((p) => p.kind === "connector" && p.key === "acme@dev");
    if (acme?.kind !== "connector") throw new Error("acme connector missing");
    expect(acme.payload.base_url).toBe("https://api.acme.test/v1?format=json");
    expect(acme.payload.config).toEqual({ static_headers: { Accept: "application/json" } });
    const template = payloads.find((p) => p.kind === "connector_template");
    if (template?.kind !== "connector_template") throw new Error("template missing");
    expect(template.payload.oauth).toEqual({
      client_id: "acme-public-client",
      token_endpoint: "https://auth.acme.test/token",
      extra_headers: {},
    });
  });

  test("platform, seed, template, memory and run material stays out", async () => {
    const { payloads } = await readPackageArchive(archive);
    const keys = payloads.map((p) => `${p.kind}:${p.key}`);
    expect(keys).not.toContain("connector:platform-internal@dev");
    expect(keys).not.toContain("skill:excluded-template");
    expect(keys).not.toContain("skill:excluded-memory");
    expect(keys).not.toContain(`knowledge:${fixture.seed_knowledge_slug}`);
    expect(keys).not.toContain(`file:${fixture.run_file_sha}`);
    expect(keys).toContain("knowledge:widget-runbook");
    expect(keys).toContain(`file:${fixture.linked_file_sha}`);
    expect(keys).toContain("skill:widget-guide");
    expect(keys).toContain("workflow:fetch-widgets");
    expect(keys).toContain("workflow:widget-report");
    expect(keys).toContain("schedule:fetch-widgets");
    const knowledgeFileSha = sha256Hex(new TextEncoder().encode(fixture.knowledge_body));
    expect(keys).not.toContain(`file:${knowledgeFileSha}`);
    expect(payloads.filter((p) => p.kind === "file")).toHaveLength(1);
  });

  test("workflows carry portable references only", async () => {
    const { payloads } = await readPackageArchive(archive);
    const text = JSON.stringify(payloads.filter((p) => p.kind === "workflow"));
    for (const id of fixture.ids) expect(text).not.toContain(id);
    const parent = payloads.find((p) => p.kind === "workflow" && p.key === "widget-report");
    if (parent?.kind !== "workflow") throw new Error("parent workflow missing");
    expect(parent.payload.workflows).toEqual(["fetch-widgets"]);
    const child = payloads.find((p) => p.kind === "workflow" && p.key === "fetch-widgets");
    if (child?.kind !== "workflow") throw new Error("child workflow missing");
    expect(child.payload.connectors).toEqual(["acme@dev"]);
  });

  test("the same tenant state yields the same archive bytes", async () => {
    const exported_at = "2026-01-01T00:00:00.000Z";
    const first = buildPackageArchive(
      await collectTenantPackage(ctx.db, tenant_id, { include_bytes: true }),
      SOURCE,
      exported_at,
    );
    const second = buildPackageArchive(
      await collectTenantPackage(ctx.db, tenant_id, { include_bytes: true }),
      SOURCE,
      exported_at,
    );
    expect(sha256Hex(first.archive)).toBe(sha256Hex(second.archive));
    const prev = installClock(createDeterministicClock());
    try {
      const again = await exportTenantPackage(ctx.db, {
        tenant_id,
        actor_type: "user",
        actor_id: user_id,
        request_source: "api",
        source: SOURCE,
      });
      expect(again.sha256).toBe(sha256Hex(archive));
    } finally {
      restoreClock(prev);
    }
  });

  test("a kind filter keeps the dependency closure", async () => {
    const collected = await collectTenantPackage(ctx.db, tenant_id, {
      kinds: ["workflow"],
      include_bytes: false,
    });
    const keys = collected.payloads.map((p) => `${p.kind}:${p.key}`).sort();
    expect(keys).toEqual(
      [
        "connector:acme@dev",
        "schedule:fetch-widgets",
        "workflow:fetch-widgets",
        "workflow:widget-report",
      ].sort(),
    );
  });

  test("a draft without steps stays out and blocks neither export nor preview", async () => {
    const { tenant_id: tenant } = await seedTenant(ctx, "pkg-export-empty-draft");
    const [workflow] = await ctx.db
      .insert(workflows)
      .values({ tenant_id: tenant, slug: "empty-draft", name: "Empty draft", lifecycle: "draft" })
      .returning();
    if (!workflow) throw new Error("seed workflow failed");
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({ tenant_id: tenant, workflow_id: workflow.id, version: 1, dag: { steps: [] } })
      .returning();
    if (!version) throw new Error("seed version failed");
    await ctx.db
      .update(workflows)
      .set({ draft_version_id: version.id })
      .where(eq(workflows.id, workflow.id));

    const collected = await collectTenantPackage(ctx.db, tenant, { include_bytes: false });
    expect(collected.payloads.some((item) => item.key === "empty-draft")).toBe(false);
    const plan = await previewPackageImport(ctx.db, tenant, skillPackageArchive(["after-draft"]));
    expect(plan.summary.create).toBe(1);
  });

  test("the export is audited without content", async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "data.exported")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const metadata = JSON.stringify(rows[0]?.metadata ?? {});
    expect(metadata).toContain("content_digest");
    for (const secret of Object.values(SECRETS)) expect(metadata).not.toContain(secret);
  });
});
