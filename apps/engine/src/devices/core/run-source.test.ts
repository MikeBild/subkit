import { describe, expect, test } from "bun:test";
import { taskRequest } from "../../conversations/instruction-cover/job.ts";
import {
  LOCAL_RUN_TRIGGERS,
  LOCAL_SOURCE_REFUSALS,
  type LocalRunSource,
  localAgenticRefusal,
  taskRunSource,
} from "./run-source.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function source(overrides: Partial<LocalRunSource>): LocalRunSource {
  return {
    trigger: "chat",
    started_by: OWNER,
    schedule_created_by: null,
    device_owner: OWNER,
    ...overrides,
  };
}

describe("who may start browser and computer use on a device", () => {
  test("the device's person in a chat, a task or a run they started", () => {
    for (const trigger of ["chat", "task", "manual_run"] as const)
      expect(localAgenticRefusal(source({ trigger }))).toBeNull();
  });

  test("someone else starting it on this person's device is refused", () => {
    for (const trigger of ["chat", "task", "manual_run"] as const) {
      expect(localAgenticRefusal(source({ trigger, started_by: OTHER }))).toBe(
        "started_by_someone_else",
      );
      expect(localAgenticRefusal(source({ trigger, started_by: null }))).toBe(
        "started_by_someone_else",
      );
    }
  });

  test("a schedule counts only when the device's person set it up", () => {
    expect(
      localAgenticRefusal(
        source({ trigger: "schedule", started_by: null, schedule_created_by: OWNER }),
      ),
    ).toBeNull();
    expect(
      localAgenticRefusal(
        source({ trigger: "schedule", started_by: OWNER, schedule_created_by: OTHER }),
      ),
    ).toBe("schedule_by_someone_else");
    expect(
      localAgenticRefusal(
        source({ trigger: "schedule", started_by: OWNER, schedule_created_by: null }),
      ),
    ).toBe("schedule_by_someone_else");
  });

  test("webhooks, API keys, MCP, called workflows and content never start it", () => {
    const others = LOCAL_RUN_TRIGGERS.filter(
      (trigger) => !["chat", "task", "manual_run", "schedule"].includes(trigger),
    );
    expect(others).toEqual(["webhook", "api", "mcp", "workflow_call", "content"]);
    for (const trigger of others)
      expect(
        localAgenticRefusal(source({ trigger, started_by: OWNER, schedule_created_by: OWNER })),
      ).toBe("trigger_not_allowed");
  });

  test("the refusals are a closed list the audit projection relies on", () => {
    expect([...LOCAL_SOURCE_REFUSALS]).toEqual([
      "started_by_someone_else",
      "schedule_by_someone_else",
      "trigger_not_allowed",
    ]);
  });
  test("a task counts as started by a person when its owner started it or set it to run", () => {
    expect(taskRunSource({ started_by: null, owner_id: OWNER }, OTHER)).toEqual({
      trigger: "schedule",
      started_by: null,
      schedule_created_by: OWNER,
      device_owner: OTHER,
    });
    expect(taskRunSource({ started_by: OTHER, owner_id: OWNER }, OWNER)).toEqual({
      trigger: "task",
      started_by: OTHER,
      schedule_created_by: null,
      device_owner: OWNER,
    });
    const task = (started_by: string | null) => ({
      task_id: "t",
      task_run_id: "r",
      owner_id: OWNER,
      goal: "",
      done_when: "",
      goal_edited_by: null,
      started_by,
      created_at: new Date(0),
      deadline_at: new Date(0),
    });
    expect(taskRequest(task(null), "UTC").by_person).toBe(true);
    expect(taskRequest(task(OWNER), "UTC").by_person).toBe(true);
    expect(taskRequest(task(OTHER), "UTC").by_person).toBe(false);
  });
});
