import { createHash } from "node:crypto";
import { dottedPath, listConfigLeaves } from "../config/walk.ts";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function configDigest(document: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(document)))
    .digest("hex");
}

export function getDeep(source: unknown, path: string[]): unknown {
  let cursor = source;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function setDeep(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const child = cursor[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path.at(-1)!] = value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function restartFieldsDiffering(
  active: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const tenantIds = new Set<string>();
  for (const document of [active, next]) {
    const tenants = getDeep(document, ["tenants"]);
    if (tenants && typeof tenants === "object" && !Array.isArray(tenants)) {
      for (const tenantId of Object.keys(tenants)) tenantIds.add(tenantId);
    }
  }
  const differing = new Set<string>();
  for (const leaf of listConfigLeaves()) {
    if (!leaf.meta.requiresRestart) continue;
    const paths = [leaf.path, ...[...tenantIds].map((id) => ["tenants", id, ...leaf.path])];
    if (paths.some((path) => !sameValue(getDeep(active, path), getDeep(next, path)))) {
      differing.add(dottedPath(leaf));
    }
  }
  return [...differing].sort();
}

function withoutTenantOverlay(
  document: Record<string, unknown>,
  tenantId: string,
): Record<string, unknown> {
  const { tenants: overlays, ...rest } = clone(document);
  if (!overlays || typeof overlays !== "object" || Array.isArray(overlays)) {
    return overlays === undefined ? rest : { ...rest, tenants: overlays };
  }
  const remaining = Object.fromEntries(
    Object.entries(overlays as Record<string, unknown>).filter(([id]) => id !== tenantId),
  );
  return Object.keys(remaining).length === 0 ? rest : { ...rest, tenants: remaining };
}

export function revisionChangesOnlyTenant(
  active: Record<string, unknown>,
  candidate: Record<string, unknown>,
  tenantId: string,
): boolean {
  return (
    configDigest(withoutTenantOverlay(active, tenantId)) ===
    configDigest(withoutTenantOverlay(candidate, tenantId))
  );
}
