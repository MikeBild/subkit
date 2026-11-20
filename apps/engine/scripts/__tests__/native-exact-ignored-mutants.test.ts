import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  nativeExactIgnoredMutant,
  readMutationEquivalentManifest,
} from "../audit/mutation-floor.ts";

const repo = resolve(import.meta.dir, "../../../..");
const logger = {
  debug() {},
  info() {},
  isDebugEnabled() {
    return false;
  },
};
const options = { plugins: null, excludedMutations: [], ignorers: [] };
const coreRequire = createRequire(import.meta.url);
const corePackage = coreRequire.resolve("@stryker-mutator/core/package.json");
const instrumenterRequire = createRequire(corePackage);
const { Instrumenter } = await import(
  pathToFileURL(instrumenterRequire.resolve("@stryker-mutator/instrumenter")).href
);
const { OptionsValidator } = await import(
  pathToFileURL(join(dirname(corePackage), "dist/src/config/options-validator.js")).href
);
const { strykerCoreSchema } = await import(
  pathToFileURL(instrumenterRequire.resolve("@stryker-mutator/api/core")).href
);

const identity = (mutant: {
  fileName: string;
  location: unknown;
  mutatorName: string;
  replacement: string;
}) =>
  JSON.stringify({
    fileName: mutant.fileName,
    location: mutant.location,
    mutatorName: mutant.mutatorName,
    replacement: mutant.replacement,
  });

test("native exact ignores bind every approved source mutation without changing inventory", async () => {
  const raw = JSON.parse(
    readFileSync(join(repo, "apps/engine/.mutation-equivalents.json"), "utf8"),
  );
  const parsed = readMutationEquivalentManifest(raw, repo);
  if ("error" in parsed) throw new Error(parsed.error);
  const byFile = new Map<string, ReturnType<typeof nativeExactIgnoredMutant>[]>();
  for (const entry of parsed.equivalents) {
    const values = byFile.get(entry.file) ?? [];
    values.push(nativeExactIgnoredMutant(entry));
    byFile.set(entry.file, values);
  }
  const instrumenter = new Instrumenter(logger);
  let ignored = 0;
  for (const [file, exactIgnoredMutants] of byFile) {
    const name = join(repo, file);
    const content = readFileSync(name, "utf8");
    const baseline = await instrumenter.instrument([{ name, content, mutate: true }], options);
    const result = await instrumenter.instrument([{ name, content, mutate: true }], {
      ...options,
      exactIgnoredMutants,
    });
    expect(result.mutants.map(identity).sort()).toEqual(baseline.mutants.map(identity).sort());
    expect(result.mutants.filter((mutant) => mutant.status === "Ignored")).toHaveLength(
      exactIgnoredMutants.length,
    );
    ignored += exactIgnoredMutants.length;
  }
  expect(ignored).toBe(parsed.equivalents.length);
  expect(ignored).toBe(103);
});

test("native exact ignores reject an entry whose file was never instrumented", async () => {
  const raw = JSON.parse(
    readFileSync(join(repo, "apps/engine/.mutation-equivalents.json"), "utf8"),
  );
  const parsed = readMutationEquivalentManifest(raw, repo);
  if ("error" in parsed) throw new Error(parsed.error);
  const entry = nativeExactIgnoredMutant(parsed.equivalents[0]!);
  const source = parsed.equivalents[0]!.file;
  const name = join(repo, source);
  await expect(
    new Instrumenter(logger).instrument(
      [{ name, content: readFileSync(name, "utf8"), mutate: true }],
      { ...options, exactIgnoredMutants: [{ ...entry, file: "never/visited.ts" }] },
    ),
  ).rejects.toThrow("Exact ignored mutant file was not instrumented");
});

test("Stryker accepts only the exact native equivalence configuration schema", () => {
  const raw = JSON.parse(
    readFileSync(join(repo, "apps/engine/.mutation-equivalents.json"), "utf8"),
  );
  const parsed = readMutationEquivalentManifest(raw, repo);
  if ("error" in parsed) throw new Error(parsed.error);
  const exact = nativeExactIgnoredMutant(parsed.equivalents[0]!);
  const validator = new OptionsValidator(strykerCoreSchema, logger);
  expect(() => validator.validate({ mutator: { exactIgnoredMutants: [exact] } })).not.toThrow();
  expect(() =>
    new OptionsValidator(strykerCoreSchema, logger).validate({
      mutator: { exactIgnoredMutants: [{ ...exact, reason: "broad" }] },
    }),
  ).toThrow();
});
