import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bootstrap } from "@/api/client";
import { SessionContext } from "@/app/session-context";
import { renderInRouter } from "@/components/cockpit/patterns/test-utils";
import { latestRun, run, TASK_ID, task } from "@/features/tasks/model/tasks-fixtures";
import { TaskDetail } from "@/features/tasks/ui/tasks-detail";

const OWNER = task().owner_id;
const ADMIN = "018f4b4a-6d33-7b3a-9c2d-0000000000ad";
const MEMBER = ["task:read", "task:run", "task_run:read", "task_run:abort", "conversation:read"];
const VIEWER = ["task:read", "task_run:read", "conversation:read"];

const has = (markup: string, testId: string) => markup.includes(`data-testid="${testId}"`);

async function stripFor(
  viewer: string,
  permissions: string[],
  waiting_reason = "conversation_abandoned",
  locale: "de" | "en" = "de",
) {
  const held = run({ state: "waiting", waiting_reason: waiting_reason as never });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(["task-runs", TASK_ID, "list"], { items: [held], total: 1 });
  client.setQueryData(["task-run", held.id], { ...held, pending_question: null });
  const session = {
    principal: { id: viewer },
    tenant: { id: "5eed0001-0000-4000-8000-000000000001", timezone: "Europe/Berlin" },
    permissions,
  } as unknown as Bootstrap;
  return await renderInRouter(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={client}>
        <TaskDetail task={task({ latest_run: latestRun(held) })} permissions={permissions} />
      </QueryClientProvider>
    </SessionContext.Provider>,
    locale,
  );
}

describe("a run held by its abandoned conversation, seen by role", () => {
  test("the owner gets Continue in a new conversation next to Stop run", async () => {
    const markup = await stripFor(OWNER, MEMBER);
    expect(has(markup, "task-strip-new_conversation")).toBe(true);
    expect(has(markup, "task-strip-stop")).toBe(true);
    expect(markup).toContain(">In neuer Unterhaltung fortsetzen<");
    expect(markup).toContain(">Run abbrechen<");
    const english = await stripFor(OWNER, MEMBER, "conversation_abandoned", "en");
    expect(english).toContain(">Continue in a new conversation<");
    expect(english).toContain(">Stop run<");
    expect(english).toContain("Continue it in a new conversation or stop the run.");
  });

  test("an admin who does not own the task can only stop the run", async () => {
    const markup = await stripFor(ADMIN, [...MEMBER, "task:write", "audit:read"]);
    expect(has(markup, "task-strip-new_conversation")).toBe(false);
    expect(has(markup, "task-strip-stop")).toBe(true);
  });

  test("an owner who may neither run nor stop it gets no action", async () => {
    const markup = await stripFor(OWNER, VIEWER);
    expect(has(markup, "task-strip-new_conversation")).toBe(false);
    expect(has(markup, "task-strip-stop")).toBe(false);
  });

  test("another wait never offers a new conversation", async () => {
    const markup = await stripFor(OWNER, MEMBER, "turn_stopped");
    expect(has(markup, "task-strip-new_conversation")).toBe(false);
  });
});
