import { expect, test } from "bun:test";
import { ATTENTION_SOURCES } from "../../../operator/attention.ts";
import { AttentionV1Schema } from "./attention-schema.ts";

const sources = Object.fromEntries(ATTENTION_SOURCES.map((source) => [source, "answered"]));

function attention(item: Record<string, unknown>) {
  return {
    schema_version: "attention.v1",
    generated_at: "2026-11-19T00:00:00.000Z",
    sources,
    status: null,
    items: [
      {
        id: "task:11111111-1111-4111-8111-111111111111",
        class: "decide",
        severity: "notice",
        kind: "task",
        subject: {
          kind: "task",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Weekly report",
        },
        reason: "task_result_ready",
        trigger: null,
        cause_class: null,
        counts: {},
        since: null,
        deadline: null,
        detail: null,
        actions: [
          {
            verb: "review",
            href: "/cockpit/tasks/11111111-1111-4111-8111-111111111111",
            primary: true,
            permission: "task:run",
          },
        ],
        ...item,
      },
    ],
  };
}

test("the attention contract accepts every task reason on a task subject", () => {
  for (const reason of [
    "task_run_failed",
    "task_result_ready",
    "task_grant_required",
    "task_grant_expiring",
    "task_owner_unavailable",
  ] as const) {
    const parsed = AttentionV1Schema.parse(attention({ reason }));
    expect(parsed.items[0]?.reason).toBe(reason);
    expect(parsed.items[0]?.subject?.kind).toBe("task");
  }
});

test("the attention contract requires the tasks source and refuses unknown task vocabulary", () => {
  expect(AttentionV1Schema.parse(attention({})).sources.tasks).toBe("answered");
  const withoutTasks = Object.fromEntries(
    Object.entries(sources).filter(([source]) => source !== "tasks"),
  );
  expect(AttentionV1Schema.safeParse({ ...attention({}), sources: withoutTasks }).success).toBe(
    false,
  );
  expect(AttentionV1Schema.safeParse(attention({ reason: "task_unknown" })).success).toBe(false);
  expect(
    AttentionV1Schema.safeParse(attention({ subject: { kind: "task_run", id: "run", name: null } }))
      .success,
  ).toBe(false);
});

test("the attention contract accepts every device reason on a device or workflow subject", () => {
  for (const reason of [
    "device_offline_waiting",
    "local_confirmation_needed",
    "device_permission_missing",
    "folder_changed",
  ] as const) {
    const onDevice = AttentionV1Schema.parse(
      attention({
        reason,
        subject: { kind: "device", id: "66666666-6666-4666-8666-666666666666", name: "MacBook" },
      }),
    );
    expect(onDevice.items[0]?.reason).toBe(reason);
    expect(onDevice.items[0]?.subject?.kind).toBe("device");
  }
  expect(
    AttentionV1Schema.parse(
      attention({
        reason: "folder_changed",
        subject: { kind: "workflow", id: "77777777-7777-4777-8777-777777777777", name: null },
      }),
    ).items[0]?.subject?.kind,
  ).toBe("workflow");
});
