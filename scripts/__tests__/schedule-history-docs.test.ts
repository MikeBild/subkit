import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const referenceRoot = new URL("../../apps/engine/src/http/reference/", import.meta.url);

describe("schedule history documentation", () => {
  for (const locale of ["en", "de"]) {
    test(`${locale} preserves offset cutoffs and the pagination cursor`, () => {
      const body = readFileSync(
        new URL(`reference-desktop-rules-schedules.${locale}.md`, referenceRoot),
        "utf8",
      );
      expect(body).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
      expect(body).toContain("`+05:30`");
      expect(body).toContain("`before_id`");
      expect(body).toContain("{items, next_before, next_before_id}");
    });
  }
});
