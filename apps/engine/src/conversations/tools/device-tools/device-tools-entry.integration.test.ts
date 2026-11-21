import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DeviceResult } from "@shared/device/protocol.ts";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  conversationElicitations,
  conversationToolCalls,
  deviceCommands,
  roles,
  users,
} from "../../../db/schema/index.ts";
import { conversationCommandId } from "../../../devices/core/command-id.ts";
import {
  call,
  enroll,
  harness,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../../../http/tests/device-runner-fixtures.ts";
import { getMockProvider, resetMockProvider } from "../../../llm/mock-provider.ts";
import { createTask, startTaskRun } from "../../../tasks/index.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { makeToolCtx, seedConversation } from "../../../test-helpers/seed.ts";
import { appendMessage } from "../../persistence/index.ts";
import { respondElicitationForTest } from "../../tests/setup.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import type { TaskRunMarker, TurnEvent } from "../../types.ts";
import { wrapTools } from "../sdk-wrap.ts";
import { deviceConfirmationPort } from "./port.ts";

let runner: Runner;

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  await setUpDeviceRunner("device_tools_entry");
  runner = await enroll("MacBook (Anna)");
  const beat = await call(runner, "POST", "/v1/device-runner/heartbeat", {
    runner_version: "11.4.0",
    os: "darwin",
    capabilities: ["files", "browser"],
    personal: ["files", "browser"],
    permissions: {},
    allowances_digest: "x",
    generation: 0,
  });
  expect(beat.status).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await tearDownDeviceRunner();
}, 30_000);

function browserPerson(): ResolvedPrincipal {
  return {
    provider: "browser_session",
    kind: "user",
    id: harness.server.userId,
    tenant_id: harness.server.tenantId,
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: "session-entry" },
  };
}

async function commandRow(command_id: string) {
  const [row] = await harness.server.db
    .select()
    .from(deviceCommands)
    .where(
      and(eq(deviceCommands.tenant_id, harness.server.tenantId), eq(deviceCommands.id, command_id)),
    );
  return row;
}

async function answer(command_id: string, result: DeviceResult) {
  await waitFor(async () => (await commandRow(command_id))?.state === "pending", { sleepMs: 20 });
  await call(runner, "POST", `/v1/device-runner/commands/${command_id}/claim`, {});
  await call(runner, "POST", `/v1/device-runner/commands/${command_id}/result`, result);
}

async function latestCall(conversation_id: string, tool: string) {
  const rows = await harness.server.db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.conversation_id, conversation_id),
        eq(conversationToolCalls.tool, tool),
      ),
    );
  const row = rows.at(-1);
  if (!row) throw new Error(`no ${tool} call`);
  return row;
}

async function chat(message: string) {
  const conversation = await seedConversation(harness.server.db, {
    tenant_id: harness.server.tenantId,
    owner_id: harness.server.userId,
  });
  await appendMessage(harness.server.db, harness.server.tenantId, conversation.id, "user", {
    text: message,
  });
  return conversation.id;
}

type Executable = { execute?: (args: unknown, options: unknown) => Promise<unknown> };

async function palette(
  conversation_id: string,
  principal: ResolvedPrincipal,
  task_run?: TaskRunMarker,
) {
  const events: TurnEvent[] = [];
  const ctx = makeToolCtx({
    db: harness.server.db,
    tenant_id: harness.server.tenantId,
    conversation_id,
    actor_id: principal.id,
    principal,
    surface: "web",
    locale: "de",
    ...(task_run ? { task_run } : {}),
  });
  return (await wrapTools(
    ctx,
    freshSignals(),
    events,
    harness.server.db,
    [],
    {},
    principal,
  )) as unknown as Record<string, Executable>;
}

async function run(tools: Record<string, Executable>, name: string, args: Record<string, unknown>) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`${name} is not in the palette`);
  return await tool.execute(args, { toolCallId: `call-${name}`, messages: [] });
}

