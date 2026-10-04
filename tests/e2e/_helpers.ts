import { spawnSync } from "node:child_process";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const BASE_URL = process.env.SUBKIT_DOCKER_BASE_URL ?? "http://127.0.0.1:3000";

export function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

export function ok(message: string): void {
  console.log(`✓ ${message}`);
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): CommandResult {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export interface HealthResponse {
  status: "ok";
  service: "subkit";
  version: string;
}

export async function waitForHealth(timeoutMs = 120_000): Promise<HealthResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        const body = (await response.json()) as HealthResponse;
        const readyResponse = await fetch(`${BASE_URL}/ready`);
        const ready = (await readyResponse.json()) as {
          status?: string;
          checks?: { database?: string };
        };
        if (
          body.status === "ok" &&
          readyResponse.ok &&
          ready.status === "ready" &&
          ready.checks?.database === "pass"
        ) {
          return body;
        }
      }
    } catch {}
    await Bun.sleep(2_000);
  }
  fail(`engine at ${BASE_URL} did not become healthy within ${timeoutMs}ms`);
}

export function readDevApiKey(): string {
  const provided = process.env.SUBKIT_DOCKER_API_KEY;
  if (provided) return provided;
  const result = runCommand("docker", ["compose", "logs", "engine"]);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    fail(`failed to read engine logs:\n${combined}`);
  }
  const match = combined.match(/wf_live_[A-Za-z0-9_-]+/);
  if (!match) {
    fail(
      `engine logs did not contain a dev admin key — make sure NODE_ENV != production for this run.\n${combined}`,
    );
  }
  return match[0];
}
