import { describe, expect, test } from "bun:test";
import {
  applyLocalWorkspaceProfile,
  bindProcessBindings,
  isProcessBindingPath,
  LOCAL_DEVICE_PROFILE,
  processBindingRefusal,
} from "./process-bindings.ts";
import { ConfigSchema } from "./schema.ts";

const parse = (document: Record<string, unknown>) => ConfigSchema.parse(document);

describe("process bindings", () => {
  test("database, storage and deployment mode are bootstrap-only", () => {
    for (const path of [
      "database.url",
      "storage.backend",
      "storage.filesystem.root",
      "deployment.mode",
    ])
      expect(isProcessBindingPath(path)).toBe(true);
    expect(isProcessBindingPath("server.port")).toBe(false);
    expect(processBindingRefusal("deployment.mode")).toContain("SUBKIT_DEPLOYMENT_MODE");
    expect(processBindingRefusal("database.url")).toContain("DATABASE_URL");
    expect(processBindingRefusal("queue.concurrency")).toBeNull();
  });

  test("the process wins over a stored revision", () => {
    const stored = parse({
      database: { url: "postgres://stored/x", pool_max: 10 },
      deployment: { mode: "server" },
      storage: { backend: "s3" },
    });
    const process = parse({
      database: { url: "postgres://process/x" },
      deployment: { mode: "local_workspace" },
      storage: { backend: "filesystem", filesystem: { root: "/data/files" } },
    });
    bindProcessBindings(stored, process);
    expect(stored.database.url).toBe("postgres://process/x");
    expect(stored.deployment.mode).toBe("local_workspace");
    expect(stored.storage.backend).toBe("filesystem");
    expect(stored.storage.filesystem.root).toBe("/data/files");
    expect(stored.database.pool_max).toBe(LOCAL_DEVICE_PROFILE.pool_max);
  });

  test("the laptop profile only lowers limits and only in local mode", () => {
    const server = parse({
      database: { url: "postgres://localhost/x", pool_max: 20 },
      queue: { concurrency: 8 },
    });
    applyLocalWorkspaceProfile(server);
    expect(server.database.pool_max).toBe(20);
    expect(server.queue.concurrency).toBe(8);
    const local = parse({
      deployment: { mode: "local_workspace" },
      database: { url: "postgres://localhost/x", pool_max: 20 },
      queue: { concurrency: 8 },
    });
    applyLocalWorkspaceProfile(local);
    expect(local.database.pool_max).toBe(6);
    expect(local.queue.concurrency).toBe(2);
    const small = parse({
      deployment: { mode: "local_workspace" },
      database: { url: "postgres://localhost/x", pool_max: 3 },
    });
    applyLocalWorkspaceProfile(small);
    expect(small.database.pool_max).toBe(3);
  });
});
