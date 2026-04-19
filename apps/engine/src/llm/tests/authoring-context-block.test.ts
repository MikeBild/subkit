// Authoring context block — structured text the loop pushes into the
// volatile cache segment on every turn.

import { describe, expect, test } from "bun:test";
import type { DraftDocument } from "../../conversations/types.ts";
import { renderAuthoringContextBlock } from "../core/authoring-context-block.ts";

function draft(overrides: Partial<DraftDocument> = {}): DraftDocument {
  return {
    workflow: { name: "new-workflow", steps: [] },
    ...overrides,
  } as DraftDocument;
}

describe("renderAuthoringContextBlock", () => {
  test("returns null when there is nothing to render", () => {
    expect(renderAuthoringContextBlock({ draft: null })).toBeNull();
  });

  test("renders mode and readiness when present", () => {
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "connector_authoring",
        summary: {
          readiness: "needs_input",
          next_action: "Add the base URL.",
          missing_fields: ["base_url"],
          last_action: null,
          progress_label: "Connector draft",
        },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("Mode: connector_authoring");
    expect(block!).toContain("Readiness: needs_input");
    expect(block!).toContain("Next recommended action");
    expect(block!).toContain("Missing: base_url");
  });

  test("renders connector fields without leaking secrets", () => {
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "connector_authoring",
        connector: {
          name: "Acme",
          slug: "acme",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          base_url: "https://api.example.com",
          // Credentials / DSN / config payloads must NEVER appear in the block.
          dsn: "postgres://user:pass@host/db",
          config: { secret_token: "hunter2" },
        },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("Acme");
    expect(block!).toContain("driver=http");
    expect(block!).toContain("base_url=https://api.example.com");
    expect(block!).not.toContain("hunter2");
    expect(block!).not.toContain("postgres://");
  });

  test("renders step summary for workflow drafts", () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i + 1}`,
      kind: i % 2 === 0 ? "request" : "transform",
    }));
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "workflow_authoring",
        workflow: { name: "my-flow", steps },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain('Workflow draft: "my-flow"');
    expect(block!).toContain("with 8 steps");
    expect(block!).toContain("s1: request");
    // First 6 steps listed, remainder elided.
    expect(block!).toContain("and 2 more");
    expect(block!).not.toContain("s7:");
  });

  test("includes a guided-next-step section", () => {
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "connector_authoring",
        connector: { name: "X", driver: "http", auth_type: "none" },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("## Guided next step");
    expect(block!).toContain("Action:");
    expect(block!).toContain("Why:");
  });
});
