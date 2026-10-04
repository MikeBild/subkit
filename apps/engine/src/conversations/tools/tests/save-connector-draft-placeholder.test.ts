import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { saveConnectorDraftTool } from "../save-connector-draft.ts";

function makeMinimalCtx(): ToolContext {
  let draft: DraftDocument = createEmptyDraftDocument();
  return {
    db: {} as ToolContext["db"],
    tenant_id: "00000000-0000-0000-0000-000000000000",
    conversation_id: "11111111-1111-1111-1111-111111111111",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => draft,
    setDraft: async (d) => {
      draft = d;
    },
  };
}

describe("save_connector_draft · mustache placeholder guard", () => {
  test("rejects {{token}} on a bearer credential", async () => {
    const ctx = makeMinimalCtx();
    const res = await saveConnectorDraftTool.execute(ctx, {
      credential: { mode: "bearer", token: "{{token}}" },
      environment: "dev",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected leak rejection");
    expect(res.error_code).toBe("credential_placeholder_leak");
    expect(res.message ?? "").toMatch(/Mustache placeholder/);
    const data = res.data as { field?: string };
    expect(data.field).toBe("token");
  });

  test("rejects {{password}} on a basic credential", async () => {
    const ctx = makeMinimalCtx();
    const res = await saveConnectorDraftTool.execute(ctx, {
      credential: { mode: "basic", username: "alice", password: "{{password}}" },
      environment: "dev",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected leak rejection");
    expect(res.error_code).toBe("credential_placeholder_leak");
  });

  test("rejects {{header_value}} on a header credential", async () => {
    const ctx = makeMinimalCtx();
    const res = await saveConnectorDraftTool.execute(ctx, {
      credential: { mode: "header", header_name: "X-API-Key", header_value: "{{header_value}}" },
      environment: "dev",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected leak rejection");
    expect(res.error_code).toBe("credential_placeholder_leak");
  });

  test("rejects {{access_key_id}} on an aws_sigv4 credential", async () => {
    const ctx = makeMinimalCtx();
    const res = await saveConnectorDraftTool.execute(ctx, {
      credential: {
        mode: "aws_sigv4",
        access_key_id: "{{access_key_id}}",
        secret_access_key: "real-secret",
      },
      environment: "dev",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected leak rejection");
    expect(res.error_code).toBe("credential_placeholder_leak");
  });

  test("rejects {{username}} on a cognito_user_password credential", async () => {
    const ctx = makeMinimalCtx();
    const res = await saveConnectorDraftTool.execute(ctx, {
      credential: {
        mode: "cognito_user_password",
        username: "{{username}}",
        password: "real-pw",
      },
      environment: "dev",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected leak rejection");
    expect(res.error_code).toBe("credential_placeholder_leak");
  });

  test("real values without {{...}} pass the placeholder guard (further validation may still apply)", async () => {
    const ctx = makeMinimalCtx();
    const res = await saveConnectorDraftTool.execute(ctx, {
      credential: { mode: "bearer", token: "ghp_realtoken" },
      environment: "dev",
    });
    if (!res.ok) {
      expect(res.error_code).not.toBe("credential_placeholder_leak");
    }
  });
});
