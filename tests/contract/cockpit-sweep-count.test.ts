// The sweep's closing number, held against the way it is produced.
//
// The line used to CALCULATE it: routes × viewports × variants + variants × 12.
// It announced 252 while the run wrote 296 — the 12 was stale, and the four
// contact sheets per pass appeared in no term of the formula at all. The count
// is not even constant: the expanded decision cards depend on which toggles the
// fixtures expose. The 252 was then quoted onwards as a measurement.
//
// The repair was counting at each write. The GUARD for it was this file, and it
// was a bad one: `.not.toContain(".screenshot({")` is a rule about how a call is
// SPELLED. `await page.screenshot(opts)` — the options in a variable, no brace —
// walked past it in a second function, 3/3 green, with the count understating
// the run exactly as before. A guard that checks text instead of effect is not a
// guard; that ban is gone.
//
// What holds the claim now lives in the script and runs on every sweep: the
// closing line counts the PNG files in the output directory and refuses to print
// a number that disagrees with them. The statements below are LOCKS against that
// line being deleted, and they are labelled as locks.
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
  test("the count is held against the files on disk (a lock)", () => {
    // The effect, not the spelling: however a frame is taken, it lands in
    // outputDir, and a frame that did not go through the counter makes the two
    // numbers differ and the run fail.
    expect(source).toContain("framesWritten += 1;");
    expect(source).toContain(
      'const framesOnDisk = (await readdir(outputDir)).filter((name) => name.endsWith(".png")).length;',
    );
    expect(source).toContain("if (framesOnDisk !== framesWritten)");
  });

  test("the output directory holds only this run's frames (a lock)", () => {
    // Without the emptying, a leftover from an earlier run inflates the disk
    // side and the comparison lies in the safe-looking direction.
    expect(source).toContain("await rm(outputDir, { recursive: true, force: true });");
    expect(source.indexOf("await rm(outputDir")).toBeLessThan(source.indexOf("await shoot("));
  });

  test("the closing line prints the count, not a formula over the route table", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text is checked, not its result
    expect(source).toContain("${framesWritten} screenshots in ${outputDir}");
    expect(source, "the formula is gone").not.toContain("variants.length * 12");
  });

  test("the number carries the rule that produced it", () => {
    expect(source).toContain("counted at each write and held against the files on disk");
  });
});
