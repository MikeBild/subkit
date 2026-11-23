import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import {
  CONVERSATION,
  confirmCall,
  conversationRecord,
  follow,
  LATER,
  outcome,
  pendingApproval,
  textMessage,
  workflowTarget,
} from "./conversation-journey-fixtures";
import { journeys, mount, stream } from "./journey-fixtures";
import {
  BASE_PERMISSIONS,
  NOW,
  RUN,
  runDetail,
  USER,
  WORKFLOW,
  workflow,
} from "./workspace-journey-fixtures";

const isolated = journeys(import.meta.path);

const SAVE = "a1111111-1111-4111-8111-111111111111";
const SAVE_CALL = "a2222222-2222-4222-8222-222222222222";
const RUN_ONCE = "a3333333-3333-4333-8333-333333333333";
const RUN_CALL = "a4444444-4444-4444-8444-444444444444";
const RECEIPT = "a5555555-5555-4555-8555-555555555555";
const AUTHORITY = "a6666666-6666-4666-8666-666666666666";
const DIGEST = "a".repeat(64);
const TITLE = "TestFlight invite";
const PROMPT = "Invite every new tester to TestFlight by Gmail.";
const SAVE_QUESTION = "Save the workflow draft?";
const RUN_QUESTION = "Run the workflow once now?";

type Stage = "draft" | "saved" | "ran";

function detail(stage: Stage) {
  const saveCall = confirmCall(SAVE_CALL, SAVE_QUESTION, "save_workflow_draft");
  const runCall = confirmCall(RUN_CALL, RUN_QUESTION, "run_workflow", workflow.slug);
  const pending =
    stage === "draft"
      ? pendingApproval(SAVE, SAVE_CALL, SAVE_QUESTION)
      : stage === "saved"
        ? pendingApproval(RUN_ONCE, RUN_CALL, RUN_QUESTION)
        : null;
  return {
    conversation: conversationRecord(TITLE, pending ? "awaiting_input" : "active"),
    owner: { id: USER, kind: "user", name: "Mira" },
    created_resources:
      stage === "draft"
        ? []
        : [{ kind: "workflow", id: WORKFLOW, name: workflow.name, slug: workflow.slug }],
    messages: [
      textMessage("m1", "user", PROMPT),
      textMessage("m2", "assistant", "The draft reads new testers and sends one invite each."),
    ],
    tool_calls: stage === "draft" ? [saveCall] : [saveCall, runCall],
    draft: null,
    playbook: null,
    resume_summary: {
      active_target: workflowTarget,
      stage:
        stage === "draft" ? "workflow_draft" : stage === "saved" ? "workflow_saved" : "run_focus",
      focused_run: null,
      live_test: stage === "ran" ? { execution_id: RUN, status: "succeeded" } : null,
      last_successful_probe: null,
      last_successful_preview: null,
      unsaved: stage === "draft",
      pending_approval: pending,
    },
  };
}

function receipt(activate: boolean, completed: boolean) {
  const grant = { environment: "prod", valid_from: NOW, valid_until: null, max_runs: null };
  return {
    receipt_id: RECEIPT,
    status: completed ? "completed" : "pending",
    snapshot_digest: DIGEST,
    expires_at: LATER,
    workflow_name: workflow.name,
    workflow_slug: workflow.slug,
    reviewed_version_number: null,
    environment: "prod",
    description: "Reads new testers and sends one invite each.",
    checks: [],
    effects: [
      {
        step_id: "send",
        connector_name: "Gmail",
        connector_slug: "gmail",
        effect: "write",
        target: "messages.send",
        details: [],
      },
    ],
    affected_triggers: [],
    actions: { activate, grant: activate ? grant : null, schedule: null },
    suggested_actions: { activate: true, grant, schedule: null },
    result: completed
      ? {
          workflow_id: WORKFLOW,
          authority_id: AUTHORITY,
          schedule_id: null,
          saved: true,
          activated: activate,
          granted: activate,
          pair_request_id: null,
        }
      : null,
  };
}

