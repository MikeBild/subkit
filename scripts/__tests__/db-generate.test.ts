import { expect, test } from "bun:test";
import { normalizeMigrationSchema } from "../db-generate.ts";

test("new generated foreign keys bind the isolated product schema", () => {
  expect(normalizeMigrationSchema('REFERENCES "public"."tenants"("id")')).toBe(
    'REFERENCES "subkit"."tenants"("id")',
  );
  expect(normalizeMigrationSchema('CREATE EXTENSION pgcrypto WITH SCHEMA "public";')).toBe(
    'CREATE EXTENSION pgcrypto WITH SCHEMA "public";',
  );
  expect(normalizeMigrationSchema('REFERENCES "subkit"."tenants"("id")')).toBe(
    'REFERENCES "subkit"."tenants"("id")',
  );
});
