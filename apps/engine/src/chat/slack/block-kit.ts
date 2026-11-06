import { encodeInteractionEnvelope } from "../api.ts";
import type { ApprovalCard, ChatDelivery, ChatElicitation, ElicitationField } from "../types.ts";

interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

interface SlackView {
  type: "modal";
  callback_id: string;
  title: { type: "plain_text"; text: string };
  submit?: { type: "plain_text"; text: string };
  close?: { type: "plain_text"; text: string };
  private_metadata?: string;
  blocks: SlackBlock[];
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

export function renderInlineElicitationBlocks(elicitation: ChatElicitation): SlackBlock[] | null {
  const header: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${elicitation.summary}*` } },
    ...(elicitation.body
      ? [{ type: "section", text: { type: "mrkdwn", text: elicitation.body } }]
      : []),
  ];

  if (elicitation.kind === "confirm") {
    return [
      ...header,
      {
        type: "actions",
        block_id: `subkit_elicit:${elicitation.id}`,
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            action_id: `elicit:${elicitation.id}:confirm`,
            value: encodeInteractionEnvelope(elicitation.conversation_id, { confirmed: true }),
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            action_id: `elicit:${elicitation.id}:confirm`,
            value: encodeInteractionEnvelope(elicitation.conversation_id, { confirmed: false }),
          },
        ],
      },
    ];
  }

  if (elicitation.kind === "choice") {
    const options = elicitation.options ?? [];
    if (options.length === 0) return header;
    if (options.length <= 5) {
      return [
        ...header,
        {
          type: "actions",
          block_id: `subkit_elicit:${elicitation.id}`,
          elements: options.map((opt) => ({
            type: "button",
            text: { type: "plain_text", text: opt.label ?? opt.value },
            action_id: `elicit:${elicitation.id}:choice`,
            value: encodeInteractionEnvelope(elicitation.conversation_id, { value: opt.value }),
          })),
        },
      ];
    }
    return [
      ...header,
      {
        type: "section",
        block_id: `subkit_elicit:${elicitation.id}`,
        text: { type: "mrkdwn", text: " " },
        accessory: {
          type: "static_select",
          action_id: `elicit:${elicitation.id}:choice`,
          placeholder: { type: "plain_text", text: "Select…" },
          options: options.map((opt) => ({
            text: { type: "plain_text", text: opt.label ?? opt.value },
            value: encodeInteractionEnvelope(elicitation.conversation_id, { value: opt.value }),
          })),
        },
      },
    ];
  }

  if (elicitation.kind === "multi") {
    const options = elicitation.options ?? [];
    return [
      ...header,
      {
        type: "section",
        block_id: `subkit_elicit_opts:${elicitation.id}`,
        text: { type: "mrkdwn", text: " " },
        accessory: {
          type: "checkboxes",
          action_id: `elicit:${elicitation.id}:multi:select`,
          options: options.map((opt) => ({
            text: { type: "plain_text", text: opt.label ?? opt.value },
            value: opt.value,
          })),
        },
      },
      {
        type: "actions",
        block_id: `subkit_elicit:${elicitation.id}`,
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Submit" },
            action_id: `elicit:${elicitation.id}:multi:submit`,
            value: encodeInteractionEnvelope(elicitation.conversation_id, { kind: "multi" }),
          },
        ],
      },
    ];
  }

  return null;
}

export function renderOpenFormBlocks(elicitation: ChatElicitation): SlackBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${elicitation.summary}*` } },
    ...(elicitation.body
      ? [{ type: "section", text: { type: "mrkdwn", text: elicitation.body } }]
      : []),
    {
      type: "actions",
      block_id: `subkit_elicit_open:${elicitation.id}`,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Antworten" },
          action_id: `open_elicit:${elicitation.id}`,
          value: encodeInteractionEnvelope(elicitation.conversation_id, {}),
        },
      ],
    },
  ];
}

function fieldToInputBlock(field: ElicitationField): SlackBlock {
  const block_id = `field:${field.name}`;
  const action_id = `el:${field.name}`;
  const labelText = field.label ?? field.name;

  if (field.type === "select") {
    return {
      type: "input",
      block_id,
      optional: !field.required,
      label: { type: "plain_text", text: labelText },
      element: {
        type: "static_select",
        action_id,
        ...(field.placeholder
          ? { placeholder: { type: "plain_text", text: field.placeholder } }
          : {}),
        options: (field.options ?? []).map((opt) => ({
          text: { type: "plain_text", text: opt.label ?? opt.value },
          value: opt.value,
        })),
        ...(field.default
          ? {
              initial_option: {
                text: {
                  type: "plain_text",
                  text:
                    (field.options ?? []).find((o) => o.value === field.default)?.label ??
                    field.default,
                },
                value: field.default,
              },
            }
          : {}),
      },
    };
  }

  if (field.type === "date") {
    return {
      type: "input",
      block_id,
      optional: !field.required,
      label: { type: "plain_text", text: labelText },
      element: {
        type: "datepicker",
        action_id,
        ...(field.default ? { initial_date: field.default } : {}),
      },
    };
  }

  return {
    type: "input",
    block_id,
    optional: !field.required,
    label: { type: "plain_text", text: labelText },
    element: {
      type: "plain_text_input",
      action_id,
      ...(field.type === "textarea" ? { multiline: true } : {}),
      ...(field.default ? { initial_value: field.default } : {}),
      ...(field.placeholder
        ? { placeholder: { type: "plain_text", text: field.placeholder } }
        : {}),
    },
  };
}

export function buildElicitationModal(elicitation: ChatElicitation): SlackView {
  const fields: ElicitationField[] =
    elicitation.kind === "text"
      ? [{ name: "answer", label: elicitation.summary, type: "textarea", required: true }]
      : (elicitation.fields ?? []);

  const intro: SlackBlock[] = elicitation.body
    ? [{ type: "section", text: { type: "mrkdwn", text: elicitation.body } }]
    : [];

  return {
    type: "modal",
    callback_id: `subkit_elicit:${elicitation.id}`,
    title: { type: "plain_text", text: elicitation.summary.slice(0, 24) || "Antworten" },
    submit: { type: "plain_text", text: "Senden" },
    close: { type: "plain_text", text: "Abbrechen" },
    private_metadata: JSON.stringify({
      c: elicitation.conversation_id,
      e: elicitation.id,
      k: elicitation.kind,
    }),
    blocks: [...intro, ...fields.map(fieldToInputBlock)],
  };
}
