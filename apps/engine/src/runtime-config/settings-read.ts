// What a reader of the settings is told, asked once.
//
// `GET /v1/settings`, `GET /v1/settings/{path}` and the MCP read tool
// `subkit_settings` each used to carry their own copy of "walk the leaves,
// mask the secrets, name the source". The copies agreed on the value and
// disagreed on the rest: MCP spelled the restart flag `requires_restart` where
// the API says `requiresRestart`, carried no saved/active revision and no
// activation status, and returned the whole internal source map as its
// diagnostics. A reader could not hold one answer against the other.
//
// A setting nobody set reads `null` on every surface — never an absent key a
// client might render as the word "undefined", or skip.

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
  /** The effective value; `null` when nobody set it. A secret reads `***` once set. */
  value: unknown;
  meta: {
    source: SettingSource;
    scope: "global" | "tenant";
    sensitive: boolean;
    requiresRestart: boolean;
    description?: string;
    kind: string;
    /** The schema default; a secret's default reads `***`. Absent when there is none. */
    default?: unknown;
    /** The allowed values of an enum setting. */
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

/** A value as a write's result and audit row carry it: a set secret is `***`. */
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

/** One setting as the reader sees it, or null for an unknown path. */
export function readSettingEntry(path: string, tenantId?: string): SettingEntry | null {
  const leaf = findLeafByPath(path);
  if (!leaf) return null;
  return entryFor(leaf, tenantId, getConfig(tenantId), getDiagnostics().source_map);
}

/** Every setting, in catalog order. */
export function readSettingEntries(tenantId?: string): SettingEntry[] {
  const config = getConfig(tenantId);
  const sourceMap = getDiagnostics().source_map;
  return listConfigLeaves().map((leaf) => entryFor(leaf, tenantId, config, sourceMap));
}

/**
 * The settings list with its revision state: which revision is saved, which
 * is active, whether activation waits on a restart and for which fields.
 */
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
