import { describe, expect, test } from "bun:test";
import { deleteOwnedConversation } from "./cockpit-chat-cleanup.mjs";

const instance = { key: "demo:3000:55439", databaseGeneration: "generation" };
const receipt = {
  id: "f29e4c9b-6cec-4afc-83ef-634cc3fd065d",
  instance: instance.key,
  databaseGeneration: instance.databaseGeneration,
  tenantId: "tenant",
  ownerId: "owner",
};
const args = {
  id: receipt.id,
  receipt,
  selectedInstance: instance,
  currentInstance: instance,
  tenantId: "tenant",
  ownerId: "owner",
  headers: {
    cookie: "subkit_session=session",
    origin: "http://127.0.0.1:3000",
    "x-subkit-client": "cockpit",
    "x-subkit-csrf": "csrf",
  },
};

describe("owned conversation cleanup", () => {
  test("accepts 404 only after the exact selected instance, database, tenant, owner, and id match", async () => {
    let called = false;
    const result = await deleteOwnedConversation({
      ...args,
      request: {
        delete: async (_path: string, options: { headers: object }) => {
          called = true;
          expect(options.headers).toEqual(args.headers);
          return { status: () => 404 };
        },
      },
    });
    expect(called).toBe(true);
    expect(result).toEqual({ deleted: true, alreadyMissing: true });
  });

  test("treats a successful first deletion as deleted without cancelling", async () => {
    let posted = false;
    const result = await deleteOwnedConversation({
      ...args,
      request: {
        delete: async () => ({ status: () => 200, ok: () => true }),
        post: async () => {
          posted = true;
          return { status: () => 200, ok: () => true };
        },
      },
    });
    expect(posted).toBe(false);
    expect(result).toEqual({ deleted: true, alreadyMissing: false });
  });

  test("refuses 404 handling when the selected database generation changed", async () => {
    let called = false;
    await expect(
      deleteOwnedConversation({
        ...args,
        currentInstance: { ...instance, databaseGeneration: "other" },
        request: {
          delete: async () => {
            called = true;
            return { status: () => 404 };
          },
        },
      }),
    ).rejects.toThrow("identity");
    expect(called).toBe(false);
  });

  test("refuses to delete an id that does not match the owned receipt", async () => {
    let called = false;
    await expect(
      deleteOwnedConversation({
        ...args,
        id: "f29e4c9b-6cec-4afc-83ef-634cc3fd065e",
        request: {
          delete: async () => {
            called = true;
            return { status: () => 404 };
          },
        },
      }),
    ).rejects.toThrow("identity");
    expect(called).toBe(false);
  });

  test("cancels a running turn then retries deletion of the same id with a bounded wait", async () => {
    const calls: string[] = [];
    const statuses = [409, 200];
    const result = await deleteOwnedConversation({
      ...args,
      wait: async () => {},
      request: {
        delete: async (path: string) => {
          calls.push(`DELETE ${path}`);
          const status = statuses.shift()!;
          return { status: () => status, ok: () => status >= 200 && status < 300 };
        },
        post: async (path: string) => {
          calls.push(`POST ${path}`);
          return { status: () => 200, ok: () => true };
        },
      },
    });
    expect(calls).toEqual([
      `DELETE /v1/conversations/${receipt.id}`,
      `POST /v1/conversations/${receipt.id}/cancel`,
      `DELETE /v1/conversations/${receipt.id}`,
    ]);
    expect(result).toEqual({ deleted: true, alreadyMissing: false });
  });

  test("bounds retries while preserving cleanup failure", async () => {
    let deletes = 0;
    await expect(
      deleteOwnedConversation({
        ...args,
        wait: async () => {},
        request: {
          delete: async () => {
            deletes += 1;
            return { status: () => 409, ok: () => false };
          },
          post: async () => ({ status: () => 200, ok: () => true }),
        },
      }),
    ).rejects.toThrow("bounded retries");
    expect(deletes).toBe(9);
  });
});
