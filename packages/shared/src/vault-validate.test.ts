import { describe, expect, test } from "bun:test";
import {
  bicValid,
  cardBrand,
  expiryInFuture,
  ibanValid,
  isCardNumber,
  luhnValid,
  normalizeOrigin,
  originMatches,
} from "./vault-validate.ts";

describe("card numbers", () => {
  test("Luhn accepts valid numbers with spaces or dashes and refuses others", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242 4242 4242 4242")).toBe(true);
    expect(luhnValid("4242-4242-4242-4242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("42424242")).toBe(false);
    expect(luhnValid("4242a42424242424")).toBe(false);
  });

  test("brands follow the issuer prefixes", () => {
    expect(cardBrand("4111111111111111")).toBe("visa");
    expect(cardBrand("5555555555554444")).toBe("mastercard");
    expect(cardBrand("2223003122003222")).toBe("mastercard");
    expect(cardBrand("378282246310005")).toBe("amex");
    expect(cardBrand("6011111111111117")).toBe("discover");
    expect(cardBrand("3056930009020004")).toBe("diners");
    expect(cardBrand("3566002020360505")).toBe("jcb");
    expect(cardBrand("6200000000000005")).toBe("unionpay");
    expect(cardBrand("1234567812345670")).toBe("unknown");
  });

  test("a card number needs Luhn, 13 or more digits and a known brand", () => {
    expect(isCardNumber("4111 1111 1111 1111")).toBe(true);
    expect(isCardNumber("1234567812345670")).toBe(false);
  });

  test("expiry counts the whole month", () => {
    const now = new Date("2026-11-27T00:00:00Z");
    expect(expiryInFuture(11, 2026, now)).toBe(true);
    expect(expiryInFuture(10, 2026, now)).toBe(false);
    expect(expiryInFuture(13, 2030, now)).toBe(false);
  });
});

describe("IBAN and BIC", () => {
  test("checksums and country lengths decide", () => {
    expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(ibanValid("de89370400440532013000")).toBe(true);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("DE89370400440532013001")).toBe(false);
    expect(ibanValid("DE8937040044053201300")).toBe(false);
    expect(ibanValid("not an iban")).toBe(false);
  });

  test("BIC has 8 or 11 characters", () => {
    expect(bicValid("COBADEFFXXX")).toBe(true);
    expect(bicValid("cobadeff")).toBe(true);
    expect(bicValid("COBADE")).toBe(false);
  });
});

describe("origins", () => {
  test("normalizes to scheme, host and port; https except on loopback", () => {
    expect(normalizeOrigin("https://Shop.Example/login?x=1")).toBe("https://shop.example");
    expect(normalizeOrigin("https://shop.example:443/")).toBe("https://shop.example");
    expect(normalizeOrigin("https://shop.example:8443")).toBe("https://shop.example:8443");
    expect(normalizeOrigin("http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeOrigin("http://shop.example")).toBeNull();
    expect(normalizeOrigin("ftp://shop.example")).toBeNull();
    expect(normalizeOrigin("https://user:pw@shop.example")).toBeNull();
    expect(normalizeOrigin("shop.example")).toBeNull();
  });

  test("matches exactly or the root and www pair, never lookalikes", () => {
    const origins = ["https://shop.example"];
    expect(originMatches(origins, "https://shop.example/checkout")).toBe(true);
    expect(originMatches(origins, "https://www.shop.example")).toBe(true);
    expect(originMatches(["https://www.shop.example"], "https://shop.example")).toBe(true);
    expect(originMatches(origins, "https://login.shop.example")).toBe(false);
    expect(originMatches(origins, "https://shop.example.evil.test")).toBe(false);
    expect(originMatches(origins, "https://shop-example.test")).toBe(false);
    expect(originMatches(origins, "http://shop.example")).toBe(false);
    expect(originMatches(origins, "https://shop.example:8443")).toBe(false);
    expect(originMatches(origins, "https://www.www.shop.example")).toBe(false);
  });
});
