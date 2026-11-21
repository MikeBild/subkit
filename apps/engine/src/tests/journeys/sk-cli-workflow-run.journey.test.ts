import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type defineCommand, runCommand } from "citty";
import { executionsCommand } from "../../../../sk/src/commands/executions.ts";
import { profileCommand } from "../../../../sk/src/commands/profile.ts";
import { workflowsCommand } from "../../../../sk/src/commands/workflows.ts";
import { loadConfig } from "../../../../sk/src/config.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

interface Captured {
  stdout: string;
  stderr: string;
  exit: number | null;
}

let ctx: JourneyCtx;
let echo: Server;
let dir = "";
let workflowId = "";
let executionId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("core-sk-cli", {
    envOverrides: {
      SUBKIT_ENGINE_URL: undefined,
      SUBKIT_API_KEY: undefined,
      SUBKIT_TENANT: undefined,
      SK_PROFILE: undefined,
      SUBKIT_PROFILE: undefined,
    },
  });
  echo = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ city: "Leipzig", path: req.url }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  dir = mkdtempSync(path.join(tmpdir(), "core-sk-cli-"));
  writeFileSync(
    path.join(dir, "weather.json"),
    JSON.stringify({
      name: "City weather",
      slug: "city-weather",
      steps: [{ kind: "request", id: "fetch", method: "GET", url: `${base}/weather` }],
    }),
  );
  writeFileSync(
    path.join(dir, "broken.json"),
    JSON.stringify({ name: "Broken", slug: "broken", steps: [{ kind: "request", id: "fetch" }] }),
  );
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function sk(command: ReturnType<typeof defineCommand>, argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);
  const text = (chunk: string | Uint8Array) =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(text(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(text(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exit: number | null = null;
  (process as { exit: unknown }).exit = (code?: number) => {
    exit = code ?? 0;
    throw new Error(`process.exit(${exit})`);
  };
  try {
    await runCommand(command, { rawArgs: argv });
  } catch (e) {
    if (exit === null) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  return { stdout: out.join(""), stderr: err.join(""), exit };
}

function isLogLine(line: string): boolean {
  if (!line.startsWith('{"ts":')) return false;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return typeof parsed.level === "string" && typeof parsed.module === "string";
  } catch {
    return false;
  }
}

function lastJson(stdout: string): Record<string, unknown> {
  const printed = stdout
    .split("\n")
    .filter((line) => !isLogLine(line.trim()))
    .join("\n");
  const start = printed.indexOf("{");
  const end = printed.lastIndexOf("}");
  return JSON.parse(printed.slice(start, end + 1)) as Record<string, unknown>;
}

describe("a person signs the sk CLI in with a key and runs a workflow from a file", () => {
  test("the key is saved as a profile and becomes the active one", async () => {
    await sk(profileCommand, [
      "add",
      "--name",
      "journey",
      "--engine-url",
      ctx.baseUrl,
      "--api-key",
      ctx.apiKey,
    ]);
    await sk(profileCommand, ["use", "journey"]);
    const cfg = loadConfig();
    expect(cfg.active_profile).toBe("journey");
    expect(cfg.profiles.journey?.engine_url).toBe(ctx.baseUrl);
    expect(cfg.profiles.journey?.api_key).toBe(ctx.apiKey);
  });

  test("validate refuses a broken file with the field path and passes the good one", async () => {
    const broken = await sk(workflowsCommand, ["validate", path.join(dir, "broken.json")]);
    expect(broken.exit).toBe(1);
    expect(broken.stderr).toContain("invalid");
    const good = await sk(workflowsCommand, ["validate", path.join(dir, "weather.json")]);
    expect(good.exit).toBeNull();
    expect(good.stdout).toContain("validates cleanly");
  });

  test("create --json prints the saved workflow as JSON", async () => {
    const created = await sk(workflowsCommand, [
      "create",
      "--file",
      path.join(dir, "weather.json"),
      "--json",
    ]);
    expect(created.exit).toBeNull();
    const body = lastJson(created.stdout);
    expect(body).toMatchObject({ name: "City weather", slug: "city-weather" });
    workflowId = body.id as string;
    const stored = await journeyFetch(ctx, `/v1/workflows/${workflowId}`);
    expect(stored.status).toBe(200);
  });

  test("run by slug prints the run result with its environment", async () => {
    const ran = await sk(workflowsCommand, ["run", "city-weather"]);
    expect(ran.exit).toBeNull();
    const body = lastJson(ran.stdout);
    expect(body).toMatchObject({
      status: "succeeded",
      environment: "dev",
      output: { city: "Leipzig", path: "/weather" },
    });
    executionId = body.execution_id as string;
    expect(executionId).toBeTruthy();
  });

  test("executions get --json shows the run as succeeded and started from the CLI", async () => {
    const got = await sk(executionsCommand, ["get", executionId, "--json"]);
    expect(got.exit).toBeNull();
    const body = lastJson(got.stdout);
    expect(body).toMatchObject({
      id: executionId,
      workflow_id: workflowId,
      status: "succeeded",
      request_source: "cli",
    });
    expect((body.outcome as { kind: string }).kind).toBe("succeeded");
    expect((body.caller as { principal_id: string }).principal_id).toBe(ctx.userId);
  });
});
