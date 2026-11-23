import { describe, expect, test } from "bun:test";
import { auditReceiptQuote } from "@/features/audit/api/receipt";

describe("audit receipt", () => {
  test("an accepted rule shows the words it was created from", () => {
    expect(auditReceiptQuote({ metadata: { source_quote: " send it " } })).toBe("send it");
  });

  test("a call that ran on a rule shows the rule's words", () => {
    expect(
      auditReceiptQuote({ metadata: { rule_quote: "always send the report", because: null } }),
    ).toBe("always send the report");
  });

  test("a call that ran on the person's request shows their words", () => {
    expect(auditReceiptQuote({ metadata: { because: "send the invoice to Anna" } })).toBe(
      "send the invoice to Anna",
    );
  });

  test("the rule's own words come before the request's words", () => {
    expect(auditReceiptQuote({ metadata: { source_quote: "rule", because: "asked" } })).toBe(
      "rule",
    );
  });

  test("nothing readable shows nothing", () => {
    expect(auditReceiptQuote({ metadata: {} })).toBeNull();
    expect(auditReceiptQuote({ metadata: { source_quote: 7 } })).toBeNull();
    expect(auditReceiptQuote({ metadata: { because: "   " } })).toBeNull();
    expect(auditReceiptQuote({ metadata: { rule_quote: "x".repeat(401) } })).toBeNull();
    expect(auditReceiptQuote({ source_quote: "top level is not an engine field" })).toBeNull();
    expect(auditReceiptQuote(null)).toBeNull();
  });
});
