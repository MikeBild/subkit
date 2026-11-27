import { describe, expect, test } from "bun:test";
import { withholdPaymentData } from "./payment-data-guard.ts";

describe("payment data typed into the chat stays out of the model context", () => {
  test("a card number in any grouping is withheld", () => {
    for (const card of ["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242"]) {
      const result = withholdPaymentData(`Use my card ${card} for the order`);
      expect(result.text).toBe("Use my card ***REDACTED:card*** for the order");
      expect(result.withheld).toEqual(["card"]);
    }
  });

  test("an IBAN with a valid checksum is withheld", () => {
    const result = withholdPaymentData("Pay to DE89 3704 0044 0532 0130 00 please");
    expect(result.text).not.toContain("3704");
    expect(result.withheld).toEqual(["iban"]);
  });

  test("security codes and one-time codes in English and German context are withheld", () => {
    const cases: Array<[string, string]> = [
      ["the CVV is 123", "cvv"],
      ["Sicherheitscode: 4711", "cvv"],
      ["Kartenpr\u00fcfnummer 123", "cvv"],
      ["The code is 482913", "otp"],
      ["my verification code: 482 913", "otp"],
      ["Der Best\u00e4tigungscode lautet 48291377", "otp"],
      ["Die TAN ist 482913", "otp"],
      ["482913", "otp"],
      ["  482 913 ", "otp"],
    ];
    for (const [text, kind] of cases) {
      const result = withholdPaymentData(text);
      expect({ text, withheld: result.withheld }).toEqual({ text, withheld: [kind as never] });
      expect(result.text).not.toMatch(/\d{3}/);
    }
  });

  test("prices, dates, order numbers and phone numbers pass unchanged", () => {
    for (const text of [
      "Order the 1 kg coffee beans for 49,90 € at shop-demo.de",
      "Book the table for 2026-11-28 at 19:30",
      "Order number 4711-0815 arrived",
      "My order 48291377 is late",
      "Call +49 30 1234567 tomorrow",
      "Pay at most 120 EUR",
      "The postal code is 10115",
      "1234567890123",
      "rerun 05b2fa7c-cd32-48ed-9c8c-02c076a2f8ca",
      "execution 12345678-1234-1234-1234-123456789012",
      "id 00000000-0000-4000-8000-000000000002",
    ]) {
      expect(withholdPaymentData(text)).toEqual({ text, withheld: [] });
    }
  });

  test("markers already in the text are not counted again", () => {
    const text = "earlier ***REDACTED:otp*** and now nothing";
    expect(withholdPaymentData(text)).toEqual({ text, withheld: [] });
  });
});
