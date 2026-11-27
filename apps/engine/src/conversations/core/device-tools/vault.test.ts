import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BrowserPayArgsSchema, BrowserSignInArgsSchema } from "@shared/device/browser.ts";
import { decideDeviceTool } from "../../instruction-cover/device-decision.ts";
import { chatJob, chatRequest, type JobState } from "../../instruction-cover/job.ts";
import { commandArgsOf, deviceToolSpec, isVaultTool } from "./catalog.ts";
import type { DeviceStepRecord } from "./history.ts";
import { personalBoundary } from "./palette.ts";
import {
  formatAmount,
  namedRefs,
  payFieldFrames,
  payPageFingerprintSource,
  sameElements,
  vaultDeviceStep,
  vaultPage,
  vaultResultOf,
  vaultToolData,
} from "./vault.ts";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://shop.example";

const SNAPSHOT: DeviceStepRecord = {
  tool: "browser_snapshot",
  device_id: "d1",
  origin: ORIGIN,
  snapshot_id: "snap-1",
  window_id: null,
  state_hash: null,
  app: null,
  refs: {
    e1: { role: "textbox", name: "E-Mail" },
    e2: { role: "textbox", name: "Password" },
    e3: { role: "button", name: "Sign in" },
    e4: { role: "textbox", name: "Card number" },
    e5: { role: "button", name: "Pay now" },
  },
  filled: [],
};

const SIGN_IN = {
  snapshot_id: "snap-1",
  origin: ORIGIN,
  vault_item: "me.shop",
  username_ref: "e1",
  password_ref: "@e2",
  submit_ref: "e3",
};

function job(): { request: ReturnType<typeof chatRequest>; job: JobState } {
  return {
    request: chatRequest([{ id: "m1", kind: "message", text: "Kauf mir Kaffee" }], [], "UTC"),
    job: {
      ...chatJob({ anchor_id: "job", anchor_at: NOW }),
      device: personalBoundary([
        { kind: "site", display: ORIGIN, entered_by: "person", keep_out_target: null },
      ]),
    },
  };
}

function chat(text: string) {
  return {
    ...job(),
    request: chatRequest([{ id: "m1", kind: "message", text }], [], "UTC"),
  };
}

describe("the vault tools are in the catalog and keep values out of their input", () => {
  test("both tools exist and are vault tools", () => {
    expect(isVaultTool("browser_sign_in")).toBe(true);
    expect(isVaultTool("browser_pay")).toBe(true);
    expect(isVaultTool("browser_fill")).toBe(false);
  });

  test("the model cannot pass a password or card number", () => {
    const signIn = deviceToolSpec("browser_sign_in");
    const pay = deviceToolSpec("browser_pay");
    expect(signIn?.input.safeParse({ ...SIGN_IN, password: "x" }).success).toBe(false);
    expect(
      pay?.input.safeParse({
        snapshot_id: "s",
        origin: ORIGIN,
        card: "4242",
        amount_minor: 100,
        currency: "EUR",
        number_ref: "e4",
        submit_ref: "e5",
        number: "4242424242424242",
      }).success,
    ).toBe(false);
  });

  test("the generic args mapping never carries the vault reference to the device", () => {
    const spec = deviceToolSpec("browser_sign_in");
    if (!spec) throw new Error("missing");
    const args = commandArgsOf(spec, SIGN_IN, {
      partition: "c-1",
      window_id: null,
      state_hash: null,
    });
    expect(JSON.stringify(args)).not.toContain("me.shop");
  });
});

