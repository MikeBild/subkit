import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import {
  attentionRow,
  waitingOnLine,
  waitingOnName,
} from "@/features/overview/model/overview-model";
import { de, item, W } from "@/features/overview/model/overview-model-fixtures.ts";
import { WaitingOnLine } from "@/features/overview/ui/waiting-on";
import { type TranslationKey, translate } from "@/lib/i18n";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const approver = { user_id: "0b9f1f5e-8a55-4c0b-9a59-0d6f5f3f6a22", name: "Anna Weber" };

describe("an item that waits for someone else's approval", () => {
  const waiting = item({ reason: "version_awaiting_approval", waiting_on: approver });

  test("the row names the approver in both languages", () => {
    expect(attentionRow(waiting, de).waitingOn).toBe("Wartet auf Freigabe von Anna Weber");
    expect(attentionRow(waiting, en).waitingOn).toBe("Waiting for approval from Anna Weber");
    expect(attentionRow(item({ reason: "version_awaiting_approval" }), de).waitingOn).toBeNull();
  });

  test("a workflow or task finds its approver by its own id", () => {
    const attention = { items: [item({ reason: "failing" }), waiting] };
    expect(waitingOnName(attention, W)).toBe("Anna Weber");
    expect(waitingOnName(attention, "another")).toBeNull();
    expect(waitingOnName(undefined, W)).toBeNull();
    expect(waitingOnName(attention, null)).toBeNull();
    expect(waitingOnName({ items: [item({ reason: "failing" })] }, W)).toBeNull();
  });

  test("the line reads the same on the row, the status strip and the chat card", () => {
    const html = render(<WaitingOnLine name="Anna Weber" testId="workflow-strip-waiting-on" />);
    expect(html).toContain('data-testid="workflow-strip-waiting-on"');
    expect(html).toContain(waitingOnLine("Anna Weber", de));
  });
});

describe("an approval the chosen approver cannot grant", () => {
  const own = item({ reason: "version_awaiting_approval" });

  test("the row, the status strip and the chat card name nobody and keep it as your decision", () => {
    expect(attentionRow(own, de).waitingOn).toBeNull();
    expect(attentionRow(own, en).waitingOn).toBeNull();
    expect(attentionRow(own, de).badge.label).toBe(
      attentionRow(item({ reason: "version_awaiting_approval", waiting_on: approver }), de).badge
        .label,
    );
    expect(waitingOnName({ items: [own] }, W)).toBeNull();
  });
});
