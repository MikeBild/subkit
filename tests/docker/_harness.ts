// Docker-image E2E harness (Track B).
//
// Drives the production application container plus external PostgreSQL
// (Dockerfile + entrypoint.sh + docker-compose.test.yml)
// over the network, the way a customer runs it. Distinct from the in-process
// `tests/e2e/setup.ts` harness — this one cannot pin LLM tool sequences
// (the engine is a separate process) so Track B is outcome-based only.
//
// Bootstrap follows the real first-run operator flow:
//   1. compose up --build --wait  (blocks on the image healthcheck)
//   2. POST /v1/bootstrap/complete with the test-only bootstrap key
//   3. materialise the tenant + admin user + admin key
// Provider is mock (POST /v1/setup accepts it) so no model is ever called.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { BASE_URL, type CommandResult, waitForHealth } from "../e2e/_helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SK_BIN = path.join(REPO_ROOT, "dist/sk");
const COMPOSE_FILE = "docker-compose.test.yml";
const SERVICE = "engine";
const TEST_BOOTSTRAP_KEY = "b".repeat(64);

/**
 * Run a `docker compose -f docker-compose.test.yml …` subcommand.
 *
 * Calls spawnSync directly (NOT the shared `runCommand`) and INHERITS the
 * ambient env by default: passing an explicit `env: {...process.env}` to
 * spawnSync mis-parses the docker argv under `bun test` (a Bun quirk that
 * drops the `compose` subcommand → "unknown shorthand flag: 'f'"). An env
 * override is only attached when a caller actually needs one.
 */
export function compose(args: string[], extraEnv?: Record<string, string>): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Start the container (building only when no image exists), blocking until healthy. */
export async function composeUp(): Promise<void> {
  // CI and the documented compose:test:up command already build the exact
  // production image once before the tests start. Rebuilding from every test
  // file invalidates the COPY layer after the first file writes its log
  // artifact and can exhaust a hosted runner while reinstalling ONNX assets.
  // Plain `compose up` still builds automatically for a clean local checkout
  // where the declared image does not exist.
  const up = compose(["up", "-d", "--wait"]);
  if (up.status !== 0) {
    throw new Error(`compose up failed (${up.status}):\n${up.stdout}\n${up.stderr}`);
  }
  // `--wait` already gates on the healthcheck, but double-check over HTTP so
  // the harness owns the readiness contract uniformly with the e2e track.
  await waitForHealth();
}

/** `down -v` — remove containers plus external-service test volumes. Best-effort. */
export function composeDown(): void {
  compose(["down", "-v"]);
}

/** Replace only the stateless application container; PostgreSQL and object
 * storage stay online so the test proves they are the complete state of
 * record. */
export async function replaceEngineContainer(): Promise<void> {
  const replaced = compose(["up", "-d", "--force-recreate", "--no-deps", "--wait", SERVICE]);
  if (replaced.status !== 0) {
    throw new Error(
      `engine replacement failed (${replaced.status}):\n${replaced.stdout}\n${replaced.stderr}`,
    );
  }
  await waitForHealth();
}

