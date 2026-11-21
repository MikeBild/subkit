import { describe, expect, test } from "bun:test";
import {
  LOCAL_CONFIRMATION_KIND,
  type LocalConfirmation,
  LocalConfirmationSchema,
  localConfirmationOf,
} from "./confirmation.ts";

const BROWSER: LocalConfirmation = {
  device_id: "d1000000-0000-4000-8000-000000000001",
  capability: "browser",
  target: "„Zahlungspflichtig bestellen“ auf shop.example",
  deadline_at: "2026-11-21T10:15:00.000Z",
  command_id: "a".repeat(64),
  binding_hash: "b".repeat(64),
};

describe("the device part of a tool confirmation", () => {
  test("round-trips, and a step without a command yet carries nulls", () => {
    expect(LocalConfirmationSchema.parse(BROWSER)).toEqual(BROWSER);
    const early = { ...BROWSER, command_id: null, binding_hash: null };
    expect(LocalConfirmationSchema.parse(early)).toEqual(early);
  });

  test("refuses extra fields, an empty or too long target, a missing deadline and other capabilities", () => {
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, rule: true }).success).toBe(false);
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, target: "" }).success).toBe(false);
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, target: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, target: "x".repeat(500) }).success).toBe(
      true,
    );
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, deadline_at: "soon" }).success).toBe(
      false,
    );
    expect(
      LocalConfirmationSchema.safeParse({ ...BROWSER, deadline_at: "2026-11-21T11:15:00+01:00" })
        .success,
    ).toBe(true);
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, capability: "shell" }).success).toBe(
      false,
    );
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, device_id: "" }).success).toBe(false);
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, command_id: "" }).success).toBe(false);
    expect(LocalConfirmationSchema.safeParse({ ...BROWSER, binding_hash: "" }).success).toBe(false);
  });

  test("reads the device block from a card payload or confirmation data, and nothing else", () => {
    expect(LOCAL_CONFIRMATION_KIND).toBe("local_confirmation");
    expect(localConfirmationOf({ kind: LOCAL_CONFIRMATION_KIND, device: BROWSER })).toEqual(
      BROWSER,
    );
    expect(localConfirmationOf({ device: { ...BROWSER, target: "" } })).toBeNull();
    expect(localConfirmationOf({ kind: "external_write" })).toBeNull();
    expect(localConfirmationOf(null)).toBeNull();
    expect(localConfirmationOf("device")).toBeNull();
    expect(localConfirmationOf([BROWSER])).toBeNull();
  });
});
