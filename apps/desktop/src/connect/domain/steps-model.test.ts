import { describe, expect, test } from "bun:test";
import type { Screen } from "./screens-model.ts";
import { frameFor, PATH_STEPS, stepIndex } from "./steps-model.ts";

const signin: Screen = {
  kind: "signin",
  origin: "https://subkit.example.com",
  host: "subkit.example.com",
  signin: { phase: "ready" },
  joining: false,
};

describe("step model", () => {
  test("both ways in have the same fixed length and share every step after the first", () => {
    expect(PATH_STEPS.server).toHaveLength(6);
    expect(PATH_STEPS.invite).toHaveLength(6);
    expect([...PATH_STEPS.server.slice(1)]).toEqual([...PATH_STEPS.invite.slice(1)] as never);
  });

  test("a screen keeps its place whatever came before it", () => {
    expect(stepIndex(signin, "server")).toBe(1);
    expect(stepIndex(signin, "invite")).toBe(1);
    const consent: Screen = { kind: "consent", topic: "diagnostics", choice: null };
    expect(frameFor(consent, "invite").dots).toEqual({ visible: true, current: 4, total: 6 });
  });

  test("screens outside the path hide the dots", () => {
    expect(stepIndex({ kind: "settings" }, "server")).toBeNull();
    const welcome: Screen = {
      kind: "welcome",
      invite: { open: false, link: "", checking: false, error: null },
    };
    expect(frameFor(welcome).dots.visible).toBe(false);
  });
});
