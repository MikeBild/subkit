import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../logging/index.ts";
import { listIntakeItems } from "../index.ts";
import { actor, createClip, ctx, nextUuid, skip, useKnowledgeIntakeDb } from "./intake-fixtures.ts";

useKnowledgeIntakeDb();

const secondActor = { kind: "system_account" as const, id: nextUuid() };

function intakeRetryObserved() {
  let resolve!: () => void;
  const observed = new Promise<void>((yes) => {
    resolve = yes;
  });
  const spy = spyOn(logger, "warn").mockImplementation((fields: unknown) => {
    const entry = fields as { action?: string; label?: string };
    if (entry.action === "retry_transient" && entry.label === "intake_write") resolve();
  });
  return { observed, restore: () => spy.mockRestore() };
}

describe.skipIf(skip)("knowledge intake concurrency", () => {
  test("a capture waits out a held tenant catalog lock instead of failing with 40001", async () => {
    const lockHolder = await ctx.testDb.pool.connect();
    const retry = intakeRetryObserved();
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 741937))", [
        ctx.tenantId,
      ]);
      const outcome = createClip({ category: "lock-held", title: "Captured under lock" }).then(
        (item) => ({ ok: true as const, item }),
        (error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }),
      );
      await Promise.race([retry.observed, outcome]);
      await lockHolder.query("COMMIT");
      expect(await outcome).toMatchObject({ ok: true });
      const listed = await listIntakeItems(
        { tenant_id: ctx.tenantId, category: "lock-held" },
        ctx.testDb.db,
      );
      expect(listed.map((item) => item.title)).toEqual(["Captured under lock"]);
    } finally {
      retry.restore();
      await lockHolder.query("ROLLBACK").catch(() => {});
      lockHolder.release();
    }
  });

  test("simultaneous captures from two actors in one category are all saved exactly once", async () => {
    const requests = Array.from({ length: 5 }, (_, index) => ({
      client_request_id: nextUuid(),
      title: `Simultaneous capture ${index}`,
      actor: index % 2 === 0 ? actor : secondActor,
    }));
    const results = await Promise.allSettled(
      requests.map((request) => createClip({ ...request, category: "simultaneous" })),
    );
    expect(results.map((result) => result.status)).toEqual(requests.map(() => "fulfilled"));
    const listed = await listIntakeItems(
      { tenant_id: ctx.tenantId, category: "simultaneous" },
      ctx.testDb.db,
    );
    expect(listed.map((item) => item.title).sort()).toEqual(
      requests.map((request) => request.title).sort(),
    );
  });
});
