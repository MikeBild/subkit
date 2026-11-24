import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

describe("recipe test organization", () => {
  test("recipe suites stay within the 600-line audit budget", () => {
    const directory = import.meta.dir;
    const oversized = readdirSync(directory)
      .filter((name) => /^recipes(?:-.*)?\.test\.ts$/.test(name))
      .filter(
        (name) => readFileSync(`${directory}/${name}`, "utf8").trimEnd().split("\n").length > 600,
      );
    expect(oversized).toEqual([]);
  });
});
