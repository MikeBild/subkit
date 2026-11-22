import { describe, expect, test } from "bun:test";
import { renderTenantSummaryBlock } from "../../../llm/runtime/tenant-summary.ts";
import { generateMainAgentSystemPrompt } from "../context.ts";
import { SUBKIT_STATUS_GROUNDING } from "../prompts.ts";

const SNAPSHOT_DEFERENCE = "unless the tenant snapshot above already lists it";

describe("status grounding defers to the tenant snapshot", () => {
  test("the grounding rule carries the snapshot exception", () => {
    expect(SUBKIT_STATUS_GROUNDING).toContain(SNAPSHOT_DEFERENCE);
    expect(SUBKIT_STATUS_GROUNDING).toContain("answer ONLY from that source");
  });

  test("the chat-surface prompt renders the rule with the exception", async () => {
    const rendered = await generateMainAgentSystemPrompt({ surface: "chat" });
    expect(rendered.content).toContain("GROUNDING STATUS & INVENTORY QUESTIONS");
    expect(rendered.content).toContain(SNAPSHOT_DEFERENCE);
  });

  test("mcp and web prompts render the same rule", async () => {
    for (const surface of ["mcp", "web"] as const) {
      const rendered = await generateMainAgentSystemPrompt({ surface });
      expect(rendered.content, surface).toContain(SNAPSHOT_DEFERENCE);
    }
  });

  test("the snapshot's DO-NOT-call rule and the grounding rule name the same exception", () => {
    const snapshot = renderTenantSummaryBlock(
      {
        workflows: [
          { id: "w-1", slug: "nightly-sync", name: "Nightly", lifecycle: "active", is_tool: true },
        ],
        connectors: [],
        workflows_total: 1,
        connectors_total: 0,
      },
      new Set(["nightly-sync"]),
    ) as string;
    expect(snapshot).toContain("DO NOT call list_workflows");
    expect(SUBKIT_STATUS_GROUNDING).toContain("`list_workflows` / `list_connectors`");
    expect(SUBKIT_STATUS_GROUNDING).toContain(SNAPSHOT_DEFERENCE);
  });
});
