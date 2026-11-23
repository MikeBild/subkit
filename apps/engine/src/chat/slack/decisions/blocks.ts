import type { SlackDecisionCopy } from "../../../http/index.ts";
import { type DecisionKind, decisionActionId, openActionId } from "./action.ts";

export interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

export const DECISION_BLOCK_ID = "sk_decision";
const COCKPIT_PATH = /^\/cockpit[A-Za-z0-9/_.~?=&%:#-]{0,500}$/;

export function safeCockpitPath(value: unknown): string | null {
  return typeof value === "string" && COCKPIT_PATH.test(value) ? value : null;
}

export function absoluteLink(baseUrl: string, path: string | null): string | null {
  if (!path || !baseUrl) return null;
  try {
    const url = new URL(path, baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function mrkdwnEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function titleBlock(title: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: `*${mrkdwnEscape(title)}*` } };
}

function contextBlock(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function openButton(
  copy: SlackDecisionCopy,
  link: string,
  kind: string,
  subject_id: string,
): SlackBlock {
  return {
    type: "button",
    text: { type: "plain_text", text: copy.open },
    url: link,
    action_id: openActionId(kind, subject_id),
  };
}

export interface PendingDecisionCard {
  copy: SlackDecisionCopy;
  title: string;
  detail: string | null;
  kind: DecisionKind | "task_run" | "workflow";
  subject_id: string;
  decidable: boolean;
  cockpit_path: string | null;
  link: string | null;
}

export function pendingDecisionBlocks(card: PendingDecisionCard): SlackBlock[] {
  const blocks: SlackBlock[] = [titleBlock(card.title)];
  if (card.detail) blocks.push(contextBlock(mrkdwnEscape(card.detail)));
  if (!card.decidable) blocks.push(contextBlock(card.copy.decideInSubkit));
  const elements: SlackBlock[] = [];
  if (card.decidable && card.kind === "tool_approval") {
    const value = card.cockpit_path ?? "";
    elements.push(
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: card.copy.approve },
        action_id: decisionActionId("approve", card.kind, card.subject_id),
        value,
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: card.copy.decline },
        action_id: decisionActionId("decline", card.kind, card.subject_id),
        value,
      },
    );
  }
  if (card.link) elements.push(openButton(card.copy, card.link, card.kind, card.subject_id));
  if (elements.length > 0) blocks.push({ type: "actions", block_id: DECISION_BLOCK_ID, elements });
  return blocks;
}

export type DecisionOutcome =
  | { state: "approved" | "declined"; slack_user_id: string; actor_name: string; at: Date }
  | { state: "already_approved"; by: string | null }
  | { state: "already_declined" | "already_used" | "expired" | "not_found" };

function slackDate(at: Date): string {
  const unix = Math.floor(at.getTime() / 1000);
  return `<!date^${unix}^{date_short_pretty} {time}|${at.toISOString()}>`;
}

export function outcomeLine(copy: SlackDecisionCopy, outcome: DecisionOutcome): string {
  switch (outcome.state) {
    case "approved":
    case "declined": {
      const who = `<@${outcome.slack_user_id}> (${mrkdwnEscape(outcome.actor_name)})`;
      return outcome.state === "approved"
        ? copy.approvedBy(who, slackDate(outcome.at))
        : copy.declinedBy(who, slackDate(outcome.at));
    }
    case "already_approved":
      return copy.alreadyApproved(outcome.by ? mrkdwnEscape(outcome.by) : null);
    case "already_declined":
      return copy.alreadyDeclined;
    case "already_used":
      return copy.alreadyUsed;
    case "expired":
      return copy.expired;
    case "not_found":
      return copy.notFound;
  }
}

export interface DecidedCard {
  copy: SlackDecisionCopy;
  header: SlackBlock | null;
  outcome: DecisionOutcome;
  kind: string;
  subject_id: string;
  link: string | null;
}

export function decidedBlocks(card: DecidedCard): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (card.header) blocks.push(card.header);
  blocks.push(contextBlock(outcomeLine(card.copy, card.outcome)));
  if (card.link)
    blocks.push({
      type: "actions",
      block_id: DECISION_BLOCK_ID,
      elements: [openButton(card.copy, card.link, card.kind, card.subject_id)],
    });
  return blocks;
}

export function noticeBlocks(p: {
  copy: SlackDecisionCopy;
  text: string;
  kind: string;
  subject_id: string;
  link: string | null;
  link_account_url?: string | null;
}): SlackBlock[] {
  const elements: SlackBlock[] = [];
  if (p.link_account_url)
    elements.push({
      type: "button",
      style: "primary",
      text: { type: "plain_text", text: p.copy.link },
      url: p.link_account_url,
      action_id: openActionId("slack_link", p.subject_id),
    });
  if (p.link) elements.push(openButton(p.copy, p.link, p.kind, p.subject_id));
  return [
    { type: "section", text: { type: "mrkdwn", text: p.text } },
    ...(elements.length > 0 ? [{ type: "actions", elements }] : []),
  ];
}

export function headerFromMessage(message: unknown): SlackBlock | null {
  if (!message || typeof message !== "object") return null;
  const blocks = (message as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  const first = blocks[0] as { type?: unknown; text?: { type?: unknown; text?: unknown } };
  if (first?.type !== "section" || typeof first.text?.text !== "string") return null;
  if (first.text.type !== "mrkdwn" && first.text.type !== "plain_text") return null;
  return { type: "section", text: { type: first.text.type, text: first.text.text.slice(0, 3000) } };
}
