import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const surfaces = ["scripts/lib/commands.ts", "scripts/stage-cli-binaries.ts"].map((path) => ({
  path,
  body: readFileSync(join(REPO, path), "utf8"),
}));

describe("compiled builds keep installed dependencies immutable", () => {
  test("externalizes ssh2's optional native addon instead of deleting it", () => {
    for (const surface of surfaces) {
      expect(surface.body).not.toContain("rm -rf node_modules/cpu-features");
      expect(surface.body).toMatch(
        /--external(?:[=\s]+["']?cpu-features|["'],\s*["']cpu-features)/,
      );
    }
  });
});
