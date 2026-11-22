import { expect } from "bun:test";
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
import { runtimeConfigReplicas, runtimeConfigState } from "../db/schema/index.ts";
import { createTestDb } from "../db/tests/setup.ts";
import { OPENAPI_INFO } from "../http/openapi.ts";
import { testEnv } from "./determinism/env.ts";
import { createDeterministicHexFactory } from "./determinism/ids.ts";
import { waitFor } from "./determinism/wait.ts";
import { seedTenant } from "./seed.ts";

const hex = createDeterministicHexFactory(0xe619f);
const entry = join(import.meta.dir, "../index.ts");
const tsconfig = join(import.meta.dir, "../../../../tsconfig.json");
const MAX_CAPTURE_CHARS = 256 * 1024;
export const PROCESS_TEST_TIMEOUT_MS =
  testEnv.SUBKIT_ENGINE_TEST_BINARY !== undefined ||
  testEnv.SUBKIT_ENGINE_TEST_VERSION !== undefined
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
    const binaryPath = testEnv.SUBKIT_ENGINE_TEST_BINARY;
    const version = testEnv.SUBKIT_ENGINE_TEST_VERSION;
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
      env: { PATH: testEnv.PATH, NODE_ENV: "test", NO_UPDATE_CHECK: "1" },
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

export function artifactReceipt(target: EngineTestTarget) {
  return target.kind === "native"
    ? { artifact_kind: target.kind, binary_path: target.binaryPath, binary_sha256: target.sha256 }
    : { artifact_kind: target.kind };
}

export interface EngineProcessHandle {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  replicaId: string;
  logs: () => string;
  rawLogs: () => string;
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

export interface ProcessFixtureOptions {
  config?: Record<string, unknown>;
}

export async function processFixture(label: string, options: ProcessFixtureOptions = {}) {
  const target = await engineTestTarget();
  await assertSameEngineCandidate(target);
  const db = await createTestDb(`engine-process-${label}`);
  const directory = mkdtempSync(join(tmpdir(), "subkit-engine-process-"));
  const configPath = join(directory, "subkit.config.json");
  const port = await ephemeralPort();
  const key = hex(32);
  const sessionSecret = hex(32);
  await seedTenant(db.db, {
    slug: "default",
    display_name: "Isolated process fixture",
    status: "suspended",
  });
  writeFileSync(
    configPath,
    JSON.stringify({
      server: { port, public_base_url: `http://127.0.0.1:${port}` },
      llm: { provider: "mock", model: "mock" },
      auth: { session: { secret: sessionSecret } },
      operations: { update_check_enabled: false, seed_skills_at_boot: false },
      log: { level: "info", format: "json" },
      ...options.config,
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
        PATH: testEnv.PATH,
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
    const rawLogs = () => capture;
    const handle = { child, replicaId, logs, rawLogs, elapsed, exited, isRunning };
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

export async function healthy(
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
