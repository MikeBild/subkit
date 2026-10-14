import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverOwnedConversationReceipts } from "./cockpit-chat-recovery.mjs";

const runId = "f29e4c9b-6cec-4afc-83ef-634cc3fd065d";
const conversationId = "f29e4c9b-6cec-4afc-83ef-634cc3fd065e";
const selected = {
  instance: "demo:3000:55439",
  databaseGeneration: "db-generation",
  tenantId: "tenant",
  ownerId: "owner",
};
let directory: string;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function saveReceipt(name: string, overrides: Record<string, unknown> = {}) {
  await writeFile(
    join(directory, name),
    JSON.stringify({
      schema: "subkit-local-chat-ownership-v1",
      runId,
      id: conversationId,
      ...selected,
      ...overrides,
    }),
    { mode: 0o600 },
  );
}

function recover(cleanup: (id: string, receipt: unknown) => Promise<unknown>) {
  return recoverOwnedConversationReceipts({
    directory,
    ...selected,
    readDirectory: readdir,
    readFile,
    lstat,
    unlink,
    cleanup,
  });
}

describe("local conversation cleanup receipt recovery", () => {
  test("consumes only valid receipts for the exact selected instance and owner", async () => {
    directory = await mkdtemp(join(tmpdir(), "subkit-chat-recovery-"));
    const ownedName = `browser-chat-ownership-${runId}.json`;
    await saveReceipt(ownedName);
    await writeFile(join(directory, "browser-chat-ownership-not-a-run.json"), "ignored");
    await writeFile(join(directory, "browser-workflow-functional.json"), "ignored");
    const calls: string[] = [];
    const result = await recover(async (id, receipt) => {
      calls.push(id);
      expect(receipt).toMatchObject({ runId, ...selected });
    });
    expect(result).toEqual({ cleaned: 1, failures: [] });
    expect(calls).toEqual([conversationId]);
    await expect(readFile(join(directory, ownedName))).rejects.toThrow();
    expect(await readFile(join(directory, "browser-workflow-functional.json"), "utf8")).toBe(
      "ignored",
    );
  });

  test("retains superseded database receipts without attempting cleanup", async () => {
    directory = await mkdtemp(join(tmpdir(), "subkit-chat-recovery-"));
    const ownedName = `browser-chat-ownership-${runId}.json`;
    await saveReceipt(ownedName, { databaseGeneration: "old-db-generation" });
    let called = false;
    const result = await recover(async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.cleaned).toBe(0);
    expect(result.failures[0]).toContain("superseded");
    expect(JSON.parse(await readFile(join(directory, ownedName), "utf8"))).toMatchObject({
      databaseGeneration: "old-db-generation",
    });
  });

  test("retains receipts for another authenticated owner", async () => {
    directory = await mkdtemp(join(tmpdir(), "subkit-chat-recovery-"));
    const ownedName = `browser-chat-ownership-${runId}.json`;
    await saveReceipt(ownedName, { ownerId: "other-owner" });
    let called = false;
    const result = await recover(async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.failures[0]).toContain("different or superseded local identity");
    expect(JSON.parse(await readFile(join(directory, ownedName), "utf8")).ownerId).toBe(
      "other-owner",
    );
  });

  test("retains receipts after cleanup failure so the same ID can be retried", async () => {
    directory = await mkdtemp(join(tmpdir(), "subkit-chat-recovery-"));
    const ownedName = `browser-chat-ownership-${runId}.json`;
    await saveReceipt(ownedName);
    const result = await recover(async () => {
      throw new Error("cleanup unavailable");
    });
    expect(result.failures[0]).toContain("cleanup unavailable");
    expect(JSON.parse(await readFile(join(directory, ownedName), "utf8")).id).toBe(conversationId);
  });
});
