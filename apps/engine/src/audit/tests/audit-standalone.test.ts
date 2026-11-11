import { expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { auditAwait, auditAwaitStandalone } from "../audit.ts";

function hostedConcurrentWrite(): Error & { code: string } {
  return Object.assign(new Error("hosted_quota_concurrent_write"), { code: "40001" });
}

function fakeDb(outcomes: Array<Error | null>, values: unknown[]): Db {
  return {
    insert: () => ({
      values: (value: unknown) => {
        values.push(value);
        return {
          onConflictDoNothing: async () => {
            const outcome = outcomes.shift();
            if (outcome) throw outcome;
          },
        };
      },
    }),
  } as unknown as Db;
}

test("standalone audit retries only hosted concurrent writes with one stable id", async () => {
  const values: unknown[] = [];
  const entry = await auditAwaitStandalone(
    { tenant_id: "00000000-0000-4000-8000-000000000001", action: "tenant.created" },
    fakeDb([hostedConcurrentWrite(), null], values),
  );
  expect(values).toHaveLength(2);
  expect((values[0] as { id: string }).id).toBe(entry.id);
  expect((values[1] as { id: string }).id).toBe(entry.id);
});

test("standalone audit exhausts exactly three hosted concurrent-write attempts", async () => {
  const values: unknown[] = [];
  await expect(
    auditAwaitStandalone(
      { tenant_id: "00000000-0000-4000-8000-000000000002", action: "tenant.created" },
      fakeDb([hostedConcurrentWrite(), hostedConcurrentWrite(), hostedConcurrentWrite()], values),
    ),
  ).rejects.toMatchObject({ code: "40001" });
  expect(values).toHaveLength(3);
});

test("standalone audit does not retry a non-hosted serialization failure", async () => {
  const values: unknown[] = [];
  await expect(
    auditAwaitStandalone(
      { tenant_id: "00000000-0000-4000-8000-000000000003", action: "tenant.created" },
      fakeDb([Object.assign(new Error("serialization_failure"), { code: "40001" })], values),
    ),
  ).rejects.toMatchObject({ code: "40001" });
  expect(values).toHaveLength(1);
});

test("standalone audit does not retry unrelated failures", async () => {
  const values: unknown[] = [];
  await expect(
    auditAwaitStandalone(
      { tenant_id: "00000000-0000-4000-8000-000000000004", action: "tenant.created" },
      fakeDb([new Error("audit unavailable")], values),
    ),
  ).rejects.toThrow("audit unavailable");
  expect(values).toHaveLength(1);
});

test("ordinary auditAwait keeps its single-attempt failure boundary", async () => {
  const values: unknown[] = [];
  await expect(
    auditAwait(
      { tenant_id: "00000000-0000-4000-8000-000000000005", action: "tenant.created" },
      fakeDb([hostedConcurrentWrite()], values),
    ),
  ).rejects.toMatchObject({ code: "40001" });
  expect(values).toHaveLength(1);
});