export function engineMounts(): Array<{ Destination?: string; Type?: string }> {
  const id = compose(["ps", "-q", SERVICE]).stdout.trim();
  if (!id) throw new Error("engine container id is unavailable");
  const inspected = spawnSync("docker", ["inspect", "--format", "{{json .Mounts}}", id], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (inspected.status !== 0) {
    throw new Error(`docker inspect failed: ${inspected.stderr ?? "unknown error"}`);
  }
  return JSON.parse(inspected.stdout || "[]") as Array<{
    Destination?: string;
    Type?: string;
  }>;
}

/** Dump the engine container's (ndjson) logs to a file for CI artifacts. */
export function collectContainerLogs(dest: string): void {
  const logs = compose(["logs", "--no-color", SERVICE]);
  Bun.write(dest, `${logs.stdout}\n${logs.stderr}`);
}

export interface BootstrapResult {
  adminKey: string;
  tenantId: string;
  tenantSlug: string;
}

/** Parse a `wf_live_…` plaintext key out of an issue-admin-key banner. */
function parseIssuedKey(text: string): string | null {
  return text.match(/wf_live_[A-Za-z0-9_-]+/)?.[0] ?? null;
}

/**
 * Materialise an admin key. The genuine first-run flow is POST /v1/bootstrap/complete
 * (token redemption); that route is one-time, so on a second boot (or a
 * second test file sharing the container) it returns 410 Gone — we then
 * mint a fresh key via the operator `engine --issue-admin-key` path, which
 * needs the tenant to already exist. tenant_name "default" derives slug
 * "default", matching issue-admin-key's default tenant. Honors
 * SUBKIT_DOCKER_API_KEY for callers that already hold a key.
 */
export async function bootstrapAdminKey(): Promise<BootstrapResult> {
  const provided = process.env.SUBKIT_DOCKER_API_KEY;
  if (provided) return { adminKey: provided, tenantId: "", tenantSlug: "default" };

  const status = await fetch(`${BASE_URL}/v1/bootstrap/status`).then(
    (r) => r.json() as Promise<{ pending: boolean }>,
  );

  if (status.pending) {
    const res = await fetch(`${BASE_URL}/v1/bootstrap/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TEST_BOOTSTRAP_KEY,
        admin_email: "admin@docker-e2e.local",
        tenant_name: "default",
        llm_provider: "mock",
        llm_api_key: "mock",
      }),
    });
    if (res.status === 200) {
      const body = (await res.json()) as { api_key: string; tenant_id: string };
      return {
        adminKey: body.api_key,
        tenantId: body.tenant_id,
        tenantSlug: "default",
      };
    }
    if (res.status !== 410) {
      throw new Error(`POST /v1/bootstrap/complete failed: ${res.status} ${await res.text()}`);
    }
    // 410 Gone — fall through to the operator key-issuance path.
  }

  // Already bootstrapped: mint a fresh admin key the operator way.
  const issued = issueAdminKeyViaExec("default");
  const key = parseIssuedKey(`${issued.stdout}\n${issued.stderr}`);
  if (!key) {
    throw new Error(`issue-admin-key produced no key:\n${issued.stdout}\n${issued.stderr}`);
  }
  return { adminKey: key, tenantId: "", tenantSlug: "default" };
}

export interface DockerEnv {
  baseUrl: string;
  adminKey: string;
  tenantId: string;
  tenantSlug: string;
}

/** Full boot: container up + healthy + bootstrapped admin key. */
export async function dockerBoot(): Promise<DockerEnv> {
  await composeUp();
  const boot = await bootstrapAdminKey();
  return { baseUrl: BASE_URL, ...boot };
}

export interface SkResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Invoke the host-built `sk` binary against the container, mirroring the
 * env contract of the in-process `cli()` helper so the same invocations work
 * on both tracks.
 */
export async function skDocker(
  env: DockerEnv,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<SkResult> {
  const home = path.join(REPO_ROOT, ".docker-sk-home");
  const proc = Bun.spawn([SK_BIN, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: env.baseUrl,
      SUBKIT_API_KEY: env.adminKey,
      HOME: home,
      XDG_CONFIG_HOME: home,
      CI: "1",
      NO_COLOR: "1",
      NO_UPDATE_CHECK: "1",
      SUBKIT_DETERMINISTIC_SEED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeout ?? 30_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

/**
 * HTTP helper for the Docker track: Bearer the admin key, parse JSON.
 * Mirrors the in-process `apiClient` shape but over the published port.
 */
export async function dockerApi<T = unknown>(
  env: DockerEnv,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${env.baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.adminKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = text ? (JSON.parse(text) as T) : (null as T);
  } catch {
    parsed = text as unknown as T;
  }
  return { status: res.status, body: parsed };
}

/** Issue an additional admin key via the operator `engine --issue-admin-key`
 *  path (exercises the documented "more keys later" command). */
export function issueAdminKeyViaExec(tenantSlug = "default"): CommandResult {
  return compose(["exec", "-T", SERVICE, "engine", "--issue-admin-key", "--tenant", tenantSlug]);
}
