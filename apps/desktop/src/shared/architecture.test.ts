import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MAIN_MODULE_RULES,
  moduleViolations,
  SHARED_MODULE_RULES,
  type SourceFile,
} from "../connect/architecture-rules.ts";

const SRC = join(import.meta.dir, "..");

function sources(root: string, directory = join(SRC, root)): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(root, path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(join(SRC, root), path), source: readFileSync(path, "utf8") }];
  });
}

describe("architecture of the shared models and the main process", () => {
  test("shared stays a pure kernel without UI, Electron or other windows", () => {
    expect(moduleViolations(sources("shared"), SHARED_MODULE_RULES)).toEqual([]);
  });

  test("main reaches only itself, shared and the runner", () => {
    expect(moduleViolations(sources("main"), MAIN_MODULE_RULES)).toEqual([]);
  });
});

describe("module rules catch planted violations", () => {
  const shared = (path: string, source: string) =>
    moduleViolations([{ path, source }], SHARED_MODULE_RULES);

  test("shared may not use UI packages or Electron", () => {
    expect(shared("x.ts", 'import { cn } from "@ui/lib/utils";')).toEqual([
      "x.ts → @ui/lib/utils: src/shared may not use it",
    ]);
    expect(shared("x.ts", 'import { useState } from "react";')).toHaveLength(1);
    expect(shared("x.ts", 'import { app } from "electron";')).toHaveLength(1);
    expect(shared("x.ts", 'import { z } from "zod";\nimport { join } from "node:path";')).toEqual(
      [],
    );
  });

  test("shared may not reach into a window or the main process", () => {
    expect(shared("local/x.ts", 'import { Shell } from "../../main/shell.ts";')).toEqual([
      "local/x.ts → ../../main/shell.ts: src/shared may not reach src/main/shell.ts",
    ]);
    expect(shared("local/x.ts", 'import { t } from "../i18n.ts";')).toEqual([]);
  });

  test("tests and fixtures may read outside", () => {
    expect(shared("x.test.ts", 'import pin from "../../vendor/a.json";')).toEqual([]);
  });

  test("main may not import a window's code", () => {
    expect(
      moduleViolations(
        [{ path: "x.ts", source: 'import { ShellApp } from "../shell/pages/ShellApp.tsx";' }],
        MAIN_MODULE_RULES,
      ),
    ).toHaveLength(1);
  });
});
