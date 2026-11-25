import { expect, test } from "bun:test";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

test("cache reporting appends after the conversation abandoned migration", () => {
  const abandoned = EMBEDDED_MIGRATIONS.find(
    (migration) => migration.tag === "0011_task_run_conversation_abandoned",
  );
  const cache = EMBEDDED_MIGRATIONS.find(
    (migration) => migration.tag === "0012_llm_usage_cache_reported",
  );
  expect(abandoned).toBeDefined();
  expect(cache).toBeDefined();
  expect(cache?.idx).toBe((abandoned?.idx ?? -1) + 1);
  expect(cache?.when).toBeGreaterThan(abandoned?.when ?? 0);
  expect(cache?.statements.join("\n")).toContain('ADD COLUMN "cache_reported" boolean');
  expect(abandoned?.statements.join("\n")).toContain("conversation_abandoned");
});
