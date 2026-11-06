import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";
import { apiRequest } from "./client";
import { tenantContentHref } from "./tenant-context";

export const PACKAGE_KINDS = [
  "connector_template",
  "connector",
  "file",
  "skill",
  "workflow",
  "schedule",
  "knowledge",
] as const;

export type PackageKind = (typeof PACKAGE_KINDS)[number];
export type PackageRequirement = components["schemas"]["PackageRequirement"];
export type PackageExportResult = components["schemas"]["PackageExportResult"];
export type PackagePlan = components["schemas"]["PackagePlan"];
export type PackagePlanItem = components["schemas"]["PackagePlanItem"];
export type PackagePlanAction = PackagePlanItem["action"];
export type PackageConflictReason = NonNullable<PackagePlanItem["reason"]>;
export type PackagePreviewResult = components["schemas"]["PackagePreviewResult"];
export type PackageAppliedItem = components["schemas"]["PackageAppliedItem"];
export type PackageAppliedAction = PackageAppliedItem["action"];
export type PackageApplyResult = components["schemas"]["PackageApplyResult"];
export type PackageInstall = components["schemas"]["PackageInstall"];
export type PackageInstallList = components["schemas"]["PackageInstallList"];

export function exportPackage(input: {
  kinds: readonly PackageKind[];
  categories?: readonly string[];
}): Promise<PackageExportResult> {
  return apiCall("post", "/v1/packages/export", {
    body: {
      kinds: [...input.kinds],
      ...(input.categories && input.categories.length > 0
        ? { categories: [...input.categories] }
        : {}),
    },
  });
}

export function packageArchiveHref(fileId: string): string {
  return tenantContentHref(`/v1/packages/archives/${encodeURIComponent(fileId)}`);
}

export function previewPackageFile(file: File): Promise<PackagePreviewResult> {
  const form = new FormData();
  form.set("archive", file, file.name);
  return apiRequest("/v1/packages/import/preview", { method: "POST", body: form });
}

export function previewStoredPackage(archiveFileId: string): Promise<PackagePreviewResult> {
  return apiCall("post", "/v1/packages/import/preview", {
    body: { archive_file_id: archiveFileId },
  });
}

export function applyPackage(
  archiveFileId: string,
  expectedPlanDigest: string,
): Promise<PackageApplyResult> {
  return apiCall("post", "/v1/packages/import/apply", {
    body: { archive_file_id: archiveFileId, expected_plan_digest: expectedPlanDigest },
  });
}

export function listPackageInstalls(): Promise<PackageInstallList> {
  return apiCall("get", "/v1/packages/installs", {});
}
