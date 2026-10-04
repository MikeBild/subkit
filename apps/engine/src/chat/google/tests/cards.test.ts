import { describe, expect, test } from "bun:test";
import type { ChatElicitation } from "../../types.ts";
import {
  buildDialogCloseOk,
  buildDialogNotFound,
  buildElicitationDialog,
  renderElicitationCard,
  renderOpenDialogCard,
} from "../cards.ts";

const baseElicitation = (overrides: Partial<ChatElicitation>): ChatElicitation => ({
  id: "elic-1",
  conversation_id: "conv-1",
  kind: "confirm",
  summary: "Confirm save?",
  ...overrides,
});

interface GoogleButton {
  text: string;
  onClick: {
    action: {
      function: string;
      interaction?: string;
      parameters: Array<{ key: string; value: string }>;
    };
  };
}

interface GoogleSection {
  widgets: Array<Record<string, unknown>>;
}

function sectionsOf(card: unknown): GoogleSection[] {
  const cards = (card as { cardsV2: Array<{ card: { sections: GoogleSection[] } }> }).cardsV2;
  return cards[0]!.card.sections;
}

function buttonsOf(section: GoogleSection | undefined): GoogleButton[] {
  const widget = section?.widgets.find((w) => "buttonList" in w);
  return (widget!.buttonList as { buttons: GoogleButton[] }).buttons;
}

function param(button: GoogleButton, key: string): string {
  return button.onClick.action.parameters.find((p) => p.key === key)?.value ?? "";
}

describe("renderElicitationCard — confirm", () => {
  test("two buttons, both elicit:<id>:confirm, exact {c,o:{confirmed}} envelopes", () => {
    const card = renderElicitationCard(baseElicitation({ kind: "confirm" }));
    const sections = sectionsOf(card);
    const buttons = buttonsOf(sections[sections.length - 1]);
    expect(buttons).toHaveLength(2);
    expect(param(buttons[0]!, "action_id")).toBe("elicit:elic-1:confirm");
    expect(param(buttons[1]!, "action_id")).toBe("elicit:elic-1:confirm");
    expect(param(buttons[0]!, "value")).toBe(
      JSON.stringify({ c: "conv-1", o: { confirmed: true } }),
    );
    expect(param(buttons[1]!, "value")).toBe(
      JSON.stringify({ c: "conv-1", o: { confirmed: false } }),
    );
    expect(buttons[0]?.onClick.action.interaction).toBeUndefined();
  });

  test("body renders as a leading textParagraph section", () => {
    const card = renderElicitationCard(baseElicitation({ kind: "confirm", body: "Details here" }));
    const sections = sectionsOf(card);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.widgets[0]).toEqual({ textParagraph: { text: "Details here" } });
  });
});

describe("renderElicitationCard — choice", () => {
  test("3 options → 3 buttons, each elicit:<id>:choice with {c,o:{value}}; text = label ?? value", () => {
    const card = renderElicitationCard(
      baseElicitation({
        kind: "choice",
        options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c" }],
      }),
    );
    const sections = sectionsOf(card);
    const buttons = buttonsOf(sections[sections.length - 1]);
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(param(b, "action_id")).toBe("elicit:elic-1:choice");
    expect(buttons.map((b) => b.text)).toEqual(["Alpha", "Beta", "c"]);
    expect(JSON.parse(param(buttons[0]!, "value"))).toEqual({ c: "conv-1", o: { value: "a" } });
    expect(JSON.parse(param(buttons[2]!, "value"))).toEqual({ c: "conv-1", o: { value: "c" } });
  });
});

describe("renderElicitationCard — multi", () => {
  test("CHECK_BOX selectionInput named `values` + Submit with {c,o:{kind:'multi'}}", () => {
    const card = renderElicitationCard(
      baseElicitation({
        kind: "multi",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      }),
    );
    const sections = sectionsOf(card);
    const widgets = sections[sections.length - 1]!.widgets;
    const selection = widgets.find((w) => "selectionInput" in w)?.selectionInput as {
      name: string;
      type: string;
      items: Array<{ text: string; value: string }>;
    };
    expect(selection.name).toBe("values");
    expect(selection.type).toBe("CHECK_BOX");
    expect(selection.items).toEqual([
      { text: "X", value: "x" },
      { text: "Y", value: "y" },
    ]);
    const buttons = buttonsOf(sections[sections.length - 1]);
    expect(buttons).toHaveLength(1);
    expect(param(buttons[0]!, "action_id")).toBe("elicit:elic-1:multi:submit");
    expect(JSON.parse(param(buttons[0]!, "value"))).toEqual({ c: "conv-1", o: { kind: "multi" } });
  });
});

