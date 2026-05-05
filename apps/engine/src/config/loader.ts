import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig as c12LoadConfig } from "c12";
import type { z } from "zod";
import { type Config, ConfigSchema } from "./schema.ts";
import { type ConfigLeaf, dottedPath, findLeafByPath, listConfigLeaves } from "./walk.ts";

export type SourceTag = "override" | "tenant" | "global" | "default";

export interface SourceMap {
  [dottedKey: string]: SourceTag;
}

export interface Diagnostics {
  source_map: SourceMap;
  pending_restart_keys: string[];
  override_keys: string[];
}

interface LoaderState {
  config: Config;
  configPath: string;
  pendingRestartKeys: Set<string>;
  overrideKeys: Set<string>;
  // Effective source per dotted leaf (global view; tenant overrides are computed on demand).
  globalSourceMap: SourceMap;
}

let _state: LoaderState | null = null;
let _writeLock: Promise<void> = Promise.resolve();

const OVERRIDE_PREFIX = "SK_OVERRIDE_";

export class ConfigLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoaderError";
  }
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string[],
    public readonly expected: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class RestartRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartRequiredError";
  }
}

function envKeyForLeaf(leafPath: string[]): string {
  return OVERRIDE_PREFIX + leafPath.join("_").toUpperCase();
}

function setDeep(target: Record<string, unknown>, leafPath: string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < leafPath.length - 1; i += 1) {
    const segment = leafPath[i] as string;
    if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[leafPath[leafPath.length - 1] as string] = value;
}

function getDeep(source: Record<string, unknown>, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const segment of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function coerceOverrideValue(raw: string, leaf: ConfigLeaf): unknown {
  switch (leaf.kind) {
    case "string":
      return raw;
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new ConfigLoaderError(`${envKeyForLeaf(leaf.path)} must be a number; got "${raw}"`);
      }
      return n;
    }
    case "boolean":
      return raw === "true" || raw === "1";
    case "enum":
      return raw;
    case "string-list":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    case "string-array":
      return JSON.parse(raw);
    default:
      return raw;
  }
}

function collectOverrides(env: Record<string, string | undefined>): {
  overrides: Record<string, unknown>;
  keys: string[];
} {
  const overrides: Record<string, unknown> = {};
  const keys: string[] = [];

  for (const leaf of listConfigLeaves()) {
    const envKey = envKeyForLeaf(leaf.path);
    const raw = env[envKey];
    if (raw === undefined) continue;
    const value = coerceOverrideValue(raw, leaf);
    setDeep(overrides, leaf.path, value);
    keys.push(dottedPath(leaf));
  }

  return { overrides, keys };
}

function defaultConfigPath(env: Record<string, string | undefined>): string {
  const envOverride = env.SUBKIT_CONFIG;
  if (envOverride) return path.resolve(envOverride);
  if (env.NODE_ENV === "production") return "/etc/subkit/subkit.config.json";
  return path.resolve(process.cwd(), "subkit.config.json");
}

async function readConfigFile(configPath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (err instanceof SyntaxError) {
      throw new ConfigLoaderError(
        `subkit.config.json at ${configPath} is invalid JSON: ${err.message}`,
      );
    }
    throw err;
  }
}

async function atomicWrite(configPath: string, content: string): Promise<void> {
  const dir = path.dirname(configPath);
  const tmp = `${configPath}.tmp`;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const fileHandle = await fs.open(tmp, "w", 0o600);
  try {
    await fileHandle.writeFile(content);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  // Best-effort fsync of parent directory so the rename is durable.
  try {
    const dirHandle = await fs.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Some platforms (Windows) reject fsync on directory handles. The
    // subsequent rename is still atomic on the filesystem we target.
  }

  await fs.rename(tmp, configPath);
}

function buildSourceMap(
  raw: Record<string, unknown>,
  overrides: Record<string, unknown>,
): SourceMap {
  const map: SourceMap = {};
  for (const leaf of listConfigLeaves()) {
    const dotted = dottedPath(leaf);
    if (getDeep(overrides, leaf.path) !== undefined) {
      map[dotted] = "override";
      continue;
    }
    const fromFile = getDeep(raw, leaf.path);
    if (fromFile !== undefined) {
      map[dotted] = "global";
      continue;
    }
    map[dotted] = "default";
  }
  return map;
}

function deepMergeReplaceArrays<T>(base: T, overlay: unknown): T {
  if (overlay === undefined || overlay === null) return base;
  if (typeof overlay !== "object" || Array.isArray(overlay)) {
    return overlay as T;
  }
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return overlay as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    if (value === null) continue; // null in overlay = unset → fall through
    out[key] = deepMergeReplaceArrays(out[key], value);
  }
  return out as T;
}

