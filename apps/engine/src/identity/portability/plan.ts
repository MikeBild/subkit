import { and, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { packageInstallItems } from "../../db/schema/index.ts";
import type { ReadPackage } from "./archive-read.ts";
import { collectTenantPackage, type PackageIndex } from "./collect.ts";
import {
  canonicalJson,
  type PackageItemKind,
  type PackageManifest,
  type PackagePayload,
  type PackageRequirement,
  payloadHash,
  sha256Hex,
} from "./format.ts";

export { payloadHash };

export type PackagePlanAction = "create" | "update" | "unchanged" | "conflict";

export type PackageConflictReason =
  | "exists_unmanaged"
  | "local_changes"
  | "reserved"
  | "manual_update_required"
  | "missing_dependency"
  | "knowledge_changed";

export interface PackagePlanItem {
  kind: PackageItemKind;
  key: string;
  action: PackagePlanAction;
  reason?: PackageConflictReason;
  missing?: string[];
  local_id: string | null;
}

export interface PackagePlan {
  package_id: string;
  package_version: string;
  content_digest: string;
  plan_digest: string;
  items: PackagePlanItem[];
  requires: PackageRequirement[];
  summary: Record<PackagePlanAction, number>;
}

type RegistryRow = typeof packageInstallItems.$inferSelect;

interface PlanContext {
  plan: PackagePlan;
  target_hashes: Map<string, string>;
  index: PackageIndex;
  registry: Map<string, RegistryRow>;
}

const UPDATABLE: ReadonlySet<PackageItemKind> = new Set(["workflow", "skill"]);

export function itemId(kind: PackageItemKind, key: string): string {
  return `${kind}:${key}`;
}

function indexFor(index: PackageIndex, kind: PackageItemKind): Map<string, string> {
  switch (kind) {
    case "connector_template":
      return index.connector_templates;
    case "connector":
      return index.connectors;
    case "file":
      return index.files;
    case "skill":
      return index.skills;
    case "workflow":
      return index.workflows;
    case "schedule":
      return index.schedules;
    case "knowledge":
      return index.knowledge;
  }
}

function dependencies(item: PackagePayload): { kind: PackageItemKind; key: string }[] {
  switch (item.kind) {
    case "workflow":
      return [
        ...item.payload.connectors.map((key) => ({ kind: "connector" as const, key })),
        ...item.payload.workflows.map((key) => ({ kind: "workflow" as const, key })),
      ];
    case "schedule":
      return [{ kind: "workflow", key: item.payload.workflow }];
    case "skill":
      return [
        ...(item.payload.connector
          ? [{ kind: "connector" as const, key: item.payload.connector }]
          : []),
        ...(item.payload.workflow
          ? [{ kind: "workflow" as const, key: item.payload.workflow }]
          : []),
      ];
    default:
      return [];
  }
}

async function loadRegistry(exec: Executor, tenant_id: string): Promise<Map<string, RegistryRow>> {
  const rows = await exec
    .select()
    .from(packageInstallItems)
    .where(and(eq(packageInstallItems.tenant_id, tenant_id)));
  return new Map(rows.map((row) => [itemId(row.kind as PackageItemKind, row.item_key), row]));
}

export async function targetState(
  exec: Executor,
  tenant_id: string,
): Promise<{ index: PackageIndex; hashes: Map<string, string> }> {
  const target = await collectTenantPackage(exec, tenant_id, { include_bytes: false });
  const hashes = new Map<string, string>();
  for (const item of target.payloads)
    hashes.set(itemId(item.kind, item.key), payloadHash(item.payload));
  return { index: target.index, hashes };
}

function localChanged(
  localId: string | null,
  targetHash: string | undefined,
  registry: RegistryRow,
): boolean {
  return (
    localId !== null &&
    targetHash !== undefined &&
    registry.local_hash !== null &&
    targetHash !== registry.local_hash
  );
}

function decide(
  item: PackagePayload,
  archiveHash: string,
  localId: string | null,
  targetHash: string | undefined,
  registry: RegistryRow | undefined,
): Pick<PackagePlanItem, "action" | "reason"> {
  if (item.kind === "knowledge") {
    if (registry) {
      if (localChanged(localId, targetHash, registry))
        return { action: "conflict", reason: "local_changes" };
      return registry.imported_hash === archiveHash
        ? { action: "unchanged" }
        : { action: "conflict", reason: "knowledge_changed" };
    }
    return localId ? { action: "conflict", reason: "exists_unmanaged" } : { action: "create" };
  }
  if (!localId) return { action: "create" };
  if (item.kind === "file") return { action: "unchanged" };
  if (!registry) return { action: "conflict", reason: "exists_unmanaged" };
  if (targetHash === undefined) return { action: "conflict", reason: "reserved" };
  if (localChanged(localId, targetHash, registry))
    return { action: "conflict", reason: "local_changes" };
  if (registry.imported_hash === archiveHash) return { action: "unchanged" };
  return UPDATABLE.has(item.kind)
    ? { action: "update" }
    : { action: "conflict", reason: "manual_update_required" };
}

export async function planPackageImport(
  exec: Executor,
  tenant_id: string,
  pkg: ReadPackage,
): Promise<PlanContext> {
  const { index, hashes } = await targetState(exec, tenant_id);
  const registry = await loadRegistry(exec, tenant_id);
  const inArchive = new Set(pkg.payloads.map((item) => itemId(item.kind, item.key)));
  const items: PackagePlanItem[] = [];
  const targetHashes = new Map(hashes);
  for (const item of pkg.payloads) {
    const archiveHash = payloadHash(item.payload);
    const registered = registry.get(itemId(item.kind, item.key));
    const localKey =
      item.kind === "knowledge" && registered?.local_id
        ? [...index.knowledge].find(([, id]) => id === registered.local_id)?.[0]
        : item.key;
    const localId =
      (localKey === undefined ? undefined : indexFor(index, item.kind).get(localKey)) ?? null;
    const targetHash = localKey === undefined ? undefined : hashes.get(itemId(item.kind, localKey));
    if (targetHash === undefined) targetHashes.delete(itemId(item.kind, item.key));
    else targetHashes.set(itemId(item.kind, item.key), targetHash);
    const decision = decide(item, archiveHash, localId, targetHash, registered);
    const missing = dependencies(item)
      .filter(
        (dep) =>
          !inArchive.has(itemId(dep.kind, dep.key)) && !indexFor(index, dep.kind).has(dep.key),
      )
      .map((dep) => itemId(dep.kind, dep.key));
    if (missing.length > 0 && (decision.action === "create" || decision.action === "update")) {
      items.push({
        kind: item.kind,
        key: item.key,
        action: "conflict",
        reason: "missing_dependency",
        missing,
        local_id: localId,
      });
      continue;
    }
    items.push({ kind: item.kind, key: item.key, ...decision, local_id: localId });
  }
  const summary: Record<PackagePlanAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    conflict: 0,
  };
  for (const item of items) summary[item.action] += 1;
  const plan_digest = sha256Hex(
    canonicalJson({
      content_digest: pkg.manifest.content_digest,
      items: items.map((item) => ({
        ...item,
        target_hash: targetHashes.get(itemId(item.kind, item.key)) ?? null,
        registry: registry.get(itemId(item.kind, item.key))?.local_hash ?? null,
      })),
    }),
  );
  return {
    plan: {
      package_id: pkg.manifest.package_id,
      package_version: pkg.manifest.version,
      content_digest: pkg.manifest.content_digest,
      plan_digest,
      items,
      requires: pkg.manifest.requires,
      summary,
    },
    target_hashes: targetHashes,
    index,
    registry,
  };
}

export function manifestSource(manifest: PackageManifest): Record<string, unknown> {
  return { ...manifest.source, exported_at: manifest.exported_at, kind: manifest.kind };
}
