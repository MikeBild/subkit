import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingElicitation } from "@cli-core/index.ts";
import { cleanup } from "ink-testing-library";
import {
  framesOf,
  histDirs,
  pressEnter,
  renderApp,
  tick,
  type,
  waitForFrame,
} from "./ink-app-fixtures.tsx";

let __homeTempDir: string | undefined;

let __originalHome: string | undefined;

beforeAll(() => {
  __homeTempDir = mkdtempSync(join(tmpdir(), "subkit-ink-app-home-"));
  __originalHome = process.env.HOME;
  process.env.HOME = __homeTempDir;
});

afterAll(() => {
  if (__originalHome !== undefined) process.env.HOME = __originalHome;
  else delete process.env.HOME;
  if (__homeTempDir) rmSync(__homeTempDir, { recursive: true, force: true });
});

afterEach(() => {
  cleanup();
  while (histDirs.length > 0) {
    const d = histDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
  if (__homeTempDir) {
    const subkitDir = join(__homeTempDir, ".subkit");
    try {
      rmSync(subkitDir, { recursive: true, force: true });
    } catch {}
  }
});

describe("ink-app: journey 12 — modal panes", () => {
  test("AC1: /status renders a StatusPane with the host-supplied rows", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "status",
          title: "status",
          subtitle: "journey",
          rows: [
            ["user", "user@example.com"],
            ["tenant", "tenant-alpha"],
            ["connectors", 7],
            ["tokens · today", 128],
          ],
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/status");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("status");
    expect(frame).toContain("user@example.com");
    expect(frame).toContain("tenant-alpha");
    expect(frame).toContain("connectors");
    expect(frame).toContain("128");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1b: /help renders in the modal slot as a text pane, not inline", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("subkit — slash commands");
    expect(frame).toContain("admin");
    expect(frame).toContain("/clear");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1c: /cost opens a text pane sourced from session usage + status snapshot", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "text",
          title: "cost",
          lines: [
            "tokens · this turn   42",
            "remaining · monthly  9,958",
            "tokens · today       128",
          ],
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/cost");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("cost");
    expect(frame).toContain("tokens · this turn");
    expect(frame).toContain("9,958");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1d: dedicated context pane renders skill and attachment state", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "context",
          title: "conversation context",
          snapshot: {
            conversation_id: "c1",
            connector_id: null,
            workflow_id: "wf-1",
            draft_mode: "workflow_authoring",
            authoring_mode: "workflow",
            authoring_stage: "workflow_previewed",
            draft_summary: {
              readiness: "ready_to_probe",
              next_action: "Preview before commit.",
              next_required_action: "Preview before commit.",
              next_suggested_tool: "dry_run_workflow",
              missing_fields: [],
              progress_label: "1 workflow step",
              lifecycle_state: "draft_only",
              blocked_by: [],
            },
            active_target: {
              kind: "workflow",
              name: "demo-flow",
              slug: "demo-flow",
              id: "wf-1",
              environment: null,
              lifecycle_state: "draft_only",
            },
            checkpoint_statuses: [],
            stale_checkpoints: [],
            next_required_action: "Preview before commit.",
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
            skills: {
              global: [{ id: "sg", title: "global skill" }],
              connector: [],
              workflow: [{ id: "sw", title: "workflow skill" }],
              total: 2,
            },
            messages: { total: 4, last_role: "assistant" },
            tool_calls_total: 3,
            pending_elicitations: 1,
            attachments: {
              total: 1,
              items: [{ slug: "spec", filename: "openapi.yaml", bytes: 1234 }],
            },
            latest_probe: null,
            latest_preview: null,
            workflow_version: { workflow_id: "wf-1", current_version: 3 },
            last_context_budget: {
              cap_tokens: 100000,
              total_tokens: 42000,
              dropped_sections: ["recorded_endpoint_samples"],
              assembled_at: "2026-01-01T00:00:00.000Z",
            },
            grounding_status: null,
          },
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/context");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("conversation context");
    expect(frame).toContain("workflow skill");
    expect(frame).toContain("@attachment:spec");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1e: dedicated approval-history pane renders approval rows", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "approval-history",
          title: "approval history",
          items: [
            {
              tool: "ask_user_confirm",
              created_at: "2026-04-19T10:00:00.000Z",
              summary: "Commit the workflow?",
              status: "approved",
            },
          ],
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/approvals");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("approval history");
    expect(frame).toContain("approved");
    expect(frame).toContain("Commit the workflow?");
    instance.unmount();
  });

  test("AC1f: /setup renders the dedicated setup diagnostics pane", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "setup-diagnostics",
          title: "setup",
          setup: {
            overall_status: "warn",
            summary_counts: {
              blockers: 0,
              warnings: 1,
              sections_blocked: 0,
              sections_warn: 1,
            },
            sections: {
              auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
              llm: { title: "LLM", status: "ok", issues: [], recommendations: [], values: [] },
              datastore: {
                title: "Datastore",
                status: "ok",
                issues: [],
                recommendations: [],
                values: [
                  {
                    key: "DATABASE_URL",
                    value: "postgres://user@db:5432/subkit",
                    status_hint: null,
                  },
                ],
              },
              storage: {
                title: "Object storage",
                status: "ok",
                issues: [],
                recommendations: [],
                values: [],
              },
              crypto: {
                title: "Crypto",
                status: "ok",
                issues: [],
                recommendations: [],
                values: [],
              },
              public_urls: {
                title: "Public URLs",
                status: "warn",
                issues: [
                  {
                    id: "public-base-url",
                    severity: "warning",
                    title: "Public base URL",
                    detail: "PUBLIC_BASE_URL is not set.",
                  },
                ],
                recommendations: ["Set PUBLIC_BASE_URL to the externally reachable engine URL."],
                values: [{ key: "PUBLIC_BASE_URL", value: null, status_hint: "Missing" }],
              },
            },
            issues: [
              {
                id: "public-base-url",
                severity: "warning",
                title: "Public base URL",
                detail: "PUBLIC_BASE_URL is not set.",
              },
            ],
            recommendations: ["Set PUBLIC_BASE_URL to the externally reachable engine URL."],
          },
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/setup");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("setup");
    expect(frame).toContain("Public URLs");
    expect(frame).toContain("PUBLIC_BASE_URL");
    expect(frame).toContain("Missing");
    instance.unmount();
  });

  test("AC2: /resume opens a ConversationBrowser and Enter calls onSelectConversation", async () => {
    const selected: { current: string | null } = { current: null };
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "conversations",
          items: [
            { id: "c-aaaaaaaa-0000", title: "invoice digest", updated_at: "2026-04-17T14:00:00Z" },
            { id: "c-bbbbbbbb-1111", title: "hubspot export", updated_at: "2026-04-16T09:30:00Z" },
          ],
        });
        return null;
      },
      onSelectConversation: async (id) => {
        selected.current = id;
      },
    });
    await tick();
    await type(instance, "/resume");
    await pressEnter(instance);
    await tick(60);
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("resume conversation");
    expect(frame).toContain("invoice digest");
    expect(frame).toContain("hubspot export");
    instance.stdin.write("\r");
    await tick(60);
    expect(selected.current).toBe("c-aaaaaaaa-0000");
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("resume conversation");
    instance.unmount();
  });
});

