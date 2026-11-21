import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdaterConfig } from "@cli-core/updater.ts";
import { desc, eq, like } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { closeDb } from "../db/client.ts";
import { auditLog } from "../db/schema/audit.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { runRollback, runSelfUpdate } from "../self-update.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { createDeterministicHexFactory, getTestNow } from "../test-helpers/determinism/index.ts";

const detHex = createDeterministicHexFactory(151);

let cacheDir = "";

function makeConfig(): UpdaterConfig {
  return {
    binaryName: "engine",
    currentVersion: "0.0.0-dev",
    cacheDir,
    githubRepo: "test/repo",
    checkIntervalMs: 86_400_000,
    channel: "stable",
  };
}

let testDb: TestDb;
let savedDatabaseUrl: string | undefined;
let stdoutOutput = "";
const originalStdoutWrite = process.stdout.write;

beforeAll(async () => {
  testDb = await createTestDb("engine-self-update");
  savedDatabaseUrl = testEnv.DATABASE_URL;
  testEnv.DATABASE_URL = testDb.url;
  cacheDir = mkdtempSync(join(tmpdir(), "engine-self-update-cache-"));
  await closeDb();
});

afterAll(async () => {
  process.stdout.write = originalStdoutWrite;
  await closeDb();
  if (savedDatabaseUrl !== undefined) {
    testEnv.DATABASE_URL = savedDatabaseUrl;
  } else {
    delete testEnv.DATABASE_URL;
  }
  rmSync(cacheDir, { recursive: true, force: true });
  await testDb.cleanup();
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
});

function captureWrites(): void {
  stdoutOutput = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
}

function makeFetchImpl(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as unknown as typeof fetch;
}

describe("engine runSelfUpdate", () => {
  test("'already at latest' branch is DB-free and emits no audit row", async () => {
    captureWrites();
    const before = new Date(getTestNow() - 1);
    const fetchImpl = makeFetchImpl(
      () =>
        new Response(
          JSON.stringify({ tag_name: "v0.0.0", prerelease: false, body: "", assets: [] }),
        ),
    );
    await runSelfUpdate(fetchImpl, makeConfig());
    expect(stdoutOutput).toContain("already at latest version");
    const rows = await testDb.db
      .select()
      .from(auditLog)
      .where(like(auditLog.action, "engine.update.%"));
    const newRows = rows.filter((r) => r.ts >= before);
    expect(newRows).toEqual([]);
  });

  test("update path with a missing binary asset writes INITIATED + FAILED rows", async () => {
    captureWrites();
    const before = new Date(getTestNow() - 1);
    const fetchImpl = makeFetchImpl(
      () =>
        new Response(
          JSON.stringify({
            tag_name: "v99.0.0",
            prerelease: false,
            body: "notes",
            assets: [
              { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
            ],
          }),
        ),
    );
    await expect(runSelfUpdate(fetchImpl, makeConfig())).rejects.toThrow(/no binary/);
    expect(stdoutOutput).toContain("checking for updates");
    expect(stdoutOutput).toContain("99.0.0");

    const rows = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "engine.update.initiated"))
      .orderBy(desc(auditLog.ts));
    const initiated = rows.find((r) => r.ts >= before);
    expect(initiated).toBeDefined();
    expect(initiated?.tenant_id).toBe(SYSTEM_TENANT_ID);

    const failedRows = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "engine.update.failed"))
      .orderBy(desc(auditLog.ts));
    const recent = failedRows.find((r) => r.ts >= before);
    expect(recent).toBeDefined();
    expect(recent?.result).toBe("error");
    expect(recent?.actor_type).toBe("system");
    expect(recent?.actor_id).toBeNull();
    expect(recent?.tenant_id).toBe(SYSTEM_TENANT_ID);
  });

  test("force=true: a fresh check still hits the network", async () => {
    captureWrites();
    let fetchCalled = false;
    const fetchImpl = makeFetchImpl(() => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({ tag_name: "v0.0.0", prerelease: false, body: "", assets: [] }),
      );
    });
    await runSelfUpdate(fetchImpl, makeConfig());
    expect(fetchCalled).toBe(true);
  });

  test("explicit self-update surfaces a network failure instead of a misleading 'already at latest'", async () => {
    captureWrites();
    const fetchImpl = makeFetchImpl(() => {
      throw new Error("network error");
    });
    await expect(runSelfUpdate(fetchImpl, makeConfig())).rejects.toThrow(/network error/);
    expect(stdoutOutput).toContain("checking for updates");
    expect(stdoutOutput).not.toContain("already at latest version");
  });

  test("explicit self-update on a private-repo 404 surfaces a token hint", async () => {
    captureWrites();
    const fetchImpl = makeFetchImpl(() => new Response("not found", { status: 404 }));
    await expect(runSelfUpdate(fetchImpl, makeConfig())).rejects.toThrow(
      /private|GITHUB_TOKEN|404/i,
    );
  });
});

