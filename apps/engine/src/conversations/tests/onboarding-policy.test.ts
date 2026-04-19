// Onboarding policy — deterministic recommendations from draft state.

import { describe, expect, test } from "bun:test";
import { nextQuestion, nextRecommendedAction } from "../onboarding-policy.ts";
import type { DraftDocument } from "../types.ts";

function draft(overrides: Partial<DraftDocument> = {}): DraftDocument {
  return {
    name: "new-workflow",
    steps: [],
    ...overrides,
  } as DraftDocument;
}

describe("onboarding policy", () => {
  test("no draft → intent classification", () => {
    const a = nextRecommendedAction({ draft: null });
    expect(a.kind).toBe("intent_classification");
    const q = nextQuestion({ draft: null });
    expect(q?.kind).toBe("choice");
    expect(q?.options?.map((o) => o.id)).toContain("connect_system");
  });

  test("pending approval trumps everything else", () => {
    const a = nextRecommendedAction({
      draft: draft({ mode: "connector_authoring" }),
      pending_approval: { tool_name: "ask_user_confirm", summary: "save connector?" },
    });
    expect(a.kind).toBe("resolve_pending_approval");
    const q = nextQuestion({
      draft: draft({ mode: "connector_authoring" }),
      pending_approval: { tool_name: "ask_user_confirm", summary: "save connector?" },
    });
    expect(q).toBeNull();
  });

  test("connector with no name → ask template or describe", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "connector_authoring",
        connector: {},
      }),
    });
    expect(a.kind).toBe("connector_template_or_describe");
  });

  test("connector missing auth → ask auth method", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "connector_authoring",
        connector: { name: "X", driver: "http" },
      }),
    });
    expect(a.kind).toBe("connector_auth_method");
  });

  test("connector missing base_url → ask for it", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "connector_authoring",
        connector: { name: "X", driver: "http", auth_type: "none" },
      }),
    });
    expect(a.kind).toBe("connector_base_url");
  });

  test("connector ready but unprobed → recommend probe", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "connector_authoring",
        connector: {
          name: "X",
          driver: "http",
          auth_type: "none",
          base_url: "https://api.example.com",
        },
      }),
    });
    expect(a.kind).toBe("connector_probe");
  });

  test("connector probed ok → recommend save", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "connector_authoring",
        connector: {
          name: "X",
          driver: "http",
          auth_type: "none",
          base_url: "https://api.example.com",
          latest_probe: { ok: true, method: "GET", path: "/", environment: "dev", summary: "ok" },
        },
      }),
    });
    expect(a.kind).toBe("connector_save");
  });

  test("workflow with no steps → ask for goal", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "workflow_authoring",
        steps: [],
        workflow: { name: "w", steps: [] },
      }),
    });
    expect(a.kind).toBe("workflow_goal");
  });

  test("workflow with steps but no preview → recommend preview", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "workflow_authoring",
        workflow: {
          name: "w",
          steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
        },
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
      }),
    });
    expect(a.kind).toBe("workflow_preview");
  });

  test("workflow previewed ok → recommend commit", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "workflow_authoring",
        workflow: {
          name: "w",
          steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
        },
        steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
        latest_preview: { ok: true, step_id: "s1", summary: "ok" },
      }),
    });
    expect(a.kind).toBe("workflow_commit");
  });
});
