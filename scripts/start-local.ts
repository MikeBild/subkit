#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gitConfigEmail,
  LOCAL_DEFAULT_ADMIN_EMAIL,
  LOCAL_DEFAULT_LLM_API_KEY,
  LOCAL_DEFAULT_LLM_PROVIDER,
  LOCAL_DEFAULT_TENANT_NAME,
} from "../apps/sk/src/commands/init.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(ROOT, ".env");
export const COMPOSE_SERVICE = "engine";
export const DEMO_WORKFLOW = "demo-httpbin-echo";
export const DEFAULT_HOST_PORT = "3000";
const READY_TIMEOUT_MS = 180_000;

const args = new Set(process.argv.slice(2));
const SKIP_RUN = args.has("--skip-run");
const QUIET = args.has("--quiet");

function say(line: string): void {
  if (!QUIET) process.stdout.write(`${line}\n`);
}

function fail(line: string): never {
  process.stderr.write(`start-local: ${line}\n`);
  process.exit(1);
}

function run(cmd: string, argv: string[], opts: { capture?: boolean } = {}) {
  return spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.capture ? "pipe" : ["ignore", "inherit", "inherit"],
  });
}

function envValue(name: string): string {
  if (!existsSync(ENV_FILE)) return "";
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
  }
  return "";
}

function requireDocker(): void {
  if (run("docker", ["info"], { capture: true }).status !== 0) {
    fail("Docker is required and is not responding — start Docker Desktop or the daemon");
  }
}

function newBootstrapKey(): string {
  return randomBytes(32).toString("hex");
}

async function waitForReady(port: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/ready`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "unreachable";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail(
    `the engine did not become ready within ${READY_TIMEOUT_MS / 1000}s (last: ${lastError}).\n` +
      `  Look at what it is saying: docker compose logs ${COMPOSE_SERVICE}`,
  );
}

function composeExec(argv: string[], opts: { capture?: boolean } = {}) {
  return run("docker", ["compose", "exec", "-T", COMPOSE_SERVICE, ...argv], opts);
}

async function main(): Promise<void> {
  requireDocker();

  say("→ preparing .env");
  if (run("sh", ["scripts/ensure-env.sh"], { capture: true }).status !== 0) {
    fail("scripts/ensure-env.sh failed");
  }
  const bootstrapKey = newBootstrapKey();
  const port = envValue("SUBKIT_HOST_PORT") || DEFAULT_HOST_PORT;

  say("→ starting the stack (engine, PostgreSQL, object storage)");
  const up = spawnSync("docker", ["compose", "up", "-d"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, SUBKIT_BOOTSTRAP_KEY: bootstrapKey },
  });
  if (up.status !== 0) fail("docker compose up failed");

  say("→ waiting for the engine to report ready");
  await waitForReady(port);

  say("→ completing first-run setup");
  const init = composeExec(
    [
      "sk",
      "init",
      "--token",
      bootstrapKey,
      "--engine-url",
      "http://127.0.0.1:3000",
      "--admin-email",
      gitConfigEmail() ?? LOCAL_DEFAULT_ADMIN_EMAIL,
      "--tenant-name",
      LOCAL_DEFAULT_TENANT_NAME,
      "--llm-provider",
      LOCAL_DEFAULT_LLM_PROVIDER,
      "--llm-api-key",
      LOCAL_DEFAULT_LLM_API_KEY,
    ],
    { capture: true },
  );
  const initOutput = `${init.stdout ?? ""}${init.stderr ?? ""}`;
  const alreadyDone = /already been bootstrapped|already_completed/.test(initOutput);
  if (init.status !== 0 && !alreadyDone) {
    process.stderr.write(initOutput);
    fail("sk init failed");
  }
  if (!QUIET && initOutput.trim().length > 0) {
    process.stdout.write(
      initOutput
        .trimEnd()
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n") + "\n",
    );
  }
  say(alreadyDone ? "  already bootstrapped — reusing the existing tenant" : "  tenant ready");

  let ranDemo = false;
  if (!SKIP_RUN) {
    say(`→ running the seeded starter workflow '${DEMO_WORKFLOW}'`);
    const exec = composeExec(["sk", "workflows", "run", DEMO_WORKFLOW, "--follow"], {
      capture: true,
    });
    const execOutput = `${exec.stdout ?? ""}${exec.stderr ?? ""}`;
    if (exec.status === 0) {
      ranDemo = true;
      say("  execution succeeded");
    } else if (/no workflow found/i.test(execOutput)) {
      say(
        `  this engine image has no starter workflows yet — the tenant is empty.\n` +
          `  Everything else is up; author one, or pull a newer image.`,
      );
    } else {
      process.stderr.write(execOutput);
      fail(
        `the starter workflow did not run. List what the tenant has:\n` +
          `  docker compose exec ${COMPOSE_SERVICE} sk workflows list`,
      );
    }
  }

  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(
    `\n${ranDemo ? "SubKit is running and has executed a workflow." : "SubKit is running."}\n\n` +
      `  Cockpit          ${base}/\n` +
      `  API reference    ${base}/docs\n` +
      `  Machine-readable ${base}/llms.txt\n\n` +
      `  Run it again     docker compose exec ${COMPOSE_SERVICE} sk workflows run ${DEMO_WORKFLOW} --follow\n` +
      `  See what ran     docker compose exec ${COMPOSE_SERVICE} sk executions list --limit 5\n` +
      `  Open the CLI     docker compose exec -it ${COMPOSE_SERVICE} sk\n` +
      `  Stop everything  docker compose down\n\n` +
      `The LLM provider is 'mock', so nothing leaves this machine and the\n` +
      `conversational authoring loop stays inert. Point it at a real provider with:\n` +
      `  docker compose exec ${COMPOSE_SERVICE} sk settings set llm.provider '"anthropic"'\n` +
      `  docker compose exec ${COMPOSE_SERVICE} sk settings set llm.providers.anthropic.api_key '"sk-ant-..."'\n`,
  );
}

if (import.meta.main) await main();
