// Pure-function tests for the native elicitation block-kit renderers.
// No DB, no Slack — assert on the exact Block Kit JSON the dispatcher
// will post and the modal-view JSON the route's sync fast path opens.

import { describe, expect, test } from "bun:test";
import type { ChatElicitation } from "../../types.ts";
import {
  buildElicitationModal,
  renderInlineElicitationBlocks,
  renderOpenFormBlocks,
} from "../block-kit.ts";

const baseElicitation = (overrides: Partial<ChatElicitation>): ChatElicitation => ({
  id: "elic-1",
  conversation_id: "conv-1",
  kind: "confirm",
  summary: "Confirm save?",
  ...overrides,
});

describe("renderInlineElicitationBlocks — confirm", () => {
  test("renders Approve/Reject buttons with envelope-encoded value", () => {
    const blocks = renderInlineElicitationBlocks(baseElicitation({ kind: "confirm" }))!;
    const actions = blocks.find((b) => b.type === "actions")!;
    const elements = actions.elements as Array<{
      action_id: string;
      value: string;
      style?: string;
    }>;
    expect(elements).toHaveLength(2);
    expect(elements[0]?.action_id).toBe("elicit:elic-1:confirm");
    expect(elements[0]?.style).toBe("primary");
    expect(JSON.parse(elements[0]!.value)).toEqual({ c: "conv-1", o: { confirmed: true } });
    expect(elements[1]?.style).toBe("danger");
    expect(JSON.parse(elements[1]!.value)).toEqual({ c: "conv-1", o: { confirmed: false } });
  });
});

describe("renderInlineElicitationBlocks — choice", () => {
  test("renders one button per option (≤ 5 options)", () => {
    const blocks = renderInlineElicitationBlocks(
      baseElicitation({
        kind: "choice",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      }),
    )!;
    const actions = blocks.find((b) => b.type === "actions")!;
    const elements = actions.elements as Array<{ action_id: string; value: string }>;
    expect(elements).toHaveLength(2);
    expect(elements[0]?.action_id).toBe("elicit:elic-1:choice");
    expect(JSON.parse(elements[0]!.value)).toEqual({ c: "conv-1", o: { value: "a" } });
  });

  test("falls back to static_select when there are > 5 options", () => {
    const blocks = renderInlineElicitationBlocks(
      baseElicitation({
        kind: "choice",
        options: Array.from({ length: 6 }, (_, i) => ({ value: `opt${i}` })),
      }),
    )!;
    const section = blocks.find((b) => b.type === "section" && "accessory" in b);
    expect(section).toBeTruthy();
    const accessory = (section as unknown as { accessory: { type: string; options: unknown[] } })
      .accessory;
    expect(accessory.type).toBe("static_select");
    expect(accessory.options).toHaveLength(6);
  });
});

describe("renderInlineElicitationBlocks — multi", () => {
  test("renders checkboxes + Submit button", () => {
    const blocks = renderInlineElicitationBlocks(
      baseElicitation({
        kind: "multi",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      }),
    )!;
    const checkboxSection = blocks.find(
      (b) => b.type === "section" && (b.block_id as string)?.startsWith("subkit_elicit_opts:"),
    );
    expect(checkboxSection).toBeTruthy();
    const submit = blocks.find(
      (b) => b.type === "actions" && (b.block_id as string)?.startsWith("subkit_elicit:"),
    );
    expect(submit).toBeTruthy();
    const submitElement = (submit as unknown as { elements: Array<{ action_id: string }> })
      .elements[0]!;
    expect(submitElement.action_id).toBe("elicit:elic-1:multi:submit");
  });
});

describe("renderOpenFormBlocks", () => {
  test("renders an Antworten button with open_elicit action_id", () => {
    const blocks = renderOpenFormBlocks(
      baseElicitation({
        kind: "form",
        fields: [{ name: "title", type: "text", required: true }],
      }),
    );
    const actions = blocks.find((b) => b.type === "actions")!;
    const button = (actions as unknown as { elements: Array<{ action_id: string; value: string }> })
      .elements[0]!;
    expect(button.action_id).toBe("open_elicit:elic-1");
    expect(JSON.parse(button.value)).toEqual({ c: "conv-1", o: {} });
  });
});

describe("buildElicitationModal", () => {
  test("text elicitation produces a single-field textarea modal", () => {
    const view = buildElicitationModal(baseElicitation({ kind: "text" }));
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe("subkit_elicit:elic-1");
    const meta = JSON.parse(view.private_metadata ?? "{}");
    expect(meta).toEqual({ c: "conv-1", e: "elic-1", k: "text" });
    const input = view.blocks.find((b) => b.type === "input");
    expect(input).toBeTruthy();
    const element = (input as unknown as { element: { type: string; multiline?: boolean } })
      .element;
    expect(element.type).toBe("plain_text_input");
    expect(element.multiline).toBe(true);
  });

  test("form elicitation produces one input block per field, blocked by field name", () => {
    const view = buildElicitationModal(
      baseElicitation({
        kind: "form",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "due", type: "date" },
          { name: "tier", type: "select", options: [{ value: "free" }, { value: "pro" }] },
        ],
      }),
    );
    const inputs = view.blocks.filter((b) => b.type === "input");
    expect(inputs).toHaveLength(3);
    expect((inputs[0] as unknown as { block_id: string }).block_id).toBe("field:title");
    expect((inputs[1] as unknown as { element: { type: string } }).element.type).toBe("datepicker");
    expect((inputs[2] as unknown as { element: { type: string } }).element.type).toBe(
      "static_select",
    );
  });
});
