import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { ChatApproval } from "./chat-approval";
import { ChatApprovalCard } from "./chat-approval-card";

function render(approval: ChatApproval, locale: Locale): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
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

test("a diagnostic transfer names its size on the card", () => {
  const transfer: ChatApproval = {
    ...approval,
    externalTool: undefined,
    gatedTool: "run_workflow",
    transferBytes: 65_360,
  };
  expect(render(transfer, "de")).toContain("Übertragen werden");
  expect(render(transfer, "en")).toContain("of diagnostic data will be sent.");
  expect(render({ ...transfer, transferBytes: undefined }, "de")).not.toContain(
    "Übertragen werden",
  );
});

test("an admin reads who can release the held changes instead of the answer buttons", () => {
  const held: ChatApproval = { ...approval, externalTool: undefined, ownerOnly: true };
  const de = render(held, "de");
  expect(de).toContain("Nur die Besitzerin der Aufgabe kann diese Freigabe erteilen.");
  expect(de).not.toContain("approval-approve");
  expect(de).not.toContain("approval-decline");
  expect(render(held, "en")).toContain("Only the owner of the task can give this approval.");
  expect(render({ ...held, ownerOnly: undefined }, "de")).toContain("approval-approve");
});

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

const gated: ChatApproval = {
  id: "approval",
  toolCallId: "call",
  question: "Policy requires confirmation before running call_connector. Proceed?",
  description: null,
  savesInactiveWorkflow: false,
  expiresAt: "2030-01-01T00:00:00Z",
};

test("a gated connector call names connector, method and target in the reader's language", () => {
  const connectorCall = {
    connector: "Reporting API",
    method: "PATCH",
    target: "https://api.example/v1/reports",
  };
  const german = render({ ...gated, connectorCall }, "de");
  expect(german).toContain("Reporting API aufrufen: PATCH https://api.example/v1/reports");
  expect(render({ ...gated, connectorCall }, "en")).toContain(
    "Call Reporting API: PATCH https://api.example/v1/reports",
  );
  expect(render({ ...gated, connectorCall: { ...connectorCall, target: null } }, "de")).toContain(
    "Reporting API aufrufen: PATCH",
  );
  for (const html of [german, render({ ...gated, gatedTool: "call_connector" }, "de")]) {
    expect(html).not.toContain("call_connector");
    expect(html).not.toContain("Policy requires");
  }
  expect(render({ ...gated, gatedTool: "call_connector" }, "de")).toContain(
    "Erlaube diese Aktion einmal, damit es weitergeht.",
  );
  expect(german).toContain(">Einmal erlauben<");
  expect(german).not.toContain(">Freigeben<");
});

test("a gated action lists what it concerns", () => {
  const html = render(
    { ...gated, gatedTool: "approve_skill_candidate", subjects: ["Chord analysis"] },
    "de",
  );
  expect(html).toContain("Chord analysis");
  expect(html).toContain('data-testid="approval-subjects"');
  expect(render({ ...gated, gatedTool: "approve_skill_candidate" }, "de")).not.toContain(
    "approval-subjects",
  );
});
