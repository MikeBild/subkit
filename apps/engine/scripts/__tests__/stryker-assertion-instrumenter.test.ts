import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const requireFromTest = createRequire(import.meta.url);
const corePackage = requireFromTest.resolve("@stryker-mutator/core/package.json");
const requireFromCore = createRequire(corePackage);
const instrumenterPackage = requireFromCore.resolve("@stryker-mutator/instrumenter/package.json");
const instrumenterPath = join(dirname(instrumenterPackage), "dist/src/instrumenter.js");
const { Instrumenter } = (await import(pathToFileURL(instrumenterPath).href)) as {
  Instrumenter: new (
    logger: object,
  ) => {
    instrument(
      files: Array<{ name: string; content: string; mutate: boolean }>,
      options: object,
    ): Promise<{ mutants: Array<{ mutatorName: string; original: string; replacement: string }> }>;
  };
};

const logger = new Proxy(
  {},
  { get: (_target, key) => (String(key).startsWith("is") ? () => false : () => undefined) },
);
const options = { excludedMutations: [], ignorers: [], plugins: null };

async function mutants(source: string) {
  return (
    await new Instrumenter(logger).instrument(
      [{ name: "/tmp/stryker-ts-assertion-contract.ts", content: source, mutate: true }],
      options,
    )
  ).mutants;
}

test("Stryker instruments runtime values behind a TypeScript `as const` assertion", async () => {
  const result = await mutants("export const effect = { operation: 'read' } as const;\n");
  expect(result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mutatorName: "StringLiteral",
        replacement: '""',
      }),
    ]),
  );
});

test("Stryker instruments every runtime TypeScript assertion wrapper", async () => {
  const result = await mutants(`
    export const asValue = 'as' as const;
    export const angleValue = <string>'angle';
    export const satisfiesValue = { mode: 'satisfies' } satisfies { mode: string };
    export const nonNullValue = ('nonnull' as string | null)!;
  `);
  expect(result.filter((mutant) => mutant.mutatorName === "StringLiteral")).toHaveLength(4);
});

test("Stryker skips nested conditional literals in type grammar while reaching the asserted runtime value", async () => {
  const result = await mutants(
    "export const effect = 'runtime' as (string extends string ? string : never);\n",
  );
  expect(result.filter((mutant) => mutant.mutatorName === "StringLiteral")).toHaveLength(1);
  const typeOnly = await mutants(
    "type Effect<T> = T extends 'type-read' ? 'type-write' : 'type-other';\n",
  );
  expect(typeOnly).toEqual([]);
});

test("Stryker still skips literals that exist only in TypeScript type grammar", async () => {
  const result = await mutants("type Effect = 'read' | 'write';\n");
  expect(result).toEqual([]);
});
