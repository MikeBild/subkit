import { describe, expect, test } from "bun:test";
import type { Command, Problem, Screen } from "../../domain/index.ts";
import { adminMessage, connectActions, problemCode } from "./connect-model.ts";

const screen = (canContinue: boolean, back = false): Extract<Screen, { kind: "connect" }> => ({
  kind: "connect",
  localAvailable: false,
  address: "subkit.example.com",
  checking: false,
  strip: null,
  fieldError: null,
  slot: { kind: "checking" },
  examples: [],
  canContinue,
  back,
});

const unreachable: Problem = {
  tone: "danger",
  title: "slot.unreachable",
  body: "slot.unreachable.help",
  vars: {},
  meta: "unknown.example.org",
  error: "serverUnreachable",
  facts: [{ label: "err.code", value: "unreachable" }],
  ask: null,
  example: "localhost:3000",
};

describe("connect model", () => {
  test("each verb sends one command of the core", () => {
    const sent: Command[] = [];
    const a = connectActions(screen(true, true), (command) => sent.push(command));
    a.setUrl("sub");
    a.check("subkit.example.com");
    a.next?.();
    a.act({ kind: "recheck" });
    a.back?.();
    expect(sent).toEqual([
      { type: "EditAddress", address: "sub" },
      { type: "CheckServer", address: "subkit.example.com" },
      { type: "ContinueToSignIn" },
      { type: "ActOnNotice", action: { kind: "recheck" } },
      { type: "GoBack" },
    ]);
  });

  test("Next exists only when the server fits, Back only when the welcome step is there", () => {
    expect(connectActions(screen(false), () => {}).next).toBeUndefined();
    expect(connectActions(screen(false), () => {}).back).toBeUndefined();
  });

  test("the technical detail names the catalog code", () => {
    expect(problemCode(unreachable)).toBe("unreachable");
    expect(problemCode({ ...unreachable, error: "serverTooOld" })).toBe("server_too_old");
  });
});

describe("asking the admin", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    `${key}:${JSON.stringify(vars ?? {})}`;

  test("the prepared message names the server and both versions", () => {
    const ask = { host: "old.example.com", version: "9.2.0", needs: "11.0.0" };
    expect(adminMessage({ ...unreachable, ask }, t)).toBe(
      'notice.ask.text:{"host":"old.example.com","version":"9.2.0","needs":"11.0.0"}',
    );
  });

  test("a problem without an admin ask has no message", () => {
    expect(adminMessage(unreachable, t)).toBeNull();
  });
});
