import { and, eq, sql } from "drizzle-orm";
import type { Actor } from "../../audit/actor.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { AuditActorType } from "../../audit/types.ts";
import { rebindConnectorIds } from "../../connectors/recipe-binding.ts";
import { createConnector } from "../../connectors/service.ts";
import { createTenantConnectorTemplate } from "../../connectors/template-service.ts";
import { CreateConnectorSchema } from "../../connectors/types.ts";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../../db/client.ts";
import { fileLinks, packageInstallItems, packageInstalls } from "../../db/schema/index.ts";
import { linkStoredFile } from "../../files/links.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { createIntakeItem, createIntakeProposal } from "../../knowledge/intake.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { createScheduleLocked } from "../../scheduler/repo.ts";
import { createSkill, getSkill, updateSkill } from "../../skills/service.ts";
import { CreateSkillSchema } from "../../skills/types.ts";
import { now } from "../../utils/clock.ts";
import { getWorkflowDraft, saveWorkflowDraft } from "../../workflows/drafts.ts";
import { type ReadPackage, readPackageArchive } from "./archive-read.ts";
import {
  CONNECTOR_REF_PREFIX,
  type KnowledgePayload,
  PACKAGE_CONTENT_TYPE,
  PACKAGE_FORMAT,
  type PackageItemKind,
  type PackagePayload,
  stableUuid,
  type WorkflowPayload,
} from "./format.ts";
import {
  itemId,
  manifestSource,
  type PackagePlan,
  type PackagePlanItem,
  payloadHash,
  planPackageImport,
  targetState,
} from "./plan.ts";

export class PackagePlanChangedError extends Error {
  constructor(readonly plan: PackagePlan) {
    super("package_plan_changed");
  }
}

export interface PackageImportActor {
  actor: Actor;
  actor_type: AuditActorType;
  request_source: RequestSource;
}

export interface AppliedItem {
  kind: PackageItemKind;
  key: string;
  action: PackagePlanItem["action"] | "failed";
  local_id: string | null;
  errors?: string[];
  review?: { intake_item_id: string; proposal_id: string; path: string };
}

export interface ApplyPackageResult {
  install_id: string | null;
  plan_digest: string;
  items: AppliedItem[];
  requires: PackagePlan["requires"];
  summary: Record<AppliedItem["action"], number>;
}

export function intakeReviewPath(itemId: string, proposalId: string): string {
  return `/cockpit/intake/${itemId}?tab=review&proposal=${proposalId}`;
}

export async function storePackageArchive(
  db: Executor,
  p: { tenant_id: string; actor_id: string; filename: string; bytes: Uint8Array },
): Promise<string> {
  const saved = await persistInlineUpload(db, {
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    filename: p.filename,
    content_type: PACKAGE_CONTENT_TYPE,
    bytes: p.bytes,
  });
  return saved.row.id;
}

export async function previewPackageImport(
  db: Executor,
  tenant_id: string,
  archive: Buffer,
): Promise<PackagePlan> {
  const pkg = await readPackageArchive(archive);
  return (await planPackageImport(db, tenant_id, pkg)).plan;
}

function knowledgeMarkdown(payload: KnowledgePayload): string {
  const parts = [`# ${payload.name}`];
  if (payload.description) parts.push(payload.description);
  for (const doc of payload.documents) {
    parts.push(payload.documents.length > 1 ? `## ${doc.path}\n\n${doc.content}` : doc.content);
  }
  return parts.join("\n\n");
}

function orderWorkflows(items: Extract<PackagePayload, { kind: "workflow" }>[]) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const done = new Set<string>();
  const out: typeof items = [];
  const visit = (key: string, trail: Set<string>): void => {
    const item = byKey.get(key);
    if (!item || done.has(key) || trail.has(key)) return;
    trail.add(key);
    for (const dep of item.payload.workflows) visit(dep, trail);
    done.add(key);
    out.push(item);
  };
  for (const item of items) visit(item.key, new Set());
  return out;
}

