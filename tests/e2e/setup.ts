// E2E test harness for the subkit + sk CLI binaries.
//
// Boots a real engine (Hono + pg-boss) against a disposable Postgres
// database, seeds three personas (admin, member, enduser), and provides
// a `cli()` helper that invokes compiled CLI binaries as subprocesses
// with per-persona config directories.
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
import type { Db } from "../../apps/engine/src/db/client.ts";
import { apiKeys, systemAccounts, tenants, users } from "../../apps/engine/src/db/schema/index.ts";
import { createTestDb, type TestDb } from "../../apps/engine/src/db/tests/setup.ts";
import { buildDefaultRegistry, createApp } from "../../apps/engine/src/http/server.ts";
import { resetMockProvider } from "../../apps/engine/src/llm/mock-provider.ts";
import { createBoss, disposeBoss, startBoss, stopBoss } from "../../apps/engine/src/queue/boss.ts";
import { registerAllHandlers } from "../../apps/engine/src/queue/handlers/index.ts";
import {
  backfillRoleIds,
  type SeededRoleIds,
  seedBuiltinRolesAndPermissions,
} from "../../apps/engine/src/rbac/seed.ts";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SUBKIT_BIN = path.join(REPO_ROOT, "dist/subkit");
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

export async function boot(label: string): Promise<E2EEnv> {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();

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

  // pg-boss.
  let boss: PgBoss;
  try {
    boss = await startBoss({ connectionString: testDb.url });
  } catch {
    boss = await createBoss({ connectionString: testDb.url });
  }
  await registerAllHandlers({ boss, db: testDb.db });

  // HTTP server on random port.
  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({ db: testDb.db, registry });
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") throw new Error("failed to get server port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

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
      // 1. Close HTTP server.
      const s = server as unknown as {
        close: (cb: () => void) => void;
        closeAllConnections?: () => void;
      };
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
      // 2. Stop pg-boss and close all its Postgres connections.
      try {
        await stopBoss(5_000);
      } catch {
        /* ignore */
      }
      try {
        await disposeBoss(boss, 2_000);
      } catch {
        /* ignore */
      }
      // 3. Give pg-boss connections time to fully close before dropping DB.
      await new Promise((r) => setTimeout(r, 200));
      // 4. Drop the test database.
      await testDb.cleanup();
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

export const shutdown = (env: E2EEnv) => env.cleanup();

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Invoke a CLI binary as a subprocess.
 *
 * @param binary - "subkit" or "sk"
 * @param args   - CLI arguments (e.g. ["health", "--json"])
 * @param opts   - persona for auth + optional env overrides
 */
export async function cli(
  binary: "subkit" | "sk",
  args: string[],
  opts: {
    env: E2EEnv;
    persona?: PersonaName;
    extraEnv?: Record<string, string>;
    timeout?: number;
  },
): Promise<CliResult> {
  const bin = binary === "subkit" ? SUBKIT_BIN : SK_BIN;
  const persona = opts.persona ? opts.env.personas[opts.persona] : opts.env.personas.admin;
  const _configDir =
    binary === "subkit" ? path.join(persona.homeDir, ".subkit") : path.join(persona.homeDir, ".sk");

  const proc = Bun.spawn([bin, ...args], {
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
      ...opts.extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = opts.timeout ?? 30_000;
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, exitCode };
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

/** Assert the CLI exited with code 0 (or throws a descriptive error). */
export function expectSuccess(result: CliResult, context?: string): void {
  if (result.exitCode !== 0) {
    const label = context ? ` (${context})` : "";
    throw new Error(
      `CLI exited with code ${result.exitCode}${label}\n` +
        `stdout: ${result.stdout.slice(0, 500)}\n` +
        `stderr: ${result.stderr.slice(0, 500)}`,
    );
  }
}

/** Shorthand: run CLI, assert success, return stdout. */
export async function run(
  binary: "subkit" | "sk",
  args: string[],
  opts: Parameters<typeof cli>[2],
): Promise<string> {
  const result = await cli(binary, args, opts);
  expectSuccess(result, `${binary} ${args.join(" ")}`);
  return result.stdout;
}

/** Shorthand: run CLI with --json, assert success, parse JSON. */
export async function runJson<T = unknown>(
  binary: "subkit" | "sk",
  args: string[],
  opts: Parameters<typeof cli>[2],
): Promise<T> {
  const result = await cli(binary, [...args, "--json"], opts);
  expectSuccess(result, `${binary} ${args.join(" ")} --json`);
  return parseJson<T>(result);
}
