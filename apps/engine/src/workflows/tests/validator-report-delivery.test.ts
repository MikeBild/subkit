import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";

const CONNECTOR_ID = "5b0f3c1e-7a2d-4c8e-9f10-2a3b4c5d6e7f";
const baseUrls = new Map([[CONNECTOR_ID, ["https://gmail.googleapis.com/gmail/v1"]]]);
const RAW_FROM_SCOPE = "${scope.build_mail.data.raw}";

const send = (overrides: Record<string, unknown> = {}) => ({
  id: "send_report",
  kind: "request",
  connector_id: CONNECTOR_ID,
  method: "POST",
  path: "/users/me/messages/send",
  body: { raw: RAW_FROM_SCOPE },
  ...overrides,
});

const workflow = (expression: string, sendStep = send()) => ({
  name: "report fixture",
  steps: [
    { id: "list_items", kind: "request", url: "https://example.test/items", method: "GET" },
    { id: "build_mail", kind: "transform", language: "javascript", expression },
    sendStep,
  ],
});

const mime = (options: string) =>
  `const rows = input.scope.list_items.data ?? [];\nreturn sk.buildMimeMessage({ from: "reports@example.com", to: "owner@example.com", subject: "Report", text: String(rows.length)${options} });`;

const rawErrors = (result: ReturnType<typeof validateWorkflowDef>) =>
  result.errors.filter((error) => error.path === "steps.send_report.body.raw");

describe("validateWorkflowDef governed report delivery", () => {
  test("a transform that sets cc for a Gmail report send fails naming the rule", () => {
    const result = validateWorkflowDef(workflow(mime(', cc: "boss@example.com"')), {
      lintJavascript: true,
      connectorBaseUrls: baseUrls,
    });
    expect(result.ok).toBe(false);
    const [error] = rawErrors(result);
    expect(error?.message).toContain("rule header_not_allowed");
    expect(error?.message).toContain('transform "build_mail" sets Cc');
  });

  test("replyTo, extra headers, several recipients and hand-built header lines are caught", () => {
    const expression = [
      "const extra = `Bcc: audit@example.com\\r\\n`;",
      'const msg = sk.buildMimeMessage({ from: "a@example.com", to: ["b@example.com", "c@example.com"], replyTo: "d@example.com", headers: { "Reply-To": "e@example.com" }, text: extra });',
      "return msg;",
    ].join("\n");
    const messages = rawErrors(
      validateWorkflowDef(workflow(expression), {
        lintJavascript: true,
        connectorBaseUrls: baseUrls,
      }),
    ).map((error) => error.message);
    expect(messages.some((m) => m.includes("sets Reply-To via sk.buildMimeMessage"))).toBe(true);
    expect(messages.some((m) => m.includes("adds the Reply-To header"))).toBe(true);
    expect(messages.some((m) => m.includes("rule extra_recipients"))).toBe(true);
    expect(messages.some((m) => m.includes("writes a Bcc: header line"))).toBe(true);
  });

  test("a single-recipient builder message passes, including explicit null cc", () => {
    for (const options of ["", ", cc: null, bcc: undefined"]) {
      expect(
        validateWorkflowDef(workflow(mime(options)), {
          lintJavascript: true,
          connectorBaseUrls: baseUrls,
        }).ok,
      ).toBe(true);
    }
  });

  test("a literal raw message with Bcc fails without any transform", () => {
    const raw = Buffer.from(
      [
        "From: reports@example.com",
        "To: owner@example.com",
        "Bcc: audit@example.com",
        "Subject: Report",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Hello",
      ].join("\r\n"),
    ).toString("base64url");
    const result = validateWorkflowDef(
      workflow(
        "return 1;",
        send({ connector_id: undefined, path: undefined, url: GMAIL_SEND_TARGET, body: { raw } }),
      ),
      { lintJavascript: true },
    );
    expect(rawErrors(result)[0]?.message).toContain("rule header_not_allowed");
  });

  test("a declared report_delivery boundary is governed without a known base url", () => {
    const result = validateWorkflowDef(
      workflow(
        mime(', bcc: "audit@example.com"'),
        send({
          report_delivery: {
            kind: "gmail_report",
            to: "owner@example.com",
            from: "reports@example.com",
            content_type: "text/plain",
          },
        }),
      ),
      { lintJavascript: true },
    );
    expect(rawErrors(result)[0]?.message).toContain("sets Bcc");
  });

  test("non-Gmail posts, transactional delivery and stored definitions are left alone", () => {
    const cc = mime(', cc: "boss@example.com"');
    const otherApi = new Map([[CONNECTOR_ID, ["https://mail.example.test/api"]]]);
    expect(
      validateWorkflowDef(workflow(cc), { lintJavascript: true, connectorBaseUrls: otherApi }).ok,
    ).toBe(true);
    const transactional = send({
      max_retries: 0,
      transactional_delivery: {
        kind: "gmail_transactional",
        webhook_id: "0d4c6f7e-3b2a-4a1c-8d9e-1f2a3b4c5d6e",
        event_type: "application.received",
        event_type_input: "body.type",
        recipient_input: "body.applicant.email",
        request_id_input: "body.id",
        from: "reports@example.com",
        content_type: "text/plain",
        max_body_bytes: 4096,
      },
    });
    expect(
      rawErrors(
        validateWorkflowDef(workflow(cc, transactional), {
          lintJavascript: true,
          connectorBaseUrls: baseUrls,
        }),
      ),
    ).toEqual([]);
    expect(validateWorkflowDef(workflow(cc), { connectorBaseUrls: baseUrls }).ok).toBe(true);
  });
});
