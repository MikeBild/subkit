// The sweep's closing number, held against the way it is produced.
//
// The line used to CALCULATE it: routes × viewports × variants + variants × 12.
// It announced 252 while the run wrote 296 — the 12 was stale, and the four
// contact sheets per pass appeared in no term of the formula at all. The count
// is not even constant: the expanded decision cards depend on which toggles the
// fixtures expose. The 252 was then quoted onwards as a measurement.
//
// A number never travels without the rule that produced it. Here the rule is
// "counted at each write", and this file pins that there is no second way to
// write a frame.
//
// tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI). `bun run test:contract` runs this.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "scripts/verify-cockpit-visual.mjs"), "utf8");

describe("the visual sweep reports the frames it wrote", () => {
  test("every frame goes through the counter", () => {
    expect(source).toContain("framesWritten += 1;");
    expect(
      source,
      "a screenshot is taken outside shoot(), so the count would understate the run",
    ).not.toContain(".screenshot({");
  });

  test("the closing line prints the count, not a formula over the route table", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(source).toContain("${framesWritten} screenshots in ${outputDir}");
    expect(source, "the formula is gone").not.toContain("variants.length * 12");
  });

  test("the number carries the rule that produced it", () => {
    expect(source).toContain("counted at each write");
  });
});
