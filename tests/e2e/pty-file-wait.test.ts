import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExpectScript, EXPECT_BIN, SKIP_PTY_WHEN_NO_EXPECT } from "./_helpers/pty.ts";

test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
  "waits for each file completion before sending more input",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pty-file-wait-"));
    const file = path.join(directory, "events$[1].log");
    const binary = path.join(directory, "child.ts");
    writeFileSync(
      binary,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
process.stdin.setRawMode(true);
let count = 0;
process.stdin.on("data", (data) => {
  if (data.toString() !== ["a", "b", "q"][count++]) process.exit(7);
  if (count === 3) process.exit(0);
  appendFileSync(${JSON.stringify(file)}, '{"kind":"dialog.turn_end","input_kind":"prompt"}\\n');
  process.stdout.write("recorded\\n");
});
process.stdout.write("READY\\n");
`,
      { mode: 0o700 },
    );
    try {
      const script = buildExpectScript(
        [
          { kind: "wait", pattern: "READY" },
          { kind: "send", text: "a" },
          {
            kind: "wait-file",
            file,
            pattern: '"kind":"dialog.turn_end"[^\n]*"input_kind":"prompt"',
            count: 1,
          },
          { kind: "send", text: "b" },
          {
            kind: "wait-file",
            file,
            pattern: '"kind":"dialog.turn_end"[^\n]*"input_kind":"prompt"',
            count: 2,
          },
          { kind: "send", text: "q" },
        ],
        { binary },
      );
      const terminalStub = `rename exec nativeExec
proc exec {args} {
  if {[lindex $args 0] eq "stty"} {return ""}
  if {[lindex $args 0] eq "ps"} {return "Z"}
  return [uplevel 1 [list nativeExec {*}$args]]
}`;
      const child = Bun.spawn([EXPECT_BIN!, "-c", `${terminalStub}\n${script}`], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
