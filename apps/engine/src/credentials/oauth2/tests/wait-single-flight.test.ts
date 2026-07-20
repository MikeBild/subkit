import { describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { waitForOAuthCredential } from "../wait.ts";

describe("waitForOAuthCredential database-wide single-flight", () => {
  test("two waits sharing a database never overlap credential reads", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let activeReads = 0;
    let maxActiveReads = 0;
    let readCalls = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              readCalls += 1;
              activeReads += 1;
              maxActiveReads = Math.max(maxActiveReads, activeReads);
              await readGate;
              activeReads -= 1;
              return [];
            },
          }),
        }),
      }),
    } as unknown as Db;
    const listener = {
      on: () => {},
      off: () => {},
    };

    const first = waitForOAuthCredential({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      connector_id: "00000000-0000-0000-0000-000000000011",
      environment: "dev",
      timeout_ms: 25,
      db,
      listener,
    });
    const second = waitForOAuthCredential({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      connector_id: "00000000-0000-0000-0000-000000000012",
      environment: "dev",
      timeout_ms: 25,
      db,
      listener,
    });

    expect(await Promise.all([first, second])).toEqual(["timeout", "timeout"]);
    expect(readCalls).toBe(1);
    expect(maxActiveReads).toBe(1);

    releaseRead();
    await Promise.resolve();
  });

  test("a stalled pool read is destroyed instead of retaining its connection", async () => {
    let releaseError: Error | boolean | undefined;
    let releaseClient!: () => void;
    const clientReleased = new Promise<void>((resolve) => {
      releaseClient = resolve;
    });
    const client = {
      query: () => new Promise<{ rows: Array<{ id: string }> }>(() => {}),
      release: (error?: Error | boolean) => {
        releaseError = error;
        releaseClient();
      },
    };
    const db = {
      $client: {
        totalCount: 1,
        idleCount: 1,
        connect: async () => client,
      },
    } as unknown as Db;
    const listener = {
      on: () => {},
      off: () => {},
    };

    const status = await waitForOAuthCredential({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      connector_id: "00000000-0000-0000-0000-000000000013",
      environment: "dev",
      timeout_ms: 25,
      db,
      listener,
    });
    await clientReleased;

    expect(status).toBe("timeout");
    expect(releaseError).toBeInstanceOf(Error);
  });
});
