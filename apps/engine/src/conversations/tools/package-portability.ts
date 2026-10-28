import { z } from "@hono/zod-openapi";
import { parseFileId, toFileId } from "../../api/files-schemas.ts";
import { actorOf, actorType } from "../../audit/actor.ts";
import type { Db } from "../../db/client.ts";
import { OPENAPI_INFO } from "../../http/openapi.ts";
import {
  applyPackageImport,
  exportTenantPackage,
  loadStoredPackageArchive,
  PackageArchiveError,
  PackageArchiveNotFoundError,
  type PackagePlan,
  PackagePlanChangedError,
  PackageTooLargeError,
  previewPackageImport,
} from "../../identity/index.ts";
import { PackageItemKindSchema } from "../../identity/portability/format.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { resolvePublicBaseUrl } from "./usage-guidance.ts";

export const PACKAGE_ITEM_LIMIT = 100;

const FileIdInput = z
  .string()
  .min(1)
  .describe("The package file id (fid_…) returned by export_tenant_package or an upload.");

function requestSource(ctx: ToolContext): "mcp" | "chat" {
  return ctx.direct_mcp_invocation === true ? "mcp" : "chat";
}

function instanceName(): string | null {
  const base = resolvePublicBaseUrl();
  if (!base) return null;
  try {
    return new URL(base).host;
  } catch {
    return null;
  }
}

type FailureExtras = Pick<Extract<ToolResult, { ok: false }>, "details" | "next_best_actions">;

function failure(error_code: string, message: string, extra: FailureExtras = {}): ToolResult {
  return { ok: false, error_code, message, ...extra };
}

function authRequired(): ToolResult {
  return failure("authentication_required", "An authenticated caller is required.");
}

function invalidFileId(): ToolResult {
  return failure("invalid_file_id", "file_id must be a package file id in the fid_… form.", {
    next_best_actions: ["export_tenant_package", "list_attachments"],
  });
}

function archiveFailure(err: unknown): ToolResult | null {
  if (err instanceof PackageArchiveNotFoundError) {
    return failure(
      "package_archive_not_found",
      "No ready SubKit package file with this id exists in this tenant.",
      { next_best_actions: ["export_tenant_package", "list_attachments"] },
    );
  }
  if (err instanceof PackageArchiveError) {
    return failure(err.code, `The package file cannot be read: ${err.detail}`);
  }
  return null;
}

function compactItems<T extends { action: string }>(items: readonly T[]) {
  const changed = items.filter((item) => item.action !== "unchanged");
  return {
    items: changed.slice(0, PACKAGE_ITEM_LIMIT),
    truncated: changed.length > PACKAGE_ITEM_LIMIT,
  };
}

function compactPlan(file_id: string, plan: PackagePlan) {
  const { items, truncated } = compactItems(
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

function reviewUrl(path: string): string {
  const base = resolvePublicBaseUrl();
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
}

export const exportTenantPackageTool: ConversationTool = {
  name: "export_tenant_package",
  description:
    "Export this tenant's connector templates, connectors (without secrets), files, skills, workflows, schedules and knowledge as one SubKit package file. Optional kinds limits the export. Returns only a file reference (input_file id and sha256), size, content digest, item counts and what an importer must supply (credentials, approvals, reviews). Never returns the archive contents.",
  inputSchema: z
    .object({
      kinds: z
        .array(PackageItemKindSchema)
        .min(1)
        .optional()
        .describe("Item kinds to include; omit for all kinds."),
    })
    .strict()
    .openapi("ExportTenantPackageToolInput"),
  category: "tenant_write",
  authoring_only: true,
  permission: { action: "package:export", resourceType: "package" },
  async execute(ctx, args) {
    const principal = ctx.principal;
    if (!principal) return authRequired();
    const input = args as { kinds?: z.infer<typeof PackageItemKindSchema>[] };
    try {
      const exported = await exportTenantPackage(ctx.db, {
        tenant_id: ctx.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: requestSource(ctx),
        kinds: input.kinds,
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
        return failure(
          "package_too_large",
          `The package would hold ${err.total_bytes} bytes; the limit is ${err.limit_bytes}. Export fewer kinds.`,
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
  inputSchema: z.object({ file_id: FileIdInput }).strict().openapi("PreviewPackageImportToolInput"),
  category: "tenant_read",
  authoring_only: true,
  permission: { action: "package:import", resourceType: "package" },
  async execute(ctx, args) {
    const { file_id } = args as { file_id: string };
    const id = parseFileId(file_id);
    if (!id) return invalidFileId();
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
  name: "apply_package_import",
  description:
    "Import a previewed SubKit package file into this tenant. Requires the plan_digest from preview_package_import; if the tenant or package changed since the preview, nothing is imported and the plan must be previewed again. Conflicts are skipped, never overwritten. Imported knowledge waits for human review; credentials, approvals and paused schedules must be completed afterwards.",
  inputSchema: z
    .object({
      file_id: FileIdInput,
      expected_plan_digest: z
        .string()
        .min(1)
        .describe("plan_digest returned by preview_package_import for this file."),
    })
    .strict()
    .openapi("ApplyPackageImportToolInput"),
  category: "tenant_write",
  authoring_only: true,
  permission: { action: "package:import", resourceType: "package" },
  async execute(ctx, args) {
    const principal = ctx.principal;
    if (!principal) return authRequired();
    const { file_id, expected_plan_digest } = args as {
      file_id: string;
      expected_plan_digest: string;
    };
    const id = parseFileId(file_id);
    if (!id) return invalidFileId();
    try {
      const stored = await loadStoredPackageArchive(ctx.db, ctx.tenant_id, id);
      const applied = await applyPackageImport(ctx.db as Db, {
        tenant_id: ctx.tenant_id,
        archive: stored.bytes,
        archive_file_id: stored.file_id,
        expected_plan_digest,
        who: {
          actor: actorOf(principal),
          actor_type: actorType(principal),
          request_source: requestSource(ctx),
        },
      });
      const { items, truncated } = compactItems(
        applied.items.map((item) => ({
          kind: item.kind,
          key: item.key,
          action: item.action,
          ...(item.errors && item.errors.length > 0 ? { errors: item.errors } : {}),
          ...(item.review ? { review_url: reviewUrl(item.review.path) } : {}),
        })),
      );
      return {
        ok: true,
        data: {
          install_id: applied.install_id,
          plan_digest: applied.plan_digest,
          summary: applied.summary,
          items,
          items_truncated: truncated,
          requires: applied.requires,
        },
      };
    } catch (err) {
      if (err instanceof PackagePlanChangedError) {
        return failure(
          "package_plan_changed",
          "The tenant or package changed since the preview, so nothing was imported. Preview the package again and confirm the new plan.",
          {
            details: { summary: err.plan.summary },
            next_best_actions: ["preview_package_import"],
          },
        );
      }
      const mapped = archiveFailure(err);
      if (mapped) return mapped;
      throw err;
    }
  },
};
