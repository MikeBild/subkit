import { describe, expect, test } from "bun:test";
import { auditReceiptQuote } from "@/features/audit/api/receipt";
import { runReceiptQuote } from "@/features/runs/api/receipt";

describe("receipt quote sources", () => {
  test("an audit entry carries the quote at the top or in its metadata", () => {
    expect(auditReceiptQuote({ source_quote: "always send the report" })).toBe(
      "always send the report",
    );
    expect(auditReceiptQuote({ metadata: { source_quote: " send it " } })).toBe("send it");
    expect(auditReceiptQuote({ source_quote: "top", metadata: { source_quote: "nested" } })).toBe(
      "top",
    );
  });

  test("an entry without a usable quote has no receipt", () => {
    expect(auditReceiptQuote({ metadata: {} })).toBeNull();
    expect(auditReceiptQuote({ metadata: { source_quote: 7 } })).toBeNull();
    expect(auditReceiptQuote({ source_quote: "   " })).toBeNull();
    expect(auditReceiptQuote({ source_quote: "x".repeat(401) })).toBeNull();
    expect(auditReceiptQuote(null)).toBeNull();
  });

  test("a run carries the quote at the top", () => {
    expect(runReceiptQuote({ id: "r", source_quote: "run it every Monday" })).toBe(
      "run it every Monday",
    );
    expect(runReceiptQuote({ id: "r" })).toBeNull();
    expect(runReceiptQuote({ id: "r", source_quote: null })).toBeNull();
    expect(runReceiptQuote(undefined)).toBeNull();
  });
});
