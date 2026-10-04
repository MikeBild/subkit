import { getConfig, getDiagnostics } from "../config/loader.ts";
import {
  type ConfigLeaf,
  dottedPath,
  findLeafByPath,
  leafSchemaMeta,
  listConfigLeaves,
} from "../config/walk.ts";
import type { Executor } from "../db/client.ts";
import { getRuntimeConfigState, RuntimeConfigNotFoundError } from "./service.ts";

export type SettingSource = "override" | "tenant" | "global" | "default";

export interface SettingEntry {
  path: string;
  value: unknown;
  meta: {
    source: SettingSource;
    scope: "global" | "tenant";
    sensitive: boolean;
    requiresRestart: boolean;
    description?: string;
    kind: string;
    default?: unknown;
    enum_values?: string[];
  };
}

export interface SettingsList {
  saved_revision: number | null;
  active_revision: number | null;
  activation_status: "saved" | "preparing" | "active" | "failed" | "restart_required" | null;
  pending_restart_fields: string[];
  items: SettingEntry[];
  diagnostics: { pending_restart_keys: string[]; override_keys: string[] };
}

function readDeep(source: unknown, leafPath: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const segment of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function maskedSettingValue(secret: boolean, value: unknown): unknown {
  if (!secret || value === undefined || value === null || value === "") return value;
  return "***";
}

function shownValue(leaf: ConfigLeaf, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return maskedSettingValue(!!leaf.meta.secret, value);
}

function sourceForLeaf(
  leaf: ConfigLeaf,
  tenantId: string | undefined,
  globalSourceMap: Record<string, SettingSource>,
): SettingSource {
  const dotted = dottedPath(leaf);
  if (!tenantId) return globalSourceMap[dotted] ?? "default";
  const tenantOverlay = getConfig().tenants?.[tenantId];
  return readDeep(tenantOverlay, leaf.path) !== undefined
    ? "tenant"
    : (globalSourceMap[dotted] ?? "default");
}

function entryFor(
  leaf: ConfigLeaf,
  tenantId: string | undefined,
  config: unknown,
  sourceMap: Record<string, SettingSource>,
): SettingEntry {
  return {
    path: dottedPath(leaf),
    value: shownValue(leaf, readDeep(config, leaf.path)),
    meta: {
      source: sourceForLeaf(leaf, tenantId, sourceMap),
      scope: leaf.meta.scope ?? "global",
      sensitive: !!leaf.meta.secret,
      requiresRestart: !!leaf.meta.requiresRestart,
      ...(leaf.description ? { description: leaf.description } : {}),
      kind: leaf.kind,
      ...leafSchemaMeta(leaf),
    },
  };
}

export function readSettingEntry(path: string, tenantId?: string): SettingEntry | null {
  const leaf = findLeafByPath(path);
  if (!leaf) return null;
  return entryFor(leaf, tenantId, getConfig(tenantId), getDiagnostics().source_map);
}

export function readSettingEntries(tenantId?: string): SettingEntry[] {
  const config = getConfig(tenantId);
  const sourceMap = getDiagnostics().source_map;
  return listConfigLeaves().map((leaf) => entryFor(leaf, tenantId, config, sourceMap));
}

export async function readSettingsList(
  db: Executor,
  tenantId?: string,
  items: SettingEntry[] = readSettingEntries(tenantId),
): Promise<SettingsList> {
  const diagnostics = getDiagnostics();
  let state: Awaited<ReturnType<typeof getRuntimeConfigState>> | null = null;
  try {
    state = await getRuntimeConfigState(db);
  } catch (error) {
    if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
  }
  return {
    saved_revision: state?.saved_revision ?? null,
    active_revision: state?.active_revision ?? null,
    activation_status: state?.activation_status ?? null,
    pending_restart_fields: state?.pending_restart_fields ?? diagnostics.pending_restart_keys,
    items,
    diagnostics: {
      pending_restart_keys: diagnostics.pending_restart_keys,
      override_keys: diagnostics.override_keys,
    },
  };
}
