import { describe, expect, test } from "bun:test";
import {
  conversationVisibility,
  VISIBILITY_IDLE,
  type VisibilityState,
  type VisibilityTarget,
  visibilityActionFor,
  visibilityDialogOpen,
  visibilityReducer,
} from "./visibility";

const target: VisibilityTarget = { id: "c1", title: "Quarterly numbers", action: "share" };

describe("conversation visibility", () => {
  test("unknown or missing visibility counts as private", () => {
    expect(conversationVisibility({ id: "c", visibility: "team" })).toBe("team");
    expect(conversationVisibility({ id: "c", visibility: "odd" })).toBe("private");
    expect(conversationVisibility({ id: "c" })).toBe("private");
    expect(conversationVisibility(null)).toBe("private");
  });

  test("the action is the way back from the current visibility", () => {
    expect(visibilityActionFor("private")).toBe("share");
    expect(visibilityActionFor("team")).toBe("unshare");
  });
});

describe("visibilityReducer", () => {
  test("idle → confirming → saving → done", () => {
    const confirming = visibilityReducer(VISIBILITY_IDLE, { type: "ask", target });
    expect(confirming).toEqual({ phase: "confirming", target });
    expect(visibilityDialogOpen(confirming)).toBe(true);
    const saving = visibilityReducer(confirming, { type: "confirm" });
    expect(saving).toEqual({ phase: "saving", target });
    const done = visibilityReducer(saving, { type: "saved", visibility: "team" });
    expect(done).toEqual({ phase: "done", target, visibility: "team" });
    expect(visibilityDialogOpen(done)).toBe(false);
  });

  test("a failed save keeps the dialog open for a retry or a cancel", () => {
    const failed = visibilityReducer({ phase: "saving", target }, { type: "failed" });
    expect(failed).toEqual({ phase: "error", target });
    expect(visibilityDialogOpen(failed)).toBe(true);
    expect(visibilityReducer(failed, { type: "confirm" })).toEqual({ phase: "saving", target });
    expect(visibilityReducer(failed, { type: "cancel" })).toBe(VISIBILITY_IDLE);
  });

  test("a running save ignores cancel and a second ask", () => {
    const saving: VisibilityState = { phase: "saving", target };
    expect(visibilityReducer(saving, { type: "cancel" })).toBe(saving);
    expect(
      visibilityReducer(saving, { type: "ask", target: { ...target, action: "unshare" } }),
    ).toBe(saving);
  });

  test("events that do not fit the phase change nothing", () => {
    expect(visibilityReducer(VISIBILITY_IDLE, { type: "confirm" })).toBe(VISIBILITY_IDLE);
    expect(visibilityReducer(VISIBILITY_IDLE, { type: "saved", visibility: "team" })).toBe(
      VISIBILITY_IDLE,
    );
    expect(visibilityReducer(VISIBILITY_IDLE, { type: "failed" })).toBe(VISIBILITY_IDLE);
  });
});
