import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  connectorTemplates,
  files,
  intakeItems,
  intakeProposals,
  knowledgeSources,
  packageInstallItems,
  packageInstalls,
  skills,
  vaultItems,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../../db/schema/index.ts";
import {
  confirmIntakeProposal,
  getIntakeProposal,
  getKnowledgeSource,
  getKnowledgeSourceContent,
  updateKnowledgeSourceContent,
} from "../../../knowledge/index.ts";
import { updateSkill } from "../../../skills/index.ts";
import {
  type MemoryOffloadStorage,
  useMemoryOffloadStorage,
} from "../../../test-helpers/offload-storage.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
} from "../../../tests/journeys/setup.ts";
import { getWorkflowDraft, saveWorkflowDraft } from "../../../workflows/index.ts";
import {
  type ApplyPackageResult,
  applyPackageImport,
  type PackageImportActor,
  PackagePlanChangedError,
  previewPackageImport,
} from "../apply.ts";
import { collectTenantPackage } from "../collect.ts";
import { buildPackageArchive } from "../export.ts";
import type { PackagePlan } from "../plan.ts";
import { type SourceFixture, seedSourceTenant, seedTenant } from "./fixture.ts";

const SOURCE = { instance: "https://source.example.test", engine_version: "0.0.0-test" };
const EXPORTED_AT = "2026-01-01T00:00:00.000Z";

let ctx: JourneyCtx;
let storage: MemoryOffloadStorage;
let fixture: SourceFixture;
let target_id: string;
let who: PackageImportActor;
let archive: Buffer;
let firstPlan: PackagePlan;
let applied: ApplyPackageResult;

const COUNTED = {
  connector_templates: connectorTemplates,
  connectors,
  vaultItems,
  files,
  skills,
  workflows,
  workflow_versions: workflowVersions,
  workflows_schedules: workflowsSchedules,
  knowledge_sources: knowledgeSources,
  intake_items: intakeItems,
  intake_proposals: intakeProposals,
  package_installs: packageInstalls,
  package_install_items: packageInstallItems,
  audit_log: auditLog,
} as const;

async function counts(tenant_id: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(COUNTED)) {
    const [row] = await ctx.db
      .select({ n: count() })
      .from(table)
      .where(eq(table.tenant_id, tenant_id));
    out[name] = Number(row?.n ?? 0);
  }
  return out;
}