describe("ink-app: journey 11 — approval hygiene", () => {
  test("AC1: /approve with no pending elicitation surfaces a helpful message", async () => {
    const instance = renderApp({
      onElicitResponse: async () => {
        throw new Error("should not be called");
      },
    });
    await tick();
    await type(instance, "/approve");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("no pending approval");
    instance.unmount();
  });

  test("bare-text 'approve' with no pending elicitation is forwarded as a plain prompt (no free-text classification of confirmation words)", async () => {
    let promptCalled = false;
    const instance = renderApp({
      onPrompt: async () => {
        promptCalled = true;
        return {
          events: framesOf({ type: "completed", status: "completed" }),
          conversationId: "c-noop",
        };
      },
      onElicitResponse: async () => {
        throw new Error("should not be called");
      },
    });
    await tick();
    await type(instance, "approve");
    await pressEnter(instance);
    await tick(60);
    expect(promptCalled).toBe(true);
    instance.unmount();
  });

  test("AC1c: a second /approve while the engine is still processing is a no-op", async () => {
    const elicit: PendingElicitation = {
      id: "b1-00000000-0000-0000-0000-000000000000",
      tool_name: "ask_user_confirm",
      summary: "confirm step",
      input: { kind: "generic" },
    };
    let respondCalls = 0;
    const releaseRef: { fn: (() => void) | null } = { fn: null };
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "elicit_request",
            elicitation_id: elicit.id,
            tool_name: elicit.tool_name,
            summary: elicit.summary,
            input: elicit.input,
          },
          { type: "completed", status: "awaiting_input" },
        ),
        conversationId: "c-x",
      }),
      onElicitResponse: async () => {
        respondCalls += 1;
        await new Promise<void>((resolve) => {
          releaseRef.fn = resolve;
        });
        return { events: framesOf({ type: "completed", status: "completed" }) };
      },
    });
    await tick();
    await type(instance, "kick off");
    await pressEnter(instance);
    await tick(80);
    await type(instance, "/approve");
    await pressEnter(instance);
    await tick(20);
    await type(instance, "/approve");
    await pressEnter(instance);
    await tick(20);
    expect(respondCalls).toBe(1);
    releaseRef.fn?.();
    await tick(40);
    instance.unmount();
  });

  test("AC2: elicitation with a generic confirm falls back to the generic body", async () => {
    const other: PendingElicitation = {
      id: "a9-00000000-0000-0000-0000-000000000000",
      tool_name: "ask_user_confirm",
      summary: "review the change",
      input: { kind: "generic", diff: { note: "freeform" } },
    };
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "elicit_request",
            elicitation_id: other.id,
            tool_name: other.tool_name,
            summary: other.summary,
            input: other.input,
          },
          { type: "completed", status: "awaiting_input" },
        ),
        conversationId: "c-other",
      }),
    });
    await tick();
    await type(instance, "review please");
    await pressEnter(instance);
    await tick(100);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("confirm: generic");
    expect(frame).toContain("review the change");
    instance.unmount();
  });
});

