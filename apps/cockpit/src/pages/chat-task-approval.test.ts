import { describe, expect, test } from "bun:test";
import type { ConversationDetail } from "@/api/client";
import { type TranslationKey, translate } from "@/lib/i18n";
import { approvalLine, chatApproval, pendingApprovalSubject } from "./chat-approval";
import {
  TASK_WRITE_TOOLS,
  type TaskAction,
  taskActionLine,
  taskActionOf,
  withTaskName,
} from "./chat-task-approval";

const de = (key: TranslationKey, values?: Record<string, string>) => translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string>) => translate("en", key, values);
const same = (value: string) => value;

const TASK = "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa";
const RUN = "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb";

function gated(tool: string, input: unknown): ConversationDetail {
  return {
    resume_summary: {
      pending_approval: {
        id: "elicitation-1",
        tool_call_id: "call-1",
        tool_name: "ask_user_confirm",
        expires_at: "2099-01-01T00:00:00Z",
        prompt: {
          question: `Policy requires confirmation before running ${tool}. Proceed?`,
          intent_kind: "execute_confirmed_tool_call",
        },
      },
    },
    tool_calls: [{ id: "call-1", tool, input }],
  } as unknown as ConversationDetail;
}

const action = (patch: Partial<TaskAction> & Pick<TaskAction, "tool">): TaskAction => ({
  taskId: null,
  taskRunId: null,
  name: null,
  scheduled: false,
  ...patch,
});

describe("what a task tool asks to do", () => {
  test("the three write tools are read from the call's own fields", () => {
    expect(TASK_WRITE_TOOLS).toEqual(["run_task", "abort_task_run", "save_task"]);
    expect(taskActionOf("run_task", { task_id: TASK, name: "ignored" })).toEqual(
      action({ tool: "run_task", taskId: TASK }),
    );
    expect(taskActionOf("abort_task_run", { task_run_id: RUN, task_id: TASK })).toEqual(
      action({ tool: "abort_task_run", taskRunId: RUN }),
    );
    expect(
      taskActionOf("save_task", {
        task_id: TASK,
        name: " Wochenzahlen ",
        schedule_cron: "0 8 * * 1",
      }),
    ).toEqual(action({ tool: "save_task", taskId: TASK, name: "Wochenzahlen", scheduled: true }));
    expect(
      taskActionOf("save_task", { name: "Einmal", schedule_run_at: "2026-12-01T08:00:00Z" }),
    ).toEqual(action({ tool: "save_task", name: "Einmal", scheduled: true }));
  });

  test("any other tool, a read tool and a call without fields are not task actions", () => {
    for (const tool of [
      undefined,
      "",
      "get_task",
      "list_tasks",
      "run_workflow",
      "schedule_task_check",
    ])
      expect(taskActionOf(tool, { task_id: TASK })).toBeNull();
    for (const input of [null, undefined, "x", [], { task_id: 7, name: "  ", schedule_cron: "" }])
      expect(taskActionOf("save_task", input)).toEqual(action({ tool: "save_task" }));
    expect(taskActionOf("run_task", { task_id: "" })).toEqual(action({ tool: "run_task" }));
  });

  test("a name given in the call wins over the stored one", () => {
    const renamed = action({ tool: "save_task", taskId: TASK, name: "Neu" });
    expect(withTaskName(renamed, "Alt")).toBe(renamed);
    const start = action({ tool: "run_task", taskId: TASK });
    expect(withTaskName(start, " Wochenzahlen ")).toEqual({ ...start, name: "Wochenzahlen" });
    for (const missing of [null, undefined, "", "  "])
      expect(withTaskName(start, missing)).toBe(start);
  });
});

