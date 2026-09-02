#!/usr/bin/env bun
// One command from nothing to a green execution.
//
// `bun run start:local` starts the Compose stack, completes first-run setup
// without asking a single question, runs one of the seeded starter workflows,
// and prints the Cockpit URL. It is the zero-config path a newcomer follows;
// `docker compose up -d` plus the interactive wizard remains the explicit path
// for an operator who wants to make each choice themselves.
//
// Why it exists: a baseline run on 2026-09-02, from a fresh machine with no
// repository access, needed 31 steps and about 40 minutes to reach a first
// execution. Three of the detours are removed here — setup no longer prompts
// when it was told not to, the bootstrap key no longer has to be scraped out of
// the container logs, and the fresh tenant is no longer empty.
//
// Idempotent. A second run reuses the existing .env, skips setup that is
// already complete, and runs the demo workflow again.
//
// Flags:
//   --skip-run   provision only; do not execute the demo workflow
//   --quiet      only print the final summary

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(ROOT, ".env");
// Exported so a contract test can hold them against docker-compose.yml and the
// seeded starter workflows without executing this script.
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

/** Read one assignment out of .env without printing the value anywhere. */
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

/**
 * The engine mints a one-time bootstrap token at first boot and prints it in a
 * banner. Scripting against a log banner is brittle, so pin the value up front:
 * SUBKIT_BOOTSTRAP_KEY makes the engine adopt this token instead of generating
 * one. Written once and reused, so a second run finds the same key.
 */
function ensureBootstrapKey(): string {
  const existing = envValue("SUBKIT_BOOTSTRAP_KEY");
  if (existing.length >= 64) return existing;
  const key = randomBytes(32).toString("hex");
  appendFileSync(
    ENV_FILE,
    `\n# Fixed first-run bootstrap token, written by scripts/start-local.ts so setup\n` +
      `# does not have to be scraped out of the engine's startup banner. It is\n` +
      `# invalid the moment setup completes.\nSUBKIT_BOOTSTRAP_KEY=${key}\n`,
  );
  say("  wrote a fixed SUBKIT_BOOTSTRAP_KEY into .env");
  return key;
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

  // ensure-env.sh creates .env from .env.example with a generated MASTER_KEY
  // and stamps the version; compose:up calls it. Call it first so the
  // bootstrap key can be appended to a file that already exists.
  say("→ preparing .env");
  if (run("sh", ["scripts/ensure-env.sh"], { capture: true }).status !== 0) {
    fail("scripts/ensure-env.sh failed");
  }
  const bootstrapKey = ensureBootstrapKey();
  const port = envValue("SUBKIT_HOST_PORT") || DEFAULT_HOST_PORT;

  say("→ starting the stack (engine, PostgreSQL, object storage)");
  if (run("docker", ["compose", "up", "-d"]).status !== 0) fail("docker compose up failed");

  say("→ waiting for the engine to report ready");
  await waitForReady(port);

  say("→ completing first-run setup");
  const init = composeExec(
    ["sk", "init", "--defaults", "--token", bootstrapKey, "--engine-url", "http://127.0.0.1:3000"],
    { capture: true },
  );
  const initOutput = `${init.stdout ?? ""}${init.stderr ?? ""}`;
  const alreadyDone = /already been bootstrapped|already_completed/.test(initOutput);
  if (init.status !== 0 && !alreadyDone) {
    process.stderr.write(initOutput);
    fail("sk init failed");
  }
  say(alreadyDone ? "  already bootstrapped — reusing the existing tenant" : "  tenant ready");

  if (!SKIP_RUN) {
    say(`→ running the seeded starter workflow '${DEMO_WORKFLOW}'`);
    const exec = composeExec(["sk", "workflows", "run", DEMO_WORKFLOW, "--follow"], {
      capture: true,
    });
    if (exec.status !== 0) {
      process.stderr.write(`${exec.stdout ?? ""}${exec.stderr ?? ""}`);
      fail(
        `the starter workflow did not run. List what the tenant has:\n` +
          `  docker compose exec ${COMPOSE_SERVICE} sk workflows list`,
      );
    }
    say("  execution succeeded");
  }

  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(
    `\nSubKit is running.\n\n` +
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