function actionOf(plan: PackagePlan, kind: string, key: string): string | undefined {
  return plan.items.find((item) => item.kind === kind && item.key === key)?.action;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("package-import");
  storage = await useMemoryOffloadStorage();
  const source = await seedTenant(ctx, "pkg-import-a");
  fixture = await seedSourceTenant(ctx.db, source.tenant_id, source.user_id);
  await ctx.db
    .update(knowledgeSources)
    .set({ name: "Reviewed widget handbook" })
    .where(eq(knowledgeSources.id, fixture.knowledge_id));
  archive = buildPackageArchive(
    await collectTenantPackage(ctx.db, source.tenant_id, { include_bytes: true }),
    SOURCE,
    EXPORTED_AT,
  ).archive;
  const target = await seedTenant(ctx, "pkg-import-b");
  target_id = target.tenant_id;
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

describe("tenant package import", () => {
  test("preview plans every item as create and writes nothing", async () => {
    const before = await counts(target_id);
    firstPlan = await previewPackageImport(ctx.db, target_id, archive);
    expect(await counts(target_id)).toEqual(before);
    expect(firstPlan.plan_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(firstPlan.summary.conflict).toBe(0);
    expect(firstPlan.summary.create).toBe(firstPlan.items.length);
    expect(await previewPackageImport(ctx.db, target_id, archive)).toEqual(firstPlan);
  });

  test("a stale plan digest is refused before anything is written", async () => {
    const before = await counts(target_id);
    let caught: unknown;
    try {
      await applyPackageImport(ctx.db, {
        tenant_id: target_id,
        archive,
        archive_file_id: null,
        expected_plan_digest: "0".repeat(64),
        who,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PackagePlanChangedError);
    expect((caught as PackagePlanChangedError).plan.plan_digest).toBe(firstPlan.plan_digest);
    expect(await counts(target_id)).toEqual(before);
  });

  test("apply lands every resource in its safe starting state", async () => {
    applied = await applyPackageImport(ctx.db, {
      tenant_id: target_id,
      archive,
      archive_file_id: null,
      expected_plan_digest: firstPlan.plan_digest,
      who,
    });
    const failed = applied.items.filter((item) => item.action === "failed");
    expect(failed).toEqual([]);
    expect(applied.install_id).not.toBeNull();
    expect(applied.summary.create).toBe(firstPlan.items.length);

    const wfRows = await ctx.db.select().from(workflows).where(eq(workflows.tenant_id, target_id));
    expect(wfRows.map((wf) => wf.slug).sort()).toEqual(["fetch-widgets", "widget-report"]);
    for (const wf of wfRows) {
      expect(wf.lifecycle).toBe("draft");
      expect(wf.current_version_id).toBeNull();
      expect(wf.draft_version_id).not.toBeNull();
    }

    const [schedule] = await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.tenant_id, target_id));
    expect(schedule?.paused).toBe(true);
    expect(schedule?.cron).toBe("0 9 * * 1");

    const skillRows = await ctx.db.select().from(skills).where(eq(skills.tenant_id, target_id));
    expect(skillRows.map((s) => [s.slug, s.lifecycle])).toEqual([["widget-guide", "draft"]]);

    const connectorRows = await ctx.db
      .select()
      .from(connectors)
      .where(eq(connectors.tenant_id, target_id));
    expect(connectorRows.map((c) => `${c.slug}@${c.environment}`).sort()).toEqual([
      "acme@dev",
      "warehouse@dev",
    ]);
    for (const row of connectorRows) expect(row.dsn).toBeNull();
    expect(skillRows[0]?.connector_id).toBe(
      connectorRows.find((c) => c.slug === "acme")?.id ?? "missing",
    );
    const [credentialCount] = await ctx.db
      .select({ n: count() })
      .from(vaultItems)
      .where(eq(vaultItems.tenant_id, target_id));
    expect(Number(credentialCount?.n ?? 0)).toBe(0);

    const [template] = await ctx.db
      .select()
      .from(connectorTemplates)
      .where(eq(connectorTemplates.tenant_id, target_id));
    expect(template?.slug).toBe("acme-template");
    expect(JSON.stringify(template?.oauth)).not.toContain("secret");
  });

  test("knowledge arrives only as a reviewable intake proposal", async () => {
    const sources = await ctx.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, target_id));
    expect(sources).toEqual([]);
    const knowledge = applied.items.find((item) => item.kind === "knowledge");
    if (!knowledge?.review) throw new Error("knowledge review handoff missing");
    const [item] = await ctx.db
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, target_id),
          eq(intakeItems.id, knowledge.review.intake_item_id),
        ),
      );
    expect(item?.state).not.toBe("admitted");
    expect(item?.body).toContain("Restart the widget queue");
    const [proposal] = await ctx.db
      .select()
      .from(intakeProposals)
      .where(
        and(
          eq(intakeProposals.tenant_id, target_id),
          eq(intakeProposals.id, knowledge.review.proposal_id),
        ),
      );
    expect(proposal?.status).toBe("draft");
    expect(proposal?.confirmed_target_id).toBeNull();
  });

  test("imported workflows reference only target-tenant resources", async () => {
    const versions = await ctx.db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.tenant_id, target_id));
    expect(versions.length).toBeGreaterThan(0);
    const text = JSON.stringify(versions);
    for (const id of fixture.ids) expect(text).not.toContain(id);
    expect(text).not.toContain("package-connector:");
    const [acme] = await ctx.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, target_id), eq(connectors.slug, "acme")));
    expect(text).toContain(acme?.id ?? "missing");
  });

  test("the linked file is restored with its skill link", async () => {
    const [file] = await ctx.db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, target_id), eq(files.sha256, fixture.linked_file_sha)));
    expect(file?.status).toBe("ready");
    const [runFile] = await ctx.db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, target_id), eq(files.sha256, fixture.run_file_sha)));
    expect(runFile).toBeUndefined();
  });

  test("the import is audited and registered", async () => {
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, target_id), eq(auditLog.action, "data.imported")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.resource_id).toBe(applied.install_id);
    const items = await ctx.db
      .select()
      .from(packageInstallItems)
      .where(eq(packageInstallItems.tenant_id, target_id));
    expect(items).toHaveLength(firstPlan.items.length);
    expect(items.find((row) => row.kind === "knowledge")?.state).toBe("pending_review");
  });

  test("re-importing the same archive changes nothing", async () => {
    const before = await counts(target_id);
    const plan = await previewPackageImport(ctx.db, target_id, archive);
    expect(plan.items.filter((item) => item.action !== "unchanged")).toEqual([]);
    const again = await applyPackageImport(ctx.db, {
      tenant_id: target_id,
      archive,
      archive_file_id: null,
      expected_plan_digest: plan.plan_digest,
      who,
    });
    expect(again.install_id).toBeNull();
    expect(again.summary.unchanged).toBe(plan.items.length);
    expect(await counts(target_id)).toEqual(before);
  });

  test("local edits of imported drafts surface as conflicts", async () => {
    const [skill] = await ctx.db.select().from(skills).where(eq(skills.tenant_id, target_id));
    if (!skill) throw new Error("imported skill missing");
    await updateSkill(target_id, skill.id, { body: "Locally edited body." }, who.actor.id, ctx.db);
    const [wf] = await ctx.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenant_id, target_id), eq(workflows.slug, "widget-report")));
    if (!wf) throw new Error("imported workflow missing");
    const draft = await getWorkflowDraft(target_id, wf.id, ctx.db);
    if (!draft) throw new Error("imported draft missing");
    const saved = await saveWorkflowDraft(
      {
        tenant_id: target_id,
        workflow_id: wf.id,
        expected_draft_version_id: draft.version_id,
        def: { ...(draft.definition as Record<string, unknown>), name: "Widget report edited" },
        actor_id: who.actor.id,
        actor_type: "user",
        request_source: "api",
      },
      ctx.db,
    );
    expect(saved.errors).toBeUndefined();
    const plan = await previewPackageImport(ctx.db, target_id, archive);
    expect(actionOf(plan, "skill", "widget-guide")).toBe("conflict");
    expect(actionOf(plan, "workflow", "widget-report")).toBe("conflict");
    expect(
      plan.items.find((item) => item.kind === "skill" && item.key === "widget-guide")?.reason,
    ).toBe("local_changes");
    expect(actionOf(plan, "workflow", "fetch-widgets")).toBe("unchanged");
  });

  test("local edits of an admitted knowledge source with a different slug surface as conflicts", async () => {
    const knowledge = applied.items.find((item) => item.kind === "knowledge");
    if (!knowledge?.review) throw new Error("knowledge review handoff missing");
    const proposal = await getIntakeProposal(target_id, knowledge.review.proposal_id, ctx.db);
    if (!proposal) throw new Error("imported proposal missing");
    const confirmed = await confirmIntakeProposal(
      {
        tenant_id: target_id,
        actor: who.actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        digest: proposal.revision.digest,
        authorize: async () => {},
      },
      ctx.db,
    );
    const source_id = confirmed?.confirmed_target_id;
    if (!source_id) throw new Error("admitted knowledge source missing");
    const [row] = await ctx.db
      .select()
      .from(packageInstallItems)
      .where(
        and(
          eq(packageInstallItems.tenant_id, target_id),
          eq(packageInstallItems.kind, "knowledge"),
        ),
      );
    expect(row?.state).toBe("admitted");
    expect(row?.local_id).toBe(source_id);
    expect(row?.local_hash).toMatch(/^[0-9a-f]{64}$/);
    const key = row?.item_key ?? "";
    const knowledgeOf = (plan: PackagePlan) =>
      plan.items.find((item) => item.kind === "knowledge" && item.key === key);
    expect(knowledgeOf(await previewPackageImport(ctx.db, target_id, archive))?.action).toBe(
      "unchanged",
    );
    const source = await getKnowledgeSource(target_id, source_id, ctx.db);
    const content = await getKnowledgeSourceContent(target_id, source_id, ctx.db);
    const document = content?.documents[0];
    if (!source || !document) throw new Error("admitted knowledge content missing");
    expect(source.slug).not.toBe(key);
    const edited = "# Runbook\n\nLocally edited on engine B.";
    await updateKnowledgeSourceContent(
      {
        tenant_id: target_id,
        knowledge_source_id: source_id,
        expected_version: source.version,
        path: document.path,
        content: edited,
        actor: who.actor,
      },
      ctx.db,
    );
    const plan = await previewPackageImport(ctx.db, target_id, archive);
    expect(knowledgeOf(plan)).toMatchObject({ action: "conflict", reason: "local_changes" });
    const again = await applyPackageImport(ctx.db, {
      tenant_id: target_id,
      archive,
      archive_file_id: null,
      expected_plan_digest: plan.plan_digest,
      who,
    });
    expect(again.items.find((item) => item.kind === "knowledge")?.action).toBe("conflict");
    const after = await getKnowledgeSourceContent(target_id, source_id, ctx.db);
    expect(after?.documents.find((doc) => doc.path === document.path)?.content).toBe(edited);
  });
});
