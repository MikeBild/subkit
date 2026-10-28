import { apiRequest } from "./client";
import type { components } from "./schema";
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

export function exportPackage(kinds: readonly PackageKind[]): Promise<PackageExportResult> {
  return apiRequest("/v1/packages/export", {
    method: "POST",
    body: JSON.stringify({ kinds }),
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
  return apiRequest("/v1/packages/import/preview", {
    method: "POST",
    body: JSON.stringify({ archive_file_id: archiveFileId }),
  });
}

export function applyPackage(
  archiveFileId: string,
  expectedPlanDigest: string,
): Promise<PackageApplyResult> {
  return apiRequest("/v1/packages/import/apply", {
    method: "POST",
    body: JSON.stringify({
      archive_file_id: archiveFileId,
      expected_plan_digest: expectedPlanDigest,
    }),
  });
}

export function listPackageInstalls(): Promise<PackageInstallList> {
  return apiRequest("/v1/packages/installs");
}
