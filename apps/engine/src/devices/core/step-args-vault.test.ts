import { describe, expect, test } from "bun:test";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import { localStepArgs, parseLocalStep, VAULT_STEP_KINDS } from "./step-args.ts";

const DEVICE = "6f1c2a7e-1b2c-4d3e-8f90-0a1b2c3d4e5f";
const browser: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "browser",
  sites: [{ origin: "https://shop.example", private: false, site_digest: "c".repeat(64) }],
};

const SIGN_IN = {
  origin: "https://shop.example",
  vault_item: "me.shop",
  username: { role: "textbox", name: "E-Mail" },
  password: { role: "textbox", name: "Password" },
  submit: { role: "button", name: "Sign in" },
};

const PAY = {
  origin: "https://shop.example",
  card: "4242",
  amount_minor: 1299,
  currency: "EUR",
  number: { role: "textbox", name: "Card number" },
  submit: { role: "button", name: "Pay now" },
};

function plan(kind: "browser.sign_in" | "browser.pay", body: unknown, boundary = browser) {
  return localStepArgs({ kind, method: "POST", body, boundary, partition: "p1" });
}

describe("workflow steps sign in and pay only by vault reference", () => {
  test("both kinds are vault steps", () => {
    expect([...VAULT_STEP_KINDS].sort()).toEqual(["browser.pay", "browser.sign_in"]);
  });

  test("a sign-in step keeps the reference and the element targets apart", () => {
    const result = plan("browser.sign_in", SIGN_IN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.fields).toEqual({
      username: SIGN_IN.username,
      password: SIGN_IN.password,
      submit: SIGN_IN.submit,
    });
    expect(result.plan.args).toMatchObject({
      origin: "https://shop.example",
      vault_item: "me.shop",
      partition: "p1",
    });
    expect(result.plan.args.fields).toBeUndefined();
    expect(result.plan.args.username).toBeUndefined();
    expect(result.plan.args.submit).toBeUndefined();
  });

  test("a pay step needs the card number and the pay button", () => {
    expect(plan("browser.pay", PAY).ok).toBe(true);
    const { submit: _submit, ...withoutSubmit } = PAY;
    expect(plan("browser.pay", withoutSubmit)).toMatchObject({
      ok: false,
      code: "local_step_invalid",
    });
  });

  test("a sign-in step names at least one element", () => {
    const { username: _u, password: _p, submit: _s, ...bare } = SIGN_IN;
    expect(plan("browser.sign_in", bare)).toMatchObject({ ok: false, code: "local_step_invalid" });
  });

  test("the nested fields shape is not accepted", () => {
    const { username, password, submit, ...rest } = SIGN_IN;
    expect(
      plan("browser.sign_in", { ...rest, fields: { username, password, submit } }),
    ).toMatchObject({ ok: false, code: "local_step_invalid" });
  });

  test("a step cannot carry a value", () => {
    expect(plan("browser.sign_in", { ...SIGN_IN, password: "hunter2" })).toMatchObject({
      ok: false,
      code: "local_step_invalid",
    });
    expect(plan("browser.pay", { ...PAY, cvv: "123" })).toMatchObject({
      ok: false,
      code: "local_step_invalid",
    });
  });

  test("a site outside the approval is refused", () => {
    expect(
      plan("browser.sign_in", { ...SIGN_IN, origin: "https://shop.example.evil.test" }),
    ).toMatchObject({
      ok: false,
      code: "outside_boundary",
    });
  });

  test("a vault step changes something, so it never uses GET", () => {
    expect(
      parseLocalStep({ kind: "browser.pay", method: "GET", body: PAY, partition: "p1" }),
    ).toMatchObject({ ok: false, code: "local_method_mismatch" });
  });
});
