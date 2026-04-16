// Render the chat surface with a canned state and assert that the
// context line, tool panel, draft panel, and approval banner appear.
//
// We don't drive keypresses here — those would require a running event
// loop inside the chat loop which is out of scope for P15.

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import React from "react";
import { App } from "../chat-ui/app.tsx";
import { initialState } from "../chat-ui/hooks.ts";

describe("chat-ui App", () => {
  test("renders context, tool panel, and draft view", () => {
    const state = initialState("conv-123", "tenant-abc");
    state.context.skills = ["slack-search"];
    state.context.connector = "slack";
    state.context.token_budget = 4096;
    state.messages.push({ role: "user", content: "hi" });
    state.messages.push({ role: "assistant", content: "hello back" });
    state.toolCalls.push({
      id: "t1",
      name: "propose_step",
      args: { kind: "http" },
      status: "running",
    });
    state.draft = { version: 1, steps: ["a", "b"] };

    const instance = render(React.createElement(App, { state }));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("tenant-abc");
    expect(frame).toContain("slack-search");
    expect(frame).toContain("propose_step");
    expect(frame).toContain("running");
    expect(frame).toContain("draft");
    expect(frame).toContain("hello back");
    expect(frame).toContain("conv-123");
    cleanup();
  });

  test("renders pending approval banner when set", () => {
    const state = initialState(null, null);
    state.pendingApproval = {
      id: "appr-1",
      title: "commit_draft",
      diff: "+ added step echo",
    };
    const instance = render(React.createElement(App, { state }));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("approval needed");
    expect(frame).toContain("commit_draft");
    expect(frame).toContain("added step echo");
    cleanup();
  });
});
