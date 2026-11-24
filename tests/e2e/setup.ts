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
  backfillSystemAccountRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../../apps/engine/src/rbac/seed.ts";
import {
  MemoryObjectStore,
  setObjectStoreForTesting,
} from "../../apps/engine/src/storage/object-store.ts";

async function ensureEngineConfigLoaded(): Promise<void> {
  try {
    getEngineConfig();
    return;
  } catch {}
  const dir = mkdtempSync(path.join(tmpdir(), "subkit-cfg-e2e-"));
  await loadEngineConfig({
    env: { DATABASE_URL: "postgres://placeholder/e2e", NODE_ENV: "test" },
    configPathOverride: path.join(dir, "subkit.config.json"),
  });
}

export type PersonaName = "admin" | "member" | "enduser";

export interface Persona {
  name: PersonaName;
  apiKey: string;
  userId: string;
  systemAccountId: string;
  tenantId: string;
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

export interface BootOpts {
  llm?: "mock";
  browser_discovery?: true;
}

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
  } catch {}
}

interface TrackedSocket {
  destroy: () => void;
  on: (event: "close", listener: () => void) => void;
}

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
            } catch {}
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
  } catch {}
}

export function providerFromEnv(): string | undefined {
  const raw = process.env.SUBKIT_OVERRIDE_LLM_PROVIDER ?? process.env.LLM_PROVIDER;
  return raw?.toLowerCase();
}

export function realProviderConfigured(): boolean {
  const explicit = providerFromEnv();
  if (explicit === "mock") return false;
  if (process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_MODEL) return true;
  return DIRECT_E2E_PROVIDERS.includes(explicit ?? "");
}

const DIRECT_E2E_PROVIDERS = ["anthropic", "openai", "gemini", "azure", "bedrock", "vertex"];

function detectRealProvider(): { provider: string; reason: string } {
  const explicit = providerFromEnv();
  if (explicit === "mock") {
    return { provider: "mock", reason: "provider=mock" };
  }
  if (process.env.AI_GATEWAY_API_KEY && process.env.AI_GATEWAY_MODEL) {
    return { provider: "gateway", reason: "AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL set" };
  }
  if (DIRECT_E2E_PROVIDERS.includes(explicit ?? "")) {
    return { provider: explicit as string, reason: `provider=${explicit}` };
  }
  throw new Error(
    "E2E boot() needs either a mock provider, AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL, " +
      "or SUBKIT_OVERRIDE_LLM_PROVIDER (or LLM_PROVIDER) set to " +
      `${DIRECT_E2E_PROVIDERS.join("/")} with the matching credentials.`,
  );
}

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SUBKIT_BIN = path.join(REPO_ROOT, "dist/subkit");

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

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

export async function boot(label: string, opts: BootOpts = {}): Promise<E2EEnv> {
  await ensureEngineConfigLoaded();
  const priorObjectStoreBucket = getEngineConfig().storage.object_store.bucket;
  if (!priorObjectStoreBucket) {
    await setConfigKey("storage.object_store.bucket", "test", { force: true });
  }
  setObjectStoreForTesting(new MemoryObjectStore());
  if (opts.llm === "mock") {
    process.env.LLM_PROVIDER = "mock";
    await setConfigKey("llm.provider", "mock", { force: true });
    const { resetMockProvider } = await import("../../apps/engine/src/llm/mock-provider.ts");
    resetMockProvider();
  } else {
    const detected = detectRealProvider();
    if (detected.provider !== "gateway") {
      await setConfigKey("llm.provider", detected.provider, { force: true });
    }
  }

  const hermeticBrowser = opts.llm === "mock" && !opts.browser_discovery;
  if (hermeticBrowser) disableBrowserDiscovery();

  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const testDb = await createTestDb(`e2e-${safeLabel}`);
  const rbacRoleIds = await seedBuiltinRolesAndPermissions(testDb.db);

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({
      slug: `e2e-${safeLabel}`.slice(0, 32),
      display_name: `E2E ${label}`,
      is_operator: true,
    })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  await backfillSystemAccountRoleIds(testDb.db, rbacRoleIds);

  const personas = {} as Record<PersonaName, Persona>;
  for (const def of PERSONA_DEFS) {
    const homeDir = mkdtempSync(path.join(tmpdir(), `subkit-e2e-${def.name}-`));

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

  const boss = await createBoss({ connectionString: testDb.url });
  await registerAllHandlers({ boss, db: testDb.db });

  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({ db: testDb.db, registry, boss });
  const server: ServerType = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    overrideGlobalObjects: false,
  });
  const sockets = trackConnections(server);
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") throw new Error("failed to get server port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const priorPublicBaseUrlEnv = process.env.SUBKIT_PUBLIC_BASE_URL;
  process.env.SUBKIT_PUBLIC_BASE_URL = baseUrl;
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
      if (priorPublicBaseUrlEnv === undefined) delete process.env.SUBKIT_PUBLIC_BASE_URL;
      else process.env.SUBKIT_PUBLIC_BASE_URL = priorPublicBaseUrlEnv;
      if (hermeticBrowser) setChromiumProviderForTesting(null);
      await bestEffortTeardown(
        "public_base_url config restore",
        () => setConfigKey("server.public_base_url", priorPublicBaseUrlConfig, { force: true }),
        3_000,
      );
      await closeHttpServer(server, sockets);
      await bestEffortTeardown("suite pg-boss dispose", () => disposeBoss(boss), 8_000);
      setObjectStoreForTesting(null);
      if (!priorObjectStoreBucket) {
        await bestEffortTeardown(
          "object-store bucket config restore",
          () =>
            setConfigKey("storage.object_store.bucket", priorObjectStoreBucket, { force: true }),
          3_000,
        );
      }
      // allow-wall-clock: socket teardown requires real I/O time.
      await new Promise((r) => setTimeout(r, 200));
      await bestEffortTeardown("test database cleanup", testDb.cleanup, 10_000);
      for (const p of Object.values(personas)) {
        try {
          rmSync(p.homeDir, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

export const shutdown = (env: E2EEnv | undefined) => env?.cleanup() ?? Promise.resolve();

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timed_out: boolean;
}

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

  const proc = Bun.spawn([SUBKIT_BIN, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: opts.env.baseUrl,
      SUBKIT_API_KEY: persona.apiKey,
      SUBKIT_TENANT: persona.tenantId,
      HOME: persona.homeDir,
      XDG_CONFIG_HOME: persona.homeDir,
      CI: "1",
      NO_COLOR: "1",
      NO_UPDATE_CHECK: "1",
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

export function writeTempFile(persona: Persona, filename: string, content: string): string {
  const filePath = path.join(persona.homeDir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function parseJson<T = unknown>(result: CliResult): T {
  const text = result.stdout.trim();
  const start = Math.min(
    text.indexOf("{") >= 0 ? text.indexOf("{") : Infinity,
    text.indexOf("[") >= 0 ? text.indexOf("[") : Infinity,
  );
  if (start === Infinity) throw new Error(`No JSON in stdout: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start)) as T;
}

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

export async function run(args: string[], opts: Parameters<typeof cli>[1]): Promise<string> {
  const result = await cli(args, opts);
  expectSuccess(result, `subkit ${args.join(" ")}`);
  return result.stdout;
}

export async function runJson<T = unknown>(
  args: string[],
  opts: Parameters<typeof cli>[1],
): Promise<T> {
  const result = await cli([...args, "--json"], opts);
  expectSuccess(result, `subkit ${args.join(" ")} --json`);
  return parseJson<T>(result);
}
