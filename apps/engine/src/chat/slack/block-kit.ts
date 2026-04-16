// Block Kit renderers for the Slack adapter.
//
// Kept small and deterministic so tests can assert on exact JSON.

import type { ApprovalCard, ChatDelivery } from "../types.ts";

export interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

export function renderMessageBlocks(delivery: ChatDelivery): SlackBlock[] {
  if (Array.isArray(delivery.blocks)) return delivery.blocks as SlackBlock[];
  if (!delivery.text) return [];
  return [{ type: "section", text: { type: "mrkdwn", text: delivery.text } }];
}

export function renderApprovalBlocks(card: ApprovalCard): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${card.summary}*` },
    },
    ...(card.body ? [{ type: "section", text: { type: "mrkdwn", text: card.body } }] : []),
    {
      type: "actions",
      block_id: `subkit_approval:${card.approval_id}`,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: `approve:${card.approval_id}`,
          value: card.conversation_id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          action_id: `reject:${card.approval_id}`,
          value: card.conversation_id,
        },
      ],
    },
  ];
}
