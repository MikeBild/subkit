import { describe, expect, test } from "bun:test";
import { EngineClient, type FetchLike } from "../engine-client.ts";

describe("EngineClient connector promotion", () => {
  test("sends the idempotency key and fixed promotion body", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      captured = { url: String(input), ...(init ? { init } : {}) };
      return new Response(
        JSON.stringify({
          strategy: "copy",
          source_connector_id: "11111111-1111-4111-8111-111111111111",
          target_connector_id: "22222222-2222-4222-8222-222222222222",
          source_environment: "dev",
          target_environment: "prod",
          source_retained: true,
          credential_mappings: [],
          idempotent_replay: false,
          audit_log_ids: [],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const client = new EngineClient({
      engine_url: "https://engine.example.test",
      api_key: "test-key",
      tenant: "tenant-1",
      fetchImpl,
    });

    const result = await client.promoteConnector(
      "11111111-1111-4111-8111-111111111111",
      { target_environment: "prod", strategy: "copy" },
      "stable-promotion-key",
    );
    expect(result.target_environment).toBe("prod");
    expect(captured).not.toBeNull();
    const request = captured as unknown as { url: string; init: RequestInit };
    expect(request.url).toBe(
      "https://engine.example.test/v1/connectors/11111111-1111-4111-8111-111111111111/promote",
    );
    expect(request.init.method).toBe("POST");
    expect(new Headers(request.init.headers).get("idempotency-key")).toBe("stable-promotion-key");
    expect(JSON.parse(String(request.init.body))).toEqual({
      target_environment: "prod",
      strategy: "copy",
    });
  });
});
