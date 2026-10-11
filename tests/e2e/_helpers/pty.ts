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

export type ExpectStep =
  | ExpectWaitStep
  | ExpectSendStep
  | ExpectSleepStep
  | { kind: "ready" }
  | { kind: "terminate" };

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
  opts: { binary?: string; args?: readonly string[] } = {},
): string {
  const bin = opts.binary ?? SK_BIN;
  const lines = [
    "set timeout 20",
    "match_max 100000",
    "log_user 1",
    `spawn -noecho ${[bin, ...(opts.args ?? [])].map(tclQuote).join(" ")}`,
    "exec stty rows 80 cols 120 < $spawn_out(slave,name)",
    "set childPid [exp_pid]",
    "set childReaped 0",
    "set scenarioCode [catch {",
    "proc drain {milliseconds} {",
    "  set deadline [expr {[clock milliseconds] + $milliseconds}]",
    "  while {[clock milliseconds] < $deadline} {",
    '    expect -timeout 1 {\n -re {.+} {}\n timeout {}\n eof { error "Unexpected EOF while draining" }\n }',
    "  }",
    "}",
  ];
  for (const step of steps) {
    if (step.kind === "ready") {
      lines.push("set deadline [expr {[clock milliseconds]+20000}]");
      lines.push("set ready 0");
      lines.push(
        'while {[clock milliseconds]<$deadline} { expect -timeout 1 {\n -re {.+} {}\n timeout {}\n eof {error "Unexpected EOF before TTY readiness"}\n }; set flags [exec stty -a < $spawn_out(slave,name)]; if {[string match "*-icanon*" $flags] && [regexp {(^|[[:space:]])-echo([[:space:]]|$)} $flags]} {set ready 1; break} }',
      );
      lines.push('if {!$ready} {error "TTY not ready"}');
      continue;
    }
    if (step.kind === "wait") {
      const label = step.label ?? step.pattern;
      lines.push("expect {");
      lines.push(`  -re ${tclRegex(step.pattern)} { puts ${tclQuote(`__MATCH__ ${label}`)} }`);
      lines.push(`  timeout { error ${tclQuote(`Timed out waiting for ${step.pattern}`)} }`);
      lines.push(`  eof { error ${tclQuote(`Process exited while waiting for ${step.pattern}`)} }`);
      lines.push("}");
      continue;
    }
    if (step.kind === "send") {
      lines.push(`send -- ${tclQuote(step.text)}`);
      continue;
    }
    if (step.kind === "terminate") {
      lines.push("exec kill -TERM $childPid");
      continue;
    }
    lines.push(`drain ${step.ms}`);
  }
  lines.push("set timeout 5");
  lines.push('expect {\n eof {}\n timeout { error "CLI EOF timeout" }\n }');
  lines.push("set exitDeadline [expr {[clock milliseconds] + 5000}]");
  lines.push("set childExited 0");
  lines.push("while {[clock milliseconds] < $exitDeadline} {");
  lines.push("  if {[catch {exec ps -p $childPid -o stat=} childState statusOptions]} {");
  lines.push("    set statusError [dict get $statusOptions -errorcode]");
  lines.push(
    '    if {[lindex $statusError 0] ne "CHILDSTATUS" || [lindex $statusError 2] != 1} {error "Cannot observe owned CLI process exit"}',
  );
  lines.push("    set childExited 1");
  lines.push("    break");
  lines.push("  }");
  lines.push("  if {[regexp {^[[:space:]]*Z} $childState]} {set childExited 1; break}");
  lines.push("  after 25");
  lines.push("}");
  lines.push('if {!$childExited} {error "CLI did not exit after EOF"}');
  lines.push("set outcome [wait]");
  lines.push("set childReaped 1");
  lines.push(
    steps.some((step) => step.kind === "terminate")
      ? 'if {[llength $outcome] < 6 || [lindex $outcome 4] ne "CHILDKILLED" || [lindex $outcome 5] ne "SIGTERM"} {error "CLI did not terminate cleanly after the scenario: $outcome"}'
      : 'if {[llength $outcome] != 4 || [lindex $outcome 2] != 0 || [lindex $outcome 3] != 0} {error "CLI did not exit normally with status zero: $outcome"}',
  );
  lines.push("} scenarioError]");
  lines.push(
    "if {$scenarioCode != 0} {puts stderr $scenarioError; if {!$childReaped} {catch {exec kill -KILL $childPid}; catch {close}; catch {wait}}; exit 1}",
  );
  lines.push("exit 0");
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
  args?: readonly string[];
  unsetEnv?: readonly string[];
}

export interface RunPtyResult {
  visible: string;
  raw: string;
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
  for (const key of opts.unsetEnv ?? []) delete baseEnv[key];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;

  const proc = Bun.spawn(
    [
      EXPECT_BIN,
      "-c",
      buildExpectScript(steps, {
        ...(opts.binary ? { binary: opts.binary } : {}),
        ...(opts.args ? { args: opts.args } : {}),
      }),
    ],
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
    raw: stdout,
    stderr: stripTerminal(stderr),
    exitCode: exitCode as number,
  };
}
