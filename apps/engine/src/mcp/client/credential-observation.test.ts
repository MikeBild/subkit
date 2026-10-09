import { expect, test } from "bun:test";
import {
  captureMcpCredentialGeneration,
  observedMcpCredentialGeneration,
  observedMcpCredentialId,
  observeMcpCredential,
  withMcpCredentialObserver,
} from "./credential-observation.ts";

const snapshot = {
  connector_id: "10000000-0000-4000-8000-000000000001",
  environment: "dev" as const,
  credential_id: null,
  credential_generation: null,
  connection_id: null,
  access_token_version: null,
  identity: null,
};

test("concurrent MCP calls isolate credential observers and refresh generations", async () => {
  const first: number[] = [];
  const second: number[] = [];
  const ready = Promise.withResolvers<void>();
  await Promise.all([
    withMcpCredentialObserver(
      async () => {
        first.push(1);
      },
      async () => {
        captureMcpCredentialGeneration(snapshot.connector_id, 4, "first-credential");
        await ready.promise;
        expect(observedMcpCredentialGeneration(snapshot.connector_id)).toBe(4);
        expect(observedMcpCredentialId(snapshot.connector_id)).toBe("first-credential");
        await observeMcpCredential(snapshot);
      },
    ),
    withMcpCredentialObserver(
      async () => {
        second.push(2);
      },
      async () => {
        captureMcpCredentialGeneration(snapshot.connector_id, 9, "second-credential");
        ready.resolve();
        await observeMcpCredential(snapshot);
        expect(observedMcpCredentialGeneration(snapshot.connector_id)).toBe(9);
        expect(observedMcpCredentialId(snapshot.connector_id)).toBe("second-credential");
      },
    ),
  ]);
  expect(first).toEqual([1]);
  expect(second).toEqual([2]);
  expect(observedMcpCredentialGeneration(snapshot.connector_id)).toBeUndefined();
  await observeMcpCredential(snapshot);
  expect(first).toEqual([1]);
});

test("background work cannot attribute requests after its invocation has finished", async () => {
  const gate = Promise.withResolvers<void>();
  let background: Promise<void> | undefined;
  const observed: unknown[] = [];
  await withMcpCredentialObserver(
    async (value) => {
      observed.push(value);
    },
    async () => {
      background = gate.promise.then(() => observeMcpCredential(snapshot));
    },
  );
  gate.resolve();
  await background;
  expect(observed).toEqual([]);
});