async function chatToRun(locale: Locale) {
  let stage: Stage | null = null;
  const bodies: Record<string, unknown[]> = {};
  const record = (key: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    bodies[key] = [...(bodies[key] ?? []), body];
    return body as Record<string, unknown>;
  };
  const base = `/v1/conversations/${CONVERSATION}`;
  const app = await mount("/chat/new", {
    locale,
    permissions: [...BASE_PERMISSIONS, "conversation:read"],
    routes: {
      "POST /v1/conversations": (_url, init) => {
        record("start", init);
        stage = "draft";
        return stream([
          ["conversation_started", { conversation: conversationRecord(TITLE, "awaiting_input") }],
          outcome(conversationRecord(TITLE, "awaiting_input"), "awaiting_input"),
        ]);
      },
      "/v1/conversations": () => ({
        items: stage ? [conversationRecord(TITLE)] : [],
        next_cursor: null,
      }),
      [base]: () => detail(stage ?? "draft"),
      [`${base}/tool-policies`]: () => ({ policies: {}, eligible_no_confirm_tools: [] }),
      [`POST ${base}/workflow-reviews`]: (_url, init) =>
        receipt(record("review", init).activate === true, false),
      [`POST ${base}/workflow-reviews/${RECEIPT}/finalize`]: (_url, init) => {
        record("finalize", init);
        stage = "saved";
        return receipt(true, true);
      },
      [`POST ${base}/elicitations/${RUN_ONCE}/respond`]: (_url, init) => {
        record("run", init);
        stage = "ran";
        return stream([outcome(conversationRecord(TITLE))]);
      },
      [`/v1/executions/${RUN}`]: () => runDetail,
    },
  });
  app.at("/chat/new");
  await app.fill("chat-composer-input", PROMPT);
  await app.click("chat-composer-submit");
  expect(app.seen).toContain("POST /v1/conversations");
  expect(bodies.start?.[0]).toMatchObject({ initial_message: PROMPT });
  app.at(`/chat/${CONVERSATION}`);
  expect(app.text()).toContain(PROMPT);

  expect(app.find("chat-approval")?.textContent).toContain(app.t("chat.decision.saveTitle"));
  expect(app.find("chat-approval-approve")?.textContent).toBe(app.t("reviewWorkflow.open"));
  expect(app.missingKeys()).toEqual([]);
  await app.click("chat-approval-approve");
  expect(app.seen).toContain(`POST ${base}/workflow-reviews`);
  expect(app.text()).toContain(app.t("reviewWorkflow.title"));
  expect(app.text()).toContain(`@${workflow.slug}`);

  const grant = app.dom.window.document.querySelector<HTMLInputElement>(
    'input[type="checkbox"][id$="-grant"]',
  );
  if (!grant) throw new Error("the environment grant is missing in the review");
  await app.clickElement(grant);
  expect(bodies.review?.at(-1)).toMatchObject({
    elicitation_id: SAVE,
    activate: true,
    grant: { environment: "prod" },
  });
  expect(app.text()).toContain(app.t("run.environment.prod"));
  expect(app.find("workflow-review-confirm")?.textContent).toBe(
    app.t("reviewWorkflow.confirmGrant"),
  );
  await app.click("workflow-review-confirm");
  expect(bodies.finalize?.[0]).toEqual({ expected_snapshot_digest: DIGEST });
  expect(app.text()).toContain(app.t("reviewWorkflow.completedGrant"));
  await app.click("workflow-review-complete-close");

  expect(app.find("chat-approval")?.textContent).toContain(app.t("chat.singleRun.title"));
  await app.click("chat-approval-approve");
  expect(bodies.run?.[0]).toEqual({ output: { confirmed: true } });
  expect(app.find("chat-approval")).toBeNull();
  expect(app.find("chat-live-test-result")?.textContent).toContain(
    app.t("chat.liveTest.succeeded"),
  );

  await follow(app, "chat-live-test-run");
  app.at(`/runs/${RUN}`);
  expect(app.text()).toContain(runDetail.result_markdown);
  expect(app.find("run-detail-audit")?.textContent).toBe(app.t("runs.detail.audit"));
  await follow(app, "run-detail-audit");
  app.at("/audit");
  const search = new URLSearchParams(app.dom.window.location.search);
  expect([...search.values()]).toContain(RUN);
  expect(app.missingKeys()).toEqual([]);
}

isolated("Chat (de) › describe › draft › review › approve the environment › run › audit", () =>
  chatToRun("de"),
);

isolated("Chat (en) › describe › draft › review › approve the environment › run › audit", () =>
  chatToRun("en"),
);