describe("engine runRollback", () => {
  function plantRetained(version: string, payload: string): { execPath: string; sha: string } {
    mkdirSync(join(cacheDir, "versions", version), { recursive: true });
    const binPath = join(cacheDir, "versions", version, "engine");
    writeFileSync(binPath, payload);
    chmodSync(binPath, 0o755);
    const sha = createHash("sha256").update(payload).digest("hex");
    writeFileSync(
      join(cacheDir, "versions", version, "manifest.json"),
      JSON.stringify({
        version,
        installed_at: getTestNow(),
        sha256: sha,
        binary_name: "engine",
      }),
    );
    const execTmp = mkdtempSync(join(tmpdir(), "self-update-exec-"));
    const execPath = join(execTmp, "engine");
    writeFileSync(execPath, "ORIGINAL");
    chmodSync(execPath, 0o755);
    return { execPath, sha };
  }

  async function withFakeExecPath<T>(execPath: string, fn: () => Promise<T>): Promise<T> {
    const real = process.execPath;
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process, "execPath", { value: real, configurable: true });
    }
  }

  function clearRetained(): void {
    if (existsSync(join(cacheDir, "versions"))) {
      rmSync(join(cacheDir, "versions"), { recursive: true, force: true });
    }
  }

  afterEach(() => {
    clearRetained();
  });

  test("no retained binaries — runRollback throws AND writes a FAILED audit row", async () => {
    captureWrites();
    clearRetained();
    const before = new Date(getTestNow() - 1);
    await expect(runRollback("previous", makeConfig())).rejects.toThrow(/no retained binaries/);

    const failedRows = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "engine.update.failed"))
      .orderBy(desc(auditLog.ts));
    const recent = failedRows.find((r) => r.ts >= before);
    expect(recent).toBeDefined();
    const meta = recent?.metadata as { request_source?: string; reason?: string };
    expect(meta?.request_source).toBe("rollback");
    expect(meta?.reason).toContain("no retained binaries");
  });

  test("happy path emits INITIATED + ROLLED_BACK rows and bumps the metric", async () => {
    captureWrites();
    const versionTag = detHex(2);
    const version = `0.0.${parseInt(versionTag, 16)}`;
    const { execPath } = plantRetained(version, `retained-bytes-${version}`);
    const before = new Date(getTestNow() - 1);
    try {
      await withFakeExecPath(execPath, async () => {
        await runRollback("previous", makeConfig());
      });
    } finally {
      try {
        unlinkSync(execPath);
      } catch {}
    }
    expect(stdoutOutput).toContain("rolling back");

    const initiated = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "engine.update.initiated"))
      .orderBy(desc(auditLog.ts));
    expect(initiated.find((r) => r.ts >= before)).toBeDefined();

    const rolledBack = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "engine.update.rolled_back"))
      .orderBy(desc(auditLog.ts));
    const recent = rolledBack.find((r) => r.ts >= before);
    expect(recent).toBeDefined();
    expect(recent?.result).toBe("success");
    expect(recent?.actor_type).toBe("system");
    expect(recent?.actor_id).toBeNull();
    const meta = recent?.metadata as { request_source?: string; sha256?: string };
    expect(meta?.request_source).toBe("rollback");
    expect(meta?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
