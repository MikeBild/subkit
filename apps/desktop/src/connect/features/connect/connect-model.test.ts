import { describe, expect, test } from "bun:test";
import { dictionary } from "../../../shared/i18n.ts";
import type { Command, Problem, Screen } from "../../domain/index.ts";
import { translator } from "../../lib/text.ts";
import { adminMessage, askAdmin, askLine, connectActions, problemCode } from "./connect-model.ts";

const screen = (canContinue: boolean, back = false): Extract<Screen, { kind: "connect" }> => ({
  kind: "connect",
  localAvailable: false,
  localMacOnly: false,
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

  test("asking copies the message through the bridge and confirms it", async () => {
    const english = translator(dictionary("en"));
    const ask = { host: "old.example.com", version: "12.0.0", needs: "12.1.0" };
    const message = adminMessage({ ...unreachable, ask }, english) ?? "";
    const copied: string[] = [];
    const outcome = await askAdmin(message, (text) => {
      copied.push(text);
      return Promise.resolve(true);
    });
    expect(copied).toEqual([
      "Please update the SubKit server old.example.com from version 12.0.0 to 12.1.0 or later so SubKit Desktop can connect.",
    ]);
    expect(outcome).toBe("copied");
    expect(askLine(outcome, english)).toBe("Message for your administrator copied");
  });

  test("a refused or failed copy says so instead of staying silent", async () => {
    const english = translator(dictionary("en"));
    expect(await askAdmin("text", () => Promise.resolve(false))).toBe("failed");
    expect(await askAdmin("text", () => Promise.reject(new Error("denied")))).toBe("failed");
    expect(askLine("failed", english)).toBe(dictionary("en")["notice.askFailed"]);
    expect(askLine("failed", english)).not.toBe("");
    expect(askLine("idle", english)).toBeNull();
  });
});
