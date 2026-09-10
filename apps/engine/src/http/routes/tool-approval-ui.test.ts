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
      locale,
    );
    expect(html).toContain(version);
    expect(html).toContain(copy.attemptsValue.replace("{count}", "5"));
    expect(html).toContain(copy.boundHelp);
    expect(html).toContain(copy.contentTruncated);
    expect(html).toContain(copy.opaqueContent);
    expect(html).toContain("reviewed@example.test");
    expect(html).not.toContain("wrong.example.test");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });

  test(`${locale} does not invent successful execution from a consumed approval`, () => {
    const copy = approvalCopy(locale);
    const page = alreadyDecidedPage({ ...view, state: "consumed" }, locale);
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
      locale,
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
    "en",
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x>");
  expect(html).not.toContain("secret=short");
  expect(html).toContain("&lt;operator&gt;");
  expect(approvalStatusPage("de", "<title>", "<message>").html).toContain("&lt;message&gt;");
});
