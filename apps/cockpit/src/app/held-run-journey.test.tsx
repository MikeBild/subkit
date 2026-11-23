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
  stream,
  textMessage,
  workflowTarget,
} from "./conversation-journey-fixtures";
import {
  attentionItem,
  attentionWith,
  BASE_PERMISSIONS,
  journeys,
  mount,
  RUN,
  run,
  runDetail,
  USER,
  workflow,
} from "./journey-fixtures";

const isolated = journeys(import.meta.path);

const ELICITATION = "77777777-7777-4777-8777-777777777777";
const CALL = "88888888-8888-4888-8888-888888888888";
const TITLE = "Weekly invoice export";
const QUESTION = "Release the held writes?";

const heldCall = confirmCall(CALL, QUESTION, "commit_held_workflow_writes", workflow.slug);

function detail(released: boolean) {
  return {
    conversation: conversationRecord(TITLE, released ? "active" : "awaiting_input"),
    owner: { id: USER, kind: "user", name: "Mira" },
    created_resources: [],
    messages: [
      textMessage("m1", "user", "Send the weekly invoice export."),
      textMessage("m2", "assistant", "The run is held until you release its writes."),
    ],
    tool_calls: [released ? { ...heldCall, confirmation_state: "approved" } : heldCall],
    draft: null,
    playbook: null,
    resume_summary: {
      active_target: workflowTarget,
      stage: released ? "run_focus" : "awaiting_approval",
      focused_run: null,
      live_test: { execution_id: RUN, status: released ? "running" : "queued" },
      last_successful_probe: null,
      last_successful_preview: null,
      unsaved: false,
      pending_approval: released ? null : pendingApproval(ELICITATION, CALL, QUESTION),
    },
  };
}

const heldItem = attentionItem({
  id: `conversation:${CONVERSATION}`,
  class: "stopped",
  severity: "urgent",
  kind: "conversation",
  subject: { kind: "conversation", id: CONVERSATION, name: TITLE },
  reason: "awaiting_answer",
  deadline: LATER,
  actions: [
    {
      verb: "answer",
      href: `/cockpit/chat/${CONVERSATION}`,
      primary: true,
      permission: "conversation:write",
    },
  ],
});

async function heldRunContinues(locale: Locale) {
  let released = false;
  let answer: unknown = null;
  const running = { ...runDetail, status: "running", finished_at: null, outcome: null };
  const respond = `/v1/conversations/${CONVERSATION}/elicitations/${ELICITATION}/respond`;
  const app = await mount("/", {
    locale,
    permissions: [...BASE_PERMISSIONS, "conversation:read"],
    routes: {
      "/v1/attention": () => attentionWith(released ? [] : [heldItem]),
      [`/v1/conversations/${CONVERSATION}`]: () => detail(released),
      [`POST ${respond}`]: (_url, init) => {
        answer = JSON.parse(String(init?.body));
        released = true;
        return stream([outcome(conversationRecord(TITLE))]);
      },
      "/v1/conversations": () => ({ items: [conversationRecord(TITLE)], next_cursor: null }),
      [`/v1/executions/${RUN}`]: () => (released ? running : runDetail),
      "/v1/executions": () => ({ items: [{ ...run, status: "running" }], next_cursor: null }),
    },
  });
  expect(app.find("attention-item-0-primary")?.textContent).toBe(app.t("overview.action.answer"));
  await app.click("attention-item-0-primary");
  app.at(`/chat/${CONVERSATION}`);
  expect(app.find("chat-approval")?.textContent).toContain(app.t("chat.singleRun.title"));
  expect(app.find("chat-approval-approve")?.textContent).toBe(app.t("chat.singleRun.confirm"));
  expect(app.find("chat-live-test-result")?.textContent).toContain(app.t("chat.liveTest.pending"));
  expect(app.missingKeys()).toEqual([]);

  await app.click("chat-approval-approve");
  expect(app.seen).toContain(`POST ${respond}`);
  expect(answer).toEqual({ output: { confirmed: true } });
  app.at(`/chat/${CONVERSATION}`);
  expect(app.find("chat-approval")).toBeNull();
  expect(app.find("chat-live-test-result")?.textContent).toContain(app.t("chat.liveTest.running"));

  await follow(app, "chat-live-test-run");
  app.at(`/runs/${RUN}`);
  expect(app.find("run-page")).not.toBeNull();
  expect(app.missingKeys()).toEqual([]);

  await app.go("/");
  app.at("/");
  expect(app.find("attention-item-0-primary")).toBeNull();
}

isolated("Held run (de) › Braucht dich › release › the run continues", () =>
  heldRunContinues("de"),
);

isolated("Held run (en) › Needs you › release › the run continues", () => heldRunContinues("en"));
