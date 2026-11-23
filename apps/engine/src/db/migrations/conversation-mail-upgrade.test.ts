import { expect, test } from "bun:test";
import { createTestDb } from "../tests/setup.ts";

test("conversation and mail columns, the operational guard, and the scheduler cursors are in place", async () => {
  const fixture = await createTestDb("conversation-mail-upgrade");
  try {
    const columns = await fixture.pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='subkit' AND table_name IN ('conversation_turns','transactional_mail_receipts')",
    );
    expect(columns.rows).toContainEqual({
      table_name: "conversation_turns",
      column_name: "cancel_requested",
    });
    expect(columns.rows).toContainEqual({
      table_name: "transactional_mail_receipts",
      column_name: "request_id",
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid='subkit.conversation_turns'::regclass AND NOT tgisinternal",
        )
      ).rows,
    ).toContainEqual({ tgname: "hosted_operational_guard" });
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS count FROM subkit.scheduler_sweep_cursors",
        )
      ).rows,
    ).toEqual([{ count: 10 }]);
  } finally {
    await fixture.cleanup();
  }
});
