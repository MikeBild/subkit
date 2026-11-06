import { describe, expect, test } from "bun:test";
import { createConnector } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { startLocalTargetServer } from "../../test-helpers/local-http.ts";
import { withConnectorInspection, withConnectorValidation } from "../authoring-state/index.ts";
import { hydrateDraftFromSavedConnector } from "../authoring-state/normalize.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { getDraftCredential, setDraftCredential } from "../persistence/draft-credential-cache.ts";
import { probeConnectorDraftTool } from "../tools/probe-connector-draft.ts";
import { updateConnectorDraftTool } from "../tools/update-connector-draft.ts";
import type { DraftDocument } from "../types.ts";
import {
  buildBearerDraft,
  buildToolCtx,
  ctx,
  seedConversation,
  tenant_id,
  useDraftProbeCredentialDescribeSetup,
  useDraftProbeCredentialSetup,
} from "./draft-probe-credential-fixtures.ts";

useDraftProbeCredentialSetup();

describe("probe_connector_draft + draft credential", () => {
  useDraftProbeCredentialDescribeSetup();

  test("graphql driver with oauth2 seed cached returns authenticate_oauth_required, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gmailGraphqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-oauth2-byo",
          slug: "gql-oauth2-byo",
          driver: "graphql",
          environment: "dev",
          auth_type: "oauth2",
          base_url: server.url,
          config: { oauth: { grant_type: "authorization_code" } },
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gmailGraphqlDraft),
        {
          ...gmailGraphqlDraft.connector,
          validation: validateConnectorDraft(gmailGraphqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, {
        mode: "oauth2",
        client_id: "client-abc",
        client_secret: "secret-xyz",
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("authenticate_oauth_required");
      expect(data.recommended_next).toContain("authenticate_oauth");
    } finally {
      await server.stop();
    }
  });

  test("cached bearer credential on a basic draft → credential_mode_mismatch, cache cleared, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach upstream", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const basicDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "basic-after-flip",
          slug: "basic-after-flip",
          driver: "http",
          environment: "dev",
          auth_type: "basic",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(basicDraft),
        {
          ...basicDraft.connector,
          validation: validateConnectorDraft(basicDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, { mode: "bearer", token: "stale-bearer-token" });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("credential_mode_mismatch");
      expect(data.recommended_next).toContain("ask_user_form");
      expect(getDraftCredential(conversation_id)).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test("re-probing an unchanged failed draft returns probe_unchanged without hitting the network", async () => {
    let hits = 0;
    const server = await startLocalTargetServer(() => {
      hits += 1;
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);
      setDraftCredential(conversation_id, { mode: "bearer", token: "same-token" });

      const first = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(first.ok).toBe(false);
      expect(hits).toBe(1);

      const second = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(second.ok).toBe(false);
      expect(hits).toBe(1);
      const data = second.data as {
        error_code?: string;
        latest_probe?: { ok?: boolean; status_code?: number } | null;
        recommended_next?: string[];
      };
      expect(data.error_code).toBe("probe_unchanged");
      expect(data.latest_probe?.ok).toBe(false);
      expect(data.latest_probe?.status_code).toBe(403);
      expect(data.recommended_next).toContain("fetch_connector_docs");

      const third = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/other",
        timeout_ms: 5_000,
      });
      expect(third.ok).toBe(false);
      expect(hits).toBe(2);
    } finally {
      await server.stop();
    }
  });

  test("graphql re-probe with jittered args is still refused as probe_unchanged", async () => {
    let hits = 0;
    const server = await startLocalTargetServer(() => {
      hits += 1;
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-jitter",
          slug: "gql-jitter",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null, []),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, { mode: "bearer", token: "gql-jitter-token" });

      const first = await probeConnectorDraftTool.execute(toolCtx, {
        method: "POST",
        path: "/",
        timeout_ms: 5_000,
      });
      expect(first.ok).toBe(false);
      expect(hits).toBe(1);

      const second = await probeConnectorDraftTool.execute(toolCtx, {
        method: "POST",
        path: "/graphql",
        headers: { "x-debug": "1" },
        timeout_ms: 5_000,
      });
      expect(second.ok).toBe(false);
      expect(hits).toBe(1);
      expect((second.data as { error_code?: string }).error_code).toBe("probe_unchanged");
    } finally {
      await server.stop();
    }
  });

  test("a transient 503 prior failure skips the probe_unchanged guard", async () => {
    let hits = 0;
    const server = await startLocalTargetServer(() => {
      hits += 1;
      return new Response("upstream hiccup", { status: 503 });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);
      setDraftCredential(conversation_id, { mode: "bearer", token: "same-token" });

      const first = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(first.ok).toBe(false);
      expect(hits).toBe(1);

      const second = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });
      expect(second.ok).toBe(false);
      expect(hits).toBe(2);
      const data = second.data as { error_code?: string };
      expect(data.error_code).not.toBe("probe_unchanged");
    } finally {
      await server.stop();
    }
  });

  test("auth_type flip via update_connector_draft clears the cached credential", async () => {
    const conversation_id = await seedConversation();
    const draft = buildBearerDraft("https://api.example.test");
    const toolCtx = await buildToolCtx(conversation_id, draft);
    setDraftCredential(conversation_id, { mode: "bearer", token: "soon-stale" });

    const result = await updateConnectorDraftTool.execute(toolCtx, { auth_type: "basic" });

    expect(result.ok).toBe(true);
    expect(getDraftCredential(conversation_id)).toBeNull();
    const data = result.data as { credential_cache_cleared?: boolean };
    expect(data.credential_cache_cleared).toBe(true);
  });

  test("reuses the saved connector's stored credential when the draft is already persisted (empty cache)", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = await startLocalTargetServer((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const saved = await createConnector(
        {
          tenant_id,
          input: {
            name: "saved-bearer",
            driver: "http",
            environment: "dev",
            auth_type: "bearer",
            base_url: server.url,
          },
          actor_id: null,
        },
        ctx.db,
      );
      await upsertCredential(
        {
          tenant_id,
          connector_id: saved.id,
          environment: "dev",
          mode: "bearer",
          value: { mode: "bearer", token: "VAULT-TOKEN" },
          actor_id: null,
        },
        ctx.db,
      );

      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const boundDraft: DraftDocument = {
        ...draft,
        connector: { ...draft.connector!, saved_connector_id: saved.id },
      };
      const toolCtx = await buildToolCtx(conversation_id, boundDraft);
      expect(getDraftCredential(conversation_id)).toBeNull();

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.auth).toBe("Bearer VAULT-TOKEN");
    } finally {
      await server.stop();
    }
  });

  test("a draft hydrated from a saved connector holds the mask, and the probe still sends the stored secret", async () => {
    const HEADER_SECRET = "fixture-header-secret-not-real";
    const captured: { key: string | null } = { key: null };
    const server = await startLocalTargetServer((req) => {
      captured.key = req.headers.get("x-api-key");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const saved = await createConnector(
        {
          tenant_id,
          input: {
            name: "saved-static-header",
            driver: "http",
            environment: "dev",
            auth_type: "bearer",
            base_url: server.url,
            config: { static_headers: { "X-Api-Key": HEADER_SECRET } },
          },
          actor_id: null,
        },
        ctx.db,
      );
      await upsertCredential(
        {
          tenant_id,
          connector_id: saved.id,
          environment: "dev",
          mode: "bearer",
          value: { mode: "bearer", token: "VAULT-TOKEN" },
          actor_id: null,
        },
        ctx.db,
      );

      const hydrated = hydrateDraftFromSavedConnector(saved);
      expect(JSON.stringify(hydrated)).not.toContain(HEADER_SECRET);

      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, {
        ...draft,
        connector: { ...draft.connector, ...hydrated },
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.key).toBe(HEADER_SECRET);
      expect(JSON.stringify(result)).not.toContain(HEADER_SECRET);
    } finally {
      await server.stop();
    }
  });
});
