import { readFileSync } from "node:fs";
import { join } from "node:path";

export function assertPinnedBun(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `Bun ${expected} is required by .bun-version; running ${actual}. Select the pinned Bun before running validation.`,
    );
  }
}

if (import.meta.main) {
  const expected = readFileSync(join(import.meta.dir, "..", ".bun-version"), "utf8").trim();
  try {
    assertPinnedBun(Bun.version, expected);
    console.log(`[runtime] Bun ${expected} matches .bun-version`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
