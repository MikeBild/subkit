import { describe, expect, test } from "bun:test";
import {
  COMPUTER_TEXT_MAX_BYTES,
  ComputerAuditSchema,
  ComputerKeyArgsSchema,
  ComputerRefArgsSchema,
  ComputerScrollArgsSchema,
  ComputerSelectArgsSchema,
  ComputerTypeArgsSchema,
  ComputerWindowArgsSchema,
} from "./computer.ts";

describe("computer argument schemas", () => {
  test("accept snapshot-qualified refs only", () => {
    expect(ComputerRefArgsSchema.safeParse({ window_id: "w-1", ref: "@s8f3k2p9:e8" }).success).toBe(
      true,
    );
    for (const ref of ["@e8", "@s1:e0", "s1:e1", "@S1:e1", "@s1:e1 --headed", "--headed"]) {
      expect(ComputerRefArgsSchema.safeParse({ window_id: "w-1", ref }).success).toBe(false);
    }
  });

  test("window ids cannot start like a flag", () => {
    expect(ComputerWindowArgsSchema.safeParse({ window_id: "12345" }).success).toBe(true);
    expect(ComputerWindowArgsSchema.safeParse({ window_id: "--app" }).success).toBe(false);
    expect(ComputerWindowArgsSchema.safeParse({ window_id: "" }).success).toBe(false);
  });

  test("text is capped in bytes and may not carry NUL", () => {
    const base = { window_id: "w-1", ref: "@s1:e1" };
    expect(
      ComputerTypeArgsSchema.safeParse({ ...base, text: "ä".repeat(COMPUTER_TEXT_MAX_BYTES / 2) })
        .success,
    ).toBe(true);
    expect(
      ComputerTypeArgsSchema.safeParse({
        ...base,
        text: "ä".repeat(COMPUTER_TEXT_MAX_BYTES / 2 + 1),
      }).success,
    ).toBe(false);
    expect(ComputerTypeArgsSchema.safeParse({ ...base, text: "a\0b" }).success).toBe(false);
  });

  test("scroll, select and key arguments are bounded and strict", () => {
    const base = { window_id: "w-1", ref: "@s1:e1" };
    expect(
      ComputerScrollArgsSchema.safeParse({ ...base, direction: "down", amount: 3 }).success,
    ).toBe(true);
    expect(
      ComputerScrollArgsSchema.safeParse({ ...base, direction: "sideways", amount: 3 }).success,
    ).toBe(false);
    expect(
      ComputerScrollArgsSchema.safeParse({ ...base, direction: "up", amount: 21 }).success,
    ).toBe(false);
    expect(ComputerSelectArgsSchema.safeParse({ ...base, option: "" }).success).toBe(false);
    expect(ComputerKeyArgsSchema.safeParse({ window_id: "w-1", keys: "cmd+s" }).success).toBe(true);
    expect(
      ComputerKeyArgsSchema.safeParse({ window_id: "w-1", keys: "cmd+s", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("computer audit", () => {
  test("carries the bundle id, action, role and label hash, nothing from the screen", () => {
    const audit = {
      app_bundle_id: "com.apple.iWork.Numbers",
      action: "computer.press",
      ax_role: "button",
      label_hash: "a".repeat(64),
    };
    expect(ComputerAuditSchema.parse(audit)).toEqual(audit);
    expect(ComputerAuditSchema.safeParse({ ...audit, label: "Send" }).success).toBe(false);
    expect(ComputerAuditSchema.safeParse({ ...audit, label_hash: "Send" }).success).toBe(false);
  });
});
