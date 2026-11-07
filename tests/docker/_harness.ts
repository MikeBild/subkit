import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import { BASE_URL, type CommandResult, waitForHealth } from "../e2e/_helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SK_BIN = path.join(REPO_ROOT, "dist/sk");
const COMPOSE_FILE = "docker-compose.test.yml";
const SERVICE = "engine";
const TEST_BOOTSTRAP_KEY = "b".repeat(64);
const DOCKER_ENV = {
  ...process.env,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(userInfo().homedir, ".docker"),
};

export function compose(args: string[], extraEnv?: Record<string, string>): CommandResult {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...DOCKER_ENV, ...extraEnv },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function composeUp(): Promise<void> {
  const up = compose(["up", "-d", "--wait"]);
  if (up.status !== 0) {
    throw new Error(`compose up failed (${up.status}):\n${up.stdout}\n${up.stderr}`);
  }
  await waitForHealth();
}

export function composeDown(): void {
  compose(["down", "-v"]);
}

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
    env: DOCKER_ENV,
  });
  if (inspected.status !== 0) {
    throw new Error(`docker inspect failed: ${inspected.stderr ?? "unknown error"}`);
  }
  return JSON.parse(inspected.stdout || "[]") as Array<{
    Destination?: string;
    Type?: string;
  }>;
}

export function collectContainerLogs(dest: string): void {
  const logs = compose(["logs", "--no-color", SERVICE]);
  Bun.write(dest, `${logs.stdout}\n${logs.stderr}`);
}

export interface BootstrapResult {
  adminKey: string;
  tenantId: string;
  tenantSlug: string;
}

function parseIssuedKey(text: string): string | null {
  return text.match(/wf_live_[A-Za-z0-9_-]+/)?.[0] ?? null;
}

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
  }

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

export function issueAdminKeyViaExec(tenantSlug = "default"): CommandResult {
  return compose(["exec", "-T", SERVICE, "engine", "--issue-admin-key", "--tenant", tenantSlug]);
}
