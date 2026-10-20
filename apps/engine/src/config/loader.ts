import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { z } from "zod";
import {
  ConfigLoaderError,
  RestartRequiredError,
  ScopeViolationError,
  ValidationError,
} from "./errors.ts";
import { parseConfigDocument, safeParseConfigDocument } from "./non-removable-scopes.ts";
import { inspectRetiredMcpSections, retiredSectionMessage } from "./retired-sections.ts";
import type { Config } from "./schema.ts";
import { dottedPath, findLeafByPath, listConfigLeaves } from "./walk.ts";

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
  statelessRuntime: boolean;
  pendingRestartKeys: Set<string>;
  overrideKeys: Set<string>;
  globalSourceMap: SourceMap;
}

let _state: LoaderState | null = null;
let _writeLock: Promise<void> = Promise.resolve();

export {
  ConfigLoaderError,
  RestartRequiredError,
  ScopeViolationError,
  ValidationError,
} from "./errors.ts";

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

function collectBootstrapEnvSeeds(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const seeds: Record<string, unknown> = {};
  if (env.DATABASE_URL) setDeep(seeds, ["database", "url"], env.DATABASE_URL);
  if (env.PORT) {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new ConfigLoaderError(`PORT must be an integer in [1, 65535]; got "${env.PORT}"`);
    }
    setDeep(seeds, ["server", "port"], port);
  }

  const objectStoreBindings: Array<[string, string]> = [
    ["OBJECT_STORAGE_ENDPOINT", "endpoint"],
    ["OBJECT_STORAGE_REGION", "region"],
    ["OBJECT_STORAGE_BUCKET", "bucket"],
    ["OBJECT_STORAGE_ACCESS_KEY_ID", "access_key_id"],
    ["OBJECT_STORAGE_SECRET_ACCESS_KEY", "secret_access_key"],
    ["OBJECT_STORAGE_SESSION_TOKEN", "session_token"],
  ];
  for (const [envKey, leaf] of objectStoreBindings) {
    if (env[envKey]) setDeep(seeds, ["storage", "object_store", leaf], env[envKey]);
  }
  const pathStyle = env.OBJECT_STORAGE_PATH_STYLE ?? env.OBJECT_STORAGE_FORCE_PATH_STYLE;
  if (
    env.OBJECT_STORAGE_PATH_STYLE !== undefined &&
    env.OBJECT_STORAGE_FORCE_PATH_STYLE !== undefined &&
    env.OBJECT_STORAGE_PATH_STYLE !== env.OBJECT_STORAGE_FORCE_PATH_STYLE
  ) {
    throw new ConfigLoaderError(
      "OBJECT_STORAGE_PATH_STYLE and OBJECT_STORAGE_FORCE_PATH_STYLE disagree",
    );
  }
  if (pathStyle !== undefined) {
    const raw = pathStyle.toLowerCase();
    if (!["true", "false", "1", "0"].includes(raw)) {
      throw new ConfigLoaderError(
        `OBJECT_STORAGE_PATH_STYLE must be true/false/1/0; got "${pathStyle}"`,
      );
    }
    setDeep(seeds, ["storage", "object_store", "force_path_style"], raw === "true" || raw === "1");
  }
  return seeds;
}

export function _defaultConfigPathForTests(env: Record<string, string | undefined>): string {
  return defaultConfigPath(env);
}

