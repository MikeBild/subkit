import { describe, expect, test } from "bun:test";
import { type RegistrationAuthMethod, registrationAuthMethod } from "./registration-method.ts";

describe("registrationAuthMethod", () => {
  const cases: ReadonlyArray<[string[] | undefined, RegistrationAuthMethod]> = [
    [["none", "client_secret_post"], "none"],
    [["client_secret_basic", "none"], "none"],
    [["none"], "none"],
    [["client_secret_post"], "client_secret_post"],
    [["client_secret_basic"], "client_secret_post"],
    [[], "client_secret_post"],
    [undefined, "client_secret_post"],
  ];
  for (const [supported, expected] of cases) {
    test(`${JSON.stringify(supported)} → ${expected}`, () => {
      expect(registrationAuthMethod(supported)).toBe(expected);
    });
  }
});
