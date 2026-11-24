import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { staleSnapshotsIn } from "../lib/migration-snapshots.ts";

const root = join(import.meta.dir, "../..");

test("cache reporting retains only the latest migration snapshot", () => {
  expect(staleSnapshotsIn(join(root, "apps/engine/src/db/migrations/meta"))).toEqual([]);
});

test("conversation cache reporting uses the LLM subsystem entry", () => {
  const source = readFileSync(join(root, "apps/engine/src/conversations/loop/usage.ts"), "utf8");
  expect(source).toContain('from "../../llm/index.ts"');
});

test("cache reporting tests keep provider SDK imports behind runtime fixtures", () => {
  const source = readFileSync(
    join(root, "apps/engine/src/llm/runtime/tests/ai-sdk-model.errors-and-cache.test.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/from\s+["']@ai-sdk\//);
});
