import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as kinds from "@ui/lib/file-kinds";
import * as files from "@ui/lib/files";

const source = readFileSync(join(import.meta.dir, "../lib/file-kinds.ts"), "utf8");
const imports = [
  ...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g),
].map((m) => m[1]);

describe("file-kinds stays free of UI code", () => {
  it("imports nothing at all, so neither react nor lucide-react can come in", () => {
    expect(imports).toEqual([]);
    expect(source).not.toMatch(/\brequire\(|import\(/);
  });

  it("@ui/lib/files re-exports the same functions", () => {
    expect(files.fileKindOf).toBe(kinds.fileKindOf);
    expect(files.extOf).toBe(kinds.extOf);
  });
});
