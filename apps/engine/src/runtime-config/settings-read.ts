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

export type SettingsView =
  | { kind: "engine"; tenantId?: string }
  | { kind: "tenant"; tenantId: string };

export interface SettingsList {
  view: "engine" | "tenant";
  tenant_id: string | null;
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
  view: SettingsView,
  globalSourceMap: Record<string, SettingSource>,
): SettingSource {
  const dotted = dottedPath(leaf);
  const globalSource = globalSourceMap[dotted] ?? "default";
  const engineSource =
    view.kind === "tenant" && globalSource === "override" ? "global" : globalSource;
  if (!view.tenantId) return engineSource;
  const tenantOverlay = getConfig().tenants?.[view.tenantId];
  return readDeep(tenantOverlay, leaf.path) !== undefined ? "tenant" : engineSource;
}

function visibleInView(leaf: ConfigLeaf, view: SettingsView): boolean {
  return view.kind === "engine" || leaf.meta.scope === "tenant";
}

function entryFor(
  leaf: ConfigLeaf,
  view: SettingsView,
  config: unknown,
  sourceMap: Record<string, SettingSource>,
): SettingEntry {
  return {
    path: dottedPath(leaf),
    value: shownValue(leaf, readDeep(config, leaf.path)),
    meta: {
      source: sourceForLeaf(leaf, view, sourceMap),
      scope: leaf.meta.scope ?? "global",
      sensitive: !!leaf.meta.secret,
      requiresRestart: !!leaf.meta.requiresRestart,
      ...(leaf.description ? { description: leaf.description } : {}),
      kind: leaf.kind,
      ...leafSchemaMeta(leaf),
    },
  };
}

export function readSettingEntry(path: string, view: SettingsView): SettingEntry | null {
  const leaf = findLeafByPath(path);
  if (!leaf || !visibleInView(leaf, view)) return null;
  return entryFor(leaf, view, getConfig(view.tenantId), getDiagnostics().source_map);
}

export function readSettingEntries(view: SettingsView): SettingEntry[] {
  const config = getConfig(view.tenantId);
  const sourceMap = getDiagnostics().source_map;
  return listConfigLeaves()
    .filter((leaf) => visibleInView(leaf, view))
    .map((leaf) => entryFor(leaf, view, config, sourceMap));
}

export async function readSettingsList(
  db: Executor,
  view: SettingsView,
  items: SettingEntry[] = readSettingEntries(view),
): Promise<SettingsList> {
  if (view.kind === "tenant") {
    return {
      view: "tenant",
      tenant_id: view.tenantId,
      saved_revision: null,
      active_revision: null,
      activation_status: null,
      pending_restart_fields: [],
      items,
      diagnostics: { pending_restart_keys: [], override_keys: [] },
    };
  }
  const diagnostics = getDiagnostics();
  let state: Awaited<ReturnType<typeof getRuntimeConfigState>> | null = null;
  try {
    state = await getRuntimeConfigState(db);
  } catch (error) {
    if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
  }
  return {
    view: "engine",
    tenant_id: view.tenantId ?? null,
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
