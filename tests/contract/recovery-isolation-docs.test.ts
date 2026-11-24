import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE = join(import.meta.dir, "..", "..", "apps/engine/src/http/reference");

const recoverySection = (language: "en" | "de") => {
  const guide = readFileSync(join(REFERENCE, `run-the-engine.${language}.md`), "utf8");
  return guide.slice(guide.indexOf("subkit-recovery"));
};

describe("isolated recovery test in run-the-engine (#524)", () => {
  for (const language of ["en", "de"] as const) {
    test(`${language}: verifies health inside the engine container while internal: true`, () => {
      const section = recoverySection(language);
      expect(section).toContain("internal: true");
      for (const probe of ["/health", "/ready"])
        expect(section).toContain(
          `docker compose -p subkit-recovery exec engine curl -fsS http://127.0.0.1:3000${probe}`,
        );
      expect(section).toContain("docker compose -p subkit-recovery exec engine subkit");
      const hostPortChecks = section
        .split("\n")
        .filter((line) => /\/(health|ready)\b/.test(line) && !line.includes("exec engine curl"));
      expect(hostPortChecks).toEqual([]);
    });
  }
});