describe("renderOpenDialogCard — text/form opener", () => {
  test("single button carries interaction OPEN_DIALOG + action_id open_elicit:<id>", () => {
    const card = renderOpenDialogCard(baseElicitation({ kind: "text" }));
    const sections = sectionsOf(card);
    const buttons = buttonsOf(sections[sections.length - 1]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.onClick.action.interaction).toBe("OPEN_DIALOG");
    expect(param(buttons[0]!, "action_id")).toBe("open_elicit:elic-1");
    expect(JSON.parse(param(buttons[0]!, "value"))).toEqual({ c: "conv-1", o: {} });
  });
});

interface DialogShape {
  actionResponse: {
    type: string;
    dialogAction: {
      dialog?: { body: { sections: GoogleSection[] } };
      actionStatus?: { statusCode: string; userFacingMessage?: string };
    };
  };
}

function dialogSections(dialog: unknown): GoogleSection[] {
  return (dialog as DialogShape).actionResponse.dialogAction.dialog!.body.sections;
}

describe("buildElicitationDialog — text", () => {
  test("DIALOG response with a single textInput named `answer` + view_submission submit", () => {
    const dialog = buildElicitationDialog(baseElicitation({ kind: "text", summary: "Your name?" }));
    expect((dialog as DialogShape).actionResponse.type).toBe("DIALOG");
    const sections = dialogSections(dialog);
    expect(sections).toHaveLength(2);
    const fieldWidgets = sections[0]!.widgets;
    expect(fieldWidgets).toHaveLength(1);
    expect(fieldWidgets[0]?.textInput).toEqual({
      name: "answer",
      label: "Your name?",
      type: "SINGLE_LINE",
    });
    const submit = buttonsOf(sections[1])[0]!;
    expect(param(submit, "action_id")).toBe("view_submission");
    expect(param(submit, "value")).toBe(JSON.stringify({ c: "conv-1", e: "elic-1", k: "text" }));
  });
});

describe("buildElicitationDialog — form", () => {
  test("per-field widgets: DROPDOWN select, DATE_ONLY date, MULTIPLE_LINE textarea, hintText/value from placeholder/default", () => {
    const dialog = buildElicitationDialog(
      baseElicitation({
        kind: "form",
        body: "Fill this in",
        fields: [
          {
            name: "city",
            label: "City",
            type: "select",
            options: [{ value: "ber", label: "Berlin" }, { value: "muc" }],
            default: "muc",
          },
          { name: "when", type: "date" },
          { name: "notes", type: "textarea", placeholder: "Optional notes" },
          { name: "email", type: "email", default: "a@b.test" },
        ],
      }),
    );
    const sections = dialogSections(dialog);
    expect(sections).toHaveLength(3);
    expect(sections[0]?.widgets[0]).toEqual({ textParagraph: { text: "Fill this in" } });
    const widgets = sections[1]!.widgets;
    expect(widgets).toHaveLength(4);
    expect(widgets[0]?.selectionInput).toEqual({
      name: "city",
      label: "City",
      type: "DROPDOWN",
      items: [
        { text: "Berlin", value: "ber", selected: false },
        { text: "muc", value: "muc", selected: true },
      ],
    });
    expect(widgets[1]?.dateTimePicker).toEqual({
      name: "when",
      label: "when",
      type: "DATE_ONLY",
    });
    expect(widgets[2]?.textInput).toEqual({
      name: "notes",
      label: "notes",
      type: "MULTIPLE_LINE",
      hintText: "Optional notes",
    });
    expect(widgets[3]?.textInput).toEqual({
      name: "email",
      label: "email",
      type: "SINGLE_LINE",
      value: "a@b.test",
    });
    const submit = buttonsOf(sections[2])[0]!;
    expect(param(submit, "action_id")).toBe("view_submission");
    expect(param(submit, "value")).toBe(JSON.stringify({ c: "conv-1", e: "elic-1", k: "form" }));
  });
});

describe("dialog status responses", () => {
  test("buildDialogNotFound is a probe-resistant NOT_FOUND actionStatus", () => {
    const d = buildDialogNotFound() as DialogShape;
    expect(d.actionResponse.type).toBe("DIALOG");
    expect(d.actionResponse.dialogAction.actionStatus).toEqual({
      statusCode: "NOT_FOUND",
      userFacingMessage: "This request expired.",
    });
    expect(d.actionResponse.dialogAction.dialog).toBeUndefined();
  });

  test("buildDialogCloseOk is an OK close-ack", () => {
    const d = buildDialogCloseOk() as DialogShape;
    expect(d.actionResponse.dialogAction.actionStatus).toEqual({ statusCode: "OK" });
  });
});
