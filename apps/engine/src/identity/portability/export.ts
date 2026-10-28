import { AuditAction, auditAwait, bucketSize } from "../../audit/index.ts";
import type { AuditActorType } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { now } from "../../utils/clock.ts";
import { writeDeterministicZip } from "../../utils/zip-write.ts";
import { type CollectedPackage, collectTenantPackage } from "./collect.ts";
import {
  blobPath,
  contentDigest,
  itemPath,
  PACKAGE_CONTENT_TYPE,
  PACKAGE_FORMAT,
  type PackageItemKind,
  type PackageManifest,
  type PackageManifestItem,
  type PackageRequirement,
  payloadBytes,
  sha256Hex,
  sortPayloads,
} from "./format.ts";

export interface PackageSource {
  instance: string | null;
  engine_version: string | null;
}

export interface BuiltPackage {
  manifest: PackageManifest;
  archive: Buffer;
}

export function buildPackageArchive(
  collected: CollectedPackage,
  source: PackageSource,
  exported_at: string,
): BuiltPackage {
  const entries = new Map<string, Uint8Array>();
  const items: PackageManifestItem[] = [];
  for (const item of sortPayloads(collected.payloads)) {
    const path = itemPath(item.kind, item.key);
    const bytes = payloadBytes(item.payload);
    entries.set(path, bytes);
    const manifestItem: PackageManifestItem = {
      kind: item.kind,
      key: item.key,
      path,
      sha256: sha256Hex(bytes),
    };
    if (item.kind === "file") {
      const blob = blobPath(item.key);
      entries.set(blob, item.bytes);
      manifestItem.blob_path = blob;
      manifestItem.blob_sha256 = sha256Hex(item.bytes);
    }
    items.push(manifestItem);
  }
  const digest = contentDigest(items);
  const tenantSlug = collected.tenant_slug;
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    kind: "tenant-export",
    package_id: [
      `tenant-export:${tenantSlug ?? "tenant"}`,
      ...(collected.categories?.length ? [collected.categories.join("+")] : []),
    ]
      .join(":")
      .slice(0, 200),
    version: digest.slice(0, 16),
    source: {
      instance: source.instance,
      tenant_slug: tenantSlug,
      engine_version: source.engine_version,
    },
    exported_at,
    content_digest: digest,
    items,
    requires: sortRequirements(collected.requires),
  };
  entries.set("manifest.json", payloadBytes(manifest));
  return { manifest, archive: writeDeterministicZip(entries) };
}

function requirementKey(requirement: PackageRequirement): string {
  switch (requirement.kind) {
    case "credential":
      return `${requirement.kind}:${requirement.connector}`;
    case "knowledge_review":
      return `${requirement.kind}:${requirement.knowledge}`;
    default:
      return `${requirement.kind}:${requirement.workflow}`;
  }
}

export function sortRequirements(requires: readonly PackageRequirement[]): PackageRequirement[] {
  return [...requires]
    .map((requirement) =>
      requirement.kind === "credential"
        ? { ...requirement, fields: [...requirement.fields].sort() }
        : requirement,
    )
    .sort((a, b) => {
      const left = requirementKey(a);
      const right = requirementKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

export interface ExportTenantPackageParams {
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string;
  request_source: string;
  kinds?: readonly PackageItemKind[] | undefined;
  categories?: readonly string[] | undefined;
  source: PackageSource;
}

export interface ExportTenantPackageResult {
  file_id: string;
  sha256: string;
  size_bytes: number;
  filename: string;
  content_digest: string;
  items_summary: Record<PackageItemKind, number>;
  requires: PackageManifest["requires"];
}

export function summarizeItems(
  items: readonly { kind: PackageItemKind }[],
): Record<PackageItemKind, number> {
  const out: Record<PackageItemKind, number> = {
    connector_template: 0,
    connector: 0,
    file: 0,
    skill: 0,
    workflow: 0,
    schedule: 0,
    knowledge: 0,
  };
  for (const item of items) out[item.kind] += 1;
  return out;
}

export async function exportTenantPackage(
  db: Executor,
  p: ExportTenantPackageParams,
): Promise<ExportTenantPackageResult> {
  const collected = await collectTenantPackage(db, p.tenant_id, {
    kinds: p.kinds,
    categories: p.categories,
    include_bytes: true,
  });
  const exported_at = new Date(now()).toISOString();
  const built = buildPackageArchive(collected, p.source, exported_at);
  const filename = `${collected.tenant_slug ?? "tenant"}-${built.manifest.version}.subkit-package.zip`;
  const saved = await persistInlineUpload(db, {
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    filename,
    content_type: PACKAGE_CONTENT_TYPE,
    bytes: built.archive,
  });
  const items_summary = summarizeItems(built.manifest.items);
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_type,
      actor_id: p.actor_id,
      action: AuditAction.DATA_EXPORTED,
      resource_type: "package",
      resource_id: saved.row.id,
      result: "success",
      metadata: {
        format: PACKAGE_FORMAT,
        content_digest: built.manifest.content_digest,
        size_bytes_bucket: bucketSize(built.archive.byteLength),
        items: items_summary,
        request_source: p.request_source,
      },
    },
    db,
  );
  return {
    file_id: saved.row.id,
    sha256: sha256Hex(built.archive),
    size_bytes: built.archive.byteLength,
    filename,
    content_digest: built.manifest.content_digest,
    items_summary,
    requires: built.manifest.requires,
  };
}
