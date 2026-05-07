// Shared PTY harness for e2e tests.
//
// Extracted from tests/e2e/sk-interactive-smoke.e2e.test.ts so every
// scripted PTY scenario uses the same TCL `expect` builder, ANSI
// stripper, and process spawn settings. Tests pass an array of
// {wait, send, sleep} steps; the harness drives the binary, captures
// stdout, and returns the stripped text.

import path from "node:path";
import type { E2EEnv } from "../setup.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
export const SK_BIN = path.join(REPO_ROOT, "dist/sk");
export const EXPECT_BIN = Bun.which("expect");

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
    `spawn -noecho -- ${tclQuote(bin)}`,
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
  lines.push("expect eof");
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