describe("a vault step binds to the latest snapshot and its exact origin", () => {
  test("collects the named refs without the @", () => {
    expect(namedRefs("browser_sign_in", SIGN_IN)).toEqual({
      username: "e1",
      password: "e2",
      submit: "e3",
    });
  });

  test("accepts the fresh snapshot", () => {
    const page = vaultPage("browser_sign_in", SIGN_IN, [SNAPSHOT]);
    expect("ok" in page).toBe(false);
    if ("ok" in page) return;
    expect(page.origin).toBe(ORIGIN);
    expect(Object.keys(page.elements).sort()).toEqual(["e1", "e2", "e3"]);
  });

  test.each([
    [
      "a look-alike origin",
      { ...SIGN_IN, origin: "https://shop.example.evil.test" },
      "origin_mismatch",
    ],
    ["an older snapshot", { ...SIGN_IN, snapshot_id: "snap-0" }, "other_snapshot"],
    ["a ref not on the page", { ...SIGN_IN, submit_ref: "e99" }, "unknown_ref"],
    ["no ref at all", { snapshot_id: "snap-1", origin: ORIGIN, vault_item: "x" }, "unknown_ref"],
  ])("refuses %s", (_label, input, code) => {
    const page = vaultPage("browser_sign_in", input, [SNAPSHOT]);
    expect("ok" in page && page.error_code).toBe(code);
  });

  test("refuses a plain http page that is not this computer", () => {
    const page = vaultPage("browser_sign_in", { ...SIGN_IN, origin: "http://shop.example" }, [
      { ...SNAPSHOT, origin: "http://shop.example" },
    ]);
    expect("ok" in page && page.error_code).toBe("origin_not_secure");
  });

  test("refuses when another step ran after the snapshot", () => {
    const page = vaultPage("browser_sign_in", SIGN_IN, [
      { ...SNAPSHOT, tool: "browser_press", snapshot_id: null },
      SNAPSHOT,
    ]);
    expect("ok" in page && page.error_code).toBe("snapshot_used");
  });

  test("a recheck finds the same elements or reports a change", () => {
    const page = vaultPage("browser_sign_in", SIGN_IN, [SNAPSHOT]);
    if ("ok" in page) throw new Error("page");
    const same = {
      snapshot: {
        snapshot:
          '- textbox "E-Mail" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]',
      },
    };
    const moved = {
      snapshot: { snapshot: '- textbox "E-Mail" [ref=e1]\n- button "Delete account" [ref=e3]' },
    };
    expect(sameElements(page.elements, same)).toBe(true);
    expect(sameElements(page.elements, moved)).toBe(false);
  });
});

describe("the payment binding is stable and complete", () => {
  const input = {
    snapshot_id: "snap-1",
    origin: ORIGIN,
    card: "4242",
    amount_minor: 1299,
    currency: "EUR",
    number_ref: "e4",
    submit_ref: "e5",
  };

  test("fingerprint and frames cover every named field", () => {
    const page = vaultPage("browser_pay", input, [SNAPSHOT]);
    if ("ok" in page) throw new Error("page");
    const fingerprint = payPageFingerprintSource(page);
    expect(fingerprint).toContain(ORIGIN);
    expect(payPageFingerprintSource(page)).toBe(fingerprint);
    expect(payFieldFrames(page)).toEqual({ number: ORIGIN, submit: ORIGIN });
    const renamed = vaultPage("browser_pay", input, [
      { ...SNAPSHOT, refs: { ...SNAPSHOT.refs, e5: { role: "button", name: "Donate" } } },
    ]);
    if ("ok" in renamed) throw new Error("page");
    expect(payPageFingerprintSource(renamed)).not.toBe(fingerprint);
  });

  test("the fingerprint input is the one the desktop recomputes (pinned)", () => {
    const page = vaultPage("browser_pay", input, [SNAPSHOT]);
    if ("ok" in page) throw new Error("page");
    const source = payPageFingerprintSource(page);
    expect(source).toBe(
      '["pay-page:v1","https://shop.example",[["number","textbox","Card number"],["submit","button","Pay now"]]]',
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "03f75726ea82abbe135001b196ed55a2582d87c110cd65044c023888c6ac52fd",
    );
  });

  test("device args validate with a ticket and reject unknown keys", () => {
    const page = vaultPage("browser_pay", input, [SNAPSHOT]);
    if ("ok" in page) throw new Error("page");
    const args = {
      partition: "c-1",
      origin: ORIGIN,
      page_fingerprint: "a".repeat(64),
      fields: page.refs,
      field_frames: payFieldFrames(page),
      amount_minor: 1299,
      currency: "EUR",
      secret_ticket: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    };
    expect(BrowserPayArgsSchema.safeParse(args).success).toBe(true);
    expect(BrowserPayArgsSchema.safeParse({ ...args, cvv: "123" }).success).toBe(false);
    expect(
      BrowserSignInArgsSchema.safeParse({
        origin: ORIGIN,
        fields: { password: "e2" },
        secret_ticket: args.secret_ticket,
        kind: "password",
        password: "x",
      }).success,
    ).toBe(false);
  });
});