function applyTenantOverlay(global: Config, tenantId: string): Config {
  const overlay = global.tenants?.[tenantId];
  if (!overlay) return global;
  return deepMergeReplaceArrays(global, overlay) as Config;
}

function serialize(config: Config): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function loadConfig(
  opts: { env?: Record<string, string | undefined>; configPathOverride?: string } = {},
): Promise<Config> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const configPath = opts.configPathOverride ?? defaultConfigPath(env);

  const fileRaw = await readConfigFile(configPath);
  const fileObj =
    typeof fileRaw === "object" && fileRaw !== null ? (fileRaw as Record<string, unknown>) : {};

  const { overrides, keys: overrideKeys } = collectOverrides(env);

  // c12 reads + merges from the configFile path. We pass it the
  // already-read `fileObj` via `defaults` and `overrides` for layering;
  // c12 stays in the dep tree so the future `extends:` story is one
  // option call away.
  const { config: merged } = await c12LoadConfig<Record<string, unknown>>({
    name: "subkit",
    cwd: path.dirname(configPath),
    configFile: configPath,
    rcFile: false,
    globalRc: false,
    defaults: fileObj,
    overrides,
  });

  const mergedObj = (merged ?? {}) as Record<string, unknown>;

  // DATABASE_URL fallback: only consulted when database.url is absent.
  const databaseUrlInConfig = (mergedObj.database as Record<string, unknown> | undefined)?.url;
  const databaseUrlInEnv = env.DATABASE_URL;
  if ((databaseUrlInConfig === undefined || databaseUrlInConfig === "") && databaseUrlInEnv) {
    mergedObj.database = { ...((mergedObj.database as object) ?? {}), url: databaseUrlInEnv };
  } else if (
    typeof databaseUrlInConfig === "string" &&
    databaseUrlInConfig !== "" &&
    databaseUrlInEnv &&
    databaseUrlInEnv !== databaseUrlInConfig
  ) {
    // Both present but differ — config wins, warn once.
    const { logger } = await import("../logging/logger.ts");
    logger.warn({
      module: "config",
      msg: "DATABASE_URL env differs from database.url in config; config wins",
    });
  }

  let parsed: Config;
  try {
    parsed = ConfigSchema.parse(mergedObj);
  } catch (err) {
    if (err instanceof Error && "issues" in err) {
      const issues = (err as z.ZodError).issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new ConfigLoaderError(
        `subkit.config.json validation failed at ${configPath}:\n${issues}\n\nSet missing values via SK_OVERRIDE_<KEY> env or \`sk settings configure\`.`,
      );
    }
    throw err;
  }

  // Auto-generate session secret on first boot if missing.
  let needsPersist = false;
  if (!parsed.auth.session.secret) {
    parsed.auth.session.secret = randomBytes(32).toString("hex");
    needsPersist = true;
  }

  if (needsPersist) {
    await atomicWrite(configPath, serialize(parsed));
    const { logger } = await import("../logging/logger.ts");
    logger.info({
      module: "config",
      msg: "auth.session.secret was empty; generated a new value and persisted",
    });
  }

  if (overrideKeys.length > 0) {
    const { logger } = await import("../logging/logger.ts");
    logger.warn({
      module: "config",
      msg: "SK_OVERRIDE_* active",
      override_keys: overrideKeys,
    });
  }

  _state = {
    config: parsed,
    configPath,
    pendingRestartKeys: new Set(),
    overrideKeys: new Set(overrideKeys),
    globalSourceMap: buildSourceMap(mergedObj, overrides),
  };

  return parsed;
}

export function getConfig(tenantId?: string): Config {
  if (_state === null) {
    throw new ConfigLoaderError("getConfig() called before loadConfig()");
  }
  if (!tenantId) return _state.config;
  return applyTenantOverlay(_state.config, tenantId);
}

export function getConfigPath(): string {
  if (_state === null) {
    throw new ConfigLoaderError("getConfigPath() called before loadConfig()");
  }
  return _state.configPath;
}

