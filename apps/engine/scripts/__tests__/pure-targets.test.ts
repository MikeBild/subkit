import { describe, expect, test } from "bun:test";
import {
  classifyPureTargetSource,
  discoverPureTargets,
  EXPLICIT_PURE_TARGET_PATHS,
  pureTargetDigest,
  pureTargetPaths,
  validatePureTargetInventory,
} from "../audit/pure-targets.ts";

describe("canonical pure target discovery", () => {
  test("owns engine cores and reviewed explicit targets with stable metadata", () => {
    const entries = discoverPureTargets([
      "apps/engine/src/workflows/core/workflow.ts",
      "apps/engine/src/workflows/service.ts",
      "apps/cockpit/src/pages/audit-filter-state.ts",
      "apps/sk/src/commands/workflow-file-model.ts",
      "packages/shared/src/approval-choice.ts",
      "packages/shared/src/jsonl-ring.ts",
    ]);

    expect(entries).toEqual([
      {
        path: "apps/cockpit/src/pages/audit-filter-state.ts",
        owner_shard: "cockpit",
        subsystem: "cockpit",
        target_kind: "cockpit",
        eligibility: "eligible",
        source_of_inclusion: "explicit_manifest",
        public_facade_obligations: [],
        effect_ledger_status: "required",
        runtime_kind: "runtime",
      },
      {
        path: "apps/engine/src/workflows/core/workflow.ts",
        owner_shard: "workflows",
        subsystem: "workflows",
        target_kind: "engine_core",
        eligibility: "eligible",
        source_of_inclusion: "isCorePath",
        public_facade_obligations: [],
        effect_ledger_status: "required",
        runtime_kind: "runtime",
      },
      {
        path: "apps/sk/src/commands/workflow-file-model.ts",
        owner_shard: "sk",
        subsystem: "sk",
        target_kind: "sk",
        eligibility: "eligible",
        source_of_inclusion: "explicit_manifest",
        public_facade_obligations: [],
        effect_ledger_status: "required",
        runtime_kind: "runtime",
      },
      {
        path: "packages/shared/src/approval-choice.ts",
        owner_shard: "shared",
        subsystem: "shared",
        target_kind: "shared",
        eligibility: "eligible",
        source_of_inclusion: "explicit_manifest",
        public_facade_obligations: [],
        effect_ledger_status: "required",
        runtime_kind: "runtime",
      },
    ]);
  });

  test("does not admit absent reviewed paths or unreviewed look-alikes", () => {
    expect(pureTargetPaths(["packages/shared/src/jsonl-ring.ts"])).toEqual([]);
    expect(EXPLICIT_PURE_TARGET_PATHS).not.toContain("packages/shared/src/jsonl-ring.ts");
  });

  test("hashes metadata in normalized path order", () => {
    const entries = discoverPureTargets([
      "packages/shared/src/approval-choice.ts",
      "apps/engine/src/workflows/core/workflow.ts",
    ]);
    expect(pureTargetDigest(entries)).toBe(pureTargetDigest([...entries].reverse()));
    expect(pureTargetDigest(entries)).not.toBe(
      pureTargetDigest([{ ...entries[0]!, owner_shard: "other" }]),
    );
  });

  test("reports a missing reviewed target in a production inventory", () => {
    expect(validatePureTargetInventory(["packages/shared/src/jsonl-ring.ts"])).toContain(
      "reviewed pure target is missing from inventory: apps/cockpit/src/pages/audit-filter-state.ts",
    );
  });

  test("reports a missing reviewed engine core instead of silently shrinking the scope", () => {
    expect(validatePureTargetInventory(EXPLICIT_PURE_TARGET_PATHS)).toContain(
      "reviewed pure target is missing from inventory: apps/engine/src/workflows/core/workflow.ts",
    );
  });

  test("rejects duplicate entries when producing a digest", () => {
    const [entry] = discoverPureTargets(["packages/shared/src/approval-choice.ts"]);
    expect(() => pureTargetDigest([entry!, entry!])).toThrow("duplicate canonical pure target");
  });
});

test("classifies only explicit erased TypeScript declarations as type-only", () => {
  expect(
    classifyPureTargetSource(
      'import type { Input } from "./input"; export type { Input }; export interface Result { ok: true }',
    ),
  ).toBe("type_only");
  for (const source of [
    'import "./side-effect"; export interface Result { ok: true }',
    "export const value = 1",
    "export enum State { Ready }",
    "export {}",
    "export interface Broken {",
  ])
    expect(classifyPureTargetSource(source)).toBe("runtime");
});