describe("a vault step always needs the person", () => {
  const step = (tool: string, quote: string | null) => ({
    step: vaultDeviceStep({ tool, job_id: "job", origin: ORIGIN, quote }),
    other_paths: [],
    blocked: null,
  });

  test("a sign-in without the person's words asks", () => {
    const decision = decideDeviceTool({
      ...job(),
      assembled: step("browser_sign_in", null),
      ask_before_writing: false,
      now: NOW,
    });
    expect(decision.decision).toBe("ask");
  });

  test("a sign-in the person asked for on this site runs", () => {
    const decision = decideDeviceTool({
      ...chat("Melde dich bei shop.example an"),
      assembled: step("browser_sign_in", "Melde dich bei shop.example an"),
      ask_before_writing: false,
      now: NOW,
    });
    expect(decision.decision).toBe("covered");
  });

  test("a payment asks even when the person asked for it", () => {
    const decision = decideDeviceTool({
      ...chat("Bezahle bei shop.example"),
      assembled: step("browser_pay", "Bezahle bei shop.example"),
      ask_before_writing: false,
      now: NOW,
    });
    expect(decision).toMatchObject({ decision: "ask", reason: "always_ask" });
  });
});

describe("the model sees no values in a vault result", () => {
  test("known values and card numbers are removed from the returned snapshot", () => {
    const result = vaultResultOf({
      filled: true,
      submitted: true,
      outcome: "submitted",
      snapshot: {
        snapshot:
          '- text "Welcome anna@shop.example, card 4242 4242 4242 4242" [ref=e1]\n- text "pw hunter2-secret" [ref=e2]',
      },
    });
    if (!result) throw new Error("result");
    const data = vaultToolData(result, "note", ["hunter2-secret"]);
    const text = JSON.stringify(data);
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("4242 4242 4242 4242");
    expect(data).toMatchObject({ filled: true, submitted: true, outcome: "submitted" });
  });

  test("a refused fill without a snapshot keeps the reason and adds no page", () => {
    const result = vaultResultOf({
      filled: false,
      submitted: false,
      outcome: "refused",
      reason: "the page asked for a different card",
    });
    if (!result) throw new Error("result");
    const data = vaultToolData(result, "nothing was entered", []);
    expect(data).toEqual({
      filled: false,
      submitted: false,
      outcome: "refused",
      note: "nothing was entered",
      reason: "the page asked for a different card",
    });
    expect(data).not.toHaveProperty("snapshot");
  });

  test("an unexpected device output is not a vault result", () => {
    expect(vaultResultOf({ filled: true, value: "x" })).toBeNull();
  });
});

describe("the amount the person confirms reads in their language", () => {
  test("minor units become the major amount in the locale's currency format", () => {
    expect(formatAmount(1250, "EUR", "de")).toBe("12,50\u00a0€");
    expect(formatAmount(123450, "EUR", "en")).toBe("€1,234.50");
    expect(formatAmount(999, "USD", "en")).toBe("$9.99");
  });
});
