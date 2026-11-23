import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { Receipt, receiptText } from "@/components/cockpit/receipt";
import { translate } from "@/lib/i18n";

describe("receipt", () => {
  test("shows the person's own words in the reader's language", () => {
    const quote = "send the report every Monday";
    const en = render(<Receipt quote={quote} />, "en");
    expect(en).toContain(translate("en", "receipt.youSaid"));
    expect(en).toContain(translate("en", "receipt.quote", { quote }));
    const de = render(<Receipt quote={quote} testId="audit-receipt" />);
    expect(de).toContain(translate("de", "receipt.youSaid"));
    expect(de).toContain(translate("de", "receipt.quote", { quote }));
    expect(translate("de", "receipt.quote", { quote })).not.toBe(
      translate("en", "receipt.quote", { quote }),
    );
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