describe("the sentence on the confirmation card", () => {
  test("starting a task names it and says where the run happens", () => {
    const start = action({ tool: "run_task", taskId: TASK, name: "Wochenzahlen" });
    expect(taskActionLine(start, de)).toBe(
      "Jetzt einen Run für die Aufgabe „Wochenzahlen“ in einer eigenen Unterhaltung starten.",
    );
    expect(taskActionLine(start, en)).toBe(
      "Start a run of the task “Wochenzahlen” now, in its own conversation.",
    );
  });

  test("stopping a run says that it is final", () => {
    const stop = action({ tool: "abort_task_run", taskRunId: RUN, name: "Wochenzahlen" });
    expect(taskActionLine(stop, de)).toBe(
      "Den aktuellen Run für die Aufgabe „Wochenzahlen“ endgültig abbrechen.",
    );
    expect(taskActionLine(stop, en)).toBe(
      "Stop the current run of the task “Wochenzahlen” for good.",
    );
  });

  test("saving tells a new task from a change, and a schedule from a start by hand", () => {
    expect(
      taskActionLine(action({ tool: "save_task", taskId: TASK, name: "Wochenzahlen" }), de),
    ).toBe("Die Änderungen für die Aufgabe „Wochenzahlen“ speichern.");
    expect(taskActionLine(action({ tool: "save_task", taskId: TASK }), en)).toBe(
      "Save the changes to this task.",
    );
    expect(taskActionLine(action({ tool: "save_task", name: "Wochenzahlen" }), de)).toBe(
      "Die neue Aufgabe „Wochenzahlen“ speichern, die nur läuft, wenn jemand sie startet.",
    );
    expect(taskActionLine(action({ tool: "save_task", name: "Wochenzahlen" }), en)).toBe(
      "Save the new task “Wochenzahlen”, which runs only when someone starts it.",
    );
    const scheduled = action({ tool: "save_task", name: "Wochenzahlen", scheduled: true });
    expect(taskActionLine(scheduled, de)).toBe(
      "Die neue Aufgabe „Wochenzahlen“ mit Zeitplan speichern, die erst mit deiner Dauererlaubnis alleine startet.",
    );
    expect(taskActionLine(scheduled, en)).toBe(
      "Save the new task “Wochenzahlen” with its schedule, which needs your standing permission to start on its own.",
    );
  });

  test("without a name the task is still pointed at; a nameless new task has no own sentence", () => {
    expect(taskActionLine(action({ tool: "run_task", taskId: TASK }), de)).toBe(
      "Jetzt einen Run für diese Aufgabe in einer eigenen Unterhaltung starten.",
    );
    expect(taskActionLine(action({ tool: "abort_task_run" }), en)).toBe(
      "Stop the current run of this task for good.",
    );
    expect(taskActionLine(action({ tool: "save_task" }), de)).toBeNull();
    expect(taskActionLine(action({ tool: "save_task", scheduled: true }), de)).toBeNull();
  });
});

describe("the card in the conversation", () => {
  test("a gated task tool carries its action and reads in the viewer's language", () => {
    const approval = chatApproval(gated("run_task", { task_id: TASK }));
    expect(approval).toMatchObject({
      gatedTool: "run_task",
      taskAction: action({ tool: "run_task", taskId: TASK }),
      description: null,
    });
    if (!approval?.taskAction) throw new Error("no task action");
    const named = { ...approval, taskAction: withTaskName(approval.taskAction, "Wochenzahlen") };
    expect(approvalLine(named, de, same)).toBe(
      "Jetzt einen Run für die Aufgabe „Wochenzahlen“ in einer eigenen Unterhaltung starten.",
    );
    expect(approvalLine(named, de, same)).not.toContain("Policy requires");
  });

  test("a nameless new task falls back to the general sentence, never to the engine's English", () => {
    const approval = chatApproval(gated("save_task", { goal: "x" }));
    expect(approval?.taskAction).toEqual(action({ tool: "save_task" }));
    if (!approval) throw new Error("no approval");
    expect(approvalLine(approval, de, same)).toBe(de("chat.decision.gatedAction"));
  });

  test("another gated tool keeps the general sentence and carries no task action", () => {
    const approval = chatApproval(gated("delete_workflow", { workflow: "w" }));
    expect(approval?.gatedTool).toBe("delete_workflow");
    expect(approval && "taskAction" in approval).toBe(false);
  });

  test("the context panel names the action too, without the call's fields", () => {
    const pending = (tool: string) =>
      pendingApprovalSubject(
        {
          id: "elicitation-2",
          tool_name: tool,
          summary: `Confirm ${tool}`,
          expires_at: "2099-01-01T00:00:00Z",
          prompt: {
            question: `Policy requires confirmation before running ${tool}. Proceed?`,
            intent_kind: "execute_confirmed_tool_call",
          },
        },
        null,
      );
    expect(approvalLine(pending("abort_task_run"), de, same)).toBe(
      "Den aktuellen Run für diese Aufgabe endgültig abbrechen.",
    );
    expect(approvalLine(pending("save_task"), de, same)).toBe(de("chat.decision.gatedAction"));
    expect("taskAction" in pending("delete_workflow")).toBe(false);
  });
});