function bindDefinition(payload: WorkflowPayload, connectorIds: Map<string, string>) {
  const bindings: Record<string, string> = {};
  for (const key of payload.connectors) {
    const id = connectorIds.get(key);
    if (id) bindings[`${CONNECTOR_REF_PREFIX}${key}`] = id;
  }
  return { ...(rebindConnectorIds(payload.definition, bindings) as object), slug: payload.slug };
}

async function ensureFileLink(
  tx: Executor,
  tenant_id: string,
  file_id: string,
  resource_type: "skill" | "connector",
  resource_id: string,
  link: { slug: string | null; role: string | null },
  who: PackageImportActor,
): Promise<void> {
  const [existing] = await tx
    .select({ id: fileLinks.id })
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, tenant_id),
        eq(fileLinks.file_id, file_id),
        eq(fileLinks.resource_type, resource_type),
        eq(fileLinks.resource_id, resource_id),
      ),
    )
    .limit(1);
  if (existing) return;
  await linkStoredFile(
    tx,
    { tenant_id, file_id, resource_type, resource_id, slug: link.slug, role: link.role },
    {
      actor_type: who.actor_type,
      actor_id: who.actor.id,
      request_source: who.request_source,
      source: "package_import",
      allowed_statuses: ["ready", "scanning"],
    },
  );
}

