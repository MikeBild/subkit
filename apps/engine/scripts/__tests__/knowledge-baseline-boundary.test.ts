import { expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { collectImports, resolveImport } from "../audit/imports.ts";
import { subsystemEntryHits, vendorImportHits } from "../audit/rules.ts";

test("admitted knowledge baselines respect adapter and subsystem boundaries", () => {
  const files = [
    ...globSync("apps/engine/src/identity/portability/**/baseline.ts"),
    "apps/engine/src/identity/portability/knowledge-payload.ts",
    "apps/engine/src/knowledge/intake.ts",
  ];
  for (const file of files) {
    const imports = collectImports(file, readFileSync(file, "utf8")).map((entry) => ({
      ...entry,
      resolved: resolveImport(file, entry.specifier),
    }));
    if (!file.endsWith("/intake.ts")) expect(vendorImportHits(file, imports)).toEqual([]);
    expect(subsystemEntryHits(file, imports).length).toBeLessThanOrEqual(
      file.endsWith("/intake.ts") ? 5 : 0,
    );
  }
});
