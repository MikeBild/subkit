import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError } from "@cli-core/errors";
import { runCommand } from "citty";
import { knowledgeSourcesCommand } from "../../commands/knowledge-sources.ts";

const PROFILE_ENV_KEYS = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"] as const;

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;
let exitCalled: number | null = null;
let origExit: typeof process.exit;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-ks-error-discipline-"));
  savedEnv = {};
  for (const k of PROFILE_ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  process.env.SUBKIT_ENGINE_URL = "http://127.0.0.1:1";
  process.env.SUBKIT_API_KEY = "wf_live_test_invalid_key_xxxxxxxxxxxxx";

  exitCalled = null;
  origExit = process.exit.bind(process);
  (process as { exit: unknown }).exit = (code?: number): never => {
    exitCalled = code ?? 0;
    throw new Error(`__SHOULD_NOT_BE_CALLED process.exit(${code ?? 0})`);
  };
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.exit = origExit;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  for (const k of PROFILE_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function expectThrowsNotExits(path: string[], extraArgs: string[] = []): Promise<unknown> {
  let caught: unknown;
  try {
    await runCommand(knowledgeSourcesCommand, { rawArgs: [...path, ...extraArgs] });
  } catch (err) {
    caught = err;
  }
  expect(exitCalled).toBeNull();
  expect(caught).toBeDefined();
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toContain("__SHOULD_NOT_BE_CALLED");
  return caught;
}

describe("knowledge-sources CLI: error-path discipline", () => {
  test("list: handler throws on transport error", async () => {
    await expectThrowsNotExits(["list"]);
  });

  test("get: handler throws on transport error", async () => {
    await expectThrowsNotExits(["get", "00000000-0000-0000-0000-000000000000"]);
  });

  test("search: handler throws on transport error", async () => {
    await expectThrowsNotExits(["search", "anything"]);
  });

  test("create: handler throws on missing-file or transport error", async () => {
    const f = join(tmpDir, "missing.txt");
    await expectThrowsNotExits(["create", "--file", f]);
  });

  test("patch: handler throws on transport error", async () => {
    await expectThrowsNotExits(["patch", "00000000-0000-0000-0000-000000000000", "--name", "new"]);
  });

  test("delete: handler throws on transport error", async () => {
    await expectThrowsNotExits(["delete", "00000000-0000-0000-0000-000000000000"]);
  });
});

describe("knowledge-sources CLI: exitCodeFor wiring", () => {
  test("an EngineError with status=400 maps to exit code 1, others to 2", async () => {
    const { exitCodeFor } = await import("@cli-core/errors");
    const four_hundred = new EngineError(400, { code: "bad_input", message: "bad" });
    const five_hundred = new EngineError(500, { code: "internal_error", message: "boom" });
    expect(exitCodeFor(four_hundred)).toBe(1);
    expect(exitCodeFor(five_hundred)).toBe(2);
  });
});
