import { apiCall } from "@/api/call";
import type { CatalogKind, MetadataPatch } from "./catalog-metadata-model";

export type CatalogMetadataBody = MetadataPatch & {
  accept_description?: boolean;
  name?: string;
  filename?: string;
  title?: string;
};

export function patchCatalogMetadata(
  kind: CatalogKind,
  id: string,
  body: CatalogMetadataBody,
): Promise<unknown> {
  if (kind === "workflow")
    return apiCall("patch", "/v1/workflows/{id}/metadata", { path: { id }, body });
  if (kind === "connector") return apiCall("patch", "/v1/connectors/{id}", { path: { id }, body });
  if (kind === "knowledge_source")
    return apiCall("patch", "/v1/knowledge-sources/{id}", { path: { id }, body });
  if (kind === "skill") return apiCall("patch", "/v1/skills/{id}", { path: { id }, body });
  return apiCall("patch", "/v1/files/{id}", { path: { id }, body });
}
