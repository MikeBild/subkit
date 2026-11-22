import { describe, expect, test } from "bun:test";
import type { Screen } from "./screens-model.ts";
import { frameFor, PATH_STEPS, stepIndex } from "./steps-model.ts";

const signin: Screen = {
  kind: "signin",
  origin: "https://subkit.example.com",
  host: "subkit.example.com",
  signin: { phase: "ready" },
  hint: null,
};

describe("step model", () => {
  test("every way in has the same fixed length and shares every step after the first", () => {
    for (const steps of Object.values(PATH_STEPS)) {
      expect(steps).toHaveLength(6);
      expect([...steps.slice(1)]).toEqual([...PATH_STEPS.server.slice(1)] as never);
    }
  });

  test("creating a workspace walks the same steps as connecting a server", () => {
    expect([...PATH_STEPS.create]).toEqual([...PATH_STEPS.server]);
    expect(stepIndex(signin, "create")).toBe(1);
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
