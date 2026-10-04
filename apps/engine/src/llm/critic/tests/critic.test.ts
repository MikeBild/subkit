import { describe, expect, it } from "bun:test";
import { runCritic } from "../index.ts";

describe("save_workflow_draft rubric", () => {
  it("passes when all structural checks succeed", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "workflow",
          resource_id: "wf_123",
          connector_auth_mode: null,
          workflow_trigger_kind: "webhook",
          validated_step_count: 1,
          committed_text: "Workflow committed with auth flow + step 1.",
          referenced_credentials: ["cred_a"],
        },
      },
      snapshot: "tenant has cred_a available",
    });
    expect(v.verdict).toBe("pass");
    expect(v.confidence).toBe(1);
    expect(v.checks?.no_placeholder_markers).toBe(true);
    expect(v.checks?.credentials_exist).toBe(true);
  });

  it("fails on placeholder marker leakage", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "connector",
          resource_id: "conn_x",
          connector_auth_mode: "bearer",
          workflow_trigger_kind: null,
          validated_step_count: 1,
          committed_text: "Connector saved at https://[guard:placeholder]/v1.",
          referenced_credentials: [],
        },
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.confidence).toBeLessThan(1);
    expect(v.reason).toContain("no_placeholder_markers");
    expect(v.hint).toContain("[guard:placeholder]");
  });

  it("fails when a referenced credential is not in the snapshot", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "connector",
          resource_id: "conn_y",
          connector_auth_mode: "bearer",
          workflow_trigger_kind: null,
          validated_step_count: 1,
          committed_text: "saved",
          referenced_credentials: ["cred_missing"],
        },
      },
      snapshot: "tenant has cred_a, cred_b",
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.credentials_exist).toBe(false);
  });

  it("fails when resource_id is null (not actually saved)", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "workflow",
          resource_id: null,
          connector_auth_mode: null,
          workflow_trigger_kind: "webhook",
          validated_step_count: 1,
          committed_text: "I will save the workflow now.",
          referenced_credentials: [],
        },
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.saved).toBe(false);
  });

  it("fails connector commit when auth mode is missing", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "connector",
          resource_id: "conn_z",
          connector_auth_mode: null,
          workflow_trigger_kind: null,
          validated_step_count: 1,
          committed_text: "saved",
          referenced_credentials: [],
        },
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.auth_or_trigger_defined).toBe(false);
  });

  it("fails workflow commit when trigger_kind is 'unknown'", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "workflow",
          resource_id: "wf_q",
          connector_auth_mode: null,
          workflow_trigger_kind: "unknown",
          validated_step_count: 1,
          committed_text: "saved",
          referenced_credentials: [],
        },
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.auth_or_trigger_defined).toBe(false);
  });

  it("fails when zero validated steps were recorded", async () => {
    const v = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "workflow",
          resource_id: "wf_q",
          connector_auth_mode: null,
          workflow_trigger_kind: "webhook",
          validated_step_count: 0,
          committed_text: "saved",
          referenced_credentials: [],
        },
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.validated_step_present).toBe(false);
  });
});

describe("chat rubric", () => {
  it("passes on grounded text", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "Workflow 26828206-0391-4618-bf08-43b500fcae09 is ready to run.",
      },
      snapshot: "26828206-0391-4618-bf08-43b500fcae09, 11111111-2222-3333-4444-555555555555",
    });
    expect(v.verdict).toBe("pass");
  });

  it("fails when an id is not in the snapshot", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "I saved 99999999-9999-9999-9999-999999999999 for you.",
      },
      snapshot: "26828206-0391-4618-bf08-43b500fcae09",
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.ids_grounded).toBe(false);
    expect(v.hint).toContain("99999999");
  });

  it("does not flag prose without UUIDs", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "I created the connector_stripe template for you.",
      },
      snapshot: "no uuids here",
    });
    expect(v.verdict).toBe("pass");
  });

  it("fails on placeholder leakage", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "Open [guard:placeholder] in your browser.",
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.no_placeholder_markers).toBe(false);
  });

  it("fails on stale 'your-tenant' wording when runtime context is set", async () => {
    const v = await runCritic({
      artifact: { kind: "chat", payload: "Open your-tenant.example.com." },
      runtimeContext: { tenant_slug: "acme" },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.runtime_values_consistent).toBe(false);
  });

  it("fails on a self-contradictory count (5 ≠ 2+2) — live-session final tally", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "Fertig. Alle 5 Acme-Ferries-Ressourcen gelöscht: 2 Workflows + 2 Connectors.",
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.counts_consistent).toBe(false);
    expect(v.hint).toContain("counts");
  });

  it("fails when a stated count over-claims its listed items (3 Workflows over 2)", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "Das sind 3 Workflows:\n• alpha\n• beta\n• (keine weiteren im Namen)",
      },
    });
    expect(v.verdict).toBe("fail");
    expect(v.checks?.counts_consistent).toBe(false);
  });

  it("passes a consistent count breakdown", async () => {
    const v = await runCritic({
      artifact: {
        kind: "chat",
        payload: "Deleted 4 resources (2 workflows + 2 connectors).",
      },
    });
    expect(v.verdict).toBe("pass");
    expect(v.checks?.counts_consistent).toBe(true);
  });
});

describe("confidence scaling", () => {
  it("decreases confidence proportionally to number of failed checks", async () => {
    const oneFail = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "workflow",
          resource_id: "wf_1",
          connector_auth_mode: null,
          workflow_trigger_kind: "webhook",
          validated_step_count: 1,
          committed_text: "saved [guard:placeholder]",
          referenced_credentials: [],
        },
      },
    });
    const twoFail = await runCritic({
      artifact: {
        kind: "save_workflow_draft",
        payload: {
          resource_kind: "workflow",
          resource_id: null,
          connector_auth_mode: null,
          workflow_trigger_kind: "webhook",
          validated_step_count: 1,
          committed_text: "saved [guard:placeholder]",
          referenced_credentials: [],
        },
      },
    });
    expect(twoFail.confidence).toBeLessThan(oneFail.confidence);
  });
});
