import { describe, expect, test } from "bun:test";
import { PERSONAL_ORIGIN_CASES, PERSONAL_SITE_OPTIONS } from "./addresses.cases.ts";
import { connectionAllowedPersonal, originAllowedPersonal } from "./addresses.ts";
import type { PolicyResult } from "./result.ts";

function outcome(result: PolicyResult): string {
  return result.ok ? "ok" : result.code;
}

describe("personal-mode origins (chat, tasks, own schedules)", () => {
  test("cover both directions", () => {
    expect(new Set(PERSONAL_ORIGIN_CASES.map((c) => c.id)).size).toBe(PERSONAL_ORIGIN_CASES.length);
    expect(PERSONAL_ORIGIN_CASES.some((c) => c.direction === "needless_ask")).toBe(true);
    expect(PERSONAL_ORIGIN_CASES.some((c) => c.direction === "over_permission")).toBe(true);
  });

  for (const c of PERSONAL_ORIGIN_CASES) {
    test(`${c.id} → ${c.expected}`, () => {
      const result =
        c.resolved_ip === undefined
          ? originAllowedPersonal(c.url, PERSONAL_SITE_OPTIONS)
          : connectionAllowedPersonal(c.url, c.resolved_ip, PERSONAL_SITE_OPTIONS);
      expect(outcome(result)).toBe(c.expected);
    });
  }

  test("an allowed origin answers a plain ok", () => {
    expect(originAllowedPersonal("https://example.com/", PERSONAL_SITE_OPTIONS)).toEqual({
      ok: true,
    });
    expect(
      connectionAllowedPersonal("http://192.168.1.1/", "192.168.1.1", PERSONAL_SITE_OPTIONS),
    ).toEqual({ ok: true });
  });

  test("unparseable entered entries never match", () => {
    const options = { entered_by_person: ["nope"] };
    expect(outcome(originAllowedPersonal("https://example.com/", options))).toBe("ok");
    expect(outcome(originAllowedPersonal("http://192.168.1.1/", options))).toBe("private_address");
    expect(outcome(originAllowedPersonal("http://192.168.1.1/", { entered_by_person: [] }))).toBe(
      "private_address",
    );
  });
});
