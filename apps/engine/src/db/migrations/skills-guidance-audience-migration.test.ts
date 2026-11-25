import { expect, test } from "bun:test";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

test("skill guidance audience appends after the files content migration with an empty default", () => {
  const files = EMBEDDED_MIGRATIONS.find(
    (migration) => migration.tag === "0013_files_active_content_unique",
  );
  const audience = EMBEDDED_MIGRATIONS.find(
    (migration) => migration.tag === "0014_skills_guidance_audience",
  );
  expect(files).toBeDefined();
  expect(audience).toBeDefined();
  expect(audience?.idx).toBe((files?.idx ?? -1) + 1);
  expect(audience?.when).toBeGreaterThan(files?.when ?? 0);
  const statements = audience?.statements.join("\n") ?? "";
  expect(statements).toContain(`ADD COLUMN "audience" jsonb DEFAULT '[]'::jsonb NOT NULL`);
  expect(statements).toContain("skills_audience_array_chk");
});
