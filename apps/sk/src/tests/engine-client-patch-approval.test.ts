import { expect, test } from "bun:test";

import { EngineClient } from "../engine-client.ts";

test("CLI rejects legacy successful HTTP responses that did not apply a repair", async () => {
  for (const body of [
    { applied: false, workflow_version_id: null },
    { applied: true, workflow_version_id: null },
  ]) {
    const client = new EngineClient({
      engine_url: "https://engine.example.test",
      api_key: "test-key",
      fetchImpl: async () => Response.json(body),
    });
    await expect(client.approvePatchCandidate("candidate", "a".repeat(64))).rejects.toThrow(
      "The repair was not applied",
    );
  }
});

test("CLI sends the reviewed digest and accepts a confirmed applied version", async () => {
  const digest = "a".repeat(64);
  const client = new EngineClient({
    engine_url: "https://engine.example.test",
    api_key: "test-key",
    fetchImpl: async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ expected_review_digest: digest });
      return Response.json({ applied: true, workflow_version_id: "version" });
    },
  });
  expect(await client.approvePatchCandidate("candidate", digest)).toMatchObject({
    applied: true,
    workflow_version_id: "version",
  });
});
