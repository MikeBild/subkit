import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONFIRMATION_TARGET_MAX } from "@shared/device/protocol.ts";
import type { DeviceStep } from "../../instruction-cover/job.ts";
import { bindingHash, confirmationQuestion, confirmationTarget } from "./confirm.ts";

const step = (over: Partial<DeviceStep> = {}): DeviceStep => ({
  kind: "device",
  job_id: "j",
  capability: "browser",
  phase: "commit",
  always_ask: "payment",
  name: "Jetzt kaufen",
  target: "https://shop.example.com",
  values: [],
  quote: null,
  ...over,
});

describe("the confirmation card", () => {
  test("names the element, the page and the values exactly", () => {
    expect(confirmationTarget("browser_press", step(), "de")).toBe(
      "Jetzt kaufen · https://shop.example.com",
    );
    expect(
      confirmationTarget(
        "browser_press",
        step({ name: null, target: null, values: ["a@b.c", ""] }),
        "de",
      ),
    ).toBe("browser_press · „a@b.c“ · „“");
    expect(confirmationTarget("t", step({ values: ["Hi"] }), "en")).toBe(
      "Jetzt kaufen · https://shop.example.com · “Hi”",
    );
  });

  test("stays inside the card's limit", () => {
    const long = confirmationTarget("t", step({ values: ["x".repeat(600)] }), "de");
    expect(long).toHaveLength(CONFIRMATION_TARGET_MAX);
    expect(long.endsWith("…")).toBe(true);
    const exact = confirmationTarget(
      "t",
      step({ name: "n", target: null, values: ["x".repeat(CONFIRMATION_TARGET_MAX - 6)] }),
      "de",
    );
    expect(exact).toHaveLength(CONFIRMATION_TARGET_MAX);
    expect(exact.endsWith("“")).toBe(true);
  });

  test("the binding hash changes with any bound part", () => {
    const base = { device_id: "d", kind: "browser.press", args: { ref: "e1" }, target: "t" };
    const hash = bindingHash(base);
    expect(hash).toBe(
      createHash("sha256")
        .update(JSON.stringify(["local_step", "d", "browser.press", { ref: "e1" }, "t"]))
        .digest("hex"),
    );
    expect(bindingHash({ ...base })).toBe(hash);
    for (const changed of [
      { ...base, device_id: "e" },
      { ...base, kind: "browser.fill" },
      { ...base, args: { ref: "e2" } },
      { ...base, target: "u" },
    ]) {
      expect(bindingHash(changed)).not.toBe(hash);
    }
  });

  test("the question in both languages", () => {
    expect(confirmationQuestion("de", "X")).toBe("Soll SubKit das auf deinem Gerät ausführen? X");
    expect(confirmationQuestion("en", "X")).toBe("Should SubKit do this on your device? X");
  });
});
