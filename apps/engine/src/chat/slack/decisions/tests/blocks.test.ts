import { describe, expect, test } from "bun:test";
import { SLACK_DECISION_COPY } from "../../../../http/i18n/slack-decisions.ts";
import {
  decisionActionId,
  isOpenAction,
  isSlackDecisionAction,
  parseDecisionAction,
} from "../action.ts";
import {
  absoluteLink,
  decidedBlocks,
  headerFromMessage,
  noticeBlocks,
  pendingDecisionBlocks,
  safeCockpitPath,
} from "../blocks.ts";

const APPROVAL = "00000000-0000-4000-8000-0000000000a1";
const de = SLACK_DECISION_COPY.de;
const en = SLACK_DECISION_COPY.en;

function actionsOf(blocks: Array<Record<string, unknown>>) {
  const actions = blocks.find((block) => block.type === "actions") as
    | { elements: Array<Record<string, unknown>> }
    | undefined;
  return actions?.elements ?? [];
}

function contextText(block: unknown): string {
  return (block as { elements: Array<{ text: string }> }).elements[0]?.text ?? "";
}

describe("decision action ids", () => {
  test("round-trips approve and decline and refuses anything else", () => {
    expect(parseDecisionAction(decisionActionId("approve", "tool_approval", APPROVAL))).toEqual({
      verb: "approve",
      kind: "tool_approval",
      subject_id: APPROVAL,
    });
    expect(parseDecisionAction(`sk_decide:decline:tool_approval:${APPROVAL}`)?.verb).toBe(
      "decline",
    );
    expect(parseDecisionAction(`approve:${APPROVAL}`)).toBeNull();
    expect(parseDecisionAction("sk_decide:approve:tool_approval:not-a-uuid")).toBeNull();
    expect(parseDecisionAction(`sk_decide:delete:tool_approval:${APPROVAL}`)).toBeNull();
    expect(isOpenAction(`sk_open:tool_approval:${APPROVAL}`)).toBe(true);
    expect(isSlackDecisionAction(`approve:${APPROVAL}`)).toBe(false);
  });
});

describe("pending decision card", () => {
  test("a decidable held run carries approve, decline and the deep link", () => {
    const link = absoluteLink("https://subkit.example.com", "/cockpit/tasks/t1");
    const blocks = pendingDecisionBlocks({
      copy: de,
      title: de.heldRunTitle("Weekly report"),
      detail: de.heldRunDetail("run_workflow"),
      kind: "tool_approval",
      subject_id: APPROVAL,
      decidable: true,
      cockpit_path: "/cockpit/tasks/t1",
      link,
    });
    const elements = actionsOf(blocks);
    expect(elements.map((e) => e.action_id)).toEqual([
      `sk_decide:approve:tool_approval:${APPROVAL}`,
      `sk_decide:decline:tool_approval:${APPROVAL}`,
      `sk_open:tool_approval:${APPROVAL}`,
    ]);
    expect(elements.map((e) => (e.text as { text: string }).text)).toEqual([
      de.approve,
      de.decline,
      de.open,
    ]);
    expect(elements[0]?.value).toBe("/cockpit/tasks/t1");
    expect(elements[2]?.url).toBe("https://subkit.example.com/cockpit/tasks/t1");
  });

  test("a browser-only decision gets only the deep link and says where to decide", () => {
    const blocks = pendingDecisionBlocks({
      copy: en,
      title: en.workflowApprovalTitle("Mail outbox"),
      detail: null,
      kind: "workflow",
      subject_id: APPROVAL,
      decidable: false,
      cockpit_path: "/cockpit/workflows/w1",
      link: "https://subkit.example.com/cockpit/workflows/w1",
    });
    expect(actionsOf(blocks).map((e) => e.action_id)).toEqual([`sk_open:workflow:${APPROVAL}`]);
    expect(JSON.stringify(blocks)).toContain(en.decideInSubkit);
  });

  test("deep links stay inside the Cockpit", () => {
    expect(safeCockpitPath("/cockpit/tasks/1")).toBe("/cockpit/tasks/1");
    expect(safeCockpitPath("https://evil.example.com")).toBeNull();
    expect(safeCockpitPath("/v1/api-keys")).toBeNull();
    expect(absoluteLink("", "/cockpit/tasks/1")).toBeNull();
  });
});

describe("message update payload", () => {
  const header = headerFromMessage({
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Held run*" } }],
  });

  test("shows the outcome, the Slack user, the SubKit person and the time, without buttons", () => {
    const blocks = decidedBlocks({
      copy: en,
      header,
      outcome: {
        state: "approved",
        slack_user_id: "U123",
        actor_name: "Ada <admin>",
        at: new Date("2026-11-23T10:00:00.000Z"),
      },
      kind: "tool_approval",
      subject_id: APPROVAL,
      link: "https://subkit.example.com/cockpit/tasks/t1",
    });
    expect(blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Held run*" } });
    const line = contextText(blocks[1]);
    expect(line).toBe(
      "Approved by <@U123> (Ada &lt;admin&gt;) · <!date^1795428000^{date_short_pretty} {time}|2026-11-23T10:00:00.000Z>",
    );
    expect(actionsOf(blocks).map((e) => e.action_id)).toEqual([
      `sk_open:tool_approval:${APPROVAL}`,
    ]);
  });

  test("already decided and expired states render their own line", () => {
    const line = (state: "already_declined" | "expired") =>
      contextText(
        decidedBlocks({
          copy: de,
          header: null,
          outcome: { state },
          kind: "tool_approval",
          subject_id: APPROVAL,
          link: null,
        })[0],
      );
    expect(line("already_declined")).toBe(de.alreadyDeclined);
    expect(line("expired")).toBe(de.expired);
  });

  test("the link prompt offers linking the account and the deep link", () => {
    const blocks = noticeBlocks({
      copy: de,
      text: de.notLinked,
      kind: "tool_approval",
      subject_id: APPROVAL,
      link: "https://subkit.example.com/cockpit/tasks/t1",
      link_account_url: "https://subkit.example.com/v1/integrations/slack/link?token=x",
    });
    expect(actionsOf(blocks).map((e) => (e.text as { text: string }).text)).toEqual([
      de.link,
      de.open,
    ]);
  });

  test("ignores a message header that is not a text section", () => {
    expect(headerFromMessage({ blocks: [{ type: "image" }] })).toBeNull();
    expect(headerFromMessage(null)).toBeNull();
  });
});
