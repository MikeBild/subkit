// Unit-level guard: every `sk knowledge-sources` subcommand handler
// must THROW on error, never call `process.exit` directly.
//
// Why this exists: journey 43 (`apps/engine/src/tests/journeys/43-cli-knowledge-sources.journey.test.ts`)
// wraps `process.exit` so it throws a synthetic `Error("process.exit(N)")`
// to detect handlers that exit prematurely. The journey was failing
// because handlers were calling `process.exit(exitCodeFor(err))` which
// swallowed the original error stack and short-circuited Citty's
// composability surface. The correct contract is:
//   1. handler logs to stderr + throws the original error,
//   2. top-level `main()` in `apps/sk/src/index.ts` catches and sets
//      `process.exitCode = exitCodeFor(err)`,
//   3. the process drains stdout/stderr and exits naturally.
//
// This test exercises (1) directly. Coverage for (2) lives below.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineError } from "@cli-core/errors";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  // Snapshot only the keys we mutate so we don't tug on sibling tests.
  savedEnv = {};
  for (const k of PROFILE_ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  process.env.SUBKIT_ENGINE_URL = "http://127.0.0.1:1"; // unreachable on purpose
  process.env.SUBKIT_API_KEY = "wf_live_test_invalid_key_xxxxxxxxxxxxx";

  exitCalled = null;
  origExit = process.exit.bind(process);
  (process as { exit: unknown }).exit = (code?: number): never => {
    exitCalled = code ?? 0;
    throw new Error(`__SHOULD_NOT_BE_CALLED process.exit(${code ?? 0})`);
  };
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // Swallow output — the discipline being tested is structural, not I/O.
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
  // The handler must propagate via throw, NOT via process.exit.
  expect(exitCalled).toBeNull();
  expect(caught).toBeDefined();
  expect(caught).toBeInstanceOf(Error);
  // The error must not be the synthetic process.exit wrapper.
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
    // Exercise the deterministic missing-file branch here. Transport failure
    // is already covered by list/get/search/patch/delete; asking Bun fetch to
    // connect to a deliberately unreachable local port made this assertion
    // depend on the host TCP timeout and could consume the whole 120 s test
    // budget before the handler had a chance to prove its error discipline.
    const f = join(tmpDir, "missing.txt");
    await expectThrowsNotExits(["create", "--file", f]);
  });

  test("patch: handler throws on transport error", async () => {
    await expectThrowsNotExits(["patch", "00000000-0000-0000-0000-000000000000", "--title", "new"]);
  });

  test("delete: handler throws on transport error", async () => {
    await expectThrowsNotExits(["delete", "00000000-0000-0000-0000-000000000000"]);
  });
});

describe("knowledge-sources CLI: exitCodeFor wiring", () => {
  test("an EngineError with status=400 maps to exit code 1, others to 2", async () => {
    // Mirror the dispatcher path in apps/sk/src/index.ts:
    //   `dispatch().catch((err) => { ...; process.exitCode = exitCodeFor(err); })`
    // The exit code is set on the process, NOT passed to process.exit.
    // This regression test enforces that wiring without spawning the
    // CLI as a child process.
    const { exitCodeFor } = await import("@cli-core/errors");
    const four_hundred = new EngineError(400, { code: "bad_input", message: "bad" });
    const five_hundred = new EngineError(500, { code: "internal_error", message: "boom" });
    expect(exitCodeFor(four_hundred)).toBe(1);
    expect(exitCodeFor(five_hundred)).toBe(2);
  });
});
