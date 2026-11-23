import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attentionDetail, attentionSentence } from "@/features/overview/model/overview-model";
import { item as overviewFixture } from "@/features/overview/model/overview-model-fixtures";
import { rerunFailureText } from "@/features/runs/model/runs-model";
import {
  ENGINE_CLASS_CODES,
  ENGINE_FAILURE_CODES,
  ENGINE_HOLD_CODES,
  engineSentence,
  engineSentenceKey,
} from "@/lib/engine-sentence";
import { errorReportable, errorSentence } from "@/lib/error-facts";
import { type TranslationKey, translate } from "@/lib/i18n";
import { engineSentenceDe, engineSentenceEn } from "@/lib/i18n/engine-sentence";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const ENGINE = resolve(import.meta.dir, "../../../engine/src");

function recordKeys(file: string, name: string): string[] {
  const source = readFileSync(resolve(ENGINE, file), "utf8");
  const start = source.indexOf(`const ${name}`);
  const body = source.slice(
    source.indexOf("{", source.indexOf("=", start)),
    source.indexOf("\n};", start),
  );
  return [...body.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1] ?? "");
}

describe("sentences the engine writes, said by the Cockpit", () => {
  test("every hold reason, failure class and failure code the engine has a sentence for is covered", () => {
    expect([...ENGINE_HOLD_CODES].sort()).toEqual(
      recordKeys("operator/core/held-detail.ts", "HELD_DETAIL").sort(),
    );
    expect([...ENGINE_CLASS_CODES].sort()).toEqual(
      recordKeys("execution/sensitive-payload.ts", "SAFE_CLASS_MESSAGES").sort(),
    );
    expect([...ENGINE_FAILURE_CODES].sort()).toEqual(
      [
        ...recordKeys("execution/sensitive-payload.ts", "SAFE_FAILURE_MESSAGES"),
        "sensitive_execution_failure",
      ].sort(),
    );
  });

  test("German and English both have every sentence, and German is not the English text", () => {
    for (const key of Object.keys(engineSentenceEn) as (keyof typeof engineSentenceEn)[]) {
      expect(engineSentenceDe[key].length).toBeGreaterThan(20);
      expect(engineSentenceDe[key]).not.toBe(engineSentenceEn[key]);
    }
  });

  test("a hold reason wins over a failure code, a code over the class", () => {
    expect(
      engineSentenceKey({
        hold: "input_required",
        code: "pagination_truncated",
        cause_class: "timeout",
      }),
    ).toBe("engine.hold.input_required");
    expect(engineSentenceKey({ code: "pagination_truncated", cause_class: "timeout" })).toBe(
      "engine.code.pagination_truncated",
    );
    expect(engineSentenceKey({ hold: "task_grant_required", cause_class: "timeout" })).toBe(
      "engine.class.timeout",
    );
  });

  test("known codes read in the person's language", () => {
    expect(
      engineSentence(
        { hold: "execution_authority_unavailable", text: "The approval has expired, …" },
        de,
      ),
    ).toEqual({
      text: "Die Freigabe ist abgelaufen, aufgebraucht oder widerrufen, deshalb warten automatische Starts. Erneuere die Freigabe, dann laufen sie wieder. Seit dem Anhalten ist nichts gelaufen.",
      source: "cockpit",
    });
    expect(engineSentence({ cause_class: "auth_failed" }, en)?.text).toBe(
      "The connected service rejected the sign-in. Reconnect the connector, then run again. Nothing was changed by this step.",
    );
    expect(engineSentence({ code: "sensitive_execution_failure" }, de)?.text).toContain(
      "geschützten Daten",
    );
  });

  test("an unknown code falls back to the engine's sentence and says so; nothing gives nothing", () => {
    expect(engineSentence({ cause_class: "driver_error", text: " Vendor said no. " }, de)).toEqual({
      text: "Vendor said no.",
      source: "engine",
    });
    expect(engineSentence({ cause_class: "unknown", text: "" }, de)).toBeNull();
    expect(engineSentence({}, de)).toBeNull();
  });
});

describe("where the Cockpit shows these sentences", () => {
  test("a held workflow on the overview reads in German, an unknown detail stays the engine's", () => {
    const held = attentionSentence(
      {
        ...overviewFixture(),
        reason: "execution_authority_unavailable",
        cause_class: "authority_mismatch",
        detail:
          "The approval has expired, is used up or was revoked, so scheduled runs wait. Renew the approval to start them again. Nothing has run since the hold.",
      },
      de,
      Date.parse("2026-09-28T12:00:00.000Z"),
    );
    expect(held.lead).toContain("Die Freigabe ist abgelaufen, aufgebraucht oder widerrufen");
    expect(held.lead).not.toContain("The approval has expired");
    expect(
      attentionDetail({ reason: "execution_authority_required", detail: null }, de),
    ).toBeNull();
    expect(attentionDetail({ reason: "failing", cause_class: "timeout", detail: "x" }, de)).toEqual(
      { text: de("engine.class.timeout"), source: "cockpit" },
    );
    expect(
      attentionDetail({ reason: "task_run_failed", cause_class: null, detail: "turn_failed" }, de),
    ).toEqual({ text: "turn_failed", source: "engine" });
  });

  test("a refused rerun and an error notice use the Cockpit sentence for a known code", () => {
    expect(
      rerunFailureText({ code: "caller_saved_workflow_required", message: "English" }, de),
    ).toBe(`${de("runs.rerun.failed")} ${de("engine.code.caller_saved_workflow_required")}`);
    expect(rerunFailureText({ code: "odd", message: "Vendor said no." }, de)).toContain(
      "Wortlaut der Engine: Vendor said no.",
    );
    expect(
      errorSentence({ status: 409, code: "x", details: { cause_class: "auth_failed" } }, en),
    ).toBe(en("engine.class.auth_failed"));
    expect(errorSentence({ status: 500, code: "internal" }, en)).toBeNull();
    expect(errorSentence({ status: 413, code: "llm_context_too_large" }, en)).toBe(
      en("chat.cause.provider_context_too_large"),
    );
    expect(errorReportable({ status: 413, code: "llm_context_too_large" })).toBe(false);
    expect(errorReportable({ status: 500, code: "internal" })).toBe(true);
    expect(errorSentence(null, en)).toBeNull();
  });
});
