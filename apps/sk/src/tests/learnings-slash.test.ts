// /learnings — thin prompt-dispatch slash.
//
// The Ink host intercepts /learnings in dispatchSlashSubmit and submits the
// review-learnings starter prompt as a plain conversation turn (the same
// prompt the review-learnings TaskAction submits, so slash and starter action
// can't diverge). The registry gates it on skill:read; the dispatch path must
// honor that gate before submitting.

import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import { dispatchSlashSubmit, type SlashDispatchContext } from "../ink-app/submit-pipeline.ts";
import { REVIEW_LEARNINGS_STARTER_PROMPT } from "../repl/task-actions.ts";
import { findSlashCommand, INK_INTERCEPTED_ENGINE_SLASHES, type PersonaProbe } from "../slash.ts";

const allowAll: PersonaProbe = { allows: () => true };
const noSkillRead: PersonaProbe = { allows: (p) => p !== "skill:read" };

function makeCtx(probe: PersonaProbe) {
  const submitPrompt = mock((_prompt: string) => {});
  const showError = mock((_message: string) => {});
  const onSlash = mock(async () => null);
  const session = {
    conversationId: null,
    status: "idle",
    messages: [],
    toolCalls: [],
    usage: null,
    pendingElicitation: null,
  } as unknown as SkSessionState;
  const ctx: SlashDispatchContext = {
    session,
    busyRef: { current: false },
    personaProbe: probe,
    personaLabel: "admin",
    exit: () => {},
    onExit: undefined,
    onSlash,
    hasElicitHandler: false,
    setPane: () => {},
    showInfo: () => {},
    showError,
    showStructuredError: () => {},
    respondElicitation: async () => {},
    runYoloSlash: () => {},
    runBuiltin: async () => false,
    submitPrompt,
  };
  return { ctx, submitPrompt, showError, onSlash };
}

describe("/learnings registry entry", () => {
  test("is registered, gated by skill:read, in the context category", () => {
    const cmd = findSlashCommand("learnings");
    expect(cmd).toBeDefined();
    expect(cmd?.requires).toBe("skill:read");
    expect(cmd?.category).toBe("context");
  });

  test("is on the Ink engine-intercept allow-list (dispatcher contract)", () => {
    expect(INK_INTERCEPTED_ENGINE_SLASHES).toContain("learnings");
  });
});

describe("/learnings dispatch", () => {
  test("submits the review-learnings starter prompt and never reaches onSlash", async () => {
    const { ctx, submitPrompt, onSlash } = makeCtx(allowAll);
    const consumed = await dispatchSlashSubmit("/learnings", ctx);
    expect(consumed).toBe(true);
    expect(submitPrompt.mock.calls.length).toBe(1);
    expect(submitPrompt.mock.calls[0]?.[0]).toBe(REVIEW_LEARNINGS_STARTER_PROMPT);
    expect(onSlash.mock.calls.length).toBe(0);
  });

  test("is blocked with a structured error when the persona lacks skill:read", async () => {
    const { ctx, submitPrompt, showError } = makeCtx(noSkillRead);
    const consumed = await dispatchSlashSubmit("/learnings", ctx);
    expect(consumed).toBe(true);
    expect(submitPrompt.mock.calls.length).toBe(0);
    expect(showError.mock.calls.length).toBe(1);
    expect(String(showError.mock.calls[0]?.[0])).toContain("skill:read");
  });
});
