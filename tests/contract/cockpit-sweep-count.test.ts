import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "scripts/verify-cockpit-visual.mjs"), "utf8");

describe("the visual sweep reports the frames it wrote", () => {
  test("the count is held against the files on disk (a lock)", () => {
    expect(source).toContain("framesWritten += 1;");
    expect(source).toContain(
      "(await readdir(outputDir, { recursive: true, withFileTypes: true })).filter(",
    );
    expect(source).toContain('(entry) => entry.isFile() && entry.name.endsWith(".png"),');
    expect(source).toContain("if (framesOnDisk !== framesWritten)");
  });

  test("the disk side counts FILES, and all of them", () => {
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
