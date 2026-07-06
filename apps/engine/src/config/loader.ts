import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

// Exported for unit tests that need to assert path resolution without
// triggering the full loadConfig() (which would also try to write the
// auto-generated session secret to disk — fine for tmpdirs, fatal for
// /etc/subkit on a dev workstation).
export function _defaultConfigPathForTests(env: Record<string, string | undefined>): string {
  return defaultConfigPath(env);
}

function defaultConfigPath(env: Record<string, string | undefined>): string {
  const envOverride = env.SUBKIT_CONFIG;
  if (envOverride) return path.resolve(envOverride);
  // Systemd convention: when `ConfigurationDirectory=subkit` is set on
  // the unit, systemd exports `CONFIGURATION_DIRECTORY=/etc/subkit` to
  // the service. Honor that explicit operator signal before falling
  // back to `NODE_ENV=production` heuristics — the unit (or any other
  // launcher) is the source of truth for where canonical config lives,
  // and CWD-relative defaults silently drift when the unit's
  // WorkingDirectory differs from /etc/subkit.
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

// Mirror generic LLM leaves into the active provider leaf that the model
// resolver reads (see llm/core/model-init.ts ENV_TO_CONFIG_PATH).
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
  const configPath = opts.configPathOverride ?? defaultConfigPath(env);

  const fileRaw = await readConfigFile(configPath);
  const fileObj =
    typeof fileRaw === "object" && fileRaw !== null ? (fileRaw as Record<string, unknown>) : {};

  const { overrides, keys: overrideKeys } = collectOverrides(env);

  // Merge the file config with SK_OVERRIDE_* env overlays using
  // REPLACE-array semantics (overrides win). We deliberately do NOT use
  // c12/defu here: defu CONCATENATES arrays, and the previous code also
  // handed c12 the same file twice — once via `configFile` (which c12
  // reads) and again via `defaults: fileObj` — so every load DOUBLED every
  // array-valued leaf. `auth.mcp_oauth.scopes_supported` (the one leaf with
  // a non-empty default array) grew 3 → 3·2ⁿ, was persisted on each deploy's
  // settings write, and reached 3·2²² ≈ 12.6M entries = a 276 MB config that
  // hung boot (config parse + reserialize spun a core and ~3.6 GB heap).
  // `deepMergeReplaceArrays` replaces arrays, matching `applyTenantOverlay`.
  const mergedObj = deepMergeReplaceArrays(
    deepMergeReplaceArrays({} as Record<string, unknown>, fileObj),
    overrides,
  ) as Record<string, unknown>;

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

  // Reconcile the generic LLM key/model into the provider-specific leaves the
  // model resolver reads, so a key set via `sk init` / generic settings works.
  mirrorGenericLlmKey(parsed);

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
      action: "override.active",
      msg: "SK_OVERRIDE_* active",
      override_keys: overrideKeys,
    });
  }

  // Per-leaf source map at boot — one structured info line that
  // summarises which leaves came from override env, which were
  // populated by the file, and which are riding the schema default.
  // Operators reading the boot log can confirm every setting is
  // sourced from the layer they expect.
  try {
    const { logger } = await import("../logging/logger.ts");
    const sourceMap = buildSourceMap(mergedObj, overrides);
    const tally = { override: 0, global: 0, default: 0 };
    for (const src of Object.values(sourceMap)) {
      if (src === "override") tally.override += 1;
      else if (src === "global") tally.global += 1;
      else if (src === "default") tally.default += 1;
    }
    logger.info({
      module: "config",
      action: "loaded",
      msg: "config resolved",
      config_path: configPath,
      tenant_overlay_count: Object.keys(parsed.tenants ?? {}).length,
      ...tally,
    });
  } catch {
    /* logger module not loaded yet */
  }

  // settings_override_active{key} gauge — operator dashboards flip on
  // any leaf where the in-memory value comes from an SK_OVERRIDE_* env
  // var. The label carries the dotted leaf path; the value itself is
  // never exported. Stale labels from a prior loadConfig (e.g. a
  // restart that dropped an override) are zeroed out so dashboards
  // don't carry phantom data.
  try {
    const { getMetrics, METRIC_NAMES } = await import("../observability/metrics.ts");
    const reg = getMetrics();
    if (_state) {
      for (const k of _state.overrideKeys) {
        if (!overrideKeys.includes(k)) {
          reg.set(METRIC_NAMES.SETTINGS_OVERRIDE_ACTIVE, 0, { key: k });
        }
      }
    }
    for (const k of overrideKeys) reg.set(METRIC_NAMES.SETTINGS_OVERRIDE_ACTIVE, 1, { key: k });
  } catch {
    /* metrics module not loaded yet (some boot orderings) */
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

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(obj);
}

