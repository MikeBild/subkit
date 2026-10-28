import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { EngineError, TransportError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import { parseResponseBody } from "./http.ts";

export type PackageExportResult = components["schemas"]["PackageExportResult"];
export type PackagePlan = components["schemas"]["PackagePlan"];
export type PackagePreviewResult = components["schemas"]["PackagePreviewResult"];
export type PackageApplyResult = components["schemas"]["PackageApplyResult"];
export type PackageInstall = components["schemas"]["PackageInstall"];
export type PackageInstallDetail = components["schemas"]["PackageInstallDetail"];
export type PackageItemKind = PackagePlan["items"][number]["kind"];

export const packagesMethods = {
  exportPackage(
    this: EngineClient,
    body: { kinds?: PackageItemKind[]; categories?: string[] } = {},
  ): Promise<PackageExportResult> {
    return this.request<PackageExportResult>("POST", "/v1/packages/export", body);
  },

  async downloadPackageArchive(
    this: EngineClient,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; sha256: string | null }> {
    const url = `${this.base}/v1/packages/archives/${encodeURIComponent(fileId)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ accept: "application/zip" }, { traceId: this.newClientTraceId() }),
      });
    } catch (cause) {
      throw new TransportError(cause);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EngineError(res.status, parseResponseBody(text));
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      sha256: res.headers.get("x-subkit-sha256"),
    };
  },

  previewPackageUpload(
    this: EngineClient,
    file: { name: string; bytes: Uint8Array },
  ): Promise<PackagePreviewResult> {
    const form = new FormData();
    form.append(
      "archive",
      new Blob([file.bytes as unknown as ArrayBuffer], { type: "application/zip" }),
      file.name,
    );
    return this.requestForm<PackagePreviewResult>("POST", "/v1/packages/import/preview", form);
  },

  previewStoredPackage(this: EngineClient, archiveFileId: string): Promise<PackagePreviewResult> {
    return this.request<PackagePreviewResult>("POST", "/v1/packages/import/preview", {
      archive_file_id: archiveFileId,
    });
  },

  applyPackage(
    this: EngineClient,
    body: { archive_file_id: string; expected_plan_digest: string },
  ): Promise<PackageApplyResult> {
    return this.request<PackageApplyResult>("POST", "/v1/packages/import/apply", body);
  },

  async listPackageInstalls(this: EngineClient): Promise<PackageInstall[]> {
    const res = await this.request<{ items: PackageInstall[] }>("GET", "/v1/packages/installs");
    return res.items;
  },

  getPackageInstall(this: EngineClient, id: string): Promise<PackageInstallDetail> {
    return this.request<PackageInstallDetail>(
      "GET",
      `/v1/packages/installs/${encodeURIComponent(id)}`,
    );
  },
};
