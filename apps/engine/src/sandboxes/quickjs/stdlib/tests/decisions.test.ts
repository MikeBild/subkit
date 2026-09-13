import { describe, expect, test } from "bun:test";

import { runJs } from "../../runtime.ts";
import { SandboxRuntimeError } from "../../types.ts";

describe("sk.allow / sk.deny", () => {
  test("allow() returns { allow: true }", async () => {
    const { output } = await runJs<{ allow: boolean }>({
      code: "return sk.allow();",
      input: null,
      clock: null,
    });
    expect(output).toEqual({ allow: true });
  });

  test("deny(reason) returns { allow: false, reason }", async () => {
    const { output } = await runJs<{ allow: boolean; reason: string }>({
      code: "return sk.deny('mutating_denied');",
      input: null,
      clock: null,
    });
    expect(output).toEqual({ allow: false, reason: "mutating_denied" });
  });

  test("deny() without reason throws TypeError", async () => {
    let threw: unknown = null;
    try {
      await runJs({ code: "return sk.deny();", input: null, clock: null });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SandboxRuntimeError);
    expect((threw as Error).message).toMatch(/non-empty string reason/);
  });

  test("deny('') is rejected as empty", async () => {
    let threw: unknown = null;
    try {
      await runJs({ code: "return sk.deny('');", input: null, clock: null });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SandboxRuntimeError);
  });
});
