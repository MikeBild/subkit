import { expect, test } from "bun:test";
import { normalizeMigrationSchema, publicTypesOf } from "../db-generate.ts";

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

test("enum changes keep the schema the baseline created the type in", () => {
  const publicTypes = publicTypesOf(
    "CREATE TYPE public.scheduler_sweep_producer AS ENUM (\n'a'\n);\nCREATE TYPE subkit.execution_status AS ENUM (\n'b'\n);\n",
  );
  expect([...publicTypes]).toEqual(["scheduler_sweep_producer"]);
  expect(
    normalizeMigrationSchema(
      'ALTER TYPE "public"."scheduler_sweep_producer" ADD VALUE \'x\';',
      publicTypes,
    ),
  ).toBe('ALTER TYPE "public"."scheduler_sweep_producer" ADD VALUE \'x\';');
  expect(
    normalizeMigrationSchema(
      'ALTER TYPE "subkit"."scheduler_sweep_producer" ADD VALUE \'x\';',
      publicTypes,
    ),
  ).toBe('ALTER TYPE "public"."scheduler_sweep_producer" ADD VALUE \'x\';');
  expect(
    normalizeMigrationSchema(
      'ALTER TYPE "public"."execution_status" ADD VALUE \'y\';',
      publicTypes,
    ),
  ).toBe('ALTER TYPE "subkit"."execution_status" ADD VALUE \'y\';');
});
