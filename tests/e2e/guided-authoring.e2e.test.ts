import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, parseJson, shutdown } from "./setup.ts";

let env: E2EEnv;

beforeAll(async () => {
  env = await boot("guided-authoring", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

function bearer(): HeadersInit {
  return { Authorization: `Bearer ${env.personas.admin.apiKey}` };
}

describe("guided authoring smoke", () => {
  test("connector-first journey pauses for connector save approval, then workflow commit approval", async () => {
    const turn1 = await cli("sk", ["--p", "subkit engine onboarding", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 120_000,
    });
    expect(turn1.exitCode).toBe(0);
    const body1 = parseJson<{
      session_id: string;
      status: string;
      tool_calls: Array<{ name: string }>;
      pending_elicitation?: { id: string; tool_name: string };
    }>(turn1);
    expect(["awaiting_input", "completed"]).toContain(body1.status);
    expect(body1.pending_elicitation?.tool_name).toBe("ask_user_confirm");
    expect(body1.tool_calls.map((call) => call.name)).toEqual(
      expect.arrayContaining([
        "suggest_connector_templates",
        "start_connector_from_description",
        "validate_connector_draft",
        "probe_connector_draft",
        "save_connector_draft",
      ]),
    );

    const approveConnectorSave = await fetch(
      `${env.baseUrl}/v1/conversations/${body1.session_id}/elicitations/${body1.pending_elicitation?.id}/respond`,
      {
        method: "POST",
        headers: {
          ...bearer(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ output: { confirmed: true } }),
      },
    );
    expect(approveConnectorSave.status).toBe(200);
    const resumedSave = (await approveConnectorSave.json()) as {
      status: string;
      pending_elicitation_id?: string;
      committed_workflow_id?: string;
    };
    expect(["awaiting_input", "active"]).toContain(resumedSave.status);
    expect(resumedSave.pending_elicitation_id).toBeDefined();

    const approveCommit = await fetch(
      `${env.baseUrl}/v1/conversations/${body1.session_id}/elicitations/${resumedSave.pending_elicitation_id}/respond`,
      {
        method: "POST",
        headers: {
          ...bearer(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ output: { confirmed: true } }),
      },
    );
    expect(approveCommit.status).toBe(200);
    const resumedCommit = (await approveCommit.json()) as {
      status: string;
      committed_workflow_id?: string;
    };
    expect(resumedCommit.status).toBe("committed");
    expect(resumedCommit.committed_workflow_id).toBeDefined();

    const detailRes = await fetch(`${env.baseUrl}/v1/conversations/${body1.session_id}`, {
      headers: bearer(),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      conversation: {
        status: string;
        target_connector_id: string | null;
        target_workflow_id: string | null;
      };
      draft: {
        connector?: {
          name?: string | null;
          saved_connector_id?: string | null;
          latest_probe?: { summary?: string | null };
        };
        summary?: { readiness?: string };
      };
      tool_calls: Array<{ tool: string }>;
    };
    expect(detail.conversation.status).toBe("committed");
    expect(detail.conversation.target_connector_id).toBeTruthy();
    expect(detail.conversation.target_workflow_id).toBeTruthy();
    expect(detail.draft.connector?.name).toBe("Subkit Engine");
    expect(detail.draft.connector?.saved_connector_id).toBeTruthy();
    expect(detail.draft.connector?.latest_probe?.summary).toContain("Probe succeeded");
    expect(detail.tool_calls.map((call) => call.tool)).toEqual(
      expect.arrayContaining([
        "save_connector_draft",
        "build_workflow",
        "inspect_workflow_draft",
        "dry_run_step",
        "commit_draft",
      ]),
    );
  }, 120_000);
});
