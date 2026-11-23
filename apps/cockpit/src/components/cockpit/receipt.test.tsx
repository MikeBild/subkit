import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { Receipt, receiptText } from "@/components/cockpit/receipt";

describe("receipt", () => {
  test("shows the person's own words in the reader's language", () => {
    const en = render(<Receipt quote="send the report every Monday" />, "en");
    expect(en).toContain("You said:");
    expect(en).toContain("“send the report every Monday”");
    const de = render(<Receipt quote="send the report every Monday" testId="audit-receipt" />);
    expect(de).toContain("„send the report every Monday“");
    expect(de).toContain('data-testid="audit-receipt-quote"');
  });

  test("renders nothing without a quote", () => {
    expect(render(<Receipt quote={null} />)).toBe("");
    expect(render(<Receipt quote="   " />)).toBe("");
    expect(render(<Receipt quote={undefined} />)).toBe("");
  });

  test("trims the stored words", () => {
    expect(receiptText("  hello  ")).toBe("hello");
    expect(receiptText("")).toBeNull();
  });
});
