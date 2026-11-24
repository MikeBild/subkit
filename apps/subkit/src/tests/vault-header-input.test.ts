import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { namedValues } from "../commands/vault.ts";

const guidePath = (language: string) =>
  join(import.meta.dir, "../../../engine/src/http/reference", `onboard-an-app.${language}.md`);

const headerModeBullet = (language: string) =>
  readFileSync(guidePath(language), "utf8")
    .split("\n")
    .find((line) => line.startsWith("- `bearer`")) ?? "";

describe("vault header mode input", () => {
  test("namedValues reads one Name=Value pair per line and keeps commas in values", () => {
    expect(namedValues("A=1\nB=2")).toEqual({ A: "1", B: "2" });
    expect(namedValues("A=x,y")).toEqual({ A: "x,y" });
  });

  test.each(["en", "de"])(
    "the %s onboarding guide describes header input as one line per header on stdin",
    (language) => {
      const bullet = headerModeBullet(language);
      expect(bullet).toContain("`Name=Value`");
      expect(bullet).toContain("stdin");
      expect(bullet).not.toMatch(/comma/i);
    },
  );
});
