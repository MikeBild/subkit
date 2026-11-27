import { describe, expect, test } from "bun:test";
import { DEVICE_ACTIONS, deviceAction } from "./actions.ts";
import { DEVICE_COMMAND_KINDS } from "./protocol.ts";

describe("deviceAction", () => {
  test("names the ten step actions a person sees", () => {
    expect(DEVICE_ACTIONS).toEqual([
      "open",
      "fill",
      "press",
      "read",
      "wait",
      "download",
      "screenshot",
      "signin",
      "focus",
      "files",
    ]);
  });

  test("every command kind has one step action", () => {
    expect(
      Object.fromEntries(DEVICE_COMMAND_KINDS.map((kind) => [kind, deviceAction(kind)])),
    ).toEqual({
      "files.list": "files",
      "files.read_text": "files",
      "files.import": "files",
      "files.write": "files",
      "files.mkdir": "files",
      "files.move": "files",
      "files.trash": "files",
      "browser.open": "open",
      "browser.pay": "fill",
      "browser.wait": "wait",
      "browser.extract": "read",
      "browser.fill": "fill",
      "browser.press": "press",
      "browser.download": "download",
      "browser.pdf": "download",
      "browser.snapshot": "read",
      "browser.screenshot": "screenshot",
      "browser.sign_in": "signin",
      "browser.handover": "signin",
      "computer.apps": "read",
      "computer.open": "open",
      "computer.snapshot": "read",
      "computer.find": "read",
      "computer.screenshot": "screenshot",
      "computer.press": "press",
      "computer.focus": "focus",
      "computer.handover": "signin",
      "computer.select": "fill",
      "computer.set_value": "fill",
      "computer.type": "fill",
      "computer.key": "press",
      "computer.scroll": "read",
    });
  });
});
