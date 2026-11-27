import { describe, expect, test } from "bun:test";
import { metadataOf, normalizeOrigins, parseKindValue, plainOf, secretsOf } from "./kinds.ts";

const NOW = new Date("2026-11-27T00:00:00Z");
const NEXT_YEAR = 2027;

function ok(kind: string, raw: unknown) {
  const parsed = parseKindValue(kind, raw, NOW);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function refusal(kind: string, raw: unknown): string {
  const parsed = parseKindValue(kind, raw, NOW);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.message;
}

describe("login", () => {
  test("keeps username and password and normalizes a one-time code key", () => {
    expect(
      ok("login", { username: "ada", password: "pw", totp_seed: "jbsw y3dp ehpk 3pxp" }),
    ).toEqual({ kind: "login", username: "ada", password: "pw", totp_seed: "JBSWY3DPEHPK3PXP" });
    expect(
      ok("login", {
        username: "ada",
        password: "pw",
        totp_seed: "otpauth://totp/Shop:ada?secret=JBSWY3DPEHPK3PXP&issuer=Shop",
      }),
    ).toMatchObject({ totp_seed: "JBSWY3DPEHPK3PXP" });
    expect(ok("login", { username: "ada", password: "pw", totp_seed: "" })).toEqual({
      kind: "login",
      username: "ada",
      password: "pw",
    });
  });

  test("refuses an unusable one-time code key and a missing password", () => {
    expect(refusal("login", { username: "ada", password: "pw", totp_seed: "123" })).toContain(
      "totp_seed",
    );
    expect(refusal("login", { username: "ada" })).toContain("password");
  });
});

describe("card", () => {
  test("stores digits only, a four-digit year and never a security code", () => {
    expect(
      ok("card", {
        number: "4111 1111 1111 1111",
        exp_month: "4",
        exp_year: "45",
        holder: "Ada L",
      }),
    ).toEqual({
      kind: "card",
      number: "4111111111111111",
      exp_month: 4,
      exp_year: 2045,
      holder: "Ada L",
    });
    expect(
      refusal("card", {
        number: "4111111111111111",
        exp_month: 4,
        exp_year: NEXT_YEAR,
        holder: "Ada",
        cvv: "123",
      }),
    ).toBe("the vault never stores a card's security code");
  });

  test("refuses a Luhn-invalid number and an expired card", () => {
    expect(
      refusal("card", {
        number: "4111111111111112",
        exp_month: 1,
        exp_year: NEXT_YEAR,
        holder: "A",
      }),
    ).toContain("number");
    expect(
      refusal("card", { number: "4111111111111111", exp_month: 1, exp_year: 2020, holder: "A" }),
    ).toContain("expired");
  });
});

describe("bank account, identity, address, note", () => {
  test("bank account checks IBAN and BIC", () => {
    expect(
      ok("bank_account", {
        iban: "de89 3704 0044 0532 0130 00",
        bic: "cobadeffxxx",
        holder: "Ada",
      }),
    ).toEqual({
      kind: "bank_account",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      holder: "Ada",
    });
    expect(refusal("bank_account", { iban: "DE89370400440532013001", holder: "Ada" })).toContain(
      "IBAN",
    );
    expect(
      refusal("bank_account", { iban: "DE89370400440532013000", bic: "X", holder: "A" }),
    ).toContain("BIC");
  });

  test("identity needs a name and an ISO birth date", () => {
    expect(ok("identity", { full_name: "Ada Lovelace", birth_date: "1815-12-10" })).toMatchObject({
      kind: "identity",
      full_name: "Ada Lovelace",
    });
    expect(refusal("identity", { full_name: "Ada", birth_date: "10.12.1815" })).toContain(
      "YYYY-MM-DD",
    );
  });

  test("address uppercases the country code and drops empty optional fields", () => {
    expect(
      ok("address", {
        line1: "Main St 1",
        postal_code: "10115",
        city: "Berlin",
        country: "de",
        line2: "",
      }),
    ).toEqual({
      kind: "address",
      line1: "Main St 1",
      postal_code: "10115",
      city: "Berlin",
      country: "DE",
    });
    expect(
      refusal("address", { line1: "x", postal_code: "1", city: "y", country: "DEU" }),
    ).toContain("country");
  });

  test("a field the kind does not know is named in the refusal", () => {
    expect(refusal("note", { text: "door code", pin: "1234" })).toBe("unknown field pin");
    expect(refusal("secret", { token: "t", extra: 1, more: 2 })).toBe("unknown field extra, more");
  });

  test("note needs text and unknown kinds have no value", () => {
    expect(ok("note", { text: "door code" })).toEqual({ kind: "note", text: "door code" });
    expect(refusal("connector", {})).toContain("no value");
  });
});

describe("metadata", () => {
  test("shows only safe hints per kind", () => {
    expect(metadataOf({ kind: "login", username: "ada@example.com", password: "pw" })).toEqual({
      username_hint: "ad…",
      has_totp: false,
    });
    expect(
      metadataOf({
        kind: "card",
        number: "5555555555554444",
        exp_month: 3,
        exp_year: 2031,
        holder: "A",
      }),
    ).toEqual({ brand: "mastercard", last4: "4444", exp_month: 3, exp_year: 2031 });
    expect(
      metadataOf({ kind: "bank_account", iban: "DE89370400440532013000", holder: "A" }),
    ).toEqual({
      iban_last4: "3000",
      country: "DE",
    });
    expect(metadataOf({ kind: "identity", full_name: "ada king lovelace" })).toEqual({
      label_hint: "A. K. L.",
    });
    expect(
      metadataOf({ kind: "address", line1: "x", postal_code: "1", city: "Berlin", country: "DE" }),
    ).toEqual({ city: "Berlin", country: "DE" });
    expect(metadataOf({ kind: "note", text: "x" })).toEqual({});
    expect(metadataOf({ kind: "secret", token: "t" })).toEqual({});
  });

  test("secrets to redact are the sensitive values", () => {
    expect(secretsOf({ kind: "login", username: "u", password: "p", totp_seed: "S" })).toEqual([
      "p",
      "S",
    ]);
    expect(
      secretsOf({
        kind: "card",
        number: "4111111111111111",
        exp_month: 1,
        exp_year: 2040,
        holder: "A",
      }),
    ).toEqual(["4111111111111111"]);
    expect(secretsOf({ kind: "identity", full_name: "A", document_number: "X1" })).toEqual(["X1"]);
    expect(secretsOf({ kind: "login", username: "u", password: "p" })).toEqual(["p"]);
    expect(secretsOf({ kind: "secret", token: "tok" })).toEqual(["tok"]);
    expect(
      secretsOf({ kind: "bank_account", iban: "DE89370400440532013000", holder: "A" }),
    ).toEqual(["DE89370400440532013000"]);
    expect(secretsOf({ kind: "identity", full_name: "A" })).toEqual([]);
    expect(
      secretsOf({ kind: "address", line1: "x", postal_code: "1", city: "Berlin", country: "DE" }),
    ).toEqual([]);
    expect(secretsOf({ kind: "note", text: "door code" })).toEqual([]);
  });

  test("the stored plain value is the value without its kind", () => {
    expect(plainOf({ kind: "login", username: "u", password: "p", totp_seed: "S" })).toEqual({
      username: "u",
      password: "p",
      totp_seed: "S",
    });
    expect(plainOf({ kind: "note", text: "door code" })).toEqual({ text: "door code" });
  });
});

describe("origins", () => {
  test("normalizes, dedupes and refuses plain http", () => {
    expect(normalizeOrigins(["https://Shop.example/login", "https://shop.example"])).toEqual([
      "https://shop.example",
    ]);
    expect(normalizeOrigins(["http://shop.example"])).toContain("https://");
    expect(
      normalizeOrigins(Array.from({ length: 21 }, (_, i) => `https://s${i}.example`)),
    ).toContain("at most");
  });
});
