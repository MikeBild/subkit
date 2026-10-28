import { z } from "@hono/zod-openapi";
import {
  type ApplyPackageResult,
  type ExportTenantPackageResult,
  PackageItemKindSchema,
  type PackagePlan,
  PackageRequirementSchema,
} from "../identity/index.ts";
import { FileIdSchema } from "./files-schemas.ts";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const ItemSummarySchema = z.object({
  connector_template: z.number().int(),
  connector: z.number().int(),
  file: z.number().int(),
  skill: z.number().int(),
  workflow: z.number().int(),
  schedule: z.number().int(),
  knowledge: z.number().int(),
});

export const PackageExportRequestSchema = z
  .object({ kinds: z.array(PackageItemKindSchema).min(1).optional() })
  .strict()
  .openapi("PackageExportRequest");

export const PackageExportResultSchema = z
  .object({
    file_id: FileIdSchema,
    filename: z.string(),
    sha256: Sha256Schema,
    size_bytes: z.number().int(),
    content_digest: Sha256Schema,
    items_summary: ItemSummarySchema,
    requires: z.array(PackageRequirementSchema),
  })
  .openapi("PackageExportResult");

export const PackagePlanActionSchema = z.enum(["create", "update", "unchanged", "conflict"]);

export const PackageConflictReasonSchema = z.enum([
  "exists_unmanaged",
  "local_changes",
  "reserved",
  "manual_update_required",
  "missing_dependency",
  "knowledge_changed",
]);

export const PackagePlanItemSchema = z
  .object({
    kind: PackageItemKindSchema,
    key: z.string(),
    action: PackagePlanActionSchema,
    reason: PackageConflictReasonSchema.optional(),
    missing: z.array(z.string()).optional(),
    local_id: z.string().nullable(),
  })
  .openapi("PackagePlanItem");

export const PackagePlanSchema = z
  .object({
    package_id: z.string(),
    package_version: z.string(),
    content_digest: Sha256Schema,
    plan_digest: Sha256Schema,
    items: z.array(PackagePlanItemSchema),
    requires: z.array(PackageRequirementSchema),
    summary: z.object({
      create: z.number().int(),
      update: z.number().int(),
      unchanged: z.number().int(),
      conflict: z.number().int(),
    }),
  })
  .openapi("PackagePlan");

export const PackagePreviewJsonRequestSchema = z
  .object({ archive_file_id: FileIdSchema })
  .strict()
  .openapi("PackagePreviewRequest");

export const PackagePreviewResultSchema = z
  .object({ archive_file_id: FileIdSchema, plan: PackagePlanSchema })
  .openapi("PackagePreviewResult");

export const PackageApplyRequestSchema = z
  .object({ archive_file_id: FileIdSchema, expected_plan_digest: Sha256Schema })
  .strict()
  .openapi("PackageApplyRequest");

export const PackageAppliedItemSchema = z
  .object({
    kind: PackageItemKindSchema,
    key: z.string(),
    action: z.enum(["create", "update", "unchanged", "conflict", "failed"]),
    local_id: z.string().nullable(),
    errors: z.array(z.string()).optional(),
    review: z
      .object({ intake_item_id: z.string(), proposal_id: z.string(), path: z.string() })
      .optional(),
  })
  .openapi("PackageAppliedItem");

export const PackageApplyResultSchema = z
  .object({
    install_id: z.string().uuid().nullable(),
    plan_digest: Sha256Schema,
    items: z.array(PackageAppliedItemSchema),
    requires: z.array(PackageRequirementSchema),
    summary: z.object({
      create: z.number().int(),
      update: z.number().int(),
      unchanged: z.number().int(),
      conflict: z.number().int(),
      failed: z.number().int(),
    }),
  })
  .openapi("PackageApplyResult");

export const PackageInstallSchema = z
  .object({
    id: z.string().uuid(),
    package_id: z.string(),
    package_version: z.string(),
    format: z.string(),
    content_digest: z.string(),
    archive_file_id: z.union([FileIdSchema, z.null()]),
    source: z.record(z.string(), z.unknown()),
    installed_by_type: z.string(),
    installed_by_id: z.string().uuid().nullable(),
    summary: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PackageInstall");

export const PackageInstallItemSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    item_key: z.string(),
    local_id: z.string().uuid().nullable(),
    imported_hash: z.string(),
    local_hash: z.string().nullable(),
    state: z.string(),
    intake_proposal_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PackageInstallItem");

export const PackageInstallListSchema = z
  .object({ items: z.array(PackageInstallSchema) })
  .openapi("PackageInstallList");

export const PackageInstallDetailSchema = PackageInstallSchema.extend({
  items: z.array(PackageInstallItemSchema),
}).openapi("PackageInstallDetail");

export const packageSchemaParity: [
  Exact<keyof z.infer<typeof PackagePlanSchema>, keyof PackagePlan>,
  Exact<keyof z.infer<typeof PackagePlanItemSchema>, keyof PackagePlan["items"][number]>,
  Exact<keyof z.infer<typeof PackageApplyResultSchema>, keyof ApplyPackageResult>,
  Exact<keyof z.infer<typeof PackageAppliedItemSchema>, keyof ApplyPackageResult["items"][number]>,
  Exact<keyof z.infer<typeof PackageExportResultSchema>, keyof ExportTenantPackageResult>,
] = [true, true, true, true, true];
