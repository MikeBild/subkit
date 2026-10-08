import { describe, expect, test } from "bun:test";
import { nextQuestion, nextRecommendedAction } from "../onboarding-policy.ts";
import type { DraftDocument } from "../types.ts";

function draft(overrides: Partial<DraftDocument> = {}): DraftDocument {
  return {
    workflow: { name: "new-workflow", steps: [] },
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

  test("templated connector base_url with unresolved placeholders still asks for endpoint values", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "connector_authoring",
        connector: {
          name: "Shopify",
          driver: "http",
          auth_type: "bearer",
          base_url: "https://{shop}.myshopify.com/admin/api/2024-07",
        },
      }),
    });
    expect(a.kind).toBe("connector_base_url");
    expect(a.summary).toContain("shop");
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
        workflow: { name: "w", steps: [] },
      }),
    });
    expect(a.kind).toBe("workflow_goal");
  });

  test("workflow onboarding explains the initiator within its existing goal question", () => {
    const input = { draft: draft({ mode: "workflow_authoring" }) };
    const question = nextQuestion(input);
    expect(question?.subject).toBe("workflow_goal");
    expect(question?.kind).toBe("text");
    expect(question?.prompt).toContain("who or what starts it");
    expect(question?.prompt).toContain("whose data it may access");
    expect(question?.prompt).toContain("do not put login tokens");
    expect(nextRecommendedAction(input).summary).toContain("human approval");
  });

  test("connector sign-in guidance does not imply workflow identity or approval", () => {
    const question = nextQuestion({
      draft: draft({
        mode: "connector_authoring",
        connector: { name: "Reporting service", driver: "http" },
      }),
    });
    expect(question?.subject).toBe("connector_auth_method");
    expect(question?.kind).toBe("choice");
    expect(question?.options?.map((option) => option.id)).toEqual([
      "none",
      "bearer",
      "basic",
      "oauth2",
      "custom",
    ]);
    expect(question?.prompt).toContain("does not identify the person");
    expect(question?.prompt).toContain("approve its actions");
  });

  test("workflow with steps but no preview → recommend preview", () => {
    const a = nextRecommendedAction({
      draft: draft({
        mode: "workflow_authoring",
        workflow: {
          name: "w",
          steps: [{ id: "s1", kind: "request", url: "https://example.com" }],
        },
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
        latest_preview: { ok: true, step_id: "s1", summary: "ok" },
      }),
    });
    expect(a.kind).toBe("workflow_commit");
  });
});