function defaultConfigPath(env: Record<string, string | undefined>): string {
  const envOverride = env.SUBKIT_CONFIG;
  if (envOverride) return path.resolve(envOverride);
  const cfgDir = env.CONFIGURATION_DIRECTORY;
  if (cfgDir) return path.resolve(cfgDir, "subkit.config.json");
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

  try {
    const dirHandle = await fs.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {}

  await fs.rename(tmp, configPath);
}

function buildSourceMap(raw: Record<string, unknown>): SourceMap {
  const map: SourceMap = {};
  for (const leaf of listConfigLeaves()) {
    const dotted = dottedPath(leaf);
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
    if (value === null) continue;
    out[key] = deepMergeReplaceArrays(out[key], value);
  }
  return out as T;
}

function applyTenantOverlay(global: Config, tenantId: string): Config {
  const overlay = global.tenants?.[tenantId];
  if (!overlay) return global;
  const merged = deepMergeReplaceArrays(global, overlay) as Config;
  const provider = merged.llm.provider;
  const target = getDeep(merged, ["llm", "providers", provider]);
  if (!target || typeof target !== "object") return merged;
  const fields: Record<string, unknown> = {};
  const boundProvider = getDeep(overlay, ["llm", "provider"]);
  for (const field of ["api_key", "model"]) {
    const generic = getDeep(overlay, ["llm", field]);
    const specific = getDeep(overlay, ["llm", "providers", provider, field]);
    if (generic !== undefined && specific === undefined && field in target) {
      if (boundProvider === provider || generic === "") fields[field] = generic;
      else if (field === "api_key") fields[field] = "";
    }
  }
  const resolved = deepMergeReplaceArrays(merged, { llm: { providers: { [provider]: fields } } });
  for (const field of ["api_key", "model"]) {
    const effective = getDeep(resolved, ["llm", "providers", provider, field]);
    if (typeof effective === "string")
      setDeep(resolved as unknown as Record<string, unknown>, ["llm", field], effective);
  }
  return resolved;
}

function serialize(config: Config): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function mirrorGenericLlmKey(
  cfg: Config,
  opts: { overwriteApiKey?: boolean; overwriteModel?: boolean } = {},
): void {
  const provider = cfg.llm.provider;
  const providers = cfg.llm.providers as Record<
    string,
    { api_key?: string; model?: string } | undefined
  >;
  const target = providers[provider];
  if (!target || typeof target !== "object") return;
  if ("api_key" in target) {
    if (opts.overwriteApiKey) {
      target.api_key = cfg.llm.api_key;
    } else if (cfg.llm.api_key && !target.api_key) {
      target.api_key = cfg.llm.api_key;
    }
  }
  if ("model" in target) {
    if (opts.overwriteModel) {
      target.model = cfg.llm.model;
    } else if (cfg.llm.model && !target.model) {
      target.model = cfg.llm.model;
    }
  }
}

export async function loadConfig(
  opts: { env?: Record<string, string | undefined>; configPathOverride?: string } = {},
): Promise<Config> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const statelessRuntime = env.NODE_ENV === "production" && opts.configPathOverride === undefined;
  const configPath = statelessRuntime
    ? "<postgresql-runtime-config>"
    : (opts.configPathOverride ?? defaultConfigPath(env));

  const fileRaw = statelessRuntime ? {} : await readConfigFile(configPath);
  const fileObj =
    typeof fileRaw === "object" && fileRaw !== null ? (fileRaw as Record<string, unknown>) : {};

  const seeds = collectBootstrapEnvSeeds(env);

  const mergedObj = deepMergeReplaceArrays(
    deepMergeReplaceArrays({} as Record<string, unknown>, seeds),
    fileObj,
  ) as Record<string, unknown>;

  const databaseUrlInConfig = (mergedObj.database as Record<string, unknown> | undefined)?.url;
  const databaseUrlInEnv = env.DATABASE_URL;
  if ((databaseUrlInConfig === undefined || databaseUrlInConfig === "") && databaseUrlInEnv) {
    mergedObj.database = {
      ...((mergedObj.database as object) ?? {}),
      url: databaseUrlInEnv,
    };
  } else if (
    typeof databaseUrlInConfig === "string" &&
    databaseUrlInConfig !== "" &&
    databaseUrlInEnv &&
    databaseUrlInEnv !== databaseUrlInConfig
  ) {
    const { logger } = await import("../logging/logger.ts");
    logger.warn({
      module: "config",
      msg: "DATABASE_URL env differs from database.url in config; config wins",
    });
  }

  const retired = inspectRetiredMcpSections(mergedObj);
  if (retired.offenders.length > 0) {
    throw new ConfigLoaderError(retiredSectionMessage(configPath, retired.offenders));
  }
  if (retired.dropped.length > 0) {
    const { logger } = await import("../logging/logger.ts");
    logger.warn({
      module: "config",
      action: "retired_mcp_section.dropped",
      msg: "retired MCP config section held nothing and was dropped — remove it from the file",
      paths: retired.dropped,
      config_path: configPath,
    });
  }

  let parsed: Config;
  try {
    parsed = parseConfigDocument(mergedObj);
  } catch (err) {
    if (err instanceof Error && "issues" in err) {
      const issues = (err as z.ZodError).issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new ConfigLoaderError(
        `subkit.config.json validation failed at ${configPath}:\n${issues}\n\nSet missing values via the Cockpit, settings HTTP/MCP API, or \`sk settings configure\`.`,
      );
    }
    throw err;
  }

  mirrorGenericLlmKey(parsed);

  let needsPersist = false;
  let generatedSessionSecret = false;
  if (!parsed.auth.session.secret) {
    parsed.auth.session.secret = randomBytes(32).toString("hex");
    needsPersist = true;
    generatedSessionSecret = true;
  }

  if (needsPersist && !statelessRuntime) {
    await atomicWrite(configPath, serialize(parsed));
    const { logger } = await import("../logging/logger.ts");
    if (generatedSessionSecret) {
      logger.info({
        module: "config",
        msg: "auth.session.secret was empty; generated a new value and persisted",
      });
    }
  }

  try {
    const { logger } = await import("../logging/logger.ts");
    const sourceMap = buildSourceMap(mergedObj);
    const tally = { override: 0, global: 0, default: 0 };
    for (const src of Object.values(sourceMap)) {
      if (src === "override") tally.override += 1;
      else if (src === "global") tally.global += 1;
      else if (src === "default") tally.default += 1;
    }
    logger.info({
      module: "config",
      action: "loaded",
      msg: statelessRuntime
        ? "bootstrap seed resolved; PostgreSQL runtime configuration will become authoritative"
        : "config resolved",
      config_path: configPath,
      stateless_runtime: statelessRuntime,
      tenant_overlay_count: Object.keys(parsed.tenants ?? {}).length,
      ...tally,
    });
  } catch {}

  _state = {
    config: parsed,
    configPath,
    statelessRuntime,
    pendingRestartKeys: new Set(),
    overrideKeys: new Set(),
    globalSourceMap: buildSourceMap(mergedObj),
  };

  return parsed;
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(obj);
}

