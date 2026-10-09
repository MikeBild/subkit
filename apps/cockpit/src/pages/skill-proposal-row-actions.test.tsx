import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { SkillProposalRowActions } from "./skill-proposal-row-actions";

const value = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
} as I18nValue;
const candidate = {
  id: "proposal",
  title: "Rule",
  tags: [],
  pattern_kind: "session_learning" as const,
  reviewable: true,
  review_digest: "digest",
};
function render(
  permissions: string[],
  next: Parameters<typeof SkillProposalRowActions>[0]["candidate"] = candidate,
) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nContext.Provider value={value}>
        <SkillProposalRowActions candidate={next} permissions={permissions} onDecided={() => {}} />
      </I18nContext.Provider>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}
describe("proposal actions in skill rows", () => {
  test("readers get no decision controls", () => {
    expect(render(["skill:read"])).not.toContain("skill-proposal-row-");
  });
  test("writers may reject but need activation rights to adopt a skill", () => {
    const writer = render(["skill:write"]);
    expect(writer).toContain("skill-proposal-row-reject-proposal");
    expect(writer).not.toContain("skill-proposal-row-accept-proposal");
    expect(render(["skill:write", "skill:activate"])).toContain(
      "skill-proposal-row-accept-proposal",
    );
  });
  test("knowledge proposals require knowledge writing rather than skill activation", () => {
    const fact = { ...candidate, pattern_kind: "knowledge_learning" as const };
    expect(render(["skill:write", "skill:activate"], fact)).not.toContain(
      "skill-proposal-row-accept-proposal",
    );
    expect(render(["skill:write", "knowledge:write"], fact)).toContain(
      "skill-proposal-row-accept-proposal",
    );
  });
  test("unreviewable or unpinned proposals never offer decision controls", () => {
    expect(
      render(["skill:write", "skill:activate"], { ...candidate, reviewable: false }),
    ).not.toContain("skill-proposal-row-");
    expect(
      render(["skill:write", "skill:activate"], { ...candidate, review_digest: "" }),
    ).not.toContain("skill-proposal-row-");
  });
});
