import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { latestRun, run, task, usagePeriod } from "./tasks-fixtures";
import {
  quotedQuestion,
  startView,
  taskRows,
  usageExcludesWorkflowCalls,
  usageFigure,
} from "./tasks-model";

const NOW = Date.parse("2026-11-19T10:00:00Z");

describe("what the task pages read from the server's task view", () => {
  test("the next start comes from the server; a past one is due and held, a paused task has none", () => {
    expect(startView(task({ next_start_at: "2026-11-20T07:00:00Z" }), NOW)).toEqual({
      kind: "at",
      at: "2026-11-20T07:00:00Z",
    });
    expect(startView(task({ next_start_at: "2026-11-19T07:00:00Z" }), NOW)).toEqual({
      kind: "due",
      line: "tasks.next.due",
    });
    expect(startView(task({ next_start_at: null }), NOW)).toEqual({ kind: "none" });
    expect(startView(task({ next_start_at: "nonsense" }), NOW)).toEqual({ kind: "none" });
    expect(
      startView(
        task({ next_start_at: "2026-11-19T07:00:00Z", paused_at: "2026-11-01T00:00:00Z" }),
        NOW,
      ),
    ).toEqual({ kind: "none" });
    expect(translate("de", "tasks.next.due")).toBe("fällig, wartet auf Erlaubnis");
    expect(translate("en", "tasks.next.due")).toBe("due, waiting for permission");
  });

  test("a due start names what it waits for: permission, the current run, or nothing", () => {
    const due = { next_start_at: "2026-11-19T07:00:00Z" };
    const open = latestRun(run({ state: "sleeping" }));
    const ended = latestRun(run({ state: "completed" }));
    const line = (change: Parameters<typeof task>[0]) => {
      const view = startView(task({ ...due, ...change }), NOW);
      return view.kind === "due" ? view.line : null;
    };
    expect(line({ grant_live: false, latest_run: open })).toBe("tasks.next.due");
    expect(line({ grant_live: true, latest_run: open })).toBe("tasks.next.dueRun");
    expect(line({ grant_live: true, latest_run: ended })).toBe("tasks.next.dueSoon");
    expect(line({ grant_live: true, latest_run: null })).toBe("tasks.next.dueSoon");
    expect(translate("de", "tasks.next.dueRun")).toBe("wartet auf den laufenden Lauf");
    expect(translate("en", "tasks.next.dueRun")).toBe("waiting for the current run");
    expect(translate("de", "tasks.next.dueSoon")).toBe("startet gleich");
    expect(translate("en", "tasks.next.dueSoon")).toBe("starts shortly");
  });

  test("the open question is quoted in one line, clipped when long, absent when empty", () => {
    expect(quotedQuestion("  Darf ich Lena\n die Erinnerung schicken? ")).toBe(
      "Darf ich Lena die Erinnerung schicken?",
    );
    expect(quotedQuestion(null)).toBeNull();
    expect(quotedQuestion("   ")).toBeNull();
    const long = quotedQuestion("x".repeat(400)) ?? "";
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
    expect(translate("de", "tasks.strip.waiting.quoted", { question: "Passt das?" })).toBe(
      "Wartet auf dich: „Passt das?“",
    );
    expect(translate("en", "tasks.strip.waiting.quoted", { question: "Is this right?" })).toBe(
      "Waiting for you: “Is this right?”",
    );
  });

  test("usage reads as cost, as a lower bound, as tokens, as nothing or as no longer assignable", () => {
    expect(usageFigure(usagePeriod())).toEqual({
      kind: "cost",
      amount: 0.42,
      currency: "USD",
      atLeast: false,
    });
    expect(
      usageFigure(
        usagePeriod({ cost: { amount: 0.1, currency: "EUR", unpriced_models: ["local-model"] } }),
      ),
    ).toEqual({ kind: "cost", amount: 0.1, currency: "EUR", atLeast: true });
    expect(usageFigure(usagePeriod({ cost: null }))).toEqual({ kind: "tokens", tokens: 12_500 });
    expect(usageFigure(usagePeriod({ calls: 0, tokens: 0, cost: null }))).toEqual({ kind: "none" });
    expect(
      usageFigure(usagePeriod({ attribution: "conversation_removed", calls: 0, cost: null })),
    ).toEqual({ kind: "removed" });
    expect(usageFigure(usagePeriod({ attribution: "conversation_removed" }))).toEqual({
      kind: "removed",
    });
    const both = {
      last_run: usagePeriod(),
      current_month: usagePeriod({ period: "current_month" }),
    };
    expect(usageExcludesWorkflowCalls(both)).toBe(true);
    expect(
      usageExcludesWorkflowCalls({
        last_run: usagePeriod({ not_included: [] }),
        current_month: usagePeriod({ not_included: [] }),
      }),
    ).toBe(false);
    expect(translate("de", "tasks.usage.removed")).toBe("nicht mehr zuordenbar");
  });

  test("list rows take the latest run from the task itself", () => {
    const latest = latestRun(run({ state: "sleeping", next_check_at: "2026-11-19T13:30:00Z" }));
    const rows = taskRows([task({ latest_run: latest }), task({ id: "t-2" })]);
    expect(rows.map((row) => row.run?.state ?? null)).toEqual(["sleeping", null]);
  });
});
