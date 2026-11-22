import { describe, expect, test } from "bun:test";
import { releaseVersionWasUsed } from "./release-history.ts";

describe("immutable release workflow history", () => {
  test("allows a version with no prior workflow run", () => {
    expect(releaseVersionWasUsed("[]")).toBe(false);
  });

  test("reserves a version after any prior run", () => {
    expect(releaseVersionWasUsed('[{"databaseId":26999250484}]')).toBe(true);
  });

  test("fails closed on a malformed response", () => {
    expect(() => releaseVersionWasUsed('{"databaseId":26999250484}')).toThrow(
      "release workflow history response is not an array",
    );
    expect(() => releaseVersionWasUsed('[{"databaseId":"26999250484"}]')).toThrow(
      "release workflow history contains an invalid run",
    );
  });
});
