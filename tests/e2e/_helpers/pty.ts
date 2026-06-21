// Shared PTY harness for e2e tests.
//
// Extracted from tests/e2e/sk-interactive-smoke.e2e.test.ts so every
// scripted PTY scenario uses the same TCL `expect` builder, ANSI
// stripper, and process spawn settings. Tests pass an array of
// {wait, send, sleep} steps; the harness drives the binary, captures
// stdout, and returns the stripped text.

import { existsSync } from "node:fs";
import path from "node:path";
import type { E2EEnv } from "../setup.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
export const SK_BIN = path.join(REPO_ROOT, "dist/sk");
export const EXPECT_BIN = Bun.which("expect");

/** True when the compiled `dist/sk` binary exists — PTY scenarios spawn it. */
export const HAS_SK_BIN = existsSync(SK_BIN);

/**
 * Expect-only skip predicate — single source of truth.
 *
 * Skip a PTY scenario ONLY when `expect` is absent AND we're NOT in CI.
 * Locally this keeps the suite developer-friendly (no hard dependency on the
 * TCL `expect` tool). In CI (`CI` is set on every runner) a missing `expect`
 * must NOT silently drop coverage: the test runs and `runPtyScenario` throws
 * a clear "missing expect" error, so a runner-image or toolchain change that
 * removes `expect` becomes a LOUD failure instead of an invisible skip.
 *
 * Evaluated at module-init (env is set before `bun test` spawns) — do not
 * toggle `CI` mid-run. Use for PTY-only suites where a missing binary should
 * itself be loud (the throw covers it).
 */
export const SKIP_PTY_WHEN_NO_EXPECT = !EXPECT_BIN && !process.env.CI;

/**
 * Combined predicate for PTY suites that ALSO gate on the compiled binary
 * (sk-overhaul-matrix / sk-overhaul-cold-start, which run without booting the
 * engine in some tests). Skips when the binary is absent — a developer
 * convenience for runs that skipped `build:sk` (a missing binary in CI is
 * caught loudly by the non-PTY e2e tests that spawn it) — OR when the
 * expect-only predicate above fires (CI-loud).
 *
 * Import this; NEVER re-derive `!HAS_BINARY || !HAS_EXPECT` inline. Drift
 * across files is exactly the gap these exports close.
 */
export const SKIP_PTY = !HAS_SK_BIN || SKIP_PTY_WHEN_NO_EXPECT;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_ESCAPE_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_SINGLE_RE = new RegExp(`${ESC}[@-_]`, "g");
const BELL_RE = new RegExp(BEL, "g");

export interface ExpectWaitStep {
  kind: "wait";
  pattern: string;
  label?: string;
}

export interface ExpectSendStep {
  kind: "send";
  text: string;
}

export interface ExpectSleepStep {
  kind: "sleep";
  ms: number;
}

export type ExpectStep = ExpectWaitStep | ExpectSendStep | ExpectSleepStep;

function tclQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")}"`;
}

function tclRegex(value: string): string {
  return `{${value.replace(/\}/g, "\\}")}}`;
}

export function buildExpectScript(
  steps: readonly ExpectStep[],
  opts: { binary?: string } = {},
): string {
  const bin = opts.binary ?? SK_BIN;
  const lines = [
    "set timeout 20",
    "match_max 100000",
    "log_user 1",
    // expect's `spawn` does not accept `--` as an end-of-flags
    // sentinel — it errors with "bad flag --". The error is
    // non-fatal so the script silently continues, the spawn never
    // happens, and any later assertions pass vacuously on empty
    // captured output. Quoting the path is sufficient for paths
    // with whitespace.
    `spawn -noecho ${tclQuote(bin)}`,
  ];
  for (const step of steps) {
    if (step.kind === "wait") {
      const label = step.label ?? step.pattern;
      lines.push("expect {");
      lines.push(`  -re ${tclRegex(step.pattern)} { puts ${tclQuote(`__MATCH__ ${label}`)} }`);
      lines.push(
        `  timeout { puts stderr ${tclQuote(`Timed out waiting for ${step.pattern}`)}; exit 1 }`,
      );
      lines.push(
        `  eof { puts stderr ${tclQuote(`Process exited while waiting for ${step.pattern}`)}; exit 1 }`,
      );
      lines.push("}");
      continue;
    }
    if (step.kind === "send") {
      lines.push(`send -- ${tclQuote(step.text)}`);
      continue;
    }
    lines.push(`after ${step.ms}`);
  }
  // Bounded teardown. Once every wait/send step has run the scenario's
  // assertions are already satisfied. The Ink REPL under a PTY frequently
  // keeps stdin open and never emits EOF, so a bare `expect eof` hangs the
  // full 20s `set timeout` — wasting ~20s on EVERY scenario AND colliding
  // with tests whose bun-test timeout is 20s (they get SIGKILL'd mid-
  // teardown and fail at ~20001ms, which is exactly how the sk-overhaul PTY
  // suites broke once CI gained `expect`). Give the process a short grace to
  // exit, then let the script end (exit 0) regardless: expect reaps the
  // spawned process on exit, so the eof vs timeout race never changes the
  // exit code the assertions check.
  lines.push("set timeout 5");
  lines.push("expect { eof {} timeout {} }");
  return lines.join("\n");
}

export function stripTerminal(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, "")
    .replace(ANSI_SINGLE_RE, "")
    .replace(/\r/g, "")
    .replace(BELL_RE, "");
}

export interface RunPtyOptions {
  /** Per-test overrides forwarded to the spawned process env. */
  env?: Record<string, string>;
  /** Override the binary path (defaults to dist/sk). */
  binary?: string;
  /** Persona used to derive the env (HOME + SUBKIT_*). Required when
   *  invoking the running engine. */
  persona?: E2EEnv["personas"]["admin"];
  /** Engine baseUrl override. Falls back to env.baseUrl when persona is set. */
  engineUrl?: string;
  /** Working directory. Defaults to the repo root. */
  cwd?: string;
}

export interface RunPtyResult {
  visible: string;
  stderr: string;
  exitCode: number;
}

/**
 * Drive the binary with a TCL expect script and return the captured
 * (ANSI-stripped) stdout.
 */
export async function runPtyScenario(
  steps: readonly ExpectStep[],
  opts: RunPtyOptions = {},
): Promise<RunPtyResult> {
  if (!EXPECT_BIN) throw new Error("missing `expect` command for PTY smoke test");
  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
    CI: "1",
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    SK_ALT_SCREEN: "never",
  };
  if (opts.persona) {
    baseEnv.SUBKIT_API_KEY = opts.persona.apiKey;
    baseEnv.SUBKIT_TENANT = opts.persona.tenantId;
    baseEnv.HOME = opts.persona.homeDir;
    baseEnv.XDG_CONFIG_HOME = opts.persona.homeDir;
  }
  if (opts.engineUrl) baseEnv.SUBKIT_ENGINE_URL = opts.engineUrl;
  if (opts.env) Object.assign(baseEnv, opts.env);
  // Filter out undefined keys to satisfy Bun.spawn's env type.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;

  const proc = Bun.spawn(
    [EXPECT_BIN, "-c", buildExpectScript(steps, opts.binary ? { binary: opts.binary } : {})],
    {
      cwd: opts.cwd ?? REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    visible: stripTerminal(stdout),
    stderr: stripTerminal(stderr),
    exitCode: exitCode as number,
  };
}
