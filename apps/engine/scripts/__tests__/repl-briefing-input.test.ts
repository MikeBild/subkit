import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the briefing PTY scenario submits lines without waiting for terminal echo", () => {
  const source = readFileSync(
    new URL("../../../../tests/e2e/repl-agent-briefing.e2e.test.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain('kind: "wait", pattern: text');
  expect(source).toContain('sendLine("Please summarize what SubKit can help with.")');
  expect(source).toContain('kind: "wait-file"');
});
