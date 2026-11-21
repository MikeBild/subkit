import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  layerOf,
  missingTestIds,
  SHELL_RULES,
  type SourceFile,
  targetOf,
  violations,
} from "../connect/architecture-rules.ts";

const ROOT = import.meta.dir;

function sources(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.startsWith("architecture")) return [];
    return [{ path: relative(ROOT, path), source: readFileSync(path, "utf8") }];
  });
}

describe("architecture of the shell window", () => {
  const files = sources(ROOT);

  test("the scan sees every layer the window uses", () => {
    const layers = new Set(files.map((file) => layerOf(file.path)));
    for (const layer of ["entry", "page", "feature", "adapter", "lib"] as const) {
      expect(layers.has(layer)).toBe(true);
    }
  });

  test("dependencies point downward and only the adapter reaches the bridge", () => {
    expect(violations(files, SHELL_RULES)).toEqual([]);
  });

  test("every interactive element carries a test id", () => {
    expect(missingTestIds(files)).toEqual([]);
  });

  test("the shell rules resolve paths inside the shell window", () => {
    expect(targetOf("pages/a.tsx", "../lib/text.ts", SHELL_RULES)).toEqual({
      layer: "lib",
      path: "lib/text.ts",
    });
    expect(targetOf("features/x/a.tsx", "../../../shared/shell-ipc.ts", SHELL_RULES)).toEqual({
      layer: "shared",
      path: "src/shared/shell-ipc.ts",
    });
    expect(
      violations(
        [{ path: "features/x/a.tsx", source: "window.subkitShell.close();" }],
        SHELL_RULES,
      ),
    ).toEqual(["features/x/a.tsx: only the adapter talks to the preload bridge"]);
  });
});
