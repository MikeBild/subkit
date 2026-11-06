import { z } from "@hono/zod-openapi";
import { actorOf, actorType } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { HttpError } from "../../http/errors.ts";
import { OPENAPI_INFO } from "../../http/openapi.ts";
import { applyPackageImport, PackagePlanChangedError } from "../../identity/portability/apply.ts";
import { PackageArchiveError } from "../../identity/portability/archive-read.ts";
import { PackageTooLargeError } from "../../identity/portability/collect.ts";
import { exportTenantPackage } from "../../identity/portability/export.ts";
import type { PackagePlan } from "../../identity/portability/plan.ts";
import {
  getPackageInstall,
  listPackageInstalls,
  loadStoredPackageArchive,
  PackageArchiveNotFoundError,
} from "../../identity/portability/registry.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { parseFileId, toFileId } from "../files-schemas.ts";
import {
  PackageApplyRequestSchema,
  PackageApplyResultSchema,
  PackageExportRequestSchema,
  PackageExportResultSchema,
  PackageInstallDetailSchema,
  PackageInstallListSchema,
} from "../packages-schemas.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";
import {
  authenticationRequired,
  compactPackageItems,
  invalidPackageFileId,
  PackageFileIdInput,
  packageArchiveNotFound,
  packageReviewUrl,
  packageToolFailure,
  packageToolSource,
  publicBaseUrl,
  unreadablePackageArchive,
} from "./package-tool.ts";

const InstallIdParam = z.object({ id: z.string().uuid() });

const TAGS = ["packages"];

type ExportInput = z.infer<typeof PackageExportRequestSchema>;
type ExportResult = Awaited<ReturnType<typeof exportTenantPackage>>;
type ApplyInput = z.infer<typeof PackageApplyRequestSchema> & {
  readonly request_source?: RequestSource;
};
type ApplyResult = Awaited<ReturnType<typeof applyPackageImport>>;
type InstallRow = Awaited<ReturnType<typeof listPackageInstalls>>[number];
type InstallDetail = NonNullable<Awaited<ReturnType<typeof getPackageInstall>>>;

const ApplyPackageImportToolInput = z
  .object({
    file_id: PackageFileIdInput,
    expected_plan_digest: z
      .string()
      .min(1)
      .describe("plan_digest returned by preview_package_import for this file."),
  })
  .strict()
  .openapi("ApplyPackageImportToolInput");

export function requireFileUuid(wire: string): string {
  const uuid = parseFileId(wire);
  if (uuid === null) throw new HttpError(400, "bad_request", "invalid file id");
  return uuid;
}

function packageErrorRejection(err: unknown): Rejection {
  if (err instanceof PackagePlanChangedError) {
    return reject.status(
      409,
      "package_plan_changed",
      "the import plan changed since preview",
      { plan: err.plan },
      "Review the returned plan and apply again with its plan_digest.",
    );
  }
  if (err instanceof PackageArchiveError) {
    const status = err.code === "package_archive_too_large" ? 413 : 400;
    return reject.status(status, err.code, err.detail);
  }
  if (err instanceof PackageArchiveNotFoundError) {
    return reject.status(
      404,
      "not_found",
      "package archive not found",
      undefined,
      "Upload the archive again with POST /v1/packages/import/preview.",
    );
  }
  if (err instanceof PackageTooLargeError) {
    return reject.status(
      413,
      "package_too_large",
      "package exceeds the size limit",
      { total_bytes: err.total_bytes, limit_bytes: err.limit_bytes },
      "Export fewer kinds or categories.",
    );
  }
  throw err;
}

export function throwPackageError(err: unknown): never {
  const rejection = packageErrorRejection(err);
  throw new HttpError(rejection.status, rejection.code, rejection.message, {
    ...(rejection.details ? { details: rejection.details } : {}),
    ...(rejection.hint ? { hint: rejection.hint } : {}),
  });
}

function applyRejectionResult(rejection: Rejection) {
  if (rejection.status === 401) return authenticationRequired();
  if (rejection.code === "bad_request") return invalidPackageFileId();
  if (rejection.code === "not_found") return packageArchiveNotFound();
  if (rejection.code === "package_plan_changed") {
    const plan = rejection.details?.plan as PackagePlan;
    return packageToolFailure(
      "package_plan_changed",
      "The tenant or package changed since the preview, so nothing was imported. Preview the package again and confirm the new plan.",
      {
        details: { summary: plan.summary },
        next_best_actions: ["preview_package_import"],
      },
    );
  }
  if (rejection.code === "package_too_large")
    return packageToolFailure(rejection.code, rejection.message);
  return unreadablePackageArchive(rejection.code, rejection.message);
}

function iso(value: Date): string {
  return value.toISOString();
}

function installView(row: InstallRow) {
  return {
    id: row.id,
    package_id: row.package_id,
    package_version: row.package_version,
    format: row.format,
    content_digest: row.content_digest,
    archive_file_id: row.archive_file_id ? toFileId(row.archive_file_id) : null,
    source: row.source,
    installed_by_type: row.installed_by_type,
    installed_by_id: row.installed_by_id,
    summary: row.summary,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function installDetailView(found: InstallDetail) {
  return {
    ...installView(found.install),
    items: found.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      item_key: item.item_key,
      local_id: item.local_id,
      imported_hash: item.imported_hash,
      local_hash: item.local_hash,
      state: item.state,
      intake_proposal_id: item.intake_proposal_id,
      created_at: iso(item.created_at),
      updated_at: iso(item.updated_at),
    })),
  };
}

