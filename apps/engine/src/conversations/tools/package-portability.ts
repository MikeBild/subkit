import { z } from "@hono/zod-openapi";
import { parseFileId, toFileId } from "../../api/files-schemas.ts";
import { applyPackageImportOperation } from "../../api/operations/package.ts";
import {
  authenticationRequired,
  compactPackageItems,
  invalidPackageFileId,
  PackageFileIdInput,
  packageArchiveNotFound,
  packageToolFailure,
  packageToolSource,
  unreadablePackageArchive,
} from "../../api/operations/package-tool.ts";
import { toConversationTool } from "../../api/operations/tool.ts";
import { actorType } from "../../audit/actor.ts";
import { OPENAPI_INFO } from "../../http/openapi.ts";
import {
  exportTenantPackage,
  loadStoredPackageArchive,
  PackageArchiveError,
  PackageArchiveNotFoundError,
  type PackagePlan,
  PackageTooLargeError,
  previewPackageImport,
} from "../../identity/index.ts";
import { PackageItemKindSchema } from "../../identity/portability/format.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { resolvePublicBaseUrl } from "./usage-guidance.ts";

function instanceName(): string | null {
  const base = resolvePublicBaseUrl();
  if (!base) return null;
  try {
    return new URL(base).host;
  } catch {
    return null;
  }
}

function archiveFailure(err: unknown): ToolResult | null {
  if (err instanceof PackageArchiveNotFoundError) return packageArchiveNotFound();
  if (err instanceof PackageArchiveError) return unreadablePackageArchive(err.code, err.detail);
  return null;
}

function compactPlan(file_id: string, plan: PackagePlan) {
  const { items, truncated } = compactPackageItems(
    plan.items.map((item) => ({
      kind: item.kind,
      key: item.key,
      action: item.action,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.missing && item.missing.length > 0 ? { missing: item.missing } : {}),
    })),
  );
  return {
    file_id,
    package_id: plan.package_id,
    package_version: plan.package_version,
    content_digest: plan.content_digest,
    plan_digest: plan.plan_digest,
    summary: plan.summary,
    items,
    items_truncated: truncated,
    requires: plan.requires,
  };
}

type PlanWords = readonly [one: string, other: string];

const PLAN_COPY = {
  en: {
    create: ["create", "create"],
    update: ["update", "update"],
    unchanged: ["unchanged", "unchanged"],
    conflict: ["conflict", "conflict"],
    credential: ["credential", "credentials"],
    approval: ["approval", "approvals"],
    schedule_resume: ["paused schedule", "paused schedules"],
    knowledge_review: ["knowledge review", "knowledge reviews"],
    afterwards: "then",
    nothing: "nothing to import",
  },
  de: {
    create: ["neu", "neu"],
    update: ["aktualisiert", "aktualisiert"],
    unchanged: ["unverändert", "unverändert"],
    conflict: ["Konflikt", "Konflikte"],
    credential: ["Zugangsdaten", "Zugangsdaten"],
    approval: ["Freigabe", "Freigaben"],
    schedule_resume: ["pausierter Zeitplan", "pausierte Zeitpläne"],
    knowledge_review: ["Wissensprüfung", "Wissensprüfungen"],
    afterwards: "danach",
    nothing: "nichts zu importieren",
  },
} as const;

function counted(count: number, [one, other]: PlanWords): string {
  return `${count} ${count === 1 ? one : other}`;
}

export function formatPackagePlanTitle(
  filename: string,
  plan: PackagePlan,
  locale: ToolContext["locale"],
): string {
  const copy = PLAN_COPY[locale ?? "de"];
  const actions = (["create", "update", "unchanged", "conflict"] as const)
    .filter((action) => plan.summary[action] > 0)
    .map((action) => counted(plan.summary[action], copy[action]));
  const needs = (["credential", "approval", "schedule_resume", "knowledge_review"] as const)
    .map((kind) => ({
      count: plan.requires.filter((requirement) => requirement.kind === kind).length,
      words: copy[kind],
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => counted(entry.count, entry.words));
  return [
    filename,
    ...(actions.length > 0 ? actions : [copy.nothing]),
    ...(needs.length > 0 ? [`${copy.afterwards} ${needs.join(", ")}`] : []),
  ].join(" · ");
}

export const exportTenantPackageTool: ConversationTool = {
  name: "export_tenant_package",
  description:
    "Export this tenant's connector templates, connectors (without secrets), files, skills, workflows, schedules and knowledge as one SubKit package file. Optional kinds and categories limit the export; everything the selection depends on comes along. Returns only a file reference (input_file id and sha256), size, content digest, item counts and what an importer must supply (credentials, approvals, reviews). Never returns the archive contents.",
  inputSchema: z
    .object({
      kinds: z
        .array(PackageItemKindSchema)
        .min(1)
        .optional()
        .describe("Item kinds to include; omit for all kinds."),
      categories: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(50)
        .optional()
        .describe("Catalog categories to export, one area per package; omit for all."),
    })
    .strict()
    .openapi("ExportTenantPackageToolInput"),
  category: "tenant_write",
  authoring_only: true,
  permission: { action: "package:export", resourceType: "package" },
  async execute(ctx, args) {
    const principal = ctx.principal;
    if (!principal) return authenticationRequired();
    const input = args as {
      kinds?: z.infer<typeof PackageItemKindSchema>[];
      categories?: string[];
    };
    try {
      const exported = await exportTenantPackage(ctx.db, {
        tenant_id: ctx.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: packageToolSource(ctx),
        kinds: input.kinds,
        categories: input.categories,
        source: { instance: instanceName(), engine_version: OPENAPI_INFO.version },
      });
      return {
        ok: true,
        data: {
          input_file: { id: toFileId(exported.file_id), sha256: exported.sha256 },
          filename: exported.filename,
          size_bytes: exported.size_bytes,
          content_digest: exported.content_digest,
          items_summary: exported.items_summary,
          requires: exported.requires,
        },
      };
    } catch (err) {
      if (err instanceof PackageTooLargeError) {
        return packageToolFailure(
          "package_too_large",
          `The package would hold ${err.total_bytes} bytes; the limit is ${err.limit_bytes}. Export fewer kinds or categories.`,
        );
      }
      throw err;
    }
  },
};

export const previewPackageImportTool: ConversationTool = {
  name: "preview_package_import",
  description:
    "Check a stored SubKit package file against this tenant without changing anything. Returns the plan digest, counts per action (create, update, unchanged, conflict), the items that would change or conflict, and what must be supplied after import. Pass plan_digest unchanged to apply_package_import.",
  inputSchema: z
    .object({ file_id: PackageFileIdInput })
    .strict()
    .openapi("PreviewPackageImportToolInput"),
  category: "tenant_read",
  authoring_only: true,
  accepts_attachment_file_id: true,
  permission: { action: "package:import", resourceType: "package" },
  async execute(ctx, args) {
    const { file_id } = args as { file_id: string };
    const id = parseFileId(file_id);
    if (!id) return invalidPackageFileId();
    try {
      const stored = await loadStoredPackageArchive(ctx.db, ctx.tenant_id, id);
      const plan = await previewPackageImport(ctx.db, ctx.tenant_id, stored.bytes);
      return { ok: true, data: compactPlan(file_id, plan) };
    } catch (err) {
      const mapped = archiveFailure(err);
      if (mapped) return mapped;
      throw err;
    }
  },
};

export const applyPackageImportTool: ConversationTool = {
  ...toConversationTool(applyPackageImportOperation),
  authoring_only: true,
  accepts_attachment_file_id: true,
};