export function getDiagnostics(): Diagnostics {
  if (_state === null) {
    throw new ConfigLoaderError("getDiagnostics() called before loadConfig()");
  }
  return {
    source_map: { ..._state.globalSourceMap },
    pending_restart_keys: [..._state.pendingRestartKeys],
    override_keys: [..._state.overrideKeys],
  };
}

export interface SetConfigKeyOptions {
  tenantId?: string;
  force?: boolean;
}

export interface SetConfigKeyResult {
  before: unknown;
  after: unknown;
  requiresRestart: boolean;
  scope: "global" | `tenant:${string}`;
  leafPath: string;
}

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _writeLock.then(fn, fn);
  _writeLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function setConfigKey(
  leafPathInput: string | string[],
  value: unknown,
  opts: SetConfigKeyOptions = {},
): Promise<SetConfigKeyResult> {
  if (_state === null) {
    throw new ConfigLoaderError("setConfigKey() called before loadConfig()");
  }

  const leafPath = Array.isArray(leafPathInput) ? leafPathInput : leafPathInput.split(".");
  const leaf = findLeafByPath(leafPath);
  if (!leaf) {
    throw new ScopeViolationError(`unknown setting path: ${leafPath.join(".")}`);
  }

  if (opts.tenantId && leaf.meta.scope !== "tenant") {
    throw new ScopeViolationError(
      `${leafPath.join(".")} is scope="global"; cannot be set per-tenant`,
    );
  }

  // Validate value through the leaf's schema (unwrap default/optional/nullable wrappers).
  const innerSchema = (leaf.schema as { def?: unknown }).def ? leaf.schema : leaf.schema;
  const parseResult = innerSchema.safeParse(value);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    if (!issue) {
      throw new ValidationError("validation_failed", leafPath, leaf.kind);
    }
    throw new ValidationError(issue.message, [...leafPath, ...(issue.path as string[])], leaf.kind);
  }
  const validatedValue = parseResult.data;

  const requiresRestart = !!leaf.meta.requiresRestart;
  if (requiresRestart && process.env.NODE_ENV === "production" && !opts.force) {
    throw new RestartRequiredError(
      `${leafPath.join(".")} requires a restart in production. Re-run with force=true to apply.`,
    );
  }

  return withWriteLock(async () => {
    const state = _state as LoaderState;
    let updatedConfig: Config;
    let beforeValue: unknown;

    if (opts.tenantId) {
      const tenants = { ...(state.config.tenants ?? {}) };
      const existingOverlay = (tenants[opts.tenantId] as Record<string, unknown> | undefined) ?? {};
      const newOverlay = JSON.parse(JSON.stringify(existingOverlay)) as Record<string, unknown>;
      beforeValue = getDeep(newOverlay, leafPath);
      setDeep(newOverlay, leafPath, validatedValue);
      tenants[opts.tenantId] = newOverlay as never;
      updatedConfig = { ...state.config, tenants };
    } else {
      const next = JSON.parse(JSON.stringify(state.config)) as Config;
      beforeValue = getDeep(next as unknown as Record<string, unknown>, leafPath);
      setDeep(next as unknown as Record<string, unknown>, leafPath, validatedValue);
      updatedConfig = next;
    }

    // Re-validate the whole config after the targeted edit so cross-leaf
    // refinements stay coherent.
    const fullParse = ConfigSchema.safeParse(updatedConfig);
    if (!fullParse.success) {
      const issue = fullParse.error.issues[0];
      throw new ValidationError(
        issue?.message ?? "validation_failed",
        issue?.path as string[],
        leaf.kind,
      );
    }

    await atomicWrite(state.configPath, serialize(fullParse.data));

    state.config = fullParse.data;
    state.globalSourceMap[dottedPath(leaf)] = opts.tenantId ? "tenant" : "global";
    if (requiresRestart) state.pendingRestartKeys.add(dottedPath(leaf));

    return {
      before: beforeValue,
      after: validatedValue,
      requiresRestart,
      scope: opts.tenantId ? `tenant:${opts.tenantId}` : "global",
      leafPath: dottedPath(leaf),
    };
  });
}

// Test-only — reset module state between cases.
export function _resetConfigForTests(): void {
  _state = null;
  _writeLock = Promise.resolve();
}