describe("ink-app: journey 12 — onboarding and transcript controls", () => {
  test("AC1: quick-start actions render on first paint and `2` prefills a connector prompt", async () => {
    const instance = renderApp();
    await tick();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("start with");
    expect(frame).toContain("Resume recent");
    expect(frame).toContain("Create a connector");
    expect(frame).toContain("Inspect tenant state");
    instance.stdin.write("2");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("I want to create a connector.");
    expect(frame).toContain("probe before saving");
    instance.unmount();
  });

  test("AC1b: quick-start action `5` prefills surface-help guidance", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("5");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("I want help using subkit surfaces");
    expect(frame).toContain("If something is not exposed in this conversation surface");
    instance.unmount();
  });

  test("AC2: background tools stay hidden in chat view and appear in inspect view", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          { type: "tool_call_start", call_id: "bg-1", tool: "list_workflows" },
          { type: "tool_result", call_id: "bg-1", tool: "list_workflows", output: { ok: true } },
          { type: "tool_call_start", call_id: "bg-2", tool: "search_knowledge" },
          {
            type: "tool_result",
            call_id: "bg-2",
            tool: "search_knowledge",
            output: { ok: true },
          },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-bg",
      }),
    });
    await tick();
    await type(instance, "look around");
    await pressEnter(instance);
    await tick(80);
    let frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("background actions");
    expect(frame).not.toContain("list_workflows");
    instance.stdin.write("\x0f");
    await waitForFrame(instance, (f) => f.includes("background actions"));
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("background actions");
    expect(frame).toContain("list_workflows");
    expect(frame).toContain("searched knowledge");
    instance.unmount();
  });

  test("AC3: Ctrl-O toggles the transcript mode and Esc dismisses sticky errors", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/does-not-exist");
    await pressEnter(instance);
    await tick(40);
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("error");
    expect(frame).toContain("unknown slash");
    instance.stdin.write("\x1b");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("unknown slash");
    instance.stdin.write("\x0f");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ctrl-o chat");
    expect(frame).toContain("inspect");
    instance.unmount();
  });
});
