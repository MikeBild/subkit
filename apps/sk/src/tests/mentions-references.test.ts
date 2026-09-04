// A named object travels as a reference, not as a paste.
//
// `@workflow:` and `@connector:` used to inline the whole GET payload into the
// prompt. That text is persisted on the user's message and replayed in full on
// every later turn, so one mention of a large object became permanent context
// for the rest of the conversation — and a deleted object went on appearing in
// the transcript as though it still existed. The engine resolves a reference
// itself, fresh, projected and budgeted, on each turn.
//
// Kinds the engine has no reference type for keep the inline copy: there is
// nothing on the other side to resolve them against yet, and dropping the
// payload would lose the answer rather than improve it.

import { describe, expect, it } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { resolveMentions } from "../mentions.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTOR_ID = "22222222-2222-4222-8222-222222222222";

/** A client that answers every GET with the same object. The cast is confined
 *  to this one place rather than repeated at each call site. */
function clientReturning(payload: Record<string, unknown>): EngineClient {
  return {
    async request() {
      return payload;
    },
  } as unknown as EngineClient;
}

describe("resolveMentions — workflows and connectors", () => {
  it("names a workflow instead of pasting it", async () => {
    const resolved = await resolveMentions("prüfe @workflow:monatsreport bitte", {
      client: clientReturning({ id: WORKFLOW_ID, slug: "monatsreport", dag: { huge: "x" } }),
    });
    expect(resolved.references).toEqual([
      { type: "workflow", id: WORKFLOW_ID, label: "monatsreport" },
    ]);
    expect(resolved.artifacts).toHaveLength(0);
    // The prompt is what the person wrote; nothing was appended to it.
    expect(resolved.prompt).toBe("prüfe @workflow:monatsreport bitte");
    expect(resolved.prompt).not.toContain("huge");
  });

  it("names a connector the same way", async () => {
    const resolved = await resolveMentions("@connector:reporting-api", {
      client: clientReturning({ id: CONNECTOR_ID, slug: "reporting-api" }),
    });
    expect(resolved.references).toEqual([
      { type: "connector", id: CONNECTOR_ID, label: "reporting-api" },
    ]);
    expect(resolved.artifacts).toHaveLength(0);
  });

  it("falls back to the written token when the label would be rejected", async () => {
    const resolved = await resolveMentions("@workflow:monatsreport", {
      client: clientReturning({ id: WORKFLOW_ID, slug: "a\nb", name: "c\td" }),
    });
    expect(resolved.references[0]?.label).toBe("monatsreport");
  });

  it("a kind the engine cannot resolve keeps its inline copy", async () => {
    const resolved = await resolveMentions("@execution:33333333-3333-4333-8333-333333333333", {
      client: clientReturning({
        id: "33333333-3333-4333-8333-333333333333",
        status: "failed",
      }),
    });
    expect(resolved.references).toHaveLength(0);
    expect(resolved.artifacts).toHaveLength(1);
    expect(resolved.prompt).toContain("failed");
  });

  it("a payload without an id is not a reference", async () => {
    const resolved = await resolveMentions("@workflow:monatsreport", {
      client: clientReturning({ slug: "monatsreport" }),
    });
    expect(resolved.references).toHaveLength(0);
    expect(resolved.artifacts).toHaveLength(1);
  });

  it("a prompt with no mentions carries no references", async () => {
    const resolved = await resolveMentions("nichts zu sehen");
    expect(resolved.references).toEqual([]);
    expect(resolved.prompt).toBe("nichts zu sehen");
  });
});
