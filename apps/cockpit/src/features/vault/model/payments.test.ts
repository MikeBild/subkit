import { afterEach, describe, expect, jest, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { translate } from "@/lib/i18n";
import { detectFormat, importCounts, importFileProblem, importRows } from "./import";
import {
  approvalMutation,
  countdownLabel,
  cvvProblem,
  formatMinor,
  PANEL_START,
  panelStep,
  paymentErrorKey,
  paymentFromUrl,
  paymentView,
  secondsLeft,
} from "./payments";
import { usageLine, usageTone } from "./uses";

afterEach(() => {
  jest.useRealTimers();
});

const ID = "6f1c2b9e-4a7d-4c1e-9b3a-2d5e8f7a1c04";

describe("payment view", () => {
  test("reads the masked card and keeps only the host of the shop", () => {
    const flat = paymentView({
      id: ID,
      status: "pending",
      origin: "https://shop.example.com",
      amount_minor: 1234,
      currency: "eur",
      card: { brand: "visa", last4: "4242" },
      expires_at: "2026-11-27T10:15:00Z",
    });
    expect(flat).toMatchObject({
      host: "shop.example.com",
      currency: "EUR",
      brand: "visa",
      last4: "4242",
    });
    const nested = paymentView({ id: ID, card: { brand: "amex", last4: "0005" } });
    expect(nested).toMatchObject({ brand: "amex", last4: "0005", status: "pending" });
  });

  test("formats minor units per currency and locale", () => {
    const de = formatMinor("de", 1234, "EUR");
    const en = formatMinor("en", 1234, "EUR");
    expect(de).not.toBe(en);
    expect(de).toBe(
      new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(12.34),
    );
    expect(formatMinor("en", 1234, "USD")).toBe("$12.34");
    expect(formatMinor("en", 1234, "JPY")).toBe("¥1,234");
  });

  test("counts down to the expiry and stops at zero", () => {
    const now = Date.parse("2026-11-27T10:00:00Z");
    expect(secondsLeft("2026-11-27T10:14:32Z", now)).toBe(872);
    expect(countdownLabel(872)).toBe("14:32");
    expect(secondsLeft("2026-11-27T09:00:00Z", now)).toBe(0);
    expect(secondsLeft(null, now)).toBeNull();
  });

  test("reads the payment id from the link the attention item opens", () => {
    expect(paymentFromUrl(`?area=vault&payment=${ID}`)).toBe(ID);
    expect(paymentFromUrl("?payment=../../etc")).toBeNull();
  });
});

describe("CVV", () => {
  test("needs 3 digits, or 4 for American Express", () => {
    expect(cvvProblem("123", "visa")).toBeNull();
    expect(cvvProblem("1234", "amex")).toBeNull();
    expect(cvvProblem("123", "amex")).toBe("vault.payment.cvvFour");
    expect(cvvProblem("1234", "visa")).toBe("vault.payment.cvvThree");
    expect(cvvProblem("12", null)).toBe("vault.payment.cvvLength");
    expect(cvvProblem("", "visa")).toBe("vault.payment.cvvMissing");
    expect(cvvProblem("12a", "visa")).toBe("vault.payment.cvvDigits");
  });

  test("the panel keeps only digits and forgets the CVV on submit, decline, failure and close", () => {
    const typed = panelStep(PANEL_START, { type: "type", cvv: "1a2 3 45" });
    expect(typed.cvv).toBe("1234");
    expect(panelStep(typed, { type: "invalid" })).toMatchObject({ cvv: "1234", touched: true });
    const approving = panelStep(typed, { type: "approve" });
    expect(approving).toMatchObject({ cvv: "", phase: "approving" });
    expect(panelStep(approving, { type: "approved" })).toMatchObject({
      cvv: "",
      phase: "submitted",
    });
    expect(panelStep(typed, { type: "reject" }).cvv).toBe("");
    expect(
      panelStep(typed, { type: "failed", error: "vault.payment.error.generic" }),
    ).toMatchObject({ cvv: "", error: "vault.payment.error.generic" });
    expect(panelStep(typed, { type: "close" })).toEqual(PANEL_START);
  });

  test("approval sends the CVV once and leaves no trace of it in the query client", async () => {
    const calls: { id: string; cvv: string }[] = [];
    jest.useFakeTimers();
    const client = new QueryClient();
    const observer = new MutationObserver(
      client,
      approvalMutation(async (id, cvv) => {
        calls.push({ id, cvv });
      }),
    );
    await observer.mutate({ id: ID, cvv: "737" });
    observer.reset();
    jest.runAllTimers();
    expect(calls).toEqual([{ id: ID, cvv: "737" }]);
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain("737");
    expect(observer.getCurrentResult().variables).toBeUndefined();
  });

  test("a failed approval is not retried and also leaves no CVV behind", async () => {
    let calls = 0;
    jest.useFakeTimers();
    const client = new QueryClient();
    const observer = new MutationObserver(
      client,
      approvalMutation(async () => {
        calls += 1;
        throw Object.assign(new Error("gone"), { status: 410 });
      }),
    );
    const failure = await observer.mutate({ id: ID, cvv: "4321" }).catch((error: unknown) => error);
    expect(paymentErrorKey(failure)).toBe("vault.payment.error.expired");
    observer.reset();
    jest.runAllTimers();
    expect(calls).toBe(1);
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain("4321");
  });

  test("errors name a next step and the submitted wording differs per language", () => {
    expect(paymentErrorKey({ status: 409 })).toBe("vault.payment.error.settled");
    expect(paymentErrorKey({ status: 403 })).toBe("vault.payment.error.forbidden");
    expect(paymentErrorKey({ status: 422 })).toBe("vault.payment.error.cvv");
    expect(translate("en", "vault.payment.submitted")).toContain("isn’t confirmed as paid");
    expect(translate("de", "vault.payment.submitted")).not.toBe(
      translate("en", "vault.payment.submitted"),
    );
  });
});

describe("activity uses", () => {
  test("shows purpose, website and outcome of a use", () => {
    const entry = {
      action: "vault.item.used",
      metadata: { purpose: "pay", origin: "https://shop.example.com", outcome: "uncertain" },
    };
    expect(usageLine(entry)).toEqual({
      purpose: "vault.use.purpose.pay",
      origin: "shop.example.com",
      outcome: "vault.use.outcome.uncertain",
    });
    expect(usageTone(entry)).toBe("warn");
    expect(usageLine({ action: "vault.item.used", metadata: { step: "s1" } })).toBeNull();
  });
});

describe("CSV import", () => {
  test("recognizes Chrome, 1Password and Bitwarden exports by their header", () => {
    expect(detectFormat("name,url,username,password,note\n")).toBe("chrome");
    expect(detectFormat('"Title","Url","Username","Password","OTPAuth"\n')).toBe("1password");
    expect(
      detectFormat(
        "﻿folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      ),
    ).toBe("bitwarden");
    expect(detectFormat("a,b,c")).toBeNull();
    expect(importFileProblem({ name: "x.txt", size: 10 })).toBe("vault.import.error.notCsv");
    expect(importFileProblem({ name: "x.csv", size: 3 * 1024 * 1024 })).toBe(
      "vault.import.error.tooLarge",
    );
  });

  test("the dry-run preview counts rows by status", () => {
    const rows = importRows({
      rows: [
        { name: "shop", origin: "https://shop.example.com", status: "create", has_totp: true },
        { name: "mail", status: "exists" },
        { name: "", status: "weird" },
      ],
    });
    expect(rows[0]?.hasTotp).toBe(true);
    expect(importCounts(rows)).toEqual({ new: 1, created: 0, exists: 1, invalid: 1 });
  });
});