// boot.complete summary: every subsystem that reads getConfig() at
// boot can register itself via `recordBootConsumer(<name>)` so the
// loader can emit a single `config.boot.complete` log line listing
// every consumer that wired up successfully. Lets an operator confirm
// from one log line that the loader → consumer chain is fully live.
//
// The set is keyed by subsystem name (string), populated only at boot.
// `recordBootConsumer` is a noop after `_state` is set + the
// `boot.complete` line was emitted (so post-boot getConfig calls don't
// flood the set).
const _bootConsumers = new Set<string>();
let _bootCompleteEmitted = false;

export function recordBootConsumer(name: string): void {
  if (_bootCompleteEmitted) return;
  _bootConsumers.add(name);
}

/**
 * Emit `config.boot.complete` once after every subsystem has wired up
 * (e.g. at the end of `runServer()` in apps/engine/src/index.ts). The
 * line carries the list of subsystems that called
 * `recordBootConsumer()` at boot — operators reading the boot log get
 * a single confirmation that loader → consumer hand-off is wired.
 *
 * Idempotent: subsequent calls are noops. Safe to call from tests.
 */
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
  } catch {
    /* logger module not loaded yet */
  }
}

/** **TEST-ONLY** — clear the boot-consumer registry between test cases. */
export function _resetBootConsumersForTests(): void {
  _bootConsumers.clear();
  _bootCompleteEmitted = false;
}

// Read-sampling is a TEST-ONLY introspection hook. It is *not* a
// production observability path — operator-grade read counting belongs
// in the Prometheus metrics layer (see observability/metrics.ts). The
// `_` prefix and `ForTests` suffix are the project convention for
// "you must not import this from production code"; the gauge in
// metrics.ts is the supported runtime telemetry surface for config
// reads. Calling `_enableReadSamplingForTests` from a non-test caller
// silently grows a Map per `getConfig()` invocation and never frees it.
let _readCounter: Map<string, number> | null = null;
let _readSamplingEnabled = false;

/**
 * **TEST-ONLY** — turn on per-leaf read sampling. Counts every
 * getConfig() invocation by tenant scope so a test can assert that a
 * downstream consumer actually fetched the leaf after setConfigKey.
 * Disabled in production by default (zero overhead until enabled).
 *
 * Production read counters belong in
 * `apps/engine/src/observability/metrics.ts`, not here. Do not call
 * this from outside a `__tests__` directory.
 */
export function _enableReadSamplingForTests(): Map<string, number> {
  _readCounter = new Map();
  _readSamplingEnabled = true;
  return _readCounter;
}

/** **TEST-ONLY** — counterpart to `_enableReadSamplingForTests`; clears
 *  the counter and disables sampling. Call from `afterEach` to keep
 *  test cases isolated. */
export function _disableReadSamplingForTests(): void {
  _readCounter = null;
  _readSamplingEnabled = false;
}

