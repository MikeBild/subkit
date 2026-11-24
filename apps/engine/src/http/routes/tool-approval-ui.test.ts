import { expect, test } from "bun:test";
import type { ApprovalPortalView } from "../../tools/index.ts";
import { approvalCopy, approvalDenialCopy } from "./tool-approval-copy.ts";
import {
  alreadyDecidedPage,
  approvalDisplayTarget,
  approvalStatusPage,
  buildApprovalDecisionHtml,
} from "./tool-approval-ui.ts";

const view: ApprovalPortalView = {
  approval_id: "never-render-the-handle",
  tenant_id: "tenant",
  tool: "wf_example",
  workflow_slug: "example",
  surface: "chat",
  execution_mode: "dev",
  expires_at: new Date("2026-09-10T12:00:00Z"),
  state: "pending",
  preview: {
    would_write: [{ step: "send", method: "POST", url: "https://ledger.example.test/entries" }],
  },
};

test("display targets omit credentials, all query values and fragments", () => {
  expect(
    approvalDisplayTarget(
      "postgresql://user:private@database.example.test:5432/ledger?sslpassword=hidden",
    ),
  ).toBe("postgresql://database.example.test:5432/ledger");
  expect(approvalDisplayTarget("s3://test-bucket/reports?credential=hidden")).toBe(
    "s3://test-bucket/reports",
  );
  expect(
    approvalDisplayTarget("https://user:password@example.test/items?key=short-secret#token"),
  ).toBe("https://example.test/items");
  for (const target of [null, "not a URL", "javascript:alert(1)", "data:text/plain,secret"])
    expect(approvalDisplayTarget(target)).toBeNull();
});

for (const locale of ["de", "en"] as const) {
  test(`${locale} direct decisions show the recorded connector environment and target`, () => {
    const copy = approvalCopy(locale);
    const html = buildApprovalDecisionHtml(
      {
        ...view,
        tool: "call_connector",
        preview: {
          would_write: [{ step: "untrusted", method: "GET", url: "https://wrong.example.test" }],
          direct_connector: {
            schema_version: 1,
            tool: "call_connector",
            references: [],
            target: {
              connector_id: "00000000-0000-4000-8000-000000000001",
              environment: "prod",
              configuration_digest: "a".repeat(64),
              credential_binding_digest: null,
              credential_id: null,
              credential_revision: null,
              connection_authority: null,
            },
            review: {
              step: "call_connector: ledger (prod)",
              method: "POST",
              url: "https://ledger.example.test/entries",
            },
          },
        },
      },
      "grant",
      { email: "operator@example.test" },
      "csrf",
      { locale, scheme: null },
    );
    expect(html).toContain(copy.prod);
    expect(html).toContain(copy.directBoundHelp);
    expect(html).toContain(copy.directEffectsHelp);
    expect(html).toContain("ledger.example.test/entries");
    expect(html).not.toContain("wrong.example.test");
    expect(html).not.toContain(copy.limitations);
    expect(html).toContain(
      copy.titleForTarget
        .replace("{operation}", "POST")
        .replace("{target}", "https://ledger.example.test/entries"),
    );
  });
  test(`${locale} shows persisted prepared content, version and retry limits without trusting caller prose`, () => {
    const copy = approvalCopy(locale);
    const version = "00000000-0000-4000-8000-000000000003";
    const html = buildApprovalDecisionHtml(
      {
        ...view,
        preview: {
          would_write: [{ step: "send", method: "DELETE", url: "https://wrong.example.test" }],
          prepared_workflow: {
            schema_version: 1,
            execution_id: "00000000-0000-4000-8000-000000000001",
            workflow_id: "00000000-0000-4000-8000-000000000002",
            workflow_version_id: version,
            execution_mode: "dev",
            input_digest: "a".repeat(64),
            request_proofs: [
              { version: 1, step_key: "send", digest: "b".repeat(64), max_attempts: 5 },
            ],
            request_reviews: [
              {
                step: "send",
                method: "POST",
                url: "https://ledger.example.test/entries",
                max_attempts: 5,
                redacted_request_json:
                  '{"recipient":"reviewed@example.test","message":"<script>never execute</script>"}',
                request_review_truncated: true,
                opaque_payload_omitted: true,
              },
            ],
          },
        },
      },
      "grant",
      { email: "operator@example.test" },
      "csrf",
      { locale, scheme: null },
    );
    expect(html).toContain(version);
    expect(html).toContain(copy.attemptsValue.replace("{count}", "5"));
    expect(html).toContain(copy.boundHelp);
    expect(html).toContain(copy.contentTruncated);
    expect(html).toContain(copy.opaqueContent);
    expect(html).toContain("reviewed@example.test");
    expect(html).not.toContain("wrong.example.test");
    expect(html).not.toContain("<script>");
    expect(html.match(/<img/g)).toEqual(["<img"]);
  });

  test(`${locale} does not invent successful execution from a consumed approval`, () => {
    const copy = approvalCopy(locale);
    const page = alreadyDecidedPage({ ...view, state: "consumed" }, { locale, scheme: null });
    expect(page.html).toContain(copy.consumedTitle);
    expect(page.html).not.toContain("has already been carried out");
    expect(page.html).not.toContain("<form");
    expect(page.html).not.toContain("ledger.example.test");
    expect(page.html).not.toContain(view.approval_id);
    expect(approvalDenialCopy("approval_already_used", locale)).toBe(copy.consumedMessage);
    expect(approvalDenialCopy("approval_expired", locale)).toBe(copy.deadMessage);
  });

  test(`${locale} absence of a preview does not mean the tool is read-only`, () => {
    const copy = approvalCopy(locale);
    const html = buildApprovalDecisionHtml(
      { ...view, preview: null },
      "grant",
      { email: "operator@example.test" },
      "csrf",
      { locale, scheme: null },
    );
    expect(html).toContain(copy.missing);
    expect(html).toContain(copy.changesHelp);
    expect(html).toContain(copy.limitations);
    expect(html).not.toContain("Version 7");
    expect(html).not.toContain("<script");
  });
}