export async function applyPackageImport(
  db: Db,
  p: {
    tenant_id: string;
    archive: Buffer;
    archive_file_id: string | null;
    expected_plan_digest: string;
    who: PackageImportActor;
  },
): Promise<ApplyPackageResult> {
  const pkg: ReadPackage = await readPackageArchive(p.archive);
  const preview = await planPackageImport(db, p.tenant_id, pkg);
  if (preview.plan.plan_digest !== p.expected_plan_digest) {
    throw new PackagePlanChangedError(preview.plan);
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`package-import:${p.tenant_id}`}::text, 0))`,
    );
    await lockCatalogVocabulary(tx, p.tenant_id);
    const { plan, index, registry } = await planPackageImport(tx, p.tenant_id, pkg);
    if (plan.plan_digest !== p.expected_plan_digest) throw new PackagePlanChangedError(plan);
    const decisions = new Map(plan.items.map((item) => [itemId(item.kind, item.key), item]));
    const fileIds = new Map<string, string>();
    for (const item of pkg.payloads) {
      if (item.kind !== "file") continue;
      if (decisions.get(itemId(item.kind, item.key))?.action !== "create") continue;
      const saved = await persistInlineUpload(tx, {
        tenant_id: p.tenant_id,
        actor_id: p.who.actor.id,
        filename: item.payload.filename,
        content_type: item.payload.content_type,
        bytes: item.bytes,
      });
      fileIds.set(item.key, saved.row.id);
    }
    const results = new Map<string, AppliedItem>();
    const record = (item: PackagePayload, applied: Omit<AppliedItem, "kind" | "key">): void => {
      results.set(itemId(item.kind, item.key), { kind: item.kind, key: item.key, ...applied });
    };
    const connectorIds = new Map(index.connectors);
    const workflowIds = new Map(index.workflows);
    const skillIds = new Map(index.skills);
    for (const [key, id] of index.files) if (!fileIds.has(key)) fileIds.set(key, id);
    const actorId = p.who.actor.id;
    const actorType = p.who.actor_type;
    const of = <K extends PackageItemKind>(kind: K) =>
      pkg.payloads.filter(
        (item): item is Extract<PackagePayload, { kind: K }> => item.kind === kind,
      );
    const decisionOf = (item: PackagePayload): PackagePlanItem => {
      const decision = decisions.get(itemId(item.kind, item.key));
      if (!decision) throw new Error(`plan item missing for ${item.kind}:${item.key}`);
      return decision;
    };
    const passThrough = (item: PackagePayload, decision: PackagePlanItem): boolean => {
      if (decision.action === "create" || decision.action === "update") return false;
      record(item, { action: decision.action, local_id: decision.local_id });
      return true;
    };

    for (const item of of("connector_template")) {
      const decision = decisionOf(item);
      if (passThrough(item, decision)) continue;
      const row = await createTenantConnectorTemplate(
        {
          tenant_id: p.tenant_id,
          actor_type: actorType,
          actor_id: actorId,
          input: { ...item.payload, oauth: item.payload.oauth ?? null },
          audit_metadata: { package_id: pkg.manifest.package_id },
        },
        tx,
      );
      record(item, { action: "create", local_id: row.id });
    }

    for (const item of of("connector")) {
      const decision = decisionOf(item);
      if (passThrough(item, decision)) continue;
      const parsed = CreateConnectorSchema.safeParse({
        name: item.payload.name,
        slug: item.payload.slug,
        driver: item.payload.driver,
        environment: item.payload.environment,
        ...(item.payload.base_url ? { base_url: item.payload.base_url } : {}),
        auth_type: item.payload.auth_type,
        config: item.payload.config,
        operator_quirks: item.payload.operator_quirks,
        ...(item.payload.template_slug ? { template_slug: item.payload.template_slug } : {}),
        ...(item.payload.template_source ? { template_source: item.payload.template_source } : {}),
        description: item.payload.description,
        category: item.payload.category,
      });
      if (!parsed.success) {
        record(item, {
          action: "failed",
          local_id: null,
          errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
        continue;
      }
      const view = await createConnector(
        { tenant_id: p.tenant_id, input: parsed.data, actor_id: actorId, actor_type: actorType },
        tx,
      );
      connectorIds.set(item.key, view.id);
      record(item, { action: "create", local_id: view.id });
    }

    for (const item of orderWorkflows(of("workflow"))) {
      const decision = decisionOf(item);
      if (passThrough(item, decision)) continue;
      const existingDraft =
        decision.action === "update" && decision.local_id
          ? await getWorkflowDraft(p.tenant_id, decision.local_id, tx)
          : null;
      const saved = await saveWorkflowDraft(
        {
          tenant_id: p.tenant_id,
          ...(decision.action === "update" && decision.local_id
            ? {
                workflow_id: decision.local_id,
                expected_draft_version_id: existingDraft?.version_id ?? null,
              }
            : {}),
          def: bindDefinition(item.payload, connectorIds),
          actor_id: actorId,
          actor_type: p.who.actor.kind === "user" ? "user" : "system_account",
          request_source: p.who.request_source,
          audit_metadata: { package_id: pkg.manifest.package_id },
          metadata: {
            ...(item.payload.description !== null ? { description: item.payload.description } : {}),
            ...(item.payload.category !== null ? { category: item.payload.category } : {}),
          },
        },
        tx,
      );
      if (!saved.draft) {
        record(item, { action: "failed", local_id: decision.local_id, errors: saved.errors });
        continue;
      }
      workflowIds.set(item.key, saved.draft.workflow_id);
      record(item, { action: decision.action, local_id: saved.draft.workflow_id });
    }

    for (const item of of("skill")) {
      const decision = decisionOf(item);
      if (passThrough(item, decision)) continue;
      const connector_id = item.payload.connector
        ? connectorIds.get(item.payload.connector)
        : undefined;
      const workflow_id = item.payload.workflow
        ? workflowIds.get(item.payload.workflow)
        : undefined;
      if (item.payload.scope === "workflow" && item.payload.workflow && !workflow_id) {
        record(item, { action: "failed", local_id: null, errors: ["workflow not available"] });
        continue;
      }
      const parsed = CreateSkillSchema.safeParse({
        scope: item.payload.scope,
        ...(connector_id ? { connector_id } : {}),
        ...(workflow_id ? { workflow_id } : {}),
        title: item.payload.title,
        description: item.payload.description,
        category: item.payload.category,
        body: item.payload.body,
        examples: item.payload.examples,
        best_practices: item.payload.best_practices,
        pitfalls: item.payload.pitfalls,
        doc_refs: item.payload.doc_refs,
        gates_tools: item.payload.gates_tools,
        activates_when: item.payload.activates_when,
        input_schema: item.payload.input_schema,
        output_schema: item.payload.output_schema,
        side_effects: item.payload.side_effects,
        idempotency: item.payload.idempotency,
        maturity: item.payload.maturity,
        tags: item.payload.tags,
        applies_to: item.payload.applies_to,
        status: "draft",
        source: "manual",
      });
      if (!parsed.success) {
        record(item, {
          action: "failed",
          local_id: null,
          errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
        continue;
      }
      if (decision.action === "update" && decision.local_id) {
        const current = await getSkill(p.tenant_id, decision.local_id, tx);
        if (current?.status !== "draft") {
          record(item, {
            action: "conflict",
            local_id: decision.local_id,
            errors: ["only a draft skill is updated by an import"],
          });
          continue;
        }
        const {
          scope: _scope,
          connector_id: _c,
          workflow_id: _w,
          source: _s,
          ...patch
        } = parsed.data;
        await updateSkill(p.tenant_id, decision.local_id, patch, actorId, tx, actorType);
        record(item, { action: "update", local_id: decision.local_id });
        continue;
      }
      const skill = await createSkill(
        {
          tenant_id: p.tenant_id,
          slug: item.key,
          input: parsed.data,
          actor_id: actorId,
          actor_type: actorType,
        },
        tx,
      );
      skillIds.set(item.key, skill.id);
      record(item, { action: "create", local_id: skill.id });
    }

    for (const item of of("file")) {
      const decision = decisionOf(item);
      const file_id = fileIds.get(item.key) ?? null;
      if (file_id) {
        for (const link of item.payload.links) {
          const resource_id =
            link.resource_kind === "skill" ? skillIds.get(link.key) : connectorIds.get(link.key);
          if (!resource_id) continue;
          const created = results.get(
            itemId(link.resource_kind === "skill" ? "skill" : "connector", link.key),
          );
          if (decision.action !== "create" && created?.action !== "create") continue;
          await ensureFileLink(
            tx,
            p.tenant_id,
            file_id,
            link.resource_kind,
            resource_id,
            link,
            p.who,
          );
        }
      }
      record(item, {
        action: decision.action === "create" && !file_id ? "failed" : decision.action,
        local_id: file_id,
      });
    }

    for (const item of of("schedule")) {
      const decision = decisionOf(item);
      if (passThrough(item, decision)) continue;
      const workflow_id = workflowIds.get(item.payload.workflow);
      if (!workflow_id) {
        record(item, { action: "failed", local_id: null, errors: ["workflow not available"] });
        continue;
      }
      try {
        const outcome = await createScheduleLocked(tx, {
          tenant_id: p.tenant_id,
          workflow_id,
          cron: item.payload.cron,
          timezone: item.payload.timezone,
          execution_mode: item.payload.execution_mode,
          ...(item.payload.input !== null ? { input: item.payload.input } : {}),
          paused: true,
        });
        await auditAwait(
          {
            tenant_id: p.tenant_id,
            actor_type: actorType,
            actor_id: actorId,
            action: AuditAction.SCHEDULE_CREATED,
            resource_type: "schedule",
            resource_id: outcome.row.id,
            result: "success",
            metadata: { workflow_id, paused: true, package_id: pkg.manifest.package_id },
          },
          tx,
        );
        record(item, { action: "create", local_id: outcome.row.id });
      } catch (err) {
        record(item, {
          action: "failed",
          local_id: null,
          errors: [err instanceof Error ? err.message : "schedule rejected"],
        });
      }
    }

    const captured_at = new Date(now()).toISOString();
    for (const item of of("knowledge")) {
      const decision = decisionOf(item);
      if (passThrough(item, decision)) continue;
      const body = knowledgeMarkdown(item.payload);
      const intakeItem = await createIntakeItem(
        {
          tenant_id: p.tenant_id,
          actor: p.who.actor,
          client_request_id: stableUuid(
            p.tenant_id,
            pkg.manifest.package_id,
            item.key,
            payloadHash(item.payload),
          ),
          title: item.payload.name.slice(0, 200),
          captured_at,
          body,
          note: `Imported from package ${pkg.manifest.package_id} (${item.key})`,
        },
        tx,
      );
      const tags = item.payload.tags.filter((tag) => tag.length <= 40).slice(0, 20);
      const proposal = await createIntakeProposal(
        {
          tenant_id: p.tenant_id,
          actor: p.who.actor,
          item_ids: [intakeItem.id],
          title: item.payload.name.slice(0, 200),
          body,
          target: {
            name: item.payload.name.slice(0, 200),
            ...(item.payload.category && item.payload.category !== "other"
              ? { category: item.payload.category }
              : {}),
            ...(tags.length > 0 ? { tags } : {}),
          },
        },
        tx,
      );
      record(item, {
        action: "create",
        local_id: null,
        review: {
          intake_item_id: intakeItem.id,
          proposal_id: proposal.id,
          path: intakeReviewPath(intakeItem.id, proposal.id),
        },
      });
    }

    const after = await targetState(tx, p.tenant_id);
    const summary: Record<AppliedItem["action"], number> = {
      create: 0,
      update: 0,
      unchanged: 0,
      conflict: 0,
      failed: 0,
    };
    const items = pkg.payloads.map((item) => {
      const applied = results.get(itemId(item.kind, item.key)) ?? {
        kind: item.kind,
        key: item.key,
        action: "failed" as const,
        local_id: null,
      };
      summary[applied.action] += 1;
      return applied;
    });
    if (summary.create + summary.update === 0) {
      return {
        install_id: null,
        plan_digest: plan.plan_digest,
        items,
        requires: plan.requires,
        summary,
      };
    }
    const [install] = await tx
      .insert(packageInstalls)
      .values({
        tenant_id: p.tenant_id,
        package_id: pkg.manifest.package_id,
        package_version: pkg.manifest.version,
        format: PACKAGE_FORMAT,
        content_digest: pkg.manifest.content_digest,
        archive_file_id: p.archive_file_id,
        source: manifestSource(pkg.manifest),
        installed_by_type: actorType,
        installed_by_id: actorId,
        summary,
      })
      .returning({ id: packageInstalls.id });
    if (!install) throw new Error("package install insert failed");
    for (const item of pkg.payloads) {
      const applied = results.get(itemId(item.kind, item.key));
      if (!applied || (applied.action !== "create" && applied.action !== "update")) continue;
      const key = itemId(item.kind, item.key);
      const local_hash = after.hashes.get(key) ?? null;
      const values = {
        install_id: install.id,
        local_id: applied.local_id,
        imported_hash: payloadHash(item.payload),
        local_hash,
        state: item.kind === "knowledge" ? "pending_review" : "imported",
        intake_proposal_id: applied.review?.proposal_id ?? null,
        updated_at: new Date(now()),
      };
      if (registry.has(key)) {
        await tx
          .update(packageInstallItems)
          .set(values)
          .where(
            and(
              eq(packageInstallItems.tenant_id, p.tenant_id),
              eq(packageInstallItems.kind, item.kind),
              eq(packageInstallItems.item_key, item.key),
            ),
          );
      } else {
        await tx
          .insert(packageInstallItems)
          .values({ tenant_id: p.tenant_id, kind: item.kind, item_key: item.key, ...values });
      }
    }
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: actorType,
        actor_id: actorId,
        action: AuditAction.DATA_IMPORTED,
        resource_type: "package",
        resource_id: install.id,
        result: "success",
        metadata: {
          format: PACKAGE_FORMAT,
          package_id: pkg.manifest.package_id,
          content_digest: pkg.manifest.content_digest,
          summary,
          request_source: p.who.request_source,
        },
      },
      tx,
    );
    return {
      install_id: install.id,
      plan_digest: plan.plan_digest,
      items,
      requires: plan.requires,
      summary,
    };
  });
}
