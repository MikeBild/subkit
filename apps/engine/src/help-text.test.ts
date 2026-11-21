import { expect, test } from "bun:test";
import { engineHelp } from "./help-text.ts";
import { PREFLIGHT_HELP } from "./preflight/index.ts";

test("engine help keeps the bootstrap and security-sensitive CLI entrypoints reachable", () => {
  const help = engineHelp("9.9.9-test");
  expect(help).toStartWith("subkit engine 9.9.9-test\n");
  expect(help).toContain("--issue-admin-key");
  expect(help).toContain("--token-exchange");
  expect(help).toContain("--preflight");
  expect(help).toContain(PREFLIGHT_HELP);
});
