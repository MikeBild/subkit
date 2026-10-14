import { describe, expect, test } from "bun:test";
import {
  chatAvailableWidth,
  chatContextControlsTarget,
  chatContextDockWidth,
  chatContextPreference,
  chatContextState,
  chatConversationListDocked,
  storedChatContextPreference,
} from "./chat-workspace";

describe("chat context preference", () => {
  test("the conversation list stays above the transcript until the workspace can fit both", () => {
    expect(chatConversationListDocked(943)).toBe(false);
    expect(chatConversationListDocked(944)).toBe(true);
    expect(chatAvailableWidth(943, 264, chatConversationListDocked(943))).toBe(943);
    expect(chatAvailableWidth(944, 264, chatConversationListDocked(944))).toBe(680);
  });

  test("automatic context appears only when a conversation and room are available", () => {
    expect(chatContextState(1500, null, true)).toMatchObject({ docked: true, open: true });
    expect(chatContextState(1000, null, true)).toMatchObject({ docked: false, open: false });
    expect(chatContextState(1500, null, false)).toMatchObject({ docked: true, open: false });
  });

  test("available chat width excludes the conversation list only while it is beside the transcript", () => {
    expect(chatAvailableWidth(1500, 264, true)).toBe(1236);
    expect(chatAvailableWidth(900, 900, false)).toBe(900);
  });

  test("the inspector adapts to wide layouts and leaves a readable transcript before docking", () => {
    expect(chatContextDockWidth(1200)).toBe(408);
    expect(chatContextDockWidth(2400)).toBe(640);
    expect(chatContextState(1029, null, true).docked).toBe(false);
    expect(chatContextState(1030, null, true).docked).toBe(true);
  });

  test("aria-controls points at the context only while a conversation panel is rendered", () => {
    expect(chatContextControlsTarget(false, true)).toBeUndefined();
    expect(chatContextControlsTarget(true, false)).toBeUndefined();
    expect(chatContextControlsTarget(true, true)).toBe("chat-context-content");
  });

  test("a close saved on a narrow layout does not suppress the wide default", () => {
    const preference = storedChatContextPreference("closed");
    expect(chatContextState(1000, preference, true).open).toBe(false);
    expect(chatContextState(1600, preference, true).open).toBe(true);
  });

  test("a close saved on a wide layout remains an explicit wide choice", () => {
    const preference = chatContextPreference(false, 1600);
    expect(preference).toBe("wide-closed");
    expect(chatContextState(1600, preference, true).open).toBe(false);
    expect(chatContextState(1000, preference, true).open).toBe(false);
    expect(chatContextState(1600, preference, true).open).toBe(false);
  });

  test("manual open stays open while presentation changes with available space", () => {
    const preference = chatContextPreference(true, 1600);
    expect(chatContextState(900, preference, true)).toMatchObject({ docked: false, open: false });
    expect(chatContextState(1500, preference, true)).toMatchObject({ docked: true, open: true });
    expect(chatContextState(1500, preference, false).open).toBe(false);
  });

  test("a manual open on a narrow layout remains scoped to that layout", () => {
    const preference = chatContextPreference(true, 900);
    expect(chatContextState(900, preference, true).open).toBe(true);
    expect(chatContextState(1500, preference, false).open).toBe(false);
  });

  test("unknown stored values do not override responsive defaults", () => {
    expect(storedChatContextPreference("unexpected")).toBeNull();
    expect(chatContextState(1500, storedChatContextPreference("unexpected"), true).open).toBe(true);
  });
});
