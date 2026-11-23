import { expect, test } from "bun:test";
import { CATALOGS, type TranslationKey, translate } from "@/lib/i18n";
import { actionLabelKey, attentionRow, attentionSentence } from "./overview-model";
import { de, item, NOW } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const open = {
  verb: "open",
  href: "/cockpit/workflows/w",
  primary: true,
  permission: "x",
} as never;

const REAPPROVAL = [
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
] as const;

test("an approval that ended says which way it ended and leaves the engine's sentence out", () => {
  const leads = new Set<string>();
  for (const reason of REAPPROVAL) {
    const held = item({
      class: "stopped",
      reason,
      cause_class: "authority_mismatch",
      since: null,
      detail: "The approval no longer admits runs.",
    });
    for (const [t, locale] of [
      [en, "en"],
      [de, "de"],
    ] as const) {
      const lead = attentionSentence(held, t, NOW).lead;
      const own = CATALOGS[locale][`overview.reason.${reason}`].replace("{subject}", "");
      expect(lead).toEndWith(own);
      expect(lead).not.toContain("no longer admits");
      leads.add(lead);
    }
    expect(actionLabelKey(open, held)).toBe("overview.action.approve");
    expect(attentionRow(held, en).badge.label).toBe("workflowStrip.state.grant");
  }
  expect(leads.size).toBe(REAPPROVAL.length * 2);
  expect(
    attentionSentence(item({ class: "stopped", reason: "execution_authority_expired" }), en, NOW)
      .lead,
  ).toContain("the approval for its schedule has expired");
});

test("a held webhook names the webhook and the way its approval ended", () => {
  for (const reason of REAPPROVAL) {
    const held = item({
      class: "stopped",
      reason,
      trigger: { kind: "inbound_hook", name: "findings-inbox" },
    });
    const lead = attentionSentence(held, en, NOW).lead;
    expect(lead).toContain("“findings-inbox”");
    expect(lead).not.toContain("schedule");
  }
});

test("a schedule without its input, a waiting handover and a due review have their own words", () => {
  const missing = item({ class: "stopped", reason: "input_required", since: null });
  expect(attentionSentence(missing, en, NOW).lead).toEndWith(
    "is on hold: its schedule is missing an input",
  );
  expect(en(actionLabelKey(open, missing))).toBe("Add input");
  const handover = item({ class: "decide", reason: "device_handover_waiting", since: null });
  expect(en(actionLabelKey(open, handover))).toBe("Take over");
  expect(attentionRow(handover, en).reason).toBe("Waiting for you to take over");
  expect(attentionRow(handover, de).reason).toBe(
    CATALOGS.de["overview.short.device_handover_waiting"],
  );
  const due = item({ class: "decide", reason: "knowledge_review_due", since: null });
  expect(attentionRow(due, en).reason).toBe("Review due");
  expect(actionLabelKey(open, due)).toBe("overview.action.reviewKnowledge");
});
