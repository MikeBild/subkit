// Boot-time dependency validation.
//
// Runs after loadConfig() + assertCryptoKeyOrExit() but BEFORE
// runMigrations() so the operator sees one clear "what's missing"
// error instead of a downstream subsystem crash. Each probe maps to
// a specific class of misconfiguration:
//
//   * DB CONNECT       — DATABASE_URL points at a reachable Postgres
//                        and the role can run `SELECT 1`.
//   * DB EXTENSIONS    — `pgcrypto` is installed in the search_path
//                        (gen_random_uuid() default for primary keys).
//   * FS WRITE         — engine writes to /etc/subkit (config), /var/lib/subkit
//                        (blob storage). On systemd `StateDirectory=`
//                        and `ConfigurationDirectory=` create them with
//                        the right ACL; this probe confirms.
//   * CRYPTO SELF-TEST — encrypt+decrypt a known plaintext with the
//                        master key. Catches a length-correct hex string
//                        that isn't actually 32 bytes after decoding.
//   * RUNTIME          — Bun version + arch, surfaced via structured log
//                        so an operator can correlate a startup against
//                        the build artifact.
//
// Each probe logs `boot.dependency.<name>.{ok,fail}` so structured-log
// alerting can fire on `_fail` without parsing prose. The blocker
// classes (DB connect, crypto) exit 1 — the engine cannot serve
// requests in those states. The non-blocker classes (FS write to
// optional dirs) emit a `warn` and continue.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";

const STATE_DIRS = [
  // engine writes its config file here on first boot via the loader's
  // auto-create path; without write access subkit.config.json never lands
  // and every restart re-prompts.
  "/etc/subkit",
  // file-storage blobs (FILE_STORAGE_ROOT). Optional in dev, required
  // in production when storage.s3 is unset.
  "/var/lib/subkit",
];

interface ProbeResult {
  name: string;
  ok: boolean;
  blocker: boolean;
  detail?: string;
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
    // pgcrypto is required for `gen_random_uuid()` defaults; runMigrations
    // installs it on first run, but a probe here surfaces the missing
    // extension before migrations run their CREATE TABLE statements
    // (which fail with a confusing "function gen_random_uuid() does not
    // exist" error if the operator's role lacks CREATE EXTENSION).
    const result = (await db.execute(
      sql`SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`,
    )) as unknown as { rows: Array<{ extname: string }> };
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
  // The systemd unit's StateDirectory/ConfigurationDirectory keys
  // create these dirs with mode 0750 + the right User/Group; this
  // probe confirms (a) the dir exists and (b) the engine user has
  // write access. Local dev runs as the operator's UID and these
  // paths may not exist — that's a non-blocker.
  const probe = join(dir, ".subkit-boot-probe");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "ok", { mode: 0o600 });
    const back = readFileSync(probe, "utf8");
    unlinkSync(probe);
    if (back !== "ok") {
      return {
        name: `fs_write:${dir}`,
        ok: false,
        blocker: false,
        detail: "round-trip read returned unexpected content",
      };
    }
    return { name: `fs_write:${dir}`, ok: true, blocker: false };
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

function probeRuntime(): ProbeResult {
  // Surface the Bun version + arch + platform once at boot. Not a
  // gate; just structured forensic info so an operator can correlate
  // a runtime crash against the binary's reported version.
  const bun = (globalThis as unknown as { Bun?: { version?: string } }).Bun;
  const detail = `bun=${bun?.version ?? "<not-bun>"} platform=${process.platform} arch=${process.arch}`;
  return { name: "runtime", ok: true, blocker: false, detail };
}

/**
 * Run every dependency probe, log structured results, and abort boot
 * if any blocker fails. Caller invokes this AFTER assertCryptoKeyOrExit
 * (so MASTER_KEY format is already validated) and BEFORE runMigrations
 * (so a CONNECT failure surfaces clearly instead of as a vague
 * "Failed query" line in migrate logs).
 */
export async function validateBootDependencies(db: Db): Promise<void> {
  const probes: ProbeResult[] = [
    probeRuntime(),
    probeCryptoSelfTest(),
    await probeDbConnect(db),
    await probeDbExtensions(db),
    ...STATE_DIRS.map((d) => probeFsWrite(d)),
  ];

  let blockerFailed = false;
  for (const p of probes) {
    if (p.ok) {
      logger.info({
        module: "boot.dependency",
        action: `${p.name}.ok`,
        msg: `boot dependency ok: ${p.name}`,
        detail: p.detail ?? null,
      });
      continue;
    }
    if (p.blocker) {
      blockerFailed = true;
      logger.fatal({
        module: "boot.dependency",
        action: `${p.name}.fail`,
        msg: `boot blocker failed: ${p.name} — engine cannot serve requests`,
        detail: p.detail ?? null,
      });
    } else {
      logger.warn({
        module: "boot.dependency",
        action: `${p.name}.fail`,
        msg: `boot dependency degraded: ${p.name} — continuing`,
        detail: p.detail ?? null,
      });
    }
  }

  if (blockerFailed) {
    // Surface a single summary line so the operator sees `boot.aborted`
    // as the last entry before the process exits — easier to grep than
    // hunting through individual probe failures.
    logger.fatal({
      module: "boot.dependency",
      action: "boot.aborted",
      msg: "one or more boot dependency probes failed; aborting",
    });
    process.exit(1);
  }
}

// Test seam: a non-fatal variant that returns the probe outcomes
// instead of exit(1)-ing. Used by unit tests so the gate doesn't kill
// the test runner.
export async function validateBootDependenciesForTests(db: Db): Promise<{
  blockerFailed: boolean;
  probes: ProbeResult[];
}> {
  const probes: ProbeResult[] = [
    probeRuntime(),
    probeCryptoSelfTest(),
    await probeDbConnect(db),
    await probeDbExtensions(db),
    ...STATE_DIRS.map((d) => probeFsWrite(d)),
  ];
  return { blockerFailed: probes.some((p) => p.blocker && !p.ok), probes };
}

export type { ProbeResult };
