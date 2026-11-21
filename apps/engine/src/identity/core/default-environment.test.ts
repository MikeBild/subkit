import { describe, expect, test } from "bun:test";
import { chooseEnvironment, FALLBACK_ENVIRONMENT } from "./default-environment.ts";

describe("chooseEnvironment", () => {
  test("an explicit request wins over everything else", () => {
    expect(chooseEnvironment({ requested: "prod", current: "dev", personal: "dev" })).toBe("prod");
    expect(chooseEnvironment({ requested: "dev", current: "prod", personal: "prod" })).toBe("dev");
  });

  test("an existing choice is kept when nothing is requested", () => {
    expect(chooseEnvironment({ current: "prod", personal: "dev" })).toBe("prod");
    expect(chooseEnvironment({ current: "dev", personal: "prod" })).toBe("dev");
  });

  test("a new choice follows the creator's setup default", () => {
    expect(chooseEnvironment({ personal: "prod" })).toBe("prod");
    expect(chooseEnvironment({ requested: null, current: null, personal: "dev" })).toBe("dev");
  });

  test("without any default the choice is dev", () => {
    expect(FALLBACK_ENVIRONMENT).toBe("dev");
    expect(chooseEnvironment({})).toBe("dev");
    expect(chooseEnvironment({ requested: null, current: null, personal: null })).toBe("dev");
  });
});
