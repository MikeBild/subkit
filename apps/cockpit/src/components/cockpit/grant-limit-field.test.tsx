import { describe, expect, test } from "bun:test";
import { GRANT_LIMIT_MEANINGS, GrantLimitField } from "@/components/cockpit/grant-limit-field";
import { render } from "@/components/cockpit/patterns/test-utils";
import { DEFAULT_GRANT_LIMIT, type GrantLimit } from "@/lib/core/authority-decision";
import { translate } from "@/lib/i18n";

const field = (limit: GrantLimit, locale: "de" | "en" = "de") =>
  render(
    <GrantLimitField limit={limit} disabled={false} onChange={() => {}} testId="review-limit" />,
    locale,
  );

describe("the validity choice of an approval", () => {
  test("offers until revoked, 30 days and 7 days in that order, each with a selector", () => {
    const markup = field(DEFAULT_GRANT_LIMIT);
    const order = [
      "review-limit-until-revoked",
      "review-limit-thirty-days",
      "review-limit-seven-days",
    ].map((id) => markup.indexOf(`data-testid="${id}"`));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain('data-testid="review-limit"');
    expect(markup).toContain('data-testid="review-limit-hint"');
    for (const label of ["Gültigkeit", "Bis auf Widerruf", "30 Tage", "7 Tage"])
      expect(markup).toContain(label);
    expect(field("7d", "en")).toContain("Until revoked");
  });

  test("marks the chosen validity, starting at until revoked", () => {
    const chosen = (markup: string, id: string) =>
      new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(markup)?.[0] ?? "";
    expect(chosen(field(DEFAULT_GRANT_LIMIT), "review-limit-until-revoked")).toContain(
      'data-state="on"',
    );
    expect(chosen(field("30d"), "review-limit-thirty-days")).toContain('data-state="on"');
    expect(chosen(field("30d"), "review-limit-until-revoked")).toContain('data-state="off"');
  });

  test("is visibly and functionally disabled while a request is in flight", () => {
    const busy = render(
      <GrantLimitField limit="30d" disabled onChange={() => {}} testId="review-limit" />,
    );
    const button = (id: string) =>
      new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(busy)?.[0] ?? "";
    for (const id of [
      "review-limit-until-revoked",
      "review-limit-thirty-days",
      "review-limit-seven-days",
    ])
      expect(button(id)).toContain('disabled=""');
    expect(button("review-limit-thirty-days")).toContain('data-state="on"');
    const idle = field("30d");
    expect(idle).not.toContain('disabled=""');
  });

  test("a completed review states the chosen validity as plain text without a control", () => {
    const markup = render(
      <GrantLimitField limit="7d" disabled readOnly onChange={() => {}} testId="review-limit" />,
    );
    expect(markup).toContain("Gültigkeit");
    expect(markup).toMatch(/<p[^>]*data-testid="review-limit"[^>]*>7 Tage<\/p>/);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Bis auf Widerruf");
    expect(markup).not.toContain('data-testid="review-limit-seven-days"');
  });

  test("every choice says in one sentence what it means, in both languages", () => {
    expect(translate("de", GRANT_LIMIT_MEANINGS.until_revoked)).toBe(
      "Läufe sind erlaubt, bis du die Freigabe widerrufst.",
    );
    expect(translate("en", GRANT_LIMIT_MEANINGS.until_revoked)).toBe(
      "Runs are allowed until you revoke the approval.",
    );
    expect(translate("de", GRANT_LIMIT_MEANINGS["30d"])).toBe(
      "Läufe sind 30 Tage lang erlaubt, solange du die Freigabe nicht vorher widerrufst.",
    );
    expect(translate("en", GRANT_LIMIT_MEANINGS["7d"])).toBe(
      "Runs are allowed for 7 days unless you revoke the approval earlier.",
    );
    for (const key of Object.values(GRANT_LIMIT_MEANINGS))
      for (const locale of ["de", "en"] as const) {
        const text = translate(locale, key);
        expect(text).not.toContain("!");
        expect(text).not.toContain("max_runs");
        expect(text.split(". ")).toHaveLength(1);
      }
  });
});
