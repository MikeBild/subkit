import { describe, expect, test } from "bun:test";
import type { ScheduleOccurrenceRow } from "../../db/schema/index.ts";
import { scheduleOccurrencePage } from "./schedule-occurrences.ts";

const DUE = new Date("2026-03-02T06:57:00.000Z");

const occurrenceRow = (id: string): ScheduleOccurrenceRow =>
  ({
    id,
    tenant_id: "00000000-0000-4000-8000-000000000000",
    workflow_id: "00000000-0000-4000-8000-000000000001",
    task_id: null,
    schedule_id: null,
    due_at: DUE,
    last_due_at: DUE,
    started_at: null,
    state: "skipped",
    reason_code: "calendar_skip_date",
    skipped_count: 1,
    execution_id: null,
    task_run_id: null,
    created_at: DUE,
    updated_at: DUE,
  }) as ScheduleOccurrenceRow;

describe("scheduleOccurrencePage", () => {
  test("a full page names the due time and id of its last item as the cursor", () => {
    const ids = ["00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000a"];
    const page = scheduleOccurrencePage(ids.map(occurrenceRow), 1);
    expect(page.items.map((item) => item.id)).toEqual([ids[0]!]);
    expect(page.next_before).toBe(DUE.toISOString());
    expect(page.next_before_id).toBe(ids[0]!);
  });

  test("the last page carries no cursor", () => {
    const page = scheduleOccurrencePage([occurrenceRow("00000000-0000-4000-8000-00000000000a")], 1);
    expect(page.next_before).toBeNull();
    expect(page.next_before_id).toBeNull();
  });
});
