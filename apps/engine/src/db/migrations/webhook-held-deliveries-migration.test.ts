import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("held deliveries come after skill audiences and retain tenant isolation", () => {
  const journal = JSON.parse(readFileSync(`${import.meta.dir}/meta/_journal.json`, "utf8"));
  const audience = journal.entries.findIndex((entry: { tag: string }) =>
    entry.tag.endsWith("_skills_guidance_audience"),
  );
  const held = journal.entries.findIndex((entry: { tag: string }) =>
    entry.tag.endsWith("_webhook_held_deliveries"),
  );
  expect(audience).toBeGreaterThan(0);
  expect(held).toBeGreaterThan(audience);
  const entry = journal.entries[held];
  expect(entry.idx).toBe(held);
  expect(entry.when).toBeGreaterThan(journal.entries[audience].when);
  const sql = readFileSync(`${import.meta.dir}/${entry.tag}.sql`, "utf8");
  expect(sql).toContain('CREATE UNIQUE INDEX "webhook_held_deliveries_delivery_key"');
  expect(sql).toContain('CREATE POLICY "tenant_row_scope"');
  expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  expect(sql).toContain("FORCE ROW LEVEL SECURITY");
});
