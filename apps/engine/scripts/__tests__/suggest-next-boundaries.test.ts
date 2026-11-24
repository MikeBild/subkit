import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseBudgets } from "../audit/budgets.ts";
import { collectImports, resolveImport } from "../audit/imports.ts";
import { subsystemEntryHits } from "../audit/rules.ts";

const budgets = parseBudgets(
  readFileSync("apps/engine/scripts/audit/allowlists/subsystem-entry.txt", "utf8"),
);

for (const file of [
  "apps/engine/src/conversations/suggest-next.ts",
  "apps/engine/src/conversations/loop/suggest-next-emitter.ts",
]) {
  test(`${file} keeps suggestion usage within its subsystem import budget`, () => {
    const imports = collectImports(file, readFileSync(file, "utf8")).map((imp) => ({
      ...imp,
      resolved: resolveImport(file, imp.specifier, existsSync),
    }));
    expect(subsystemEntryHits(file, imports).length).toBeLessThanOrEqual(budgets.get(file) ?? 0);
  });
}
