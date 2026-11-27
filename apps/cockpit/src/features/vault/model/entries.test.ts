import { describe, expect, test } from "bun:test";
import { totpCode } from "@shared/totp.ts";
import { translate } from "@/lib/i18n";
import {
  cardExpired,
  cardNumberProblem,
  detectedBrand,
  expiryProblem,
  fieldProblems,
  ibanProblem,
  isFreshAuthRefusal,
  maskedLine,
  metadataOf,
  normalizedOrigins,
  parseExpiry,
  parseTotp,
  scopeChoices,
  scopeFor,
  scopeNoteKey,
  totpProblem,
} from "./entries";
import { totpPreview, totpSecondsLeft } from "./totp";
import {
  createBody,
  emptyDraft,
  rotateBody,
  rotateProblem,
  type VaultDraft,
  vaultErrorKey,
  withoutValues,
} from "./vault";

const NOW = new Date("2026-11-27T10:00:00Z");
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function draft(overrides: Partial<VaultDraft>): VaultDraft {
  return { ...emptyDraft(true), name: "my-card", ...overrides };
}

describe("card validation", () => {
  test("accepts a Luhn-valid number with spaces and detects the brand", () => {
    expect(cardNumberProblem("4242 4242 4242 4242")).toBeNull();
    expect(cardNumberProblem("3782-822463-10005")).toBeNull();
    expect(detectedBrand("4242")).toBe("visa");
    expect(detectedBrand("37")).toBe("amex");
    expect(detectedBrand("5")).toBeNull();
  });

  test("names the reason a number is rejected", () => {
    expect(cardNumberProblem("")?.key).toBe("vault.card.numberMissing");
    expect(cardNumberProblem("4242 abcd")?.key).toBe("vault.card.numberDigits");
    expect(cardNumberProblem("4242 4242")?.key).toBe("vault.card.numberLength");
    expect(cardNumberProblem("4242 4242 4242 4241")?.key).toBe("vault.card.numberChecksum");
  });

  test("reads MM/YY and MM/YYYY and refuses past or malformed expiry dates", () => {
    expect(parseExpiry("08/29")).toEqual({ month: 8, year: 2029 });
    expect(parseExpiry(" 8 / 2031 ")).toEqual({ month: 8, year: 2031 });
    expect(parseExpiry("13/29")).toBeNull();
    expect(expiryProblem("11/26", NOW)).toBeNull();
    expect(expiryProblem("10/26", NOW)?.key).toBe("vault.card.expired");
    expect(expiryProblem("2029-08", NOW)?.key).toBe("vault.card.expiryFormat");
    expect(expiryProblem("", NOW)?.key).toBe("vault.card.expiryMissing");
  });

  test("a card draft only becomes a body with digits, month and four-digit year and never a CVV", () => {
    const card = draft({
      kind: "card",
      scope: "workspace",
      fields: { number: "4242 4242 4242 4242", expiry: "12/28", holder: " Mira Example " },
    });
    expect(fieldProblems("card", card.fields, NOW)).toEqual({});
    const body = createBody(card);
    expect(body).toEqual({
      kind: "card",
      name: "my-card",
      scope: "person",
      environment: "prod",
      value: { number: "4242424242424242", exp_month: 12, exp_year: 2028, holder: "Mira Example" },
    });
    expect(JSON.stringify(body)).not.toContain("cvv");
  });
});

describe("bank account validation", () => {
  test("checks the IBAN checksum and the optional BIC", () => {
    expect(ibanProblem("DE89 3704 0044 0532 0130 00")).toBeNull();
    expect(ibanProblem("DE89 3704 0044 0532 0130 01")?.key).toBe("vault.bank.ibanInvalid");
    expect(ibanProblem(" ")?.key).toBe("vault.bank.ibanMissing");
    const fields = { iban: "de89370400440532013000", holder: "Mira", bic: "deutdeff" };
    expect(fieldProblems("bank_account", fields, NOW)).toEqual({});
    expect(fieldProblems("bank_account", { ...fields, bic: "DEUT" }, NOW).bic?.key).toBe(
      "vault.bank.bicInvalid",
    );
    expect(
      rotateBody({ kind: "bank_account", token: "", username: "", password: "", fields }),
    ).toEqual({
      value: { iban: "DE89370400440532013000", holder: "Mira", bic: "DEUTDEFF" },
    });
  });
});

