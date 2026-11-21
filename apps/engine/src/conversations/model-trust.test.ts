import { describe, expect, test } from "bun:test";
import { writesModelChecked } from "./model-trust.ts";
import { decideToolMode } from "./tool-policies.ts";

const cloud = { provider: "anthropic", providers: { anthropic: { base_url: "" } } };
const localServer = {
  provider: "openai",
  providers: { openai: { base_url: "http://127.0.0.1:11434/v1" } },
};

describe("writes and the model check", () => {
  test("server mode trusts every configured model as before", () => {
    expect(writesModelChecked("server", { provider: "mock", providers: {} })).toBe(true);
    expect(writesModelChecked("server", localServer)).toBe(true);
  });

  test("local mode counts only a cloud provider at its own address as checked", () => {
    expect(writesModelChecked("local_workspace", cloud)).toBe(true);
    expect(writesModelChecked("local_workspace", localServer)).toBe(false);
    expect(writesModelChecked("local_workspace", { provider: "mock", providers: {} })).toBe(false);
  });

  test("an unchecked model makes auto ask before every write, even when covered", () => {
    const base = {
      tool: "create_connector",
      category: "tenant_write" as const,
      input: {},
      overrides: {},
      instruction_covered: true,
    };
    expect(decideToolMode({ ...base, model_checked: false }).mode).toBe("confirm_before_execution");
    expect(decideToolMode({ ...base, category: "tenant_read", model_checked: false }).mode).toBe(
      "no_confirm",
    );
    expect(decideToolMode(base)).toEqual(decideToolMode({ ...base, model_checked: true }));
  });
});
