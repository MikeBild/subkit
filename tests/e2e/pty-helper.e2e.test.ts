import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitFor } from "../../apps/engine/src/test-helpers/determinism/wait.ts";
import {
  buildExpectScript,
  EXPECT_BIN,
  type ExpectStep,
  ptyFailureDiagnostic,
  runPtyScenario,
  SKIP_PTY_WHEN_NO_EXPECT,
} from "./_helpers/pty.ts";

const scenarios: Array<{
  name: string;
  body: string;
  steps: ExpectStep[];
  expectedExit: number;
}> = [
  { name: "accepts a normal zero exit", body: "process.exit(0)", steps: [], expectedExit: 0 },
  { name: "refuses a nonzero exit", body: "process.exit(7)", steps: [], expectedExit: 1 },
  {
    name: "refuses a signal exit even when wait reports zero in its fourth field",
    body: 'process.kill(process.pid, "SIGTERM")',
    steps: [],
    expectedExit: 1,
  },
  {
    name: "bounds and cleans a content wait timeout",
    body: "await Bun.sleep(120000)",
    steps: [{ kind: "wait", pattern: "NEVER_MATCH" }],
    expectedExit: 1,
  },
  {
    name: "bounds and cleans an EOF timeout",
    body: "await Bun.sleep(120000)",
    steps: [],
    expectedExit: 1,
  },
  {
    name: "refuses EOF during an output drain",
    body: "process.exit(0)",
    steps: [
      { kind: "wait", pattern: "READY" },
      { kind: "sleep", ms: 100 },
    ],
    expectedExit: 1,
  },
  {
    name: "bounds and cleans missing raw terminal readiness",
    body: "await Bun.sleep(120000)",
    steps: [{ kind: "ready" }],
    expectedExit: 1,
  },
  {
    name: "refuses closed standard streams while the child stays alive",
    body: 'process.on("SIGHUP", () => {}); closeSync(0); closeSync(1); closeSync(2); await Bun.sleep(120000)',
    steps: [{ kind: "wait", pattern: "READY" }],
    expectedExit: 1,
  },
];

function childFixture(body: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "sk-pty-child-"));
  chmodSync(directory, 0o700);
  const binary = path.join(directory, "child.ts");
  const pidFile = path.join(directory, "child.pid");
  writeFileSync(
    binary,
    `#!/usr/bin/env bun\nimport {writeFileSync,closeSync} from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)},String(process.pid));\nprocess.on("SIGHUP", () => {});\nprocess.stdout.write("READY\\n");\nawait Bun.sleep(100);\n${body};\n`,
    { mode: 0o700 },
  );
  return {
    binary,
    directory,
    pid: () => Number(readFileSync(pidFile, "utf8")),
    cleanup: () => {
      try {
        const pid = Number(readFileSync(pidFile, "utf8"));
        const observed = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
        if (observed.stdout.includes(binary)) process.kill(pid, "SIGKILL");
      } catch {}
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let settled: { value: T } | { error: unknown } | undefined;
  void pending.then(
    (value) => {
      settled = { value };
    },
    (error: unknown) => {
      settled = { error };
    },
  );
  const outcome = await waitFor(() => settled, {
    tries: 270,
    sleepMs: 100,
    label: "Owned PTY helper bounded deadline",
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

for (const scenario of scenarios) {
  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    scenario.name,
    async () => {
      const child = childFixture(scenario.body);
      try {
        const result = await bounded(
          runPtyScenario(scenario.steps, { binary: child.binary, cwd: child.directory }),
        );
        expect(result.exitCode).toBe(scenario.expectedExit);
        expect(() => process.kill(child.pid(), 0)).toThrow();
      } finally {
        child.cleanup();
      }
    },
    30000,
  );
}

test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
  "fails closed when terminal setup cannot invoke stty and keeps a bounded safe diagnostic",
  async () => {
    const after = childFixture("await Bun.sleep(120000)");
    let afterRunner: ReturnType<typeof spawnExpect> | undefined;
    const interceptStty = [
      "rename exec realExec",
      "proc exec {args} {",
      '  if {[lindex $args 0] eq "stty"} {',
      '    puts stderr "__PTY_CHILD_PID__ [exp_pid]"',
      '    error "forced stty failure"',
      "  }",
      "  uplevel 1 [list realExec {*}$args]",
      "}",
    ].join("\n");
    try {
      const script = buildExpectScript([], { binary: after.binary });
      afterRunner = spawnExpect(`${interceptStty}\n${script}`, after.directory);
      const [exitCode, stderr] = await bounded(
        Promise.all([afterRunner.exited, new Response(afterRunner.stderr).text()]),
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("PTY setup failed");
      const pid = Number(/__PTY_CHILD_PID__ (\d+)/.exec(stderr)?.[1]);
      expect(Number.isSafeInteger(pid)).toBe(true);
      const diagnostic = ptyFailureDiagnostic({
        exitCode,
        stderr: `${stderr}\nauthorization: Bearer top-secret\n{"token":"quoted-secret","api_key":"also-secret"}`,
        visible: "x".repeat(5_000),
      });
      expect(diagnostic).toContain("PTY setup failed");
      expect(diagnostic).toContain("***REDACTED***");
      expect(diagnostic).not.toContain("top-secret");
      expect(diagnostic).not.toContain("quoted-secret");
      expect(diagnostic).not.toContain("also-secret");
      expect(diagnostic).toContain("[PTY diagnostic truncated]");
      expect(diagnostic.length).toBeLessThan(8_300);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      after.cleanup();
      if (afterRunner?.exitCode === null) afterRunner.kill("SIGKILL");
      if (afterRunner) await afterRunner.exited;
    }
  },
  30_000,
);

function spawnExpect(script: string, cwd: string) {
  if (!EXPECT_BIN) throw new Error("missing expect command");
  return Bun.spawn([EXPECT_BIN, "-c", script], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
  "forwards individually quoted command arguments to the PTY child",
  async () => {
    const child = childFixture(
      'if (process.argv[2] !== "argument with spaces" || process.argv[3] !== "literal $[value]") process.exit(9)',
    );
    try {
      const result = await bounded(
        runPtyScenario([], {
          binary: child.binary,
          args: ["argument with spaces", "literal $[value]"],
          cwd: child.directory,
        }),
      );
      expect(result.exitCode).toBe(0);
    } finally {
      child.cleanup();
    }
  },
  30000,
);

test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
  "bounds authoritative wait after a terminal closes with its child alive",
  async () => {
    if (!EXPECT_BIN) throw new Error("missing expect command");
    const child = childFixture('process.on("SIGHUP", () => {}); await Bun.sleep(120000)');
    let runner: ReturnType<typeof spawnExpect> | undefined;
    try {
      const script = buildExpectScript([{ kind: "wait", pattern: "READY" }], {
        binary: child.binary,
      });
      const terminalClose = 'expect {\n eof {}\n timeout { error "CLI EOF timeout" }\n }';
      expect(script).toContain(terminalClose);
      runner = spawnExpect(script.replace(terminalClose, "close"), child.directory);
      const [exit, stderr] = await bounded(
        Promise.all([runner.exited, new Response(runner.stderr).text()]),
      );
      expect(exit).toBe(1);
      expect(stderr).toContain("CLI did not exit after EOF");
      expect(() => process.kill(child.pid(), 0)).toThrow();
    } finally {
      child.cleanup();
      if (runner?.exitCode === null) runner.kill("SIGKILL");
      if (runner) await runner.exited;
    }
  },
  30000,
);
