// Google Chat cardsV2 / Dialog renderers for elicitations.
//
// Mirror of `slack/block-kit.ts` for the Google surface. Two render
// families:
//
//   confirm  → inline card, two buttons, action_id `elicit:<id>:confirm`,
//              value = envelope({confirmed: true|false})
//   choice   → inline card, one button per option, action_id
//              `elicit:<id>:choice`, value = envelope({value})
//   multi    → inline card, CHECK_BOX selectionInput named `values` +
//              Submit button `elicit:<id>:multi:submit`; the selections
//              ride in `common.formInputs` → `interaction.form_values`
//   text/form → opener card whose button carries
//              `interaction: "OPEN_DIALOG"` (action_id
//              `open_elicit:<id>`); the Dialog itself is returned
//              SYNCHRONOUSLY by `handleSyncInteraction` — Google has no
//              async "open dialog" API. The Dialog's Submit uses
//              action_id `view_submission` + value `{c,e,k}` so the
//              EXISTING routeChatInteraction branch resolves it.
//
// Every onClick carries `parameters: [{key:"action_id"},{key:"value"}]`
// — the same two-key convention `receive()` already reads; the
// `function` name is a cosmetic Google requirement, never a routing key.

import { encodeInteractionEnvelope } from "../api.ts";
import type { ChatElicitation, ElicitationField } from "../types.ts";

interface GoogleCardButton {
  text: string;
  onClick: {
    action: {
      function: string;
      interaction?: "OPEN_DIALOG";
      parameters: Array<{ key: string; value: string }>;
    };
  };
}

type GoogleWidget = Record<string, unknown>;

function actionButton(
  text: string,
  fn: string,
  actionId: string,
  value: string,
  openDialog = false,
): GoogleCardButton {
  return {
    text,
    onClick: {
      action: {
        function: fn,
        ...(openDialog ? { interaction: "OPEN_DIALOG" as const } : {}),
        parameters: [
          { key: "action_id", value: actionId },
          { key: "value", value },
        ],
      },
    },
  };
}

function cardShell(elicitation: ChatElicitation, widgets: GoogleWidget[]): unknown {
  return {
    cardsV2: [
      {
        cardId: `subkit_elicit_${elicitation.id}`,
        card: {
          header: { title: elicitation.summary },
          sections: [
            ...(elicitation.body
              ? [{ widgets: [{ textParagraph: { text: elicitation.body } }] }]
              : []),
            { widgets },
          ],
        },
      },
    ],
  };
}

/**
 * Inline interactive card for `confirm` / `choice` / `multi`. These
 * resolve asynchronously through the `chat.event` queue — a click acks
 * `{ok: true}` sync (the proven-benign pattern the approve/reject card
 * already uses) and `routeChatInteraction` resolves the elicitation.
 */
export function renderElicitationCard(elicitation: ChatElicitation): unknown {
  const conv = elicitation.conversation_id;
  if (elicitation.kind === "confirm") {
    return cardShell(elicitation, [
      {
        buttonList: {
          buttons: [
            actionButton(
              "Approve",
              "approve",
              `elicit:${elicitation.id}:confirm`,
              encodeInteractionEnvelope(conv, { confirmed: true }),
            ),
            actionButton(
              "Reject",
              "reject",
              `elicit:${elicitation.id}:confirm`,
              encodeInteractionEnvelope(conv, { confirmed: false }),
            ),
          ],
        },
      },
    ]);
  }
  if (elicitation.kind === "choice") {
    // One button per option: each click self-resolves through the
    // envelope's `o.value` — a DROPDOWN would deliver the pick via
    // formInputs, which the router's choice branch never reads.
    return cardShell(elicitation, [
      {
        buttonList: {
          buttons: (elicitation.options ?? []).map((opt) =>
            actionButton(
              opt.label ?? opt.value,
              "choose",
              `elicit:${elicitation.id}:choice`,
              encodeInteractionEnvelope(conv, { value: opt.value }),
            ),
          ),
        },
      },
    ]);
  }
  // multi — the CHECK_BOX widget is named `values` ON PURPOSE:
  // receive() maps common.formInputs.values → form_values.values and
  // the router's multi:submit branch reads form_values verbatim
  // (MultiOutputSchema `{values: string[]}`). The Submit envelope only
  // carries the conversation_id, mirroring Slack.
  return cardShell(elicitation, [
    {
      selectionInput: {
        name: "values",
        type: "CHECK_BOX",
        items: (elicitation.options ?? []).map((opt) => ({
          text: opt.label ?? opt.value,
          value: opt.value,
        })),
      },
    },
    {
      buttonList: {
        buttons: [
          actionButton(
            "Submit",
            "submit",
            `elicit:${elicitation.id}:multi:submit`,
            encodeInteractionEnvelope(conv, { kind: "multi" }),
          ),
        ],
      },
    },
  ]);
}

