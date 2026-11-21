import { describe, expect, test } from "bun:test";
import { PERSONAL_PATH_CASES } from "./paths.cases.ts";
import {
  classifyNewEntry,
  classifyRelativePath,
  isSecretFile,
  pathAllowedPersonal,
} from "./paths.ts";
import type { PolicyResult } from "./result.ts";

function outcome(result: PolicyResult): string {
  return result.ok ? "ok" : result.code;
}

describe("personal-mode paths (chat, tasks, own schedules)", () => {
  test("cover both directions and both systems", () => {
    expect(new Set(PERSONAL_PATH_CASES.map((c) => c.id)).size).toBe(PERSONAL_PATH_CASES.length);
    for (const direction of ["over_permission", "needless_ask"]) {
      for (const os of ["darwin", "win32"]) {
        expect(PERSONAL_PATH_CASES.some((c) => c.direction === direction && c.os === os)).toBe(
          true,
        );
      }
    }
  });

  for (const c of PERSONAL_PATH_CASES) {
    test(`${c.id} → ${c.expected}`, () => {
      const options = {
        os: c.os,
        keep_out: c.keep_out,
        ...(c.case_sensitive === undefined ? {} : { case_sensitive: c.case_sensitive }),
        ...(c.data_dir === undefined ? {} : { data_dir: c.data_dir }),
      };
      expect(outcome(pathAllowedPersonal(c.lexical, c.real, options))).toBe(c.expected);
    });
  }

  test("an unparseable keep-out entry never matches", () => {
    expect(
      outcome(
        pathAllowedPersonal("/Users/mike/a.txt", "/Users/mike/a.txt", {
          os: "darwin",
          keep_out: ["relative"],
        }),
      ),
    ).toBe("ok");
  });
});

describe(".key files", () => {
  test("are always key files, so always secret", () => {
    expect(isSecretFile("Vortrag.key")).toBe(true);
    expect(isSecretFile("Vortrag.KEY.")).toBe(true);
    expect(isSecretFile("Vortrag.keynote")).toBe(false);
    expect(outcome(classifyRelativePath("Vortrag.key", "darwin"))).toBe("secret_file");
    expect(outcome(classifyNewEntry("Vortrag.key", "darwin"))).toBe("secret_file");
  });
});
