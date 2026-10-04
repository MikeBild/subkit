import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import { resumeNextAction, resumeStageLabel, resumeSummaryLine } from "@/pages/chat-resume";

const de = (key: TranslationKey, values?: Record<string, string>) => translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string>) => translate("en", key, values);

const STAGES = [
  { stage: "awaiting_approval", kind: "connector", name: "Reporting API" },
  { stage: "connector_drafting", kind: "connector", name: "Reporting API" },
  { stage: "connector_ready_to_save", kind: "connector", name: "Reporting API" },
  { stage: "connector_saved", kind: "none", name: null },
  { stage: "workflow_drafting", kind: "workflow", name: "Monatsreport" },
  { stage: "workflow_ready_to_commit", kind: "workflow", name: "Monatsreport" },
  { stage: "workflow_saved", kind: "workflow", name: "Monatsreport" },
  { stage: "onboarding", kind: "none", name: null },
] as const;

function summary(entry: (typeof STAGES)[number]) {
  return resumeSummaryLine(
    {
      stage: entry.stage,
      active_target: { kind: entry.kind, name: entry.name, environment: null },
    },
    de,
  );
}

describe("cockpit chat resume", () => {
  test("speaks German in every state the engine can be in", () => {
    for (const entry of STAGES) {
      const line = summary(entry);
      if (entry.stage === "onboarding") {
        expect(line).toBeNull();
        continue;
      }
      expect(line, `${entry.stage} still reads as engine prose`).not.toMatch(
        /^You (were|have|saved)\b/,
      );
      expect(line?.length ?? 0, `${entry.stage} has no line at all`).toBeGreaterThan(0);
    }
  });

  test("gives each stage its own sentence rather than one catch-all", () => {
    const lines = new Set(STAGES.map(summary));
    expect(lines.size).toBe(STAGES.length);
  });

  test("names the target inside the sentence", () => {
    expect(summary(STAGES[1])).toContain("Reporting API");
    expect(summary(STAGES[4])).toContain("Monatsreport");
  });

  test("survives the sentence arriving without its appended next action", () => {
    expect(resumeSummaryLine({ stage: "onboarding", active_target: null }, de)).toBeNull();
  });

  test("says nothing for a stage it has not learned, rather than a filler", () => {
    expect(resumeSummaryLine({ stage: "some_future_stage", active_target: null }, de)).toBeNull();
  });

  test("names an unnamed target without leaking the word none", () => {
    const line = resumeSummaryLine(
      { stage: "connector_drafting", active_target: { kind: "connector", name: "none" } },
      de,
    );
    expect(line).not.toContain("none");
    expect(line).toContain("Konnektor");
  });

  test("carries the environment into the sentence when there is one", () => {
    expect(
      resumeSummaryLine(
        {
          stage: "connector_drafting",
          active_target: { kind: "connector", name: "Reporting API", environment: "prod" },
        },
        de,
      ),
    ).toContain("prod");
  });

  test("reads the next action off the same stage, in German", () => {
    for (const entry of STAGES) {
      const action = resumeNextAction(entry.stage, de);
      expect(action, `${entry.stage} has no next action`).toBeTruthy();
      expect(action).not.toMatch(/^(Resolve|Probe|Save|Preview|Commit|Describe|Continue)\b/);
    }
    expect(new Set(STAGES.map((entry) => resumeNextAction(entry.stage, de))).size).toBe(
      STAGES.length,
    );
  });

  test("labels every real stage instead of calling six of seven ready", () => {
    const labels = STAGES.map((entry) => resumeStageLabel(entry.stage, de));
    expect(new Set(labels).size).toBe(STAGES.length);
    expect(labels).not.toContain(translate("de", "chat.context.ready"));
  });

  test("a pending question is not said a second time under the title", () => {
    for (const tool_name of ["ask_user_text", "ask_user_confirm", "ask_user_choice"]) {
      const line = resumeSummaryLine(
        {
          stage: "awaiting_approval",
          active_target: { kind: "connector", name: "Reporting API" },
          pending_approval: { tool_name },
        },
        de,
      );
      expect(line, tool_name).not.toMatch(/wartet|Antwort|Rückfrage|offen gelassen/i);
      expect(line).toContain("Reporting API");
    }
  });

  test("a conversation that has not started carries no line under its title", () => {
    expect(resumeSummaryLine(null, de)).toBeNull();
    expect(resumeSummaryLine(undefined, en)).toBeNull();
  });

  test("keeps the English catalog usable for an English reader", () => {
    expect(resumeSummaryLine({ stage: "connector_saved", active_target: null }, en)).toBe(
      translate("en", "chat.resume.connectorSaved"),
    );
  });
});

test("business choices are questions rather than authority requests in the chat header", () => {
  for (const t of [de, en]) {
    const line = resumeSummaryLine(
      { stage: "awaiting_approval", pending_approval: { tool_name: "ask_user_choice" } },
      t,
    );
    expect(line).not.toMatch(/Freigabe|approval/i);
  }
});
