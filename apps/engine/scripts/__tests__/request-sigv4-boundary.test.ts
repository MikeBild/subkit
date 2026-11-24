import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkSource } from "../../../../scripts/check-determinism.ts";
import { collectImports, resolveImport } from "../audit/imports.ts";
import { subsystemEntryHits } from "../audit/rules.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

test("the request driver keeps SigV4 resolution within its subsystem import budget", () => {
  const file = "apps/engine/src/execution/steps/request/drivers/http.ts";
  const imports = collectImports(file, readFileSync(`${repo}/${file}`, "utf8")).map((ref) => ({
    ...ref,
    resolved: resolveImport(file, ref.specifier, (path) => existsSync(`${repo}/${path}`)),
  }));
  expect(subsystemEntryHits(file, imports).length).toBeLessThanOrEqual(10);
});

test("the request SigV4 integration tests pass the determinism gate", () => {
  const file = "apps/engine/src/execution/tests/request-step-sigv4.test.ts";
  expect(checkSource(file, readFileSync(`${repo}/${file}`, "utf8"))).toEqual([]);
});
