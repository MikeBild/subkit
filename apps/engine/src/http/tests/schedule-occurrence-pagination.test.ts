import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { scheduleOccurrences, workflows } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let workflowId = "";

const SHARED_DUE = new Date("2026-03-02T06:57:00.000Z");
const OLDER_DUE = new Date("2026-03-02T06:00:00.000Z");

interface OccurrencePageBody {
  items: Array<{ id: string }>;
  next_before: string | null;
  next_before_id: string | null;
}

const readPage = async (query: string): Promise<OccurrencePageBody> => {
  const res = await fetch(
    `${srv.baseUrl}/v1/workflows/${workflowId}/schedule-occurrences?${query}`,
    { headers: { authorization: `Bearer ${srv.apiKey}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as OccurrencePageBody;
};

const followCursor = async (
  seen: string[] = [],
  cursor: { before: string; before_id: string } | null = null,
): Promise<string[]> => {
  const page = await readPage(new URLSearchParams({ limit: "1", ...(cursor ?? {}) }).toString());
  const collected = [...seen, ...page.items.map((item) => item.id)];
  return page.next_before && page.next_before_id && collected.length < 10
    ? followCursor(collected, { before: page.next_before, before_id: page.next_before_id })
    : collected;
};

const skippedAt = (due: Date, reason_code: string) => ({
  tenant_id: srv.tenantId,
  workflow_id: workflowId,
  due_at: due,
  last_due_at: due,
  state: "skipped" as const,
  reason_code,
  skipped_count: 1,
});

beforeAll(async () => {
  srv = await createHttpTestServer("schedule-occurrence-pagination");
  const [wf] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug: "wf-occ-page", name: "Occ page", lifecycle: "active" })
    .returning();
  workflowId = wf!.id;
  await srv.db.insert(scheduleOccurrences).values([
    {
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      due_at: SHARED_DUE,
      last_due_at: new Date("2026-03-02T06:58:00.000Z"),
      started_at: new Date("2026-03-02T06:58:30.000Z"),
      state: "ran_late" as const,
      reason_code: "merged_missed",
      skipped_count: 1,
    },
    skippedAt(SHARED_DUE, "calendar_skip_date"),
    skippedAt(SHARED_DUE, "calendar_weekend"),
    skippedAt(OLDER_DUE, "calendar_weekend"),
  ]);
});

afterAll(async () => {
  await srv.cleanup();
});

describe("schedule history pages through occurrences that share a due time", () => {
  test("following the cursor one row at a time returns every occurrence once, in list order", async () => {
    const fullRead = (await readPage("limit=50")).items.map((item) => item.id);
    expect(fullRead).toHaveLength(4);
    expect(await followCursor()).toEqual(fullRead);
  });

  test("a before without before_id still reads the occurrences due earlier", async () => {
    const page = await readPage(`limit=50&before=${encodeURIComponent(SHARED_DUE.toISOString())}`);
    expect(page.items).toHaveLength(1);
    expect(page.next_before_id).toBeNull();
  });
});
