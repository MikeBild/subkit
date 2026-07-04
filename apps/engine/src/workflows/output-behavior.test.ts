// Tests for `deriveOutputBehavior` — Polish A's derivation surface.

import { describe, expect, it } from "bun:test";
import { deriveOutputBehavior } from "./output-behavior.ts";

describe("deriveOutputBehavior", () => {
  it("returns explicit_transform when output_transform is set", () => {
    expect(deriveOutputBehavior({ output_transform: "data.body.storage.value" })).toBe(
      "explicit_transform",
    );
  });

  it("returns transform_function when output_transform_function is set", () => {
    expect(deriveOutputBehavior({ output_transform_function: "x => x.value" })).toBe(
      "transform_function",
    );
  });

  it("prefers explicit_transform when both are somehow set", () => {
    // Author error — Zod superRefine usually catches this, but the
    // derivation must not throw.
    expect(
      deriveOutputBehavior({
        output_transform: "data",
        output_transform_function: "x => x",
      }),
    ).toBe("explicit_transform");
  });

  it("returns last_step_passthrough when neither is set", () => {
    expect(deriveOutputBehavior({})).toBe("last_step_passthrough");
    expect(deriveOutputBehavior({ output_transform: null })).toBe("last_step_passthrough");
    expect(deriveOutputBehavior({ output_transform: undefined })).toBe("last_step_passthrough");
    expect(deriveOutputBehavior({ output_transform: "" })).toBe("last_step_passthrough");
  });
});
