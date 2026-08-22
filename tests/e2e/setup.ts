// E2E test harness for the sk CLI binary.
//
// Boots a real engine (Hono + pg-boss) against a disposable Postgres
// database, seeds three personas (admin, member, enduser), and provides
// a `cli()` helper that invokes the compiled sk binary as a subprocess
// with per-persona config directories.
//
// HOW TO RUN THESE TESTS
//
//   bun run test:e2e          # the ONLY supported command
//
// It builds `sk` and then runs `scripts/test-e2e-isolated.ts`, which
// spawns ONE `bun test` process PER FILE. CI runs that same script.
//
//   bun test tests/e2e/       # NOT supported — do not use
//
// That form loads every e2e file into a SINGLE process. Each suite boots
// a real engine and mutates process-global state (config leaves, env
// vars, the LLM provider, pg-boss workers, listening servers); the
// harness gives back what it can, but suites still contend for one
// process, and roughly half of those runs fail on interference that has
// nothing to do with the code under test. To run a single file, name it:
// `bun test tests/e2e/<file>.e2e.test.ts` — one file is one process, so
// that is fine.
//
// Usage:
//   import { boot, shutdown, cli, Persona } from "./setup.ts";
//
//   let env: Awaited<ReturnType<typeof boot>>;
//   beforeAll(async () => { env = await boot("my-suite"); }, 60_000);
//   afterAll(() => shutdown(env));
//
// Best practices applied:
//   - Full isolation: disposable Postgres DB per suite, temp config dirs
//   - No shared mutable state between tests (personas are read-only)
//   - Subprocess CLI invocation (tests the compiled binary, not imports)
//   - Deterministic teardown: server, boss, DB, temp dirs all cleaned up
//   - Extensible: add a persona by pushing to PERSONA_DEFS

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import type { PgBoss } from "pg-boss";
import {
  getConfig as getEngineConfig,
  loadConfig as loadEngineConfig,
  setConfigKey,
} from "../../apps/engine/src/config/loader.ts";
import { setChromiumProviderForTesting } from "../../apps/engine/src/connectors/discovery/index.ts";
import type { Db } from "../../apps/engine/src/db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../apps/engine/src/db/schema/index.ts";
import { createTestDb, type TestDb } from "../../apps/engine/src/db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../../apps/engine/src/http/server.ts";
import { createBoss, disposeBoss } from "../../apps/engine/src/queue/boss.ts";
import { registerAllHandlers } from "../../apps/engine/src/queue/handlers/index.ts";
import {
  backfillRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../../apps/engine/src/rbac/seed.ts";

// v3.5: route handlers and conversation services read getConfig() at
// request time, which throws if loadConfig() never ran. The e2e
// harness boots a real Hono app via createApp(), so we must
// bootstrap the loader before any route can be hit. Idempotent
// across suites.
async function ensureEngineConfigLoaded(): Promise<void> {
  try {
    getEngineConfig();
    return;
  } catch {
    // not yet loaded — fall through.
  }
  const dir = mkdtempSync(path.join(tmpdir(), "sk-cfg-e2e-"));
  await loadEngineConfig({
    env: { DATABASE_URL: "postgres://placeholder/e2e", NODE_ENV: "test" },
    configPathOverride: path.join(dir, "subkit.config.json"),
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PersonaName = "admin" | "member" | "enduser";

export interface Persona {
  name: PersonaName;
  apiKey: string;
  userId: string;
  systemAccountId: string;
  tenantId: string;
  /** Temp dir used as $HOME for this persona's CLI config. */
  homeDir: string;
}

export interface E2EEnv {
  baseUrl: string;
  tenantId: string;
  tenantSlug: string;
  personas: Record<PersonaName, Persona>;
  rbacRoleIds: SeededRoleIds;
  db: Db;
  boss: PgBoss;
  testDb: TestDb;
  cleanup: () => Promise<void>;
}

/** Two tracks: real (default, gateway or direct provider) or mock. */
export interface BootOpts {
  /** Pin the in-process mock LLM. Default: real provider from .env. */
  llm?: "mock";
  /**
   * Let connector discovery launch a real Chromium and navigate to the
   * live target. The mock track disables it by default (see
   * `disableBrowserDiscovery`); set this when the browser crawl is the
   * behaviour under test.
   */
  browser_discovery?: true;
}

/**
 * Make the mock track hermetic by declaring playwright unloadable.
 *
 * `llm: "mock"` reads as a promise that the suite reaches nothing, but
 * the `playwright-crawl` discovery strategy is the tail of the strategy
 * chain and claims any URL — so any mock suite that discovered a
 * connector launched Chromium and navigated to the live target, at
 * roughly four seconds a call. A provider that rejects makes `canHandle`
 * resolve false, so the dispatcher records a clean `strategy_skipped` —
 * the same path a host without playwright installed already takes —
 * instead of launching a browser and fetching a third party.
 * Authority: `tests/e2e/harness-isolation.e2e.test.ts`.
 */
function disableBrowserDiscovery(): void {
  setChromiumProviderForTesting(() =>
    Promise.reject(new Error("browser discovery is disabled on the hermetic e2e mock track")),
  );
}

async function withTeardownTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      // allow-wall-clock: e2e teardown must bound leaked sockets and DB handles.
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bestEffortTeardown(
  label: string,
  action: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTeardownTimeout(label, action(), timeoutMs);
  } catch {
    /* cleanup must not mask the suite result; orphan DB sweep handles leftovers */
  }
}

/** Minimal shape of the sockets we have to be able to destroy. */
interface TrackedSocket {
  destroy: () => void;
  on: (event: "close", listener: () => void) => void;
}

/**
 * Remember every accepted connection so teardown can destroy it.
 *
 * `Server.close()` stops accepting and calls back only once every open
 * connection has ended, and `closeAllConnections()` does not end a
 * connection whose response is still streaming — so a suite that leaves an
 * SSE stream open (`sk --p`, `/v1/events`) burned the whole teardown budget
 * and left a live server registered for the rest of the test process.
 * Authority for both halves of that claim:
 * `tests/e2e/harness-isolation.e2e.test.ts`.
 */
export function trackConnections(server: ServerType): Set<TrackedSocket> {
  const sockets = new Set<TrackedSocket>();
  (server as unknown as { on: (e: "connection", l: (s: TrackedSocket) => void) => void }).on(
    "connection",
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    },
  );
  return sockets;
}

export async function closeHttpServer(
  server: ServerType,
  sockets: Set<TrackedSocket>,
): Promise<void> {
  const s = server as unknown as {
    close: (cb: (err?: Error) => void) => void;
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  await bestEffortTeardown(
    "http server close",
    async () => {
      await new Promise<void>((resolve, reject) => {
        try {
          s.close((err?: Error) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
          s.closeIdleConnections?.();
          s.closeAllConnections?.();
          for (const socket of [...sockets]) {
            try {
              socket.destroy();
            } catch {
              /* already gone */
            }
          }
        } catch (err) {
          reject(err);
        }
      });
    },
    5_000,
  );
  try {
    s.closeAllConnections?.();
  } catch {
    /* ignore */
  }
}

/**
 * Real-LLM detection. Mirrors the precedence in
 * `apps/engine/src/llm/core/model-init.ts`: gateway first when both
 * gateway vars are present, otherwise direct provider via LLM_PROVIDER.
 */
function detectRealProvider(): { provider: string; reason: string } {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === "mock") {
    return { provider: "mock", reason: "LLM_PROVIDER=mock" };
  }
  if (process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_MODEL) {
    return { provider: "gateway", reason: "AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL set" };
  }
  if (
    explicit === "anthropic" ||
    explicit === "openai" ||
    explicit === "gemini" ||
    explicit === "azure" ||
    explicit === "bedrock" ||
    explicit === "vertex"
  ) {
    return { provider: explicit, reason: `LLM_PROVIDER=${explicit}` };
  }
  throw new Error(
    "E2E boot() needs either LLM_PROVIDER=mock, AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL, " +
      "or LLM_PROVIDER set to anthropic/openai/gemini/azure/bedrock/vertex with the matching credentials.",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SK_BIN = path.join(REPO_ROOT, "dist/sk");

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------

interface PersonaDef {
  name: PersonaName;
  email: string;
  role: string;
  roleKey: keyof SeededRoleIds;
  sysAccountName: string;
}

const PERSONA_DEFS: PersonaDef[] = [
  {
    name: "admin",
    email: "admin@e2e.local",
    role: "admin",
    roleKey: "admin",
    sysAccountName: "e2e-admin-bot",
  },
  {
    name: "member",
    email: "member@e2e.local",
    role: "member",
    roleKey: "member",
    sysAccountName: "e2e-member-bot",
  },
  {
    name: "enduser",
    email: "enduser@e2e.local",
    role: "enduser",
    roleKey: "enduser",
    sysAccountName: "e2e-enduser-bot",
  },
];

// ---------------------------------------------------------------------------
// Boot / Shutdown
// ---------------------------------------------------------------------------

export async function boot(label: string, opts: BootOpts = {}): Promise<E2EEnv> {
  await ensureEngineConfigLoaded();
  if (opts.llm === "mock") {
    process.env.LLM_PROVIDER = "mock";
    await setConfigKey("llm.provider", "mock", { force: true });
    const { resetMockProvider } = await import("../../apps/engine/src/llm/mock-provider.ts");
    resetMockProvider();
  } else {
    const detected = detectRealProvider();
    // The engine resolves LLM_PROVIDER config-first (model-init readEnv)
    // and the schema DEFAULTS `llm.provider` to "mock" — a non-empty leaf
    // that shadows process.env. Without this write the "real LLM" track
    // silently ran the mock provider (root cause of the nightly real-llm
    // tier failing every night since 2026-05-05: 127ms "turns", no
    // provider call). Gateway needs no write — its config leaves default
    // empty (env fallback applies) and gateway resolution precedes the
    // provider leaf.
    if (detected.provider !== "gateway") {
      await setConfigKey("llm.provider", detected.provider, { force: true });
    }
  }

  const hermeticBrowser = opts.llm === "mock" && !opts.browser_discovery;
  if (hermeticBrowser) disableBrowserDiscovery();

  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const testDb = await createTestDb(`e2e-${safeLabel}`);
  const rbacRoleIds = await seedBuiltinRolesAndPermissions(testDb.db);

  // Tenant shared by all personas.
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `e2e-${safeLabel}`.slice(0, 32), display_name: `E2E ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  await backfillRoleIds(testDb.db, rbacRoleIds);

  // Seed each persona.
  const personas = {} as Record<PersonaName, Persona>;
  for (const def of PERSONA_DEFS) {
    const homeDir = mkdtempSync(path.join(tmpdir(), `sk-e2e-${def.name}-`));

    const [user] = await testDb.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: def.email,
        role: def.role,
        role_id: rbacRoleIds[def.roleKey],
      })
      .returning();
    if (!user) throw new Error(`seed user ${def.name} failed`);

    const [sysAcct] = await testDb.db
      .insert(systemAccounts)
      .values({
        tenant_id: tenant.id,
        name: def.sysAccountName,
        description: `E2E ${def.name} bot`,
        role_id: rbacRoleIds[def.roleKey],
      })
      .returning();
    if (!sysAcct) throw new Error(`seed system_account ${def.name} failed`);

    const key = generateApiKey();
    await testDb.db.insert(apiKeys).values({
      tenant_id: tenant.id,
      user_id: user.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["*"],
    });

    personas[def.name] = {
      name: def.name,
      apiKey: key.plaintext,
      userId: user.id,
      systemAccountId: sysAcct.id,
      tenantId: tenant.id,
      homeDir,
    };
  }

  // pg-boss.
  // Every suite owns its queue runtime. Using the module-scoped startBoss()
  // singleton routes jobs from later suites into the first suite's disposable
  // database, including when a developer runs selected files concurrently.
  const boss = await createBoss({ connectionString: testDb.url });
  await registerAllHandlers({ boss, db: testDb.db });

  // HTTP server on random port.
  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({ db: testDb.db, registry, boss });
  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const sockets = trackConnections(server);
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") throw new Error("failed to get server port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  // Both mutations are PROCESS-GLOBAL and `bun test` runs every file in
  // one process: a suite that runs after an e2e boot would otherwise
  // inherit this suite's public origin (e.g. `buildReauthUrl`'s
  // no-public-origin branch became unreachable and its test failed
  // full-suite-only). Capture the prior values and restore in cleanup.
  const priorPublicBaseUrlEnv = process.env.SUBKIT_PUBLIC_BASE_URL;
  process.env.SUBKIT_PUBLIC_BASE_URL = baseUrl;
  // v3.5: routes/services read public_base_url via getConfig().
  // Capture the leaf's pre-boot value, not a constant: restoring a
  // process-global to a guessed default is a leak of its own, and any
  // suite in the same process that had configured an origin would find it
  // silently blanked. Authority: `tests/e2e/harness-isolation.e2e.test.ts`.
  const priorPublicBaseUrlConfig = getEngineConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", baseUrl, { force: true });

  return {
    baseUrl,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    personas,
    rbacRoleIds,
    db: testDb.db,
    boss,
    testDb,
    cleanup: async () => {
      // 0. Undo the process-global public-origin mutations so suites
      // that run after this one see the pre-boot state.
      if (priorPublicBaseUrlEnv === undefined) delete process.env.SUBKIT_PUBLIC_BASE_URL;
      else process.env.SUBKIT_PUBLIC_BASE_URL = priorPublicBaseUrlEnv;
      // Same reasoning for the chromium provider, which is process-global
      // too. `null` is the production default, and no e2e suite installs a
      // provider of its own — the discovery unit tests that do never share
      // a process with this harness.
      if (hermeticBrowser) setChromiumProviderForTesting(null);
      await bestEffortTeardown(
        "public_base_url config restore",
        () => setConfigKey("server.public_base_url", priorPublicBaseUrlConfig, { force: true }),
        3_000,
      );
      // 1. Close HTTP server, destroying its live connections.
      await closeHttpServer(server, sockets);
      // 2. Stop this suite's pg-boss and close all its Postgres connections.
      await bestEffortTeardown("suite pg-boss dispose", () => disposeBoss(boss), 8_000);
      // 3. Give pg-boss connections time to fully close before dropping DB.
      // allow-wall-clock: socket teardown requires real I/O time.
      await new Promise((r) => setTimeout(r, 200));
      // 4. Drop the test database.
      await bestEffortTeardown("test database cleanup", testDb.cleanup, 10_000);
      // 5. Clean up temp directories.
      for (const p of Object.values(personas)) {
        try {
          rmSync(p.homeDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// Tolerate an undefined env: when boot() throws in beforeAll the suite's
// afterAll still runs with the variable unassigned — crashing here buried
// the REAL boot error under a TypeError in the CI log.
export const shutdown = (env: E2EEnv | undefined) => env?.cleanup() ?? Promise.resolve();

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the harness killed the CLI at the test timeout — the
   *  non-zero exit is a hang, not a CLI-reported failure. */
  timed_out: boolean;
}

/**
 * Invoke the sk CLI binary as a subprocess.
 *
 * @param args   - CLI arguments (e.g. ["health", "--json"])
 * @param opts   - persona for auth + optional env overrides
 */
export async function cli(
  args: string[],
  opts: {
    env: E2EEnv;
    persona?: PersonaName;
    extraEnv?: Record<string, string>;
    timeout?: number;
  },
): Promise<CliResult> {
  const persona = opts.persona ? opts.env.personas[opts.persona] : opts.env.personas.admin;

  const proc = Bun.spawn([SK_BIN, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Point CLI at the test engine.
      SUBKIT_ENGINE_URL: opts.env.baseUrl,
      SUBKIT_API_KEY: persona.apiKey,
      SUBKIT_TENANT: persona.tenantId,
      // Override config paths so we don't pollute real config.
      HOME: persona.homeDir,
      XDG_CONFIG_HOME: persona.homeDir,
      // Force non-interactive.
      CI: "1",
      NO_COLOR: "1",
      // The update check hits api.github.com; the fetch has no timeout
      // and keeps the CLI process alive past the test's 5s budget in
      // sandboxed CI. Disable it for every e2e CLI invocation.
      NO_UPDATE_CHECK: "1",
      // Propagate determinism knobs to the subprocess so parent and
      // child share the same seeded RNG / clock source. Parent tests
      // can pin these via extraEnv; otherwise we default to seed=1 for
      // reproducible e2e runs.
      SUBKIT_DETERMINISTIC_SEED: process.env.SUBKIT_DETERMINISTIC_SEED ?? "1",
      ...opts.extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = opts.timeout ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, exitCode, timed_out: timedOut };
}

/** Write content to a temp file and return the path. Uses the persona's homeDir. */
export function writeTempFile(persona: Persona, filename: string, content: string): string {
  const filePath = path.join(persona.homeDir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Parse JSON from CLI stdout, stripping any leading non-JSON lines. */
export function parseJson<T = unknown>(result: CliResult): T {
  const text = result.stdout.trim();
  // Some commands emit a status line before JSON; find the first { or [.
  const start = Math.min(
    text.indexOf("{") >= 0 ? text.indexOf("{") : Infinity,
    text.indexOf("[") >= 0 ? text.indexOf("[") : Infinity,
  );
  if (start === Infinity) throw new Error(`No JSON in stdout: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start)) as T;
}

/** Assert the CLI exited with code 0 (or throws a descriptive error).
 *  Prints the TAIL of stdout/stderr — on a hang-then-kill the evidence
 *  (last SSE frame, last debug line) is at the end, not the start —
 *  and flags a timeout kill explicitly so a flaky run self-diagnoses. */
export function expectSuccess(result: CliResult, context?: string): void {
  if (result.exitCode !== 0) {
    const label = context ? ` (${context})` : "";
    const timeoutNote = result.timed_out ? " [KILLED BY TEST TIMEOUT — CLI hang]" : "";
    throw new Error(
      `CLI exited with code ${result.exitCode}${label}${timeoutNote}\n` +
        `stdout(tail): ${result.stdout.slice(-1500)}\n` +
        `stderr(tail): ${result.stderr.slice(-1500)}`,
    );
  }
}

/** Shorthand: run sk CLI, assert success, return stdout. */
export async function run(args: string[], opts: Parameters<typeof cli>[1]): Promise<string> {
  const result = await cli(args, opts);
  expectSuccess(result, `sk ${args.join(" ")}`);
  return result.stdout;
}

/** Shorthand: run sk CLI with --json, assert success, parse JSON. */
export async function runJson<T = unknown>(
  args: string[],
  opts: Parameters<typeof cli>[1],
): Promise<T> {
  const result = await cli([...args, "--json"], opts);
  expectSuccess(result, `sk ${args.join(" ")} --json`);
  return parseJson<T>(result);
}
