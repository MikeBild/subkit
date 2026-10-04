import { existsSync } from "node:fs";
import path from "node:path";
import type { E2EEnv } from "../setup.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
export const SK_BIN = path.join(REPO_ROOT, "dist/sk");
export const EXPECT_BIN = Bun.which("expect");

export const HAS_SK_BIN = existsSync(SK_BIN);

export const SKIP_PTY_WHEN_NO_EXPECT = !EXPECT_BIN && !process.env.CI;

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
  env?: Record<string, string>;
  binary?: string;
  persona?: E2EEnv["personas"]["admin"];
  engineUrl?: string;
  cwd?: string;
}

export interface RunPtyResult {
  visible: string;
  stderr: string;
  exitCode: number;
}

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
