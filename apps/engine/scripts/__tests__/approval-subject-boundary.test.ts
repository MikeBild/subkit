import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { germanTextLines } from "../audit/german-text.ts";
import { collectImports, resolveImport } from "../audit/imports.ts";
import { subsystemEntryHits, vendorImportHits } from "../audit/rules.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

test("approval subjects respect SDK and subsystem boundaries", () => {
  const file = "apps/engine/src/tools/approval-subject.ts";
  const imports = collectImports(file, readFileSync(`${repo}/${file}`, "utf8")).map((ref) => ({
    ...ref,
    resolved: resolveImport(file, ref.specifier, (path) => existsSync(`${repo}/${path}`)),
  }));
  expect(vendorImportHits(file, imports)).toEqual([]);
  expect(subsystemEntryHits(file, imports)).toEqual([]);
});

test("approval route copy keeps translations in the locale catalog", () => {
  const file = "apps/engine/src/http/routes/tool-approval-copy.ts";
  expect(germanTextLines(readFileSync(`${repo}/${file}`, "utf8"))).toEqual([]);
});