const _bootConsumers = new Set<string>();
let _bootCompleteEmitted = false;

export function recordBootConsumer(name: string): void {
  if (_bootCompleteEmitted) return;
  _bootConsumers.add(name);
}

export async function emitBootComplete(): Promise<void> {
  if (_bootCompleteEmitted) return;
  _bootCompleteEmitted = true;
  try {
    const { logger } = await import("../logging/logger.ts");
    logger.info({
      module: "config",
      action: "boot.complete",
      msg: "config consumers wired",
      consumers: [..._bootConsumers].sort(),
      consumer_count: _bootConsumers.size,
    });
  } catch {}
}

export function _resetBootConsumersForTests(): void {
  _bootConsumers.clear();
  _bootCompleteEmitted = false;
}

let _readCounter: Map<string, number> | null = null;
let _readSamplingEnabled = false;

export function _enableReadSamplingForTests(): Map<string, number> {
  _readCounter = new Map();
  _readSamplingEnabled = true;
  return _readCounter;
}

export function _disableReadSamplingForTests(): void {
  _readCounter = null;
  _readSamplingEnabled = false;
}

export function isConfigLoaded(): boolean {
  return _state !== null;
}

export function getConfig(tenantId?: string): Config {
  if (_state === null) {
    throw new ConfigLoaderError("getConfig() called before loadConfig()");
  }
  if (_readSamplingEnabled && _readCounter) {
    const key = tenantId ? `tenant:${tenantId}` : "global";
    _readCounter.set(key, (_readCounter.get(key) ?? 0) + 1);
  }
  if (!tenantId) return deepFreeze(_state.config);
  return deepFreeze(applyTenantOverlay(_state.config, tenantId));
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

export function installRuntimeConfig(document: unknown): Config {
  if (_state === null) {
    throw new ConfigLoaderError("installRuntimeConfig() called before loadConfig()");
  }
  const parsed = parseConfigDocument(document);
  mirrorGenericLlmKey(parsed);
  _state.config = parsed;
  _state.globalSourceMap = buildSourceMap(parsed as unknown as Record<string, unknown>);
  _state.pendingRestartKeys.clear();
  return parsed;
}

export async function emitRequiresRestartPendingIfAny(): Promise<void> {
  if (_state === null) return;
  if (_state.pendingRestartKeys.size === 0) return;
  try {
    const { logger } = await import("../logging/logger.ts");
    logger.warn({
      module: "config",
      action: "requires_restart_pending",
      msg: "config writes pending restart — engine has not picked up the new value yet",
      pending_restart_keys: [..._state.pendingRestartKeys].sort(),
      pending_count: _state.pendingRestartKeys.size,
    });
  } catch {}
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
  reconfigureFailed?: boolean;
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
      `${leafPath.join(".")} requires a restart in production. Re-run with the --force flag ` +
        `(sk settings set … --force) to apply it now; the write takes effect in this process ` +
        `immediately, and "restart" only matters for other running instances.`,
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

      if (
        leafPath.length === 2 &&
        leafPath[0] === "llm" &&
        leafPath[1] === "provider" &&
        beforeValue !== validatedValue
      ) {
        setDeep(newOverlay, ["llm", "api_key"], "");
      }
      if (
        leafPath.length === 2 &&
        leafPath[0] === "llm" &&
        (leafPath[1] === "api_key" || leafPath[1] === "model")
      ) {
        const provider = applyTenantOverlay(updatedConfig, opts.tenantId).llm.provider;
        const targetLeaf = leafPath[1];
        setDeep(newOverlay, ["llm", "providers", provider, targetLeaf], validatedValue);
      }
    } else {
      const next = JSON.parse(JSON.stringify(state.config)) as Config;
      beforeValue = getDeep(next as unknown as Record<string, unknown>, leafPath);
      setDeep(next as unknown as Record<string, unknown>, leafPath, validatedValue);
      updatedConfig = next;
    }

    if (
      !opts.tenantId &&
      leafPath.length === 2 &&
      leafPath[0] === "llm" &&
      leafPath[1] === "provider" &&
      beforeValue !== validatedValue
    ) {
      setDeep(updatedConfig as unknown as Record<string, unknown>, ["llm", "api_key"], "");
    }

    const fullParse = safeParseConfigDocument(updatedConfig);
    if (!fullParse.success) {
      const issue = fullParse.error.issues[0];
      throw new ValidationError(
        issue?.message ?? "validation_failed",
        issue?.path as string[],
        leaf.kind,
      );
    }

    mirrorGenericLlmKey(fullParse.data, {
      overwriteApiKey:
        !opts.tenantId &&
        leafPath.length === 2 &&
        leafPath[0] === "llm" &&
        leafPath[1] === "api_key",
      overwriteModel:
        !opts.tenantId && leafPath.length === 2 && leafPath[0] === "llm" && leafPath[1] === "model",
    });

    if (!state.statelessRuntime) {
      await atomicWrite(state.configPath, serialize(fullParse.data));
    }

    state.config = fullParse.data;
    if (!opts.tenantId) state.globalSourceMap[dottedPath(leaf)] = "global";
    if (requiresRestart) state.pendingRestartKeys.add(dottedPath(leaf));

    try {
      const { logger } = await import("../logging/logger.ts");
      logger.info({
        module: "config",
        action: "setting.applied",
        msg: "config leaf applied",
        leaf: dottedPath(leaf),
        scope: opts.tenantId ? `tenant:${opts.tenantId}` : "global",
        sensitive: !!leaf.meta.secret,
        requires_restart: requiresRestart,
        changed: JSON.stringify(beforeValue) !== JSON.stringify(validatedValue),
      });
    } catch {}

    if (leaf.path[0] === "log") {
      try {
        const { reconfigureLogger } = await import("../logging/logger.ts");
        reconfigureLogger({
          level: fullParse.data.log.level,
          format: fullParse.data.log.format,
        });
      } catch {}
    }

    let reconfigureFailed = false;
    if (leaf.path[0] === "observability") {
      try {
        const { reconfigureObservability } = await import("../logging/logger.ts");
        reconfigureObservability({
          field_truncation_chars: fullParse.data.observability.field_truncation_chars,
          service_name: fullParse.data.observability.otlp.service_name,
          deployment_environment: fullParse.data.observability.deployment_environment,
        });
      } catch {}
      try {
        const { reconfigureTracing } = await import("../observability/tracing.ts");
        await reconfigureTracing();
      } catch (err) {
        reconfigureFailed = true;
        const { logger } = await import("../logging/logger.ts");
        logger.warn({
          module: "config",
          action: "observability.reconfigure_failed",
          msg: "tracing reconfigure failed after settings.changed",
          leaf: dottedPath(leaf),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const langfuseModule = await import("../observability/langfuse-spans.ts");
        try {
          langfuseModule.resetLangfuseCacheForReload();
        } catch (err) {
          reconfigureFailed = true;
          const { logger } = await import("../logging/logger.ts");
          logger.warn({
            module: "config",
            action: "observability.langfuse_reset_failed",
            msg: "langfuse cache reset failed after settings.changed",
            leaf: dottedPath(leaf),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch {}
    }

    return {
      before: beforeValue,
      after: validatedValue,
      requiresRestart: requiresRestart || reconfigureFailed,
      scope: opts.tenantId ? `tenant:${opts.tenantId}` : "global",
      leafPath: dottedPath(leaf),
      reconfigureFailed,
    };
  });
}

export function _resetConfigForTests(): void {
  _state = null;
  _writeLock = Promise.resolve();
}
