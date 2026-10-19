import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  createReadStream,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { eq } from "drizzle-orm";
import {
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { OPENAPI_INFO } from "../http/openapi.ts";
import { logger } from "../logging/logger.ts";
import { createDeterministicHexFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";

const hex = createDeterministicHexFactory(0xe619e);
const entry = join(import.meta.dir, "../index.ts");
const tsconfig = join(import.meta.dir, "../../../../tsconfig.json");
const MAX_CAPTURE_CHARS = 256 * 1024;
const PROCESS_TEST_TIMEOUT_MS =
  process.env.SUBKIT_ENGINE_TEST_BINARY !== undefined ||
  process.env.SUBKIT_ENGINE_TEST_VERSION !== undefined
    ? 180_000
    : 60_000;

type EngineTestTarget =
  | { kind: "source-bun"; version: string }
  | { kind: "native"; version: string; binaryPath: string; sha256: string };

let selectedTarget: Promise<EngineTestTarget> | undefined;

async function binarySha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function engineTestTarget(): Promise<EngineTestTarget> {
  selectedTarget ??= (async () => {
    const binaryPath = process.env.SUBKIT_ENGINE_TEST_BINARY;
    const version = process.env.SUBKIT_ENGINE_TEST_VERSION;
    if (binaryPath === undefined && version === undefined)
      return { kind: "source-bun", version: OPENAPI_INFO.version } as const;
    if (
      !binaryPath ||
      !version ||
      !isAbsolute(binaryPath) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    )
      throw new Error(
        "native process tests require an absolute SUBKIT_ENGINE_TEST_BINARY and paired SUBKIT_ENGINE_TEST_VERSION",
      );
    const resolved = realpathSync(binaryPath);
    if (!statSync(resolved).isFile())
      throw new Error("native engine candidate must be a regular executable file");
    accessSync(resolved, constants.X_OK);
    const sha256 = await binarySha256(resolved);
    const result = Bun.spawnSync([resolved, "--version"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, NODE_ENV: "test", NO_UPDATE_CHECK: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      maxBuffer: 4096,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(version);
    if ((await binarySha256(resolved)) !== sha256)
      throw new Error("native engine candidate changed during identity check");
    return { kind: "native", version, binaryPath: resolved, sha256 } as const;
  })();
  return await selectedTarget;
}

async function assertSameEngineCandidate(target: EngineTestTarget): Promise<void> {
  if (target.kind === "native" && (await binarySha256(target.binaryPath)) !== target.sha256)
    throw new Error("native engine candidate changed during process acceptance");
}

function artifactReceipt(target: EngineTestTarget) {
  return target.kind === "native"
    ? { artifact_kind: target.kind, binary_path: target.binaryPath, binary_sha256: target.sha256 }
    : { artifact_kind: target.kind };
}

interface EngineProcessHandle {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  replicaId: string;
  logs: () => string;
  elapsed: () => number;
  exited: (timeoutMs?: number) => Promise<number>;
  isRunning: () => boolean;
}

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("missing isolated engine port");
  return address.port;
}

function redact(text: string, secrets: string[]): string {
  let safe = text
    .replace(/postgres(?:ql)?:\/\/[^\s"'\\]+/gi, "<database>")
    .replace(/wf_live_[A-Za-z0-9_-]+/g, "<api-key>");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(secret, "<fixture-secret>");
  return safe;
}

async function processFixture(label: string) {
  const target = await engineTestTarget();
  await assertSameEngineCandidate(target);
  const db = await createTestDb(`engine-process-${label}`);
  const directory = mkdtempSync(join(tmpdir(), "subkit-engine-process-"));
  const configPath = join(directory, "subkit.config.json");
  const port = await ephemeralPort();
  const key = hex(32);
  const sessionSecret = hex(32);
  await db.db
    .insert(tenants)
    .values({ slug: "default", display_name: "Isolated process fixture", status: "suspended" });
  writeFileSync(
    configPath,
    JSON.stringify({
      server: { port, public_base_url: `http://127.0.0.1:${port}` },
      llm: { provider: "mock", model: "mock" },
      auth: { session: { secret: sessionSecret } },
      operations: { update_check_enabled: false, seed_skills_at_boot: false },
      log: { level: "info", format: "json" },
    }),
    { mode: 0o600 },
  );
  const children: EngineProcessHandle[] = [];
  function start(masterKey = key, replicaId = `fixture-engine-${label}`): EngineProcessHandle {
    const started = process.hrtime.bigint();
    const argv =
      target.kind === "native"
        ? [target.binaryPath]
        : [
            process.execPath,
            "--no-install",
            `--tsconfig-override=${tsconfig}`,
            `--define=BUILD_VERSION=${JSON.stringify(target.version)}`,
            entry,
          ];
    const child = Bun.spawn(argv, {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        MASTER_KEY: masterKey,
        DATABASE_URL: db.url,
        SUBKIT_CONFIG: configPath,
        ENGINE_LISTEN_HOST: "127.0.0.1",
        SUBKIT_REPLICA_ID: replicaId,
        OTEL_SDK_DISABLED: "true",
        CONFIGURATION_DIRECTORY: directory,
        STATE_DIRECTORY: directory,
        TMPDIR: directory,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let exitCode: number | undefined;
    const completion = child.exited.then((code) => {
      exitCode = code;
      return code;
    });
    const isRunning = () => exitCode === undefined;
    let capture = "";
    const append = (chunk: string) => {
      capture = (capture + chunk).slice(-MAX_CAPTURE_CHARS);
    };
    async function pump(stream: ReadableStream<Uint8Array>) {
      const decoder = new TextDecoder();
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
      append(decoder.decode());
    }
    const streams = Promise.all([pump(child.stdout), pump(child.stderr)]);
    const password = decodeURIComponent(new URL(db.url).password);
    const logs = () => redact(capture, [key, masterKey, sessionSecret, db.url, password]);
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1_000_000;
    async function exited(timeoutMs = 15000) {
      try {
        await waitFor(() => !isRunning(), {
          tries: Math.ceil(timeoutMs / 20),
          sleepMs: 20,
          label: "isolated engine exit",
        });
      } catch {
        child.kill("SIGKILL");
        await child.exited;
        await streams;
        throw new Error(`isolated engine exit watchdog: ${logs()}`);
      }
      await streams;
      return await completion;
    }
    const handle = { child, replicaId, logs, elapsed, exited, isRunning };
    children.push(handle);
    return handle;
  }
  async function cleanup() {
    for (const child of children) {
      if (child.isRunning()) {
        child.child.kill("SIGKILL");
        await child.exited();
      }
    }
    try {
      await db.cleanup();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await assertSameEngineCandidate(target);
    }
  }
  return { db, port, key, start, cleanup, target };
}

async function healthy(
  fixture: Awaited<ReturnType<typeof processFixture>>,
  child: ReturnType<Awaited<ReturnType<typeof processFixture>>["start"]>,
) {
  const started = process.hrtime.bigint();
  try {
    return await waitFor(
      async () => {
        if (Number(process.hrtime.bigint() - started) / 1_000_000 > 30000)
          throw new Error("isolated engine startup deadline exceeded");
        if (!child.isRunning())
          throw new Error(`isolated engine exited before health: ${child.logs()}`);
        let response: Response;
        try {
          response = await fetch(`http://127.0.0.1:${fixture.port}/health`, {
            signal: AbortSignal.timeout(500),
          });
        } catch {
          return false;
        }
        if (response.status !== 200) return false;
        const body = (await response.json()) as {
          status: string;
          version: string;
          service: string;
        };
        expect(body).toEqual({ status: "ok", service: "subkit", version: fixture.target.version });
        const [replica] = await fixture.db.db
          .select()
          .from(runtimeConfigReplicas)
          .where(eq(runtimeConfigReplicas.instance_id, child.replicaId));
        const [state] = await fixture.db.db.select().from(runtimeConfigState);
        expect(replica?.product_version).toBe(fixture.target.version);
        expect(state?.master_key_digest).toBe(
          createHash("sha256").update(Buffer.from(fixture.key, "hex")).digest("hex"),
        );
        expect(replica?.active_revision).toBe(state?.active_revision);
        expect(state?.active_revision).toBeGreaterThan(0);
        return body;
      },
      { tries: 1500, sleepMs: 20, label: `isolated ${fixture.target.kind} engine health` },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "engine startup failed"}\n${child.logs()}`,
    );
  }
}

async function snapshot(db: TestDb) {
  return {
    state: await db.db.select().from(runtimeConfigState),
    revisions: await db.db.select().from(runtimeConfigRevisions),
    secrets: await db.db.select().from(runtimeSecretVersions),
  };
}

test(
  "engine pins/registers before HTTP health and removes registration after graceful shutdown",
  async () => {
    const fixture = await processFixture("normal");
    try {
      const child = fixture.start();
      await healthy(fixture, child);
      const startupMs = child.elapsed();
      const ready = await fetch(`http://127.0.0.1:${fixture.port}/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        status: "ready",
        version: fixture.target.version,
        checks: { lifecycle: "pass", database: "pass" },
      });
      const [revision] = await fixture.db.db.select().from(runtimeConfigRevisions);
      expect(revision?.document).toMatchObject({
        server: { port: fixture.port },
        llm: { provider: "mock" },
        operations: { update_check_enabled: false },
      });
      child.child.kill("SIGTERM");
      const code = await child.exited();
      expect(code).toBe(0);
      expect(child.logs()).toContain('"action":"shutdown.complete"');
      expect(child.logs()).not.toContain('"action":"shutdown.replica_registration_retained"');
      expect(
        await fixture.db.db
          .select()
          .from(runtimeConfigReplicas)
          .where(eq(runtimeConfigReplicas.instance_id, child.replicaId)),
      ).toEqual([]);
      const before = await snapshot(fixture.db);
      const mismatch = fixture.start(hex(32), "fixture-engine-mismatch");
      expect(await mismatch.exited()).toBe(1);
      expect(mismatch.logs()).toContain("vault_master_key_mismatch");
      expect(mismatch.logs()).not.toContain('"action":"ready"');
      expect(await snapshot(fixture.db)).toEqual(before);
      expect(await fixture.db.db.select().from(runtimeConfigReplicas)).toEqual([]);
      await expect(
        fetch(`http://127.0.0.1:${fixture.port}/health`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toBeDefined();
      logger.info({
        module: "tests",
        action: "engine_process.normal_receipt",
        version: fixture.target.version,
        startup_ms: Math.round(startupMs),
        normal_exit: code,
        mismatch_exit: 1,
        source_bun: fixture.target.kind === "source-bun",
        ...artifactReceipt(fixture.target),
      });
    } finally {
      await fixture.cleanup();
    }
  },
  PROCESS_TEST_TIMEOUT_MS,
);

test(
  "abrupt engine death preserves its owned registration for review",
  async () => {
    const fixture = await processFixture("abrupt");
    try {
      const child = fixture.start();
      await healthy(fixture, child);
      child.child.kill("SIGKILL");
      await child.exited();
      expect(child.logs()).not.toContain('"action":"shutdown.complete"');
      const rows = await fixture.db.db
        .select()
        .from(runtimeConfigReplicas)
        .where(eq(runtimeConfigReplicas.instance_id, child.replicaId));
      expect(rows).toHaveLength(1);
      logger.info({
        module: "tests",
        action: "engine_process.abrupt_receipt",
        version: fixture.target.version,
        registration_retained: true,
        source_bun: fixture.target.kind === "source-bun",
        ...artifactReceipt(fixture.target),
      });
    } finally {
      await fixture.cleanup();
    }
  },
  PROCESS_TEST_TIMEOUT_MS,
);
