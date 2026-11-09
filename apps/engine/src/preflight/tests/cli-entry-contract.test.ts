import { expect, test } from "bun:test";
import { isPreflightInvocation, PREFLIGHT_HELP } from "../cli-entry.ts";

test("preflight CLI entry recognizes every documented bootstrap flag", () => {
  for (const flag of ["--preflight", "--vault-check", "--vault-set", "--rewrap-master-key"])
    expect(isPreflightInvocation([flag])).toBe(true);
  expect(isPreflightInvocation(["--help"])).toBe(false);
  expect(PREFLIGHT_HELP).toContain("Exit codes");
});
