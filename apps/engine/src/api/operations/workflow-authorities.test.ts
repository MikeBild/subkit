import { describe, expect, test } from "bun:test";
import { authorityRejection } from "./workflow-authorities.ts";

describe("device refusals of an approval reach the caller", () => {
  for (const [code, status] of [
    ["device_approval_elsewhere", 403],
    ["device_unavailable", 409],
    ["device_binding_multiple", 409],
  ] as const) {
    test(`${code} keeps its code`, () => {
      const rejection = authorityRejection(Object.assign(new Error(code), { code }));
      expect(JSON.stringify(rejection)).toContain(code);
      expect(JSON.stringify(rejection)).toContain(String(status));
    });
  }

  test("an unknown code is not turned into a refusal", () => {
    expect(() => authorityRejection(Object.assign(new Error("x"), { code: "nope" }))).toThrow("x");
  });
});
