import { accessSync, constants, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import type { Db } from "../db/client.ts";
import { readEnv } from "../env.ts";
import { logger } from "../logging/index.ts";

interface ProbeResult {
  name: string;
  ok: boolean;
  blocker: boolean;
  detail?: string;
  duration_ms?: number;
}

async function timed(probe: () => ProbeResult | Promise<ProbeResult>): Promise<ProbeResult> {
  const started = performance.now();
  const result = await probe();
  return { ...result, duration_ms: Math.round(performance.now() - started) };
}

async function probeDbConnect(db: Db): Promise<ProbeResult> {
  try {
    await db.execute(sql`SELECT 1`);
    return { name: "db_connect", ok: true, blocker: true };
  } catch (err) {
    return {
      name: "db_connect",
      ok: false,
      blocker: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeDbExtensions(db: Db): Promise<ProbeResult> {
  try {
    const result = await db.execute(
      sql`SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`,
    );
    if (result.rows.length === 0) {
      return {
        name: "db_extensions",
        ok: false,
        blocker: false,
        detail:
          "pgcrypto extension not installed; runMigrations will install it but the role needs CREATE EXTENSION privilege",
      };
    }
    return { name: "db_extensions", ok: true, blocker: false };
  } catch (err) {
    return {
      name: "db_extensions",
      ok: false,
      blocker: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeFsWrite(dir: string): ProbeResult {
  const probe = join(dir, `.subkit-boot-probe.${process.pid}.${Date.now()}`);
  try {
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    }
    try {
      writeFileSync(probe, "ok", { mode: 0o600 });
      const back = readFileSync(probe, "utf8");
      if (back !== "ok") {
        return {
          name: `fs_write:${dir}`,
          ok: false,
          blocker: false,
          detail: "round-trip read returned unexpected content",
        };
      }
      return { name: `fs_write:${dir}`, ok: true, blocker: false };
    } finally {
      try {
        unlinkSync(probe);
      } catch {}
    }
  } catch (err) {
    return {
      name: `fs_write:${dir}`,
      ok: false,
      blocker: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeCryptoSelfTest(): ProbeResult {
  try {
    const plaintext = "subkit-boot-self-test";
    const payload = encryptSecret(plaintext, "boot-self-test");
    const back = decryptSecret(payload, "boot-self-test");
    if (back !== plaintext) {
      return {
        name: "crypto_self_test",
        ok: false,
        blocker: true,
        detail: `round-trip mismatch: '${back}' !== '${plaintext}'`,
      };
    }
    return { name: "crypto_self_test", ok: true, blocker: true };
  } catch (err) {
    return {
      name: "crypto_self_test",
      ok: false,
      blocker: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

declare const Bun: { version: string } | undefined;

function probeRuntime(): ProbeResult {
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : "<not-bun>";
  const detail = `bun=${bunVersion} platform=${process.platform} arch=${process.arch}`;
  return { name: "runtime", ok: true, blocker: false, detail };
}

const FALLBACK_STATE_DIRS = ["/etc/subkit", "/var/lib/subkit"];

function isProduction(): boolean {
  return (readEnv("NODE_ENV") ?? "").toLowerCase() === "production";
}

function resolveStateDirs(): string[] {
  const fromSystemd = [
    ...(readEnv("CONFIGURATION_DIRECTORY")?.split(":") ?? []),
    ...(readEnv("STATE_DIRECTORY")?.split(":") ?? []),
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (fromSystemd.length > 0) {
    return Array.from(new Set(fromSystemd));
  }
  return FALLBACK_STATE_DIRS;
}

function probeObjectStore(root: string): ProbeResult {
  return { ...probeFsWrite(root), name: "object_store", blocker: true };
}

async function runAllProbes(db: Db, objectStoreRoot: string | null): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [
    await timed(probeRuntime),
    await timed(probeCryptoSelfTest),
    await timed(() => probeDbConnect(db)),
    await timed(() => probeDbExtensions(db)),
    ...(objectStoreRoot ? [await timed(() => probeObjectStore(objectStoreRoot))] : []),
  ];
  if (isProduction()) {
    for (const dir of resolveStateDirs()) probes.push(probeFsWrite(dir));
  }
  return probes;
}

export async function validateBootDependencies(
  db: Db,
  objectStoreRoot: string | null = null,
): Promise<void> {
  const probes = await runAllProbes(db, objectStoreRoot);

  const failedBlockers: string[] = [];
  for (const p of probes) {
    if (p.ok) {
      logger.info({
        module: "observability",
        action: `boot.dependency.${p.name}.ok`,
        msg: `boot dependency ok: ${p.name}`,
        detail: p.detail ?? null,
        duration_ms: p.duration_ms ?? null,
      });
      continue;
    }
    if (p.blocker) {
      failedBlockers.push(p.detail ? `${p.name}: ${p.detail}` : p.name);
      logger.fatal({
        module: "observability",
        action: `boot.dependency.${p.name}.fail`,
        msg: `boot blocker failed: ${p.name} — engine cannot serve requests`,
        detail: p.detail ?? null,
        duration_ms: p.duration_ms ?? null,
      });
    } else {
      logger.warn({
        module: "observability",
        action: `boot.dependency.${p.name}.fail`,
        msg: `boot dependency degraded: ${p.name} — continuing`,
        detail: p.detail ?? null,
        duration_ms: p.duration_ms ?? null,
      });
    }
  }

  if (failedBlockers.length > 0)
    throw new Error(`boot dependency failed: ${failedBlockers.join("; ")}`);
}

export async function _validateBootDependenciesForTests(
  db: Db,
  objectStoreRoot: string | null = null,
): Promise<{
  blockerFailed: boolean;
  probes: ProbeResult[];
}> {
  const probes = await runAllProbes(db, objectStoreRoot);
  return { blockerFailed: probes.some((p) => p.blocker && !p.ok), probes };
}

export type { ProbeResult };
