import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { updateConnector } from "../../../connectors/index.ts";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors, knowledgeSources, skills, workflows } from "../../../db/schema/index.ts";
import {
  type MemoryOffloadStorage,
  useMemoryOffloadStorage,
} from "../../../test-helpers/offload-storage.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
} from "../../../tests/journeys/setup.ts";
import { applyPackageImport, type PackageImportActor, previewPackageImport } from "../apply.ts";
import { collectTenantPackage } from "../collect.ts";
import { buildPackageArchive } from "../export.ts";
import { type SourceFixture, seedSourceTenant, seedTenant } from "./fixture.ts";

const SOURCE = { instance: "https://source.example.test", engine_version: "0.0.0-test" };
const EXPORTED_AT = "2026-01-01T00:00:00.000Z";

let ctx: JourneyCtx;
let storage: MemoryOffloadStorage;
let source_id: string;
let fixture: SourceFixture;
let target_id: string;
let target_user_id: string;
let who: PackageImportActor;

async function packageFor(categories: string[]) {
  const collected = await collectTenantPackage(ctx.db, source_id, {
    categories,
    include_bytes: true,
  });
  return buildPackageArchive(collected, SOURCE, EXPORTED_AT);
}

async function keysFor(categories: string[]): Promise<string[]> {
  const collected = await collectTenantPackage(ctx.db, source_id, {
    categories,
    include_bytes: false,
  });
  return collected.payloads.map((p) => `${p.kind}:${p.key}`).sort();
}

async function importAll(archive: Buffer) {
  const plan = await previewPackageImport(ctx.db, target_id, archive);
  const applied = await applyPackageImport(ctx.db, {
    tenant_id: target_id,
    archive,
    archive_file_id: null,
    expected_plan_digest: plan.plan_digest,
    who,
  });
  expect(applied.items.filter((item) => item.action === "failed")).toEqual([]);
  return { plan, applied };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("package-categories");
  storage = await useMemoryOffloadStorage();
  const source = await seedTenant(ctx, "pkg-cat-a");
  source_id = source.tenant_id;
  fixture = await seedSourceTenant(ctx.db, source.tenant_id, source.user_id);
  await ctx.db
    .update(workflows)
    .set({ category: "reports" })
    .where(and(eq(workflows.tenant_id, source_id), eq(workflows.slug, "widget-report")));
  await ctx.db
    .update(workflows)
    .set({ category: "ingest" })
    .where(and(eq(workflows.tenant_id, source_id), eq(workflows.slug, "fetch-widgets")));
  await ctx.db
    .update(skills)
    .set({ category: "docs" })
    .where(and(eq(skills.tenant_id, source_id), eq(skills.slug, "widget-guide")));
  await ctx.db
    .update(knowledgeSources)
    .set({ category: "docs" })
    .where(
      and(eq(knowledgeSources.tenant_id, source_id), eq(knowledgeSources.slug, "widget-runbook")),
    );
  const target = await seedTenant(ctx, "pkg-cat-b");
  target_id = target.tenant_id;
  target_user_id = target.user_id;
  who = {
    actor: { kind: "user", id: target.user_id },
    actor_type: "user",
    request_source: "api",
  };
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await storage?.restore();
  await ctx?.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("package export by category", () => {
  test("a category brings its items and everything they depend on, nothing else", async () => {
    expect(await keysFor(["reports"])).toEqual([
      "connector:acme@dev",
      "schedule:fetch-widgets",
      "workflow:fetch-widgets",
      "workflow:widget-report",
    ]);
  });

  test("files travel with the skill that owns them", async () => {
    expect(await keysFor(["docs"])).toEqual([
      "connector:acme@dev",
      `file:${fixture.linked_file_sha}`,
      "knowledge:widget-runbook",
      "skill:widget-guide",
    ]);
  });

  test("each selection gets its own stable package id", async () => {
    const both = await packageFor(["reports", "docs"]);
    expect(both.manifest.package_id).toBe("tenant-export:pkg-cat-a:docs+reports");
    const whole = buildPackageArchive(
      await collectTenantPackage(ctx.db, source_id, { include_bytes: false }),
      SOURCE,
      EXPORTED_AT,
    );
    expect(whole.manifest.package_id).toBe("tenant-export:pkg-cat-a");
  });

  test("a connector shared by two packages stays unchanged after the target sets it up", async () => {
    const first = await importAll((await packageFor(["reports"])).archive);
    expect(first.applied.summary.create).toBe(4);

    const [acme] = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, target_id), eq(connectors.slug, "acme")));
    if (!acme) throw new Error("imported connector missing");
    await updateConnector(
      target_id,
      acme.id,
      {
        config: {
          static_headers: { "X-Api-Key": "target-entered-secret", Accept: "application/json" },
        },
      },
      { kind: "user", id: target_user_id },
      ctx.db,
    );
    await upsertCredential(
      {
        tenant_id: target_id,
        connector_id: acme.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "target-entered-token" },
        actor_id: target_user_id,
        actor_type: "user",
      },
      ctx.db,
    );

    const second = await importAll((await packageFor(["docs"])).archive);
    const shared = second.plan.items.find(
      (item) => item.kind === "connector" && item.key === "acme@dev",
    );
    expect(shared?.action).toBe("unchanged");
    expect(second.plan.summary.conflict).toBe(0);
    expect(second.applied.summary.create).toBe(3);

    const again = await previewPackageImport(
      ctx.db,
      target_id,
      (await packageFor(["reports"])).archive,
    );
    expect(again.summary.conflict).toBe(0);
    expect(again.summary.unchanged).toBe(again.items.length);
  });
});
