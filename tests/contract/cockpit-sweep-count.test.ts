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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      "(await readdir(outputDir, { recursive: true, withFileTypes: true })).filter(",
    );
    expect(source).toContain('(entry) => entry.isFile() && entry.name.endsWith(".png"),');
    expect(source).toContain("if (framesOnDisk !== framesWritten)");
  });

  test("the disk side counts FILES, and all of them", () => {
    // The rule the line used to carry read one level and took every NAME ending
    // in .png. Driven here rather than argued: four written frames, two of them
    // one level down, next to a directory called x.png. The old rule answers 3
    // — it misses the two below and counts the directory, and both errors point
    // towards a number that looks fine.
    // mkdtempSync, not a timestamp: the directory needs to be UNIQUE, and a
    // clock reading is a poor way to get that — two runs in the same
    // millisecond collide, and the reading is wall-clock in a test file.
    const root2 = mkdtempSync(join(tmpdir(), "sweep-count-"));
    mkdirSync(join(root2, "unter"), { recursive: true });
    mkdirSync(join(root2, "x.png"), { recursive: true });
    for (const name of ["a.png", "b.png", "unter/c.png", "unter/d.png"])
      writeFileSync(join(root2, name), "");
    try {
      const old = readdirSync(root2).filter((name) => name.endsWith(".png")).length;
      const now = readdirSync(root2, { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".png"),
      ).length;
      expect(old, "what the line used to answer").toBe(3);
      expect(now, "what was actually written").toBe(4);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
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
