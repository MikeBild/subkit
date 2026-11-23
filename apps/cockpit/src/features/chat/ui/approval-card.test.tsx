import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@ui/molecules/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import type { ChatApproval } from "../model/approval";
import { ChatApprovalCard } from "./approval-card";

function render(
  approval: ChatApproval,
  locale: Locale,
  devices: { id: string; device_label: string }[] = [],
): string {
  const client = new QueryClient();
  client.setQueryData(["devices", "own"], devices);
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nContext.Provider value={value}>
        <TooltipProvider>
          <ChatApprovalCard
            approval={approval}
            busy={false}
            error={false}
            onDecision={() => {}}
            testId="approval"
          />
        </TooltipProvider>
      </I18nContext.Provider>
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replaceAll(/<\/?strong[^>]*>/g, "");

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
  expect(text(german)).toContain("Reporting API aufrufen: PATCH https://api.example/v1/reports");
  expect(text(render({ ...gated, connectorCall }, "en"))).toContain(
    "Call Reporting API: PATCH https://api.example/v1/reports",
  );
  expect(
    text(render({ ...gated, connectorCall: { ...connectorCall, target: null } }, "de")),
  ).toContain("Reporting API aufrufen: PATCH");
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
  for (const part of ["verb", "target", "account", "content"])
    expect(de).toContain(`data-testid="approval-binding-${part}"`);
  expect(de).toMatch(/data-testid="approval-binding-target">bob@firma\.de</);
  expect(de).not.toContain("POST /v1/messages/send");
  expect(de).toContain('data-testid="approval-request-technical-toggle"');
  expect(de).not.toContain("approval-request-technical-report");
  expect(de).toContain("Du hast diesen Empfänger nicht genannt.");
  expect(de).toContain("Anderer Empfänger oder Inhalt fragt neu");
  expect(de).not.toContain("Möchte das ausführen");
  expect(de).not.toMatch(/<p class="[^"]*">Gmail aufrufen: POST/);
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
  expect(de).not.toContain("1.585 Zeichen");
  expect(de).not.toContain('data-testid="approval-binding-content"');
  expect(de).toContain(
    "Der Text stammt nicht von dir und du hast ihn noch nicht als Entwurf gesehen. Lies ihn, bevor er rausgeht.",
  );
  expect(de).toContain("Wortlaut der Engine: adds the link https://example.com/q3");
  const en = render(drafted, "en");
  expect(en).toContain("Full text");
  expect(en).not.toContain("Scroll inside the box");
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
  expect(short).toContain("Kurz und gut.");
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

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_STEP = {
  device_id: DEVICE_ID,
  capability: "browser" as const,
  target: "Klick auf „Kaufen“ auf shop.example",
  deadline_at: "2030-01-01T00:00:00Z",
};
const onDevice: ChatApproval = {
  ...approval,
  externalTool: undefined,
  question: "Soll SubKit auf „Kaufen“ klicken?",
  device: DEVICE_STEP,
};

function cell(html: string, id: string): string {
  return html.match(new RegExp(`data-testid="approval-${id}"[^>]*>(.*?)</dd>`))?.[1] ?? "";
}

test("a device step names the device, what it uses and its single target", () => {
  const de = render(onDevice, "de", [{ id: DEVICE_ID, device_label: "MacBook Pro (Mike)" }]);
  expect(de).toContain("Schritt auf deinem Gerät bestätigen");
  expect(cell(de, "device")).toBe("MacBook Pro (Mike)");
  expect(cell(de, "capability")).toBe("Browser");
  expect(cell(de, "target")).toBe("Klick auf „Kaufen“ auf shop.example");
  expect(de).not.toContain("approval-line");
  const en = render(onDevice, "en");
  expect(en).toContain("Confirm a step on your device");
  expect(cell(en, "device")).toBe("Your device");
});

test("a device step past its deadline says nothing was sent and offers no answer", () => {
  const past = "2001-01-01T00:00:00Z";
  const expired: ChatApproval = {
    ...onDevice,
    expiresAt: past,
    device: { ...DEVICE_STEP, deadline_at: past },
  };
  const de = render(expired, "de");
  expect(de).toContain("Es wurde nichts gesendet oder geändert.");
  expect(de).not.toContain("Diese Anfrage ist abgelaufen");
  expect(de).not.toContain("approval-pending");
  expect(render(expired, "en")).toContain("Nothing was sent or changed.");
});

test("a workflow patch offers each change on its own, then Accept or Accept and save", () => {
  const patch: ChatApproval = {
    ...approval,
    externalTool: undefined,
    changes: [{ label: "Rename the first step" }, { label: "Add a retry", preview: "retry: 3" }],
  };
  const html = render(patch, "en");
  expect(html).toContain("Rename the first step");
  expect(html.match(/role="checkbox"/g)?.length).toBe(2);
  expect(html.match(/data-testid="approval-accept"/g)?.length).toBe(1);
  expect(html.match(/data-testid="approval-accept-save"/g)?.length).toBe(1);
  expect(html.match(/data-testid="approval-decline"/g)?.length).toBe(1);
  expect(html).not.toContain("approval-approve");
  expect(html).not.toContain("approval-test-first");
});

test("the question line bolds the structured values to check, never model markup", () => {
  const html = render(
    {
      ...approval,
      externalTool: undefined,
      connectorCall: { connector: "Billing", method: "POST", target: "<b>/invoices</b> **42**" },
      transferBytes: 2048,
    },
    "en",
  );
  expect(html).toContain('<strong class="font-semibold">Billing</strong>');
  expect(html).toContain(
    '<strong class="font-semibold">&lt;b&gt;/invoices&lt;/b&gt; **42**</strong>',
  );
  expect(html).toContain('<strong class="font-semibold">2 KB</strong>');
  expect(html).not.toContain("<b>");
  const question = render(
    { ...approval, externalTool: undefined, question: "Send **all** <i>money</i>?" },
    "en",
  );
  expect(question).toContain("Send **all** &lt;i&gt;money&lt;/i&gt;?");
  expect(question).not.toContain("<strong");
});
