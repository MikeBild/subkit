import { z } from "@hono/zod-openapi";
import { actorOf, actorType } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { HttpError } from "../../http/errors.ts";
import { applyPackageImport, PackagePlanChangedError } from "../../identity/portability/apply.ts";
import { PackageArchiveError } from "../../identity/portability/archive-read.ts";
import { PackageTooLargeError } from "../../identity/portability/collect.ts";
import {
  getPackageInstall,
  listPackageInstalls,
  loadStoredPackageArchive,
  PackageArchiveNotFoundError,
} from "../../identity/portability/registry.ts";
import { parseFileId, toFileId } from "../files-schemas.ts";
import {
  PackageApplyRequestSchema,
  PackageApplyResultSchema,
  PackageInstallDetailSchema,
  PackageInstallListSchema,
} from "../packages-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const InstallIdParam = z.object({ id: z.string().uuid() });

const TAGS = ["packages"];

type ApplyInput = z.infer<typeof PackageApplyRequestSchema>;
type ApplyResult = Awaited<ReturnType<typeof applyPackageImport>>;
type InstallRow = Awaited<ReturnType<typeof listPackageInstalls>>[number];
type InstallDetail = NonNullable<Awaited<ReturnType<typeof getPackageInstall>>>;

export function requireFileUuid(wire: string): string {
  const uuid = parseFileId(wire);
  if (uuid === null) throw new HttpError(400, "bad_request", "invalid file id");
  return uuid;
}

export function throwPackageError(err: unknown): never {
  if (err instanceof PackagePlanChangedError) {
    throw new HttpError(409, "package_plan_changed", "the import plan changed since preview", {
      hint: "Review the returned plan and apply again with its plan_digest.",
      details: { plan: err.plan },
    });
  }
  if (err instanceof PackageArchiveError) {
    const status = err.code === "package_archive_too_large" ? 413 : 400;
    throw new HttpError(status, err.code, err.detail);
  }
  if (err instanceof PackageArchiveNotFoundError) {
    throw new HttpError(404, "not_found", "package archive not found", {
      hint: "Upload the archive again with POST /v1/packages/import/preview.",
    });
  }
  if (err instanceof PackageTooLargeError) {
    throw new HttpError(413, "package_too_large", "package exceeds the size limit", {
      details: { total_bytes: err.total_bytes, limit_bytes: err.limit_bytes },
      hint: "Export fewer kinds or categories.",
    });
  }
  throw err;
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

export const applyPackageImportOperation = defineOperation<ApplyInput, ApplyResult>({
  id: "package.import_apply",
  summary: "Apply a previewed package import",
  permission: "package:import",
  effect: "write",
  audit: AuditAction.DATA_IMPORTED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const uuid = requireFileUuid(body.archive_file_id);
    try {
      const stored = await loadStoredPackageArchive(scope.db, scope.tenant_id, uuid);
      return await applyPackageImport(scope.db, {
        tenant_id: scope.tenant_id,
        archive: stored.bytes,
        archive_file_id: stored.file_id,
        expected_plan_digest: body.expected_plan_digest,
        who: {
          actor: actorOf(principal),
          actor_type: actorType(principal),
          request_source: scope.request_source ?? "api",
        },
      });
    } catch (err) {
      throwPackageError(err);
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
