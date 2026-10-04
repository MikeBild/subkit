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

export function buildDialogCloseOk(): unknown {
  return {
    actionResponse: {
      type: "DIALOG",
      dialogAction: { actionStatus: { statusCode: "OK" } },
    },
  };
}
