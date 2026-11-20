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

test("someone who is neither the owner nor an admin reads who can release the held changes", () => {
  const held: ChatApproval = { ...approval, externalTool: undefined, decidedByOthers: true };
  const de = render(held, "de");
  expect(de).toContain(
    "Nur die Besitzerin der Aufgabe oder ein Administrator kann diese Freigabe erteilen.",
  );
  expect(de).not.toContain("approval-approve");
  expect(de).not.toContain("approval-decline");
  expect(render(held, "en")).toContain(
    "Only the owner of the task or an admin can give this approval.",
  );
  const admin = render({ ...held, decidedByOthers: undefined }, "de");
  expect(admin).toContain("approval-approve");
  expect(admin).toContain("approval-decline");
  expect(admin).not.toContain("Nur die Besitzerin");
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

test("a bound action shows exactly what would run, why it asks and that it counts once", () => {
  const bound: ChatApproval = {
    ...approval,
    externalTool: undefined,
    connectorCall: { connector: "Gmail", method: "POST", target: "/v1/messages/send" },
    binding: {
      action: {
        verb: "send",
        effect_class: "ordinary",
        target: "POST /v1/messages/send",
        account: "Gmail",
        recipients: ["bob@firma.de"],
        content_summary: "Betreff: Wochenzahlen",
      },
      askReason: "recipient_not_named",
      askDetail: null,
      because: null,
    },
  };
  const de = render(bound, "de");
  for (const part of ["verb", "target", "account", "recipients", "content"])
    expect(de).toContain(`data-testid="approval-binding-${part}"`);
  expect(de).toContain("bob@firma.de");
  expect(de).toContain("Du hast diesen Empfänger nicht genannt.");
  expect(de).toContain(
    "Gilt genau für diese Aktion, einmal. Ein anderer Empfänger oder Inhalt braucht eine neue Frage.",
  );
  expect(de).toContain("Einmal erlauben");
  expect(de).toContain("Ablehnen");
  const quoted = render(
    {
      ...bound,
      binding: { ...bound.binding!, askReason: "mode", because: "Schick Bob die Zahlen" },
    },
    "de",
  );
  expect(quoted).toContain("Weil du gesagt hast: „Schick Bob die Zahlen“");
  expect(quoted).not.toContain("approval-ask-reason");
  expect(render(approval, "de")).not.toContain("approval-binding");
  expect(de).not.toContain("approval-content");
});

test("a drafted text is shown in full, scrollable, with the reason and what was added", () => {
  const text = `Hallo Bob,\n\n${"Die Zahlen der Woche stehen im Anhang. ".repeat(40)}\n\nViele Grüße`;
  const drafted: ChatApproval = {
    ...approval,
    externalTool: undefined,
    connectorCall: { connector: "Gmail", method: "POST", target: "/v1/messages/send" },
    binding: {
      action: {
        verb: "send",
        effect_class: "ordinary",
        target: "POST /v1/messages/send",
        account: "Gmail",
        recipients: ["bob@firma.de"],
        content_summary: "Hallo Bob, Die Zahlen …",
        content: text,
      },
      askReason: "content_not_given",
      askDetail: "adds the link https://example.com/q3",
      because: null,
    },
  };
  const de = render(drafted, "de");
  expect(de).toContain('data-testid="approval-content"');
  expect(de).toContain("Vollständiger Text");
  expect(de).toContain("Viele Grüße</pre>");
  expect(de).toContain("overflow-auto");
  expect(de).toContain("Vollständig, 1.585 Zeichen. Scrolle im Kasten, um alles zu lesen.");
  expect(de).not.toContain('data-testid="approval-binding-content"');
  expect(de).toContain(
    "Der Text stammt nicht von dir und du hast ihn noch nicht als Entwurf gesehen. Lies ihn, bevor er rausgeht.",
  );
  expect(de).toContain("Wortlaut der Engine: adds the link https://example.com/q3");
  const en = render(drafted, "en");
  expect(en).toContain("Full text");
  expect(en).toContain("Complete, 1,585 characters. Scroll inside the box to read all of it.");
  const short = render(
    {
      ...drafted,
      binding: {
        ...drafted.binding!,
        action: { ...drafted.binding!.action, content: "Kurz und gut." },
      },
    },
    "de",
  );
  expect(short).toContain("Vollständig, 13 Zeichen.");
  expect(short).not.toContain("Scrolle im Kasten");
  const capped = render(
    {
      ...drafted,
      binding: {
        ...drafted.binding!,
        action: { ...drafted.binding!.action, content: `${"a".repeat(7999)}…` },
      },
    },
    "de",
  );
  expect(capped).toContain('data-truncated="true"');
  expect(capped).toMatch(/Das sind seine ersten 8\.?000 Zeichen/);
});