export const exportPackageOperation = defineOperation<ExportInput, ExportResult>({
  id: "package.export",
  summary: "Export the tenant as a package archive",
  permission: "package:export",
  effect: "write",
  audit: AuditAction.DATA_EXPORTED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      return await exportTenantPackage(scope.db, {
        tenant_id: scope.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: scope.request_source ?? "api",
        kinds: body.kinds,
        categories: body.categories,
        source: { instance: publicBaseUrl(), engine_version: OPENAPI_INFO.version },
      });
    } catch (err) {
      return packageErrorRejection(err);
    }
  },
  http: {
    method: "post",
    path: "/v1/packages/export",
    tags: TAGS,
    description:
      "Collects workflows, connectors without secrets, skills, files, schedules and knowledge into a stored package archive. Download it with GET /v1/packages/archives/{file_id}.",
    body: PackageExportRequestSchema,
    bodyRequired: false,
    response: PackageExportResultSchema,
    success: { status: 201, description: "Package archive stored" },
    errors: {
      400: "Invalid request",
      413: "Package exceeds the size limit",
    },
    toInput: ({ json }) => json as ExportInput,
    toBody: (result) => ({ ...result, file_id: toFileId(result.file_id) }),
  },
});

export const applyPackageImportOperation = defineOperation<ApplyInput, ApplyResult>({
  id: "package.import_apply",
  summary: "Apply a previewed package import",
  permission: "package:import",
  effect: "write",
  audit: AuditAction.DATA_IMPORTED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const uuid = parseFileId(input.archive_file_id);
    if (uuid === null) return reject.badRequest("invalid file id");
    try {
      const stored = await loadStoredPackageArchive(scope.db, scope.tenant_id, uuid);
      return await applyPackageImport(scope.db, {
        tenant_id: scope.tenant_id,
        archive: stored.bytes,
        archive_file_id: stored.file_id,
        expected_plan_digest: input.expected_plan_digest,
        who: {
          actor: actorOf(principal),
          actor_type: actorType(principal),
          request_source: input.request_source ?? scope.request_source ?? "api",
        },
      });
    } catch (err) {
      return packageErrorRejection(err);
    }
  },
  http: {
    method: "post",
    path: "/v1/packages/import/apply",
    tags: TAGS,
    body: PackageApplyRequestSchema,
    bodyRequired: true,
    response: PackageApplyResultSchema,
    success: { status: 200, description: "Import result" },
    errors: {
      400: "Invalid archive or request",
      404: "Package archive not found",
      409: "The plan changed since preview; details.plan holds the current plan",
      413: "Archive exceeds the size limit",
    },
    toInput: ({ json }) => json as ApplyInput,
    toBody: (result) => result,
  },
  tool: {
    name: "apply_package_import",
    description:
      "Import a previewed SubKit package file into this tenant. Requires the plan_digest from preview_package_import; if the tenant or package changed since the preview, nothing is imported and the plan must be previewed again. Conflicts are skipped, never overwritten. Imported knowledge waits for human review; credentials, approvals and paused schedules must be completed afterwards.",
    input: ApplyPackageImportToolInput,
    gate: "enforced",
    permission: { resourceType: "package" },
    toInput: (args, ctx) => {
      const { file_id, expected_plan_digest } = args as {
        file_id: string;
        expected_plan_digest: string;
      };
      return {
        archive_file_id: file_id,
        expected_plan_digest,
        request_source: packageToolSource(ctx),
      };
    },
    async guard(input, ctx) {
      if (!ctx.principal) return authenticationRequired();
      if (parseFileId(input.archive_file_id) === null) return invalidPackageFileId();
      return null;
    },
    toResult(outcome) {
      if (isRejection(outcome)) return applyRejectionResult(outcome);
      const { items, truncated } = compactPackageItems(
        outcome.items.map((item) => ({
          kind: item.kind,
          key: item.key,
          action: item.action,
          ...(item.errors && item.errors.length > 0 ? { errors: item.errors } : {}),
          ...(item.review ? { review_url: packageReviewUrl(item.review.path) } : {}),
        })),
      );
      return {
        ok: true,
        data: {
          install_id: outcome.install_id,
          plan_digest: outcome.plan_digest,
          summary: outcome.summary,
          items,
          items_truncated: truncated,
          requires: outcome.requires,
        },
      };
    },
  },
});

export const listPackageInstallsOperation = defineOperation<Record<string, never>, InstallRow[]>({
  id: "package.install_list",
  summary: "List package installs",
  permission: "package:import",
  effect: "read",
  handler: (scope) => listPackageInstalls(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/packages/installs",
    tags: TAGS,
    response: PackageInstallListSchema,
    success: { status: 200, description: "Package installs" },
    toInput: () => ({}),
    toBody: (rows) => ({ items: rows.map(installView) }),
  },
});

export const getPackageInstallOperation = defineOperation<{ id: string }, InstallDetail>({
  id: "package.install_get",
  summary: "Get one package install with its items",
  permission: "package:import",
  effect: "read",
  async handler(scope, { id }) {
    const found = await getPackageInstall(scope.db, scope.tenant_id, id);
    return found ?? reject.notFound("package install");
  },
  http: {
    method: "get",
    path: "/v1/packages/installs/{id}",
    tags: TAGS,
    params: InstallIdParam,
    response: PackageInstallDetailSchema,
    success: { status: 200, description: "Package install" },
    errors: { 404: "Package install not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: installDetailView,
  },
});
