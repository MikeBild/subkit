import { expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";

test("CLI rejects successful HTTP responses that did not apply a repair", async () => {
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

test("CLI sends the accepted changes with a partial approval and a partial dry run", async () => {
  const digest = "b".repeat(64);
  const seen: Array<{ url: string; body: unknown }> = [];
  const client = new EngineClient({
    engine_url: "https://engine.example.test",
    api_key: "test-key",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ applied: true, workflow_version_id: "version" });
    },
  });
  await client.dryRunPatchCandidate("candidate", [0, 2]);
  await client.approvePatchCandidate("candidate", digest, [0, 2]);
  expect(seen).toEqual([
    {
      url: "https://engine.example.test/v1/patch-candidates/candidate/dry-run",
      body: { accepted_operations: [0, 2] },
    },
    {
      url: "https://engine.example.test/v1/patch-candidates/candidate/approve",
      body: { expected_review_digest: digest, accepted_operations: [0, 2] },
    },
  ]);
});

test("CLI sends an interrupted write's outcome to resolve-write", async () => {
  const client = new EngineClient({
    engine_url: "https://engine.example.test",
    api_key: "test-key",
    fetchImpl: async (input, init) => {
      expect(String(input)).toBe("https://engine.example.test/v1/executions/ex-1/resolve-write");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ step_key: "send", outcome: "arrived" });
      return Response.json({ execution_id: "ex-1", status: "queued" });
    },
  });
  expect(
    await client.resolveExecutionWrite("ex-1", { step_key: "send", outcome: "arrived" }),
  ).toEqual({ execution_id: "ex-1", status: "queued" });
});
