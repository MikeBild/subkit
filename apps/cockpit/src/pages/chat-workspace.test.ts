import { describe, expect, test } from "bun:test";
import { chatContextState } from "./chat-workspace";

describe("chat context preference", () => {
  test("automatic context appears only when a conversation and room are available", () => {
    expect(chatContextState(1500, null, true)).toEqual({ docked: true, open: true });
    expect(chatContextState(1000, null, true)).toEqual({ docked: false, open: false });
    expect(chatContextState(1500, null, false)).toEqual({ docked: true, open: false });
  });

  test("manual close remains closed when more space becomes available", () => {
    expect(chatContextState(1000, "closed", true).open).toBe(false);
    expect(chatContextState(1600, "closed", true).open).toBe(false);
  });

  test("manual open stays open while presentation changes with available space", () => {
    expect(chatContextState(900, "open", true)).toEqual({ docked: false, open: true });
    expect(chatContextState(1500, "open", true)).toEqual({ docked: true, open: true });
    expect(chatContextState(1500, "open", false).open).toBe(true);
  });
});
