import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mutationTestInputs } from "../audit/mutation-inputs.ts";
import { digestWaveFiles, type MutationWaveManifest } from "../audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
} from "../audit/pure-targets.ts";
import { executeMutationWave, loadMutationWave } from "../run-mutation-shards.ts";
import { frozenWaveFixture } from "./fixtures/frozen-wave.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeWave(root: string, manifestPath: string, wave: MutationWaveManifest): void {
  writeFileSync(manifestPath, JSON.stringify(wave));
}

function typeOnlyFixture() {
  const fixture = frozenWaveFixture();
  roots.push(fixture.root);
  for (const target of fixture.targets)
    fixture.put(target, "export interface TypeOnlyFixture { readonly marker: string }\n");
  for (const test of fixture.tests) fixture.put(test, "\n");
  const entries = assertCompletePureTargetInventory(fixture.targets, (path) =>
    readFileSync(join(fixture.root, path), "utf8"),
  );
  expect(entries.every((entry) => entry.runtime_kind === "type_only")).toBe(true);
  const wave: MutationWaveManifest = {
    ...fixture.wave,
    source_freeze_sha256: digestWaveFiles(fixture.root, mutationTestInputs(fixture.root)),
    test_freeze_sha256: digestWaveFiles(fixture.root, []),
    target_digest_sha256: canonicalPureTargetDigest(entries),
    shards: [
      {
        id: "fixture",
        targets: fixture.targets,
        tests: [],
        consumers: [],
        resource_tags: [],
      },
    ],
  };
  writeWave(fixture.root, fixture.manifestPath, wave);
  return { ...fixture, wave };
}

function receipt(unionPath: string): Record<string, unknown> {
  const union = JSON.parse(readFileSync(unionPath, "utf8")) as { shards: Array<{ id: string }> };
  const shard = union.shards[0];
  if (!shard) throw new Error("expected one type-only shard");
  return JSON.parse(readFileSync(join(dirname(unionPath), shard.id, "receipt.json"), "utf8"));
}

test("frozen AST type-only wave emits a no-tool mutation receipt", async () => {
  const fixture = typeOnlyFixture();
  const mutationUnion = await executeMutationWave({
    repo: fixture.root,
    manifestPath: fixture.manifestPath,
    timeoutMs: 1_000,
  });
  const mutation = receipt(mutationUnion);
  expect(mutation).toMatchObject({
    not_applicable: "type_only_ast",
    runtime_targets: [],
    type_only_targets: fixture.targets,
  });
  const mutationShard = join(dirname(mutationUnion), "fixture");
  expect(existsSync(join(mutationShard, "stryker.json"))).toBe(false);
  expect(existsSync(join(mutationShard, "mutation.json"))).toBe(false);
});

test("a type-only target becoming runtime code invalidates the frozen target digest", () => {
  const fixture = typeOnlyFixture();
  fixture.put(fixture.targets[0]!, "export const nowRuntime = true;\n");
  expect(() => loadMutationWave(fixture.root, fixture.manifestPath)).toThrow(
    "target digest differs",
  );
});
