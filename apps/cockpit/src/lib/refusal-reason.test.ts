import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { diagnosisCauseKey } from "./gate-diagnosis";
import { CATALOGS, type TranslationKey } from "./i18n";
import { REFUSAL_REASON_KEYS, refusalReasonKey, refusalReasonLabel } from "./refusal-reason";

const engine = (path: string) =>
  readFileSync(new URL(`../../../engine/src/${path}`, import.meta.url).pathname, "utf8");

function constArray(source: string, name: string): string[] {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source)?.[1];
  if (!body) throw new Error(`${name} not found in the engine source`);
  const entries = [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => String(match[1]));
  if (entries.length === 0) throw new Error(`${name} parsed empty`);
  return entries;
}

const REPORT_SOURCE = engine("workflows/report-delivery-boundary.ts");
const REPORT_REASONS_SOURCE = engine("workflows/core/report-refusal.ts");
const ENGINE_REASONS = [
  ...constArray(REPORT_REASONS_SOURCE, "REPORT_MESSAGE_REFUSALS"),
  ...constArray(REPORT_REASONS_SOURCE, "REPORT_DELIVERY_DISCREPANCIES"),
];

function engineRequestRefusals(): string[] {
  const source = engine("workflows/request-boundary.ts");
  const union = /export type RequestBoundaryRefusal =([\s\S]*?);/.exec(source)?.[1];
  if (!union) throw new Error("RequestBoundaryRefusal not found in the engine source");
  const codes = [...union.matchAll(/\|\s*"([a-z0-9_]+)"/g)].map((match) => String(match[1]));
  if (codes.length === 0) throw new Error("RequestBoundaryRefusal parsed empty");
  return codes;
}

describe("refusal reasons", () => {
  test("the engine's reasons and the cockpit's table are the same set", () => {
    expect(REPORT_SOURCE).toContain('{ code: "execution_authority_changed", ...refusal }');
    expect([...ENGINE_REASONS].sort()).toEqual(Object.keys(REFUSAL_REASON_KEYS).sort());
  });

  test.each(ENGINE_REASONS)("%s has a plain sentence in German and English", (reason) => {
    const key = refusalReasonKey(reason);
    expect(key).toBeDefined();
    for (const catalog of [CATALOGS.de, CATALOGS.en]) {
      const text = catalog[key as TranslationKey];
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(reason);
    }
    expect(CATALOGS.de[key as TranslationKey]).not.toBe(CATALOGS.en[key as TranslationKey]);
  });

  test("the two the person decides by read as the approval they compare", () => {
    expect(CATALOGS.de["refusal.reason.not_utf8"]).toBe(
      "Die Nachricht ist nicht korrekt als UTF-8 kodiert",
    );
    expect(CATALOGS.de["refusal.reason.recipient_differs"]).toBe(
      "Empfänger weicht von der Freigabe ab",
    );
  });

  test("a reason this build does not know stays the engine's value, marked", () => {
    const t = (key: TranslationKey) => CATALOGS.de[key];
    expect(refusalReasonLabel("sent_on_a_sunday", t)).toEqual({
      text: "sent_on_a_sunday",
      machine: true,
    });
    expect(refusalReasonLabel(null, t)).toBeNull();
    expect(refusalReasonKey("toString")).toBeUndefined();
  });
});

describe("diagnosis codes", () => {
  test("every report-delivery refusal the review card can name has its sentence", () => {
    const report = engineRequestRefusals().filter((code) => code.startsWith("report_delivery_"));
    expect(report).toContain("report_delivery_contradicted");
    for (const code of report) {
      const key = diagnosisCauseKey(code);
      expect(key).toBe(`authority.refusal.${code}` as TranslationKey);
      expect(CATALOGS.de[key as TranslationKey].length).toBeGreaterThan(10);
      expect(CATALOGS.en[key as TranslationKey].length).toBeGreaterThan(10);
    }
  });

  test("a changed approval and an unavailable connector are said in the cockpit's words", () => {
    expect(diagnosisCauseKey("execution_authority_changed")).toBe(
      "diagnosis.code.execution_authority_changed",
    );
    expect(diagnosisCauseKey("connector_unavailable")).toBe("diagnosis.code.connector_unavailable");
    expect(diagnosisCauseKey("dynamic_request")).toBe("authority.issue.dynamic_request");
    expect(diagnosisCauseKey("not_a_code")).toBeUndefined();
  });
});