describe("login extras", () => {
  test("accepts a base32 seed or a standard otpauth link and refuses non-standard codes", () => {
    expect(parseTotp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")?.secret).toBe(RFC_SEED);
    const uri = `otpauth://totp/Shop:mira@example.com?secret=${RFC_SEED}&issuer=Shop`;
    expect(parseTotp(uri)).toMatchObject({
      secret: RFC_SEED,
      account: "mira@example.com",
      issuer: "Shop",
    });
    expect(totpProblem("")).toBeNull();
    expect(totpProblem("short")?.key).toBe("vault.totp.invalid");
    expect(totpProblem(`otpauth://totp/x?secret=${RFC_SEED}&digits=8`)?.key).toBe(
      "vault.totp.unsupported",
    );
  });

  test("normalizes allowed websites and names the first one that is not https", () => {
    expect(
      normalizedOrigins("shop.example.com\nhttps://www.shop.example.com/login, shop.example.com"),
    ).toEqual({
      origins: ["https://shop.example.com", "https://www.shop.example.com"],
      invalid: null,
    });
    expect(normalizedOrigins("http://shop.example.com").invalid).toBe("http://shop.example.com");
    expect(normalizedOrigins("http://localhost:3000").origins).toEqual(["http://localhost:3000"]);
  });

  test("a login body carries the seed and origins, and clearing keeps only the origins", () => {
    const login = draft({
      kind: "login",
      username: "mira",
      password: "pw",
      fields: { totp: RFC_SEED.toLowerCase(), origins: "shop.example.com" },
    });
    expect(createBody(login)).toMatchObject({
      username: "mira",
      password: "pw",
      totp_seed: RFC_SEED,
      origins: ["https://shop.example.com"],
    });
    expect(withoutValues(login).fields).toEqual({ origins: "shop.example.com" });
    const websitesOnly = { ...login, username: "", password: "" };
    expect(rotateProblem(websitesOnly)).toBeNull();
    expect(rotateBody(websitesOnly)).toEqual({ origins: ["https://shop.example.com"] });
    expect(rotateProblem({ ...websitesOnly, username: "mira" })).toBe("vault.value.missingLogin");
  });
});

describe("TOTP preview", () => {
  test("matches the RFC 6238 vector and the shared implementation", async () => {
    expect(await totpPreview(RFC_SEED, 59_000)).toBe("287082");
    const at = Date.UTC(2026, 10, 27, 10, 0, 7);
    expect(await totpPreview(`otpauth://totp/a?secret=${RFC_SEED}`, at)).toBe(
      totpCode(RFC_SEED, at),
    );
    expect(await totpPreview("not a seed", at)).toBeNull();
    expect(totpSecondsLeft(RFC_SEED, 59_000)).toBe(1);
  });
});

describe("scope", () => {
  test("cards, bank accounts and identities are forced to only me with an explanation", () => {
    for (const kind of ["card", "bank_account", "identity"]) {
      expect(scopeFor(kind, "workspace")).toBe("person");
      expect(scopeChoices(kind, true)).toEqual(["person"]);
      expect(scopeNoteKey(kind, true)).toBe("vault.field.scopePersonalOnly");
    }
    expect(scopeFor("login", "workspace")).toBe("workspace");
    expect(scopeChoices("address", true)).toEqual(["workspace", "person"]);
    expect(scopeChoices("note", false)).toEqual(["person"]);
    expect(scopeNoteKey("note", true)).toBeNull();
    const en = translate("en", "vault.field.scopePersonalOnly");
    expect(en).not.toBe(translate("de", "vault.field.scopePersonalOnly"));
  });
});

describe("masking", () => {
  test("shows brand, last four and expiry for cards and the IBAN tail for bank accounts", () => {
    const card = maskedLine("card", {
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2028,
    });
    expect(card).toEqual({
      key: "vault.masked.card",
      values: { brand: "Visa", last4: "4242", expiry: "12/28" },
    });
    expect(translate("en", card?.key ?? "vault.masked.card", card?.values)).toBe(
      "Visa •••• 4242 · expires 12/28",
    );
    const iban = maskedLine("bank_account", { iban_last4: "1234", country: "DE" });
    expect(translate("en", iban?.key ?? "vault.masked.iban", iban?.values)).toBe("IBAN •••• 1234");
    expect(maskedLine("card", { brand: "weird", last4: "1111" })?.key).toBe(
      "vault.masked.cardNoBrand",
    );
    expect(maskedLine("login", { username_hint: "mi…", has_totp: true })?.key).toBe(
      "vault.masked.loginTotp",
    );
    expect(maskedLine("secret", {})).toBeNull();
  });

  test("reads metadata from the object form only and flags expired cards", () => {
    expect(metadataOf({ fields: ["token"] })).toEqual({});
    expect(metadataOf({ metadata: { last4: "4242" } })).toEqual({ last4: "4242" });
    expect(cardExpired({ exp_month: 10, exp_year: 2026 }, NOW)).toBe(true);
    expect(cardExpired({ exp_month: 11, exp_year: 2026 }, NOW)).toBe(false);
  });
});

describe("fresh sign-in refusal", () => {
  test("is recognized by its code and gets its own next step", () => {
    const refusal = {
      status: 403,
      code: "forbidden",
      details: { reason: "reauthentication_required" },
    };
    expect(isFreshAuthRefusal(refusal)).toBe(true);
    expect(vaultErrorKey(refusal, "card")).toBe("vault.error.freshAuth");
    expect(vaultErrorKey({ status: 403, code: "forbidden" }, "card")).toBe("vault.error.forbidden");
    expect(translate("en", "vault.error.freshAuth")).not.toBe(
      translate("de", "vault.error.freshAuth"),
    );
  });
});