test("all untrusted preview fields and status copy are escaped", () => {
  const html = buildApprovalDecisionHtml(
    {
      ...view,
      tool: "<script>bad</script>",
      preview: {
        would_write: [
          { step: "<img src=x>", method: "<bad>", url: "https://example.test/?secret=short" },
        ],
      },
    },
    "hidden-grant",
    { email: "<operator>" },
    "csrf",
    { locale: "en", scheme: null },
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x>");
  expect(html).not.toContain("secret=short");
  expect(html).toContain("&lt;operator&gt;");
  expect(approvalStatusPage({ locale: "de", scheme: null }, "<title>", "<message>").html).toContain(
    "&lt;message&gt;",
  );
});

const PENDING_HTML = (locale: "de" | "en") =>
  buildApprovalDecisionHtml(view, "grant", { email: "operator@example.test" }, "csrf", {
    locale,
    scheme: null,
  });

test("the decision page is one wide single page with a status chip and the §8.4 verbs", () => {
  const html = PENDING_HTML("de");
  expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(html).toContain('data-sk-surface="auth"');
  expect(html).toContain('<main class="card wide"');
  expect(html).toContain("<title>SubKit Cockpit</title>");
  expect(html).toContain('<span class="dot warning"></span>Entscheidung ausstehend</span>');
  expect(html).toContain('value="approve">Einmal erlauben</button>');
  expect(html).toContain('value="decline">Ablehnen</button>');
  expect(html.match(/SubKit · Einmal erlauben/g)?.length).toBe(1);
  expect(html).not.toContain("<a ");
});

test("every status page ends with exactly one way back to the cockpit", () => {
  for (const locale of ["de", "en"] as const) {
    const copy = approvalCopy(locale);
    const look = { locale, scheme: null };
    const pages = [
      approvalStatusPage(look, copy.deadTitle, copy.deadMessage).html,
      approvalStatusPage(look, copy.invalidTitle, copy.invalidMessage).html,
      approvalStatusPage(look, copy.signTitle, copy.signMessage).html,
      approvalStatusPage(look, copy.csrfTitle, copy.csrfMessage).html,
      approvalStatusPage(look, copy.refusedTitle, copy.unchanged).html,
      ...(["granted", "declined", "consumed"] as const).map(
        (state) => alreadyDecidedPage({ ...view, state }, look).html,
      ),
    ];
    for (const html of pages) {
      expect(html.match(/<a\s/g)?.length).toBe(1);
      expect(html).toContain('href="/cockpit"');
      expect(html).toContain(locale === "de" ? ">Zum Cockpit</a>" : ">Back to Cockpit</a>");
      expect(html).not.toContain("<form");
    }
  }
});

test("the German portal carries none of the English copy", () => {
  const english = approvalCopy("en");
  const german = [
    PENDING_HTML("de"),
    alreadyDecidedPage({ ...view, state: "declined" }, { locale: "de", scheme: null }).html,
  ].join("");
  const leaks = Object.entries(english)
    .filter(([key]) => !["tool", "workflow", "method", "language"].includes(key))
    .filter(([, text]) => german.includes(text.split("{")[0] ?? text));
  expect(leaks).toEqual([]);
});

for (const locale of ["de", "en"] as const) {
  test(`${locale} separates a snapshot-backed requester from the deciding user and marks self requests`, () => {
    const copy = approvalCopy(locale);
    const html = buildApprovalDecisionHtml(
      {
        ...view,
        requester: { kind: "user", id: "requesting-user", label: "requester@example.test" },
      },
      "grant",
      { user_id: "requesting-user", email: "decider@example.test" },
      "csrf",
      { locale, scheme: null },
    );
    expect(html).toContain(copy.requester);
    expect(html).toContain(copy.decider);
    expect(html).toContain(copy.ownRequest);
    expect(html).toContain("requester@example.test");
    expect(html).toContain("decider@example.test");
    expect(html).not.toContain("requesting-user");
  });

  test(`${locale} does not infer a requester or promote a caller-supplied preview into the title`, () => {
    const copy = approvalCopy(locale);
    const html = buildApprovalDecisionHtml(
      { ...view, requester: null },
      "grant",
      { email: "decider@example.test" },
      "csrf",
      { locale, scheme: null },
    );
    expect(html).toContain(`<dt>${copy.requester}</dt><dd>${copy.unspecified}</dd>`);
    expect(html).toContain(copy.title);
    expect(html).not.toContain(copy.ownRequest);
  });
}

function visibleText(html: string): string {
  return html
    .replace(/<details[\s\S]*?<\/details>/g, " ")
    .replace(/<head[\s\S]*?<\/head>/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

for (const locale of ["de", "en"] as const) {
  test(`${locale} the one-time page reads like the chat card and folds the technical binding away`, () => {
    const copy = approvalCopy(locale);
    const prepared = buildApprovalDecisionHtml(
      {
        ...view,
        preview: {
          would_write: [],
          prepared_workflow: {
            schema_version: 1,
            execution_id: "00000000-0000-4000-8000-000000000001",
            workflow_id: "00000000-0000-4000-8000-000000000002",
            workflow_version_id: "00000000-0000-4000-8000-000000000003",
            execution_mode: "dev",
            input_digest: "a".repeat(64),
            request_proofs: [
              { version: 1, step_key: "send", digest: "b".repeat(64), max_attempts: 5 },
            ],
            request_reviews: [
              {
                step: "send",
                method: "POST",
                url: "https://ledger.example.test/entries",
                max_attempts: 5,
                redacted_request_json: '{"message":"hello"}',
                request_review_truncated: false,
                opaque_payload_omitted: false,
              },
            ],
          },
        },
      },
      "grant",
      { email: "operator@example.test" },
      "csrf",
      { locale, scheme: null },
    );
    for (const html of [prepared, PENDING_HTML(locale)]) {
      const text = visibleText(html);
      expect(text.split(" ").length).toBeLessThanOrEqual(100);
      expect(text).toContain(locale === "de" ? "einmal erlauben?" : "once?");
      expect(text).toContain(copy.expiry);
      expect(text).not.toMatch(/materiali|digest/i);
      expect(text).not.toContain(copy.boundHelp);
      expect(text).not.toContain(copy.outcomeHelp);
      expect(html).toContain(copy.outcomeHelp);
    }
    expect(visibleText(prepared)).toContain("https://ledger.example.test/entries");
    expect(visibleText(PENDING_HTML(locale))).toContain(copy.unknownEffect);
    expect(PENDING_HTML(locale)).toContain("ledger.example.test/entries");
  });
}

for (const locale of ["de", "en"] as const) {
  test(`${locale} a workflow metadata update names the affected workflow and the proposed change`, () => {
    const copy = approvalCopy(locale);
    const renameView = (current_name: string, current_slug: string): ApprovalPortalView => ({
      ...view,
      tool: "update_workflow",
      workflow_slug: null,
      preview: {
        would_write: [],
        subject: {
          resource_type: "workflow",
          resource_id: "00000000-0000-4000-8000-000000000002",
          current_name,
          current_slug,
          changes: [{ field: "name", to: "Invoice sync (legacy)" }],
        },
      },
    });
    const render = (target: ApprovalPortalView) =>
      buildApprovalDecisionHtml(target, "grant", { email: "operator@example.test" }, "csrf", {
        locale,
        scheme: null,
      });
    const first = render(renameView("Invoice sync <b>", "invoice-sync"));
    const second = render(renameView("Invoice sync 2", "invoice-sync-2"));
    const text = visibleText(first);
    expect(text).toContain(copy.proposedName);
    expect(text).toContain("Invoice sync (legacy)");
    expect(text).toContain("invoice-sync");
    expect(text).not.toContain(copy.unknownEffect);
    expect(first).toContain(copy.titleForRename.replace("{workflow}", "Invoice sync &lt;b&gt;"));
    expect(first).not.toContain("Invoice sync <b>");
    expect(visibleText(second)).toContain("invoice-sync-2");
    expect(visibleText(second)).not.toContain("Invoice sync <b>");
  });
}