describe("the Cockpit chat palette runs device tools through the normal tool wrapper", () => {
  test("a covered read is dispatched and recorded like any finished tool call", async () => {
    const conversation_id = await chat("Zeig mir meine Downloads in /Users/anna/Downloads");
    const tools = await palette(conversation_id, browserPerson());
    expect(Object.keys(tools)).toContain("files_list");
    expect(Object.keys(tools)).toContain("browser_open");
    expect(Object.keys(tools)).not.toContain("computer_press");
    const listing = run(tools, "files_list", { path: "/Users/anna/Downloads" });
    const row = await waitFor(async () => {
      const rows = await harness.server.db
        .select()
        .from(conversationToolCalls)
        .where(eq(conversationToolCalls.conversation_id, conversation_id));
      return rows.find((entry) => entry.tool === "files_list");
    });
    const command_id = conversationCommandId({
      owner_kind: "conversation",
      owner_id: conversation_id,
      tool_call_id: row.id,
    });
    await answer(command_id, {
      status: "done",
      output: { entries: [{ name: "a.pdf" }] },
      evidence: {},
    });
    await listing;
    const stored = await latestCall(conversation_id, "files_list");
    expect(stored.outcome).toBe("ok");
    expect(JSON.stringify(stored.output)).toContain("⟦untrusted:listing⟧");
    expect(stored.confirmation_state).not.toBe("proposed");
  });

  test("ask → the person confirms in the chat → the device runs it and the turn sees the result", async () => {
    const conversation_id = await chat("Räum meine Downloads auf");
    const tools = await palette(conversation_id, browserPerson());
    await run(tools, "files_trash", { path: "/Users/anna/Downloads/old.zip" });
    const asked = await latestCall(conversation_id, "files_trash");
    const [elicitation] = await harness.server.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tool_call_id, asked.id));
    if (!elicitation) throw new Error("no confirmation card");
    const command_id = conversationCommandId({
      owner_kind: "conversation",
      owner_id: conversation_id,
      tool_call_id: asked.id,
    });
    expect(await commandRow(command_id)).toBeUndefined();
    getMockProvider().setConversePlan(conversation_id, [{ text: "Erledigt." }]);
    const responding = respondElicitationForTest(
      {
        tenant_id: harness.server.tenantId,
        conversation_id,
        elicitation_id: elicitation.id,
        actor_id: harness.server.userId,
        principal: browserPerson(),
        output: { confirmed: true },
        local_confirmations: deviceConfirmationPort(harness.server.db),
      },
      harness.server.db,
    );
    await answer(command_id, {
      status: "done",
      output: { items: [{ index: 0, status: "done" }] },
      evidence: {},
    });
    await responding;
    const settled = await latestCall(conversation_id, "files_trash");
    expect(settled.output).toEqual({ done: true, items: [{ index: 0, status: "done" }] });
    expect(settled.outcome).toBe("ok");
    expect(settled.confirmation_state).toBe("confirmed");
  });
});

describe("task runs", () => {
  async function taskRun(started_by: ResolvedPrincipal) {
    const owner = browserPerson();
    const task = await createTask(
      {
        tenant_id: harness.server.tenantId,
        principal: owner,
        input: {
          name: "Downloads sortieren",
          description: null,
          goal: "Sortiere jeden Montag meine Downloads in /Users/anna/Downloads",
          done_when: "Die Downloads sind sortiert",
          plan: {
            title: "Downloads sortieren",
            goal: "Sortiere jeden Montag meine Downloads in /Users/anna/Downloads",
            steps: [
              {
                id: "list",
                label: "Downloads ansehen",
                criterion: { kind: "assessment", description: "Liste liegt vor", result: null },
                depends_on: [],
                evidence_ids: [],
                note: null,
                progress: "open",
                next_action: null,
              },
            ],
            cancelled: false,
            completion_step_id: null,
          },
          bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
          environment: "dev",
          schedule_cron: null,
          schedule_timezone: null,
          schedule_run_at: null,
          max_turns: 20,
          run_deadline_minutes: 240,
        },
      },
      harness.server.db,
    );
    const started = await startTaskRun(
      { tenant_id: harness.server.tenantId, task_id: task.id, trigger: "manual", started_by },
      harness.server.db,
    );
    if (!started.admitted || !started.run.conversation_id) throw new Error("run not admitted");
    const marker: TaskRunMarker = {
      task_id: task.id,
      task_run_id: started.run.id,
      environment: "dev",
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
    };
    const principal: ResolvedPrincipal = {
      ...owner,
      auth_source: {
        kind: "task_run",
        task_id: task.id,
        task_run_id: started.run.id,
        grant_id: null,
      },
    };
    return {
      marker,
      principal,
      conversation_id: started.run.conversation_id,
      run_id: started.run.id,
    };
  }

  test("the owner's own run sees the tools and its covered step carries the task run", async () => {
    const run_ = await taskRun(browserPerson());
    const tools = await palette(run_.conversation_id, run_.principal, run_.marker);
    expect(Object.keys(tools)).toContain("files_list");
    const listing = run(tools, "files_list", { path: "/Users/anna/Downloads" });
    const row = await waitFor(async () => {
      const rows = await harness.server.db
        .select()
        .from(conversationToolCalls)
        .where(eq(conversationToolCalls.conversation_id, run_.conversation_id));
      return rows.find((entry) => entry.tool === "files_list");
    });
    const command_id = conversationCommandId({
      owner_kind: "task_run",
      owner_id: run_.run_id,
      tool_call_id: row.id,
    });
    await answer(command_id, { status: "done", output: { entries: [] }, evidence: {} });
    await listing;
    expect((await commandRow(command_id))?.task_run_id).toBe(run_.run_id);
    expect((await latestCall(run_.conversation_id, "files_list")).outcome).toBe("ok");
  });

  test("a run someone else started is refused before the device", async () => {
    const [role] = await harness.server.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, "admin"))
      .limit(1);
    const [other] = await harness.server.db
      .insert(users)
      .values({
        tenant_id: harness.server.tenantId,
        email: "someone-else@device.test",
        role_id: role?.id ?? "",
      })
      .returning({ id: users.id });
    if (!other) throw new Error("no second person");
    const run_ = await taskRun({ ...browserPerson(), id: other.id });
    const tools = await palette(run_.conversation_id, run_.principal, run_.marker);
    const refused = (await run(tools, "files_list", { path: "/Users/anna/Downloads" })) as {
      ok: boolean;
      error_code?: string;
    };
    expect(refused).toMatchObject({ ok: false });
    const stored = await latestCall(run_.conversation_id, "files_list");
    expect(JSON.stringify(stored.output)).toContain("not_started_by_person");
  });
});
