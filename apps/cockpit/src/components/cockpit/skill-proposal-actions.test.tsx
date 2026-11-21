import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillProposalActions } from "@/features/decisions/ui/skill-proposal-sheet";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";

function i18n(locale: Locale): I18nValue {
  return {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
}
const candidate = {
  id: "proposal",
  title: "Rule",
  reviewable: true,
  review_digest: "digest",
};
function render(
  permissions: string[],
  next: Parameters<typeof SkillProposalActions>[0]["candidate"] = candidate,
  locale: Locale = "de",
) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nContext.Provider value={i18n(locale)}>
        <SkillProposalActions candidate={next} permissions={permissions} onDecided={() => {}} />
      </I18nContext.Provider>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}
describe("skill candidate decisions", () => {
  test("readers get no decision controls", () => {
    expect(render(["skill:read"])).not.toContain("skill-proposal-");
  });
  test("writers may discard but need activation rights to adopt a skill", () => {
    const writer = render(["skill:write"]);
    expect(writer).toContain('data-testid="skill-proposal-reject"');
    expect(writer).not.toContain('data-testid="skill-proposal-accept"');
    expect(render(["skill:write", "skill:activate"])).toContain(
      'data-testid="skill-proposal-accept"',
    );
  });
  test("knowledge writing never stands in for skill activation", () => {
    expect(render(["skill:write", "knowledge:write"])).not.toContain(
      'data-testid="skill-proposal-accept"',
    );
  });
  test("unreviewable or unpinned proposals never offer decision controls", () => {
    expect(
      render(["skill:write", "skill:activate"], { ...candidate, reviewable: false }),
    ).not.toContain("skill-proposal-");
    expect(
      render(["skill:write", "skill:activate"], { ...candidate, review_digest: "" }),
    ).not.toContain("skill-proposal-");
  });
  test("a candidate is applied or discarded, never rejected", () => {
    const permissions = ["skill:write", "skill:activate"];
    const de = render(permissions);
    expect(de).toContain(">Übernehmen<");
    expect(de).toContain(">Verwerfen<");
    expect(de).not.toContain("Ablehnen");
    const en = render(permissions, candidate, "en");
    expect(en).toContain(">Discard<");
    expect(en).not.toContain("Reject");
  });
});