/**
 * Opener card for `text` / `form`: one button whose click makes Google
 * request a Dialog from the events endpoint (`interaction:
 * "OPEN_DIALOG"`). `routeChatInteraction` defensively ignores
 * `open_elicit:*` should the click ever reach the queue.
 */
export function renderOpenDialogCard(elicitation: ChatElicitation): unknown {
  return cardShell(elicitation, [
    {
      buttonList: {
        buttons: [
          actionButton(
            "Antworten",
            "open_elicit",
            `open_elicit:${elicitation.id}`,
            encodeInteractionEnvelope(elicitation.conversation_id, {}),
            true,
          ),
        ],
      },
    },
  ]);
}

/** Map an ElicitationField to the closest native Google widget, named
 *  `field.name` so the dialog submit keys `form_values` by field name
 *  (the same widget-name==field-name convention Slack's modal uses). */
function fieldToWidget(field: ElicitationField): GoogleWidget {
  if (field.type === "select") {
    return {
      selectionInput: {
        name: field.name,
        label: field.label ?? field.name,
        type: "DROPDOWN",
        items: (field.options ?? []).map((o) => ({
          text: o.label ?? o.value,
          value: o.value,
          selected: o.value === field.default,
        })),
      },
    };
  }
  if (field.type === "date") {
    return {
      dateTimePicker: {
        name: field.name,
        label: field.label ?? field.name,
        type: "DATE_ONLY",
      },
    };
  }
  // text / textarea / number / email — Google has no native
  // number/email input; keep string, downstream coerces (same tradeoff
  // block-kit.ts documents).
  return {
    textInput: {
      name: field.name,
      label: field.label ?? field.name,
      type: field.type === "textarea" ? "MULTIPLE_LINE" : "SINGLE_LINE",
      ...(field.default ? { value: field.default } : {}),
      ...(field.placeholder ? { hintText: field.placeholder } : {}),
    },
  };
}

/**
 * Full synchronous DIALOG actionResponse for a `text` / `form`
 * elicitation. `text` degenerates to a single textInput named `answer`
 * — matching the router's `fv.answer` read on the view_submission
 * branch. The Submit button reuses the `view_submission` action_id +
 * `{c,e,k}` metadata so the existing parser resolves the submit with
 * ZERO router changes.
 */
export function buildElicitationDialog(elicitation: ChatElicitation): unknown {
  const kind = elicitation.kind === "form" ? "form" : "text";
  const fields: ElicitationField[] =
    kind === "form"
      ? (elicitation.fields ?? [])
      : [{ name: "answer", label: elicitation.summary, type: "text" }];
  return {
    actionResponse: {
      type: "DIALOG",
      dialogAction: {
        dialog: {
          body: {
            sections: [
              ...(elicitation.body
                ? [{ widgets: [{ textParagraph: { text: elicitation.body } }] }]
                : []),
              { widgets: fields.map(fieldToWidget) },
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: "Senden",
                          onClick: {
                            action: {
                              function: "submit_elicit",
                              parameters: [
                                { key: "action_id", value: "view_submission" },
                                {
                                  key: "value",
                                  value: JSON.stringify({
                                    c: elicitation.conversation_id,
                                    e: elicitation.id,
                                    k: kind,
                                  }),
                                },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** Probe-resistant "expired" Dialog for unknown/foreign elicitation ids
 *  — identical outcome for "id does not exist" and "id belongs to
 *  another tenant" so a probing click learns nothing. */
export function buildDialogNotFound(): unknown {
  return {
    actionResponse: {
      type: "DIALOG",
      dialogAction: {
        actionStatus: {
          statusCode: "NOT_FOUND",
          userFacingMessage: "This request expired.",
        },
      },
    },
  };
}

/** Sync close-ack for a dialog submit — dismisses the dialog
 *  immediately while the resolution runs async via the queue. */
export function buildDialogCloseOk(): unknown {
  return {
    actionResponse: {
      type: "DIALOG",
      dialogAction: { actionStatus: { statusCode: "OK" } },
    },
  };
}
