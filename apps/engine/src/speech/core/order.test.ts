import { describe, expect, test } from "bun:test";
import { type TranscriberAvailability, transcriberOrder } from "./order.ts";

const availability = (
  overrides: Partial<TranscriberAvailability> = {},
): TranscriberAvailability => ({
  primaryProvider: "anthropic",
  configured: { openai: false, azure: false, gemini: false },
  localAllowed: true,
  ...overrides,
});

describe("transcriberOrder", () => {
  test("off hides dictation even when providers are configured", () => {
    expect(
      transcriberOrder(
        "off",
        availability({ configured: { openai: true, azure: true, gemini: true } }),
      ),
    ).toEqual([]);
  });

  test("auto without any audio-capable key falls back to the local model", () => {
    expect(transcriberOrder("auto", availability())).toEqual(["local"]);
  });

  test("auto puts the primary provider first, then the other configured ones, then local", () => {
    expect(
      transcriberOrder(
        "auto",
        availability({
          primaryProvider: "gemini",
          configured: { openai: true, azure: false, gemini: true },
        }),
      ),
    ).toEqual(["gemini", "openai", "local"]);
  });

  test("auto keeps the fixed cloud order when the primary provider cannot transcribe", () => {
    expect(
      transcriberOrder(
        "auto",
        availability({ configured: { openai: true, azure: true, gemini: true } }),
      ),
    ).toEqual(["openai", "azure", "gemini", "local"]);
  });

  test("an explicit provider without its key leaves only the local model", () => {
    expect(transcriberOrder("azure", availability())).toEqual(["local"]);
  });

  test("an explicit provider with its key comes first", () => {
    expect(
      transcriberOrder(
        "azure",
        availability({ configured: { openai: true, azure: true, gemini: false } }),
      ),
    ).toEqual(["azure", "local"]);
  });

  test("local is empty when the local model is not allowed", () => {
    expect(transcriberOrder("local", availability({ localAllowed: false }))).toEqual([]);
    expect(transcriberOrder("auto", availability({ localAllowed: false }))).toEqual([]);
  });
});