/**
 * True once `loadConfig()` has run. Lets low-level code that may execute
 * before the config subsystem is bootstrapped (e.g. driver functions
 * exercised directly in unit tests) read a setting only when it is
 * actually available, falling back to a documented default otherwise. In
 * production config is always loaded before the HTTP listener accepts
 * traffic, so request-path callers always observe `true`.
 */
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
  // Plan §2: getConfig returns an immutable view. setConfigKey writes
  // a fresh object via JSON.parse(JSON.stringify(...)) and replaces
  // _state.config wholesale, so freeze never blocks legitimate writes.
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

/**
 * Emit one `config.requires_restart_pending` warn per call when one or
 * more leaves are flagged `requiresRestart: true` and have been
 * written since boot. Call from a scheduler tick (e.g. every 5
 * minutes) so an operator who PUT a `requiresRestart: true` leaf and
 * forgot to restart the container surfaces in the boot/operator log
 * stream alongside the rest of their diagnostics. No-op when the set
 * is empty; never logs the value, only the leaf paths.
 */
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
  } catch {
    /* logger module not loaded */
  }
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
  /** True iff the leaf was on a hot-reload path (currently only
   *  `observability.*`) AND the in-process reconfigure threw. The
   *  on-disk + in-memory write succeeded; the live tracer/exporter
   *  is the part that didn't pick up the change. Callers (the
   *  /v1/settings PUT route) must surface this so the operator
   *  doesn't see `requiresRestart: false` while the running
   *  process is still on the old config. */
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

    // Switching the active LLM provider must not mirror the previous
    // provider's generic key into the newly selected provider's empty leaf.
    // Clear the generic key on a real provider change; the prior provider
    // keeps its provider-specific leaf, and the new provider stays unset.
    if (
      !opts.tenantId &&
      leafPath.length === 2 &&
      leafPath[0] === "llm" &&
      leafPath[1] === "provider" &&
      beforeValue !== validatedValue
    ) {
      setDeep(updatedConfig as unknown as Record<string, unknown>, ["llm", "api_key"], "");
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

    // Keep the active provider leaf in sync when the operator edits the
    // generic LLM leaf through settings. Otherwise a stale provider-specific
    // key remains the one used by the SDK even though llm.api_key changed.
    mirrorGenericLlmKey(fullParse.data, {
      overwriteApiKey:
        !opts.tenantId &&
        leafPath.length === 2 &&
        leafPath[0] === "llm" &&
        leafPath[1] === "api_key",
      overwriteModel:
        !opts.tenantId && leafPath.length === 2 && leafPath[0] === "llm" && leafPath[1] === "model",
    });

    await atomicWrite(state.configPath, serialize(fullParse.data));

    state.config = fullParse.data;
    if (!opts.tenantId) state.globalSourceMap[dottedPath(leaf)] = "global";
    if (requiresRestart) state.pendingRestartKeys.add(dottedPath(leaf));

    // Structured runtime log — one line per applied setting so an
    // operator tailing the engine log can correlate every change with
    // the responsible request. The log NEVER carries the value itself
    // (sensitive leaves render as "***" via the route's mask layer
    // upstream of this function); it carries only the leaf path,
    // scope, restart flag, and whether the on-disk file was actually
    // rewritten with a new value (vs. a no-op write).
    //
    // Emitted BEFORE the optional logger reconfigure below so that a
    // log.level / log.format change cannot retroactively suppress or
    // reformat the applied-line documenting the change itself: an
    // operator who sets log.level=error must still see the
    // setting.applied entry that flipped the threshold.
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
    } catch {
      /* logger module not loaded; never fail a write because of telemetry */
    }

    // Hot-reload the logger when a log.* leaf changes — operators set
    // `sk settings set log.level "debug"` expecting the next request
    // to log at the new level, not "after restart". The reconfigure
    // call swaps the in-memory MODE/THRESHOLD atomically. Runs AFTER
    // the setting.applied log above so the change-document line is
    // not suppressed by the threshold it just installed.
    if (leaf.path[0] === "log") {
      try {
        const { reconfigureLogger } = await import("../logging/logger.ts");
        reconfigureLogger({
          level: fullParse.data.log.level,
          format: fullParse.data.log.format,
        });
      } catch {
        /* logger module not loaded */
      }
    }

    // Hot-reload OTel + langfuse exporters when an observability.*
    // leaf changes. Without this, flipping
    // `observability.langfuse.secret_key` (etc.) wrote the value to
    // disk but the running tracer kept the old credentials in memory
    // until the next process restart — which contradicted the
    // `requiresRestart: false` flag this section now carries. The
    // tracing reconfigure shuts down the SDK and re-bootstraps from
    // the updated config; the langfuse-spans cache is reset so the
    // next `getLangfuse()` reads the new config too. Both calls are
    // best-effort — never fail a settings write because the tracer
    // couldn't restart cleanly.
    //
    // Dynamic imports here — observability/tracing.ts lazy-imports the
    // OTel SDK packages (~10 MB of code), and the matching log/logger
    // hot-reload above is dynamic for the same reason. Top-of-file
    // imports would pull the entire OTel surface into every process
    // that touches config (CLI, tests, smoke binary) for no benefit.
    let reconfigureFailed = false;
    if (leaf.path[0] === "observability") {
      // Hot-reload the per-field log cap when observability.* changes —
      // operators set `sk settings set observability.field_truncation_chars`
      // expecting the next log line to honor it without a restart.
      try {
        const { reconfigureObservability } = await import("../logging/logger.ts");
        reconfigureObservability({
          field_truncation_chars: fullParse.data.observability.field_truncation_chars,
        });
      } catch {
        /* logger module not loaded */
      }
      // The reconfigure runs INSIDE withWriteLock on purpose: a second
      // setConfigKey arriving mid-reconfigure would otherwise see the
      // new in-memory config but the old running tracer, and could
      // race with our shutdown→re-init sequence (the OTel SDK is not
      // safe to start while a previous shutdown is in flight).
      //
      // Tail-latency bound: reconfigureTracing wraps its
      // SDK shutdown in `awaitWithTimeout` with a 5 s ceiling
      // (`RECONFIGURE_SHUTDOWN_TIMEOUT_MS` in
      // observability/tracing.ts). Even a hung exporter can't pin the
      // lock past that — the SDK's retry stays in the background and
      // we proceed to startTracing(). Worst-case unrelated
      // setConfigKey() waits ≤ 5 s during heavy observability churn.
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
      // Two failure modes here, only one of which is benign:
      //   (a) dynamic import throws because langfuse-spans is not on
      //       this binary's import graph (smoke-mode boot, CLI entry
      //       points that never serve requests). Benign — no client
      //       to reset.
      //   (b) resetLangfuseCacheForReload itself throws (a future
      //       refactor that returns undefined or works against a
      //       stale handle). NOT benign — the live tracer is
      //       half-reloaded and an operator who flipped
      //       observability.langfuse.secret_key would see spans go
      //       to the old project. We promote this case to
      //       reconfigureFailed so the audit row + route response
      //       reflect the half-reload.
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
      } catch {
        /* langfuse-spans module not loaded — benign */
      }
    }

    return {
      before: beforeValue,
      after: validatedValue,
      // The on-disk + in-memory write succeeded. Only the live tracer
      // didn't pick it up — operator must restart for the new config
      // to take effect, so requiresRestart promotes to true.
      requiresRestart: requiresRestart || reconfigureFailed,
      scope: opts.tenantId ? `tenant:${opts.tenantId}` : "global",
      leafPath: dottedPath(leaf),
      reconfigureFailed,
    };
  });
}

/**
 * **TEST-ONLY** — reset module state between cases. Production code
 * never resets the loader; loadConfig() runs exactly once at boot. Use
 * this in `beforeEach` to isolate test cases that mutate config.
 */
export function _resetConfigForTests(): void {
  _state = null;
  _writeLock = Promise.resolve();
}
