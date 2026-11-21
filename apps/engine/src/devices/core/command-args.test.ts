import { describe, expect, test } from "bun:test";
import { DEVICE_COMMAND_KINDS } from "@shared/device/protocol.ts";
import {
  DEVICE_ARGS_SCHEMAS,
  dispatchedOutcome,
  parseCommandArgs,
  SOURCE_REFUSAL_MESSAGE,
} from "./command-args.ts";

describe("device command arguments", () => {
  test("every command kind has an entry, and the unsupported ones are named", () => {
    expect(Object.keys(DEVICE_ARGS_SCHEMAS).sort()).toEqual([...DEVICE_COMMAND_KINDS].sort());
    const unsupported = DEVICE_COMMAND_KINDS.filter((kind) => DEVICE_ARGS_SCHEMAS[kind] === null);
    expect(unsupported).toEqual(["browser.pdf", "computer.open", "computer.find"]);
  });

  test("valid arguments pass through the runner's own schema", () => {
    expect(parseCommandArgs("browser.open", { url: "https://example.com" })).toEqual({
      ok: true,
      args: { url: "https://example.com" },
    });
    expect(parseCommandArgs("browser.snapshot", undefined)).toEqual({ ok: true, args: {} });
    expect(parseCommandArgs("browser.press", { action: "scroll", direction: "down" })).toEqual({
      ok: true,
      args: { action: "scroll", direction: "down", pixels: 600 },
    });
    expect(
      parseCommandArgs("files.read_text", { target: { absolute: "/Users/m/Documents/a.txt" } }),
    ).toEqual({ ok: true, args: { target: { absolute: "/Users/m/Documents/a.txt" } } });
  });

  test("invalid arguments name the field and nothing is sent", () => {
    const parsed = parseCommandArgs("browser.open", { url: "" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("local_args_invalid");
    expect(parsed.issues[0]).toStartWith("url: ");
    const root = parseCommandArgs("browser.snapshot", "nope");
    expect(root.ok).toBe(false);
    if (!root.ok) expect(root.issues[0]).toStartWith("args: ");
    expect(parseCommandArgs("browser.snapshot", { extra: 1 }).ok).toBe(false);
    const nested = parseCommandArgs("files.write", {
      target: { absolute: "/a/b" },
      content: { encoding: "utf8", text: 5 },
    });
    expect(nested.ok ? [] : nested.issues[0]).toStartWith("content.text: ");
  });

  test("kinds without a runner shape are refused", () => {
    expect(parseCommandArgs("browser.pdf", {})).toEqual({
      ok: false,
      code: "local_command_unsupported",
      issues: ["browser.pdf"],
    });
  });

  test("a dispatch outcome maps onto one step outcome", () => {
    expect(dispatchedOutcome({ kind: "refused", code: "trigger_not_allowed" })).toEqual({
      status: "failed",
      code: "trigger_not_allowed",
      message: SOURCE_REFUSAL_MESSAGE,
    });
    expect(
      dispatchedOutcome({
        kind: "result",
        result: { status: "done", output: { a: 1 }, evidence: {} },
      }),
    ).toEqual({ status: "succeeded", output: { a: 1 } });
    expect(dispatchedOutcome({ kind: "closed", closure: "lost", effect: "write" })).toMatchObject({
      status: "failed",
      code: "device_lost_during_write",
    });
    expect(SOURCE_REFUSAL_MESSAGE).toEndWith("Nothing ran.");
  });
});
