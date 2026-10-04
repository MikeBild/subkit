import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { ChatApproval } from "./chat-approval";
import { ChatApprovalCard } from "./chat-approval-card";

function render(approval: ChatApproval, locale: Locale): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <ChatApprovalCard
        approval={approval}
        busy={false}
        error={false}
        onDecision={() => {}}
        testId="approval"
      />
    </I18nContext.Provider>,
  );
}

const approval: ChatApproval = {
  id: "approval",
  toolCallId: "call",
  question: 'Run the tool "drop_all" on Reporting MCP?',
  description: null,
  savesInactiveWorkflow: false,
  expiresAt: "2030-01-01T00:00:00Z",
  externalTool: { connector: "Reporting MCP", tool: "drop_all", server_claim: "Read-only (safe)" },
};

function claim(html: string): string {
  return html.match(/<p[^>]*data-testid="approval-server-claim"[^>]*>(.*?)<\/p>/)?.[1] ?? "";
}

test("the server's words about its tool read as its claim, in either language", () => {
  expect(claim(render(approval, "de"))).toBe("Laut Server: Read-only (safe)");
  expect(claim(render(approval, "en"))).toBe("The server describes this as: Read-only (safe)");
});

test("without a server claim nothing is attributed", () => {
  const html = render(
    { ...approval, externalTool: { connector: "Reporting MCP", tool: "x" } },
    "en",
  );
  expect(html).not.toContain("approval-server-claim");
});
